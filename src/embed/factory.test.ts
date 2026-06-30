import { describe, it, expect, afterEach, vi } from 'vitest';
import { createEmbedder } from './factory.js';
import { OllamaEmbedder } from './ollama.js';
import { FastEmbedEmbedder } from './fastembed.js';
import { TransformersEmbedder } from './transformers.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createEmbedder', () => {
  it('defaults to the ollama embedder', () => {
    expect(createEmbedder()).toBeInstanceOf(OllamaEmbedder);
  });

  it('builds an ollama embedder when AGENT_SEARCH_EMBED_PROVIDER=ollama', () => {
    vi.stubEnv('AGENT_SEARCH_EMBED_PROVIDER', 'ollama');
    expect(createEmbedder()).toBeInstanceOf(OllamaEmbedder);
  });

  it('builds a fastembed embedder when AGENT_SEARCH_EMBED_PROVIDER=fastembed', () => {
    vi.stubEnv('AGENT_SEARCH_EMBED_PROVIDER', 'fastembed');
    expect(createEmbedder()).toBeInstanceOf(FastEmbedEmbedder);
  });

  it('builds a transformers embedder when AGENT_SEARCH_EMBED_PROVIDER=transformers', () => {
    vi.stubEnv('AGENT_SEARCH_EMBED_PROVIDER', 'transformers');
    expect(createEmbedder()).toBeInstanceOf(TransformersEmbedder);
  });

  it('is case-insensitive on the provider name', () => {
    vi.stubEnv('AGENT_SEARCH_EMBED_PROVIDER', 'FastEmbed');
    expect(createEmbedder()).toBeInstanceOf(FastEmbedEmbedder);
  });

  it('throws on an unknown provider', () => {
    vi.stubEnv('AGENT_SEARCH_EMBED_PROVIDER', 'openai');
    expect(() => createEmbedder()).toThrow(/unknown embed provider.*openai/i);
  });
});
