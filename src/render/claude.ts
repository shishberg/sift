import type { TranscriptItem } from '../types.js';
import { resultText } from './shared.js';

/**
 * Parse a full claude JSONL transcript faithfully: untruncated text, tool_use
 * paired with its later tool_result (by id), thinking dropped. Order preserved.
 */
export function parseClaudeTranscript(lines: string[], filePath: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolIndexById = new Map<string, number>();

  lines.forEach((line, i) => {
    const lineNumber = i + 1;
    const trimmed = line.trim();
    if (!trimmed) return;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = record['type'];
    if (type !== 'user' && type !== 'assistant') return;

    const timestamp = (record['timestamp'] as string | undefined) ?? '';
    const message = record['message'] as { role?: string; content?: unknown } | undefined;
    if (!message) return;
    const role = message.role === 'user' ? 'user' : 'assistant';
    const content = message.content;

    if (typeof content === 'string') {
      if (content) items.push({ role, text: content, filePath, lineNumbers: [lineNumber], timestamp });
      return;
    }
    if (!Array.isArray(content)) return;

    for (const block of content as Record<string, unknown>[]) {
      const blockType = block['type'] as string | undefined;

      if (blockType === 'text') {
        const text = (block['text'] as string | undefined) ?? '';
        if (text) items.push({ role, text, filePath, lineNumbers: [lineNumber], timestamp });
      } else if (blockType === 'thinking') {
        continue;
      } else if (blockType === 'tool_use') {
        const id = block['id'] as string | undefined;
        const name = (block['name'] as string | undefined) ?? '';
        const input = block['input'];
        const inputStr = typeof input === 'string' ? input : JSON.stringify(input ?? {});
        items.push({ role: 'tool', text: '', tool: { name, input: inputStr }, filePath, lineNumbers: [lineNumber], timestamp });
        if (id) toolIndexById.set(id, items.length - 1);
      } else if (blockType === 'tool_result') {
        const id = block['tool_use_id'] as string | undefined;
        const output = resultText(block['content']);
        const isError = block['is_error'] === true;
        const idx = id !== undefined ? toolIndexById.get(id) : undefined;
        if (idx !== undefined && items[idx]?.tool) {
          items[idx].tool!.output = output;
          items[idx].tool!.isError = isError;
          items[idx].lineNumbers.push(lineNumber);
          // Each call pairs with at most one result; a later duplicate id
          // becomes an orphan instead of overwriting the first result.
          if (id !== undefined) toolIndexById.delete(id);
        } else {
          // Orphan result (call in another file or out of order): standalone item.
          items.push({ role: 'tool', text: '', tool: { name: '', input: '', output, isError }, filePath, lineNumbers: [lineNumber], timestamp });
        }
      }
    }
  });

  return items;
}
