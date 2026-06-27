import type { Adapter, Registry } from './types.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { PiAdapter } from './pi.js';

/**
 * Build a registry containing all three agent adapters.
 * forFile() returns the first adapter whose claims() returns true for that path.
 */
export function buildRegistry(): Registry {
  const adapters: Adapter[] = [new ClaudeAdapter(), new CodexAdapter(), new PiAdapter()];

  return {
    adapters,
    forFile(filePath: string): Adapter | undefined {
      return adapters.find((a) => a.claims(filePath));
    },
  };
}
