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
last_updated: 2026-06-28
---

# Ingestion

## Watched directories
- `~/.claude/projects/`
- `~/.codex/sessions/`
- `~/.pi/agent/sessions/`

These hold append-only JSONL — one JSON object per line. They are READ ONLY.
The watched dirs are derived from the adapters' `rootDir`s (override with
`AGENT_SEARCH_DIRS`). opencode is also indexed, but NOT via the watcher — it's a
SQLite DB read by `OpenCodeSource` as a one-shot import at startup (see
`context/agent-adapters.md`).

## Trigger
A chokidar watcher over the directories above. On startup it also scans existing
files so the index backfills. New writes and existing files are handled the same
way. No agent hooks in V1 (see `context/decisions.md`).

## Change detection — byte-offset tail
Re-reading whole files on every write is wasteful. Track per-file state in a
`source_files` table (snake_case columns):
- `path`, `agent_type`, `inode`, `last_offset`, `last_size`, `last_line_number`,
  `cwd`.

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

Chunking & truncation (see `src/text.ts`):
- One message / text block = one chunk; no further splitting.
- Tool calls: a `tool` chunk with text `name(args)`, args truncated to
  `TOOL_ARGS_MAX` (200) — FTS-only, not embedded.
- Tool results: a `tool` chunk, text truncated to `TOOL_RESULT_MAX` (500) —
  FTS-only.

## Queue
The embedding queue IS the index: chunks are written with `needs_embed = 1`, and a
single-flight consumer (`EmbedWorker`) drains `chunks WHERE needs_embed = 1`,
writes the sqlite-vec row, and clears the flag — atomically. Durable across
restarts because it's just a column in SQLite; backfill is the watcher's startup
scan re-enqueueing anything unembedded. `sift status` reports total /
embedded / pending.
