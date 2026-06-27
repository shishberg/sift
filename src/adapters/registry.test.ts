import { describe, it, expect } from 'vitest';
import { buildRegistry } from './registry.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { PiAdapter } from './pi.js';
import os from 'os';

const home = os.homedir();

const CLAUDE_PATH = `${home}/.claude/projects/-Users-agent-src-foo/abc123.jsonl`;
const CODEX_PATH = `${home}/.codex/sessions/2026/06/27/rollout-2026-06-27T09-27-02-019f0642-164f-76c0-8424-cf60e8030e3e.jsonl`;
const PI_PATH = `${home}/.pi/agent/sessions/--Users-agent-src-foo--/2026-05-16T13-32-15-764Z_019e30fc-d214-7349-8b1c-b149337ace1e.jsonl`;
const UNKNOWN_PATH = '/tmp/some-other-file.jsonl';

describe('buildRegistry()', () => {
  it('returns a registry with three adapters', () => {
    const registry = buildRegistry();
    expect(registry.adapters).toHaveLength(3);
  });

  it('includes a ClaudeAdapter, CodexAdapter, and PiAdapter', () => {
    const registry = buildRegistry();
    const types = registry.adapters.map((a) => a.agentType);
    expect(types).toContain('claude');
    expect(types).toContain('codex');
    expect(types).toContain('pi');
  });
});

describe('registry.forFile()', () => {
  it('returns the ClaudeAdapter for a claude project file', () => {
    const registry = buildRegistry();
    const adapter = registry.forFile(CLAUDE_PATH);
    expect(adapter).toBeInstanceOf(ClaudeAdapter);
  });

  it('returns the CodexAdapter for a codex session file', () => {
    const registry = buildRegistry();
    const adapter = registry.forFile(CODEX_PATH);
    expect(adapter).toBeInstanceOf(CodexAdapter);
  });

  it('returns the PiAdapter for a pi session file', () => {
    const registry = buildRegistry();
    const adapter = registry.forFile(PI_PATH);
    expect(adapter).toBeInstanceOf(PiAdapter);
  });

  it('returns undefined for an unknown path', () => {
    const registry = buildRegistry();
    const adapter = registry.forFile(UNKNOWN_PATH);
    expect(adapter).toBeUndefined();
  });
});
