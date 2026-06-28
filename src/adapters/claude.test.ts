import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from './claude.js';

// Real fixture lines from ~/.claude/projects/-Users-agent-src-agent-search/ and
// ~/.claude/projects/-Users-agent-src-agent-search/4f5a42c3-0fd4-419a-a089-6c6297ac6150.jsonl

const SESSION_ID = '2e79d433-10a4-41bc-a3b4-0bc313ca2d26';
const FILE_PATH = `/Users/agent/.claude/projects/-Users-agent-src-agent-search/${SESSION_ID}.jsonl`;
const CTX = { filePath: FILE_PATH, lineNumber: 5 };

// --- FIXTURE: skipped record types ---
const MODE_LINE = JSON.stringify({ type: 'mode', mode: 'normal', sessionId: SESSION_ID });
const PERMISSION_LINE = JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: SESSION_ID });
const ATTACHMENT_LINE = JSON.stringify({ type: 'attachment', sessionId: SESSION_ID });
const SYSTEM_LINE = JSON.stringify({ type: 'system', sessionId: SESSION_ID });

// --- FIXTURE: user message with array content (text block) ---
// Trimmed from real log; structure preserved.
const USER_TEXT_ARRAY_LINE = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'You are going to populate an AI context scaffold.' }],
  },
  timestamp: '2026-06-27T07:17:26.821Z',
  sessionId: SESSION_ID,
  cwd: '/Users/agent/src/agent-search',
});

// --- FIXTURE: user message with plain string content ---
const USER_TEXT_STRING_LINE = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: 'Plain string message from user.' },
  timestamp: '2026-06-27T08:00:00.000Z',
  sessionId: SESSION_ID,
});

// --- FIXTURE: user message containing a tool_result block ---
// Real shape from ~/.claude/projects/…/4f5a42c3-…jsonl
const USER_TOOL_RESULT_LINE = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: 'toolu_01DEXJB4Y2mdbpNaX7u71yTt',
        type: 'tool_result',
        content: '1\t---\n2\tname: router\n3\tdescription: Session bootstrap and navigation hub.',
        is_error: false,
      },
    ],
  },
  timestamp: '2026-06-27T07:17:32.000Z',
  sessionId: SESSION_ID,
});

// --- FIXTURE: assistant message with thinking + tool_use blocks ---
// Real shape from ~/.claude/projects/…/4f5a42c3-…jsonl (trimmed)
const ASSISTANT_TOOL_USE_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'Some internal reasoning.',
        signature: 'Et4ECmMI...',
      },
      {
        type: 'tool_use',
        id: 'toolu_01DEXJB4Y2mdbpNaX7u71yTt',
        name: 'Read',
        input: { file_path: '/Users/agent/src/agent-search/.mex/ROUTER.md' },
      },
    ],
    stop_reason: 'tool_use',
  },
  timestamp: '2026-06-27T07:17:30.736Z',
  sessionId: SESSION_ID,
});

// --- FIXTURE: assistant message with text + tool_use blocks ---
const ASSISTANT_TEXT_AND_TOOL_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me read the router file.' },
      {
        type: 'tool_use',
        id: 'toolu_abc123',
        name: 'Bash',
        input: { command: 'ls /tmp', timeout: 5000 },
      },
    ],
  },
  timestamp: '2026-06-27T09:00:00.000Z',
  sessionId: SESSION_ID,
});

// --- FIXTURE: assistant with only thinking (no text, no tool) ---
const ASSISTANT_THINKING_ONLY_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'Encrypted thinking.', signature: 'abc' }],
  },
  timestamp: '2026-06-27T09:01:00.000Z',
  sessionId: SESSION_ID,
});

describe('ClaudeAdapter', () => {
  const adapter = new ClaudeAdapter();

  describe('agentType and rootDir', () => {
    it('has agentType claude', () => {
      expect(adapter.agentType).toBe('claude');
    });

    it('has rootDir pointing to ~/.claude/projects (expanded)', () => {
      expect(adapter.rootDir).not.toContain('~');
      expect(adapter.rootDir).toMatch(/\.claude\/projects$/);
    });
  });

  describe('claims()', () => {
    it('claims files inside ~/.claude/projects', () => {
      expect(adapter.claims(FILE_PATH)).toBe(true);
    });

    it('does not claim files outside ~/.claude/projects', () => {
      expect(adapter.claims('/Users/agent/.codex/sessions/foo.jsonl')).toBe(false);
      expect(adapter.claims('/Users/agent/.pi/agent/sessions/foo/bar.jsonl')).toBe(false);
    });
  });

  describe('parseLine() — skipped types', () => {
    it('returns [] for mode records', () => {
      expect(adapter.parseLine(MODE_LINE, CTX)).toEqual([]);
    });

    it('returns [] for permission-mode records', () => {
      expect(adapter.parseLine(PERMISSION_LINE, CTX)).toEqual([]);
    });

    it('returns [] for attachment records', () => {
      expect(adapter.parseLine(ATTACHMENT_LINE, CTX)).toEqual([]);
    });

    it('returns [] for system records', () => {
      expect(adapter.parseLine(SYSTEM_LINE, CTX)).toEqual([]);
    });

    it('returns [] for blank lines', () => {
      expect(adapter.parseLine('', CTX)).toEqual([]);
      expect(adapter.parseLine('   ', CTX)).toEqual([]);
    });
  });

  describe('parseLine() — user text (array content)', () => {
    it('produces one chunk with role user and correct text', () => {
      const chunks = adapter.parseLine(USER_TEXT_ARRAY_LINE, CTX);
      expect(chunks).toHaveLength(1);
      const c = chunks[0];
      expect(c.role).toBe('user');
      expect(c.text).toBe('You are going to populate an AI context scaffold.');
      expect(c.toolCall).toBeUndefined();
    });

    it('carries correct metadata', () => {
      const chunks = adapter.parseLine(USER_TEXT_ARRAY_LINE, CTX);
      const c = chunks[0];
      expect(c.agentType).toBe('claude');
      expect(c.sessionId).toBe(SESSION_ID);
      expect(c.filePath).toBe(FILE_PATH);
      expect(c.lineNumber).toBe(5);
      expect(c.timestamp).toBe('2026-06-27T07:17:26.821Z');
    });
  });

  describe('parseLine() — user text (string content)', () => {
    it('produces one chunk with role user and the string as text', () => {
      const chunks = adapter.parseLine(USER_TEXT_STRING_LINE, CTX);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].role).toBe('user');
      expect(chunks[0].text).toBe('Plain string message from user.');
    });
  });

  describe('parseLine() — user tool_result', () => {
    it('produces one chunk with role tool and truncated text', () => {
      const chunks = adapter.parseLine(USER_TOOL_RESULT_LINE, CTX);
      expect(chunks).toHaveLength(1);
      const c = chunks[0];
      expect(c.role).toBe('tool');
      expect(c.text).toContain('router');
      expect(c.toolCall).toBeUndefined();
    });

    it('truncates tool_result text to ~500 chars', () => {
      const longText = 'x'.repeat(1000);
      const line = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: longText }],
        },
        timestamp: '2026-06-27T09:00:00.000Z',
        sessionId: SESSION_ID,
      });
      const chunks = adapter.parseLine(line, CTX);
      expect(chunks[0].text.length).toBeLessThanOrEqual(503); // 500 + possible '...'
    });
  });

  describe('parseLine() — assistant thinking only', () => {
    it('returns [] when content is only a thinking block', () => {
      const chunks = adapter.parseLine(ASSISTANT_THINKING_ONLY_LINE, CTX);
      expect(chunks).toEqual([]);
    });
  });

  describe('parseLine() — assistant tool_use', () => {
    it('produces a tool chunk (no text chunk when only thinking+tool_use)', () => {
      const chunks = adapter.parseLine(ASSISTANT_TOOL_USE_LINE, CTX);
      expect(chunks).toHaveLength(1);
      const c = chunks[0];
      expect(c.role).toBe('tool');
      expect(c.toolCall?.name).toBe('Read');
      expect(c.toolCall?.args).toContain('ROUTER.md');
    });

    it('truncates tool args to ~200 chars', () => {
      const bigInput = { key: 'x'.repeat(500) };
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'Write', input: bigInput }],
        },
        timestamp: '2026-06-27T09:00:00.000Z',
        sessionId: SESSION_ID,
      });
      const chunks = adapter.parseLine(line, CTX);
      expect(chunks[0].toolCall?.args.length).toBeLessThanOrEqual(203); // 200 + possible '...'
    });
  });

  describe('parseLine() — assistant text + tool_use', () => {
    it('produces two chunks: text (assistant) + tool (tool)', () => {
      const chunks = adapter.parseLine(ASSISTANT_TEXT_AND_TOOL_LINE, CTX);
      expect(chunks).toHaveLength(2);
      const textChunk = chunks.find((c) => c.role === 'assistant');
      const toolChunk = chunks.find((c) => c.role === 'tool');
      expect(textChunk?.text).toBe('Let me read the router file.');
      expect(toolChunk?.toolCall?.name).toBe('Bash');
      expect(toolChunk?.toolCall?.args).toContain('ls /tmp');
    });
  });

  describe('parseLine() — session id resolution', () => {
    it('prefers sessionId field on the record over filename stem', () => {
      const chunks = adapter.parseLine(USER_TEXT_ARRAY_LINE, CTX);
      expect(chunks[0].sessionId).toBe(SESSION_ID);
    });

    it('falls back to filename stem when record has no sessionId', () => {
      const line = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello' },
        timestamp: '2026-06-27T09:00:00.000Z',
        // no sessionId field
      });
      const chunks = adapter.parseLine(line, CTX);
      // filename stem of FILE_PATH is SESSION_ID
      expect(chunks[0].sessionId).toBe(SESSION_ID);
    });
  });
});

describe('ClaudeAdapter.extractCwd', () => {
  const adapter = new ClaudeAdapter();

  it('returns cwd from a record that carries it', () => {
    expect(adapter.extractCwd(USER_TEXT_ARRAY_LINE)).toBe('/Users/agent/src/agent-search');
  });

  it('returns undefined when the record has no cwd', () => {
    expect(adapter.extractCwd(USER_TEXT_STRING_LINE)).toBeUndefined();
  });

  it('returns undefined for a non-JSON line', () => {
    expect(adapter.extractCwd('not json')).toBeUndefined();
  });
});
