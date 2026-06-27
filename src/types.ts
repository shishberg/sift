/** All agent types that can appear in the index (includes opencode which uses a DB source). */
export type AgentType = 'claude' | 'codex' | 'pi' | 'opencode';

/**
 * Agent types that are backed by JSONL log files and go through the Adapter interface.
 * opencode is excluded — it uses a SQLite source (OpenCodeSource), not an Adapter.
 */
export type JsonlAgentType = 'claude' | 'codex' | 'pi';

export type Role = 'user' | 'assistant' | 'tool';

export interface Chunk {
  agentType: AgentType;
  sessionId: string;
  filePath: string;
  lineNumber: number; // 1-based line in the file
  role: Role;
  text: string; // natural-language content; '' if none
  toolCall?: { name: string; args: string }; // compact form for FTS; args is a short string
  timestamp: string; // ISO 8601; best-effort from the record
}
