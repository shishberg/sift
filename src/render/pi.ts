import type { TranscriptItem } from '../types.js';
import { resultText } from './shared.js';

/**
 * Parse a full pi JSONL transcript faithfully: untruncated text, thinking
 * dropped, toolCall paired with its toolResult message (by id). Order kept.
 */
export function parsePiTranscript(lines: string[], filePath: string): TranscriptItem[] {
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
    if (record['type'] !== 'message') return;

    const timestamp = (record['timestamp'] as string | undefined) ?? '';
    const message = record['message'] as Record<string, unknown> | undefined;
    if (!message) return;
    const role = message['role'] as string | undefined;
    if (!role) return;

    if (role === 'toolResult') {
      const id = message['toolCallId'] as string | undefined;
      const output = resultText(message['content']);
      const idx = id !== undefined ? toolIndexById.get(id) : undefined;
      if (idx !== undefined && items[idx]?.tool) {
        items[idx].tool!.output = output;
        items[idx].tool!.isError = false;
        items[idx].lineNumbers.push(lineNumber);
        // One result per call; a later duplicate id becomes an orphan.
        if (id !== undefined) toolIndexById.delete(id);
      } else {
        items.push({ role: 'tool', text: '', tool: { name: '', input: '', output, isError: false }, filePath, lineNumbers: [lineNumber], timestamp });
      }
      return;
    }

    if (role !== 'user' && role !== 'assistant') return;
    const content = message['content'] as Record<string, unknown>[] | undefined;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      const blockType = block['type'] as string | undefined;
      if (blockType === 'text') {
        const text = (block['text'] as string | undefined) ?? '';
        if (text) items.push({ role, text, filePath, lineNumbers: [lineNumber], timestamp });
      } else if (blockType === 'thinking') {
        continue;
      } else if (blockType === 'toolCall') {
        const id = block['id'] as string | undefined;
        const name = (block['name'] as string | undefined) ?? '';
        const rawArgs = block['arguments'];
        const input = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
        items.push({ role: 'tool', text: '', tool: { name, input }, filePath, lineNumbers: [lineNumber], timestamp });
        if (id) toolIndexById.set(id, items.length - 1);
      }
    }
  });

  return items;
}
