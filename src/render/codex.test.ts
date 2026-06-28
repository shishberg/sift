import { describe, it, expect } from 'vitest';
import { parseCodexTranscript } from './codex.js';

const FP = '/logs/rollout.jsonl';
function lines(...records: unknown[]): string[] {
  return records.map((r) => JSON.stringify(r));
}

describe('parseCodexTranscript', () => {
  it('emits messages and pairs function_call with its output by call_id', () => {
    const items = parseCodexTranscript(
      lines(
        { type: 'response_item', timestamp: 't1', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] } },
        { type: 'response_item', timestamp: 't2', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'c1' } },
        { type: 'response_item', timestamp: 't3', payload: { type: 'function_call_output', call_id: 'c1', output: 'a\nb' } },
      ),
      FP,
    );
    expect(items.map((i) => i.role)).toEqual(['user', 'tool']);
    expect(items[0].text).toBe('run it');
    expect(items[1].tool).toEqual({ name: 'shell', input: '{"cmd":"ls"}', output: 'a\nb', isError: false });
    expect(items[1].lineNumbers).toEqual([2, 3]);
  });

  it('drops the injected environment_context block from user messages', () => {
    const items = parseCodexTranscript(
      lines({
        type: 'response_item',
        timestamp: 't1',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                'real question\n\n<environment_context>\n  <cwd>/x</cwd>\n</environment_context>',
            },
          ],
        },
      }),
      FP,
    );
    expect(items.map((i) => i.text)).toEqual(['real question']);
  });

  it('skips developer messages and non-response_item lines', () => {
    const items = parseCodexTranscript(
      lines(
        { type: 'session_meta', payload: { cwd: '/x' } },
        { type: 'response_item', timestamp: 't', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] } },
        { type: 'response_item', timestamp: 't', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
      ),
      FP,
    );
    expect(items.map((i) => [i.role, i.text])).toEqual([['assistant', 'done']]);
  });

  it('keeps a non-string (array) function_call_output as JSON text', () => {
    const items = parseCodexTranscript(
      lines(
        { type: 'response_item', timestamp: 't1', payload: { type: 'function_call', name: 'screenshot', arguments: '{}', call_id: 'c1' } },
        { type: 'response_item', timestamp: 't2', payload: { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_image', image_url: 'data:...' }] } },
      ),
      FP,
    );
    expect(items[0].tool?.output).toBe('[{"type":"input_image","image_url":"data:..."}]');
  });
});
