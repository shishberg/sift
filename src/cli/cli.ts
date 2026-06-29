#!/usr/bin/env node
/**
 * cli.ts — sift CLI entrypoint.
 *
 * All command logic lives in exported functions that take injected deps,
 * so they can be unit-tested without spawning processes or hitting ollama.
 * main() is the thin wiring layer: parse args, build real deps, call handlers.
 */

import { fileURLToPath } from 'node:url';
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { readTranscript } from '../render/transcript.js';
import type { Chunk } from '../types.js';
import { Store } from '../index/store.js';
import { createEmbedder } from '../embed/factory.js';
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
sift — search across Claude, Codex, and pi agent session transcripts.

USAGE
  sift <query> [--limit N] [--format text|json] [--cwd PATH | --all]
  sift show <sessionId>[:LINE | :START-END] [--lines RANGE] [--tools]
  sift index
  sift watch
  sift status
  sift serve [--port N] [--watch]
  sift --help

COMMANDS
  <query>
      Search indexed sessions. Prints ranked results — each result shows a
      header (session id:line, agent type, role, datetime, working dir) with
      the matching snippet on the line below. Use --format json for the raw
      result objects (full ISO timestamps) instead.

      By default the search is scoped to the current working directory — only
      sessions that ran there are searched. Pass --all to search every indexed
      session, or --cwd PATH to scope to a different directory.

  show <sessionId>
      Print the full transcript for a session. User and assistant messages
      are shown by default; tool calls are hidden unless you pass --tools.

      Restrict output to a range of source-log line numbers (the same id:line
      locators search prints) in any of these forms:
        sift show <id>:220              ← only line 220
        sift show <id>:210-230          ← lines 210–230
        sift show --lines 210-230 <id>  ← same, as a flag (-l for short)

      Workflow: go from a search result to its transcript:
        1. sift <query>         ← find matching chunks
        2. note the session id          ← first column of each result line
        3. sift show <sessionId>  ← read the full transcript

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
  --format F    Output format for search: text (default) or json.
  --cwd PATH    Scope the search to sessions that ran in PATH (default: the
                current directory). Accepts ~, relative, or absolute paths.
  --all         Search every indexed session, ignoring the working directory.
  -l, --lines RANGE
                Show only line RANGE of the transcript (show command): a single
                line (220) or a span (210-230). Same as the <id>:RANGE suffix.
  --tools       Include tool call chunks in transcript output (show command).
  --port N      Port for the serve command (default: ${DEFAULT_PORT}).
  --watch       Start watcher + embed worker alongside the server (serve only).
  -h, --help    Show this help.

EMBEDDING
  Embeddings are generated LOCALLY (never a cloud API). Two providers, chosen
  via AGENT_SEARCH_EMBED_PROVIDER:
    ollama    (default) nomic-embed-text, 768 dims. Needs a running ollama:
                ollama serve
    fastembed in-process ONNX (bge-base-en-v1.5, 768 dims), no service. Needs
              the optional package once: npm install fastembed
  Switching provider changes the model, so reindex from scratch after changing.
`.trim();

// ---------------------------------------------------------------------------
// Per-subcommand help (shown by `sift <command> --help`)
// ---------------------------------------------------------------------------

const SUBCOMMAND_HELP: Record<string, string> = {
  show: `
sift show — print a session transcript.

USAGE
  sift show <sessionId>[:LINE | :START-END] [--lines RANGE] [--tools]

DESCRIPTION
  Print the full transcript for a session. User and assistant messages are
  shown by default; tool calls are hidden unless you pass --tools.

  Restrict output to a range of source-log line numbers (the same id:line
  locators search prints) in any of these forms:
    sift show <id>:220              only line 220
    sift show <id>:210-230          lines 210–230
    sift show --lines 210-230 <id>  same, as a flag (-l for short)

OPTIONS
  -l, --lines RANGE   Show only line RANGE: a single line (220) or a span
                      (210-230). Same as the <id>:RANGE suffix.
  --tools             Include tool call chunks in the output.
  -h, --help          Show this help.
`.trim(),

  index: `
sift index — one-shot index of all agent logs.

USAGE
  sift index

DESCRIPTION
  Scan every agent log file, index it, and drain the embedding queue to
  completion, then exit. Shows a live progress bar. Embeddings are generated
  locally via ollama — make sure it is running (ollama serve).

OPTIONS
  -h, --help   Show this help.
`.trim(),

  watch: `
sift watch — index agent logs continuously.

USAGE
  sift watch

DESCRIPTION
  Watch the agent log directories and keep indexing new and changed files,
  draining the embedding queue as it goes. Shows a live progress bar.
  Ctrl-C to stop. Make sure ollama is running (ollama serve).

OPTIONS
  -h, --help   Show this help.
`.trim(),

  status: `
sift status — print embedding queue stats.

USAGE
  sift status

DESCRIPTION
  Print current embedding queue stats (total / embedded / pending) and a
  text progress bar, then exit.

OPTIONS
  -h, --help   Show this help.
`.trim(),

  serve: `
sift serve — start the HTTP API + web app.

USAGE
  sift serve [--port N] [--watch]

DESCRIPTION
  Start the HTTP API server and serve the web app from web/dist. Exposes
  /api/search, /api/session/:id, and /api/status.

OPTIONS
  --port N     Port to listen on (default: ${DEFAULT_PORT}, or AGENT_SEARCH_PORT).
  --watch      Also start the file watcher + embed worker so the web app
               shows live indexing progress.
  -h, --help   Show this help.
`.trim(),
};

/** Help text for a topic, falling back to the top-level help. */
export function helpText(topic?: string): string {
  return (topic && SUBCOMMAND_HELP[topic]) || HELP_TEXT;
}

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

// ---------------------------------------------------------------------------
// ANSI colour (header only; opt-in so non-TTY / piped output stays plain)
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const;

/** Distinct colour per agent so the source is scannable at a glance. */
function agentColor(agent: string): string {
  switch (agent) {
    case 'claude': return ANSI.magenta;
    case 'codex': return ANSI.green;
    case 'pi': return ANSI.blue;
    case 'opencode': return ANSI.yellow;
    default: return ANSI.cyan;
  }
}

/** Colour the role marker: user/assistant/tool. */
function roleColor(role: string): string {
  switch (role) {
    case 'user': return ANSI.yellow;
    case 'assistant': return ANSI.green;
    default: return ANSI.dim; // tool
  }
}

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

/**
 * Resolve a user-supplied --cwd value to the absolute form stored in the index.
 * Expands a leading `~`, then resolves relative paths (including `.`) against
 * `base` (the process working directory in production). Empty input → ''.
 */
export function resolveCwd(input: string, base: string, home: string): string {
  if (!input) return '';
  let p = input;
  if (p === '~') p = home;
  else if (p.startsWith('~/')) p = join(home, p.slice(2));
  return resolve(base, p);
}

/**
 * Format an ISO timestamp the way the web UI does: "28 Jun 13:25". Drops the
 * day & month when it's today (today → "13:25") and the year when it's this
 * year (this year → "28 Jun 13:25", otherwise → "5 Jan 2024 08:15"). Empty or
 * unparseable input returns ''.
 *
 * @param now  Reference "current time" — injectable for deterministic tests.
 */
export function formatTimestamp(iso: string, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (sameDay) return time;
  const dayMonth = `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })}`;
  const datePart = d.getFullYear() === now.getFullYear() ? dayMonth : `${dayMonth} ${d.getFullYear()}`;
  return `${datePart} ${time}`;
}

/**
 * Format one search result as a two-line block: a metadata header, then the
 * snippet on its own indented line below it. The snippet has all runs of
 * whitespace (including newlines) squashed to single spaces so each result
 * stays compact and readable. Long snippets are truncated with an ellipsis.
 *
 *   test-session-id:10  [claude]  [user]  src/y  28 Jun 13:25
 *     the snippet text, newlines squashed
 *
 * @param opts.color    Wrap header fields in ANSI colour (default off, so piped
 *                      / non-TTY output stays plain). The snippet body is never
 *                      coloured.
 * @param opts.showCwd  Include the working directory in the header (default on).
 *                      Off when the search is scoped to a single directory.
 */
export function formatResult(
  r: SearchResult,
  opts: { color?: boolean; showCwd?: boolean } = {},
): string {
  const color = opts.color ?? false;
  const showCwd = opts.showCwd ?? true;
  const paint = (s: string, code: string): string =>
    color ? `${code}${s}${ANSI.reset}` : s;

  // The session id IS the filename (minus extension) for our locators, so we
  // skip the redundant filename and append the line number directly to the id —
  // `id:line`, the same path:line shape every dev tool uses. `show <id>` resolves
  // the actual file from the index, so nothing is lost.
  const loc = `${r.sessionId}:${r.lineNumber}`;

  const headerParts = [
    paint(loc, ANSI.dim),
    paint(`[${r.agentType}]`, ANSI.bold + agentColor(r.agentType)),
    paint(`[${r.role}]`, roleColor(r.role)),
  ];
  // Working dir then datetime last, matching the web UI ordering. Omitted when
  // the search is already scoped to one directory (the scope note covers it).
  const cwd = showCwd ? homeRelative(r.cwd, homedir()) : '';
  if (cwd) headerParts.push(paint(cwd, ANSI.dim));
  const when = formatTimestamp(r.timestamp);
  if (when) headerParts.push(paint(when, ANSI.dim));
  const header = headerParts.join('  ');

  const squashed = r.snippet.replace(/\s+/g, ' ').trim();
  const snippet =
    squashed.length > SNIPPET_DISPLAY_MAX
      ? squashed.slice(0, SNIPPET_DISPLAY_MAX) + '…'
      : squashed;

  return `${header}\n  ${snippet}`;
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
 * @param opts.format    'json' dumps the raw results array (full timestamps);
 *                       'text' (default) prints the readable two-line blocks.
 * @param opts.color     Colour the text-mode header (default off).
 * @param opts.write     Output writer (console.log in prod, captured array in tests).
 */
export async function cmdSearch(
  query: string,
  deps: {
    searchFn: (q: string, opts?: { limit?: number }) => Promise<SearchResult[]>;
  },
  opts: {
    limit?: number;
    format?: 'text' | 'json';
    color?: boolean;
    showCwd?: boolean;
    write: (s: string) => void;
  },
): Promise<void> {
  const results = await deps.searchFn(query, { limit: opts.limit });

  if (opts.format === 'json') {
    opts.write(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    opts.write('No results found.');
    return;
  }

  // A blank line between results keeps them visually separated.
  results.forEach((r, i) => {
    if (i > 0) opts.write('');
    opts.write(formatResult(r, { color: opts.color, showCwd: opts.showCwd }));
  });
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
 * @param opts.lines             Restrict to chunks whose line number falls in
 *                               this inclusive range (default: all lines).
 * @param opts.write             Output writer.
 */
export function cmdShow(
  sessionId: string,
  deps: { getSessionChunks: (id: string) => Chunk[] },
  opts: {
    showTools?: boolean;
    lines?: { start: number; end: number };
    color?: boolean;
    write: (s: string) => void;
  },
): void {
  const { write, lines } = opts;
  const showTools = opts.showTools ?? false;
  const color = opts.color ?? false;
  const paint = (s: string, code: string): string =>
    color ? `${code}${s}${ANSI.reset}` : s;

  const allChunks = deps.getSessionChunks(sessionId);

  if (allChunks.length === 0) {
    write(`No chunks found for session: ${sessionId}`);
    return;
  }

  // Narrow to the requested line range, if any (line numbers are 1-based).
  const chunks = lines
    ? allChunks.filter((c) => c.lineNumber >= lines.start && c.lineNumber <= lines.end)
    : allChunks;

  if (lines && chunks.length === 0) {
    const span = lines.start === lines.end ? `line ${lines.start}` : `lines ${lines.start}-${lines.end}`;
    write(`No chunks found at ${span} for session: ${sessionId}`);
    return;
  }

  let lastFile = '';
  let visibleCount = 0;

  for (const chunk of chunks) {
    if (!showTools && chunk.role === 'tool') continue;

    // Print a file header whenever we encounter a new source file.
    if (chunk.filePath !== lastFile) {
      write(paint(`\n--- ${chunk.filePath} ---`, ANSI.dim));
      lastFile = chunk.filePath;
    } else if (visibleCount > 0) {
      // Blank line between messages (same colouring scheme as search results).
      write('');
    }

    const text =
      chunk.text.length > 0
        ? chunk.text
        : chunk.toolCall
          ? `${chunk.toolCall.name}(${chunk.toolCall.args})`
          : '';

    write(`${paint(`[${chunk.role}]`, roleColor(chunk.role))} ${text}`);
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
  /** Help topic (show/index/…) when command === 'help'. Undefined → top-level help. */
  helpTopic?: string;
  /**
   * Line range for `show` (1-based, inclusive). A single line is start === end.
   * `{ start: NaN, end: NaN }` signals a malformed range for main() to reject.
   */
  lines?: { start: number; end: number };
  limit?: number;
  /** Raw --format value, validated by main() ('text' | 'json'). */
  format?: string;
  /** Raw --cwd value (search only). '' for a bare flag; main() resolves/validates it. */
  cwd?: string;
  /** --all (search only): disable the default current-directory cwd filter. */
  all?: boolean;
  showTools?: boolean;
  port?: number;
  watch?: boolean;
}

/**
 * Parse a line-range string for `show`: `"220"` → a single line, `"210-230"`
 * → a span. Returns undefined for undefined input (no range requested), or
 * `{ start: NaN, end: NaN }` for anything malformed (so main() can reject it).
 */
export function parseLineRange(input: string | undefined): { start: number; end: number } | undefined {
  if (input === undefined) return undefined;
  const m = input.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return { start: NaN, end: NaN };
  const start = parseInt(m[1]!, 10);
  const end = m[2] !== undefined ? parseInt(m[2]!, 10) : start;
  if (start < 1 || end < start) return { start: NaN, end: NaN };
  return { start, end };
}

/**
 * Parse CLI argv (pass `process.argv.slice(2)` in production).
 * Pure: no side effects, easy to unit-test.
 */
export function parseCli(argv: string[]): ParsedCli {
  // No args → top-level help.
  if (argv.length === 0) return { command: 'help' };

  const [first, ...rest] = argv;
  const subcommands = new Set(['show', 'index', 'watch', 'status', 'serve']);

  // Subcommand-specific help: `sift show --help` shows show's help, not the
  // top-level help. Must run before the generic --help handling below.
  if (subcommands.has(first!) && (rest.includes('--help') || rest.includes('-h'))) {
    return { command: 'help', helpTopic: first };
  }

  // Named subcommands.
  if (first === 'show') {
    const showTools = rest.includes('--tools');

    // Find an explicit --lines / -l flag and the value after it.
    let linesIdx = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--lines' || rest[i] === '-l') {
        linesIdx = i;
        break;
      }
    }
    let flagInput: string | undefined;
    if (linesIdx !== -1) {
      const value = rest[linesIdx + 1];
      // Bare flag (no value, or another flag follows) → '' so parseLineRange
      // reports it as malformed rather than silently ignoring it.
      flagInput = value !== undefined && !value.startsWith('-') ? value : '';
    }

    // Session id: first non-flag token that isn't the --lines value.
    let sessionToken: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (linesIdx !== -1 && (i === linesIdx || i === linesIdx + 1)) continue;
      if (rest[i]!.startsWith('-')) continue;
      sessionToken = rest[i];
      break;
    }

    // Split an `id:LINE` / `id:START-END` suffix off the session token. Session
    // ids are UUID-shaped (no colons), so the last colon is the separator.
    let sessionId = sessionToken;
    let suffixInput: string | undefined;
    if (sessionToken && sessionToken.includes(':')) {
      const idx = sessionToken.lastIndexOf(':');
      sessionId = sessionToken.slice(0, idx);
      suffixInput = sessionToken.slice(idx + 1);
    }

    // An explicit --lines flag wins over the id suffix.
    const lines = parseLineRange(linesIdx !== -1 ? flagInput : suffixInput);
    return { command: 'show', sessionId, showTools, lines };
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

  // No subcommand matched: a bare --help / -h anywhere means top-level help.
  if (argv.includes('--help') || argv.includes('-h')) {
    return { command: 'help' };
  }

  // Default: everything that isn't a known flag becomes the search query.
  // Strip value-taking flags (and their values) wherever they appear; the last
  // occurrence of each wins. NaN/empty values are passed through for main() to
  // reject with a friendly message.
  const valueFlags = new Set(['--limit', '--format', '--cwd']);
  const booleanFlags = new Set(['--all']);
  const indicesToDrop = new Set<number>();
  let limit: number | undefined;
  let format: string | undefined;
  let cwd: string | undefined;
  let all = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;

    // Boolean flags: strip the token, no value to consume.
    if (booleanFlags.has(flag)) {
      indicesToDrop.add(i);
      if (flag === '--all') all = true;
      continue;
    }

    if (!valueFlags.has(flag)) continue;
    indicesToDrop.add(i);
    const valueIdx = i + 1;
    const value = argv[valueIdx];
    const hasValue =
      value !== undefined && !valueFlags.has(value) && !booleanFlags.has(value);
    if (hasValue) indicesToDrop.add(valueIdx);

    if (flag === '--limit') {
      if (!hasValue) continue; // bare --limit: leave undefined (unchanged behavior)
      const parsed = parseInt(value!, 10);
      // Accept only positive integers; signal a bad value with NaN.
      limit =
        !isNaN(parsed) && parsed > 0 && String(parsed) === value!.trim()
          ? parsed
          : NaN;
    } else if (flag === '--format') {
      // Store the raw value (or '' for a bare flag) for main() to validate.
      format = hasValue ? value! : '';
    } else {
      // --cwd: store the raw value (or '' for a bare flag); main() resolves it.
      cwd = hasValue ? value! : '';
    }
  }

  const queryTokens = argv.filter((_, i) => !indicesToDrop.has(i));
  const query = queryTokens.join(' ');
  return { command: 'search', query, limit, format, cwd, all };
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
    console.log(helpText(parsed.helpTopic));
    return;
  }

  // ---- search ----
  if (parsed.command === 'search') {
    if (!parsed.query?.trim()) {
      console.error('Usage: sift <query> [--limit N]');
      process.exit(1);
    }

    if (parsed.limit !== undefined && (isNaN(parsed.limit) || parsed.limit <= 0)) {
      console.error('--limit must be a positive integer (e.g. --limit 10)');
      process.exit(1);
    }

    if (parsed.format !== undefined && parsed.format !== 'text' && parsed.format !== 'json') {
      console.error("--format must be 'text' or 'json'");
      process.exit(1);
    }
    const format: 'text' | 'json' = parsed.format === 'json' ? 'json' : 'text';

    // Working-directory filter. Default: scope to the current directory; --all
    // disables that; --cwd PATH scopes to a different directory. cwdFilter is
    // undefined when searching everywhere.
    if (parsed.all && parsed.cwd !== undefined) {
      console.error('Use either --all or --cwd, not both.');
      process.exit(1);
    }
    let cwdFilter: string | undefined;
    if (parsed.all) {
      cwdFilter = undefined;
    } else if (parsed.cwd !== undefined) {
      if (parsed.cwd === '') {
        console.error('--cwd requires a path (e.g. --cwd ~/src/foo, --cwd ., or --all)');
        process.exit(1);
      }
      cwdFilter = resolveCwd(parsed.cwd, process.cwd(), homedir());
    } else {
      cwdFilter = process.cwd();
    }

    const store = new Store();
    const embedder = createEmbedder();

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
      // Colour only when writing to a real terminal, and honour NO_COLOR.
      const color = (process.stdout.isTTY ?? false) && !process.env.NO_COLOR;

      // In text mode, note the scope on stderr (keeps stdout/JSON clean) so the
      // default cwd filtering is discoverable.
      if (format === 'text' && cwdFilter) {
        const scope = homeRelative(cwdFilter, homedir());
        const note = `Scope: ${scope} — use --all to search every directory.`;
        console.error(color ? `${ANSI.dim}${note}${ANSI.reset}` : note);
      }

      await cmdSearch(
        parsed.query,
        { searchFn: (q, opts) => search(q, { store, embedder }, { ...opts, cwd: cwdFilter }) },
        {
          limit: parsed.limit,
          format,
          color,
          // When scoped to one directory, every result shares that cwd (and the
          // scope note above already states it) — so only show it under --all.
          showCwd: !cwdFilter,
          write: (s) => console.log(s),
        },
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
      console.error('Usage: sift show <sessionId>[:LINE|:START-END] [--lines RANGE] [--tools]');
      process.exit(1);
    }

    if (parsed.lines && (Number.isNaN(parsed.lines.start) || Number.isNaN(parsed.lines.end))) {
      console.error('--lines must be a line number or range (e.g. --lines 220 or --lines 210-230)');
      process.exit(1);
    }

    const store = new Store();
    try {
      const color = (process.stdout.isTTY ?? false) && !process.env.NO_COLOR;
      cmdShow(
        parsed.sessionId,
        { getSessionChunks: (id) => store.getSessionChunks(id) },
        { showTools: parsed.showTools, lines: parsed.lines, color, write: (s) => console.log(s) },
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
    const embedder = createEmbedder();
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
    const embedder = createEmbedder();

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
        getRecent: (limit) =>
          // Recent sessions reuse the SearchResult shape (score is unused here);
          // make cwd $HOME-relative like the search/session endpoints.
          store
            .recentSessions(limit)
            .map((r) => ({ ...r, score: 0, cwd: homeRelative(r.cwd, homedir()) })),
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

    console.log(`sift server running at ${url}`);
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
    const embedder = createEmbedder();
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
