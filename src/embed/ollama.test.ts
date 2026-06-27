import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaEmbedder } from './ollama.js';

/** 768-dimensional fake vector for mocking ollama responses. */
function fakeVec(): number[] {
  return Array<number>(768).fill(0.1);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// properties
// ---------------------------------------------------------------------------

describe('OllamaEmbedder properties', () => {
  it('exposes model=nomic-embed-text and dims=768 by default', () => {
    const e = new OllamaEmbedder();
    expect(e.model).toBe('nomic-embed-text');
    expect(e.dims).toBe(768);
  });
});

// ---------------------------------------------------------------------------
// empty input short-circuit
// ---------------------------------------------------------------------------

describe('empty input', () => {
  it('returns [] without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const e = new OllamaEmbedder();
    const result = await e.embed([], 'document');
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// task prefixes
// ---------------------------------------------------------------------------

describe('document prefix', () => {
  it('prefixes every text with "search_document: "', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [fakeVec(), fakeVec()] }),
    }));

    const e = new OllamaEmbedder();
    await e.embed(['hello', 'world'], 'document');

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string) as { model: string; input: string[] };
    expect(body.input).toEqual(['search_document: hello', 'search_document: world']);
  });
});

describe('query prefix', () => {
  it('prefixes every text with "search_query: "', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [fakeVec()] }),
    }));

    const e = new OllamaEmbedder();
    await e.embed(['find me'], 'query');

    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string) as { model: string; input: string[] };
    expect(body.input).toEqual(['search_query: find me']);
  });
});

// ---------------------------------------------------------------------------
// request shape
// ---------------------------------------------------------------------------

describe('HTTP request shape', () => {
  it('POSTs to /api/embed with model and prefixed input', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [fakeVec()] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const e = new OllamaEmbedder();
    await e.embed(['sample text'], 'document');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/embed');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as { model: string; input: string[] };
    expect(body.model).toBe('nomic-embed-text');
    expect(body.input).toEqual(['search_document: sample text']);
  });
});

// ---------------------------------------------------------------------------
// order preservation
// ---------------------------------------------------------------------------

describe('order preservation', () => {
  it('returns embeddings in the same order as inputs', async () => {
    // Use distinct values per vector so we can verify order is preserved
    const v1 = fakeVec().map((_, i) => i === 0 ? 0.1 : 0);
    const v2 = fakeVec().map((_, i) => i === 0 ? 0.2 : 0);
    const v3 = fakeVec().map((_, i) => i === 0 ? 0.3 : 0);
    const embeddings = [v1, v2, v3];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings }),
    }));

    const e = new OllamaEmbedder();
    const result = await e.embed(['a', 'b', 'c'], 'document');

    expect(result).toEqual(embeddings);
  });
});

// ---------------------------------------------------------------------------
// error handling
// ---------------------------------------------------------------------------

describe('error: ollama unreachable', () => {
  it('throws with message naming ollama, the base URL, and the hint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const e = new OllamaEmbedder();
    const err = await e.embed(['text'], 'document').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/ollama/i);
    expect(msg).toContain('http://localhost:11434');
    expect(msg).toContain('ollama serve');
    expect(msg).toContain('fetch failed');
  });
});

describe('error: non-OK HTTP response', () => {
  it('throws with the status code, URL, and response body in the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    }));

    const e = new OllamaEmbedder();
    const err = await e.embed(['text'], 'document').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('503');
    expect(msg).toContain('http://localhost:11434/api/embed');
    expect(msg).toContain('Service Unavailable');
  });
});

// ---------------------------------------------------------------------------
// env / constructor overrides
// ---------------------------------------------------------------------------

describe('baseUrl override via constructor', () => {
  it('uses a custom base URL passed at construction', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [fakeVec()] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const e = new OllamaEmbedder({ baseUrl: 'http://myhost:9999' });
    await e.embed(['text'], 'document');

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://myhost:9999/api/embed');
  });
});

describe('model override via constructor', () => {
  it('throws for an unknown model (no dims mapping)', () => {
    expect(() => new OllamaEmbedder({ model: 'unknown-model-xyz' })).toThrow(/unknown.*model|no dims/i);
  });
});

// ---------------------------------------------------------------------------
// response validation
// ---------------------------------------------------------------------------

describe('response validation: wrong number of embeddings', () => {
  it('throws when ollama returns fewer embeddings than inputs', async () => {
    // Ask for 3 texts, only get 2 back — ollama API bug / version mismatch
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2], [3, 4]] }),
    }));

    const e = new OllamaEmbedder();
    await expect(e.embed(['a', 'b', 'c'], 'document')).rejects.toThrow(/expected 3.*got 2|count mismatch/i);
  });
});

describe('response validation: wrong embedding dimensions', () => {
  it('throws when a vector has wrong dims', async () => {
    // Return a 3-dimensional vector instead of 768
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3]] }),
    }));

    const e = new OllamaEmbedder();
    await expect(e.embed(['text'], 'document')).rejects.toThrow(/dims|dimension/i);
  });
});

describe('response validation: missing embeddings key', () => {
  it('throws when embeddings key is absent from response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ model: 'nomic-embed-text' }),
    }));

    const e = new OllamaEmbedder();
    await expect(e.embed(['text'], 'document')).rejects.toThrow(/embeddings/i);
  });
});
