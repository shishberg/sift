import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Embedder } from './types.js';

// ---------------------------------------------------------------------------
// FastEmbedEmbedder — in-process local embeddings via the `fastembed` package.
//
// An alternative to OllamaEmbedder that needs no separate service: `fastembed`
// runs ONNX models in-process (downloading the model to a local cache on first
// use). Still LOCAL only — no cloud API, satisfying the project's hard rule.
//
// The sqlite-vec schema is fixed at 768 dims (see store.ts EMBED_DIMS), so only
// 768-dim models are allowed here. Each entry maps our stable model id (stored
// in the index metadata) to the `fastembed` EmbeddingModel enum key + dims.
// ---------------------------------------------------------------------------
const MODEL_DIMS: Readonly<Record<string, { enumKey: string; dims: number }>> = {
  'bge-base-en-v1.5': { enumKey: 'BGEBaseENV15', dims: 768 },
  'bge-base-en': { enumKey: 'BGEBaseEN', dims: 768 },
};

// Minimal shape of the parts of `fastembed` we use. Declared locally so this
// file type-checks even when the optional dependency isn't installed, and so a
// `fastembed` major bump can't silently change our contract.
interface FlagEmbeddingLike {
  passageEmbed(texts: string[], batchSize?: number): AsyncGenerator<number[][]>;
  queryEmbed(text: string): Promise<number[]>;
}
interface FastEmbedModule {
  FlagEmbedding: { init(options: { model: unknown; cacheDir?: string }): Promise<FlagEmbeddingLike> };
  EmbeddingModel: Record<string, unknown>;
}

export interface FastEmbedEmbedderOptions {
  /** Override the model (default: AGENT_SEARCH_EMBED_MODEL env or bge-base-en-v1.5). */
  model?: string;
  /** Where fastembed caches downloaded model files (default: FASTEMBED_CACHE_DIR env, else ~/.sift/fastembed). */
  cacheDir?: string;
}

export class FastEmbedEmbedder implements Embedder {
  readonly model: string;
  readonly dims: number;
  private readonly enumKey: string;
  private readonly cacheDir: string | undefined;
  // Lazily-initialised, single-flight model handle. The model name + dims are
  // known synchronously (the guard reads them before the first embed), but
  // loading the ONNX model is async and deferred until actually needed.
  private handle: Promise<FlagEmbeddingLike> | undefined;

  constructor(options?: FastEmbedEmbedderOptions) {
    this.model =
      options?.model ??
      process.env['AGENT_SEARCH_EMBED_MODEL'] ??
      'bge-base-en-v1.5';

    const entry = MODEL_DIMS[this.model];
    if (entry === undefined) {
      throw new Error(
        `FastEmbedEmbedder: unknown model "${this.model}" — no dims mapping. ` +
          `Known models: ${Object.keys(MODEL_DIMS).join(', ')}.`,
      );
    }
    this.dims = entry.dims;
    this.enumKey = entry.enumKey;
    // fastembed otherwise dumps a `local_cache/` into the current directory —
    // bad for a CLI run from anywhere. Keep model files alongside the index.
    this.cacheDir =
      options?.cacheDir ??
      process.env['FASTEMBED_CACHE_DIR'] ??
      join(homedir(), '.sift', 'fastembed');
  }

  private init(): Promise<FlagEmbeddingLike> {
    if (this.handle === undefined) {
      this.handle = (async () => {
        let mod: FastEmbedModule;
        try {
          mod = (await import('fastembed')) as unknown as FastEmbedModule;
        } catch (err) {
          throw new Error(
            `FastEmbedEmbedder: the "fastembed" package is not installed. ` +
              `Install it to use AGENT_SEARCH_EMBED_PROVIDER=fastembed:\n  npm install fastembed\n` +
              `Original error: ${String(err)}`,
          );
        }
        const modelEnum = mod.EmbeddingModel[this.enumKey];
        if (modelEnum === undefined) {
          throw new Error(
            `FastEmbedEmbedder: the installed "fastembed" has no EmbeddingModel.${this.enumKey} ` +
              `(for model "${this.model}"). It may be too old — try \`npm install fastembed@latest\`.`,
          );
        }
        return mod.FlagEmbedding.init({ model: modelEnum, cacheDir: this.cacheDir });
      })();
    }
    return this.handle;
  }

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    if (texts.length === 0) return [];

    const fe = await this.init();

    // fastembed applies the model-appropriate retrieval prefix itself, so use
    // its passage/query entry points rather than prefixing here.
    let out: number[][];
    if (kind === 'query') {
      out = await Promise.all(
        texts.map(async (t) => Array.from(await fe.queryEmbed(t))),
      );
    } else {
      out = [];
      for await (const batch of fe.passageEmbed(texts)) {
        for (const vec of batch) out.push(Array.from(vec));
      }
    }

    this.validate(out, texts.length);
    return out;
  }

  private validate(embeddings: number[][], expectedCount: number): void {
    if (embeddings.length !== expectedCount) {
      throw new Error(
        `FastEmbedEmbedder: expected ${expectedCount} embedding(s), got ${embeddings.length}. ` +
          `Model: ${this.model}.`,
      );
    }
    for (let i = 0; i < embeddings.length; i++) {
      const vec = embeddings[i];
      if (!Array.isArray(vec) || vec.length !== this.dims) {
        throw new Error(
          `FastEmbedEmbedder: embedding[${i}] has ${Array.isArray(vec) ? vec.length : 'non-array'} dims, ` +
            `expected ${this.dims} (model ${this.model}).`,
        );
      }
    }
  }
}
