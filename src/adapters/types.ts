import type { Chunk } from '../types.js';

export interface ParseCtx {
  filePath: string;
  lineNumber: number;
}

export interface Adapter {
  agentType: 'claude' | 'codex' | 'pi';
  /** Absolute dir this adapter owns (expanded ~). */
  rootDir: string;
  /** True if this file path belongs to this agent. */
  claims(filePath: string): boolean;
  /** Parse one raw JSONL line into 0+ chunks. ctx carries filePath + lineNumber. */
  parseLine(line: string, ctx: ParseCtx): Chunk[];
}

export interface Registry {
  adapters: Adapter[];
  /** Returns the adapter that claims this file path, or undefined. */
  forFile(filePath: string): Adapter | undefined;
}
