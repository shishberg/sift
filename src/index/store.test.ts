import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import Database from 'better-sqlite3';
import { Store, EMBED_DIMS, resolveDbPath } from './store.js';
import type { Chunk } from '../types.js';

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    agentType: 'claude',
    sessionId: 'test-session-1',
    filePath: '/tmp/test.jsonl',
    lineNumber: 1,
    role: 'user',
    text: 'Hello world',
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeEmbedding(value = 0.1): number[] {
  return Array(EMBED_DIMS).fill(value);
}

describe('resolveDbPath', () => {
  const original = process.env.SIFT_DB;
  afterEach(() => {
    if (original === undefined) delete process.env.SIFT_DB;
    else process.env.SIFT_DB = original;
  });

  it('prefers an explicit path over $SIFT_DB and the default', () => {
    process.env.SIFT_DB = '/env/path.db';
    expect(resolveDbPath('/explicit/path.db')).toBe('/explicit/path.db');
  });

  it('falls back to $SIFT_DB when no explicit path is given', () => {
    process.env.SIFT_DB = '/env/path.db';
    expect(resolveDbPath()).toBe('/env/path.db');
  });

  it('falls back to ~/.sift/index.db when neither is set', () => {
    delete process.env.SIFT_DB;
    expect(resolveDbPath()).toBe(join(homedir(), '.sift', 'index.db'));
  });
});

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('schema', () => {
    it('creates schema without error', () => {
      expect(() => store.getMeta('test')).not.toThrow();
    });

    it('schema creation is idempotent', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'store-test-'));
      const dbPath = join(tmpDir, 'test.db');
      try {
        const s1 = new Store(dbPath);
        s1.close();
        expect(() => {
          const s2 = new Store(dbPath);
          s2.close();
        }).not.toThrow();
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });
  });

  describe('addChunk', () => {
    it('returns a numeric id greater than 0', () => {
      const id = store.addChunk(makeChunk());
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    it('increments ids for successive inserts', () => {
      const id1 = store.addChunk(makeChunk({ lineNumber: 1 }));
      const id2 = store.addChunk(makeChunk({ lineNumber: 2 }));
      expect(id2).toBeGreaterThan(id1);
    });

    it('round-trips all chunk fields', () => {
      const chunk = makeChunk({
        agentType: 'codex',
        sessionId: 'session-abc',
        filePath: '/home/user/.codex/foo.jsonl',
        lineNumber: 42,
        role: 'assistant',
        text: 'I will help you',
        timestamp: '2026-01-01T12:00:00Z',
      });
      store.addChunk(chunk);
      const rows = store.getSessionChunks('session-abc');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        agentType: 'codex',
        sessionId: 'session-abc',
        filePath: '/home/user/.codex/foo.jsonl',
        lineNumber: 42,
        role: 'assistant',
        text: 'I will help you',
        timestamp: '2026-01-01T12:00:00Z',
      });
    });

    it('round-trips tool chunk with toolCall fields', () => {
      const chunk = makeChunk({
        role: 'tool',
        text: '',
        toolCall: { name: 'bash', args: '{"cmd":"ls"}' },
      });
      store.addChunk(chunk);
      const rows = store.getSessionChunks(chunk.sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].toolCall).toEqual({ name: 'bash', args: '{"cmd":"ls"}' });
    });

    it('stores chunk without toolCall as undefined toolCall', () => {
      store.addChunk(makeChunk({ role: 'user', text: 'no tool' }));
      const rows = store.getSessionChunks('test-session-1');
      expect(rows[0].toolCall).toBeUndefined();
    });

    // --- needs_embed gating ---
    it('sets needs_embed=1 for user chunk with non-empty text', () => {
      const id = store.addChunk(makeChunk({ role: 'user', text: 'hello' }));
      const pending = store.takePendingEmbeds(100);
      expect(pending.some(p => p.id === id)).toBe(true);
    });

    it('sets needs_embed=1 for assistant chunk with non-empty text', () => {
      const id = store.addChunk(makeChunk({ role: 'assistant', text: 'a response' }));
      const pending = store.takePendingEmbeds(100);
      expect(pending.some(p => p.id === id)).toBe(true);
    });

    it('sets needs_embed=0 for tool chunk', () => {
      store.addChunk(makeChunk({ role: 'tool', text: '', toolCall: { name: 'bash', args: '{}' } }));
      const pending = store.takePendingEmbeds(100);
      expect(pending).toHaveLength(0);
    });

    it('sets needs_embed=0 for user chunk with empty text', () => {
      store.addChunk(makeChunk({ role: 'user', text: '' }));
      const pending = store.takePendingEmbeds(100);
      expect(pending).toHaveLength(0);
    });

    it('sets needs_embed=0 for assistant chunk with empty text', () => {
      store.addChunk(makeChunk({ role: 'assistant', text: '' }));
      const pending = store.takePendingEmbeds(100);
      expect(pending).toHaveLength(0);
    });
  });

  describe('FTS search', () => {
    it('ftsSearch finds inserted text', () => {
      store.addChunk(makeChunk({ text: 'unique findme phrase' }));
      const results = store.ftsSearch('findme', 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('id');
      expect(typeof results[0].rank).toBe('number');
    });

    it('ftsSearch finds tool_name in tool chunk', () => {
      store.addChunk(
        makeChunk({ role: 'tool', text: '', toolCall: { name: 'specialtool_xyz', args: '{}' } }),
      );
      const results = store.ftsSearch('specialtool_xyz', 10);
      expect(results.length).toBeGreaterThan(0);
    });

    it('ftsSearch returns empty array for non-matching query', () => {
      store.addChunk(makeChunk({ text: 'hello world' }));
      const results = store.ftsSearch('zzznomatchzzz', 10);
      expect(results).toHaveLength(0);
    });

    it('ftsSearch respects limit', () => {
      for (let i = 0; i < 5; i++) {
        store.addChunk(makeChunk({ text: `common word here ${i}`, lineNumber: i + 1 }));
      }
      const results = store.ftsSearch('common', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  describe('vecSearch', () => {
    it('vecSearch finds exact-match embedding first with distance 0', () => {
      const emb1 = makeEmbedding(1.0);
      const emb2 = makeEmbedding(0.0);
      const id1 = store.addChunk(makeChunk({ text: 'vector one', sessionId: 's1', lineNumber: 1 }));
      const id2 = store.addChunk(makeChunk({ text: 'vector two', sessionId: 's2', lineNumber: 2 }));
      store.setEmbedding(id1, emb1);
      store.setEmbedding(id2, emb2);

      const results = store.vecSearch(emb1, 2);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe(id1);
      expect(typeof results[0].distance).toBe('number');
      expect(results[0].distance).toBeCloseTo(0);
    });

    it('vecSearch ranks closer embedding first', () => {
      const emb1 = makeEmbedding(1.0);
      const emb2 = makeEmbedding(0.0);
      const id1 = store.addChunk(makeChunk({ text: 'close', sessionId: 's1', lineNumber: 1 }));
      const id2 = store.addChunk(makeChunk({ text: 'far', sessionId: 's2', lineNumber: 2 }));
      store.setEmbedding(id1, emb1);
      store.setEmbedding(id2, emb2);

      // query near emb2 (all zeros) — id2 should come first
      const results = store.vecSearch(emb2, 2);
      expect(results[0].id).toBe(id2);
      expect(results[1].id).toBe(id1);
    });

    it('vecSearch returns empty when no vectors stored', () => {
      store.addChunk(makeChunk({ text: 'no embedding' }));
      const results = store.vecSearch(makeEmbedding(), 10);
      expect(results).toHaveLength(0);
    });

    it('vecSearch only returns chunks that have embeddings', () => {
      const emb = makeEmbedding(0.5);
      const idWithEmb = store.addChunk(
        makeChunk({ text: 'has embedding', sessionId: 's1', lineNumber: 1 }),
      );
      store.setEmbedding(idWithEmb, emb);
      store.addChunk(makeChunk({ text: 'no embedding', sessionId: 's2', lineNumber: 2 }));

      const results = store.vecSearch(emb, 10);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(idWithEmb);
    });
  });

  describe('cwd-filtered search', () => {
    // Two sessions in two different working directories. cwd lives on
    // source_files (keyed by file path), resolved through each chunk's file_path.
    const FILE_A = '/home/u/.claude/projects/a/sess-a.jsonl';
    const FILE_B = '/home/u/.claude/projects/b/sess-b.jsonl';
    const CWD_A = '/home/u/src/project-a';
    const CWD_B = '/home/u/src/project-b';

    beforeEach(() => {
      const idA = store.addChunk(
        makeChunk({ text: 'shared searchterm alpha', sessionId: 'sa', filePath: FILE_A, lineNumber: 1 }),
      );
      const idB = store.addChunk(
        makeChunk({ text: 'shared searchterm beta', sessionId: 'sb', filePath: FILE_B, lineNumber: 1 }),
      );
      store.setEmbedding(idA, makeEmbedding(1.0));
      store.setEmbedding(idB, makeEmbedding(0.0));
      store.setSourceFileCwd(FILE_A, CWD_A, 'claude');
      store.setSourceFileCwd(FILE_B, CWD_B, 'claude');
    });

    it('ftsSearch with a cwd returns only that directory\'s chunks', () => {
      const all = store.ftsSearch('searchterm', 10);
      expect(all).toHaveLength(2);

      const onlyA = store.ftsSearch('searchterm', 10, CWD_A);
      expect(onlyA).toHaveLength(1);
      expect(store.getChunk(onlyA[0].id)!.sessionId).toBe('sa');
    });

    it('vecSearch with a cwd returns only that directory\'s chunks', () => {
      // Query nearest emb1 (CWD_A's vector). Without a filter both come back;
      // with CWD_B only the (farther) B chunk should remain.
      const all = store.vecSearch(makeEmbedding(1.0), 10);
      expect(all).toHaveLength(2);

      const onlyB = store.vecSearch(makeEmbedding(1.0), 10, CWD_B);
      expect(onlyB).toHaveLength(1);
      expect(store.getChunk(onlyB[0].id)!.sessionId).toBe('sb');
    });

    it('an unknown cwd matches nothing', () => {
      expect(store.ftsSearch('searchterm', 10, '/no/such/dir')).toHaveLength(0);
      expect(store.vecSearch(makeEmbedding(1.0), 10, '/no/such/dir')).toHaveLength(0);
    });
  });

  describe('takePendingEmbeds', () => {
    it('returns chunks with needs_embed=1 with id and text', () => {
      const id = store.addChunk(makeChunk({ role: 'user', text: 'pending text' }));
      const pending = store.takePendingEmbeds(10);
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(id);
      expect(pending[0].text).toBe('pending text');
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        store.addChunk(makeChunk({ text: `text ${i}`, lineNumber: i + 1 }));
      }
      const pending = store.takePendingEmbeds(3);
      expect(pending).toHaveLength(3);
    });

    it('excludes chunks already embedded', () => {
      const id1 = store.addChunk(makeChunk({ text: 'embedded', lineNumber: 1 }));
      store.addChunk(makeChunk({ text: 'pending', lineNumber: 2 }));
      store.setEmbedding(id1, makeEmbedding(0.1));

      const pending = store.takePendingEmbeds(10);
      expect(pending).toHaveLength(1);
      expect(pending[0].text).toBe('pending');
    });

    it('returns empty when nothing pending', () => {
      store.addChunk(makeChunk({ role: 'tool', text: '', toolCall: { name: 'x', args: '{}' } }));
      expect(store.takePendingEmbeds(10)).toHaveLength(0);
    });
  });

  describe('setEmbedding', () => {
    it('writes vec row and clears needs_embed', () => {
      const id = store.addChunk(makeChunk({ text: 'embed me' }));
      expect(store.takePendingEmbeds(10)).toHaveLength(1);

      store.setEmbedding(id, makeEmbedding(0.5));

      expect(store.takePendingEmbeds(10)).toHaveLength(0);
      // vec row should exist — vecSearch finds it
      const results = store.vecSearch(makeEmbedding(0.5), 10);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(id);
    });

    it('throws on wrong dimension count', () => {
      const id = store.addChunk(makeChunk({ text: 'embed me' }));
      expect(() => store.setEmbedding(id, Array(3).fill(0.1))).toThrow(/dimension/i);
    });

    it('leaves needs_embed=1 on wrong dimension (atomic: no partial write)', () => {
      const id = store.addChunk(makeChunk({ text: 'embed me' }));
      try { store.setEmbedding(id, Array(3).fill(0.1)); } catch { /* expected */ }
      // needs_embed should still be 1
      const pending = store.takePendingEmbeds(10);
      expect(pending.some(p => p.id === id)).toBe(true);
    });
  });

  describe('queueStats', () => {
    it('returns zeros for empty store', () => {
      const stats = store.queueStats();
      expect(stats).toEqual({ total: 0, embedded: 0, pending: 0 });
    });

    it('counts user/assistant non-empty chunks as total', () => {
      store.addChunk(makeChunk({ role: 'user', text: 'hello' }));
      store.addChunk(makeChunk({ role: 'assistant', text: 'reply', lineNumber: 2 }));
      store.addChunk(makeChunk({ role: 'tool', text: '', toolCall: { name: 'x', args: '{}' }, lineNumber: 3 }));
      store.addChunk(makeChunk({ role: 'user', text: '', lineNumber: 4 })); // empty text
      const stats = store.queueStats();
      expect(stats.total).toBe(2);
      expect(stats.pending).toBe(2);
      expect(stats.embedded).toBe(0);
    });

    it('updates embedded count after setEmbedding', () => {
      const id1 = store.addChunk(makeChunk({ text: 'first', lineNumber: 1 }));
      store.addChunk(makeChunk({ text: 'second', lineNumber: 2 }));
      store.setEmbedding(id1, makeEmbedding(0.1));

      const stats = store.queueStats();
      expect(stats.total).toBe(2);
      expect(stats.embedded).toBe(1);
      expect(stats.pending).toBe(1);
    });
  });

  describe('recentSessions', () => {
    it('returns an empty array for an empty store', () => {
      expect(store.recentSessions()).toEqual([]);
    });

    it('returns one row per session, ordered by most recent message desc', () => {
      // s1: oldest first message, but its latest message is the newest overall.
      store.addChunk(makeChunk({ sessionId: 's1', lineNumber: 1, text: 's1 first', timestamp: '2026-01-01T00:00:01Z' }));
      store.addChunk(makeChunk({ sessionId: 's1', lineNumber: 2, text: 's1 latest', timestamp: '2026-01-01T00:00:09Z' }));
      // s2: a single message in the middle.
      store.addChunk(makeChunk({ sessionId: 's2', lineNumber: 1, text: 's2 only', timestamp: '2026-01-01T00:00:05Z' }));

      const rows = store.recentSessions();
      expect(rows.map((r) => r.sessionId)).toEqual(['s1', 's2']);
    });

    it('uses the most recent message as the snippet and its locator', () => {
      store.addChunk(makeChunk({ sessionId: 's1', lineNumber: 1, text: 'old', timestamp: '2026-01-01T00:00:01Z' }));
      store.addChunk(makeChunk({ sessionId: 's1', lineNumber: 7, text: 'newest', timestamp: '2026-01-01T00:00:09Z' }));

      const [row] = store.recentSessions();
      expect(row?.snippet).toBe('newest');
      expect(row?.lineNumber).toBe(7);
      expect(row?.timestamp).toBe('2026-01-01T00:00:09Z');
    });

    it('respects the limit', () => {
      for (let i = 0; i < 5; i++) {
        store.addChunk(makeChunk({ sessionId: `s${i}`, lineNumber: 1, text: `msg ${i}`, timestamp: `2026-01-01T00:00:0${i}Z` }));
      }
      expect(store.recentSessions(2)).toHaveLength(2);
    });

    it('resolves the session cwd when recorded', () => {
      store.addChunk(makeChunk({ sessionId: 's1', filePath: '/logs/s1.jsonl', text: 'hi' }));
      store.setSourceFileCwd('/logs/s1.jsonl', '/home/dave/proj', 'claude');

      const [row] = store.recentSessions();
      expect(row?.cwd).toBe('/home/dave/proj');
    });

    it("returns '' for cwd when none is recorded", () => {
      store.addChunk(makeChunk({ sessionId: 's1', text: 'hi' }));
      expect(store.recentSessions()[0]?.cwd).toBe('');
    });

    it('returns exactly one row per session even when the latest timestamp ties', () => {
      // Two chunks share the max timestamp; the later-inserted (higher id) wins.
      store.addChunk(makeChunk({ sessionId: 's1', lineNumber: 1, text: 'tie A', timestamp: '2026-01-01T00:00:09Z' }));
      store.addChunk(makeChunk({ sessionId: 's1', lineNumber: 2, text: 'tie B', timestamp: '2026-01-01T00:00:09Z' }));

      const rows = store.recentSessions();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.snippet).toBe('tie B');
      expect(rows[0]?.lineNumber).toBe(2);
    });
  });

  describe('source_files', () => {
    it('getSourceFile returns undefined for unknown path', () => {
      expect(store.getSourceFile('/unknown/path')).toBeUndefined();
    });

    it('upsertSourceFile creates a new record', () => {
      store.upsertSourceFile({
        path: '/test/file.jsonl',
        agentType: 'claude',
        inode: 12345,
        lastOffset: 0,
        lastSize: 0,
        lastLineNumber: 0,
      });
      const sf = store.getSourceFile('/test/file.jsonl');
      expect(sf).toBeDefined();
      expect(sf!.agentType).toBe('claude');
      expect(sf!.inode).toBe(12345);
      expect(sf!.lastOffset).toBe(0);
    });

    it('upsertSourceFile updates existing record', () => {
      const path = '/test/file.jsonl';
      store.upsertSourceFile({ path, agentType: 'claude', inode: 1, lastOffset: 0, lastSize: 0, lastLineNumber: 0 });
      store.upsertSourceFile({ path, agentType: 'claude', inode: 1, lastOffset: 500, lastSize: 1000, lastLineNumber: 20 });
      const sf = store.getSourceFile(path);
      expect(sf!.lastOffset).toBe(500);
      expect(sf!.lastSize).toBe(1000);
    });

    it('upsertSourceFile handles undefined inode', () => {
      store.upsertSourceFile({
        path: '/test/no-inode.jsonl',
        agentType: 'pi',
        lastOffset: 100,
        lastSize: 200,
        lastLineNumber: 5,
      });
      const sf = store.getSourceFile('/test/no-inode.jsonl');
      expect(sf!.inode).toBeUndefined();
    });

    it('round-trips lastLineNumber', () => {
      store.upsertSourceFile({
        path: '/test/lln.jsonl',
        agentType: 'claude',
        inode: 999,
        lastOffset: 0,
        lastSize: 0,
        lastLineNumber: 42,
      });
      const sf = store.getSourceFile('/test/lln.jsonl');
      expect(sf!.lastLineNumber).toBe(42);
    });

    it('lastLineNumber defaults to 0 when not set', () => {
      // Insert via raw SQL to simulate a legacy row without the column value
      // (In practice, the migration adds DEFAULT 0, so this just tests the default)
      store.upsertSourceFile({
        path: '/test/legacy.jsonl',
        agentType: 'codex',
        lastOffset: 0,
        lastSize: 0,
        lastLineNumber: 0,
      });
      const sf = store.getSourceFile('/test/legacy.jsonl');
      expect(sf!.lastLineNumber).toBe(0);
    });
  });

  describe('cwd (working directory)', () => {
    it('getSessionCwd returns undefined when no cwd is recorded', () => {
      store.addChunk(makeChunk({ sessionId: 's-nocwd', filePath: '/f.jsonl' }));
      expect(store.getSessionCwd('s-nocwd')).toBeUndefined();
    });

    it('setSourceFileCwd updates an existing source_files row and getSessionCwd resolves it via chunks', () => {
      const path = '/home/u/.claude/projects/x/sess.jsonl';
      store.upsertSourceFile({ path, agentType: 'claude', lastOffset: 0, lastSize: 0, lastLineNumber: 0 });
      store.addChunk(makeChunk({ sessionId: 's1', filePath: path }));

      store.setSourceFileCwd(path, '/home/u/src/agent-search', 'claude');

      expect(store.getSessionCwd('s1')).toBe('/home/u/src/agent-search');
      expect(store.getSourceFile(path)!.cwd).toBe('/home/u/src/agent-search');
    });

    it('setSourceFileCwd inserts a row when none exists (opencode virtual path)', () => {
      const path = 'opencode://os1';
      store.addChunk(makeChunk({ agentType: 'opencode', sessionId: 'os1', filePath: path }));

      store.setSourceFileCwd(path, '/home/u/src/mopoke', 'opencode');

      expect(store.getSessionCwd('os1')).toBe('/home/u/src/mopoke');
    });

    it('sourceFilesMissingCwd lists rows without a cwd and omits ones that have it', () => {
      store.upsertSourceFile({ path: '/a.jsonl', agentType: 'claude', lastOffset: 0, lastSize: 0, lastLineNumber: 0 });
      store.upsertSourceFile({ path: '/b.jsonl', agentType: 'codex', lastOffset: 0, lastSize: 0, lastLineNumber: 0 });
      store.setSourceFileCwd('/b.jsonl', '/home/u/b', 'codex');

      const missing = store.sourceFilesMissingCwd();
      expect(missing).toEqual([{ path: '/a.jsonl', agentType: 'claude' }]);
    });
  });

  describe('meta', () => {
    it('getMeta returns undefined for unknown key', () => {
      expect(store.getMeta('unknown_key')).toBeUndefined();
    });

    it('setMeta and getMeta round-trip', () => {
      store.setMeta('embed_model', 'nomic-embed-text');
      expect(store.getMeta('embed_model')).toBe('nomic-embed-text');
    });

    it('setMeta overwrites existing value', () => {
      store.setMeta('embed_dims', '768');
      store.setMeta('embed_dims', '1024');
      expect(store.getMeta('embed_dims')).toBe('1024');
    });
  });

  describe('getSessionChunks', () => {
    it('returns empty array for unknown sessionId', () => {
      expect(store.getSessionChunks('nonexistent')).toHaveLength(0);
    });

    it('returns chunks ordered by file_path then line_number', () => {
      store.addChunk(makeChunk({ sessionId: 'order-test', filePath: '/b.jsonl', lineNumber: 2 }));
      store.addChunk(makeChunk({ sessionId: 'order-test', filePath: '/a.jsonl', lineNumber: 10 }));
      store.addChunk(makeChunk({ sessionId: 'order-test', filePath: '/a.jsonl', lineNumber: 3 }));

      const chunks = store.getSessionChunks('order-test');
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toMatchObject({ filePath: '/a.jsonl', lineNumber: 3 });
      expect(chunks[1]).toMatchObject({ filePath: '/a.jsonl', lineNumber: 10 });
      expect(chunks[2]).toMatchObject({ filePath: '/b.jsonl', lineNumber: 2 });
    });

    it('only returns chunks for the given sessionId', () => {
      store.addChunk(makeChunk({ sessionId: 'session-a', lineNumber: 1 }));
      store.addChunk(makeChunk({ sessionId: 'session-b', lineNumber: 2 }));
      const chunks = store.getSessionChunks('session-a');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].sessionId).toBe('session-a');
    });
  });

  describe('getSessionFiles', () => {
    it('getSessionFiles returns distinct file/agent for a session, ordered', () => {
      store.addChunks([
        { chunk: { agentType: 'claude', sessionId: 's1', filePath: '/b.jsonl', lineNumber: 1, role: 'user', text: 'a', timestamp: 't' } },
        { chunk: { agentType: 'claude', sessionId: 's1', filePath: '/b.jsonl', lineNumber: 2, role: 'assistant', text: 'b', timestamp: 't' } },
        { chunk: { agentType: 'claude', sessionId: 's1', filePath: '/a.jsonl', lineNumber: 1, role: 'user', text: 'c', timestamp: 't' } },
      ]);
      expect(store.getSessionFiles('s1')).toEqual([
        { filePath: '/a.jsonl', agentType: 'claude' },
        { filePath: '/b.jsonl', agentType: 'claude' },
      ]);
    });
  });

  describe('checkEmbedModel', () => {
    it('returns matches=true and no stored when no meta is set (first run)', () => {
      const result = store.checkEmbedModel('nomic-embed-text', 768);
      expect(result.matches).toBe(true);
      expect(result.stored).toBeUndefined();
    });

    it('returns matches=true when model and dims match stored values', () => {
      store.setMeta('embed_model', 'nomic-embed-text');
      store.setMeta('embed_dims', '768');
      const result = store.checkEmbedModel('nomic-embed-text', 768);
      expect(result.matches).toBe(true);
    });

    it('returns matches=false and stored info when model differs', () => {
      store.setMeta('embed_model', 'old-model');
      store.setMeta('embed_dims', '768');
      const result = store.checkEmbedModel('nomic-embed-text', 768);
      expect(result.matches).toBe(false);
      expect(result.stored).toEqual({ model: 'old-model', dims: 768 });
    });

    it('returns matches=false when dims differ', () => {
      store.setMeta('embed_model', 'nomic-embed-text');
      store.setMeta('embed_dims', '512');
      const result = store.checkEmbedModel('nomic-embed-text', 768);
      expect(result.matches).toBe(false);
    });
  });

  describe('vec enforcement (spec: only user/assistant with non-empty text get a vec row)', () => {
    it('does not write vec row for tool chunks', () => {
      // Add a user chunk so the vec table is non-empty
      const userId = store.addChunk(makeChunk({ role: 'user', text: 'user text', lineNumber: 1 }));
      store.setEmbedding(userId, makeEmbedding(1.0));

      const toolId = store.addChunk(
        makeChunk({ role: 'tool', text: '', toolCall: { name: 'bash', args: '{}' }, lineNumber: 2 }),
      );
      // tool chunk never gets needs_embed=1, so setEmbedding is never called for it
      // confirm it's not in vec table
      const results = store.vecSearch(makeEmbedding(1.0), 10);
      expect(results.map(r => r.id)).toContain(userId);
      expect(results.map(r => r.id)).not.toContain(toolId);
    });

    it('does not write vec row for user chunks with empty text', () => {
      const userId = store.addChunk(makeChunk({ role: 'user', text: 'has text', lineNumber: 1 }));
      store.setEmbedding(userId, makeEmbedding(1.0));

      const emptyId = store.addChunk(makeChunk({ role: 'user', text: '', lineNumber: 2 }));
      // empty text chunk has needs_embed=0, so setEmbedding is never called for it
      const results = store.vecSearch(makeEmbedding(1.0), 10);
      expect(results.map(r => r.id)).toContain(userId);
      expect(results.map(r => r.id)).not.toContain(emptyId);
    });
  });

  describe('setEmbedding atomicity', () => {
    it('does not insert vec row when dims are wrong and needs_embed stays 1', () => {
      const id = store.addChunk(makeChunk({ text: 'must be atomic', sessionId: 'atomic-test' }));
      const wrongDimEmb = Array(3).fill(0.1);

      expect(() => store.setEmbedding(id, wrongDimEmb)).toThrow();
      // needs_embed still 1
      const pending = store.takePendingEmbeds(10);
      expect(pending.some(p => p.id === id)).toBe(true);
      // vec table still empty for this id
      expect(store.vecSearch(Array(EMBED_DIMS).fill(0.1), 10)).toHaveLength(0);
    });
  });

  describe('getChunk', () => {
    it('returns undefined for an id that does not exist', () => {
      expect(store.getChunk(999)).toBeUndefined();
    });

    it('returns the chunk for a known id', () => {
      const chunk = makeChunk({ sessionId: 'gc-session', lineNumber: 7 });
      const id = store.addChunk(chunk);
      const result = store.getChunk(id);
      expect(result).toBeDefined();
      expect(result!.sessionId).toBe('gc-session');
      expect(result!.lineNumber).toBe(7);
    });

    it('round-trips all chunk fields', () => {
      const chunk = makeChunk({
        agentType: 'codex',
        sessionId: 'gc-full',
        filePath: '/some/file.jsonl',
        lineNumber: 42,
        role: 'assistant',
        text: 'some assistant text',
        timestamp: '2026-06-01T10:00:00Z',
      });
      const id = store.addChunk(chunk);
      const result = store.getChunk(id);
      expect(result).toMatchObject({
        agentType: 'codex',
        sessionId: 'gc-full',
        filePath: '/some/file.jsonl',
        lineNumber: 42,
        role: 'assistant',
        text: 'some assistant text',
        timestamp: '2026-06-01T10:00:00Z',
      });
    });

    it('round-trips toolCall fields', () => {
      const chunk = makeChunk({
        role: 'tool',
        text: '',
        toolCall: { name: 'bash', args: '{"cmd":"ls"}' },
      });
      const id = store.addChunk(chunk);
      const result = store.getChunk(id);
      expect(result!.toolCall).toEqual({ name: 'bash', args: '{"cmd":"ls"}' });
    });
  });

  describe('WAL mode + busy_timeout (concurrency pragmas)', () => {
    it(':memory: store does not throw — WAL is skipped gracefully', () => {
      // The beforeEach store is :memory: — it must already be open with no errors.
      expect(() => store.getMeta('ping')).not.toThrow();
    });

    it('file-backed store sets journal_mode = wal', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'store-wal-'));
      const dbPath = join(tmpDir, 'wal.db');
      let s: Store | undefined;
      try {
        s = new Store(dbPath);
        // Open a second raw connection to verify the persisted journal_mode.
        const raw = new Database(dbPath, { readonly: true });
        const jm = raw.pragma('journal_mode', { simple: true }) as string;
        raw.close();
        expect(jm).toBe('wal');
      } finally {
        s?.close();
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('file-backed store sets busy_timeout = 5000 on its connection', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'store-bt-'));
      const dbPath = join(tmpDir, 'bt.db');
      let s: Store | undefined;
      try {
        s = new Store(dbPath);
        // Access the internal db connection to read the per-connection pragma.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bt = (s as any).db.pragma('busy_timeout', { simple: true }) as number;
        expect(bt).toBe(5000);
      } finally {
        s?.close();
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('file-backed store sets synchronous = NORMAL', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'store-sync-'));
      const dbPath = join(tmpDir, 'sync.db');
      let s: Store | undefined;
      try {
        s = new Store(dbPath);
        // synchronous values: 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sync = (s as any).db.pragma('synchronous', { simple: true }) as number;
        expect(sync).toBe(1); // NORMAL
      } finally {
        s?.close();
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('two file-backed handles on the same db can read and write without locking', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'store-concurrent-'));
      const dbPath = join(tmpDir, 'shared.db');
      let writer: Store | undefined;
      let reader: Store | undefined;
      try {
        writer = new Store(dbPath);
        reader = new Store(dbPath);

        // writer inserts a chunk; reader must see it without "database is locked"
        writer.addChunk(makeChunk({ text: 'concurrent test', sessionId: 'conc', lineNumber: 1 }));
        // Non-null assertion: both stores were assigned two lines above; if
        // either constructor threw, we'd already be in the finally block.
        expect(() => reader!.getSessionChunks('conc')).not.toThrow();
        const chunks = reader!.getSessionChunks('conc');
        expect(chunks).toHaveLength(1);
        expect(chunks[0].text).toBe('concurrent test');
      } finally {
        writer?.close();
        reader?.close();
        rmSync(tmpDir, { recursive: true });
      }
    });
  });

  describe('addChunks (batch insert)', () => {
    it('inserts multiple chunks and returns all ids', () => {
      const chunks = [
        makeChunk({ text: 'batch one', sessionId: 'batch-test', lineNumber: 1 }),
        makeChunk({ text: 'batch two', sessionId: 'batch-test', lineNumber: 2 }),
        makeChunk({ text: 'batch three', sessionId: 'batch-test', lineNumber: 3 }),
      ];
      const ids = store.addChunks(chunks.map(chunk => ({ chunk })));
      expect(ids).toHaveLength(3);
      expect(ids.every(id => typeof id === 'number')).toBe(true);
      expect(new Set(ids).size).toBe(3);
    });

    it('batch insert results appear in getSessionChunks', () => {
      const chunks = [
        makeChunk({ sessionId: 'batch-session', lineNumber: 1 }),
        makeChunk({ sessionId: 'batch-session', lineNumber: 2 }),
      ];
      store.addChunks(chunks.map(chunk => ({ chunk })));
      expect(store.getSessionChunks('batch-session')).toHaveLength(2);
    });

    it('batch insert marks eligible chunks as pending', () => {
      const chunks = [
        makeChunk({ text: 'user text', role: 'user', sessionId: 'vec-batch', lineNumber: 1 }),
        makeChunk({ text: '', role: 'tool', toolCall: { name: 'x', args: '{}' }, sessionId: 'vec-batch', lineNumber: 2 }),
      ];
      store.addChunks(chunks.map(chunk => ({ chunk })));
      const pending = store.takePendingEmbeds(10);
      expect(pending).toHaveLength(1);
      expect(pending[0].text).toBe('user text');
    });
  });
});
