import type { TranscriptItem } from '../types.js';
import { parseClaudeTranscript } from './claude.js';
import { parseCodexTranscript } from './codex.js';
import { parsePiTranscript } from './pi.js';

export interface TranscriptDeps {
  getSessionFiles(sessionId: string): { filePath: string; agentType: string }[];
  readFile(path: string): string;
  /** Returns the full opencode transcript for the session (DB-backed). */
  openTranscript(sessionId: string): TranscriptItem[];
}

/**
 * Build a faithful transcript for a session from its raw log file(s). The index
 * only tells us which files belong to the session; content comes from the logs.
 */
export function readTranscript(sessionId: string, deps: TranscriptDeps): TranscriptItem[] {
  const files = deps.getSessionFiles(sessionId);
  const out: TranscriptItem[] = [];
  let openHandled = false;

  for (const { filePath, agentType } of files) {
    if (agentType === 'opencode') {
      if (!openHandled) {
        out.push(...deps.openTranscript(sessionId));
        openHandled = true;
      }
      continue;
    }
    let body: string;
    try {
      body = deps.readFile(filePath);
    } catch {
      continue; // log file gone/unreadable — skip it
    }
    const lines = body.split('\n');
    if (agentType === 'claude') out.push(...parseClaudeTranscript(lines, filePath));
    else if (agentType === 'codex') out.push(...parseCodexTranscript(lines, filePath));
    else if (agentType === 'pi') out.push(...parsePiTranscript(lines, filePath));
  }

  return out;
}
