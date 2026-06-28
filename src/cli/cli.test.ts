import { describe, it, expect } from 'vitest';
import {
  formatResult,
  formatTimestamp,
  renderProgressBar,
  cmdSearch,
  cmdShow,
  cmdStatus,
  cmdIndex,
  HELP_TEXT,
  parseCli,
  homeRelative,
  resolveCwd,
} from './cli.js';
import type { SearchResult } from '../search/search.js';
import type { Chunk } from '../types.js';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    sessionId: 'test-session-id',
    agentType: 'claude',
    filePath: '/home/user/.claude/projects/proj/test-session-id.jsonl',
    lineNumber: 10,
    role: 'user',
    snippet: 'test snippet text',
    timestamp: '2026-01-01T00:00:00Z',
    score: 0.9,
    cwd: '',
    ...overrides,
  };
}

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    agentType: 'claude',
    sessionId: 'test-session-id',
    filePath: '/logs/test.jsonl',
    lineNumber: 1,
    role: 'user',
    text: 'hello world',
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderProgressBar
// ---------------------------------------------------------------------------

describe('renderProgressBar', () => {
  it('shows 0% when nothing is embedded', () => {
    const bar = renderProgressBar({ total: 100, embedded: 0, pending: 100 });
    expect(bar).toContain('0%');
    expect(bar).toContain('0/100 embedded');
    expect(bar).toContain('100 pending');
  });

  it('shows 100% when all chunks are embedded', () => {
    const bar = renderProgressBar({ total: 50, embedded: 50, pending: 0 });
    expect(bar).toContain('100%');
    expect(bar).toContain('50/50 embedded');
    expect(bar).toContain('0 pending');
  });

  it('shows 50% at half completion', () => {
    const bar = renderProgressBar({ total: 200, embedded: 100, pending: 100 });
    expect(bar).toContain('50%');
    expect(bar).toContain('100/200 embedded');
  });

  it('handles zero total gracefully without dividing by zero', () => {
    const bar = renderProgressBar({ total: 0, embedded: 0, pending: 0 });
    expect(bar).toContain('0%');
    expect(bar).toContain('0/0 embedded');
    expect(bar).toContain('0 pending');
  });

  it('includes a visual bar bracket', () => {
    const bar = renderProgressBar({ total: 10, embedded: 5, pending: 5 });
    expect(bar).toMatch(/\[.+\]/);
  });
});

// ---------------------------------------------------------------------------
// formatResult
// ---------------------------------------------------------------------------

describe('formatResult', () => {
  it('includes the session id', () => {
    const line = formatResult(makeSearchResult({ sessionId: 'sess-abc123' }));
    expect(line).toContain('sess-abc123');
  });

  it('appends the line number to the session id, dropping the redundant filename', () => {
    const line = formatResult(
      makeSearchResult({
        sessionId: 'sess-abc',
        filePath: '/logs/session.jsonl',
        lineNumber: 42,
      }),
    );
    expect(line).toContain('sess-abc:42');
    expect(line).not.toContain('session.jsonl');
  });

  it('includes the role', () => {
    expect(formatResult(makeSearchResult({ role: 'assistant' }))).toContain('assistant');
    expect(formatResult(makeSearchResult({ role: 'user' }))).toContain('user');
  });

  it('includes the snippet text', () => {
    const line = formatResult(makeSearchResult({ snippet: 'a unique snippet value' }));
    expect(line).toContain('a unique snippet value');
  });

  it('includes the agent type', () => {
    const line = formatResult(makeSearchResult({ agentType: 'codex' }));
    expect(line).toContain('codex');
  });

  it('truncates very long snippets so lines stay reasonable', () => {
    const longSnippet = 'x'.repeat(300);
    const line = formatResult(makeSearchResult({ snippet: longSnippet }));
    // Should not be 300 chars of x — some truncation should have happened
    expect(line.length).toBeLessThan(300 + 100); // allow header overhead but not full 300
  });

  it('puts the snippet on its own line below the header', () => {
    const line = formatResult(makeSearchResult({ snippet: 'the body' }));
    const [header, ...body] = line.split('\n');
    expect(header).toContain('test-session-id'); // metadata on the header line
    expect(header).not.toContain('the body'); // snippet is NOT on the header line
    expect(body.join('\n')).toContain('the body'); // snippet is below
  });

  it('squashes newlines and runs of whitespace in the snippet', () => {
    const line = formatResult(makeSearchResult({ snippet: 'a\n\nb\t  c' }));
    expect(line).toContain('a b c');
    // No raw newline should survive inside the snippet portion.
    const snippetPortion = line.split('\n').slice(1).join('\n');
    expect(snippetPortion).not.toMatch(/a\s*\n\s*b/);
  });

  it('emits no ANSI escape codes by default', () => {
    const line = formatResult(makeSearchResult());
    expect(line).not.toContain('\x1b[');
  });

  it('colours the header when color is enabled, leaving the text readable', () => {
    const line = formatResult(makeSearchResult({ sessionId: 'sess-color' }), {
      color: true,
    });
    expect(line).toContain('\x1b['); // some ANSI colour present
    expect(line).toContain('sess-color'); // raw text still recoverable
    // The snippet body itself stays uncoloured (no escape on the body line).
    const body = line.split('\n').slice(1).join('\n');
    expect(body).not.toContain('\x1b[');
  });

  it('shows the working directory home-relative in the header', () => {
    const line = formatResult(
      makeSearchResult({ cwd: `${homedir()}/src/proj` }),
    );
    expect(line).toContain('src/proj');
    expect(line).not.toContain(homedir());
  });

  it('omits the working directory when showCwd is false', () => {
    const line = formatResult(
      makeSearchResult({ cwd: `${homedir()}/src/proj` }),
      { showCwd: false },
    );
    expect(line).not.toContain('src/proj');
  });

  it('includes a human-readable datetime in the header', () => {
    const line = formatResult(
      makeSearchResult({ timestamp: '2020-03-15T10:30:00Z' }),
    );
    // Old enough that the year is always shown regardless of "now".
    expect(line).toContain('2020');
    expect(line).toContain('Mar');
  });
});

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------

describe('formatTimestamp', () => {
  it('shows only the time when the timestamp is today', () => {
    const now = new Date(2026, 5, 28, 14, 0);
    const d = new Date(2026, 5, 28, 13, 25);
    expect(formatTimestamp(d.toISOString(), now)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('drops the year when the timestamp is this year', () => {
    const now = new Date(2026, 7, 1, 9, 0);
    const d = new Date(2026, 5, 28, 13, 25);
    const out = formatTimestamp(d.toISOString(), now);
    expect(out).toContain('28 Jun');
    expect(out).not.toContain('2026');
  });

  it('includes the year for a timestamp in a different year', () => {
    const now = new Date(2026, 5, 28, 9, 0);
    const d = new Date(2024, 0, 5, 8, 15);
    const out = formatTimestamp(d.toISOString(), now);
    expect(out).toContain('5 Jan');
    expect(out).toContain('2024');
  });

  it('returns empty string for an empty or invalid timestamp', () => {
    expect(formatTimestamp('')).toBe('');
    expect(formatTimestamp('not-a-date')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// cmdSearch
// ---------------------------------------------------------------------------

describe('cmdSearch', () => {
  it('prints each result with the session id and line number locator', async () => {
    const lines: string[] = [];
    const results: SearchResult[] = [
      makeSearchResult({
        sessionId: 'sess-xyz',
        filePath: '/logs/a.jsonl',
        lineNumber: 7,
      }),
    ];
    await cmdSearch(
      'test query',
      { searchFn: async () => results },
      { write: (s) => lines.push(s) },
    );

    const output = lines.join('\n');
    expect(output).toContain('sess-xyz:7');
  });

  it('omits the working directory in text mode when showCwd is false', async () => {
    const lines: string[] = [];
    const results: SearchResult[] = [
      makeSearchResult({ sessionId: 'sess-a', cwd: `${homedir()}/src/proj` }),
    ];
    await cmdSearch(
      'query',
      { searchFn: async () => results },
      { showCwd: false, write: (s) => lines.push(s) },
    );
    expect(lines.join('\n')).not.toContain('src/proj');
  });

  it('passes the limit option through to the search function', async () => {
    let capturedOpts: { limit?: number } | undefined;

    await cmdSearch(
      'query',
      {
        searchFn: async (_q, opts) => {
          capturedOpts = opts;
          return [];
        },
      },
      { limit: 5, write: () => {} },
    );

    expect(capturedOpts?.limit).toBe(5);
  });

  it('prints a no-results message when search returns nothing', async () => {
    const lines: string[] = [];
    await cmdSearch(
      'query with no hits',
      { searchFn: async () => [] },
      { write: (s) => lines.push(s) },
    );

    expect(lines.some((l) => /no results/i.test(l))).toBe(true);
  });

  it('prints multiple results in rank order', async () => {
    const lines: string[] = [];
    const results: SearchResult[] = [
      makeSearchResult({ sessionId: 'first', snippet: 'first result' }),
      makeSearchResult({ sessionId: 'second', snippet: 'second result' }),
    ];
    await cmdSearch(
      'query',
      { searchFn: async () => results },
      { write: (s) => lines.push(s) },
    );

    const output = lines.join('\n');
    const firstIdx = output.indexOf('first');
    const secondIdx = output.indexOf('second');
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it('separates results with a blank line in text mode', async () => {
    const lines: string[] = [];
    const results: SearchResult[] = [
      makeSearchResult({ sessionId: 'first' }),
      makeSearchResult({ sessionId: 'second' }),
    ];
    await cmdSearch(
      'query',
      { searchFn: async () => results },
      { write: (s) => lines.push(s) },
    );
    expect(lines.join('\n')).toContain('\n\n');
  });

  it('emits a JSON array with full timestamps in json mode', async () => {
    const lines: string[] = [];
    const results: SearchResult[] = [
      makeSearchResult({ sessionId: 'sess-json', timestamp: '2026-01-02T03:04:05Z' }),
    ];
    await cmdSearch(
      'query',
      { searchFn: async () => results },
      { format: 'json', write: (s) => lines.push(s) },
    );

    const parsed = JSON.parse(lines.join('\n'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sessionId).toBe('sess-json');
    expect(parsed[0].timestamp).toBe('2026-01-02T03:04:05Z');
  });

  it('emits an empty JSON array (not a message) for no results in json mode', async () => {
    const lines: string[] = [];
    await cmdSearch(
      'query',
      { searchFn: async () => [] },
      { format: 'json', write: (s) => lines.push(s) },
    );
    expect(JSON.parse(lines.join('\n'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cmdShow
// ---------------------------------------------------------------------------

describe('cmdShow', () => {
  it('prints user messages', () => {
    const lines: string[] = [];
    cmdShow(
      'sess1',
      {
        getSessionChunks: () => [
          makeChunk({ role: 'user', text: 'hello from user', filePath: '/f.jsonl' }),
        ],
      },
      { write: (s) => lines.push(s) },
    );

    expect(lines.some((l) => l.includes('hello from user'))).toBe(true);
  });

  it('prints assistant messages', () => {
    const lines: string[] = [];
    cmdShow(
      'sess1',
      {
        getSessionChunks: () => [
          makeChunk({ role: 'assistant', text: 'hi from assistant', filePath: '/f.jsonl' }),
        ],
      },
      { write: (s) => lines.push(s) },
    );

    expect(lines.some((l) => l.includes('hi from assistant'))).toBe(true);
  });

  it('hides tool chunks by default', () => {
    const lines: string[] = [];
    cmdShow(
      'sess1',
      {
        getSessionChunks: () => [
          makeChunk({ role: 'tool', text: 'secret tool output', filePath: '/f.jsonl' }),
        ],
      },
      { write: (s) => lines.push(s) },
    );

    expect(lines.some((l) => l.includes('secret tool output'))).toBe(false);
  });

  it('prints a helpful message when session has only tool chunks and --tools is not set', () => {
    const lines: string[] = [];
    cmdShow(
      'tool-only-session',
      {
        getSessionChunks: () => [
          makeChunk({ role: 'tool', text: 'tool output', filePath: '/f.jsonl' }),
          makeChunk({ role: 'tool', text: 'more tool output', filePath: '/f.jsonl' }),
        ],
      },
      { write: (s) => lines.push(s) },
    );

    // Should not be silent — user should know why nothing printed
    const output = lines.join('\n');
    expect(output).toMatch(/no visible chunks|tool chunks only/i);
  });

  it('shows tool chunks when --tools is passed', () => {
    const lines: string[] = [];
    cmdShow(
      'sess1',
      {
        getSessionChunks: () => [
          makeChunk({ role: 'tool', text: 'secret tool output', filePath: '/f.jsonl' }),
        ],
      },
      { showTools: true, write: (s) => lines.push(s) },
    );

    expect(lines.some((l) => l.includes('secret tool output'))).toBe(true);
  });

  it('prints which file the chunks come from', () => {
    const lines: string[] = [];
    cmdShow(
      'sess1',
      {
        getSessionChunks: () => [
          makeChunk({
            role: 'user',
            text: 'hello',
            filePath: '/logs/my-session.jsonl',
          }),
        ],
      },
      { write: (s) => lines.push(s) },
    );

    expect(lines.some((l) => l.includes('my-session.jsonl'))).toBe(true);
  });

  it('prints a not-found message when session has no chunks', () => {
    const lines: string[] = [];
    cmdShow(
      'no-such-session',
      { getSessionChunks: () => [] },
      { write: (s) => lines.push(s) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/no chunks|not found/i);
  });

  it('emits no ANSI escape codes by default', () => {
    const lines: string[] = [];
    cmdShow(
      'sess1',
      {
        getSessionChunks: () => [
          makeChunk({ role: 'user', text: 'hello', filePath: '/f.jsonl' }),
        ],
      },
      { write: (s) => lines.push(s) },
    );
    expect(lines.join('\n')).not.toContain('\x1b[');
  });

  it('colours the role marker when color is enabled, leaving the body readable', () => {
    const lines: string[] = [];
    cmdShow(
      'sess1',
      {
        getSessionChunks: () => [
          makeChunk({ role: 'user', text: 'hello body', filePath: '/f.jsonl' }),
        ],
      },
      { color: true, write: (s) => lines.push(s) },
    );
    const output = lines.join('\n');
    expect(output).toContain('\x1b['); // some ANSI colour present
    expect(output).toContain('hello body'); // body text still recoverable
  });

  it('separates messages with a blank line', () => {
    const lines: string[] = [];
    cmdShow(
      'sess1',
      {
        getSessionChunks: () => [
          makeChunk({ role: 'user', text: 'first', filePath: '/f.jsonl' }),
          makeChunk({ role: 'assistant', text: 'second', filePath: '/f.jsonl' }),
        ],
      },
      { write: (s) => lines.push(s) },
    );
    expect(lines.join('\n')).toContain('\n\n');
  });
});

// ---------------------------------------------------------------------------
// cmdStatus
// ---------------------------------------------------------------------------

describe('cmdStatus', () => {
  it('renders a progress bar showing total, embedded, and pending counts', () => {
    const lines: string[] = [];
    cmdStatus(
      { queueStats: () => ({ total: 400, embedded: 300, pending: 100 }) },
      { write: (s) => lines.push(s) },
    );

    const output = lines.join('\n');
    expect(output).toContain('400');
    expect(output).toContain('300');
    expect(output).toContain('100');
  });

  it('includes a visual progress bar', () => {
    const lines: string[] = [];
    cmdStatus(
      { queueStats: () => ({ total: 10, embedded: 5, pending: 5 }) },
      { write: (s) => lines.push(s) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/\[.+\]/);
  });
});

// ---------------------------------------------------------------------------
// HELP_TEXT
// ---------------------------------------------------------------------------

describe('HELP_TEXT', () => {
  it('explains how to go from a search result to reading a transcript', () => {
    // The key workflow: search gives sessionId, then show reads the transcript
    expect(HELP_TEXT).toContain('agent-search show');
  });

  it('mentions show <sessionId> so agents know the next step after search', () => {
    expect(HELP_TEXT).toMatch(/show\s+<sessionId>/i);
  });

  it('documents the --limit flag', () => {
    expect(HELP_TEXT).toContain('--limit');
  });

  it('documents the --tools flag', () => {
    expect(HELP_TEXT).toContain('--tools');
  });
});

// ---------------------------------------------------------------------------
// parseCli
// ---------------------------------------------------------------------------

describe('parseCli', () => {
  it('treats a bare positional argument as a search query', () => {
    const args = parseCli(['my query here']);
    expect(args.command).toBe('search');
    expect(args.query).toBe('my query here');
  });

  it('joins multiple words into a single search query', () => {
    const args = parseCli(['hello', 'world', 'search']);
    expect(args.command).toBe('search');
    expect(args.query).toBe('hello world search');
  });

  it('parses --limit N and converts it to a number', () => {
    const args = parseCli(['my query', '--limit', '5']);
    expect(args.command).toBe('search');
    expect(args.limit).toBe(5);
  });

  it('produces NaN limit for a non-numeric --limit value', () => {
    const args = parseCli(['query', '--limit', 'nope']);
    expect(args.command).toBe('search');
    expect(args.limit).toBeNaN();
  });

  it('produces NaN limit for a non-positive --limit value', () => {
    const args = parseCli(['query', '--limit', '0']);
    expect(args.command).toBe('search');
    expect(args.limit).toBeNaN();
  });

  it('uses the last --limit value when the flag appears more than once', () => {
    const args = parseCli(['query', '--limit', '5', '--limit', '10']);
    expect(args.command).toBe('search');
    expect(args.limit).toBe(10);
    // Neither --limit flag should leak into the query
    expect(args.query).toBe('query');
  });

  it('parses --format json and strips it from the query', () => {
    const args = parseCli(['my query', '--format', 'json']);
    expect(args.command).toBe('search');
    expect(args.format).toBe('json');
    expect(args.query).toBe('my query');
  });

  it('parses --format text', () => {
    const args = parseCli(['my query', '--format', 'text']);
    expect(args.format).toBe('text');
    expect(args.query).toBe('my query');
  });

  it('preserves an unknown --format value for main() to reject', () => {
    const args = parseCli(['my query', '--format', 'xml']);
    expect(args.format).toBe('xml');
    expect(args.query).toBe('my query');
  });

  it('parses --limit and --format together', () => {
    const args = parseCli(['my query', '--limit', '5', '--format', 'json']);
    expect(args.limit).toBe(5);
    expect(args.format).toBe('json');
    expect(args.query).toBe('my query');
  });

  it('parses --cwd and strips it (and its value) from the query', () => {
    const args = parseCli(['my query', '--cwd', '~/src/foo']);
    expect(args.command).toBe('search');
    expect(args.cwd).toBe('~/src/foo');
    expect(args.all).toBe(false);
    expect(args.query).toBe('my query');
  });

  it('records a bare --cwd as empty string for main() to reject', () => {
    const args = parseCli(['my query', '--cwd']);
    expect(args.cwd).toBe('');
    expect(args.query).toBe('my query');
  });

  it('parses --all and strips it from the query', () => {
    const args = parseCli(['my query', '--all']);
    expect(args.all).toBe(true);
    expect(args.cwd).toBeUndefined();
    expect(args.query).toBe('my query');
  });

  it('leaves cwd undefined and all false when neither flag is given', () => {
    const args = parseCli(['my query']);
    expect(args.cwd).toBeUndefined();
    expect(args.all).toBe(false);
  });

  it('parses --cwd together with --limit and --format', () => {
    const args = parseCli(['my query', '--limit', '5', '--cwd', '.', '--format', 'json']);
    expect(args.limit).toBe(5);
    expect(args.format).toBe('json');
    expect(args.cwd).toBe('.');
    expect(args.query).toBe('my query');
  });

  it('parses the show subcommand with a session id', () => {
    const args = parseCli(['show', 'sess-abc123']);
    expect(args.command).toBe('show');
    expect(args.sessionId).toBe('sess-abc123');
  });

  it('parses --tools flag for the show subcommand', () => {
    const args = parseCli(['show', 'sess-123', '--tools']);
    expect(args.showTools).toBe(true);
  });

  it('show without --tools defaults showTools to false', () => {
    const args = parseCli(['show', 'sess-123']);
    expect(args.showTools).toBe(false);
  });

  it('parses index command', () => {
    const args = parseCli(['index']);
    expect(args.command).toBe('index');
  });

  it('parses watch command', () => {
    const args = parseCli(['watch']);
    expect(args.command).toBe('watch');
  });

  it('parses status command', () => {
    const args = parseCli(['status']);
    expect(args.command).toBe('status');
  });

  it('parses serve command with no options', () => {
    const args = parseCli(['serve']);
    expect(args.command).toBe('serve');
    expect(args.port).toBeUndefined();
    expect(args.watch).toBe(false);
  });

  it('parses serve with --port', () => {
    const args = parseCli(['serve', '--port', '4000']);
    expect(args.command).toBe('serve');
    expect(args.port).toBe(4000);
  });

  it('parses serve with --watch', () => {
    const args = parseCli(['serve', '--watch']);
    expect(args.command).toBe('serve');
    expect(args.watch).toBe(true);
  });

  it('parses serve with --port and --watch', () => {
    const args = parseCli(['serve', '--port', '8080', '--watch']);
    expect(args.command).toBe('serve');
    expect(args.port).toBe(8080);
    expect(args.watch).toBe(true);
  });

  it('marks a non-integer serve port as NaN', () => {
    const args = parseCli(['serve', '--port', 'abc']);
    expect(args.command).toBe('serve');
    expect(args.port).toBeNaN();
  });

  it('marks --port with no value as NaN', () => {
    const args = parseCli(['serve', '--port']);
    expect(args.command).toBe('serve');
    expect(args.port).toBeNaN();
  });

  it('returns help command for --help flag', () => {
    const args = parseCli(['--help']);
    expect(args.command).toBe('help');
  });

  it('returns help command for -h flag', () => {
    const args = parseCli(['-h']);
    expect(args.command).toBe('help');
  });

  it('returns help command for empty argv', () => {
    const args = parseCli([]);
    expect(args.command).toBe('help');
  });
});

// ---------------------------------------------------------------------------
// cmdIndex
// ---------------------------------------------------------------------------

/** Build a minimal fake CmdIndexDeps for unit tests. */
function makeFakeIndexDeps(overrides: Partial<Parameters<typeof cmdIndex>[0]> = {}): Parameters<typeof cmdIndex>[0] {
  return {
    queueStats: () => ({ total: 0, embedded: 0, pending: 0 }),
    kickWorker: () => {},
    isWorkerRunning: () => false,
    workerLastError: () => undefined,
    awaitWorkerIdle: () => Promise.resolve(),
    startWatcher: () => {},
    awaitBackfillEnqueued: () => Promise.resolve(),
    stopWatcher: () => Promise.resolve(),
    importOpencode: () => Promise.resolve(),
    assertEmbedModel: () => {}, // no-op by default
    ...overrides,
  };
}

const SILENT_OPTS: Parameters<typeof cmdIndex>[1] = {
  isTTY: false,
  write: () => {},
  writeRaw: () => {},
  intervalMs: 0,
};

describe('cmdIndex', () => {
  it('returns ok=true when queue drains to zero', async () => {
    const result = await cmdIndex(makeFakeIndexDeps(), SILENT_OPTS);
    expect(result.ok).toBe(true);
  });

  it('calls kickWorker after backfill is enqueued', async () => {
    let kicked = false;
    await cmdIndex(
      makeFakeIndexDeps({ kickWorker: () => { kicked = true; } }),
      SILENT_OPTS,
    );
    expect(kicked).toBe(true);
  });

  it('returns ok=false with an error message when the embed worker dies with pending work', async () => {
    // Worker is not running, has an error, but pending > 0.
    const result = await cmdIndex(
      makeFakeIndexDeps({
        queueStats: () => ({ total: 5, embedded: 0, pending: 5 }),
        isWorkerRunning: () => false,
        workerLastError: () => new Error('cannot reach ollama at localhost:11434'),
      }),
      SILENT_OPTS,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ollama/i);
  });

  it('does not hang when worker dies with pending work (terminates promptly)', async () => {
    // This test would time out if the loop were infinite.
    const start = Date.now();
    await cmdIndex(
      makeFakeIndexDeps({
        queueStats: () => ({ total: 3, embedded: 0, pending: 3 }),
        isWorkerRunning: () => false,
        workerLastError: () => new Error('ollama unreachable'),
      }),
      { ...SILENT_OPTS, intervalMs: 0 },
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000); // should terminate in well under 2s
  });

  it('calls assertEmbedModel before kicking the worker', async () => {
    const calls: string[] = [];
    await cmdIndex(
      makeFakeIndexDeps({
        assertEmbedModel: () => { calls.push('assertEmbedModel'); },
        kickWorker: () => { calls.push('kickWorker'); },
      }),
      SILENT_OPTS,
    );
    const assertIdx = calls.indexOf('assertEmbedModel');
    const kickIdx = calls.indexOf('kickWorker');
    expect(assertIdx).toBeGreaterThanOrEqual(0);
    expect(kickIdx).toBeGreaterThan(assertIdx);
  });

  it('returns ok=false with clear error when assertEmbedModel throws (model mismatch)', async () => {
    const result = await cmdIndex(
      makeFakeIndexDeps({
        assertEmbedModel: () => {
          throw new Error('Embed model mismatch: index was built with "old-model" but current is "new-model". Delete /idx.db to reindex.');
        },
      }),
      SILENT_OPTS,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mismatch|old-model/i);
  });
});

describe('homeRelative', () => {
  it('strips the home prefix to give a path relative to home', () => {
    expect(homeRelative('/Users/agent/src/agent-search', '/Users/agent')).toBe('src/agent-search');
  });

  it('returns ~ when the path is exactly home', () => {
    expect(homeRelative('/Users/agent', '/Users/agent')).toBe('~');
  });

  it('returns the absolute path unchanged when not under home', () => {
    expect(homeRelative('/tmp/scratch', '/Users/agent')).toBe('/tmp/scratch');
  });

  it('returns empty string for empty input', () => {
    expect(homeRelative('', '/Users/agent')).toBe('');
  });
});

describe('resolveCwd', () => {
  const base = '/Users/agent/src/agent-search';
  const home = '/Users/agent';

  it('returns an absolute path unchanged', () => {
    expect(resolveCwd('/tmp/x', base, home)).toBe('/tmp/x');
  });

  it('expands a bare ~ to home', () => {
    expect(resolveCwd('~', base, home)).toBe('/Users/agent');
  });

  it('expands a leading ~/ to home', () => {
    expect(resolveCwd('~/src/foo', base, home)).toBe('/Users/agent/src/foo');
  });

  it('resolves . against the base directory', () => {
    expect(resolveCwd('.', base, home)).toBe(base);
  });

  it('resolves a relative path against the base directory', () => {
    expect(resolveCwd('../other', base, home)).toBe('/Users/agent/src/other');
  });

  it('returns empty string for empty input', () => {
    expect(resolveCwd('', base, home)).toBe('');
  });
});
