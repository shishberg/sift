import os from 'os';
import path from 'path';
import type { Chunk } from '../types.js';
import type { Adapter, ParseCtx } from './types.js';
import { truncate, TOOL_ARGS_MAX, TOOL_RESULT_MAX } from '../text.js';
import { stripHarnessTags } from '../harness-tags.js';

/**
 * Derive the codex session id from the filename.
 *
 * Codex filenames have the form: rollout-<YYYY-MM-DDTHH-MM-SS>-<uuid>.jsonl
 * The session id (a UUID, 36 chars including hyphens) is always the last segment.
 * The `session_meta` record also carries `payload.id`, but since parseLine processes
 * one line at a time with no cross-line state, we always derive from the filename.
 * Both values are identical in practice.
 */
const UUID_AT_END = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionIdFromPath(filePath: string): string {
  const stem = path.basename(filePath, '.jsonl');
  // The id is the trailing UUID. Match it precisely; fall back to the last 36 chars
  // (a UUID's length) if the tail isn't a recognizable UUID.
  const match = stem.match(UUID_AT_END);
  return match ? match[0] : stem.slice(-36);
}

/**
 * Codex content arrives either as a plain string or as an array of typed blocks
 * (`input_text` / `output_text` / `input_image` / …). Both message content and a
 * `function_call_output`'s `output` use this shape — e.g. a `view_image` call's
 * output is `[{ type: 'input_image', image_url: 'data:…' }]`. Pull out the
 * natural-language text; non-text blocks (images) contribute nothing. Always
 * returns a string, so it is safe to store.
 */
function blocksToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return (value as Record<string, unknown>[])
    .filter((b) => b['type'] === 'input_text' || b['type'] === 'output_text')
    .map((b) => (typeof b['text'] === 'string' ? b['text'] : ''))
    .join('');
}

export class CodexAdapter implements Adapter {
  readonly agentType = 'codex' as const;
  readonly rootDir: string;

  constructor() {
    this.rootDir = path.join(os.homedir(), '.codex', 'sessions');
  }

  claims(filePath: string): boolean {
    return filePath.startsWith(this.rootDir + path.sep) || filePath.startsWith(this.rootDir + '/');
  }

  // Codex records `cwd` once, in the session_meta record's payload (first line).
  extractCwd(line: string): string | undefined {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record['type'] !== 'session_meta') return undefined;
      const payload = record['payload'] as Record<string, unknown> | undefined;
      const cwd = payload?.['cwd'];
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

    // Only response_item records carry indexed content. Everything else is skipped.
    if (type !== 'response_item') return [];

    const payload = record['payload'] as Record<string, unknown> | undefined;
    if (!payload) return [];

    const payloadType = payload['type'] as string | undefined;
    const timestamp = (record['timestamp'] as string | undefined) ?? '';
    const sessionId = sessionIdFromPath(ctx.filePath);
    const filePath = ctx.filePath;
    const lineNumber = ctx.lineNumber;
    const agentType = this.agentType;

    if (payloadType === 'message') {
      const role = payload['role'] as string | undefined;
      // Skip developer (system instructions) messages per spec.
      if (!role || role === 'developer') return [];
      if (role !== 'user' && role !== 'assistant') return [];

      // Concatenate input_text / output_text blocks (images and other block
      // types contribute nothing).
      const joined = blocksToText(payload['content']);
      // Strip codex's injected harness preamble from user turns.
      const text = role === 'user' ? stripHarnessTags(joined) : joined;
      if (!text) return [];

      return [{ agentType, sessionId, filePath, lineNumber, role: role as 'user' | 'assistant', text, timestamp }];
    }

    if (payloadType === 'function_call') {
      const name = (payload['name'] as string | undefined) ?? '';
      const rawArgs = (payload['arguments'] as string | undefined) ?? '';
      const args = truncate(rawArgs, TOOL_ARGS_MAX);
      return [{ agentType, sessionId, filePath, lineNumber, role: 'tool', text: '', toolCall: { name, args }, timestamp }];
    }

    if (payloadType === 'function_call_output') {
      // `output` is usually a string, but tools like view_image return an array
      // of content blocks (image data) — normalize either shape to text.
      const output = blocksToText(payload['output']);
      return [{ agentType, sessionId, filePath, lineNumber, role: 'tool', text: truncate(output, TOOL_RESULT_MAX), timestamp }];
    }

    // reasoning, turn_context, custom_tool_call, etc. — all skipped.
    return [];
  }
}
