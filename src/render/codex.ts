import type { TranscriptItem } from '../types.js';

/**
 * Parse a full codex JSONL transcript faithfully: untruncated message text,
 * function_call paired with function_call_output (by call_id). developer
 * messages and non-content records are skipped. Order preserved.
 */
export function parseCodexTranscript(lines: string[], filePath: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolIndexByCallId = new Map<string, number>();

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
    if (record['type'] !== 'response_item') return;

    const payload = record['payload'] as Record<string, unknown> | undefined;
    if (!payload) return;
    const payloadType = payload['type'] as string | undefined;
    const timestamp = (record['timestamp'] as string | undefined) ?? '';

    if (payloadType === 'message') {
      const role = payload['role'] as string | undefined;
      if (role !== 'user' && role !== 'assistant') return; // skip developer/system
      const content = payload['content'] as Record<string, unknown>[] | undefined;
      if (!Array.isArray(content)) return;
      const text = content
        .filter((b) => b['type'] === 'input_text' || b['type'] === 'output_text')
        .map((b) => (b['text'] as string | undefined) ?? '')
        .join('');
      if (text) items.push({ role, text, filePath, lineNumbers: [lineNumber], timestamp });
    } else if (payloadType === 'function_call') {
      const name = (payload['name'] as string | undefined) ?? '';
      const input = (payload['arguments'] as string | undefined) ?? '';
      const callId = payload['call_id'] as string | undefined;
      items.push({ role: 'tool', text: '', tool: { name, input }, filePath, lineNumbers: [lineNumber], timestamp });
      if (callId) toolIndexByCallId.set(callId, items.length - 1);
    } else if (payloadType === 'function_call_output') {
      const callId = payload['call_id'] as string | undefined;
      const output = (payload['output'] as string | undefined) ?? '';
      const idx = callId !== undefined ? toolIndexByCallId.get(callId) : undefined;
      if (idx !== undefined && items[idx]?.tool) {
        items[idx].tool!.output = output;
        items[idx].tool!.isError = false;
        items[idx].lineNumbers.push(lineNumber);
      } else {
        items.push({ role: 'tool', text: '', tool: { name: '', input: '', output, isError: false }, filePath, lineNumbers: [lineNumber], timestamp });
      }
    }
  });

  return items;
}
