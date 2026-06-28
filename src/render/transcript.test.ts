import { describe, it, expect } from 'vitest';
import { readTranscript } from './transcript.js';

describe('readTranscript', () => {
  it('dispatches jsonl files to the right parser and concatenates in order', () => {
    const files = [
      { filePath: '/c.jsonl', agentType: 'claude' },
      { filePath: '/x.jsonl', agentType: 'codex' },
    ];
    const fileBodies: Record<string, string> = {
      '/c.jsonl': JSON.stringify({ type: 'user', timestamp: 't', message: { role: 'user', content: 'hi' } }),
      '/x.jsonl': JSON.stringify({ type: 'response_item', timestamp: 't', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] } }),
    };
    const items = readTranscript('s1', {
      getSessionFiles: () => files,
      readFile: (p) => fileBodies[p],
      openTranscript: () => [],
    });
    expect(items.map((i) => [i.role, i.text])).toEqual([['user', 'hi'], ['assistant', 'yo']]);
  });

  it('routes opencode sessions to openTranscript', () => {
    const items = readTranscript('s1', {
      getSessionFiles: () => [{ filePath: 'opencode://s1', agentType: 'opencode' }],
      readFile: () => { throw new Error('should not read files for opencode'); },
      openTranscript: (id) => [{ role: 'assistant', text: 'oc ' + id, tool: undefined, filePath: 'opencode://s1', lineNumbers: [1], timestamp: 't' }],
    });
    expect(items).toEqual([{ role: 'assistant', text: 'oc s1', tool: undefined, filePath: 'opencode://s1', lineNumbers: [1], timestamp: 't' }]);
  });
});
