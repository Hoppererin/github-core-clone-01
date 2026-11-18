// app.ts — the entry's HTTP server: routing, auth, body reading and the response
// envelope. All state lives in one Store; every reply is JSON (except the git
// smart-HTTP byte streams) and carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { infoRefs, receivePack, uploadPack } from './gitserver.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The token the trial's env sets; when it is unset (local runs) any non-empty Bearer is accepted. */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'x-github-request-id': requestId,
    ...(extraHeaders ?? {}),
  };
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(status, headers);
  res.end(`${JSON.stringify(body)}\n`);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

export function createApp(): Server {
  const store = new Store();
  let requestCounter = 0;

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const requestId = `req-${requestCounter + 1}`;
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = `req-${++requestCounter}`;
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    let url: URL;
    try {
      url = new URL(rawUrl, 'http://localhost');
    } catch {
      sendJson(res, 400, { message: 'malformed URL' }, requestId);
      return;
    }
    const host = req.headers.host ?? '127.0.0.1';
    const segments = url.pathname.split('/').filter((s) => s !== '').map(decodeSegment);
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!(key in query)) query[key] = value;
    }

    // ---- health check: no auth, always 200.
    if (segments.length === 1 && segments[0] === 'healthz' && method === 'GET') {
      sendJson(res, 200, { ok: true }, requestId);
      return;
    }

    const isApi = segments[0] === 'api' && (segments[1] === 'v3' || segments[1] === 'graphql');
    const isMcp = segments.length === 1 && segments[0] === 'mcp';
    if (isApi || isMcp) {
      // ---- auth: a Bearer token is required; when MAKEFUN_SHOP_TOKEN is set it must match exactly.
      const authorization = req.headers.authorization ?? '';
      const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
      const expected = expectedToken();
      if (bearer === '' || (expected !== '' && bearer !== expected)) {
        sendJson(res, 401, { message: 'Unauthorized' }, requestId);
        return;
      }
    }

    const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

    // ---- git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
    const gitAction = segments.length >= 3 ? segments[2] : undefined;
    if (
      segments.length >= 3 &&
      segments[1] !== undefined &&
      (gitAction === 'info' || gitAction === 'git-upload-pack' || gitAction === 'git-receive-pack')
    ) {
      const owner = segments[0] as string;
      const repoName = (segments[1] as string).endsWith('.git') ? (segments[1] as string).slice(0, -'.git'.length) : (segments[1] as string);
      const repo = store.getRepo(owner, repoName);
      const action = gitAction;
      if (action === 'info' && segments[3] === 'refs' && method === 'GET') {
        const service = query.service;
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 400, { message: 'service is required' }, requestId);
          return;
        }
        const wantV2 = req.headers['git-protocol'] === 'version=2';
        const result = infoRefs(repo, service, wantV2);
        sendBytes(res, result.status, result.contentType, result.body, requestId);
        return;
      }
      if (action === 'git-upload-pack' && method === 'POST') {
        const wantV2 = req.headers['git-protocol'] === 'version=2';
        const result = uploadPack(repo, rawBody, wantV2);
        sendBytes(res, result.status, result.contentType, result.body, requestId);
        return;
      }
      if (action === 'git-receive-pack' && method === 'POST') {
        const result = receivePack(repo, rawBody);
        sendBytes(res, result.status, result.contentType, result.body, requestId);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' }, requestId);
      return;
    }

    // ---- REST v3
    if (isApi && segments[1] === 'v3') {
      let body: unknown;
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody.toString('utf8')) as unknown;
        } catch {
          sendJson(res, 400, { message: 'malformed JSON body' }, requestId);
          return;
        }
      }
      const result = handleRest(store, method, segments.slice(2), query, body, host);
      sendJson(res, result.status, result.body, requestId, result.headers);
      return;
    }

    // ---- GraphQL
    if (isApi && segments[1] === 'graphql') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
        return;
      }
      let body: unknown;
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody.toString('utf8')) as unknown;
        } catch {
          sendJson(res, 400, { message: 'malformed JSON body' }, requestId);
          return;
        }
      }
      const result = handleGraphQL(store, body);
      sendJson(res, result.status, result.body, requestId);
      return;
    }

    // ---- MCP
    if (isMcp) {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
        return;
      }
      const result = handleMcp(store, rawBody.toString('utf8'), host);
      if (result.body === undefined) {
        res.writeHead(result.status, { 'x-github-request-id': requestId });
        res.end();
        return;
      }
      sendJson(res, result.status, result.body, requestId);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' }, requestId);
  }

  return server;
}
