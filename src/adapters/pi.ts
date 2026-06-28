import os from 'os';
import path from 'path';
import type { Chunk } from '../types.js';
import type { Adapter, ParseCtx } from './types.js';
import { truncate, TOOL_ARGS_MAX, TOOL_RESULT_MAX } from '../text.js';

/**
 * Derive the pi session id from the filename.
 *
 * Pi filenames have the form: <ISO-timestamp>_<uuid>.jsonl
 * The `session` record also carries an `id` field, but parseLine processes lines
 * in isolation so we always derive from the filename — the id after the last '_'.
 * Both values are identical in practice.
 */
function sessionIdFromPath(filePath: string): string {
  const stem = path.basename(filePath, '.jsonl');
  const idx = stem.lastIndexOf('_');
  return idx >= 0 ? stem.slice(idx + 1) : stem;
}

// Record types we index; all others are skipped.
const INDEXED_TYPES = new Set(['message']);

export class PiAdapter implements Adapter {
  readonly agentType = 'pi' as const;
  readonly rootDir: string;

  constructor() {
    this.rootDir = path.join(os.homedir(), '.pi', 'agent', 'sessions');
  }

  claims(filePath: string): boolean {
    return filePath.startsWith(this.rootDir + path.sep) || filePath.startsWith(this.rootDir + '/');
  }

  // Pi records `cwd` once, on the `session` record (first line).
  extractCwd(line: string): string | undefined {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record['type'] !== 'session') return undefined;
      const cwd = record['cwd'];
      return typeof cwd === 'string' ? cwd : undefined;
    } catch {
      return undefined;
    }
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

    const type = record['type'] as string | undefined;
    if (!type || !INDEXED_TYPES.has(type)) return [];

    const timestamp = (record['timestamp'] as string | undefined) ?? '';
    const sessionId = sessionIdFromPath(ctx.filePath);
    const filePath = ctx.filePath;
    const lineNumber = ctx.lineNumber;
    const agentType = this.agentType;

    const message = record['message'] as Record<string, unknown> | undefined;
    if (!message) return [];

    const role = message['role'] as string | undefined;
    if (!role) return [];

    // toolResult messages: content blocks are all text → role tool, FTS-only.
    if (role === 'toolResult') {
      const content = message['content'] as Record<string, unknown>[] | undefined;
      const text = Array.isArray(content)
        ? content
            .filter((b) => b['type'] === 'text')
            .map((b) => b['text'] as string)
            .join('\n')
        : '';
      return [{ agentType, sessionId, filePath, lineNumber, role: 'tool', text: truncate(text, TOOL_RESULT_MAX), timestamp }];
    }

    if (role !== 'user' && role !== 'assistant') return [];

    const content = message['content'] as Record<string, unknown>[] | undefined;
    if (!Array.isArray(content)) return [];

    const chunks: Chunk[] = [];
    for (const block of content) {
      const blockType = block['type'] as string | undefined;

      if (blockType === 'text') {
        const text = (block['text'] as string | undefined) ?? '';
        if (text) {
          chunks.push({ agentType, sessionId, filePath, lineNumber, role: role as 'user' | 'assistant', text, timestamp });
        }
      } else if (blockType === 'thinking') {
        // Skip thinking blocks per spec.
        continue;
      } else if (blockType === 'toolCall') {
        const name = (block['name'] as string | undefined) ?? '';
        const rawArgs = block['arguments'];
        const argsStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
        const args = truncate(argsStr, TOOL_ARGS_MAX);
        chunks.push({ agentType, sessionId, filePath, lineNumber, role: 'tool', text: '', toolCall: { name, args }, timestamp });
      }
    }

    return chunks;
  }
}
