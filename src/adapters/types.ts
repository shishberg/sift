import type { Chunk, JsonlAgentType } from '../types.js';

export interface ParseCtx {
  filePath: string;
  lineNumber: number;
}

export interface Adapter {
  agentType: JsonlAgentType;
  /** Absolute dir this adapter owns (expanded ~). */
  rootDir: string;
  /** True if this file path belongs to this agent. */
  claims(filePath: string): boolean;
  /** Parse one raw JSONL line into 0+ chunks. ctx carries filePath + lineNumber. */
  parseLine(line: string, ctx: ParseCtx): Chunk[];
  /**
   * Pull the session's working directory out of a single line, if this line
   * carries it (undefined otherwise). Different agents record it on different
   * record types — claude on every message, codex/pi on their first metadata line.
   */
  extractCwd(line: string): string | undefined;
}

export interface Registry {
  adapters: Adapter[];
  /** Returns the adapter that claims this file path, or undefined. */
  forFile(filePath: string): Adapter | undefined;
}
