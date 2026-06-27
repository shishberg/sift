/** All agent types that can appear in the index. Mirrors src/types.ts AgentType. */
export type AgentType = 'claude' | 'codex' | 'pi' | 'opencode';

/** Mirror of the backend SearchResult shape. */
export interface SearchResult {
  sessionId: string;
  agentType: AgentType;
  filePath: string;
  lineNumber: number;
  role: 'user' | 'assistant' | 'tool';
  snippet: string;
  timestamp: string;
  score: number;
}

/** Mirror of the backend Chunk shape. */
export interface Chunk {
  agentType: AgentType;
  sessionId: string;
  filePath: string;
  lineNumber: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  toolCall?: { name: string; args: string };
  timestamp: string;
}

export interface SessionResponse {
  sessionId: string;
  filePath: string;
  chunks: Chunk[];
}

export interface StatusResponse {
  total: number;
  embedded: number;
  pending: number;
}
