import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store, EMBED_DIMS } from '../index/store.js';
import type { Embedder } from '../embed/types.js';
import type { Chunk } from '../types.js';
import { rrfFuse, search } from './search.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    agentType: 'claude',
    sessionId: 'test-session',
    filePath: '/logs/test.jsonl',
    lineNumber: 1,
    role: 'user',
    text: 'hello world',
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeEmbedding(value = 0.1): number[] {
  return Array(EMBED_DIMS).fill(value);
}

/** A fake embedder that always returns the same vector for any query. */
function makeFakeEmbedder(queryVector: number[]): Embedder {
  return {
    model: 'fake-model',
    dims: EMBED_DIMS,
    async embed(_texts: string[], _kind: 'document' | 'query'): Promise<number[][]> {
      return _texts.map(() => queryVector);
    },
  };
}

// ---------------------------------------------------------------------------
// rrfFuse — pure unit tests (no DB, no network)
// ---------------------------------------------------------------------------

describe('rrfFuse', () => {
  it('returns empty array for no lists', () => {
    expect(rrfFuse([], { limit: 10 })).toHaveLength(0);
  });

  it('returns empty array for empty lists', () => {
    expect(rrfFuse([[], []], { limit: 10 })).toHaveLength(0);
  });

  it('scores a single-list result as 1/(k+rank)', () => {
    // Default k=60, rank 1 → 1/61
    const result = rrfFuse([[42]], { limit: 10 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(42);
    expect(result[0].score).toBeCloseTo(1 / 61, 8);
  });

  it('item in both lists outranks items in only one list', () => {
    // vecList: [2, 1]  — id=2 rank1, id=1 rank2
    // ftsList: [1, 3]  — id=1 rank1, id=3 rank2
    // id=1: 1/62 + 1/61 ≈ 0.03253  (in both)
    // id=2: 1/61        ≈ 0.01639  (vec only)
    // id=3: 1/62        ≈ 0.01613  (fts only)
    const fused = rrfFuse([[2, 1], [1, 3]], { limit: 10 });
    expect(fused[0].id).toBe(1); // must be first — in both lists
    const ids = fused.map(r => r.id);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
  });

  it('produces the correct RRF order for known ranked lists', () => {
    // vecList: [2, 1]  — id=2 rank1, id=1 rank2
    // ftsList: [1, 3]  — id=1 rank1, id=3 rank2
    // Expected order: id=1 > id=2 > id=3
    const fused = rrfFuse([[2, 1], [1, 3]], { limit: 10 });
    expect(fused[0].id).toBe(1);
    expect(fused[1].id).toBe(2);
    expect(fused[2].id).toBe(3);
  });

  it('computes scores correctly for known ranked lists', () => {
    const fused = rrfFuse([[2, 1], [1, 3]], { limit: 10 });
    // id=1: rank 2 in list A + rank 1 in list B
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 8);
    // id=2: rank 1 in list A only
    expect(fused[1].score).toBeCloseTo(1 / 61, 8);
    // id=3: rank 2 in list B only
    expect(fused[2].score).toBeCloseTo(1 / 62, 8);
  });

  it('respects the limit parameter', () => {
    const result = rrfFuse([[1, 2, 3, 4, 5]], { limit: 3 });
    expect(result).toHaveLength(3);
  });

  it('uses custom k when provided', () => {
    // k=0 → score for rank 1 = 1/(0+1) = 1
    const result = rrfFuse([[7]], { k: 0, limit: 10 });
    expect(result[0].score).toBeCloseTo(1, 8);
  });

  it('handles items appearing in more than two lists', () => {
    // id=5 appears in all three lists at rank 1 each → score = 3 * 1/61
    const fused = rrfFuse([[5, 6], [5, 7], [5, 8]], { limit: 10 });
    expect(fused[0].id).toBe(5);
    expect(fused[0].score).toBeCloseTo(3 / 61, 8);
  });
});

// ---------------------------------------------------------------------------
// search — integration tests (in-memory store + fake embedder)
// ---------------------------------------------------------------------------

describe('search', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('returns empty array when store is empty', async () => {
    const embedder = makeFakeEmbedder(makeEmbedding(0.5));
    const results = await search('anything', { store, embedder });
    expect(results).toHaveLength(0);
  });

  it('result carries all required source-locator fields', async () => {
    const chunk = makeChunk({
      agentType: 'claude',
      sessionId: 'session-abc',
      filePath: '/logs/claude/session-abc.jsonl',
      lineNumber: 5,
      role: 'user',
      text: 'locator test phrase uniqueword',
      timestamp: '2026-03-01T12:00:00Z',
    });
    const id = store.addChunk(chunk);
    const emb = makeEmbedding(0.5);
    store.setEmbedding(id, emb);

    const embedder = makeFakeEmbedder(emb);
    const results = await search('uniqueword', { store, embedder });

    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r.sessionId).toBe('session-abc');
    expect(r.agentType).toBe('claude');
    expect(r.filePath).toBe('/logs/claude/session-abc.jsonl');
    expect(r.lineNumber).toBe(5);
    expect(r.role).toBe('user');
    expect(r.timestamp).toBe('2026-03-01T12:00:00Z');
    expect(typeof r.snippet).toBe('string');
    expect(r.snippet.length).toBeGreaterThan(0);
    expect(typeof r.score).toBe('number');
    expect(r.score).toBeGreaterThan(0);
  });

  it('respects the limit option', async () => {
    // Insert 10 chunks all matching the query
    for (let i = 1; i <= 10; i++) {
      const id = store.addChunk(
        makeChunk({
          text: `common queryterm here ${i}`,
          sessionId: `session-${i}`,
          lineNumber: i,
        }),
      );
      store.setEmbedding(id, makeEmbedding(0.5));
    }

    const embedder = makeFakeEmbedder(makeEmbedding(0.5));
    const results = await search('queryterm', { store, embedder }, { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('default limit is 20', async () => {
    // Insert 25 matching chunks
    for (let i = 1; i <= 25; i++) {
      const id = store.addChunk(
        makeChunk({
          text: `matching content wordforlimit ${i}`,
          sessionId: `sl-${i}`,
          lineNumber: i,
        }),
      );
      store.setEmbedding(id, makeEmbedding(0.5));
    }

    const embedder = makeFakeEmbedder(makeEmbedding(0.5));
    const results = await search('wordforlimit', { store, embedder });
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it('results are sorted by score descending', async () => {
    // Chunk A: appears in BOTH indexes (high score)
    // Chunk B: appears in vec only
    // Chunk C: appears in fts only
    // Chunk A should come first because it's in both

    const queryVec = makeEmbedding(1.0);

    // Chunk A — matches FTS ("uniqueftsterm") and gets a vec embedding close to query
    const idA = store.addChunk(
      makeChunk({
        text: 'uniqueftsterm hello',
        sessionId: 'session-a',
        lineNumber: 1,
      }),
    );
    store.setEmbedding(idA, queryVec);

    // Chunk B — gets query-close vec embedding but generic text (won't match FTS "uniqueftsterm")
    const idB = store.addChunk(
      makeChunk({
        text: 'generic unrelated content here',
        sessionId: 'session-b',
        lineNumber: 1,
      }),
    );
    store.setEmbedding(idB, queryVec);

    const embedder = makeFakeEmbedder(queryVec);
    const results = await search('uniqueftsterm', { store, embedder });

    expect(results.length).toBeGreaterThanOrEqual(2);
    // A appears in both → must have higher score
    const scores = Object.fromEntries(results.map(r => [r.sessionId, r.score]));
    expect(scores['session-a']).toBeGreaterThan(scores['session-b']);
    // Scores must be non-increasing
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it('merges both indexes — items from vec-only and fts-only both appear', async () => {
    const queryVec = makeEmbedding(1.0);
    const farVec = makeEmbedding(0.0); // far from queryVec

    // Chunk A: matches FTS "onlyftsterm" but has a far embedding (won't rank in vec)
    const idA = store.addChunk(
      makeChunk({
        text: 'onlyftsterm here',
        sessionId: 'fts-only',
        lineNumber: 1,
      }),
    );
    store.setEmbedding(idA, farVec);

    // Chunk B: has queryVec embedding but generic text (won't match FTS "onlyftsterm")
    const idB = store.addChunk(
      makeChunk({
        text: 'completely different content zzzz',
        sessionId: 'vec-only',
        lineNumber: 1,
      }),
    );
    store.setEmbedding(idB, queryVec);

    const embedder = makeFakeEmbedder(queryVec);
    const results = await search('onlyftsterm', { store, embedder }, { limit: 10 });

    const sessionIds = results.map(r => r.sessionId);
    expect(sessionIds).toContain('fts-only'); // found via FTS
    expect(sessionIds).toContain('vec-only'); // found via vec
  });

  it('snippet is the chunk text trimmed to a reasonable length', async () => {
    const longText = 'a'.repeat(500);
    const id = store.addChunk(
      makeChunk({ text: longText, sessionId: 'snip-test', lineNumber: 1 }),
    );
    store.setEmbedding(id, makeEmbedding(0.5));

    const embedder = makeFakeEmbedder(makeEmbedding(0.5));
    // FTS won't match 'aaa...', use vec-only by searching with a matching vector
    const results = await search('aaaa', { store, embedder }, { limit: 5 });
    const r = results.find(x => x.sessionId === 'snip-test');
    if (r) {
      expect(r.snippet.length).toBeLessThanOrEqual(200);
    }
    // Even if FTS finds nothing, vec should find it; check via vec search result
    const vecResults = store.vecSearch(makeEmbedding(0.5), 10);
    expect(vecResults.some(v => v.id === id)).toBe(true);
  });

  it('works when vecSearch returns nothing (no embeddings stored)', async () => {
    // Only FTS-indexable content, no embeddings set
    store.addChunk(
      makeChunk({ text: 'noembed matchterm', sessionId: 'fts-session', lineNumber: 1 }),
    );

    const embedder = makeFakeEmbedder(makeEmbedding(0.5));
    const results = await search('matchterm', { store, embedder });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sessionId).toBe('fts-session');
  });

  it('works when ftsSearch returns nothing (no text match)', async () => {
    const queryVec = makeEmbedding(0.9);
    const id = store.addChunk(
      makeChunk({ text: 'zzznomatch', sessionId: 'vec-session', lineNumber: 1 }),
    );
    store.setEmbedding(id, queryVec);

    const embedder = makeFakeEmbedder(queryVec);
    const results = await search('termthatdoesnotexistindb', { store, embedder });

    // vec should still find the chunk
    expect(results.some(r => r.sessionId === 'vec-session')).toBe(true);
  });

  it('does not throw when query contains FTS5-syntax punctuation', async () => {
    // FTS5 MATCH throws on certain inputs like "hello-world", "foo:bar", unmatched quotes.
    // The search function should catch those and fall back to vec-only results.
    const queryVec = makeEmbedding(0.7);
    const id = store.addChunk(
      makeChunk({ text: 'vector content only', sessionId: 'fts-error-session', lineNumber: 1 }),
    );
    store.setEmbedding(id, queryVec);

    const embedder = makeFakeEmbedder(queryVec);
    // These queries would throw from FTS5 MATCH without the try/catch guard.
    await expect(search('hello-world', { store, embedder })).resolves.toBeDefined();
    await expect(search('foo:bar', { store, embedder })).resolves.toBeDefined();
    // "unmatched quote" — FTS5 parse error
    await expect(search('"unclosed', { store, embedder })).resolves.toBeDefined();

    // Vec results should still come back even when FTS throws
    const results = await search('"unclosed', { store, embedder });
    expect(results.some(r => r.sessionId === 'fts-error-session')).toBe(true);
  });

  it('handles multiple agent types correctly', async () => {
    const emb = makeEmbedding(0.5);
    const agents: Array<'claude' | 'codex' | 'pi'> = ['claude', 'codex', 'pi'];

    for (const agentType of agents) {
      const id = store.addChunk(
        makeChunk({
          agentType,
          text: `multiagent queryword content`,
          sessionId: `session-${agentType}`,
          lineNumber: 1,
        }),
      );
      store.setEmbedding(id, emb);
    }

    const embedder = makeFakeEmbedder(emb);
    const results = await search('queryword', { store, embedder }, { limit: 10 });

    const agentTypes = new Set(results.map(r => r.agentType));
    expect(agentTypes.size).toBeGreaterThanOrEqual(2); // at least two agent types appear
  });
});
