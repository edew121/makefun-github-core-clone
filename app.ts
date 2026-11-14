// The HTTP server: one process, one port. Routes /healthz (no auth), /mcp, /api/graphql,
// /api/v3/* and the git smart-HTTP endpoints, all over a single Store. Authentication is a
// non-empty Bearer token (matching MAKEFUN_SHOP_TOKEN when it is set); anything else is a
// 401. The server never crashes on a bad request: malformed bodies answer 400 and the
// handler catches the rest as 500 JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import {
  handleInfoRefs,
  handleReceivePackV0,
  handleUploadPackV0,
  handleUploadPackV2,
  type GitRequestContext,
} from './git.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function isAuthenticated(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  if (!match) return false;
  const token = (match[1] as string).trim();
  if (token.length === 0) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected.length > 0 && token !== expected) return false;
  return true;
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer): void {
  const finalHeaders: Record<string, string> = { ...headers, 'content-length': String(body.length) };
  res.writeHead(status, finalHeaders);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  send(res, status, { 'content-type': 'application/json', ...extraHeaders }, Buffer.from(JSON.stringify(value), 'utf8'));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error('request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!rejected) reject(err);
    });
  });
}

function parseGitPath(pathname: string): { owner: string; repo: string; action: string } | null {
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (!match) return null;
  return { owner: decodeURIComponent(match[1] as string), repo: decodeURIComponent(match[2] as string), action: match[3] as string };
}

export function createAppServer(store: Store): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const pathname = url.pathname;
        const method = (req.method ?? 'GET').toUpperCase();
        const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
        const requestId = store.nextRequestId();
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        }

        if (pathname === '/healthz') {
          if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId });
          return sendJson(res, 200, { ok: true }, { 'x-github-request-id': requestId });
        }

        if (!isAuthenticated(req)) {
          return sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId });
        }

        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        if (pathname === '/mcp') {
          if (method === 'DELETE') return sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId });
          if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId });
          const result = handleMcp({ store, viewerLogin: store.viewerLogin, baseUrl }, body);
          return send(res, result.status, result.headers, result.body);
        }

        if (pathname === '/api/graphql') {
          if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId });
          const result = handleGraphQL({ store, viewerLogin: store.viewerLogin }, body);
          return send(res, result.status, { 'content-type': 'application/json' }, result.body);
        }

        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const segments = pathname
            .split('/')
            .filter((part) => part.length > 0)
            .slice(2);
          const result = handleRest({
            store,
            viewerLogin: store.viewerLogin,
            baseUrl,
            method,
            segments,
            query: url.searchParams,
            bodyText: body,
          });
          return send(res, result.status, result.headers, result.body);
        }

        const gitPath = parseGitPath(pathname);
        if (gitPath) {
          const repo = store.getRepo(gitPath.owner, gitPath.repo);
          if (!repo) return sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
          const ctx: GitRequestContext = { method, headers, body, query: url.searchParams };
          if (gitPath.action === 'info/refs') {
            if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId });
            const result = handleInfoRefs(store, repo, ctx);
            return send(res, result.status, result.headers, result.body);
          }
          if (gitPath.action === 'git-upload-pack') {
            if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId });
            const isV2 = (headers['git-protocol'] ?? '').includes('version=2');
            const result = isV2 ? handleUploadPackV2(store, repo, ctx) : handleUploadPackV0(store, repo, ctx);
            return send(res, result.status, result.headers, result.body);
          }
          if (gitPath.action === 'git-receive-pack') {
            if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': requestId });
            const result = handleReceivePackV0(store, repo, ctx);
            return send(res, result.status, result.headers, result.body);
          }
        }

        return sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: (err as Error).message || 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
