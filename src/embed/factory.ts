/**
 * factory.ts — pick the embedder from configuration.
 *
 * The rest of the system depends only on the `Embedder` interface; this is the
 * single place that decides which concrete embedder to build. Selection is via
 * the AGENT_SEARCH_EMBED_PROVIDER env var:
 *   - "ollama"       (default) — OllamaEmbedder, talks to a local ollama service.
 *   - "fastembed"              — FastEmbedEmbedder, in-process ONNX (CPU), no service.
 *   - "transformers"           — TransformersEmbedder, in-process transformers.js
 *                                with device:"webgpu" (GPU in a WebGPU runtime).
 *
 * All are LOCAL only. Switching providers changes the stored model id, so the
 * embed-model guard will require a reindex — that's expected.
 */
import type { Embedder } from './types.js';
import { OllamaEmbedder } from './ollama.js';
import { FastEmbedEmbedder } from './fastembed.js';
import { TransformersEmbedder } from './transformers.js';

export const DEFAULT_EMBED_PROVIDER = 'ollama';

export function createEmbedder(): Embedder {
  const provider = (
    process.env['AGENT_SEARCH_EMBED_PROVIDER'] ?? DEFAULT_EMBED_PROVIDER
  ).toLowerCase();

  switch (provider) {
    case 'ollama':
      return new OllamaEmbedder();
    case 'fastembed':
      return new FastEmbedEmbedder();
    case 'transformers':
      return new TransformersEmbedder();
    default:
      throw new Error(
        `Unknown embed provider "${provider}". ` +
          `Set AGENT_SEARCH_EMBED_PROVIDER to "ollama", "fastembed", or "transformers".`,
      );
  }
}
