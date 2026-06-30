import { describe, it, expect, vi, afterEach } from 'vitest';
import { TransformersEmbedder } from './transformers.js';

function fakeVec(seed = 0.1): number[] {
  return Array<number>(768).fill(seed);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

// A controllable fake of @huggingface/transformers. The returned `env` object
// is observable so tests can assert local-only wiring.
function mockTransformers(extract: (texts: string[], opts: unknown) => Promise<{ tolist(): number[][] }>) {
  const env = { allowRemoteModels: true, localModelPath: '', cacheDir: '' };
  const pipeline = vi.fn().mockResolvedValue(extract);
  vi.doMock('@huggingface/transformers', () => ({ pipeline, env }));
  return { pipeline, env };
}

const out = (vecs: number[][]) => ({ tolist: () => vecs });

// ---------------------------------------------------------------------------
// properties
// ---------------------------------------------------------------------------

describe('TransformersEmbedder properties', () => {
  it('exposes a bge model id and dims=768 by default', () => {
    const e = new TransformersEmbedder();
    expect(e.model).toBe('xenova/bge-base-en-v1.5');
    expect(e.dims).toBe(768);
  });

  it('uses an id distinct from the fastembed model id (forces reindex on switch)', () => {
    expect(new TransformersEmbedder().model).not.toBe('bge-base-en-v1.5');
  });

  it('throws for an unknown model', () => {
    expect(() => new TransformersEmbedder({ model: 'nope' })).toThrow(/unknown.*model|no dims/i);
  });
});

// ---------------------------------------------------------------------------
// empty input
// ---------------------------------------------------------------------------

describe('empty input', () => {
  it('returns [] without loading the pipeline', async () => {
    const { pipeline } = mockTransformers(async () => out([]));
    const e = new TransformersEmbedder();
    expect(await e.embed([], 'document')).toEqual([]);
    expect(pipeline).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// device + pipeline wiring
// ---------------------------------------------------------------------------

describe('pipeline wiring', () => {
  it('builds a feature-extraction pipeline for the bge model', async () => {
    const { pipeline } = mockTransformers(async () => out([fakeVec()]));
    const e = new TransformersEmbedder({ device: 'cpu' });
    await e.embed(['hi'], 'document');
    const [task, model] = pipeline.mock.calls[0] as [string, string, unknown];
    expect(task).toBe('feature-extraction');
    expect(model).toBe('Xenova/bge-base-en-v1.5');
  });

  it('falls back to cpu when webgpu is requested but no navigator.gpu exists', async () => {
    // Default device is webgpu; the test runtime has no WebGPU.
    const { pipeline } = mockTransformers(async () => out([fakeVec()]));
    const e = new TransformersEmbedder();
    await e.embed(['hi'], 'document');
    const [, , opts] = pipeline.mock.calls[0] as [string, string, { device: string }];
    expect(opts.device).toBe('cpu');
  });

  it('passes webgpu through when a WebGPU runtime is present', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const { pipeline } = mockTransformers(async () => out([fakeVec()]));
    const e = new TransformersEmbedder();
    await e.embed(['hi'], 'document');
    const [, , opts] = pipeline.mock.calls[0] as [string, string, { device: string }];
    expect(opts.device).toBe('webgpu');
  });

  it('honours an explicit device override', async () => {
    const { pipeline } = mockTransformers(async () => out([fakeVec()]));
    const e = new TransformersEmbedder({ device: 'dml' });
    await e.embed(['hi'], 'document');
    const [, , opts] = pipeline.mock.calls[0] as [string, string, { device: string }];
    expect(opts.device).toBe('dml');
  });
});

// ---------------------------------------------------------------------------
// query instruction prefix
// ---------------------------------------------------------------------------

describe('query instruction', () => {
  it('prefixes the bge retrieval instruction onto queries, not documents', async () => {
    let seen: string[] = [];
    mockTransformers(async (texts) => {
      seen = texts;
      return out(texts.map(() => fakeVec()));
    });
    const e = new TransformersEmbedder({ device: 'cpu' });

    await e.embed(['find me'], 'query');
    expect(seen[0]).toMatch(/^Represent this sentence for searching relevant passages: find me$/);

    await e.embed(['a doc'], 'document');
    expect(seen[0]).toBe('a doc');
  });
});

// ---------------------------------------------------------------------------
// local-only
// ---------------------------------------------------------------------------

describe('local-only mode', () => {
  it('disables remote models and points at the model dir', async () => {
    const { env } = mockTransformers(async () => out([fakeVec()]));
    const e = new TransformersEmbedder({ device: 'cpu', modelPath: '/models/bge' });
    await e.embed(['hi'], 'document');
    expect(env.allowRemoteModels).toBe(false);
    expect(env.localModelPath).toBe('/models/bge');
  });

  it('allows remote models by default', async () => {
    const { env } = mockTransformers(async () => out([fakeVec()]));
    const e = new TransformersEmbedder({ device: 'cpu' });
    await e.embed(['hi'], 'document');
    expect(env.allowRemoteModels).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validation + missing package
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('throws on wrong dims', async () => {
    mockTransformers(async () => out([[1, 2, 3]]));
    const e = new TransformersEmbedder({ device: 'cpu' });
    await expect(e.embed(['x'], 'document')).rejects.toThrow(/dims|dimension/i);
  });
});

describe('missing package', () => {
  it('throws an actionable error pointing at npm install', async () => {
    vi.doMock('@huggingface/transformers', () => {
      throw new Error("Cannot find module '@huggingface/transformers'");
    });
    const e = new TransformersEmbedder({ device: 'cpu' });
    const err = await e.embed(['x'], 'document').catch((x: unknown) => x);
    expect((err as Error).message).toMatch(/npm install @huggingface\/transformers/i);
  });
});
