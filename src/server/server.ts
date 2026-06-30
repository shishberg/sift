/**
 * server.ts — minimal HTTP API server for sift.
 *
 * Uses Node's built-in `http` (no framework dep) since the API surface is tiny
 * and a thin router is all we need. Reasoning: keeps the dependency footprint at
 * zero for the server itself, matches the project's "local tool, no cloud" ethos.
 *
 * Default port: 3737 — chosen to be distinctive and memorable for this tool,
 * avoiding Vite (5173), OTLP (4317), and common web ports (3000/8080).
 * Override via `AGENT_SEARCH_PORT` env var or the `port` option.
 *
 * Factory pattern: `createServer(deps)` takes injected deps so it is
 * unit-testable without a real DB or ollama. `startServer()` wires real deps.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SearchResult } from '../search/search.js';
import type { TranscriptItem } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionResponse {
  sessionId: string;
  /** Agent that produced the session; null if unknown. */
  agentType: string | null;
  /** First real log file path (for the copy-path button). '' if none. */
  filePath: string;
  /** Working directory relative to $HOME; '' if not recorded. */
  cwd: string;
  items: TranscriptItem[];
}

export interface StatusResponse {
  total: number;
  embedded: number;
  pending: number;
}

/** Injected dependencies — all pure function-shaped so tests can pass fakes. */
export interface ServerDeps {
  search: (query: string, limit?: number) => Promise<SearchResult[]>;
  /** Most recently touched sessions (no query), newest message first. */
  getRecent: (limit?: number) => SearchResult[];
  getSession: (sessionId: string) => SessionResponse;
  getStatus: () => StatusResponse;
}

export interface ServerOptions {
  port?: number;
  /** Directory to serve static files from. Defaults to <root>/web/dist. */
  staticDir?: string;
  /**
   * Long-poll tuning for GET /api/status. When a request carries a `since` token
   * equal to the current status, the handler holds the response open until the
   * status changes or `timeoutMs` elapses, checking every `intervalMs`. Defaults:
   * 30s timeout, 1s interval. Injectable so tests can use small values.
   */
  statusLongPoll?: { timeoutMs?: number; intervalMs?: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PORT = 3737;

/** Default long-poll window for /api/status: hold the request up to 30s. */
export const STATUS_LONGPOLL_TIMEOUT_MS = 30_000;
/** How often the long-poll handler re-checks the status while waiting. */
export const STATUS_LONGPOLL_INTERVAL_MS = 1_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolved at module load; works from both src/ and dist/. */
const DEFAULT_STATIC_DIR = path.resolve(__dirname, '../../web/dist');

// ---------------------------------------------------------------------------
// MIME types for static file serving
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// Request handler helpers
// ---------------------------------------------------------------------------

function jsonOk(res: http.ServerResponse, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

function jsonError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Parse an optional `limit` query param. Returns the number, `undefined` when
 * absent, or a sentinel `'invalid'` when present but not a positive integer so
 * the caller can return 400.
 */
function parseLimit(searchParams: URLSearchParams): number | undefined | 'invalid' {
  const limitStr = searchParams.get('limit');
  if (limitStr === null) return undefined;
  const parsed = parseInt(limitStr, 10);
  if (isNaN(parsed) || parsed <= 0) return 'invalid';
  return parsed;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Compact token identifying a status snapshot, for long-poll change detection. */
function statusToken(s: StatusResponse): string {
  return `${s.total}:${s.embedded}:${s.pending}`;
}

async function handleApi(
  pathname: string,
  searchParams: URLSearchParams,
  res: http.ServerResponse,
  deps: ServerDeps,
  longPoll: { timeoutMs: number; intervalMs: number },
): Promise<void> {
  // GET /api/search?q=<string>&limit=<n>
  if (pathname === '/api/search') {
    const q = searchParams.get('q') ?? '';
    if (!q.trim()) {
      jsonError(res, 400, 'q parameter is required and must not be blank');
      return;
    }
    const limit = parseLimit(searchParams);
    if (limit === 'invalid') {
      jsonError(res, 400, 'limit must be a positive integer');
      return;
    }
    const results = await deps.search(q, limit);
    jsonOk(res, results);
    return;
  }

  // GET /api/recent?limit=<n> — most recently touched sessions (no query).
  if (pathname === '/api/recent') {
    const limit = parseLimit(searchParams);
    if (limit === 'invalid') {
      jsonError(res, 400, 'limit must be a positive integer');
      return;
    }
    jsonOk(res, deps.getRecent(limit));
    return;
  }

  // GET /api/session/:id
  const sessionMatch = /^\/api\/session\/(.+)$/.exec(pathname);
  if (sessionMatch) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(sessionMatch[1]!);
    } catch {
      jsonError(res, 400, 'Invalid session id: bad percent-encoding');
      return;
    }
    const session = deps.getSession(sessionId);
    jsonOk(res, session);
    return;
  }

  // GET /api/status[?since=<token>] — long-polling.
  // Without `since`, or when `since` differs from the current status, return
  // immediately. When `since` matches the current status, hold the response open
  // until the status changes or the timeout elapses, so the client polls at most
  // once per timeout window instead of every second.
  if (pathname === '/api/status') {
    const since = searchParams.get('since');
    let stats = deps.getStatus();

    if (since !== null && since === statusToken(stats)) {
      const deadline = Date.now() + longPoll.timeoutMs;
      let closed = false;
      const onClose = (): void => {
        closed = true;
      };
      res.on('close', onClose);
      try {
        while (!closed && Date.now() < deadline) {
          await delay(Math.max(1, Math.min(longPoll.intervalMs, deadline - Date.now())));
          // Client gone — stop before touching deps or the response.
          if (closed || res.writableEnded) return;
          stats = deps.getStatus();
          if (statusToken(stats) !== since) break;
        }
      } finally {
        res.off('close', onClose);
      }
      // Client went away mid-wait — nothing to send.
      if (closed || res.writableEnded) return;
    }

    jsonOk(res, stats);
    return;
  }

  // Unknown /api/... route
  jsonError(res, 404, `Unknown API endpoint: ${pathname}`);
}

function serveStatic(pathname: string, staticDir: string, res: http.ServerResponse): void {
  // Resolve the root once so comparisons are against a normalized absolute path.
  const root = path.resolve(staticDir);
  const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const fullPath = path.resolve(root, relPath);

  // Path-boundary traversal guard: path.relative() produces a string starting
  // with '..' when fullPath escapes the root, or an absolute path when the
  // resolved result is outside (e.g. a sibling dir whose name shares the root prefix).
  const relative = path.relative(root, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // Try the exact path, then fall back to index.html (SPA routing).
  const candidates = [fullPath, path.join(root, 'index.html')];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const ext = path.extname(candidate).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      const stream = fs.createReadStream(candidate);
      stream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        } else {
          res.destroy();
        }
      });
      stream.pipe(res);
      return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an HTTP server with injected deps (no real DB or embedder).
 * The server is NOT started — call `server.listen(port)` yourself, or use
 * `startServer()` which handles that.
 */
export function createServer(deps: ServerDeps, opts?: ServerOptions): http.Server {
  const staticDir = opts?.staticDir ?? DEFAULT_STATIC_DIR;
  const longPoll = {
    timeoutMs: opts?.statusLongPoll?.timeoutMs ?? STATUS_LONGPOLL_TIMEOUT_MS,
    intervalMs: opts?.statusLongPoll?.intervalMs ?? STATUS_LONGPOLL_INTERVAL_MS,
  };

  return http.createServer((req, res) => {
    // Only handle GET; reject everything else cleanly.
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      res.end('Method Not Allowed');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname, searchParams } = url;

    if (pathname.startsWith('/api/')) {
      handleApi(pathname, searchParams, res, deps, longPoll).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // The response may already be finished (e.g. client disconnected during a
        // long-poll wait) — writing again would throw. Only respond if still open.
        if (res.writableEnded || res.destroyed) return;
        if (!res.headersSent) {
          jsonError(res, 500, msg);
        } else {
          res.end();
        }
      });
    } else {
      serveStatic(pathname, staticDir, res);
    }
  });
}

/**
 * Start the server, resolving the port from opts → AGENT_SEARCH_PORT env → DEFAULT_PORT.
 * Returns the bound URL and the http.Server instance.
 */
export async function startServer(
  deps: ServerDeps,
  opts?: ServerOptions,
): Promise<{ url: string; server: http.Server }> {
  const port =
    opts?.port ??
    (process.env.AGENT_SEARCH_PORT ? parseInt(process.env.AGENT_SEARCH_PORT, 10) : undefined) ??
    DEFAULT_PORT;

  const server = createServer(deps, opts);

  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve);
    server.once('error', reject);
  });

  const addr = server.address() as { port: number };
  return { url: `http://localhost:${addr.port}`, server };
}
