// rest.ts — GitHub REST v3: repositories, branches, commits, contents, issues,
// comments, labels and pull requests. Every reply is JSON with X-GitHub-Request-Id
// (added by app.ts); errors carry {message}.

import { hashObject, parseCommit, parseTree } from './gitcore.ts';
import { countLines } from './graph.ts';
import { b64decode, b64encode, VIEWER_ID, VIEWER_LOGIN } from './store.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function notFound(): RestResult {
  return err(404, 'Not Found');
}

export function repoView(repo: Repo, host: string): Record<string, unknown> {
  const base = `http://${host}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1001, type: 'User', html_url: `${base}/${repo.owner}` },
    private: repo.privateFlag,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: new Date(1_700_000_000_000 + repo.createdSeq * 1000).toISOString(),
    updated_at: new Date(1_700_000_000_000 + repo.createdSeq * 1000).toISOString(),
    pushed_at: new Date(1_700_000_000_000 + repo.createdSeq * 1000).toISOString(),
    git_url: `git://${host}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${host}:${repo.owner}/${repo.name}.git`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.privateFlag ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function issueView(repo: Repo, issue: Issue, host: string): Record<string, unknown> {
  const base = `http://${host}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: new Date(1_700_000_000_000 + issue.createdSeq * 1000).toISOString(),
    updated_at: new Date(1_700_000_000_000 + issue.updatedSeq * 1000).toISOString(),
    closed_at: issue.state === 'closed' ? new Date(1_700_000_000_000 + issue.updatedSeq * 1000).toISOString() : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

export function pullView(repo: Repo, pull: Pull, host: string, store: Store): Record<string, unknown> {
  const base = `http://${host}`;
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: [],
    milestone: null,
    created_at: new Date(1_700_000_000_000 + pull.createdSeq * 1000).toISOString(),
    updated_at: new Date(1_700_000_000_000 + pull.createdSeq * 1000).toISOString(),
    closed_at: pull.state === 'closed' ? pull.mergedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: store.pullMergeable(repo, pull) === 'MERGEABLE',
    mergeable_state: pull.merged ? 'merged' : store.pullMergeable(repo, pull) === 'MERGEABLE' ? 'clean' : 'dirty',
    merged_by: pull.merged ? { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' } : null,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      repo: repoView(repo, host),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      repo: repoView(repo, host),
    },
    author_association: 'OWNER',
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function pagination(query: Record<string, string>): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.per_page ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: Record<string, string>, host: string, path: string): { items: T[]; link: string | null } {
  const { page, perPage } = pagination(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const urlFor = (p: number): string => `http://${host}${path}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { items: [...slice], link: links.length > 0 ? links.join(', ') : null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The REST v3 dispatcher. `segments` are the decoded path parts after /api/v3. */
export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: Record<string, string>,
  body: unknown,
  host: string,
): RestResult {
  const seg = segments;
  // ---- API root
  if (seg.length === 0) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return ok({ installed_version: '1.0.0' });
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return ok({ login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', html_url: `http://${host}/${VIEWER_LOGIN}` });
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const repos = store.listReposByOwner(VIEWER_LOGIN);
      const { items, link } = paginate(repos.map((r) => repoView(r, host)), query, host, '/api/v3/user/repos');
      return ok(items, 200, link === null ? undefined : { link });
    }
    if (method === 'POST') {
      if (!isRecord(body)) return err(422, 'name is required');
      const name = str(body.name).trim();
      if (name === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'invalid repository name');
      const created = store.createRepo(VIEWER_LOGIN, name, {
        description: str(body.description),
        privateFlag: body.private === true,
        defaultBranch: typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : undefined,
      });
      if (created === null) return err(422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
      return ok(repoView(created, host), 201);
    }
    return err(405, 'Method Not Allowed');
  }
  if (seg[0] !== 'repos' || seg.length < 3) return notFound();
  const owner = seg[1] as string;
  const name = seg[2] as string;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return notFound();
  const rest = seg.slice(3);

  // ---- /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return ok(repoView(repo, host));
    if (method === 'PATCH') {
      if (!isRecord(body)) return err(422, 'invalid body');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.privateFlag = body.private;
      return ok(repoView(repo, host));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      return { status: 204, body: null };
    }
    return err(405, 'Method Not Allowed');
  }

  // ---- branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) }, protected: false }));
      return ok(branches);
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = rest[1] as string;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return notFound();
      return ok({ name: branch, commit: { sha }, protected: false });
    }
    return notFound();
  }

  // ---- commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const refish = query.sha ?? repo.defaultBranch;
    const tip = store.resolveCommit(repo, refish);
    if (tip === null) return notFound();
    const commits = store.listCommits(repo, tip).map((c) => ({
      sha: c.sha,
      commit: {
        message: c.message,
        author: { name: 'Forge', email: 'forge@example.invalid' },
        committer: { name: 'Forge', email: 'forge@example.invalid' },
        tree: { sha: c.tree },
      },
      author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      parents: c.parents.map((p) => ({ sha: p })),
    }));
    const { items, link } = paginate(commits, query, host, `/api/v3/repos/${owner}/${name}/commits`);
    return ok(items, 200, link === null ? undefined : { link });
  }

  // ---- git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (!isRecord(body)) return err(422, 'ref and sha are required');
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'ref and sha are required');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      return ok({ ref, node_id: `R_${hashObject('blob', Buffer.from(ref))}`.slice(0, 12), url: `http://${host}/api/v3/repos/${owner}/${name}/git/refs/${ref}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } }, 201);
    }
    if (method === 'GET' && rest.length > 2) {
      const ref = rest.slice(2).join('/');
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound();
      return ok({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    return notFound();
  }

  // ---- contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') {
      const refish = query.ref ?? repo.defaultBranch;
      const tip = store.resolveCommit(repo, refish);
      if (tip === null) return notFound();
      const commit = repo.objects.get(tip);
      if (commit?.type !== 'commit') return notFound();
      const treeOid = parseCommit(commit.data).tree;
      return contentsGet(store, repo, treeOid, path, host);
    }
    if (method === 'PUT') {
      if (!isRecord(body)) return err(422, 'message and content are required');
      const contentRaw = str(body.content);
      if (contentRaw === '') return err(422, 'content is required');
      let content: Buffer;
      try {
        content = b64decode(contentRaw);
      } catch {
        return err(422, 'content is not valid base64');
      }
      const message = str(body.message) === '' ? `Update ${path}` : str(body.message);
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : undefined;
      const sha = typeof body.sha === 'string' && body.sha !== '' ? body.sha : undefined;
      const result = store.commitFile(repo, { path, content, message, branch, sha });
      if ('error' in result) return err(result.status, result.error);
      const blob = repo.objects.get(result.contentSha);
      return ok(
        {
          content: { name: path.split('/').pop(), path, sha: result.contentSha, size: content.length, type: 'file', encoding: 'base64', content: b64encode(content) },
          commit: { sha: result.commitSha, message },
        },
        result.status,
      );
    }
    if (method === 'DELETE') {
      if (!isRecord(body)) return err(422, 'message and sha are required');
      const message = str(body.message) === '' ? `Delete ${path}` : str(body.message);
      const sha = typeof body.sha === 'string' && body.sha !== '' ? body.sha : undefined;
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : undefined;
      const result = store.deleteFile(repo, { path, message, branch, sha });
      if ('error' in result) return err(result.status, result.error);
      return ok({ commit: { sha: result.commitSha, message } });
    }
    return err(405, 'Method Not Allowed');
  }

  // ---- labels
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return ok([...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
    }
    if (method === 'POST' && rest.length === 1) {
      if (!isRecord(body)) return err(422, 'name is required');
      const labelName = str(body.name).trim();
      if (labelName === '') return err(422, 'name is required');
      const existing = repo.labels.get(labelName);
      if (existing !== undefined) return ok({ name: existing.name, color: existing.color, description: existing.description }, 201);
      const label = { name: labelName, color: str(body.color) === '' ? 'ededed' : str(body.color), description: str(body.description) };
      repo.labels.set(labelName, label);
      return ok({ name: label.name, color: label.color, description: label.description }, 201);
    }
    return notFound();
  }

  // ---- issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        let issues = [...repo.issues.values()];
        const state = query.state ?? 'open';
        if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
        const direction = query.direction ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        const { items, link } = paginate(issues.map((i) => issueView(repo, i, host)), query, host, `/api/v3/repos/${owner}/${name}/issues`);
        return ok(items, 200, link === null ? undefined : { link });
      }
      if (method === 'POST') {
        if (!isRecord(body)) return err(422, 'title is required');
        const title = str(body.title).trim();
        if (title === '') return err(422, 'title is required');
        const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
        const result = store.createIssue(repo, { title, body: str(body.body), labels });
        if ('error' in result) return err(422, result.error);
        return ok(issueView(repo, result.issue, host), 201);
      }
      return err(405, 'Method Not Allowed');
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number)) return notFound();
    const issue = repo.issues.get(number);
    if (rest.length === 2) {
      if (issue === undefined) return notFound();
      if (method === 'GET') return ok(issueView(repo, issue, host));
      if (method === 'PATCH') {
        if (!isRecord(body)) return err(422, 'invalid body');
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        const { seq } = store.tick();
        issue.updatedSeq = seq;
        return ok(issueView(repo, issue, host));
      }
      return err(405, 'Method Not Allowed');
    }
    if (rest[2] === 'comments') {
      if (issue === undefined) return notFound();
      if (method === 'GET') {
        return ok(issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: new Date(1_700_000_000_000 + c.createdSeq * 1000).toISOString(), updated_at: new Date(1_700_000_000_000 + c.createdSeq * 1000).toISOString() })));
      }
      if (method === 'POST') {
        if (!isRecord(body) || str(body.body).trim() === '') return err(422, 'body is required');
        const comment = store.createComment(repo, issue, str(body.body));
        return ok({ id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: new Date(1_700_000_000_000 + comment.createdSeq * 1000).toISOString(), updated_at: new Date(1_700_000_000_000 + comment.createdSeq * 1000).toISOString() }, 201);
      }
      return err(405, 'Method Not Allowed');
    }
    return notFound();
  }

  // ---- pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        let pulls = [...repo.pulls.values()];
        const state = query.state ?? 'open';
        if (state === 'open' || state === 'closed') pulls = pulls.filter((p) => p.state === state);
        pulls.sort((a, b) => b.number - a.number);
        const { items, link } = paginate(pulls.map((p) => pullView(repo, p, host, store)), query, host, `/api/v3/repos/${owner}/${name}/pulls`);
        return ok(items, 200, link === null ? undefined : { link });
      }
      if (method === 'POST') {
        if (!isRecord(body)) return err(422, 'title, head and base are required');
        const title = str(body.title).trim();
        const head = str(body.head).trim();
        const base = str(body.base).trim();
        if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
        const result = store.createPull(repo, { title, body: str(body.body), head, base });
        if ('error' in result) return err(result.status, result.error);
        return ok(pullView(repo, result.pull, host, store), 201);
      }
      return err(405, 'Method Not Allowed');
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number)) return notFound();
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (pull === undefined) return notFound();
      if (method === 'GET') return ok(pullView(repo, pull, host, store));
      return err(405, 'Method Not Allowed');
    }
    if (rest[2] === 'files' && rest.length === 3 && method === 'GET') {
      if (pull === undefined) return notFound();
      const files = store.pullFiles(repo, pull).map((change) => {
        const oldBlob = change.oldOid === null ? null : repo.objects.get(change.oldOid);
        const newBlob = change.newOid === null ? null : repo.objects.get(change.newOid);
        const additions = change.status === 'removed' ? 0 : countLines(newBlob?.data ?? Buffer.alloc(0));
        const deletions = change.status === 'added' ? 0 : countLines(oldBlob?.data ?? Buffer.alloc(0));
        return {
          sha: change.newOid ?? change.oldOid,
          filename: change.path,
          status: change.status,
          additions,
          deletions,
          changes: additions + deletions,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        };
      });
      return ok(files);
    }
    if (rest[2] === 'merge' && rest.length === 3 && method === 'PUT') {
      if (pull === undefined) return notFound();
      const mergeMethod = isRecord(body) && typeof body.merge_method === 'string' ? body.merge_method : 'squash';
      const result = store.mergePull(repo, pull, mergeMethod);
      if (!result.ok) return err(result.status, result.message);
      return ok({ sha: result.sha, merged: true, message: result.message });
    }
    return notFound();
  }

  return notFound();
}

function contentsGet(store: Store, repo: Repo, treeOid: string, path: string, host: string): RestResult {
  const flat = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const p = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, p);
      else flat.set(p, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  if (path === '') {
    // Root listing: top-level files and directories.
    const entries: Array<Record<string, unknown>> = [];
    const seenDirs = new Set<string>();
    const top = new Map<string, { oid: string; mode: string; isDir: boolean }>();
    for (const [p, entry] of flat) {
      const slash = p.indexOf('/');
      if (slash < 0) top.set(p, { oid: entry.oid, mode: entry.mode, isDir: false });
      else {
        const dir = p.slice(0, slash);
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          top.set(dir, { oid: '', mode: '40000', isDir: true });
        }
      }
    }
    // Directory shas come from the tree itself.
    const obj = repo.objects.get(treeOid);
    if (obj !== undefined) {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000' && top.has(entry.name)) {
          const current = top.get(entry.name) as { oid: string; mode: string; isDir: boolean };
          current.oid = entry.oid;
        }
      }
    }
    for (const [name, entry] of [...top.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const blob = entry.isDir ? undefined : repo.objects.get(entry.oid);
      entries.push({
        type: entry.isDir ? 'dir' : 'file',
        name,
        path: name,
        sha: entry.oid,
        size: blob?.data.length ?? 0,
        url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/contents/${name}`,
        html_url: `http://${host}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${name}`,
        download_url: null,
      });
    }
    return ok(entries);
  }
  const file = flat.get(path);
  if (file !== undefined) {
    const blob = repo.objects.get(file.oid);
    if (blob === undefined) return notFound();
    return ok({
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop(),
      path,
      content: b64encode(blob.data),
      sha: file.oid,
      url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `http://${host}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      download_url: null,
    });
  }
  // Directory listing: entries directly under `path`.
  const prefix = `${path}/`;
  const children = new Map<string, { oid: string; mode: string; isDir: boolean }>();
  for (const [p, entry] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { oid: entry.oid, mode: entry.mode, isDir: false });
    else children.set(rest.slice(0, slash), { oid: '', mode: '40000', isDir: true });
  }
  if (children.size === 0) return notFound();
  // Resolve directory shas from the nested tree.
  const resolveDirSha = (dirPath: string): string => {
    let oid = treeOid;
    for (const segment of dirPath.split('/')) {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return '';
      const entry = parseTree(obj.data).find((e) => e.name === segment && e.mode === '40000');
      if (entry === undefined) return '';
      oid = entry.oid;
    }
    return oid;
  };
  const entries: Array<Record<string, unknown>> = [];
  for (const [name, entry] of [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const oid = entry.isDir ? resolveDirSha(`${path}/${name}`) : entry.oid;
    const blob = entry.isDir ? undefined : repo.objects.get(oid);
    entries.push({
      type: entry.isDir ? 'dir' : 'file',
      name,
      path: `${path}/${name}`,
      sha: oid,
      size: blob?.data.length ?? 0,
      url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}/${name}`,
      html_url: `http://${host}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}/${name}`,
      download_url: null,
    });
  }
  return ok(entries);
}
