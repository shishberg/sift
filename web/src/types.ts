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
  /** Working directory the session ran in, relative to $HOME ('' if unknown). */
  cwd: string;
}

/** Mirror of backend ToolDetail. */
export interface ToolDetail {
  name: string;
  input: string;
  output?: string;
  isError?: boolean;
}

/** Mirror of backend CompactionDetail — a conversation-compaction event. */
export interface CompactionDetail {
  /** Human-readable summary of the compacted-away conversation. '' when the agent records none (e.g. codex). */
  summary: string;
  /** Approx token count before compaction, when the log records it. */
  tokensBefore?: number;
  /** What triggered it (e.g. 'manual', 'auto', 'hook'), when known. */
  trigger?: string;
}

/**
 * Mirror of backend TranscriptItem (faithful, log-derived). A compaction item
 * carries `compaction` (role is a placeholder 'user', text '').
 */
export interface TranscriptItem {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  tool?: ToolDetail;
  compaction?: CompactionDetail;
  filePath: string;
  lineNumbers: number[];
  timestamp: string;
}

export interface SessionResponse {
  sessionId: string;
  agentType: AgentType | null;
  filePath: string;
  /** Working directory the session ran in, relative to $HOME ('' if unknown). */
  cwd: string;
  items: TranscriptItem[];
}

export interface StatusResponse {
  total: number;
  embedded: number;
  pending: number;
}
