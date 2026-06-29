import { describe, it, expect, vi, afterEach } from 'vitest';
import { FastEmbedEmbedder } from './fastembed.js';

/** 768-dim fake vector. */
function fakeVec(seed = 0.1): number[] {
  return Array<number>(768).fill(seed);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

// A controllable fake of the `fastembed` module. Each test sets the queryEmbed
// / passageEmbed behaviour it needs.
function mockFastembed(handle: {
  queryEmbed?: (q: string) => Promise<number[]>;
  passageEmbed?: (texts: string[]) => AsyncGenerator<number[][]>;
}) {
  const init = vi.fn().mockResolvedValue(handle);
  vi.doMock('fastembed', () => ({
    FlagEmbedding: { init },
    EmbeddingModel: { BGEBaseENV15: 'fast-bge-base-en-v1.5', BGEBaseEN: 'fast-bge-base-en' },
  }));
  return { init };
}

async function* oneBatch(vecs: number[][]): AsyncGenerator<number[][]> {
  yield vecs;
}

// ---------------------------------------------------------------------------
// properties
// ---------------------------------------------------------------------------

describe('FastEmbedEmbedder properties', () => {
  it('exposes model=bge-base-en-v1.5 and dims=768 by default', () => {
    const e = new FastEmbedEmbedder();
    expect(e.model).toBe('bge-base-en-v1.5');
    expect(e.dims).toBe(768);
  });

  it('throws for an unknown model (no dims mapping)', () => {
    expect(() => new FastEmbedEmbedder({ model: 'unknown-xyz' })).toThrow(/unknown.*model|no dims/i);
  });

  it('reads the model from AGENT_SEARCH_EMBED_MODEL', () => {
    vi.stubEnv('AGENT_SEARCH_EMBED_MODEL', 'bge-base-en');
    const e = new FastEmbedEmbedder();
    expect(e.model).toBe('bge-base-en');
    expect(e.dims).toBe(768);
  });
});

// ---------------------------------------------------------------------------
// empty input short-circuit (must not load the model)
// ---------------------------------------------------------------------------

describe('empty input', () => {
  it('returns [] without initialising the model', async () => {
    const { init } = mockFastembed({});
    const e = new FastEmbedEmbedder();
    const result = await e.embed([], 'document');
    expect(result).toEqual([]);
    expect(init).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// document vs query routing
// ---------------------------------------------------------------------------

describe('document embedding', () => {
  it('uses passageEmbed and collects batches in order', async () => {
    const v1 = fakeVec(0.1);
    const v2 = fakeVec(0.2);
    mockFastembed({ passageEmbed: () => oneBatch([v1, v2]) });

    const e = new FastEmbedEmbedder();
    const out = await e.embed(['a', 'b'], 'document');
    expect(out).toEqual([v1, v2]);
  });
});

describe('query embedding', () => {
  it('uses queryEmbed for each text, preserving order', async () => {
    const queryEmbed = vi.fn(async (q: string) => (q === 'first' ? fakeVec(0.1) : fakeVec(0.2)));
    mockFastembed({ queryEmbed });

    const e = new FastEmbedEmbedder();
    const out = await e.embed(['first', 'second'], 'query');
    expect(queryEmbed).toHaveBeenCalledTimes(2);
    expect(out).toEqual([fakeVec(0.1), fakeVec(0.2)]);
  });
});

// ---------------------------------------------------------------------------
// single-flight init
// ---------------------------------------------------------------------------

describe('lazy single-flight init', () => {
  it('initialises the model once across multiple embed calls', async () => {
    const { init } = mockFastembed({ passageEmbed: () => oneBatch([fakeVec()]) });
    const e = new FastEmbedEmbedder();
    await e.embed(['a'], 'document');
    await e.embed(['b'], 'document');
    expect(init).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

describe('response validation: wrong dims', () => {
  it('throws when a vector has the wrong number of dims', async () => {
    mockFastembed({ passageEmbed: () => oneBatch([[1, 2, 3]]) });
    const e = new FastEmbedEmbedder();
    await expect(e.embed(['text'], 'document')).rejects.toThrow(/dims|dimension/i);
  });
});

describe('response validation: wrong count', () => {
  it('throws when fewer embeddings come back than inputs', async () => {
    mockFastembed({ passageEmbed: () => oneBatch([fakeVec()]) });
    const e = new FastEmbedEmbedder();
    await expect(e.embed(['a', 'b'], 'document')).rejects.toThrow(/expected 2.*got 1|count/i);
  });
});

// ---------------------------------------------------------------------------
// missing package
// ---------------------------------------------------------------------------

describe('missing fastembed package', () => {
  it('throws an actionable error pointing at npm install', async () => {
    vi.doMock('fastembed', () => {
      throw new Error("Cannot find module 'fastembed'");
    });
    const e = new FastEmbedEmbedder();
    const err = await e.embed(['text'], 'document').catch((x: unknown) => x);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/npm install fastembed/i);
  });
});
