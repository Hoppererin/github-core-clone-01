// mcp.ts — Model Context Protocol over Streamable HTTP at POST /mcp (JSON-RPC 2.0).
// Speaks the modern 2026-07-28 era (server/discover) and the legacy handshake
// (initialize). Plain application/json answers; no SSE stream is needed.

import { VIEWER_LOGIN } from './store.ts';
import type { Store } from './store.ts';

export const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// Built once as a constant so two tools/list answers are byte-for-byte identical.
export const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository for the viewer.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        owner: Object.freeze({ type: 'string', description: 'The repository owner (defaults to the viewer).' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Issue state: open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'number', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

export interface McpResult {
  status: number;
  /** undefined means an empty body (notifications). */
  body: unknown;
}

function rpcResult(id: string | number | null, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: string | number | null, code: number, message: string, status = 200): McpResult {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolResult(result: unknown): Record<string, unknown> {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const OWNER_KEYS = ['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'];
const REPO_KEYS = ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'];
const NUMBER_KEYS = ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'];

function pickString(args: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function pickNumber(args: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

/** Resolve owner/repo from the arguments, including a full_name fallback. */
function resolveRepoRef(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = pickString(args, OWNER_KEYS);
  let repo = pickString(args, REPO_KEYS);
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      owner = owner === '' ? (parts[0] as string) : owner;
      repo = repo === '' ? (parts[1] as string) : repo;
    }
  }
  if (owner === '') owner = VIEWER_LOGIN;
  return { owner, repo };
}

/** Dispatch one tools/call. Returns a JSON-RPC error result when the call itself is invalid. */
function callTool(store: Store, name: string, args: Record<string, unknown>, host: string, id: string | number | null): McpResult {
  const base = `http://${host}`;
  switch (name) {
    case 'create_repo': {
      const repoName = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
      if (repoName === '') return rpcError(id, -32602, 'create_repo requires a name');
      const owner = pickString(args, OWNER_KEYS) === '' ? VIEWER_LOGIN : pickString(args, OWNER_KEYS);
      const created = store.createRepo(owner, repoName, {
        description: str(args.description),
        privateFlag: args.private === true,
      });
      if (created === null) {
        return rpcResult(id, toolError(`Repository ${owner}/${repoName} already exists`));
      }
      return rpcResult(id, toolResult({
        id: created.id,
        name: created.name,
        full_name: created.fullName,
        owner: created.owner,
        private: created.privateFlag,
        description: created.description,
        default_branch: created.defaultBranch,
        html_url: `${base}/${created.owner}/${created.name}`,
        clone_url: `${base}/${created.owner}/${created.name}.git`,
      }));
    }
    case 'get_repo': {
      const { owner, repo } = resolveRepoRef(args);
      if (repo === '') return rpcError(id, -32602, 'get_repo requires owner and repo');
      const found = store.getRepo(owner, repo);
      if (found === undefined) return rpcResult(id, toolError(`Repository ${owner}/${repo} not found`));
      return rpcResult(id, toolResult({
        id: found.id,
        name: found.name,
        full_name: found.fullName,
        owner: found.owner,
        private: found.privateFlag,
        description: found.description,
        default_branch: found.defaultBranch,
        html_url: `${base}/${found.owner}/${found.name}`,
        clone_url: `${base}/${found.owner}/${found.name}.git`,
      }));
    }
    case 'create_issue': {
      const { owner, repo } = resolveRepoRef(args);
      const title = pickString(args, ['title', 'issue_title', 'pr_title', 'subject']);
      if (repo === '' || title === '') return rpcError(id, -32602, 'create_issue requires owner, repo and title');
      const found = store.getRepo(owner, repo);
      if (found === undefined) return rpcResult(id, toolError(`Repository ${owner}/${repo} not found`));
      const result = store.createIssue(found, { title, body: str(args.body), labels: [] });
      if ('error' in result) return rpcResult(id, toolError(result.error));
      const issue = result.issue;
      return rpcResult(id, toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        url: `${base}/api/v3/repos/${owner}/${repo}/issues/${issue.number}`,
        html_url: `${base}/${owner}/${repo}/issues/${issue.number}`,
      }));
    }
    case 'list_issues': {
      const { owner, repo } = resolveRepoRef(args);
      if (repo === '') return rpcError(id, -32602, 'list_issues requires owner and repo');
      const found = store.getRepo(owner, repo);
      if (found === undefined) return rpcResult(id, toolError(`Repository ${owner}/${repo} not found`));
      const state = pickString(args, ['state', 'status']);
      let issues = [...found.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      const views = issues.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        url: `${base}/api/v3/repos/${owner}/${repo}/issues/${issue.number}`,
      }));
      return rpcResult(id, toolResult({ issues: views }));
    }
    case 'create_pull_request': {
      const { owner, repo } = resolveRepoRef(args);
      const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
      const head = pickString(args, ['head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from_branch', 'branch']);
      const baseRef = pickString(args, ['base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into_branch']);
      if (repo === '' || title === '' || head === '' || baseRef === '') {
        return rpcError(id, -32602, 'create_pull_request requires owner, repo, title, head and base');
      }
      const found = store.getRepo(owner, repo);
      if (found === undefined) return rpcResult(id, toolError(`Repository ${owner}/${repo} not found`));
      const result = store.createPull(found, { title, body: str(args.body), head, base: baseRef });
      if ('error' in result) return rpcResult(id, toolError(result.error));
      const pull = result.pull;
      const headSha = found.refs.get(`refs/heads/${pull.headRef}`) ?? '';
      const baseSha = found.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
      return rpcResult(id, toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: headSha },
        base: { ref: pull.baseRef, sha: baseSha },
        url: `${base}/api/v3/repos/${owner}/${repo}/pulls/${pull.number}`,
        html_url: `${base}/${owner}/${repo}/pull/${pull.number}`,
      }));
    }
    case 'merge_pull_request': {
      const { owner, repo } = resolveRepoRef(args);
      const number = pickNumber(args, NUMBER_KEYS);
      if (repo === '' || number === null) return rpcError(id, -32602, 'merge_pull_request requires owner, repo and pull_number');
      const found = store.getRepo(owner, repo);
      if (found === undefined) return rpcResult(id, toolError(`Repository ${owner}/${repo} not found`));
      const pull = found.pulls.get(number);
      if (pull === undefined) return rpcResult(id, toolError(`Pull request #${number} not found`));
      const result = store.mergePull(found, pull, 'squash');
      if (!result.ok) return rpcResult(id, toolError(result.message));
      return rpcResult(id, toolResult({
        number: pull.number,
        merged: true,
        state: 'closed',
        sha: result.sha,
        message: result.message,
      }));
    }
    default:
      return rpcError(id, -32602, `unknown tool: ${name}`);
  }
}

/** Handle one POST /mcp body. `rawBody` is the exact request text (parse errors map to -32700). */
export function handleMcp(store: Store, rawBody: string, host: string): McpResult {
  let request: unknown;
  try {
    request = JSON.parse(rawBody);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(request)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const method = typeof request.method === 'string' ? request.method : '';
  const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  // Notifications have no id: answer 202 with an empty body.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: undefined };
  }
  const params = isRecord(request.params) ? request.params : {};
  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        protocolVersion: MCP_VERSIONS[0],
        supportedVersions: [...MCP_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        _meta: { serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = (MCP_VERSIONS as readonly string[]).includes(offered) ? offered : MCP_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (toolName === '') return rpcError(id, -32602, 'tools/call requires a tool name');
      return callTool(store, toolName, args, host, id);
    }
    default: {
      return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}
