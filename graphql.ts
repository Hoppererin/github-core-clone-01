// graphql.ts — a small GraphQL executor for the fixed document set the conformance
// suite sends (see the kit's checks-graphql.ts GRAPHQL_DOCUMENTS). It is not a
// general GraphQL implementation: it parses one operation per body (or a batch
// array), resolves fields against the store, and answers unknown fields with a
// 200 + errors array naming the field.

import { VIEWER_ID, VIEWER_LOGIN } from './store.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// ------------------------------------------------------------------ global ids

export function gidRepo(owner: string, name: string): string {
  return Buffer.from(`repo:${owner}/${name}`, 'utf8').toString('base64');
}

export function gidIssue(owner: string, name: string, number: number): string {
  return Buffer.from(`issue:${owner}/${name}#${number}`, 'utf8').toString('base64');
}

export function gidPull(owner: string, name: string, number: number): string {
  return Buffer.from(`pr:${owner}/${name}#${number}`, 'utf8').toString('base64');
}

export function gidComment(owner: string, name: string, number: number, id: number): string {
  return Buffer.from(`comment:${owner}/${name}#${number}:${id}`, 'utf8').toString('base64');
}

function decodeGid(id: string): string | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    return text.includes(':') ? text : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ tokenizer

interface Token {
  kind: 'name' | 'string' | 'int' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!$=@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1] as string;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      while (i < source.length && /[0-9]/.test(source[i] as string)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] as string)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ------------------------------------------------------------------ parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  children: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string | null; children: SelectionNode[] };

export interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, ValueNode | undefined>;
  selections: SelectionNode[];
}

interface Parser {
  tokens: Token[];
  pos: number;
}

function peek(p: Parser): Token | undefined {
  return p.tokens[p.pos];
}

function next(p: Parser): Token {
  const token = p.tokens[p.pos];
  if (token === undefined) throw new Error('unexpected end of GraphQL document');
  p.pos += 1;
  return token;
}

function expectPunct(p: Parser, value: string): void {
  const token = next(p);
  if (token.kind !== 'punct' || token.value !== value) {
    throw new Error(`expected "${value}" but got ${token.value}`);
  }
}

function parseValue(p: Parser): ValueNode {
  const token = next(p);
  if (token.kind === 'punct' && token.value === '$') {
    const name = next(p);
    return { kind: 'variable', name: name.value };
  }
  if (token.kind === 'string') return { kind: 'string', value: token.value };
  if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
  if (token.kind === 'name') {
    if (token.value === 'true') return { kind: 'boolean', value: true };
    if (token.value === 'false') return { kind: 'boolean', value: false };
    if (token.value === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token.value };
  }
  if (token.kind === 'punct' && token.value === '[') {
    const items: ValueNode[] = [];
    while (!(peek(p)?.kind === 'punct' && peek(p)?.value === ']')) items.push(parseValue(p));
    expectPunct(p, ']');
    return { kind: 'list', items };
  }
  if (token.kind === 'punct' && token.value === '{') {
    const fields: Array<{ name: string; value: ValueNode }> = [];
    while (!(peek(p)?.kind === 'punct' && peek(p)?.value === '}')) {
      const name = next(p);
      expectPunct(p, ':');
      fields.push({ name: name.value, value: parseValue(p) });
    }
    expectPunct(p, '}');
    return { kind: 'object', fields };
  }
  throw new Error(`unexpected token ${token.value} in value`);
}

function parseArguments(p: Parser): Array<{ name: string; value: ValueNode }> {
  const args: Array<{ name: string; value: ValueNode }> = [];
  expectPunct(p, '(');
  while (!(peek(p)?.kind === 'punct' && peek(p)?.value === ')')) {
    const name = next(p);
    expectPunct(p, ':');
    args.push({ name: name.value, value: parseValue(p) });
  }
  expectPunct(p, ')');
  return args;
}

function parseSelectionSet(p: Parser): SelectionNode[] {
  expectPunct(p, '{');
  const selections: SelectionNode[] = [];
  while (!(peek(p)?.kind === 'punct' && peek(p)?.value === '}')) {
    const token = peek(p);
    if (token?.kind === 'spread') {
      next(p);
      const after = peek(p);
      if (after?.kind === 'name' && after.value === 'on') {
        next(p);
        const typeName = next(p);
        selections.push({ kind: 'fragment', typeCondition: typeName.value, children: parseSelectionSet(p) });
      } else {
        // Named fragment spread: the suite never sends one; skip its name.
        next(p);
        selections.push({ kind: 'fragment', typeCondition: null, children: [] });
      }
      continue;
    }
    const first = next(p);
    let alias = first.value;
    let name = first.value;
    if (peek(p)?.kind === 'punct' && peek(p)?.value === ':') {
      next(p);
      name = next(p).value;
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (peek(p)?.kind === 'punct' && peek(p)?.value === '(') args = parseArguments(p);
    let children: SelectionNode[] = [];
    if (peek(p)?.kind === 'punct' && peek(p)?.value === '{') children = parseSelectionSet(p);
    selections.push({ kind: 'field', field: { alias, name, args, children } });
  }
  expectPunct(p, '}');
  return selections;
}

export function parseDocument(source: string): Operation {
  const p: Parser = { tokens: tokenize(source), pos: 0 };
  // Skip fragment definitions the suite never sends; take the first operation.
  while (p.pos < p.tokens.length) {
    const token = peek(p);
    if (token?.kind === 'name' && token.value === 'fragment') {
      next(p);
      next(p); // name
      next(p); // on
      next(p); // type
      parseSelectionSet(p);
      continue;
    }
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = token.value;
      next(p);
      const maybeName = peek(p);
      if (maybeName?.kind === 'name') {
        name = maybeName.value;
        next(p);
      }
    }
    const variables: Record<string, ValueNode | undefined> = {};
    if (peek(p)?.kind === 'punct' && peek(p)?.value === '(') {
      next(p);
      while (!(peek(p)?.kind === 'punct' && peek(p)?.value === ')')) {
        expectPunct(p, '$');
        const varName = next(p).value;
        expectPunct(p, ':');
        // Type: a name, possibly wrapped in [ ] or followed by !.
        let depth = 0;
        while (true) {
          const t = next(p);
          if (t.kind === 'punct' && t.value === '[') depth += 1;
          else if (t.kind === 'punct' && t.value === ']') depth -= 1;
          else if (t.kind === 'punct' && t.value === '!' && depth === 0) break;
          else if (t.kind === 'name' && depth === 0) {
            if (peek(p)?.kind === 'punct' && peek(p)?.value === '!') next(p);
            break;
          }
        }
        // Default value, if any.
        if (peek(p)?.kind === 'punct' && peek(p)?.value === '=') {
          next(p);
          variables[varName] = parseValue(p);
        } else {
          variables[varName] = undefined;
        }
      }
      expectPunct(p, ')');
    }
    const selections = parseSelectionSet(p);
    return { type, name, variables, selections };
  }
  throw new Error('empty GraphQL document');
}

// ------------------------------------------------------------------ executor

type GqlValue =
  | { kind: 'viewer' }
  | { kind: 'owner'; login: string }
  | { kind: 'repo'; repo: Repo }
  | { kind: 'issue'; repo: Repo; issue: Issue }
  | { kind: 'pull'; repo: Repo; pull: Pull }
  | { kind: 'comment'; repo: Repo; issue: Issue; id: number; body: string }
  | { kind: 'commentEdge'; repo: Repo; issue: Issue; id: number; body: string }
  | { kind: 'ref'; name: string }
  | { kind: 'type'; name: string }
  | { kind: 'issueConn'; repo: Repo; issues: Issue[] }
  | { kind: 'pullConn'; repo: Repo; pulls: Pull[] }
  | { kind: 'fileConn'; repo: Repo; pull: Pull }
  | { kind: 'pageInfo'; hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null }
  | { kind: 'createIssue'; repo: Repo; issue: Issue }
  | { kind: 'closeIssue'; repo: Repo; issue: Issue }
  | { kind: 'createPull'; repo: Repo; pull: Pull }
  | { kind: 'mergePull'; repo: Repo; pull: Pull }
  | { kind: 'addComment'; repo: Repo; issue: Issue; id: number; body: string };

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'url', 'repository', 'closedAt'];
const PULL_FIELDS = ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'createdAt', 'updatedAt', 'author', 'url', 'repository', 'closedAt', 'mergedAt', 'mergeCommit'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url'];
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'];

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'variable':
      return ctx.variables[node.name];
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function argMap(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx);
  return out;
}

function unknownField(ctx: ExecContext, typeName: string, fieldName: string): null {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function typeNameOf(value: GqlValue): string {
  switch (value.kind) {
    case 'viewer':
      return 'Viewer';
    case 'owner':
      return 'User';
    case 'repo':
      return 'Repository';
    case 'issue':
      return 'Issue';
    case 'pull':
      return 'PullRequest';
    case 'comment':
      return 'IssueComment';
    case 'commentEdge':
      return 'IssueCommentEdge';
    case 'ref':
      return 'Ref';
    case 'type':
      return '__Type';
    case 'issueConn':
      return 'IssueConnection';
    case 'pullConn':
      return 'PullRequestConnection';
    case 'fileConn':
      return 'PullRequestChangedFileConnection';
    case 'pageInfo':
      return 'PageInfo';
    case 'createIssue':
      return 'CreateIssuePayload';
    case 'closeIssue':
      return 'CloseIssuePayload';
    case 'createPull':
      return 'CreatePullRequestPayload';
    case 'mergePull':
      return 'MergePullRequestPayload';
    case 'addComment':
      return 'AddCommentPayload';
  }
}

function executeSelections(value: GqlValue, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const applies =
        selection.typeCondition === null || selection.typeCondition === typeNameOf(value);
      if (applies) Object.assign(out, executeSelections(value, selection.children, ctx));
      continue;
    }
    const field = selection.field;
    out[field.alias] = executeField(value, field, ctx);
  }
  return out;
}

function executeField(value: GqlValue, field: FieldNode, ctx: ExecContext): unknown {
  const args = argMap(field, ctx);
  const result = resolveField(value, field.name, args, ctx);
  if (result === undefined) return unknownField(ctx, typeNameOf(value), field.name);
  if (result === null || typeof result !== 'object' || !('__gql' in result)) {
    // Scalar or plain list of scalars.
    if (Array.isArray(result)) return result.map((item) => (item !== null && typeof item === 'object' && '__gql' in item ? executeSelections(item as GqlValue, field.children, ctx) : item));
    return result;
  }
  return executeSelections(result as GqlValue, field.children, ctx);
}

function paginateConnection<T>(items: readonly T[], args: Record<string, unknown>): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  const first = typeof args.first === 'number' ? args.first : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const index = Number.parseInt(decoded.replace('cursor:', ''), 10);
      if (Number.isInteger(index)) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const page = items.slice(start, start + first);
  const hasNextPage = start + first < items.length;
  const endCursor = page.length > 0 ? Buffer.from(`cursor:${start + page.length - 1}`, 'utf8').toString('base64') : null;
  return { page, hasNextPage, endCursor };
}

function resolveField(value: GqlValue, name: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const { store } = ctx;
  switch (value.kind) {
    case 'viewer': {
      if (name === 'login') return VIEWER_LOGIN;
      if (name === 'id') return VIEWER_ID;
      return undefined;
    }
    case 'owner': {
      if (name === 'login') return value.login;
      if (name === 'id') return value.login === VIEWER_LOGIN ? VIEWER_ID : 1001;
      return undefined;
    }
    case 'repo': {
      const repo = value.repo;
      switch (name) {
        case 'id':
          return gidRepo(repo.owner, repo.name);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return { kind: 'owner', login: repo.owner, __gql: true } as GqlValue;
        case 'defaultBranchRef': {
          const tip = repo.refs.get(repo.defaultRef);
          if (tip === undefined) return null;
          return { kind: 'ref', name: repo.defaultBranch, __gql: true } as GqlValue;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = args.number as number;
          const issue = repo.issues.get(number);
          if (issue === undefined) return null;
          return { kind: 'issue', repo, issue, __gql: true } as GqlValue;
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          if (Array.isArray(args.states)) {
            const wanted = new Set((args.states as string[]).map((s) => s.toLowerCase()));
            issues = issues.filter((i) => wanted.has(i.state));
          }
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          const direction = orderBy?.direction ?? 'DESC';
          issues.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          return { kind: 'issueConn', repo, issues, __gql: true, __args: args } as GqlValue & { __args: Record<string, unknown> };
        }
        case 'pullRequest': {
          const number = args.number as number;
          const pull = repo.pulls.get(number);
          if (pull === undefined) return null;
          return { kind: 'pull', repo, pull, __gql: true } as GqlValue;
        }
        case 'pullRequests': {
          const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
          return { kind: 'pullConn', repo, pulls, __gql: true, __args: args } as GqlValue & { __args: Record<string, unknown> };
        }
        case 'url':
          return `https://github.local/${repo.owner}/${repo.name}`;
        default:
          return undefined;
      }
    }
    case 'issue': {
      const issue = value.issue;
      switch (name) {
        case 'id':
          return gidIssue(value.repo.owner, value.repo.name, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'createdAt':
        case 'updatedAt':
          return new Date(1_700_000_000_000 + issue.createdSeq * 1000).toISOString();
        default:
          return undefined;
      }
    }
    case 'pull': {
      const pull = value.pull;
      switch (name) {
        case 'id':
          return gidPull(value.repo.owner, value.repo.name, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return store.pullMergeable(value.repo, pull);
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN';
        case 'merged':
          return pull.merged;
        case 'files':
          return { kind: 'fileConn', repo: value.repo, pull, __gql: true, __args: args } as GqlValue & { __args: Record<string, unknown> };
        case 'createdAt':
        case 'updatedAt':
          return new Date(1_700_000_000_000 + pull.createdSeq * 1000).toISOString();
        default:
          return undefined;
      }
    }
    case 'comment': {
      if (name === 'id') return gidComment(value.repo.owner, value.repo.name, value.issue.number, value.id);
      if (name === 'body') return value.body;
      return undefined;
    }
    case 'commentEdge': {
      if (name === 'node') return { kind: 'comment', repo: value.repo, issue: value.issue, id: value.id, body: value.body, __gql: true } as GqlValue;
      if (name === 'cursor') return null;
      return undefined;
    }
    case 'ref': {
      if (name === 'name') return value.name;
      return undefined;
    }
    case 'type': {
      if (name === 'name') return value.name;
      if (name === 'kind') return value.name === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        const list =
          value.name === 'Issue' ? ISSUE_FIELDS : value.name === 'PullRequest' ? PULL_FIELDS : value.name === 'Repository' ? REPO_FIELDS : null;
        if (list === null) return null;
        return list.map((fieldName) => ({ name: fieldName }));
      }
      if (name === 'enumValues') {
        if (value.name !== 'SearchType') return null;
        return SEARCH_ENUM.map((enumName) => ({ name: enumName }));
      }
      return undefined;
    }
    case 'issueConn': {
      const argsForConn = (value as GqlValue & { __args?: Record<string, unknown> }).__args ?? {};
      const merged = { ...argsForConn, ...args };
      if (name === 'nodes') {
        const { page } = paginateConnection(value.issues, merged);
        return page.map((issue) => ({ kind: 'issue', repo: value.repo, issue, __gql: true }) as GqlValue);
      }
      if (name === 'totalCount') return value.issues.length;
      if (name === 'pageInfo') {
        const { hasNextPage, endCursor } = paginateConnection(value.issues, merged);
        return { kind: 'pageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: null, __gql: true } as GqlValue;
      }
      return undefined;
    }
    case 'pullConn': {
      const argsForConn = (value as GqlValue & { __args?: Record<string, unknown> }).__args ?? {};
      const merged = { ...argsForConn, ...args };
      if (name === 'nodes') {
        const { page } = paginateConnection(value.pulls, merged);
        return page.map((pull) => ({ kind: 'pull', repo: value.repo, pull, __gql: true }) as GqlValue);
      }
      if (name === 'totalCount') return value.pulls.length;
      if (name === 'pageInfo') {
        const { hasNextPage, endCursor } = paginateConnection(value.pulls, merged);
        return { kind: 'pageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: null, __gql: true } as GqlValue;
      }
      return undefined;
    }
    case 'fileConn': {
      if (name === 'nodes') {
        const files = store.pullFiles(value.repo, value.pull);
        const { page } = paginateConnection(files, args);
        return page.map((file) => ({ path: file.path }));
      }
      if (name === 'totalCount') return store.pullFiles(value.repo, value.pull).length;
      if (name === 'pageInfo') {
        const files = store.pullFiles(value.repo, value.pull);
        const { hasNextPage, endCursor } = paginateConnection(files, args);
        return { kind: 'pageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: null, __gql: true } as GqlValue;
      }
      return undefined;
    }
    case 'pageInfo': {
      if (name === 'hasNextPage') return value.hasNextPage;
      if (name === 'endCursor') return value.endCursor;
      if (name === 'hasPreviousPage') return value.hasPreviousPage;
      if (name === 'startCursor') return value.startCursor;
      return undefined;
    }
    case 'createIssue': {
      if (name === 'issue') return { kind: 'issue', repo: value.repo, issue: value.issue, __gql: true } as GqlValue;
      if (name === 'clientMutationId') return null;
      return undefined;
    }
    case 'closeIssue': {
      if (name === 'issue') return { kind: 'issue', repo: value.repo, issue: value.issue, __gql: true } as GqlValue;
      if (name === 'clientMutationId') return null;
      return undefined;
    }
    case 'createPull': {
      if (name === 'pullRequest') return { kind: 'pull', repo: value.repo, pull: value.pull, __gql: true } as GqlValue;
      if (name === 'clientMutationId') return null;
      return undefined;
    }
    case 'mergePull': {
      if (name === 'pullRequest') return { kind: 'pull', repo: value.repo, pull: value.pull, __gql: true } as GqlValue;
      if (name === 'clientMutationId') return null;
      return undefined;
    }
    case 'addComment': {
      if (name === 'commentEdge') {
        return { kind: 'commentEdge', repo: value.repo, issue: value.issue, id: value.id, body: value.body, __gql: true } as GqlValue;
      }
      if (name === 'clientMutationId') return null;
      return undefined;
    }
  }
}

// Root fields (Query and Mutation) live on a synthetic root value.
type RootValue = { kind: 'root'; store: Store };

function resolveRootField(value: RootValue, name: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const { store } = value;
  if (name === '__typename') return 'Query';
  if (name === 'viewer') return { kind: 'viewer', __gql: true } as GqlValue;
  if (name === 'repository') {
    const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
    if (repo === undefined) return null;
    return { kind: 'repo', repo, __gql: true } as GqlValue;
  }
  if (name === 'node') {
    const decoded = typeof args.id === 'string' ? decodeGid(args.id) : null;
    if (decoded === null) return null;
    const repoMatch = /^repo:(.+)\/(.+)$/.exec(decoded);
    if (repoMatch !== null) {
      const repo = store.getRepo(repoMatch[1] as string, repoMatch[2] as string);
      if (repo === undefined) return null;
      return { kind: 'repo', repo, __gql: true } as GqlValue;
    }
    const issueMatch = /^issue:(.+)\/(.+)#(\d+)$/.exec(decoded);
    if (issueMatch !== null) {
      const repo = store.getRepo(issueMatch[1] as string, issueMatch[2] as string);
      const issue = repo?.issues.get(Number(issueMatch[3]));
      if (repo === undefined || issue === undefined) return null;
      return { kind: 'issue', repo, issue, __gql: true } as GqlValue;
    }
    const pullMatch = /^pr:(.+)\/(.+)#(\d+)$/.exec(decoded);
    if (pullMatch !== null) {
      const repo = store.getRepo(pullMatch[1] as string, pullMatch[2] as string);
      const pull = repo?.pulls.get(Number(pullMatch[3]));
      if (repo === undefined || pull === undefined) return null;
      return { kind: 'pull', repo, pull, __gql: true } as GqlValue;
    }
    return null;
  }
  if (name === '__type') {
    const typeName = String(args.name ?? '');
    if (['Issue', 'PullRequest', 'Repository', 'SearchType'].includes(typeName)) {
      return { kind: 'type', name: typeName, __gql: true } as GqlValue;
    }
    return null;
  }
  if (name === '__schema') return { kind: 'type', name: 'Query', __gql: true } as GqlValue;
  return undefined;
}

function resolveMutationField(value: RootValue, name: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const { store } = value;
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const repoId = typeof input.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
    const match = repoId === null ? null : /^repo:(.+)\/(.+)$/.exec(repoId);
    if (match === null) return null;
    const repo = store.getRepo(match[1] as string, match[2] as string);
    if (repo === undefined) return null;
    const result = store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? ''), labels: [] });
    if ('error' in result) return null;
    return { kind: 'createIssue', repo, issue: result.issue, __gql: true } as GqlValue;
  }
  if (name === 'closeIssue') {
    const issueId = typeof input.issueId === 'string' ? decodeGid(input.issueId) : null;
    const match = issueId === null ? null : /^issue:(.+)\/(.+)#(\d+)$/.exec(issueId);
    if (match === null) return null;
    const repo = store.getRepo(match[1] as string, match[2] as string);
    const issue = repo?.issues.get(Number(match[3]));
    if (repo === undefined || issue === undefined) return null;
    issue.state = 'closed';
    const { seq } = store.tick();
    issue.updatedSeq = seq;
    return { kind: 'closeIssue', repo, issue, __gql: true } as GqlValue;
  }
  if (name === 'createPullRequest') {
    const repoId = typeof input.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
    const match = repoId === null ? null : /^repo:(.+)\/(.+)$/.exec(repoId);
    if (match === null) return null;
    const repo = store.getRepo(match[1] as string, match[2] as string);
    if (repo === undefined) return null;
    const result = store.createPull(repo, {
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
    });
    if ('error' in result) return null;
    return { kind: 'createPull', repo, pull: result.pull, __gql: true } as GqlValue;
  }
  if (name === 'mergePullRequest') {
    const pullId = typeof input.pullRequestId === 'string' ? decodeGid(input.pullRequestId) : null;
    const match = pullId === null ? null : /^pr:(.+)\/(.+)#(\d+)$/.exec(pullId);
    if (match === null) return null;
    const repo = store.getRepo(match[1] as string, match[2] as string);
    const pull = repo?.pulls.get(Number(match[3]));
    if (repo === undefined || pull === undefined) return null;
    const result = store.mergePull(repo, pull, 'squash');
    if (!result.ok) return null;
    return { kind: 'mergePull', repo, pull, __gql: true } as GqlValue;
  }
  if (name === 'addComment') {
    const subjectId = typeof input.subjectId === 'string' ? decodeGid(input.subjectId) : null;
    const issueMatch = subjectId === null ? null : /^issue:(.+)\/(.+)#(\d+)$/.exec(subjectId);
    const pullMatch = subjectId === null ? null : /^pr:(.+)\/(.+)#(\d+)$/.exec(subjectId);
    const match = issueMatch ?? pullMatch;
    if (match === null) return null;
    const repo = store.getRepo(match[1] as string, match[2] as string);
    const issue = repo?.issues.get(Number(match[3]));
    if (repo === undefined || issue === undefined) return null;
    const comment = store.createComment(repo, issue, String(input.body ?? ''));
    return { kind: 'addComment', repo, issue, id: comment.id, body: comment.body, __gql: true } as GqlValue;
  }
  return undefined;
}

function executeOperation(store: Store, operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const ctx: ExecContext = { store, variables, errors: [] };
  const root: RootValue = { kind: 'root', store };
  const out: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind === 'fragment') continue;
    const field = selection.field;
    const args = argMap(field, ctx);
    let result: unknown;
    if (operation.type === 'mutation') {
      result = resolveMutationField(root, field.name, args, ctx);
    } else {
      result = resolveRootField(root, field.name, args, ctx);
    }
    if (result === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${operation.type === 'mutation' ? 'Mutation' : 'Query'}".` });
      out[field.alias] = null;
      continue;
    }
    if (result === null) {
      out[field.alias] = null;
      continue;
    }
    if (typeof result === 'object' && '__gql' in (result as Record<string, unknown>)) {
      out[field.alias] = executeSelections(result as GqlValue, field.children, ctx);
      continue;
    }
    out[field.alias] = result;
  }
  const response: { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } = { data: out };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

export interface GraphQLResult {
  status: number;
  body: unknown;
}

/** Execute one GraphQL HTTP body (single operation or a batch array). */
export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  const run = (entry: unknown): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'request body must be a JSON object with a query string' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: null, errors: [{ message: 'query must be a non-empty string' }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    let operation: Operation;
    try {
      operation = parseDocument(query);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'failed to parse query' }] };
    }
    return executeOperation(store, operation, variables);
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => run(entry)) };
  }
  return { status: 200, body: run(body) };
}
