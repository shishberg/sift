/**
 * guard.ts — embed model/dims consistency check.
 *
 * Before any indexing or searching that uses the embedder, call assertEmbedModel to
 * ensure the stored model metadata matches the current embedder. On a fresh index it
 * writes the metadata; on a match it's a no-op; on a mismatch it throws a clear,
 * actionable error.
 */
import type { Store } from '../index/store.js';
import type { Embedder } from './types.js';

/**
 * Assert that the current embedder's model + dims match what is stored in the index.
 *
 * Behaviour:
 *   - No stored meta (fresh index) → write current model + dims, continue.
 *   - Stored meta matches current → no-op.
 *   - Mismatch → throw with a message naming both models, the db path,
 *     and what the user must do (delete the index file or set the model back).
 *
 * @param store    Open Store instance.
 * @param embedder Current embedder (provides .model and .dims).
 * @param dbPath   Path to the db file — included in error messages for actionability.
 */
export function assertEmbedModel(store: Store, embedder: Embedder, dbPath: string): void {
  const storedModel = store.getMeta('embed_model');
  const storedDimsStr = store.getMeta('embed_dims');

  if (storedModel === undefined && storedDimsStr === undefined) {
    // Fresh index — record the current embedder's model + dims.
    store.setMeta('embed_model', embedder.model);
    store.setMeta('embed_dims', String(embedder.dims));
    return;
  }

  const storedDims = storedDimsStr !== undefined ? parseInt(storedDimsStr, 10) : NaN;
  const modelMatch = storedModel === embedder.model;
  const dimsMatch = storedDims === embedder.dims;

  if (modelMatch && dimsMatch) return;

  throw new Error(
    `Embed model mismatch: the index at "${dbPath}" was built with ` +
      `model "${storedModel ?? '?'}" (${storedDims} dims), ` +
      `but the current embedder is "${embedder.model}" (${embedder.dims} dims).\n` +
      `To fix: delete the index file and reindex from scratch:\n` +
      `  rm "${dbPath}"\n` +
      `  agent-search index\n` +
      `Or set the model back to "${storedModel ?? '?'}" and restart ollama.`,
  );
}
