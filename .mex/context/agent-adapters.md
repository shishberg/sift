---
name: agent-adapters
description: The pluggable per-agent abstraction. Each agent type (claude, codex, pi) has an adapter that hides its on-disk format. Load when adding an agent or touching agent-specific parsing.
triggers:
  - "adapter"
  - "agent type"
  - "claude"
  - "codex"
  - "pi"
  - "schema"
  - "pluggable"
  - "new agent"
edges:
  - target: context/ingestion.md
    condition: when wiring an adapter into the watcher/parser
  - target: context/conventions.md
    condition: when checking the "everything goes through the adapter" rule
  - target: patterns/add-agent-adapter.md
    condition: when actually adding support for a new agent type
last_updated: 2026-06-28
---

# Agent Adapters

## Why this exists
Each agent (claude, codex, pi) writes sessions in its own JSON shape in its own
directory. The rest of the system — ingestion, search, CLI, web — must never
know those differences. All agent-specific knowledge lives behind one interface.
Adding an agent = adding an adapter; nothing else changes.

## What an adapter owns
- The directory it watches (e.g. `~/.claude/projects/`).
- Recognising/claiming a file as belonging to its agent.
- Parsing a raw JSONL line into the common chunk shape.
- Extracting: role (user/assistant/tool), text content, tool-call info, timestamp,
  session id, line number.
- `extractCwd(line)` — pull the session's working directory from a line if it
  carries one (claude: top-level `cwd` on every message; codex: `session_meta`
  payload `cwd`; pi: the `session` record `cwd`). The indexer captures the first
  hit per file into `source_files.cwd`. opencode (a DB source, not an adapter)
  reads `session.directory` instead.
- A stable agent type id (`claude`, `codex`, `pi`).

## Common chunk shape (the contract)
What every adapter produces, regardless of agent. [TO BE DETERMINED — lock the
exact fields/types after first implementation. Expected shape:]
- `agentType`, `sessionId`, `filePath`, `lineNumber`
- `role` (user | assistant | tool)
- `text` (natural-language content, for embedding when user/assistant)
- `toolCall` (compact name + key args, for FTS) — optional
- `timestamp`

## V1 adapters
- **claude** — `~/.claude/projects/` — [TO BE DETERMINED — document the JSON schema after inspecting real logs]
- **codex** — `~/.codex/sessions/` — [TO BE DETERMINED — document the JSON schema]
- **pi** — `~/.pi/agent/sessions/` — [TO BE DETERMINED — document the JSON schema]

## Registry
Adapters are registered so the watcher can pick the right one per directory/file.
[TO BE DETERMINED — define the registry/interface signature after first
implementation, then record it here so new adapters follow it.]

## Out of scope
- opencode (own SQLite DB, not JSONL) — not V1.
- Hooks-based ingestion — kept open as a future per-agent capability, but adapters
  are about parsing, not triggering.
