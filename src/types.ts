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

/** One tool call in a faithful transcript: full input, and output once paired. */
export interface ToolDetail {
  name: string;
  /** Full args — a JSON string for object inputs, or the raw string. */
  input: string;
  /** Full result text; undefined until/unless a matching result is found. */
  output?: string;
  isError?: boolean;
}

/** A conversation-compaction event in a faithful transcript. */
export interface CompactionDetail {
  /** Human-readable summary of the compacted-away conversation. '' when the agent records none (e.g. codex). */
  summary: string;
  /** Approx token count before compaction, when the log records it. */
  tokensBefore?: number;
  /** What triggered it (e.g. 'manual', 'auto', 'hook'), when known. */
  trigger?: string;
}

/**
 * One item in a faithful session transcript, read from the raw log (not the
 * lossy search index). `text` holds untruncated prose for user/assistant; tool
 * items carry `tool` instead. `lineNumbers` lists every source log line this
 * item covers (a tool item covers its call line and its result line), so the
 * web view can match-and-scroll from a search result that hit either line.
 * A compaction item carries `compaction` (role is a placeholder 'user', text '').
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
