import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Embedder } from './types.js';

// ---------------------------------------------------------------------------
// TransformersEmbedder — in-process local embeddings via @huggingface/transformers
// (transformers.js), with `device: 'webgpu'` by default for GPU acceleration.
//
// WebGPU is the in-process GPU path: in a browser/Electron renderer (or a
// WebGPU-enabled Node runtime) this runs on the GPU. Plain Node has no
// `navigator.gpu`, so transformers.js falls back to CPU (onnxruntime-node) —
// we warn once when that happens. Either way it is LOCAL only; no cloud API.
//
// `localOnly` (with an optional model directory) forbids any network fetch:
// transformers.js loads the model from disk only. Use it on air-gapped boxes
// or to pin a vetted local copy.
//
// 768-dim models only — the sqlite-vec schema is fixed (store.ts EMBED_DIMS).
// ---------------------------------------------------------------------------
const MODEL_DIMS: Readonly<
  Record<string, { hfId: string; dims: number; queryInstruction: string }>
> = {
  // bge-base-en-v1.5 recommends a query instruction for retrieval and CLS
  // pooling; passages are embedded with no prefix.
  'bge-base-en-v1.5': {
    hfId: 'Xenova/bge-base-en-v1.5',
    dims: 768,
    queryInstruction: 'Represent this sentence for searching relevant passages: ',
  },
};

// Minimal shapes of what we use from @huggingface/transformers, declared
// locally so this file type-checks without the optional dependency present.
interface ExtractorOutput {
  tolist(): number[][];
}
type FeatureExtractor = (
  texts: string[],
  opts: { pooling: 'cls' | 'mean' | 'none'; normalize: boolean },
) => Promise<ExtractorOutput>;
interface TransformersModule {
  pipeline(
    task: 'feature-extraction',
    model: string,
    opts: { device?: string; dtype?: string },
  ): Promise<FeatureExtractor>;
  env: {
    allowRemoteModels: boolean;
    localModelPath: string;
    cacheDir: string;
  };
}

export interface TransformersEmbedderOptions {
  /** Model key (default: AGENT_SEARCH_EMBED_MODEL env or bge-base-en-v1.5). */
  model?: string;
  /** Execution device (default: AGENT_SEARCH_TRANSFORMERS_DEVICE env or "webgpu"). */
  device?: string;
  /** Weight dtype (default: AGENT_SEARCH_TRANSFORMERS_DTYPE env or "fp32"). */
  dtype?: string;
  /** Forbid any network fetch — load the model from disk only (default: AGENT_SEARCH_TRANSFORMERS_LOCAL_ONLY truthy). */
  localOnly?: boolean;
  /** Base directory holding the local model (default: AGENT_SEARCH_TRANSFORMERS_MODEL_PATH env). Implies localOnly. */
  modelPath?: string;
  /** Where to cache downloaded models (default: AGENT_SEARCH_TRANSFORMERS_CACHE env or ~/.sift/transformers). */
  cacheDir?: string;
}

function envTruthy(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

export class TransformersEmbedder implements Embedder {
  readonly model: string;
  readonly dims: number;
  private readonly hfId: string;
  private readonly queryInstruction: string;
  private readonly device: string;
  private readonly dtype: string;
  private readonly localOnly: boolean;
  private readonly modelPath: string | undefined;
  private readonly cacheDir: string;
  private extractor: Promise<FeatureExtractor> | undefined;
  private warnedFallback = false;

  constructor(options?: TransformersEmbedderOptions) {
    const key =
      options?.model ??
      process.env['AGENT_SEARCH_EMBED_MODEL'] ??
      'bge-base-en-v1.5';

    const entry = MODEL_DIMS[key];
    if (entry === undefined) {
      throw new Error(
        `TransformersEmbedder: unknown model "${key}" — no dims mapping. ` +
          `Known models: ${Object.keys(MODEL_DIMS).join(', ')}.`,
      );
    }
    this.hfId = entry.hfId;
    this.dims = entry.dims;
    this.queryInstruction = entry.queryInstruction;
    // Stored model id — distinct from the fastembed/ollama ids so the embed
    // guard forces a reindex when switching providers.
    this.model = entry.hfId.toLowerCase();

    this.device =
      options?.device ?? process.env['AGENT_SEARCH_TRANSFORMERS_DEVICE'] ?? 'webgpu';
    this.dtype =
      options?.dtype ?? process.env['AGENT_SEARCH_TRANSFORMERS_DTYPE'] ?? 'fp32';
    this.modelPath =
      options?.modelPath ?? process.env['AGENT_SEARCH_TRANSFORMERS_MODEL_PATH'];
    this.localOnly =
      options?.localOnly ??
      (this.modelPath !== undefined ||
        envTruthy(process.env['AGENT_SEARCH_TRANSFORMERS_LOCAL_ONLY']));
    this.cacheDir =
      options?.cacheDir ??
      process.env['AGENT_SEARCH_TRANSFORMERS_CACHE'] ??
      join(homedir(), '.sift', 'transformers');
  }

  private init(): Promise<FeatureExtractor> {
    if (this.extractor === undefined) {
      this.extractor = (async () => {
        let mod: TransformersModule;
        try {
          mod = (await import('@huggingface/transformers')) as unknown as TransformersModule;
        } catch (err) {
          throw new Error(
            `TransformersEmbedder: the "@huggingface/transformers" package is not installed. ` +
              `Install it to use AGENT_SEARCH_EMBED_PROVIDER=transformers:\n` +
              `  npm install @huggingface/transformers\n` +
              `Original error: ${String(err)}`,
          );
        }

        if (this.localOnly) {
          mod.env.allowRemoteModels = false;
          if (this.modelPath !== undefined) mod.env.localModelPath = this.modelPath;
        } else {
          mod.env.cacheDir = this.cacheDir;
        }

        // WebGPU needs a browser-like environment; warn (once) when Node will
        // fall back so a "slow" run isn't a mystery.
        if (
          this.device === 'webgpu' &&
          !this.warnedFallback &&
          (typeof navigator === 'undefined' ||
            (navigator as { gpu?: unknown }).gpu === undefined)
        ) {
          this.warnedFallback = true;
          console.error(
            'TransformersEmbedder: device "webgpu" requested but no WebGPU runtime ' +
              '(navigator.gpu) is available — transformers.js will fall back to CPU. ' +
              'Set AGENT_SEARCH_TRANSFORMERS_DEVICE=cpu to silence this, or run under a ' +
              'WebGPU-capable runtime (browser/Electron) for GPU acceleration.',
          );
        }

        return mod.pipeline('feature-extraction', this.hfId, {
          device: this.device,
          dtype: this.dtype,
        });
      })();
    }
    return this.extractor;
  }

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    if (texts.length === 0) return [];

    const extract = await this.init();
    const inputs =
      kind === 'query' ? texts.map((t) => this.queryInstruction + t) : texts;

    const output = await extract(inputs, { pooling: 'cls', normalize: true });
    const vecs = output.tolist();

    this.validate(vecs, texts.length);
    return vecs;
  }

  private validate(embeddings: number[][], expectedCount: number): void {
    if (embeddings.length !== expectedCount) {
      throw new Error(
        `TransformersEmbedder: expected ${expectedCount} embedding(s), got ${embeddings.length}. ` +
          `Model: ${this.model}.`,
      );
    }
    for (let i = 0; i < embeddings.length; i++) {
      const vec = embeddings[i];
      if (!Array.isArray(vec) || vec.length !== this.dims) {
        throw new Error(
          `TransformersEmbedder: embedding[${i}] has ${Array.isArray(vec) ? vec.length : 'non-array'} dims, ` +
            `expected ${this.dims} (model ${this.model}).`,
        );
      }
    }
  }
}
