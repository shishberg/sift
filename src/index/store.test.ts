import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, EMBED_DIMS } from './store.js';
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
      const id1 = store.addChunk(
        makeChunk({ text: 'vector one', sessionId: 's1', lineNumber: 1 }),
        emb1,
      );
      store.addChunk(makeChunk({ text: 'vector two', sessionId: 's2', lineNumber: 2 }), emb2);

      const results = store.vecSearch(emb1, 2);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe(id1);
      expect(typeof results[0].distance).toBe('number');
      expect(results[0].distance).toBeCloseTo(0);
    });

    it('vecSearch ranks closer embedding first', () => {
      const emb1 = makeEmbedding(1.0);
      const emb2 = makeEmbedding(0.0);
      const id1 = store.addChunk(
        makeChunk({ text: 'close', sessionId: 's1', lineNumber: 1 }),
        emb1,
      );
      const id2 = store.addChunk(
        makeChunk({ text: 'far', sessionId: 's2', lineNumber: 2 }),
        emb2,
      );

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
        emb,
      );
      store.addChunk(makeChunk({ text: 'no embedding', sessionId: 's2', lineNumber: 2 }));

      const results = store.vecSearch(emb, 10);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(idWithEmb);
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
      });
      const sf = store.getSourceFile('/test/file.jsonl');
      expect(sf).toBeDefined();
      expect(sf!.agentType).toBe('claude');
      expect(sf!.inode).toBe(12345);
      expect(sf!.lastOffset).toBe(0);
    });

    it('upsertSourceFile updates existing record', () => {
      const path = '/test/file.jsonl';
      store.upsertSourceFile({ path, agentType: 'claude', inode: 1, lastOffset: 0, lastSize: 0 });
      store.upsertSourceFile({ path, agentType: 'claude', inode: 1, lastOffset: 500, lastSize: 1000 });
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
      });
      const sf = store.getSourceFile('/test/no-inode.jsonl');
      expect(sf!.inode).toBeUndefined();
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
    it('does not write vec row for tool chunks even when embedding is provided', () => {
      // Add a user chunk first so the vec table is non-empty (vecSearch needs at least 1 row)
      const userEmb = makeEmbedding(1.0);
      const userId = store.addChunk(
        makeChunk({ role: 'user', text: 'user text', lineNumber: 1 }),
        userEmb,
      );

      const toolId = store.addChunk(
        makeChunk({
          role: 'tool',
          text: '',
          toolCall: { name: 'bash', args: '{}' },
          lineNumber: 2,
        }),
        makeEmbedding(1.0), // embedding provided but should be ignored
      );

      const results = store.vecSearch(makeEmbedding(1.0), 10);
      expect(results.map(r => r.id)).toContain(userId);
      expect(results.map(r => r.id)).not.toContain(toolId);
    });

    it('does not write vec row for user chunks with empty text', () => {
      const userEmb = makeEmbedding(1.0);
      const userId = store.addChunk(
        makeChunk({ role: 'user', text: 'has text', lineNumber: 1 }),
        userEmb,
      );

      const emptyId = store.addChunk(
        makeChunk({ role: 'user', text: '', lineNumber: 2 }),
        makeEmbedding(0.9), // embedding provided but should be ignored
      );

      const results = store.vecSearch(makeEmbedding(1.0), 10);
      expect(results.map(r => r.id)).toContain(userId);
      expect(results.map(r => r.id)).not.toContain(emptyId);
    });
  });

  describe('addChunk atomicity', () => {
    it('throws and does not insert chunk when embedding has wrong dimensions', () => {
      const chunk = makeChunk({ text: 'must be atomic', sessionId: 'atomic-test' });
      const wrongDimEmb = Array(3).fill(0.1); // 3 dims, not 768

      expect(() => store.addChunk(chunk, wrongDimEmb)).toThrow();
      expect(store.getSessionChunks('atomic-test')).toHaveLength(0);
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

    it('batch insert with embeddings stores them in vec table', () => {
      const emb = makeEmbedding(0.5);
      store.addChunks([
        { chunk: makeChunk({ sessionId: 'vec-batch', lineNumber: 1 }), embedding: emb },
      ]);
      const results = store.vecSearch(emb, 10);
      expect(results).toHaveLength(1);
    });
  });
});
