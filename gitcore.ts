// gitcore.ts — the git object model, pkt-line framing and packfiles.
// Standard library only (node:crypto, node:zlib). No dependencies.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits / tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: ObjType; tag: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export const FORGE_IDENTITY = 'Forge <forge@example.invalid>';

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  timestamp: number;
}): Buffer {
  const who = `${FORGE_IDENTITY} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------- pkt-line

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Parse a whole buffer of pkt-lines. Throws on a malformed length prefix. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('malformed pkt-line length');
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + len > buf.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile (version 2) from plain objects, no deltas. Trailer is SHA-1 of the rest. */
export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta to its base object, returning the reconstructed bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('truncated delta varint');
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos] as number, pos += 1;
      if (op & 0x02) offset |= (delta[pos] as number) << 8, pos += 1;
      if (op & 0x04) offset |= (delta[pos] as number) << 16, pos += 1;
      if (op & 0x08) offset |= (delta[pos] as number) << 24, pos += 1;
      if (op & 0x10) size = delta[pos] as number, pos += 1;
      if (op & 0x20) size |= (delta[pos] as number) << 8, pos += 1;
      if (op & 0x40) size |= (delta[pos] as number) << 16, pos += 1;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(offset, offset + size));
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('truncated delta insert');
      out.push(delta.subarray(pos, pos + op));
      pos += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  /** Offset of the entry's header in the pack (for OFS_DELTA base resolution). */
  startOffset: number;
  typeCode: number;
  /** Inflated payload (raw object bytes, or delta instructions for type 6/7). */
  data: Buffer;
  /** For OFS_DELTA: the base entry's start offset. For REF_DELTA: the base oid. */
  baseOffset: number | null;
  baseOid: string | null;
}

/**
 * Read a packfile into a map of oid -> object. Plain objects and delta objects
 * (OFS_DELTA, REF_DELTA) are supported; a delta base may live earlier in the
 * same pack or in `extraBases` (the receiving repo's objects, for thin packs).
 */
export function readPack(pack: Buffer, extraBases?: ReadonlyMap<string, GitObj>): Map<string, GitObj> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const expectedTrailer = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  const actualTrailer = pack.subarray(pack.length - 20).toString('hex');
  if (expectedTrailer !== actualTrailer) throw new Error('pack trailer checksum mismatch');
  const entries: PackEntry[] = [];
  const byStartOffset = new Map<number, number>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const startOffset = offset;
    // Object header: varint, low 4 bits of first byte are size bits 0-3, bits 4-6 are the type.
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base entry, varint-encoded.
      let ofsByte = pack[offset] as number;
      offset += 1;
      let base = ofsByte & 0x7f;
      while (ofsByte & 0x80) {
        ofsByte = pack[offset] as number;
        offset += 1;
        base = ((base + 1) << 7) | (ofsByte & 0x7f);
      }
      baseOffset = startOffset - base;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset));
    const consumed = zlibConsumed(pack, offset);
    offset += consumed;
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    byStartOffset.set(startOffset, entries.length);
    entries.push({ startOffset, typeCode, data: inflated, baseOffset, baseOid });
  }
  // Resolve entries to objects (deltas applied to their bases, chains included).
  const objects = new Map<string, GitObj>();
  const resolved: Array<GitObj | null> = entries.map(() => null);
  const resolving = new Set<number>();
  // Plain entries can be named by oid before resolution, so a REF_DELTA can
  // point at a plain entry anywhere in the pack.
  const plainIndex = new Map<string, number>();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] as PackEntry;
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      plainIndex.set(hashObject(CODE_TYPE[entry.typeCode] as ObjType, entry.data), i);
    }
  }
  const resolve = (index: number): GitObj => {
    const done = resolved[index];
    if (done !== null) return done as GitObj;
    if (resolving.has(index)) throw new Error('delta cycle in pack');
    resolving.add(index);
    const entry = entries[index] as PackEntry;
    let result: GitObj;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObj | undefined;
      if (entry.baseOffset !== null) {
        const baseIndex = byStartOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error('delta base offset not found in pack');
        base = resolve(baseIndex);
      } else if (entry.baseOid !== null) {
        base = objects.get(entry.baseOid);
        if (base === undefined) {
          const baseIndex = plainIndex.get(entry.baseOid);
          if (baseIndex !== undefined) base = resolve(baseIndex);
        }
        if (base === undefined) base = extraBases?.get(entry.baseOid);
        if (base === undefined) throw new Error(`delta base ${entry.baseOid} not found`);
      }
      if (base === undefined) throw new Error('delta without a base');
      const data = applyDelta(base.data, entry.data);
      result = { type: base.type, data };
    } else {
      const type = CODE_TYPE[entry.typeCode] as ObjType;
      result = { type, data: entry.data };
    }
    resolving.delete(index);
    resolved[index] = result;
    objects.set(hashObject(result.type, result.data), result);
    return result;
  };
  for (let i = 0; i < entries.length; i += 1) resolve(i);
  return objects;
}

// How many compressed bytes did inflateSync consume? The smallest prefix of the input that
// inflates successfully is the stream's end (a truncated stream throws, trailing bytes after
// the stream are ignored). Found by exponential probing then a binary search, so the slices
// stayed near the stream's own size.
function zlibConsumed(pack: Buffer, offset: number): number {
  const max = pack.length - offset - 20; // leave the trailer out
  const ok = (size: number): boolean => {
    try {
      inflateSync(pack.subarray(offset, offset + size));
      return true;
    } catch {
      return false;
    }
  };
  // ok() is monotone: a prefix shorter than the stream is truncated (throws),
  // a prefix at or past the stream's end inflates (trailing bytes ignored).
  // The stream always ends within [offset, offset + max), so ok(max) is true.
  let size = 1;
  while (size < max && !ok(size)) size *= 2;
  let high = Math.min(size, max);
  const low0 = Math.floor(size / 2);
  let low = low0;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (ok(mid)) high = mid;
    else low = mid;
  }
  return high;
}
