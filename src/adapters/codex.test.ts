import { describe, it, expect } from 'vitest';
import { CodexAdapter } from './codex.js';

// Real fixture lines from ~/.codex/sessions/2026/06/27/rollout-2026-06-27T09-27-02-019f0642-164f-76c0-8424-cf60e8030e3e.jsonl
// Structure preserved; large text fields trimmed.

// Session id is derived from filename: last 36 chars of stem.
const SESSION_ID = '019f0642-164f-76c0-8424-cf60e8030e3e';
const FILE_PATH = `/Users/agent/.codex/sessions/2026/06/27/rollout-2026-06-27T09-27-02-${SESSION_ID}.jsonl`;
const CTX = { filePath: FILE_PATH, lineNumber: 3 };

// --- FIXTURE: session_meta (not indexed; used only for session id reference) ---
const SESSION_META_LINE = JSON.stringify({
  timestamp: '2026-06-26T23:27:02.445Z',
  type: 'session_meta',
  payload: {
    session_id: SESSION_ID,
    id: SESSION_ID,
    timestamp: '2026-06-26T23:27:02.252Z',
    cwd: '/Users/agent/src/MezzaNexus/.claude/worktrees/nx91-party-travel',
    originator: 'codex_exec',
    cli_version: '0.142.0',
  },
});

// --- FIXTURE: event_msg (skipped) ---
const EVENT_MSG_LINE = JSON.stringify({
  timestamp: '2026-06-26T23:27:02.446Z',
  type: 'event_msg',
  payload: { type: 'task_started', turn_id: '019f0642-1704-7f90-9e61-f166f5763c27' },
});

// --- FIXTURE: response_item - developer role (skipped) ---
const DEVELOPER_MSG_LINE = JSON.stringify({
  timestamp: '2026-06-26T23:27:05.809Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'developer',
    content: [
      { type: 'input_text', text: '<permissions instructions>\nsome system text\n</permissions instructions>' },
    ],
  },
});

// --- FIXTURE: response_item - reasoning (skipped) ---
const REASONING_LINE = JSON.stringify({
  timestamp: '2026-06-26T23:27:08.565Z',
  type: 'response_item',
  payload: {
    type: 'reasoning',
    id: 'rs_06b201cfabb6bf37016a3f0acb9e648191a91aaa7624b8fb85',
    summary: [],
    encrypted_content: 'gAAAAABqPwrMdbVUYcMWopHrPb4...',
  },
});

// --- FIXTURE: response_item - user message ---
// Real shape: user messages use input_text content blocks
const USER_MSG_LINE = JSON.stringify({
  timestamp: '2026-06-26T23:27:05.809Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'Implement the feature as described in the task.' },
    ],
  },
});

// --- FIXTURE: response_item - assistant message ---
// Real shape: assistant messages use output_text content blocks
const ASSISTANT_MSG_LINE = JSON.stringify({
  timestamp: '2026-06-26T23:28:00.000Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'output_text', text: 'I will now read the relevant files.' },
    ],
  },
});

// --- FIXTURE: response_item - function_call ---
// Real shape from actual codex log
const FUNCTION_CALL_LINE = JSON.stringify({
  timestamp: '2026-06-26T23:27:12.947Z',
  type: 'response_item',
  payload: {
    type: 'function_call',
    id: 'fc_06b201cfabb6bf37016a3f0ad0f2048191b8c35b9003f99f91',
    name: 'exec_command',
    arguments: '{"cmd":"sed -n \'1,220p\' /Users/agent/src/skills/skills/dev/code-review/SKILL.md","workdir":"/Users/agent/src","yield_time_ms":1000}',
    call_id: 'call_dM1paFMiA1nhWXkgYcHSMfLr',
  },
});

// --- FIXTURE: response_item - function_call_output ---
// Real shape from actual codex log (text trimmed)
const FUNCTION_CALL_OUTPUT_LINE = JSON.stringify({
  timestamp: '2026-06-26T23:27:13.024Z',
  type: 'response_item',
  payload: {
    type: 'function_call_output',
    call_id: 'call_dM1paFMiA1nhWXkgYcHSMfLr',
    output: 'Chunk ID: 62efb0\nWall time: 0.0001 seconds\nProcess exited with code 0\nOutput:\n---\nname: code-review\ndescription: Review a code change.',
  },
});

describe('CodexAdapter', () => {
  const adapter = new CodexAdapter();

  describe('agentType and rootDir', () => {
    it('has agentType codex', () => {
      expect(adapter.agentType).toBe('codex');
    });

    it('has rootDir pointing to ~/.codex/sessions (expanded)', () => {
      expect(adapter.rootDir).not.toContain('~');
      expect(adapter.rootDir).toMatch(/\.codex\/sessions$/);
    });
  });

  describe('claims()', () => {
    it('claims files inside ~/.codex/sessions', () => {
      expect(adapter.claims(FILE_PATH)).toBe(true);
    });

    it('does not claim files outside ~/.codex/sessions', () => {
      expect(adapter.claims('/Users/agent/.claude/projects/foo/bar.jsonl')).toBe(false);
      expect(adapter.claims('/Users/agent/.pi/agent/sessions/foo/bar.jsonl')).toBe(false);
    });
  });

  describe('parseLine() — skipped types', () => {
    it('returns [] for session_meta records', () => {
      expect(adapter.parseLine(SESSION_META_LINE, CTX)).toEqual([]);
    });

    it('returns [] for event_msg records', () => {
      expect(adapter.parseLine(EVENT_MSG_LINE, CTX)).toEqual([]);
    });

    it('returns [] for developer role messages', () => {
      expect(adapter.parseLine(DEVELOPER_MSG_LINE, CTX)).toEqual([]);
    });

    it('returns [] for reasoning records', () => {
      expect(adapter.parseLine(REASONING_LINE, CTX)).toEqual([]);
    });

    it('returns [] for blank lines', () => {
      expect(adapter.parseLine('', CTX)).toEqual([]);
      expect(adapter.parseLine('  ', CTX)).toEqual([]);
    });
  });

  describe('parseLine() — user message', () => {
    it('produces one chunk with role user', () => {
      const chunks = adapter.parseLine(USER_MSG_LINE, CTX);
      expect(chunks).toHaveLength(1);
      const c = chunks[0];
      expect(c.role).toBe('user');
      expect(c.text).toBe('Implement the feature as described in the task.');
    });

    it('carries correct metadata', () => {
      const chunks = adapter.parseLine(USER_MSG_LINE, CTX);
      const c = chunks[0];
      expect(c.agentType).toBe('codex');
      expect(c.sessionId).toBe(SESSION_ID);
      expect(c.filePath).toBe(FILE_PATH);
      expect(c.lineNumber).toBe(3);
      expect(c.timestamp).toBe('2026-06-26T23:27:05.809Z');
    });
  });

  describe('parseLine() — assistant message', () => {
    it('produces one chunk with role assistant', () => {
      const chunks = adapter.parseLine(ASSISTANT_MSG_LINE, CTX);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].role).toBe('assistant');
      expect(chunks[0].text).toBe('I will now read the relevant files.');
    });
  });

  describe('parseLine() — function_call', () => {
    it('produces a tool chunk with toolCall name and args', () => {
      const chunks = adapter.parseLine(FUNCTION_CALL_LINE, CTX);
      expect(chunks).toHaveLength(1);
      const c = chunks[0];
      expect(c.role).toBe('tool');
      expect(c.toolCall?.name).toBe('exec_command');
      expect(c.toolCall?.args).toContain('code-review');
    });

    it('truncates function_call arguments to ~200 chars', () => {
      const bigArgs = '{"key":"' + 'x'.repeat(500) + '"}';
      const line = JSON.stringify({
        timestamp: '2026-06-26T23:27:12.947Z',
        type: 'response_item',
        payload: { type: 'function_call', id: 'fc_1', name: 'run', arguments: bigArgs, call_id: 'c1' },
      });
      const chunks = adapter.parseLine(line, CTX);
      expect(chunks[0].toolCall?.args.length).toBeLessThanOrEqual(203);
    });
  });

  describe('parseLine() — function_call_output', () => {
    it('produces a tool chunk with FTS text, no toolCall', () => {
      const chunks = adapter.parseLine(FUNCTION_CALL_OUTPUT_LINE, CTX);
      expect(chunks).toHaveLength(1);
      const c = chunks[0];
      expect(c.role).toBe('tool');
      expect(c.text).toContain('code-review');
      expect(c.toolCall).toBeUndefined();
    });

    it('truncates output text to ~500 chars', () => {
      const bigOutput = 'y'.repeat(1000);
      const line = JSON.stringify({
        timestamp: '2026-06-26T23:27:13.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c1', output: bigOutput },
      });
      const chunks = adapter.parseLine(line, CTX);
      expect(chunks[0].text.length).toBeLessThanOrEqual(503);
    });
  });

  describe('parseLine() — session id from filename', () => {
    it('derives session id from the UUID at end of filename stem', () => {
      const chunks = adapter.parseLine(USER_MSG_LINE, CTX);
      expect(chunks[0].sessionId).toBe(SESSION_ID);
    });

    it('uses the correct id even when filePath differs', () => {
      const otherId = '019f0652-d414-7f70-a8d9-7d2c31b33805';
      const otherPath = `/Users/agent/.codex/sessions/2026/06/27/rollout-2026-06-27T09-45-19-${otherId}.jsonl`;
      const chunks = adapter.parseLine(USER_MSG_LINE, { filePath: otherPath, lineNumber: 1 });
      expect(chunks[0].sessionId).toBe(otherId);
    });
  });
});

describe('CodexAdapter.extractCwd', () => {
  const adapter = new CodexAdapter();

  it('returns cwd from the session_meta payload', () => {
    expect(adapter.extractCwd(SESSION_META_LINE)).toBe(
      '/Users/agent/src/MezzaNexus/.claude/worktrees/nx91-party-travel',
    );
  });

  it('returns undefined for a non-meta record', () => {
    expect(adapter.extractCwd(EVENT_MSG_LINE)).toBeUndefined();
  });

  it('returns undefined for a non-JSON line', () => {
    expect(adapter.extractCwd('not json')).toBeUndefined();
  });
});
