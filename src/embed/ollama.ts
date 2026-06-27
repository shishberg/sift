import type { Embedder } from './types.js';

// ---------------------------------------------------------------------------
// Supported models and their embedding dimensions.
// Add entries here when adding new models; dims are not negotiable (sqlite-vec
// schema depends on a fixed vector size per index).
// ---------------------------------------------------------------------------
const MODEL_DIMS: Readonly<Record<string, number>> = {
  'nomic-embed-text': 768,
};

export interface OllamaEmbedderOptions {
  /** Override the base URL (default: OLLAMA_BASE_URL env or http://localhost:11434). */
  baseUrl?: string;
  /** Override the model (default: AGENT_SEARCH_EMBED_MODEL env or nomic-embed-text). */
  model?: string;
}

// ---------------------------------------------------------------------------
// Shape of the /api/embed response.
// ---------------------------------------------------------------------------
interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
}

// ---------------------------------------------------------------------------
// OllamaEmbedder
// ---------------------------------------------------------------------------

export class OllamaEmbedder implements Embedder {
  readonly model: string;
  readonly dims: number;
  private readonly baseUrl: string;

  constructor(options?: OllamaEmbedderOptions) {
    this.model =
      options?.model ??
      process.env['AGENT_SEARCH_EMBED_MODEL'] ??
      'nomic-embed-text';

    const dims = MODEL_DIMS[this.model];
    if (dims === undefined) {
      throw new Error(
        `OllamaEmbedder: unknown model "${this.model}" — no dims mapping. ` +
          `Known models: ${Object.keys(MODEL_DIMS).join(', ')}.`,
      );
    }
    this.dims = dims;

    this.baseUrl =
      options?.baseUrl ??
      process.env['OLLAMA_BASE_URL'] ??
      'http://localhost:11434';
  }

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    if (texts.length === 0) return [];

    const prefix = kind === 'document' ? 'search_document: ' : 'search_query: ';
    const input = texts.map((t) => `${prefix}${t}`);
    const url = `${this.baseUrl}/api/embed`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input }),
      });
    } catch (err) {
      throw new Error(
        `OllamaEmbedder: cannot reach ollama at ${this.baseUrl}. ` +
          `Make sure ollama is running (e.g. \`ollama serve\`). ` +
          `Original error: ${String(err)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(no body)');
      throw new Error(
        `OllamaEmbedder: ollama returned HTTP ${response.status} from ${url}. ` +
          `Response: ${body}`,
      );
    }

    const data = (await response.json()) as OllamaEmbedResponse;
    this.validate(data, input.length);
    return data.embeddings;
  }

  private validate(data: OllamaEmbedResponse, expectedCount: number): void {
    if (!Array.isArray(data.embeddings)) {
      throw new Error(
        `OllamaEmbedder: response from ${this.baseUrl}/api/embed is missing "embeddings" array. ` +
          `Got: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    if (data.embeddings.length !== expectedCount) {
      throw new Error(
        `OllamaEmbedder: expected ${expectedCount} embedding(s) from ${this.baseUrl}/api/embed, ` +
          `got ${data.embeddings.length}. Model: ${this.model}.`,
      );
    }
    for (let i = 0; i < data.embeddings.length; i++) {
      const vec = data.embeddings[i];
      if (!Array.isArray(vec) || vec.length !== this.dims) {
        throw new Error(
          `OllamaEmbedder: embedding[${i}] has ${Array.isArray(vec) ? vec.length : 'non-array'} dims, ` +
            `expected ${this.dims} (model ${this.model}).`,
        );
      }
    }
  }
}
