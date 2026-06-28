import { describe, it, expect } from 'vitest';
import { PiAdapter } from './pi.js';

// Real fixture lines from ~/.pi/agent/sessions/--Users-agent-src-agent-web--/
// 2026-05-16T13-32-15-764Z_019e30fc-d214-7349-8b1c-b149337ace1e.jsonl
// Structure preserved; large text fields trimmed.

// Pi session id: extracted from filename — the part after the last underscore.
const SESSION_ID = '019e30fc-d214-7349-8b1c-b149337ace1e';
const FILE_PATH = `/Users/agent/.pi/agent/sessions/--Users-agent-src-agent-web--/2026-05-16T13-32-15-764Z_${SESSION_ID}.jsonl`;
const CTX = { filePath: FILE_PATH, lineNumber: 4 };

// --- FIXTURE: session record (skipped) ---
const SESSION_LINE = JSON.stringify({
  type: 'session',
  version: 3,
  id: SESSION_ID,
  timestamp: '2026-05-16T13:32:15.764Z',
  cwd: '/Users/agent/src/agent-web',
});

// --- FIXTURE: model_change (skipped) ---
const MODEL_CHANGE_LINE = JSON.stringify({
  type: 'model_change',
  id: 'd5410092',
  parentId: null,
  timestamp: '2026-05-16T13:32:16.000Z',
  provider: 'openai-codex',
  modelId: 'gpt-5.5',
});

// --- FIXTURE: thinking_level_change (skipped) ---
const THINKING_LEVEL_LINE = JSON.stringify({
  type: 'thinking_level_change',
  id: 'cb0be1a6',
  parentId: 'd5410092',
  timestamp: '2026-05-16T13:32:16.001Z',
  thinkingLevel: 'medium',
});

// --- FIXTURE: custom (skipped) ---
const CUSTOM_LINE = JSON.stringify({ type: 'custom', id: 'abc', parentId: null, timestamp: '2026-05-16T13:32:17.000Z' });

// --- FIXTURE: user message with text block ---
const USER_MSG_LINE = JSON.stringify({
  type: 'message',
  id: '2d1ff3f5',
  parentId: 'b1464d27',
  timestamp: '2026-05-16T13:32:20.000Z',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'Adjust the light mode theme.' }],
  },
});

// --- FIXTURE: assistant message with thinking + text + toolCall blocks ---
// Real shape from ~/.pi/agent/sessions/--Users-agent-src-agent-web--/…
const ASSISTANT_TOOL_MSG_LINE = JSON.stringify({
  type: 'message',
  id: '96dc43d4',
  parentId: 'ec3a8de6',
  timestamp: '2026-05-16T13:33:11.678Z',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'The user wants to adjust the light mode theme.',
        thinkingSignature: 'reasoning_content',
      },
      { type: 'text', text: 'Let me explore the project\'s theme and styling setup first.' },
      {
        type: 'toolCall',
        id: 'call_1629',
        name: 'bash',
        arguments: { command: 'find /Users/agent/src/agent-web/src -type f -name "*.css"' },
      },
      {
        type: 'toolCall',
        id: 'call_34e8',
        name: 'bash',
        arguments: { command: 'grep -rl "light|theme" /Users/agent/src/agent-web/src' },
      },
    ],
  },
});

// --- FIXTURE: toolResult message ---
// Real shape from ~/.pi/agent/sessions/--Users-agent-src-agent-web--/…
const TOOL_RESULT_MSG_LINE = JSON.stringify({
  type: 'message',
  id: 'b367d96e',
  parentId: '96dc43d4',
  timestamp: '2026-05-16T13:33:11.713Z',
  message: {
    role: 'toolResult',
    toolCallId: 'call_1629',
    toolName: 'bash',
    content: [
      {
        type: 'text',
        text: '/Users/agent/src/agent-web/src/App.vue\n/Users/agent/src/agent-web/src/styles.css\n',
      },
    ],
    isError: false,
    timestamp: 1778938391713,
  },
});

describe('PiAdapter', () => {
  const adapter = new PiAdapter();

  describe('agentType and rootDir', () => {
    it('has agentType pi', () => {
      expect(adapter.agentType).toBe('pi');
    });

    it('has rootDir pointing to ~/.pi/agent/sessions (expanded)', () => {
      expect(adapter.rootDir).not.toContain('~');
      expect(adapter.rootDir).toMatch(/\.pi\/agent\/sessions$/);
    });
  });

  describe('claims()', () => {
    it('claims files inside ~/.pi/agent/sessions', () => {
      expect(adapter.claims(FILE_PATH)).toBe(true);
    });

    it('does not claim files outside ~/.pi/agent/sessions', () => {
      expect(adapter.claims('/Users/agent/.claude/projects/foo/bar.jsonl')).toBe(false);
      expect(adapter.claims('/Users/agent/.codex/sessions/2026/06/27/rollout.jsonl')).toBe(false);
    });
  });

  describe('parseLine() — skipped types', () => {
    it('returns [] for session records', () => {
      expect(adapter.parseLine(SESSION_LINE, CTX)).toEqual([]);
    });

    it('returns [] for model_change records', () => {
      expect(adapter.parseLine(MODEL_CHANGE_LINE, CTX)).toEqual([]);
    });

    it('returns [] for thinking_level_change records', () => {
      expect(adapter.parseLine(THINKING_LEVEL_LINE, CTX)).toEqual([]);
    });

    it('returns [] for custom records', () => {
      expect(adapter.parseLine(CUSTOM_LINE, CTX)).toEqual([]);
    });

    it('returns [] for blank lines', () => {
      expect(adapter.parseLine('', CTX)).toEqual([]);
    });
  });

  describe('parseLine() — user message', () => {
    it('produces one chunk with role user and correct text', () => {
      const chunks = adapter.parseLine(USER_MSG_LINE, CTX);
      expect(chunks).toHaveLength(1);
      const c = chunks[0];
      expect(c.role).toBe('user');
      expect(c.text).toBe('Adjust the light mode theme.');
    });

    it('carries correct metadata', () => {
      const chunks = adapter.parseLine(USER_MSG_LINE, CTX);
      const c = chunks[0];
      expect(c.agentType).toBe('pi');
      expect(c.sessionId).toBe(SESSION_ID);
      expect(c.filePath).toBe(FILE_PATH);
      expect(c.lineNumber).toBe(4);
      expect(c.timestamp).toBe('2026-05-16T13:32:20.000Z');
    });
  });

  describe('parseLine() — assistant message with thinking + text + toolCalls', () => {
    it('skips thinking blocks and produces text + tool chunks', () => {
      const chunks = adapter.parseLine(ASSISTANT_TOOL_MSG_LINE, CTX);
      // 1 text chunk + 2 tool chunks (thinking skipped)
      expect(chunks).toHaveLength(3);
    });

    it('text chunk has role assistant', () => {
      const chunks = adapter.parseLine(ASSISTANT_TOOL_MSG_LINE, CTX);
      const textChunk = chunks.find((c) => c.role === 'assistant');
      expect(textChunk?.text).toBe("Let me explore the project's theme and styling setup first.");
    });

    it('tool chunks have role tool and correct toolCall', () => {
      const chunks = adapter.parseLine(ASSISTANT_TOOL_MSG_LINE, CTX);
      const toolChunks = chunks.filter((c) => c.role === 'tool');
      expect(toolChunks).toHaveLength(2);
      expect(toolChunks[0].toolCall?.name).toBe('bash');
      expect(toolChunks[0].toolCall?.args).toContain('*.css');
      expect(toolChunks[1].toolCall?.args).toContain('theme');
    });
  });

  describe('parseLine() — toolResult message', () => {
    it('produces one chunk with role tool and text', () => {
      const chunks = adapter.parseLine(TOOL_RESULT_MSG_LINE, CTX);
      expect(chunks).toHaveLength(1);
      const c = chunks[0];
      expect(c.role).toBe('tool');
      expect(c.text).toContain('App.vue');
      expect(c.toolCall).toBeUndefined();
    });

    it('truncates toolResult text to ~500 chars', () => {
      const bigText = 'z'.repeat(1000);
      const line = JSON.stringify({
        type: 'message',
        id: 'abc',
        parentId: null,
        timestamp: '2026-05-16T13:33:11.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          content: [{ type: 'text', text: bigText }],
        },
      });
      const chunks = adapter.parseLine(line, CTX);
      expect(chunks[0].text.length).toBeLessThanOrEqual(503);
    });
  });

  describe('parseLine() — toolCall args truncation', () => {
    it('truncates toolCall args to ~200 chars', () => {
      const bigCmd = 'find . ' + '-name "*.ts" '.repeat(100);
      const line = JSON.stringify({
        type: 'message',
        id: 'abc',
        parentId: null,
        timestamp: '2026-05-16T13:33:11.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: bigCmd } },
          ],
        },
      });
      const chunks = adapter.parseLine(line, CTX);
      expect(chunks[0].toolCall?.args.length).toBeLessThanOrEqual(203);
    });
  });

  describe('parseLine() — session id from filename', () => {
    it('derives session id from part after underscore in filename', () => {
      const chunks = adapter.parseLine(USER_MSG_LINE, CTX);
      expect(chunks[0].sessionId).toBe(SESSION_ID);
    });

    it('uses correct id from a different filename', () => {
      const otherId = '019e52f9-22c0-7f68-b9a1-72ea2e1109c8';
      const otherPath = `/Users/agent/.pi/agent/sessions/--Users-agent--/2026-05-23T03-55-19-617Z_${otherId}.jsonl`;
      const chunks = adapter.parseLine(USER_MSG_LINE, { filePath: otherPath, lineNumber: 1 });
      expect(chunks[0].sessionId).toBe(otherId);
    });
  });
});

describe('PiAdapter.extractCwd', () => {
  const adapter = new PiAdapter();

  it('returns cwd from the session record', () => {
    expect(adapter.extractCwd(SESSION_LINE)).toBe('/Users/agent/src/agent-web');
  });

  it('returns undefined for a non-session record', () => {
    expect(adapter.extractCwd(MODEL_CHANGE_LINE)).toBeUndefined();
  });

  it('returns undefined for a non-JSON line', () => {
    expect(adapter.extractCwd('not json')).toBeUndefined();
  });
});
