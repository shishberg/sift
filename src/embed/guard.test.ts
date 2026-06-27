/**
 * guard.test.ts — tests for assertEmbedModel
 *
 * Uses in-memory Store instances so nothing touches the filesystem.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../index/store.js';
import { assertEmbedModel } from './guard.js';

// Minimal Embedder stub for tests
function makeEmbedder(model: string, dims: number) {
  return {
    model,
    dims,
    embed: async () => [],
  };
}

describe('assertEmbedModel', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('writes embed_model and embed_dims to meta when none are stored', () => {
    const embedder = makeEmbedder('nomic-embed-text', 768);
    assertEmbedModel(store, embedder, '/path/to/index.db');

    expect(store.getMeta('embed_model')).toBe('nomic-embed-text');
    expect(store.getMeta('embed_dims')).toBe('768');
  });

  it('does not throw when model and dims match stored values', () => {
    store.setMeta('embed_model', 'nomic-embed-text');
    store.setMeta('embed_dims', '768');

    const embedder = makeEmbedder('nomic-embed-text', 768);
    expect(() => assertEmbedModel(store, embedder, '/path/to/index.db')).not.toThrow();
  });

  it('throws with a clear error when the stored model differs', () => {
    store.setMeta('embed_model', 'old-model');
    store.setMeta('embed_dims', '768');

    const embedder = makeEmbedder('new-model', 768);
    expect(() => assertEmbedModel(store, embedder, '/my/index.db')).toThrow(
      /old-model.*new-model|new-model.*old-model/i,
    );
  });

  it('throws with a clear error when dims differ', () => {
    store.setMeta('embed_model', 'nomic-embed-text');
    store.setMeta('embed_dims', '512');

    const embedder = makeEmbedder('nomic-embed-text', 768);
    expect(() => assertEmbedModel(store, embedder, '/my/index.db')).toThrow(/512.*768|768.*512/);
  });

  it('includes the db path in the mismatch error so the user knows what to delete', () => {
    store.setMeta('embed_model', 'old-model');
    store.setMeta('embed_dims', '512');

    const embedder = makeEmbedder('new-model', 768);
    let message = '';
    try {
      assertEmbedModel(store, embedder, '/specific/path/index.db');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('/specific/path/index.db');
  });

  it('error message tells user to delete the index file or set the model back', () => {
    store.setMeta('embed_model', 'old-model');
    store.setMeta('embed_dims', '512');

    const embedder = makeEmbedder('new-model', 768);
    let message = '';
    try {
      assertEmbedModel(store, embedder, '/idx.db');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // Should mention delete or reindex
    expect(message).toMatch(/delete|reindex/i);
  });
});
