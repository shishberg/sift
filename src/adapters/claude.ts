import os from 'os';
import path from 'path';
import type { Chunk } from '../types.js';
import type { Adapter, ParseCtx } from './types.js';
import { truncate, TOOL_ARGS_MAX, TOOL_RESULT_MAX } from '../text.js';
import { stripHarnessTags } from '../harness-tags.js';

/** Extract session id from file path: the stem of the filename (without .jsonl). */
function sessionIdFromPath(filePath: string): string {
  return path.basename(filePath, '.jsonl');
}

// Types we index; all others are skipped.
const INDEXED_TYPES = new Set(['user', 'assistant']);

export class ClaudeAdapter implements Adapter {
  readonly agentType = 'claude' as const;
  // Session id, normal records: prefer the `sessionId` field; fall back to the
  // filename stem (which IS the session id for claude, e.g. <sessionId>.jsonl).
  //
  // Sidechain records are different. Claude writes each subagent's transcript to
  // <project>/<parentSessionId>/subagents/agent-<agentId>.jsonl, and every line
  // there carries `sessionId` = the PARENT session id. That field is a
  // cross-reference to the parent, not this transcript's own id — keying by it
  // would fold the whole subagent log into the parent session. So for sidechain
  // records we key by the filename stem (agent-<agentId>), giving each subagent
  // its own session.
  readonly rootDir: string;

  constructor() {
    this.rootDir = path.join(os.homedir(), '.claude', 'projects');
  }

  claims(filePath: string): boolean {
    return filePath.startsWith(this.rootDir + path.sep) || filePath.startsWith(this.rootDir + '/');
  }

  // Claude records `cwd` at the top level of every message record.
  extractCwd(line: string): string | undefined {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
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

    const type = record['type'];
    if (!INDEXED_TYPES.has(type as string)) return [];

    // Post-compaction summary records are `type: 'user'` but machine-generated
    // recaps, not real user turns. Skip indexing: they duplicate content already
    // in the log and are synthetic. (Still rendered as a collapsible block.)
    if (record['isCompactSummary'] === true) return [];

    const timestamp = (record['timestamp'] as string | undefined) ?? '';
    // Session id: sidechain (subagent) records key by their own file's stem, since
    // their `sessionId` field points at the parent. All other records prefer the
    // `sessionId` field and fall back to the filename stem. See the class comment.
    const sessionId =
      record['isSidechain'] === true
        ? sessionIdFromPath(ctx.filePath)
        : ((record['sessionId'] as string | undefined) ?? sessionIdFromPath(ctx.filePath));
    const filePath = ctx.filePath;
    const lineNumber = ctx.lineNumber;
    const agentType = this.agentType;

    const message = record['message'] as { role: string; content: unknown } | undefined;
    if (!message) return [];

    const role = message.role as 'user' | 'assistant';
    const content = message.content;

    // String content → single text chunk.
    if (typeof content === 'string') {
      const text = role === 'user' ? stripHarnessTags(content) : content;
      if (!text) return [];
      return [{ agentType, sessionId, filePath, lineNumber, role, text, timestamp }];
    }

    if (!Array.isArray(content)) return [];

    const chunks: Chunk[] = [];
    for (const block of content as Record<string, unknown>[]) {
      const blockType = block['type'] as string;

      if (blockType === 'text') {
        const raw = (block['text'] as string | undefined) ?? '';
        const text = role === 'user' ? stripHarnessTags(raw) : raw;
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
