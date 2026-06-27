import os from 'os';
import path from 'path';
import type { Chunk } from '../types.js';
import type { Adapter, ParseCtx } from './types.js';

// Truncation limits per spec.
const TOOL_ARGS_MAX = 200;
const TOOL_RESULT_MAX = 500;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

/** Extract session id from file path: the stem of the filename (without .jsonl). */
function sessionIdFromPath(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

// Types we index; all others are skipped.
const INDEXED_TYPES = new Set(['user', 'assistant']);

export class ClaudeAdapter implements Adapter {
  readonly agentType = 'claude' as const;
  // Session id: prefer the `sessionId` field on the record; fall back to filename stem.
  // The filename stem IS the session id for claude (e.g. <sessionId>.jsonl), so either
  // path works — but we prefer the record field in case it differs.
  readonly rootDir: string;

  constructor() {
    this.rootDir = path.join(os.homedir(), '.claude', 'projects');
  }

  claims(filePath: string): boolean {
    return filePath.startsWith(this.rootDir + path.sep) || filePath.startsWith(this.rootDir + '/');
  }

  parseLine(line: string, ctx: ParseCtx): Chunk[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return [];
    }

    const type = record['type'];
    if (!INDEXED_TYPES.has(type as string)) return [];

    const timestamp = (record['timestamp'] as string | undefined) ?? '';
    // Session id: prefer field on record, fall back to filename stem.
    const sessionId = (record['sessionId'] as string | undefined) ?? sessionIdFromPath(ctx.filePath);
    const filePath = ctx.filePath;
    const lineNumber = ctx.lineNumber;
    const agentType = this.agentType;

    const message = record['message'] as { role: string; content: unknown } | undefined;
    if (!message) return [];

    const role = message.role as 'user' | 'assistant';
    const content = message.content;

    // String content → single text chunk.
    if (typeof content === 'string') {
      return [{ agentType, sessionId, filePath, lineNumber, role, text: content, timestamp }];
    }

    if (!Array.isArray(content)) return [];

    const chunks: Chunk[] = [];
    for (const block of content as Record<string, unknown>[]) {
      const blockType = block['type'] as string;

      if (blockType === 'text') {
        const text = (block['text'] as string | undefined) ?? '';
        if (text) {
          chunks.push({ agentType, sessionId, filePath, lineNumber, role, text, timestamp });
        }
      } else if (blockType === 'thinking') {
        // Skip thinking blocks per spec.
        continue;
      } else if (blockType === 'tool_use') {
        const name = (block['name'] as string | undefined) ?? '';
        const input = block['input'];
        const rawArgs = typeof input === 'string' ? input : JSON.stringify(input ?? {});
        const args = truncate(rawArgs, TOOL_ARGS_MAX);
        chunks.push({ agentType, sessionId, filePath, lineNumber, role: 'tool', text: '', toolCall: { name, args }, timestamp });
      } else if (blockType === 'tool_result') {
        // Tool results appear in user messages; FTS-only (role tool, no embedding).
        const resultContent = block['content'];
        let text = '';
        if (typeof resultContent === 'string') {
          text = resultContent;
        } else if (Array.isArray(resultContent)) {
          text = (resultContent as Record<string, unknown>[])
            .filter((b) => b['type'] === 'text')
            .map((b) => b['text'] as string)
            .join('\n');
        }
        chunks.push({ agentType, sessionId, filePath, lineNumber, role: 'tool', text: truncate(text, TOOL_RESULT_MAX), timestamp });
      }
    }

    return chunks;
  }
}
