// gitserver.ts — git smart HTTP: info/refs (v2 + v0), upload-pack v2/v0, receive-pack v0.
// All state lives in the store; objects are stored byte-exactly as received.

import { decodePktLines, encodePktLines, hashObject, isObjectId, parseTag, readPack, writePack, ZERO_OID } from './gitcore.ts';
import type { Pkt } from './gitcore.ts';
import { collectReachable, isAncestor, peelToCommit } from './graph.ts';
import type { Repo } from './store.ts';

export const GIT_AGENT = 'forge/1.0.0';

interface RefLine {
  oid: string;
  name: string;
}

function sortedRefs(repo: Repo): RefLine[] {
  const refs: RefLine[] = [];
  for (const [name, oid] of repo.refs) refs.push({ oid, name });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function headTarget(repo: Repo): string {
  return repo.defaultRef;
}

/** The first pkt-line data of a v2 advertisement, plus capabilities. */
export function v2Advertisement(): Buffer {
  const lines: string[] = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${GIT_AGENT}\n`,
  ];
  return Buffer.concat([encodePktLines(lines), Buffer.from('0000', 'ascii')]);
}

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): string {
  const common = `agent=${GIT_AGENT}`;
  if (service === 'git-receive-pack') {
    return `report-status side-band-64k delete-refs ofs-delta ${common}`;
  }
  return `side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow symref=HEAD:${headTarget(repo)} ${common}`;
}

/** v0 ref advertisement: service preamble, flush, ref lines (HEAD first), flush. */
export function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const parts: Buffer[] = [encodePktLines([`# service=${service}\n`, 'flush'])];
  const refs = sortedRefs(repo);
  const caps = v0Capabilities(service, repo);
  if (refs.length === 0) {
    parts.push(encodePktLines([`${ZERO_OID} capabilities^{}\0${caps}\n`, 'flush']));
    return Buffer.concat(parts);
  }
  const lines: Array<string | 'flush'> = [];
  const tip = repo.refs.get(headTarget(repo));
  if (tip !== undefined) lines.push(`${tip} HEAD\0${caps}\n`);
  else lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}\n`);
    const obj = repo.objects.get(ref.oid);
    if (obj?.type === 'tag') {
      const peeled = peelToCommit(repo.objects, ref.oid);
      if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  parts.push(encodePktLines(lines));
  return Buffer.concat(parts);
}

export interface InfoRefsResult {
  status: number;
  contentType: string;
  body: Buffer;
}

export function infoRefs(repo: Repo | undefined, service: 'git-upload-pack' | 'git-receive-pack', wantV2: boolean): InfoRefsResult {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
  }
  if (service === 'git-upload-pack' && wantV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(service, repo),
  };
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

function parseFetchArgs(packets: readonly Pkt[], v2: boolean): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (v2 && (line.startsWith('command=') || line.startsWith('agent=') || line.startsWith('object-format='))) continue;
    if (line === 'thin-pack\n' || line === 'no-progress\n' || line === 'ofs-delta\n' || line === 'done\n') continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
    // deepen-since / deepen-not: accepted, treated as a full fetch.
  }
  return args;
}

const SIDEBAND_MAX_DATA = 65500;

/** Split pack bytes into sideband band-1 pkt-lines (band byte + data, each under the pkt-line max). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_MAX_DATA) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_MAX_DATA));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    out.push(encodePktLines([payload]));
  }
  return out;
}

interface FetchPlan {
  /** Objects to send, in a deterministic order. */
  send: Array<{ type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>;
  /** New shallow boundaries (commits at the depth frontier). */
  shallow: string[];
  /** Old shallow boundaries that are no longer shallow. */
  unshallow: string[];
  /** Whether every want is already held. */
  nothingNew: boolean;
}

function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const stopAt = new Set(args.shallow);
  const have = collectReachable(repo.objects, args.haves, { stopAt });
  // With a depth limit the old shallow boundaries do not block the traversal:
  // deepen N walks N generations from the wants and the depth alone sets the
  // new frontier. Without a depth limit the boundaries block (their parents
  // are not traversed), so a shallow fetch never pulls the old history.
  const want =
    args.depth !== null
      ? collectReachable(repo.objects, args.wants, { depth: args.depth })
      : collectReachable(repo.objects, args.wants, { stopAt });
  const send: FetchPlan['send'] = [];
  for (const [oid, obj] of want.objects) {
    if (have.objects.has(oid)) continue;
    send.push(obj);
  }
  // Deterministic order: commits first (by oid), then the rest (by oid).
  send.sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const nothingNew = send.length === 0;
  const shallow = [...want.boundary].sort();
  const unshallow: string[] = [];
  // An old boundary is unshallow when it is inside the new closure and its parents are too.
  for (const old of args.shallow) {
    if (!want.commits.has(old)) continue;
    const obj = repo.objects.get(old);
    if (obj?.type !== 'commit') continue;
    const parents: string[] = [];
    for (const line of obj.data.toString('utf8').split('\n')) {
      if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    }
    if (parents.length === 0 || parents.every((p) => want.commits.has(p))) unshallow.push(old);
  }
  return { send, shallow, unshallow: unshallow.sort(), nothingNew };
}

function v2FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    // NAK means "no common base": the client answers with another round of
    // haves. A have the server holds is ACKed and negotiation ends with ready.
    const known = args.haves.filter((oid) => repo.objects.has(oid));
    const lines: Array<string | 'delim'> = ['acknowledgments\n'];
    if (known.length > 0) {
      for (const oid of known) lines.push(`ACK ${oid}\n`);
      lines.push('ready\n');
    } else {
      lines.push('NAK\n');
    }
    lines.push('delim');
    parts.push(encodePktLines(lines));
    if (known.length === 0) {
      parts.push(Buffer.from('0000', 'ascii'));
      return Buffer.concat(parts);
    }
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  if (plan.send.length > 0) {
    const pack = writePack(plan.send);
    // The packfile section has no delim after its header: the sideband packets
    // follow the header line directly, and the response ends with a flush.
    const section: Buffer[] = [encodePktLines(['packfile\n']), ...sidebandPack(pack)];
    parts.push(Buffer.concat(section));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  const head: string[] = [];
  const known = args.haves.filter((oid) => repo.objects.has(oid));
  if (known.length > 0) {
    for (const oid of known) head.push(`ACK ${oid}\n`);
  } else {
    head.push('NAK\n');
  }
  for (const oid of plan.shallow) head.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) head.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(head));
  if (plan.send.length > 0) {
    const pack = writePack(plan.send);
    parts.push(Buffer.concat(sidebandPack(pack)));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export interface UploadPackResult {
  status: number;
  contentType: string;
  body: Buffer;
}

/** Handle POST git-upload-pack (v2 when the request asked for it, else v0). */
export function uploadPack(repo: Repo | undefined, body: Buffer, wantV2: boolean): UploadPackResult {
  const contentType = 'application/x-git-upload-pack-result';
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
  }
  let packets: Pkt[];
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"malformed pkt-line stream"}\n', 'utf8') };
  }
  const firstData = packets.find((p) => p.kind === 'data');
  const firstLine = firstData?.payload.toString('utf8') ?? '';
  if (firstLine.startsWith('command=ls-refs')) {
    return { status: 200, contentType, body: lsRefs(repo, packets) };
  }
  if (firstLine.startsWith('command=fetch')) {
    const args = parseFetchArgs(packets, true);
    return { status: 200, contentType, body: v2FetchResponse(repo, args) };
  }
  if (firstLine.startsWith('command=')) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"unknown command"}\n', 'utf8') };
  }
  // v0: want lines, then flush, then have/done lines.
  const args = parseFetchArgs(packets, false);
  void wantV2;
  return { status: 200, contentType, body: v0FetchResponse(repo, args) };
}

function lsRefs(repo: Repo, packets: readonly Pkt[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) lines.push(`unborn HEAD symref-target:${headTarget(repo)}\n`);
  } else {
    const tip = repo.refs.get(headTarget(repo));
    if (tip !== undefined && keep('HEAD')) {
      lines.push(symrefs ? `${tip} HEAD symref-target:${headTarget(repo)}\n` : `${tip} HEAD\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const obj = repo.objects.get(ref.oid);
        if (obj?.type === 'tag') {
          const peeled = peelToCommit(repo.objects, ref.oid);
          if (peeled !== null) line += ` peeled:${peeled}`;
        }
      }
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines as Array<string | 'flush'>);
}

// ---------------------------------------------------------------- receive-pack

export interface ReceivePackResult {
  status: number;
  contentType: string;
  body: Buffer;
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Handle POST git-receive-pack: unpack the pack, apply the commands, report per ref. */
export function receivePack(repo: Repo | undefined, body: Buffer): ReceivePackResult {
  const contentType = 'application/x-git-receive-pack-result';
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
  }
  // Split the command list (pkt-lines up to the first flush) from the pack that follows.
  let offset = 0;
  const commandPackets: Pkt[] = [];
  let packStart = body.length;
  try {
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated pkt-line');
      const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
      if (Number.isNaN(len)) throw new Error('malformed pkt-line length');
      if (len === 0) {
        offset += 4;
        packStart = offset;
        break;
      }
      if (offset + len > body.length) throw new Error('truncated pkt-line payload');
      commandPackets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + len) });
      offset += len;
    }
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"malformed pkt-line stream"}\n', 'utf8') };
  }
  const commands: PushCommand[] = [];
  for (const packet of commandPackets) {
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (isObjectId(oldOid) && isObjectId(newOid) && ref.startsWith('refs/')) {
      commands.push({ oldOid, newOid, ref });
    }
  }
  // Unpack the pack (if any): a delete-only push carries none.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      // Delta bases may live in the repo already (thin packs from git).
      const objects = readPack(packBytes, repo.objects);
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  // Evaluate the commands in order, applying the accepted ones.
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const command of commands) {
    const result = applyCommand(repo, command, unpackOk);
    reportLines.push(result === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${result}\n`);
  }
  const inner = encodePktLines([...reportLines, 'flush']);
  const outer = Buffer.concat([encodePktLines([Buffer.concat([Buffer.from([1]), inner])]), Buffer.from('0000', 'ascii')]);
  return { status: 200, contentType, body: outer };
}

/** Apply one push command; returns null on success or the ng reason. */
function applyCommand(repo: Repo, command: PushCommand, unpackOk: boolean): string | null {
  if (!unpackOk) return 'unpack error';
  const current = repo.refs.get(command.ref);
  const isDelete = command.newOid === ZERO_OID;
  const isCreate = command.oldOid === ZERO_OID;
  if (isDelete) {
    if (current === undefined) return 'no such ref';
    if (current !== command.oldOid) return 'non-fast-forward';
    repo.refs.delete(command.ref);
    return null;
  }
  const target = repo.objects.get(command.newOid);
  if (target === undefined) return 'object not found';
  if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') return 'not a commit';
  if (isCreate) {
    if (current !== undefined) return 'already exists';
    repo.refs.set(command.ref, command.newOid);
    return null;
  }
  if (current === undefined) return 'no such ref';
  if (current !== command.oldOid) return 'non-fast-forward';
  if (!isAncestor(repo.objects, command.oldOid, command.newOid)) return 'non-fast-forward';
  repo.refs.set(command.ref, command.newOid);
  return null;
}
