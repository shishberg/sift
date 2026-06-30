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

  it('squashes harness command wrapper tags in user messages', () => {
    const items = parseClaudeTranscript(
      lines({
        type: 'user',
        timestamp: 't1',
        message: {
          role: 'user',
          content:
            '<command-name>/login</command-name>\n  <command-message>login</command-message>\n  <command-args></command-args>',
        },
      }),
      FP,
    );
    expect(items.map((i) => i.text)).toEqual(['/login login']);
  });

  it('drops a caveat-only user message entirely', () => {
    const items = parseClaudeTranscript(
      lines({
        type: 'user',
        timestamp: 't1',
        message: {
          role: 'user',
          content: '<local-command-caveat>Caveat: boilerplate.</local-command-caveat>',
        },
      }),
      FP,
    );
    expect(items).toEqual([]);
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

  it('emits one compaction item from a boundary + summary pair, not a user bubble', () => {
    const items = parseClaudeTranscript(
      lines(
        { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 231153 }, content: 'Conversation compacted', timestamp: 't1' },
        { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: 't2', message: { role: 'user', content: 'This session is being continued...' } },
      ),
      FP,
    );
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe('user');
    expect(items[0].text).toBe('');
    expect(items[0].compaction).toEqual({ summary: 'This session is being continued...', tokensBefore: 231153, trigger: 'manual' });
    expect(items[0].lineNumbers).toEqual([2]);
    expect(items[0].timestamp).toBe('t2');
  });

  it('does not run stripHarnessTags on the compaction summary and joins array content', () => {
    const items = parseClaudeTranscript(
      lines(
        { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 1000 }, content: 'Conversation compacted', timestamp: 't1' },
        { type: 'user', isCompactSummary: true, timestamp: 't2', message: { role: 'user', content: [{ type: 'text', text: '<command-name>/x</command-name>' }] } },
      ),
      FP,
    );
    expect(items).toHaveLength(1);
    expect(items[0].compaction?.summary).toBe('<command-name>/x</command-name>');
  });

  it('does not crash on a compact_boundary with no following summary', () => {
    const items = parseClaudeTranscript(
      lines(
        { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 5 }, content: 'Conversation compacted', timestamp: 't1' },
        { type: 'assistant', timestamp: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'after' }] } },
      ),
      FP,
    );
    expect(items.map((i) => [i.role, i.text])).toEqual([['assistant', 'after']]);
  });
});
