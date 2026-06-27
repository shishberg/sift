export type Role = 'user' | 'assistant' | 'tool';

export interface Chunk {
  agentType: 'claude' | 'codex' | 'pi' | 'opencode';
  sessionId: string;
  filePath: string;
  lineNumber: number; // 1-based line in the file
  role: Role;
  text: string; // natural-language content; '' if none
  toolCall?: { name: string; args: string }; // compact form for FTS; args is a short string
  timestamp: string; // ISO 8601; best-effort from the record
}
