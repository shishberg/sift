import { describe, it, expect } from 'vitest';
import {
  formatResult,
  renderProgressBar,
  cmdSearch,
  cmdShow,
  cmdStatus,
  cmdIndex,
  HELP_TEXT,
  parseCli,
  homeRelative,
} from './cli.js';
import type { SearchResult } from '../search/search.js';
import type { Chunk } from '../types.js';

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

  it('includes file:line from the source locator', () => {
    const line = formatResult(
      makeSearchResult({ filePath: '/logs/session.jsonl', lineNumber: 42 }),
    );
    expect(line).toContain('session.jsonl:42');
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
});

// ---------------------------------------------------------------------------
// cmdSearch
// ---------------------------------------------------------------------------

describe('cmdSearch', () => {
  it('prints each result including session id and file:line', async () => {
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
    expect(output).toContain('sess-xyz');
    expect(output).toContain('a.jsonl:7');
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
