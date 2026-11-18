// graph.ts — reachability, ancestry, tree flattening/diffing and three-way merge over a
// repo's object map. All operations are deterministic and pure.

import { buildTree, hashObject, parseCommit, parseTag, parseTree } from './gitcore.ts';
import type { GitObj } from './gitcore.ts';

export type ObjMap = Map<string, GitObj>;

export interface CollectResult {
  /** Every object collected, oid -> object. */
  objects: ObjMap;
  /** Commits collected, oid -> depth from the nearest root (roots are depth 1). */
  commits: Map<string, number>;
  /** Commits whose parents were cut off by the depth limit (the new shallow boundary). */
  boundary: Set<string>;
}

/**
 * Collect everything reachable from `roots`.
 * - `depth`: when set, only commits within that many generations of a root (depth 1 = the roots).
 * - `stopAt`: commits whose parents are not traversed (a client's shallow boundary: it holds the
 *   commit but not its history). The stopped commit itself is still collected with its tree.
 * Tag roots are peeled to their target; tree/blob roots are collected as-is.
 */
export function collectReachable(
  lookup: ObjMap,
  roots: readonly string[],
  opts: { depth?: number; stopAt?: ReadonlySet<string> } = {},
): CollectResult {
  const objects: ObjMap = new Map();
  const commits = new Map<string, number>();
  const boundary = new Set<string>();
  const depthLimit = opts.depth;
  const stopAt = opts.stopAt ?? new Set<string>();

  const addTree = (treeOid: string): void => {
    const tree = lookup.get(treeOid);
    if (tree === undefined || tree.type !== 'tree' || objects.has(treeOid)) return;
    objects.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      const child = lookup.get(entry.oid);
      if (child === undefined || objects.has(entry.oid)) continue;
      if (child.type === 'blob') {
        objects.set(entry.oid, child);
      } else if (child.type === 'tree') {
        addTree(entry.oid);
      }
      // gitlinks (mode 160000) are skipped: they name objects in another repository.
    }
  };

  const queue: Array<{ oid: string; depth: number }> = [];
  const visitObject = (oid: string, depth: number): void => {
    const obj = lookup.get(oid);
    if (obj === undefined) return;
    if (obj.type === 'tag') {
      if (objects.has(oid)) return;
      objects.set(oid, obj);
      const target = parseTag(obj.data).object;
      visitObject(target, depth);
      return;
    }
    if (obj.type === 'commit') {
      const known = commits.get(oid);
      if (known !== undefined && known <= depth) return;
      commits.set(oid, depth);
      queue.push({ oid, depth });
      return;
    }
    if (!objects.has(oid)) objects.set(oid, obj);
  };

  for (const root of roots) visitObject(root, 1);
  // Breadth-first over commits so `depth` is the generation from the nearest root.
  for (let head = 0; head < queue.length; head += 1) {
    const { oid, depth } = queue[head] as { oid: string; depth: number };
    const obj = lookup.get(oid);
    if (obj === undefined || obj.type !== 'commit' || objects.has(oid)) continue;
    objects.set(oid, obj);
    const commit = parseCommit(obj.data);
    addTree(commit.tree);
    if (stopAt.has(oid)) continue;
    if (depthLimit !== undefined && depth >= depthLimit) {
      boundary.add(oid);
      continue;
    }
    for (const parent of commit.parents) {
      if (!commits.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
      else if ((commits.get(parent) as number) > depth + 1) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return { objects, commits, boundary };
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(lookup: ObjMap, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
      continue;
    }
    if (obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The nearest common ancestor of two commits (linear histories: the first shared commit). */
export function mergeBase(lookup: ObjMap, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = lookup.get(oid);
    if (obj?.type === 'commit') for (const parent of parseCommit(obj.data).parents) stackA.push(parent);
  }
  const stackB = [b];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const oid = stackB.pop() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = lookup.get(oid);
    if (obj?.type === 'commit') for (const parent of parseCommit(obj.data).parents) stackB.push(parent);
  }
  return null;
}

/** Peel a tag (recursively) to the commit it points at; non-tags pass through. */
export function peelToCommit(lookup: ObjMap, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = lookup.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
}

// ---------------------------------------------------------------- flat trees

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** A tree as path -> blob entry, following subdirectories. */
export function flattenTree(lookup: ObjMap, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const obj = lookup.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) the nested tree objects for a flat path map; returns the root tree oid. */
export function buildTreeFromFlat(lookup: ObjMap, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Dir {
    entries: Map<string, { oid: string; mode: string }>;
  }
  const dirs = new Map<string, Dir>();
  const dirOf = (path: string): Dir => {
    let dir = dirs.get(path);
    if (dir === undefined) {
      dir = { entries: new Map() };
      dirs.set(path, dir);
    }
    return dir;
  };
  dirOf('');
  for (const [path, entry] of flat) {
    const slash = path.lastIndexOf('/');
    const dirPath = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path.slice(slash + 1) : path.slice(slash + 1);
    dirOf(dirPath).entries.set(name, { oid: entry.oid, mode: entry.mode });
  }
  // Build bottom-up: deepest directories first ('' is depth 0, not 1).
  const depthOf = (p: string): number => (p === '' ? 0 : p.split('/').length);
  const paths = [...dirs.keys()].sort((a, b) => depthOf(b) - depthOf(a));
  const treeOidOf = new Map<string, string>();
  for (const dirPath of paths) {
    const dir = dirs.get(dirPath) as Dir;
    const entries = [...dir.entries.entries()].map(([name, value]) => ({
      mode: value.mode,
      name,
      oid: value.oid,
    }));
    // Subdirectories of this directory become tree entries.
    for (const [childPath, childOid] of treeOidOf) {
      const slash = childPath.lastIndexOf('/');
      const parent = slash < 0 ? '' : childPath.slice(0, slash);
      if (parent !== dirPath) continue;
      const name = slash < 0 ? childPath : childPath.slice(slash + 1);
      entries.push({ mode: '40000', name, oid: childOid });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!lookup.has(oid)) lookup.set(oid, { type: 'tree', data });
    treeOidOf.set(dirPath, oid);
  }
  return treeOidOf.get('') as string;
}

// ---------------------------------------------------------------- diff / merge

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The file-level diff between two trees (base -> head). */
export function diffTrees(lookup: ObjMap, baseTree: string, headTree: string): FileChange[] {
  const base = flattenTree(lookup, baseTree);
  const head = flattenTree(lookup, headTree);
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === undefined && h !== undefined) changes.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b !== undefined && h === undefined) changes.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      changes.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
  }
  return changes;
}

/** Count the lines of a blob's bytes (a trailing newline does not start a new line). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

export interface MergeOutcome {
  /** The merged flat tree (valid only when conflicts is empty). */
  flat: Map<string, FlatEntry>;
  conflicts: string[];
}

/** Three-way merge of flat trees: base, ours, theirs. A path both sides changed differently conflicts. */
export function threeWayMerge(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): MergeOutcome {
  const flat = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    if (same(o, t)) {
      if (o !== undefined) flat.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) flat.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) flat.set(path, o);
    } else {
      conflicts.push(path);
      if (o !== undefined) flat.set(path, o);
    }
  }
  return { flat, conflicts: conflicts.sort() };
}
