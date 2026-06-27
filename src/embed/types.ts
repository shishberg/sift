export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}
