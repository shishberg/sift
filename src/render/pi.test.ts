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

  it('marks a failed tool result as isError', () => {
    const items = parsePiTranscript(
      lines(
        { type: 'message', timestamp: 't1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: {} }] } },
        { type: 'message', timestamp: 't2', message: { role: 'toolResult', toolCallId: 'call_1', isError: true, content: [{ type: 'text', text: 'boom' }] } },
      ),
      FP,
    );
    expect(items[0].tool).toEqual({ name: 'bash', input: '{}', output: 'boom', isError: true });
  });

  it('emits a compaction item from a compaction record', () => {
    const items = parsePiTranscript(
      lines({ type: 'compaction', summary: '## Goal\nstuff', tokensBefore: 98744, fromHook: false, details: {}, timestamp: 't1' }),
      FP,
    );
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe('user');
    expect(items[0].text).toBe('');
    expect(items[0].compaction).toEqual({ summary: '## Goal\nstuff', tokensBefore: 98744, trigger: undefined });
    expect(items[0].lineNumbers).toEqual([1]);
    expect(items[0].timestamp).toBe('t1');
  });

  it('sets trigger to hook when fromHook is true', () => {
    const items = parsePiTranscript(
      lines({ type: 'compaction', summary: 's', tokensBefore: 10, fromHook: true, timestamp: 't1' }),
      FP,
    );
    expect(items[0].compaction).toEqual({ summary: 's', tokensBefore: 10, trigger: 'hook' });
  });
});
