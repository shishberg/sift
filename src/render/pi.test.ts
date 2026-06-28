import { describe, it, expect } from 'vitest';
import { parsePiTranscript } from './pi.js';

const FP = '/logs/2026_abc.jsonl';
function lines(...records: unknown[]): string[] {
  return records.map((r) => JSON.stringify(r));
}

describe('parsePiTranscript', () => {
  it('emits text, skips thinking, pairs toolCall with toolResult', () => {
    const items = parsePiTranscript(
      lines(
        { type: 'message', timestamp: 't1', message: { role: 'assistant', content: [
          { type: 'thinking', text: 'hmm' },
          { type: 'text', text: 'doing it' },
          { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
        ] } },
        { type: 'message', timestamp: 't2', message: { role: 'toolResult', toolCallId: 'call_1', content: [{ type: 'text', text: 'a\nb' }] } },
      ),
      FP,
    );
    expect(items.map((i) => i.role)).toEqual(['assistant', 'tool']);
    expect(items[0].text).toBe('doing it');
    expect(items[1].tool).toEqual({ name: 'bash', input: '{"command":"ls"}', output: 'a\nb', isError: false });
    expect(items[1].lineNumbers).toEqual([1, 2]);
  });
});
