// store.ts — the forge's in-memory store: repositories, git objects and refs, issues,
// pull requests, labels and comments. One store per process; everything deterministic:
// a logical clock stands in for wall time so two runs on the same operations agree.

import { buildCommit, buildTree, hashObject, parseCommit, ZERO_OID } from './gitcore.ts';
import type { GitObj } from './gitcore.ts';
import {
  buildTreeFromFlat,
  collectReachable,
  diffTrees,
  flattenTree,
  isAncestor,
  mergeBase,
  peelToCommit,
  threeWayMerge,
  countLines,
} from './graph.ts';
import type { FileChange, FlatEntry } from './graph.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

const EPOCH_BASE = 1_700_000_000;

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdSeq: number;
}

export class Repo {
  readonly owner: string;
  readonly name: string;
  readonly id: number;
  description: string;
  privateFlag: boolean;
  defaultBranch: string;
  readonly refs = new Map<string, string>();
  readonly objects = new Map<string, GitObj>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  nextNumber = 1;
  readonly createdSeq: number;

  constructor(owner: string, name: string, id: number, createdSeq: number, opts: { description?: string; privateFlag?: boolean; defaultBranch?: string }) {
    this.owner = owner;
    this.name = name;
    this.id = id;
    this.createdSeq = createdSeq;
    this.description = opts.description ?? '';
    this.privateFlag = opts.privateFlag ?? false;
    this.defaultBranch = opts.defaultBranch ?? 'main';
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  get defaultRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  get defaultTip(): string | undefined {
    return this.refs.get(this.defaultRef);
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1000;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private clock = 0;

  /** The next logical tick: strictly increasing, deterministic. */
  tick(): { seq: number; epoch: number; iso: string } {
    this.clock += 1;
    const epoch = EPOCH_BASE + this.clock;
    return { seq: this.clock, epoch, iso: new Date(epoch * 1000).toISOString() };
  }

  peekSeq(): number {
    return this.clock;
  }

  static repoKey(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  createRepo(
    owner: string,
    name: string,
    opts: { description?: string; privateFlag?: boolean; defaultBranch?: string },
  ): Repo | null {
    const key = Store.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const { seq } = this.tick();
    const repo = new Repo(owner, name, this.nextRepoId, seq, opts);
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.repoKey(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  listAllRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, input: { title: string; body: string; labels?: readonly string[] }): { issue: Issue } | { error: string } {
    const labels: string[] = [];
    for (const name of input.labels ?? []) {
      if (!repo.labels.has(name)) return { error: `Label "${name}" does not exist` };
      labels.push(name);
    }
    const { seq } = this.tick();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return { issue };
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const { seq } = this.tick();
    const comment: Comment = { id: this.nextCommentId, body, createdSeq: seq };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    issue.updatedSeq = seq;
    return comment;
  }

  // ---------------------------------------------------------------- pull requests

  createPull(
    repo: Repo,
    input: { title: string; body: string; head: string; base: string },
  ): { pull: Pull } | { error: string; status: number } {
    const headRef = `refs/heads/${input.head}`;
    const baseRef = `refs/heads/${input.base}`;
    const headSha = repo.refs.get(headRef);
    const baseSha = repo.refs.get(baseRef);
    if (headSha === undefined) return { error: `Head branch "${input.head}" does not exist`, status: 422 };
    if (baseSha === undefined) return { error: `Base branch "${input.base}" does not exist`, status: 422 };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
        return { error: 'A pull request already exists for this head and base', status: 422 };
      }
    }
    const { seq } = this.tick();
    const pull: Pull = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      baseRef: input.base,
      createdSeq: seq,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return { pull };
  }

  /** The files a pull request changes (merge-base of head/base vs head). */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headSha === undefined || baseSha === undefined) return [];
    const base = mergeBase(repo.objects, baseSha, headSha) ?? baseSha;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(headSha);
    if (baseCommit?.type !== 'commit' || headCommit?.type !== 'commit') return [];
    return diffTrees(repo.objects, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
  }

  /** MERGEABLE / CONFLICTING for a pull request, from a three-way merge of its trees. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headSha === undefined || baseSha === undefined) return 'UNKNOWN';
    const base = mergeBase(repo.objects, baseSha, headSha);
    if (base === null) return 'UNKNOWN';
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(headSha);
    const baseTipCommit = repo.objects.get(baseSha);
    if (baseCommit?.type !== 'commit' || headCommit?.type !== 'commit' || baseTipCommit?.type !== 'commit') return 'UNKNOWN';
    const merged = threeWayMerge(
      flattenTree(repo.objects, parseCommit(baseCommit.data).tree),
      flattenTree(repo.objects, parseCommit(baseTipCommit.data).tree),
      flattenTree(repo.objects, parseCommit(headCommit.data).tree),
    );
    return merged.conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
  }

  mergePull(
    repo: Repo,
    pull: Pull,
    method: string,
  ): { ok: true; sha: string; message: string } | { ok: false; status: number; message: string } {
    if (pull.state !== 'open') return { ok: false, status: 405, message: 'Pull request is not open' };
    if (method !== '' && method !== 'squash' && method !== 'merge' && method !== 'rebase') {
      return { ok: false, status: 422, message: `Unknown merge method "${method}"` };
    }
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headSha === undefined || baseSha === undefined) return { ok: false, status: 404, message: 'Head or base branch is missing' };
    const base = mergeBase(repo.objects, baseSha, headSha);
    if (base === null) return { ok: false, status: 405, message: 'No merge base' };
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(headSha);
    const baseTipCommit = repo.objects.get(baseSha);
    if (baseCommit?.type !== 'commit' || headCommit?.type !== 'commit' || baseTipCommit?.type !== 'commit') {
      return { ok: false, status: 405, message: 'Cannot merge' };
    }
    const merged = threeWayMerge(
      flattenTree(repo.objects, parseCommit(baseCommit.data).tree),
      flattenTree(repo.objects, parseCommit(baseTipCommit.data).tree),
      flattenTree(repo.objects, parseCommit(headCommit.data).tree),
    );
    if (merged.conflicts.length > 0) {
      return { ok: false, status: 405, message: 'Merge conflict' };
    }
    const treeOid = buildTreeFromFlat(repo.objects, merged.flat);
    const { epoch, iso } = this.tick();
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const commitData = buildCommit({ tree: treeOid, parents: [baseSha], message, timestamp: epoch });
    const sha = hashObject('commit', commitData);
    repo.objects.set(sha, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = iso;
    pull.mergeCommitSha = sha;
    return { ok: true, sha, message };
  }

  // ---------------------------------------------------------------- git helpers

  /** Resolve a ref-ish (branch name, full ref, or oid) to a commit oid, or null. */
  resolveCommit(repo: Repo, refish: string): string | null {
    if (repo.refs.has(refish)) return peelToCommit(repo.objects, repo.refs.get(refish) as string);
    const asBranch = repo.refs.get(`refs/heads/${refish}`);
    if (asBranch !== undefined) return peelToCommit(repo.objects, asBranch);
    const asTag = repo.refs.get(`refs/tags/${refish}`);
    if (asTag !== undefined) return peelToCommit(repo.objects, asTag);
    if (/^[0-9a-f]{40}$/.test(refish)) return peelToCommit(repo.objects, refish);
    return null;
  }

  /** Commits reachable from a tip, newest first (by creation order, then oid for stability). */
  listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string; author: string; committer: string; tree: string; parents: string[] }> {
    const { commits } = collectReachable(repo.objects, [tip]);
    const out: Array<{ sha: string; message: string; author: string; committer: string; tree: string; parents: string[] }> = [];
    for (const sha of commits.keys()) {
      const obj = repo.objects.get(sha);
      if (obj?.type !== 'commit') continue;
      const view = parseCommit(obj.data);
      out.push({ sha, message: view.message, author: view.author, committer: view.committer, tree: view.tree, parents: view.parents });
    }
    // Newest first: the walk order is breadth-first from the tip, which is newest-first for
    // linear histories; break ties deterministically by sha.
    return out;
  }

  /** Create a commit object in the store and return its oid. */
  createCommit(repo: Repo, fields: { tree: string; parents: readonly string[]; message: string }): string {
    const { epoch } = this.tick();
    const data = buildCommit({ tree: fields.tree, parents: fields.parents, message: fields.message, timestamp: epoch });
    const oid = hashObject('commit', data);
    repo.objects.set(oid, { type: 'commit', data });
    return oid;
  }

  // ---------------------------------------------------------------- contents

  /** The flat file map at a branch tip (empty when the branch has no commits). */
  flatAtBranch(repo: Repo, branch: string): Map<string, FlatEntry> {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return new Map();
    const commit = repo.objects.get(tip);
    if (commit?.type !== 'commit') return new Map();
    return flattenTree(repo.objects, parseCommit(commit.data).tree);
  }

  /** Commit one file change on a branch (creating the branch from the default tip when new). */
  commitFile(
    repo: Repo,
    input: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { status: 200 | 201; commitSha: string; contentSha: string } | { error: string; status: number } {
    const branch = input.branch ?? repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    let tip = repo.refs.get(branchRef);
    if (tip === undefined) {
      // A new branch starts at the default branch's tip (or at nothing for a first commit).
      if (branch !== repo.defaultBranch) tip = repo.defaultTip;
      if (tip === undefined && repo.refs.size > 0) return { error: `Branch "${branch}" does not exist`, status: 422 };
    }
    const flat = tip === undefined ? new Map<string, FlatEntry>() : this.flatAtBranch(repo, branch);
    const existing = flat.get(input.path);
    const contentSha = hashObject('blob', input.content);
    if (input.sha !== undefined) {
      if (existing === undefined || existing.oid.toLowerCase() !== input.sha.toLowerCase()) {
        return { error: 'sha does not match the current blob', status: 409 };
      }
    } else if (existing !== undefined) {
      return { error: 'sha is required to update an existing file', status: 409 };
    }
    repo.objects.set(contentSha, { type: 'blob', data: input.content });
    flat.set(input.path, { oid: contentSha, mode: '100644' });
    const treeOid = buildTreeFromFlat(repo.objects, flat);
    const parents = tip === undefined ? [] : [tip];
    const commitSha = this.createCommit(repo, { tree: treeOid, parents, message: input.message });
    repo.refs.set(branchRef, commitSha);
    return { status: existing === undefined ? 201 : 200, commitSha, contentSha };
  }

  /** Delete one file on the default branch (or the given branch). */
  deleteFile(
    repo: Repo,
    input: { path: string; message: string; branch?: string; sha?: string },
  ): { status: 200; commitSha: string } | { error: string; status: number } {
    const branch = input.branch ?? repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    if (tip === undefined) return { error: 'Not Found', status: 404 };
    const flat = this.flatAtBranch(repo, branch);
    const existing = flat.get(input.path);
    if (existing === undefined) return { error: 'Not Found', status: 404 };
    if (input.sha !== undefined && existing.oid.toLowerCase() !== input.sha.toLowerCase()) {
      return { error: 'sha does not match the current blob', status: 409 };
    }
    flat.delete(input.path);
    const treeOid = buildTreeFromFlat(repo.objects, flat);
    const commitSha = this.createCommit(repo, { tree: treeOid, parents: [tip], message: input.message });
    repo.refs.set(branchRef, commitSha);
    return { status: 200, commitSha };
  }
}

/** Base64 of a UTF-8 string (standard alphabet, no wrapping). */
export function b64encode(data: Buffer | string): string {
  return Buffer.from(data).toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** Count the lines of a blob's bytes. */
export { countLines };
export type { FileChange };
export { ZERO_OID };
