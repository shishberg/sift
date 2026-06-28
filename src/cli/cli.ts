#!/usr/bin/env node
/**
 * cli.ts — agent-search CLI entrypoint.
 *
 * All command logic lives in exported functions that take injected deps,
 * so they can be unit-tested without spawning processes or hitting ollama.
 * main() is the thin wiring layer: parse args, build real deps, call handlers.
 */

import { fileURLToPath } from 'node:url';
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import { readTranscript } from '../render/transcript.js';
import type { Chunk } from '../types.js';
import { Store } from '../index/store.js';
import { OllamaEmbedder } from '../embed/ollama.js';
import { assertEmbedModel } from '../embed/guard.js';
import { buildRegistry } from '../adapters/registry.js';
import { EmbedWorker, backfillCwd } from '../ingest/indexer.js';
import { Watcher } from '../ingest/watcher.js';
import { search, type SearchResult } from '../search/search.js';
import { startServer, DEFAULT_PORT } from '../server/server.js';
import { OpenCodeSource, DEFAULT_OPENCODE_DB_PATH } from '../sources/opencode.js';

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const HELP_TEXT = `
agent-search — search across Claude, Codex, and pi agent session transcripts.

USAGE
  agent-search <query> [--limit N]
  agent-search show <sessionId> [--tools]
  agent-search index
  agent-search watch
  agent-search status
  agent-search serve [--port N] [--watch]
  agent-search --help

COMMANDS
  <query>
      Search indexed sessions. Prints ranked results — each line shows:
        session id, agent type, file:line, role, and a text snippet.

  show <sessionId>
      Print the full transcript for a session. User and assistant messages
      are shown by default; tool calls are hidden unless you pass --tools.

      Workflow: go from a search result to its transcript:
        1. agent-search <query>         ← find matching chunks
        2. note the session id          ← first column of each result line
        3. agent-search show <sessionId>  ← read the full transcript

  index
      One-shot scan: index all agent log files and drain the embedding queue
      to completion, then exit. Shows a live progress bar.

  watch
      Watch for new/changed agent log files and keep indexing them.
      Shows a live progress bar. Ctrl-C to stop.

  status
      Print current embedding queue stats (total / embedded / pending) and
      a text progress bar, then exit.

  serve [--port N] [--watch]
      Start the HTTP API server (default port: ${DEFAULT_PORT}, override via
      AGENT_SEARCH_PORT or --port). Serves the web app from web/dist and
      exposes /api/search, /api/session/:id, and /api/status.
      Pass --watch to also start the file watcher + embed worker so the web
      app shows live indexing progress.

OPTIONS
  --limit N     Max search results to return (default: 20).
  --tools       Include tool call chunks in transcript output (show command).
  --port N      Port for the serve command (default: ${DEFAULT_PORT}).
  --watch       Start watcher + embed worker alongside the server (serve only).
  -h, --help    Show this help.

EMBEDDING
  Embeddings are generated locally via ollama (nomic-embed-text, 768 dims).
  Ensure ollama is running before indexing or searching:
    ollama serve
`.trim();

// ---------------------------------------------------------------------------
// Progress bar (pure — safe to unit-test)
// ---------------------------------------------------------------------------

/**
 * Render a text progress bar for embedding queue stats.
 *
 * Output: [████████────────────] 40% (40/100 embedded, 60 pending)
 *
 * @param stats  Queue stats from store.queueStats()
 * @param width  Number of bar characters (default 20)
 */
export function renderProgressBar(
  stats: { total: number; embedded: number; pending: number },
  width = 20,
): string {
  const { total, embedded, pending } = stats;

  if (total === 0) {
    return `[${'─'.repeat(width)}]   0% (0/0 embedded, 0 pending)`;
  }

  const ratio = embedded / total;
  const pct = Math.floor(ratio * 100);
  const filled = Math.floor(ratio * width);
  const bar = '█'.repeat(filled) + '─'.repeat(width - filled);

  return `[${bar}] ${pct.toString().padStart(3)}% (${embedded}/${total} embedded, ${pending} pending)`;
}

// ---------------------------------------------------------------------------
// Format a single search result (pure — safe to unit-test)
// ---------------------------------------------------------------------------

/** Max snippet chars to display. Beyond this we truncate with …  */
const SNIPPET_DISPLAY_MAX = 120;

/**
 * Format one search result as a single readable line.
 * Always includes: session id, agent type, file:line, role, snippet.
 */
/**
 * Render an absolute path relative to the home directory: `/Users/x/src/y` →
 * `src/y`, home itself → `~`, paths outside home returned unchanged. Empty in,
 * empty out.
 */
export function homeRelative(absPath: string, home: string): string {
  if (!absPath) return '';
  if (absPath === home) return '~';
  if (absPath.startsWith(home + '/')) return absPath.slice(home.length + 1);
  return absPath;
}

export function formatResult(r: SearchResult): string {
  const file = basename(r.filePath);
  const loc = `${file}:${r.lineNumber}`;
  const snippet =
    r.snippet.length > SNIPPET_DISPLAY_MAX
      ? r.snippet.slice(0, SNIPPET_DISPLAY_MAX) + '…'
      : r.snippet;
  return `${r.sessionId}  [${r.agentType}] ${loc}  [${r.role}]  ${snippet}`;
}

// ---------------------------------------------------------------------------
// Command: search
// ---------------------------------------------------------------------------

/**
 * Run a search query and print results.
 *
 * @param query     Plain search string.
 * @param deps.searchFn  Bound search function (store + embedder pre-applied).
 * @param opts.limit     Max results (forwarded to searchFn).
 * @param opts.write     Output writer (console.log in prod, captured array in tests).
 */
export async function cmdSearch(
  query: string,
  deps: {
    searchFn: (q: string, opts?: { limit?: number }) => Promise<SearchResult[]>;
  },
  opts: { limit?: number; write: (s: string) => void },
): Promise<void> {
  const results = await deps.searchFn(query, { limit: opts.limit });

  if (results.length === 0) {
    opts.write('No results found.');
    return;
  }

  for (const r of results) {
    opts.write(formatResult(r));
  }
}

// ---------------------------------------------------------------------------
// Command: show
// ---------------------------------------------------------------------------

/**
 * Print a session transcript.
 *
 * @param sessionId  Session id from a search result.
 * @param deps.getSessionChunks  Returns chunks for a session id.
 * @param opts.showTools         Include tool chunks (default: false).
 * @param opts.write             Output writer.
 */
export function cmdShow(
  sessionId: string,
  deps: { getSessionChunks: (id: string) => Chunk[] },
  opts: { showTools?: boolean; write: (s: string) => void },
): void {
  const { write } = opts;
  const showTools = opts.showTools ?? false;

  const chunks = deps.getSessionChunks(sessionId);

  if (chunks.length === 0) {
    write(`No chunks found for session: ${sessionId}`);
    return;
  }

  let lastFile = '';
  let visibleCount = 0;

  for (const chunk of chunks) {
    if (!showTools && chunk.role === 'tool') continue;

    // Print a file header whenever we encounter a new source file.
    if (chunk.filePath !== lastFile) {
      write(`\n--- ${chunk.filePath} ---`);
      lastFile = chunk.filePath;
    }

    const text =
      chunk.text.length > 0
        ? chunk.text
        : chunk.toolCall
          ? `${chunk.toolCall.name}(${chunk.toolCall.args})`
          : '';

    write(`[${chunk.role}] ${text}`);
    visibleCount++;
  }

  if (visibleCount === 0) {
    write(
      `No visible chunks for session: ${sessionId} (session has tool chunks only — run with --tools to include them)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Command: status
// ---------------------------------------------------------------------------

/**
 * Print queue stats + a progress bar, then exit.
 *
 * @param deps.queueStats  Returns { total, embedded, pending }.
 * @param opts.write       Output writer.
 */
export function cmdStatus(
  deps: { queueStats: () => { total: number; embedded: number; pending: number } },
  opts: { write: (s: string) => void },
): void {
  const stats = deps.queueStats();
  opts.write(renderProgressBar(stats));
  opts.write(
    `total: ${stats.total}  embedded: ${stats.embedded}  pending: ${stats.pending}`,
  );
}

// ---------------------------------------------------------------------------
// Command: index (one-shot, exported for unit tests)
// ---------------------------------------------------------------------------

export interface CmdIndexDeps {
  /** Returns current embedding queue stats. */
  queueStats: () => { total: number; embedded: number; pending: number };
  /** Start the embed worker drain pass. */
  kickWorker: () => void;
  /** Whether the embed worker drain pass is currently running. */
  isWorkerRunning: () => boolean;
  /** The most recent embed error, if the worker stopped due to a failure. */
  workerLastError: () => Error | undefined;
  /** Resolves when the worker becomes idle. */
  awaitWorkerIdle: () => Promise<void>;
  /** Start the file watcher. */
  startWatcher: () => void;
  /** Resolves when the initial backfill scan has finished enqueueing rows. */
  awaitBackfillEnqueued: () => Promise<void>;
  /** Stop the file watcher. */
  stopWatcher: () => Promise<void>;
  /** Pull new opencode sessions. */
  importOpencode: (write: (s: string) => void) => Promise<void>;
  /**
   * Assert that the embed model stored in the index matches the current embedder.
   * Throws an Error with a human-readable message on mismatch.
   */
  assertEmbedModel: () => void;
}

export interface CmdIndexOpts {
  isTTY: boolean;
  write: (s: string) => void;
  writeRaw: (s: string) => void;
  intervalMs?: number;
}

export interface CmdIndexResult {
  ok: boolean;
  /** Human-readable error message. Defined only when ok === false. */
  error?: string;
}

/**
 * One-shot index command: scan all JSONL + opencode files, drain the embed queue
 * to completion (or report a clear error if the embedder is unreachable), then exit.
 *
 * Designed for dependency injection so it can be unit-tested without real ollama
 * or real file I/O.
 */
export async function cmdIndex(deps: CmdIndexDeps, opts: CmdIndexOpts): Promise<CmdIndexResult> {
  const {
    queueStats,
    kickWorker,
    isWorkerRunning,
    workerLastError,
    awaitWorkerIdle,
    startWatcher,
    awaitBackfillEnqueued,
    stopWatcher,
    importOpencode,
    assertEmbedModel: assertModel,
  } = deps;
  const { isTTY, write, writeRaw, intervalMs = 500 } = opts;

  // Assert embed model BEFORE starting the worker — gives a clear error
  // if the index was built with a different model.
  try {
    assertModel();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }

  await importOpencode(write);
  write('Scanning agent log directories…');
  startWatcher();
  await awaitBackfillEnqueued();
  write('Backfill scan complete. Draining embedding queue…');
  kickWorker();

  // Progress loop with stuck-worker detection.
  // Exits when pending reaches 0 (done) or the worker has stopped with pending > 0 (error).
  let lastBar = '';
  while (true) {
    const stats = queueStats();
    const bar = renderProgressBar(stats);

    if (isTTY) {
      writeRaw(`\r${bar}`);
    } else if (bar !== lastBar) {
      write(bar);
      lastBar = bar;
    }

    if (stats.pending === 0) {
      if (isTTY) writeRaw('\n');
      break;
    }

    // Detect: worker stopped (not running, no rerun scheduled) while work remains.
    // This means the embedder is persistently failing — abort with a clear message.
    if (!isWorkerRunning() && stats.pending > 0) {
      if (isTTY) writeRaw('\n');
      const err = workerLastError();
      const detail = err?.message ?? 'embed worker stopped unexpectedly';
      // Stop the watcher before returning so we don't leak handles.
      await stopWatcher();
      return {
        ok: false,
        error:
          `Embedding failed: ${detail}\n` +
          `Is ollama running? Start it with: ollama serve`,
      };
    }

    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }

  await awaitWorkerIdle();
  await stopWatcher();

  const finalStats = queueStats();
  write(`Done. ${finalStats.embedded}/${finalStats.total} chunks embedded.`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ParsedCli {
  command: 'search' | 'show' | 'index' | 'watch' | 'status' | 'serve' | 'help';
  query?: string;
  sessionId?: string;
  limit?: number;
  showTools?: boolean;
  port?: number;
  watch?: boolean;
}

/**
 * Parse CLI argv (pass `process.argv.slice(2)` in production).
 * Pure: no side effects, easy to unit-test.
 */
export function parseCli(argv: string[]): ParsedCli {
  // No args or explicit help flags → show help.
  if (
    argv.length === 0 ||
    argv.includes('--help') ||
    argv.includes('-h')
  ) {
    return { command: 'help' };
  }

  const [first, ...rest] = argv;

  // Named subcommands.
  if (first === 'show') {
    const sessionId = rest.find((a) => !a.startsWith('-'));
    const showTools = rest.includes('--tools');
    return { command: 'show', sessionId, showTools };
  }
  if (first === 'index') return { command: 'index' };
  if (first === 'watch') return { command: 'watch' };
  if (first === 'status') return { command: 'status' };
  if (first === 'serve') {
    const portIdx = rest.indexOf('--port');
    let port: number | undefined;
    if (portIdx !== -1) {
      if (portIdx + 1 < rest.length && !rest[portIdx + 1]!.startsWith('-')) {
        const raw = rest[portIdx + 1]!;
        const parsed = parseInt(raw, 10);
        port = !isNaN(parsed) && parsed > 0 && String(parsed) === raw.trim() ? parsed : NaN;
      } else {
        // --port with no following value → signal a bad arg to main()
        port = NaN;
      }
    }
    const watch = rest.includes('--watch');
    return { command: 'serve', port, watch };
  }

  // Default: everything that isn't a known flag becomes the search query.
  // Strip ALL --limit <N> occurrences; use the last valid one found.
  const limitOccurrences: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') limitOccurrences.push(i);
  }

  let limit: number | undefined;
  const indicesToDrop = new Set<number>();

  for (const idx of limitOccurrences) {
    indicesToDrop.add(idx);
    const valueIdx = idx + 1;
    if (valueIdx < argv.length && argv[valueIdx] !== '--limit') {
      indicesToDrop.add(valueIdx);
      const raw = argv[valueIdx]!;
      const parsed = parseInt(raw, 10);
      // Accept only positive integers; ignore NaN / zero / negative.
      if (!isNaN(parsed) && parsed > 0 && String(parsed) === raw.trim()) {
        limit = parsed;
      } else {
        limit = NaN; // signal a bad value to main()
      }
    }
  }

  const queryTokens = argv.filter((_, i) => !indicesToDrop.has(i));
  const query = queryTokens.join(' ');
  return { command: 'search', query, limit };
}

// ---------------------------------------------------------------------------
// opencode one-shot import (used by index + watch)
// ---------------------------------------------------------------------------

/**
 * Pull new opencode sessions into the store. Silently skips when opencode is
 * not installed (no DB file). Logs counts when chunks are found, warns on error.
 *
 * Watch integration: opencode is not a JSONL file-watcher target, so this is a
 * one-shot pull at the start of both `index` and `watch` runs. For live watch
 * coverage you would poll the DB file's mtime; that is left as a future
 * enhancement. The cursor persists across runs, so re-indexing picks up only
 * new sessions.
 */
async function importOpencode(store: Store, write: (s: string) => void): Promise<void> {
  if (!existsSync(DEFAULT_OPENCODE_DB_PATH)) return;
  try {
    const source = new OpenCodeSource(DEFAULT_OPENCODE_DB_PATH);
    const count = source.index(store);
    source.close();
    if (count > 0) write(`Indexed ${count} chunks from opencode.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    write(`[warn] opencode import failed (skipped): ${msg}`);
  }
}

/**
 * One-time backfill of the cwd column for data indexed before it existed.
 * Cheap and self-limiting: only files with a null cwd are touched, so after the
 * first run subsequent startups do almost nothing.
 */
async function runCwdBackfill(
  store: Store,
  registry: ReturnType<typeof buildRegistry>,
  write: (s: string) => void,
): Promise<void> {
  let opencodeSource: OpenCodeSource | undefined;
  if (existsSync(DEFAULT_OPENCODE_DB_PATH)) {
    try {
      opencodeSource = new OpenCodeSource(DEFAULT_OPENCODE_DB_PATH);
    } catch {
      opencodeSource = undefined;
    }
  }
  try {
    const filled = await backfillCwd(store, registry, opencodeSource);
    if (filled > 0) write(`Backfilled working directory for ${filled} sessions.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    write(`[warn] cwd backfill failed (skipped): ${msg}`);
  } finally {
    opencodeSource?.close();
  }
}

// ---------------------------------------------------------------------------
// Progress display for index / watch (used only by main())
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseCli(argv);

  if (parsed.command === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  // ---- search ----
  if (parsed.command === 'search') {
    if (!parsed.query?.trim()) {
      console.error('Usage: agent-search <query> [--limit N]');
      process.exit(1);
    }

    if (parsed.limit !== undefined && (isNaN(parsed.limit) || parsed.limit <= 0)) {
      console.error('--limit must be a positive integer (e.g. --limit 10)');
      process.exit(1);
    }

    const store = new Store();
    const embedder = new OllamaEmbedder();

    // Guard: if the index was built with a different model, the query embeddings
    // would be in a different space than the stored vectors — results would be garbage.
    try {
      assertEmbedModel(store, embedder, store.dbPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(msg);
      store.close();
      process.exit(1);
    }

    try {
      await cmdSearch(
        parsed.query,
        { searchFn: (q, opts) => search(q, { store, embedder }, opts) },
        { limit: parsed.limit, write: (s) => console.log(s) },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Search failed: ${msg}`);
      if (msg.includes('cannot reach ollama')) {
        console.error('Make sure ollama is running: ollama serve');
      }
      process.exit(1);
    } finally {
      store.close();
    }
    return;
  }

  // ---- show ----
  if (parsed.command === 'show') {
    if (!parsed.sessionId) {
      console.error('Usage: agent-search show <sessionId> [--tools]');
      process.exit(1);
    }

    const store = new Store();
    try {
      cmdShow(
        parsed.sessionId,
        { getSessionChunks: (id) => store.getSessionChunks(id) },
        { showTools: parsed.showTools, write: (s) => console.log(s) },
      );
    } finally {
      store.close();
    }
    return;
  }

  // ---- status ----
  if (parsed.command === 'status') {
    const store = new Store();
    try {
      cmdStatus(
        { queueStats: () => store.queueStats() },
        { write: (s) => console.log(s) },
      );
    } finally {
      store.close();
    }
    return;
  }

  // ---- index ----
  if (parsed.command === 'index') {
    const store = new Store();
    const embedder = new OllamaEmbedder();
    const registry = buildRegistry();
    const embedWorker = new EmbedWorker(store, embedder, { backoffMs: 1000 });
    const watcher = new Watcher(store, registry, embedWorker, {
      awaitWriteFinish: false,
    });

    await runCwdBackfill(store, registry, (s) => console.log(s));

    const isTTY = process.stdout.isTTY ?? false;

    const result = await cmdIndex(
      {
        queueStats: () => store.queueStats(),
        kickWorker: () => embedWorker.kick(),
        isWorkerRunning: () => embedWorker.isRunning,
        workerLastError: () => embedWorker.lastError,
        awaitWorkerIdle: () => embedWorker.awaitIdle(),
        startWatcher: () => watcher.start(),
        awaitBackfillEnqueued: () => watcher.awaitBackfillEnqueued(),
        stopWatcher: () => watcher.stop(),
        importOpencode: (write) => importOpencode(store, write),
        assertEmbedModel: () => assertEmbedModel(store, embedder, store.dbPath),
      },
      {
        isTTY,
        write: (s) => console.log(s),
        writeRaw: (s) => process.stdout.write(s),
      },
    );

    store.close();

    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    return;
  }

  // ---- serve ----
  if (parsed.command === 'serve') {
    if (parsed.port !== undefined && (isNaN(parsed.port) || parsed.port <= 0)) {
      console.error('--port must be a positive integer (e.g. --port 3737)');
      process.exit(1);
    }

    const store = new Store();
    const embedder = new OllamaEmbedder();

    // Guard: the embed model must match the index (needed for both search queries
    // and, with --watch, for new embeddings).
    try {
      assertEmbedModel(store, embedder, store.dbPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(msg);
      store.close();
      process.exit(1);
    }

    // Fill cwd for anything indexed before the column existed, so the web UI
    // can show the working directory on existing sessions.
    await runCwdBackfill(store, buildRegistry(), (s) => console.log(s));

    let watcher: Watcher | undefined;
    let embedWorker: EmbedWorker | undefined;

    if (parsed.watch) {
      const registry = buildRegistry();
      embedWorker = new EmbedWorker(store, embedder, { backoffMs: 1000 });
      watcher = new Watcher(store, registry, embedWorker);
      console.log('Starting file watcher + embed worker…');
      watcher.start();
      embedWorker.kick();
    }

    const { url, server } = await startServer(
      {
        search: async (q, limit) => {
          const results = await search(q, { store, embedder }, { limit });
          // Make cwd $HOME-relative for display, matching the session endpoint.
          return results.map((r) => ({ ...r, cwd: homeRelative(r.cwd, homedir()) }));
        },
        getSession: (sessionId) => {
          const items = readTranscript(sessionId, {
            getSessionFiles: (id) => store.getSessionFiles(id),
            readFile: (p) => readFileSync(p, 'utf8'),
            openTranscript: (id) => {
              const source = new OpenCodeSource();
              try {
                return source.readTranscript(id);
              } finally {
                source.close();
              }
            },
          });
          const files = store.getSessionFiles(sessionId);
          const realFile = files.find((f) => f.agentType !== 'opencode')?.filePath ?? files[0]?.filePath ?? '';
          return {
            sessionId,
            agentType: files[0]?.agentType ?? null,
            filePath: realFile,
            cwd: homeRelative(store.getSessionCwd(sessionId) ?? '', homedir()),
            items,
          };
        },
        getStatus: () => store.queueStats(),
      },
      { port: parsed.port },
    );

    console.log(`agent-search server running at ${url}`);
    if (parsed.watch) {
      console.log('Watching agent log directories. Ctrl-C to stop.');
    }

    // Graceful shutdown on SIGINT: close server, watcher, store.
    process.once('SIGINT', () => {
      console.log('\nStopping…');
      void (async () => {
        if (watcher) await watcher.stop();
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
        store.close();
        process.exit(0);
      })();
    });

    // Block indefinitely (the http.Server keeps the event loop alive).
    return;
  }

  // ---- watch ----
  if (parsed.command === 'watch') {
    const store = new Store();
    const embedder = new OllamaEmbedder();
    const registry = buildRegistry();
    const embedWorker = new EmbedWorker(store, embedder, { backoffMs: 1000 });
    const watcher = new Watcher(store, registry, embedWorker);

    const isTTY = process.stdout.isTTY ?? false;
    let stopped = false;

    process.on('SIGINT', () => {
      stopped = true;
      if (isTTY) process.stdout.write('\n');
      console.log('Stopping watcher…');
      void watcher.stop().then(() => {
        store.close();
        process.exit(0);
      });
    });

    // Guard embed model before starting. watch retries on each kick, so a model
    // mismatch here is a fatal startup error.
    try {
      assertEmbedModel(store, embedder, store.dbPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(msg);
      store.close();
      process.exit(1);
    }

    // One-shot opencode pull at startup. Future: poll DB file mtime for live updates.
    await importOpencode(store, (s) => console.log(s));
    await runCwdBackfill(store, registry, (s) => console.log(s));

    console.log('Watching agent log directories. Ctrl-C to stop.');
    watcher.start();
    embedWorker.kick();

    let lastBar = '';
    while (!stopped) {
      const stats = store.queueStats();
      const bar = renderProgressBar(stats);

      if (isTTY) {
        process.stdout.write(`\r${bar}`);
      } else if (bar !== lastBar) {
        console.log(bar);
        lastBar = bar;
      }

      await new Promise<void>((r) => setTimeout(r, 500));
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point guard — only run main() when executed directly, not imported.
// Uses realpathSync so the comparison works through npm bin symlinks.
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const isMain = (() => {
  try {
    return realpathSync(__filename) === realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
