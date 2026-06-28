import { describe, it, expect } from 'vitest';
import { parseClaudeTranscript } from './claude.js';

const FP = '/logs/s.jsonl';

function lines(...records: unknown[]): string[] {
  return records.map((r) => JSON.stringify(r));
}

describe('parseClaudeTranscript', () => {
  it('emits user/assistant text items with untruncated text', () => {
    const items = parseClaudeTranscript(
      lines(
        { type: 'user', timestamp: 't1', message: { role: 'user', content: 'hi there' } },
        { type: 'assistant', timestamp: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      ),
      FP,
    );
    expect(items.map((i) => [i.role, i.text])).toEqual([
      ['user', 'hi there'],
      ['assistant', 'hello'],
    ]);
    expect(items[0].filePath).toBe(FP);
    expect(items[0].lineNumbers).toEqual([1]);
  });

  it('pairs tool_use with its later tool_result, covering both line numbers', () => {
    const items = parseClaudeTranscript(
      lines(
        { type: 'assistant', timestamp: 't1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/x' } }] } },
        { type: 'user', timestamp: 't2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false, content: 'file body' }] } },
      ),
      FP,
    );
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe('tool');
    expect(items[0].tool).toEqual({ name: 'Read', input: '{"path":"/x"}', output: 'file body', isError: false });
    expect(items[0].lineNumbers).toEqual([1, 2]);
  });

  it('skips thinking blocks and drops empty user-only-tool_result bubbles', () => {
    const items = parseClaudeTranscript(
      lines(
        { type: 'assistant', timestamp: 't1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] } },
        { type: 'user', timestamp: 't2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } },
      ),
      FP,
    );
    expect(items.map((i) => i.role)).toEqual(['tool']);
  });
});
