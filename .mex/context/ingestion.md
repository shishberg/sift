---
name: ingestion
description: How session logs get watched, read, parsed, and queued into the index. Load when working on the watcher, byte-offset tailing, JSONL parsing, or what gets indexed.
triggers:
  - "watcher"
  - "chokidar"
  - "indexing"
  - "tail"
  - "offset"
  - "jsonl"
  - "queue"
  - "ingest"
edges:
  - target: context/agent-adapters.md
    condition: when the per-agent JSON schema or parsing is involved
  - target: context/architecture.md
    condition: when understanding where ingestion sits in the overall flow
  - target: context/search.md
    condition: when deciding what gets written to the vector vs FTS index
  - target: patterns/debug-indexing.md
    condition: when a session isn't being indexed correctly
last_updated: 2026-06-27
---

# Ingestion

## Watched directories
- `~/.claude/projects/`
- `~/.codex/sessions/`
- `~/.pi/agent/sessions/`

These hold append-only JSONL — one JSON object per line. They are READ ONLY.
opencode is excluded in V1 (its own SQLite DB, not JSONL).

## Trigger
A chokidar watcher over the directories above. On startup it also scans existing
files so the index backfills. New writes and existing files are handled the same
way. No agent hooks in V1 (see `context/decisions.md`).

## Change detection — byte-offset tail
Re-reading whole files on every write is wasteful. Track per-file state in a
`source_files` table:
- `path`, `inode`, `last_offset`, `last_size` (and agent type).

On a change event:
1. `fstat` the file.
2. If `size > last_offset`: open, read from `last_offset` to EOF, split into
   complete lines, parse, advance `last_offset`.
3. If `size < last_offset` or `inode` changed (truncation/rotation): re-scan from 0.
4. Hold back a trailing partial line (no newline yet) until the next write completes it.

## Parsing
Each new line is parsed by the agent adapter for that directory into the common
chunk shape. Ingestion itself does not know agent-specific JSON — that lives
entirely behind the adapter. See `context/agent-adapters.md`.

## What gets indexed
- **Embedding (vector index):** user + assistant text only. The semantic content. Embedded via ollama `nomic-embed-text` (768 dims); prefix indexed text with `search_document:`.
- **FTS5 (text index):** user + assistant text PLUS a compact text form of tool
  calls (tool name + key args). Cheap, and "which session ran X" is a real query.
- **Skip embedding tool calls** — noisy, inflates the vector table, low semantic value.
- Every chunk stores: session id, source file path, line number, role, timestamp.

[TO BE DETERMINED — populate after first implementation:]
- Exact chunking strategy (one message = one chunk? split long messages?).
- The precise compact tool-call representation for FTS.
- Whether/which tool results are worth indexing, and how to truncate them.
- Embedding batch size and backpressure for the queue.

## Queue
New parsed chunks are queued for embedding (user/assistant) and written to FTS.
[TO BE DETERMINED — queue durability, ordering, and crash recovery after first implementation.]
