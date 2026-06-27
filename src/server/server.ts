/**
 * server.ts — minimal HTTP API server for agent-search.
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
import type { Chunk } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionResponse {
  sessionId: string;
  /** First file path seen in this session's chunks (may be '' if no chunks). */
  filePath: string;
  chunks: Chunk[];
}

export interface StatusResponse {
  total: number;
  embedded: number;
  pending: number;
}

/** Injected dependencies — all pure function-shaped so tests can pass fakes. */
export interface ServerDeps {
  search: (query: string, limit?: number) => Promise<SearchResult[]>;
  getSession: (sessionId: string) => SessionResponse;
  getStatus: () => StatusResponse;
}

export interface ServerOptions {
  port?: number;
  /** Directory to serve static files from. Defaults to <root>/web/dist. */
  staticDir?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PORT = 3737;

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

async function handleApi(
  pathname: string,
  searchParams: URLSearchParams,
  res: http.ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  // GET /api/search?q=<string>&limit=<n>
  if (pathname === '/api/search') {
    const q = searchParams.get('q') ?? '';
    if (!q.trim()) {
      jsonError(res, 400, 'q parameter is required and must not be blank');
      return;
    }
    const limitStr = searchParams.get('limit');
    let limit: number | undefined;
    if (limitStr !== null) {
      const parsed = parseInt(limitStr, 10);
      if (isNaN(parsed) || parsed <= 0) {
        jsonError(res, 400, 'limit must be a positive integer');
        return;
      }
      limit = parsed;
    }
    const results = await deps.search(q, limit);
    jsonOk(res, results);
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

  // GET /api/status
  if (pathname === '/api/status') {
    const stats = deps.getStatus();
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
      handleApi(pathname, searchParams, res, deps).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Only write head if headers not sent yet.
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
