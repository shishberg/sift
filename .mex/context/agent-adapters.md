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

## V1 sources
JSONL adapters (file-watched):
- **claude** — `~/.claude/projects/`
- **codex** — `~/.codex/sessions/`
- **pi** — `~/.pi/agent/sessions/`

Non-JSONL source (polled, not an adapter):
- **opencode** — SQLite DB at `~/.local/share/opencode/opencode.db`. Read by
  `src/sources/opencode.ts` (`OpenCodeSource`), one-shot import at index/watch/
  serve startup with a persisted cursor. cwd comes from `session.directory`. Not
  in the adapter registry because it isn't a watched JSONL file.

## Registry
Adapters are registered so the watcher can pick the right one per directory/file.
[TO BE DETERMINED — define the registry/interface signature after first
implementation, then record it here so new adapters follow it.]

## Harness wrapper tags (claude)
Claude Code injects XML wrapper tags into the *user* turn to annotate harness
activity: slash-command invocations (`<command-name>`, `<command-message>`,
`<command-args>`) and local `!`-command output (`<local-command-stdout>`,
`<local-command-stderr>`, `<local-command-caveat>`). `src/harness-tags.ts` holds
a CLOSED registry (`HARNESS_TAGS`) mapping each tag to `unwrap` (drop tags, keep
inner text) or `drop` (remove element + content; the caveat is pure boilerplate).
`stripHarnessTags(text)` is a no-op unless a registry tag is present, so real
code/XML in messages is never touched. Applied to user text in BOTH the claude
adapter (`src/adapters/claude.ts`, indexed text) and the faithful renderer
(`src/render/claude.ts`, transcript view). Render is fixed immediately (reads raw
logs); search snippets only update for chunks indexed after this — re-index to
clean existing rows. Add new harness tags to the registry; nothing else changes.

Other agents (surveyed 2026-06-28):
- **codex** injects an `<environment_context>` block (`<cwd>`/`<shell>`/
  `<current_date>`/`<timezone>`) plus an AGENTS.md/`user_instructions` preamble
  into a synthetic first user message — its own harness noise, a different shape
  from claude's. NOT yet stripped (the registry is wired only into the claude
  path). If we tackle it, drop it codex-side only — the nested tag names (`cwd`,
  `shell`) are too generic to strip globally.
- **pi** — clean. No injected wrapper tags (stray `<command-name>` hits were file
  content inside tool results, not annotations).
- **opencode** — clean. No systematic wrapper tags.

## Out of scope
- Hooks-based ingestion — kept open as a future per-agent capability, but adapters
  are about parsing, not triggering.
