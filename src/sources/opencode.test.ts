/**
 * opencode.test.ts
 *
 * Tests for the OpenCodeSource using an in-memory fixture database that mirrors
 * the real opencode.db schema. Does NOT touch ~/.local/share/opencode/opencode.db.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { OpenCodeSource } from './opencode.js';
import { Store } from '../index/store.js';

// ---- fixture DB helpers ----

function createFixtureDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS message (
      id           TEXT    PRIMARY KEY,
      session_id   TEXT    NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data         TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS part (
      id           TEXT    PRIMARY KEY,
      message_id   TEXT    NOT NULL,
      session_id   TEXT    NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data         TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session (
      id        TEXT PRIMARY KEY,
      directory TEXT
    );
  `);
  return db;
}

function insertSession(
  db: Database.Database,
  opts: { id: string; directory: string },
): void {
  db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run(opts.id, opts.directory);
}

const stmtInsertMessage = (db: Database.Database) =>
  db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
  );

function insertMessage(
  db: Database.Database,
  opts: { id: string; sessionId: string; role: 'user' | 'assistant'; timeCreated?: number },
): void {
  stmtInsertMessage(db).run(
    opts.id,
    opts.sessionId,
    opts.timeCreated ?? 1_000_000,
    opts.timeCreated ?? 1_000_000,
    JSON.stringify({ role: opts.role }),
  );
}

const stmtInsertPart = (db: Database.Database) =>
  db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
  );

function insertPart(
  db: Database.Database,
  opts: {
    id: string;
    messageId: string;
    sessionId: string;
    timeCreated?: number;
    data: Record<string, unknown>;
  },
): void {
  stmtInsertPart(db).run(
    opts.id,
    opts.messageId,
    opts.sessionId,
    opts.timeCreated ?? 1_000_000,
    opts.timeCreated ?? 1_000_000,
    JSON.stringify(opts.data),
  );
}

// ---- tests ----

describe('OpenCodeSource', () => {
  let fixtureDb: Database.Database;
  let store: Store;

  beforeEach(() => {
    fixtureDb = createFixtureDb();
    store = new Store(':memory:');
  });

  afterEach(() => {
    fixtureDb.close();
    store.close();
  });

  it('maps a user text part to a chunk with correct shape', () => {
    insertMessage(fixtureDb, {
      id: 'msg_1',
      sessionId: 'ses_1',
      role: 'user',
      timeCreated: 1_700_000_000_000,
    });
    insertPart(fixtureDb, {
      id: 'prt_1',
      messageId: 'msg_1',
      sessionId: 'ses_1',
      timeCreated: 1_700_000_000_001,
      data: { type: 'text', text: 'Hello opencode' },
    });

    const source = new OpenCodeSource(fixtureDb);
    const count = source.index(store);

    expect(count).toBe(1);
    const chunks = store.getSessionChunks('ses_1');
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0]!;
    expect(chunk.agentType).toBe('opencode');
    expect(chunk.sessionId).toBe('ses_1');
    expect(chunk.role).toBe('user');
    expect(chunk.text).toBe('Hello opencode');
    expect(chunk.filePath).toBe('opencode://ses_1');
    expect(chunk.timestamp).toBe(new Date(1_700_000_000_001).toISOString());
    expect(chunk.toolCall).toBeUndefined();
  });

  it('records the session working directory from the opencode session table', () => {
    insertSession(fixtureDb, { id: 'ses_cwd', directory: '/Users/agent/src/mopoke' });
    insertMessage(fixtureDb, { id: 'msg_cwd', sessionId: 'ses_cwd', role: 'user' });
    insertPart(fixtureDb, {
      id: 'prt_cwd',
      messageId: 'msg_cwd',
      sessionId: 'ses_cwd',
      data: { type: 'text', text: 'hello' },
    });

    const source = new OpenCodeSource(fixtureDb);
    source.index(store);

    expect(store.getSessionCwd('ses_cwd')).toBe('/Users/agent/src/mopoke');
  });

  it('backfillCwd sets cwd for already-indexed sessions from the session table', () => {
    // A chunk already exists (indexed before the cwd column) but has no cwd.
    store.addChunk({
      agentType: 'opencode',
      sessionId: 'ses_back',
      filePath: 'opencode://ses_back',
      lineNumber: 1,
      role: 'user',
      text: 'hi',
      timestamp: '',
    });
    insertSession(fixtureDb, { id: 'ses_back', directory: '/Users/agent/src/x' });

    const source = new OpenCodeSource(fixtureDb);
    source.backfillCwd(store);

    expect(store.getSessionCwd('ses_back')).toBe('/Users/agent/src/x');
  });

  it('maps an assistant text part to an assistant chunk', () => {
    insertMessage(fixtureDb, {
      id: 'msg_2',
      sessionId: 'ses_2',
      role: 'assistant',
      timeCreated: 1_700_000_000_002,
    });
    insertPart(fixtureDb, {
      id: 'prt_2',
      messageId: 'msg_2',
      sessionId: 'ses_2',
      timeCreated: 1_700_000_000_002,
      data: { type: 'text', text: 'Here is my answer.' },
    });

    const source = new OpenCodeSource(fixtureDb);
    const count = source.index(store);

    expect(count).toBe(1);
    const chunks = store.getSessionChunks('ses_2');
    expect(chunks[0]!.role).toBe('assistant');
    expect(chunks[0]!.text).toBe('Here is my answer.');
  });

  it('maps a tool part to a tool chunk with toolCall and output text', () => {
    insertMessage(fixtureDb, { id: 'msg_3', sessionId: 'ses_3', role: 'assistant' });
    insertPart(fixtureDb, {
      id: 'prt_3',
      messageId: 'msg_3',
      sessionId: 'ses_3',
      timeCreated: 1_700_000_001_000,
      data: {
        type: 'tool',
        tool: 'read',
        callID: 'call_123',
        state: {
          status: 'completed',
          input: { filePath: '/src/foo.ts' },
          output: 'file content here',
        },
      },
    });

    const source = new OpenCodeSource(fixtureDb);
    const count = source.index(store);

    expect(count).toBe(1);
    const chunks = store.getSessionChunks('ses_3');
    expect(chunks[0]!.role).toBe('tool');
    expect(chunks[0]!.toolCall?.name).toBe('read');
    expect(chunks[0]!.toolCall?.args).toContain('filePath');
    expect(chunks[0]!.text).toBe('file content here');
  });

  it('skips reasoning, step-start, step-finish, patch, and file parts', () => {
    insertMessage(fixtureDb, { id: 'msg_4', sessionId: 'ses_4', role: 'assistant' });
    for (const type of ['reasoning', 'step-start', 'step-finish', 'patch', 'file']) {
      insertPart(fixtureDb, {
        id: `prt_skip_${type}`,
        messageId: 'msg_4',
        sessionId: 'ses_4',
        data: { type, text: 'should be skipped' },
      });
    }

    const source = new OpenCodeSource(fixtureDb);
    const count = source.index(store);

    expect(count).toBe(0);
    expect(store.getSessionChunks('ses_4')).toHaveLength(0);
  });

  it('skips text parts with empty text', () => {
    insertMessage(fixtureDb, { id: 'msg_5', sessionId: 'ses_5', role: 'user' });
    insertPart(fixtureDb, {
      id: 'prt_empty',
      messageId: 'msg_5',
      sessionId: 'ses_5',
      data: { type: 'text', text: '' },
    });

    const source = new OpenCodeSource(fixtureDb);
    const count = source.index(store);

    expect(count).toBe(0);
    expect(store.getSessionChunks('ses_5')).toHaveLength(0);
  });

  it('incremental: second run only indexes newly added parts', () => {
    insertMessage(fixtureDb, { id: 'msg_6', sessionId: 'ses_6', role: 'user' });
    insertPart(fixtureDb, {
      id: 'prt_6a',
      messageId: 'msg_6',
      sessionId: 'ses_6',
      data: { type: 'text', text: 'first message' },
    });

    const source = new OpenCodeSource(fixtureDb);
    const count1 = source.index(store);
    expect(count1).toBe(1);

    // Insert another part AFTER the first run.
    insertPart(fixtureDb, {
      id: 'prt_6b',
      messageId: 'msg_6',
      sessionId: 'ses_6',
      data: { type: 'text', text: 'second message' },
    });

    const count2 = source.index(store);
    expect(count2).toBe(1);

    // Total: 2 chunks in session.
    const chunks = store.getSessionChunks('ses_6');
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.text)).toEqual(['first message', 'second message']);
  });

  it('idempotent: re-run with no new data returns 0 and produces no duplicates', () => {
    insertMessage(fixtureDb, { id: 'msg_7', sessionId: 'ses_7', role: 'assistant' });
    insertPart(fixtureDb, {
      id: 'prt_7',
      messageId: 'msg_7',
      sessionId: 'ses_7',
      data: { type: 'text', text: 'some response' },
    });

    const source = new OpenCodeSource(fixtureDb);
    source.index(store);
    const count2 = source.index(store);

    expect(count2).toBe(0);
    // Still only one chunk — no duplicate.
    expect(store.getSessionChunks('ses_7')).toHaveLength(1);
  });

  it('truncates long tool args and output', () => {
    insertMessage(fixtureDb, { id: 'msg_8', sessionId: 'ses_8', role: 'assistant' });
    const longInput = { data: 'x'.repeat(500) };
    const longOutput = 'y'.repeat(1000);
    insertPart(fixtureDb, {
      id: 'prt_8',
      messageId: 'msg_8',
      sessionId: 'ses_8',
      data: {
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: longInput, output: longOutput },
      },
    });

    const source = new OpenCodeSource(fixtureDb);
    source.index(store);

    const chunks = store.getSessionChunks('ses_8');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.toolCall?.args.length).toBeLessThanOrEqual(203); // 200 + '...'
    expect(chunks[0]!.text.length).toBeLessThanOrEqual(503); // 500 + '...'
  });

  it('uses the part rowid as lineNumber (stable across re-runs)', () => {
    insertMessage(fixtureDb, { id: 'msg_9', sessionId: 'ses_9', role: 'user' });
    insertPart(fixtureDb, {
      id: 'prt_9',
      messageId: 'msg_9',
      sessionId: 'ses_9',
      data: { type: 'text', text: 'stable line' },
    });

    const source = new OpenCodeSource(fixtureDb);
    source.index(store);

    const chunks = store.getSessionChunks('ses_9');
    // lineNumber must be a positive integer (the rowid from the opencode part table).
    expect(chunks[0]!.lineNumber).toBeGreaterThan(0);
    expect(Number.isInteger(chunks[0]!.lineNumber)).toBe(true);
  });

  it('advances cursor past skipped parts so they are not reprocessed', () => {
    insertMessage(fixtureDb, { id: 'msg_10', sessionId: 'ses_10', role: 'assistant' });
    // Only skippable parts — no indexable chunks produced.
    insertPart(fixtureDb, {
      id: 'prt_skip',
      messageId: 'msg_10',
      sessionId: 'ses_10',
      data: { type: 'reasoning', text: 'internal thoughts' },
    });

    const source = new OpenCodeSource(fixtureDb);
    const count1 = source.index(store); // 0 chunks but cursor should advance
    expect(count1).toBe(0);

    // Insert an indexable part afterwards.
    insertPart(fixtureDb, {
      id: 'prt_real',
      messageId: 'msg_10',
      sessionId: 'ses_10',
      data: { type: 'text', text: 'real content' },
    });

    const count2 = source.index(store); // should pick up only prt_real
    expect(count2).toBe(1);

    const chunks = store.getSessionChunks('ses_10');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('real content');
  });

  it('handles an out-of-range time_created without throwing, falls back to empty timestamp, and advances the cursor', () => {
    // Number.MAX_SAFE_INTEGER + 1 is beyond the Date range → new Date(x).toISOString() throws
    // SQLite's flexible typing lets us insert this as an INTEGER column value.
    const badTime = 8640000000000001; // 1 ms beyond Date max

    insertMessage(fixtureDb, { id: 'msg_bad_ts', sessionId: 'ses_bad_ts', role: 'user' });
    insertPart(fixtureDb, {
      id: 'prt_bad_ts',
      messageId: 'msg_bad_ts',
      sessionId: 'ses_bad_ts',
      timeCreated: badTime,
      data: { type: 'text', text: 'content with bad timestamp' },
    });

    const source = new OpenCodeSource(fixtureDb);
    let count = -1;
    expect(() => {
      count = source.index(store);
    }).not.toThrow();

    // A chunk should still be produced.
    expect(count).toBe(1);
    const chunks = store.getSessionChunks('ses_bad_ts');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('content with bad timestamp');
    // Timestamp must be a string (empty or epoch fallback — either is fine).
    expect(typeof chunks[0]!.timestamp).toBe('string');

    // Cursor must have advanced so re-run produces 0.
    const count2 = source.index(store);
    expect(count2).toBe(0);
  });

  describe('readTranscript', () => {
    it('returns text and tool items (input+output) in rowid order', () => {
      // Uses the existing fixtureDb from beforeEach (fresh per test).
      insertMessage(fixtureDb, { id: 'm1', sessionId: 's1', role: 'assistant' });
      insertPart(fixtureDb, {
        id: 'prt_t1',
        messageId: 'm1',
        sessionId: 's1',
        data: { type: 'text', text: 'hi' },
      });
      insertPart(fixtureDb, {
        id: 'prt_t2',
        messageId: 'm1',
        sessionId: 's1',
        data: { type: 'tool', tool: 'bash', state: { input: { cmd: 'ls' }, output: 'a\nb' } },
      });
      const source = new OpenCodeSource(fixtureDb);
      const items = source.readTranscript('s1');
      expect(items.map((i) => i.role)).toEqual(['assistant', 'tool']);
      expect(items[0]).toMatchObject({ text: 'hi', filePath: 'opencode://s1', lineNumbers: [1] });
      expect(items[1]!.tool).toEqual({ name: 'bash', input: '{"cmd":"ls"}', output: 'a\nb', isError: false });
      expect(items[1]!.lineNumbers).toEqual([2]);
    });

    it('uses state.error as the output for a failed tool part', () => {
      insertMessage(fixtureDb, { id: 'm1', sessionId: 's1', role: 'assistant' });
      insertPart(fixtureDb, {
        id: 'prt_err',
        messageId: 'm1',
        sessionId: 's1',
        data: { type: 'tool', tool: 'read', state: { status: 'error', input: { filePath: '/missing' }, error: 'File not found' } },
      });
      const source = new OpenCodeSource(fixtureDb);
      const items = source.readTranscript('s1');
      expect(items[0]!.tool).toMatchObject({ name: 'read', output: 'File not found', isError: true });
    });
  });
});
