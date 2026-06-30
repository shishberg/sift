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
last_updated: 2026-06-30
compaction_render_updated: 2026-06-30
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
- **codex** — `~/.codex/sessions/`. Content (message `content` AND a
  `function_call_output`'s `output`) is EITHER a plain string OR an array of typed
  blocks (`input_text`/`output_text`/`input_image`/…). `blocksToText()` normalizes
  both to a string, keeping text blocks and dropping images — e.g. a `view_image`
  output is `[{type:'input_image', image_url:'data:…'}]`. Skipping this left
  `chunk.text` as an array object → SQLite "can only bind …" on insert.
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

## Subagent (sidechain) session keying — claude
Claude writes each subagent transcript to its own file at
`<project>/<parentSessionId>/subagents/agent-<agentId>.jsonl`. Every line in those
files carries `sessionId` = the **parent** session id (a back-reference) and
`isSidechain: true`. So the record's `sessionId` field is NOT that transcript's own
id. `src/adapters/claude.ts` keys sidechain records (`isSidechain === true`) by the
filename stem (`agent-<agentId>`) instead — each subagent becomes its own session.
Keying by the field instead would make `getSessionFiles(parentId)` return the main
log + every subagent log, and the faithful renderer would append all subagent
transcripts after the parent's last real message. The parent's own inline `Agent`
tool call + result (in the main file, `isSidechain: false`) correctly stay with the
parent. Re-index existing data to re-key rows indexed before this rule.

## Harness wrapper tags
Agents inject XML wrapper tags into the *user* turn to annotate harness activity.
`src/harness-tags.ts` holds a CLOSED registry (`HARNESS_TAGS`) mapping each known
tag to `unwrap` (drop tags, keep inner text) or `drop` (remove element + content).
`stripHarnessTags(text)` is a no-op unless a registry tag is present, so real
code/XML in messages is never touched. Applied to **user** text in both the
indexer (adapter) and the faithful renderer for each agent that needs it. The
registry is shared across agents — tag names are distinct, so cross-application is
harmless. Render is fixed immediately (reads raw logs); search snippets only
update for chunks indexed after this — re-index to clean existing rows.

Per agent (surveyed 2026-06-28):
- **claude** — slash-command invocations (`<command-name>`, `<command-message>`,
  `<command-args>` → unwrap) and local `!`-command output
  (`<local-command-stdout>`/`<local-command-stderr>` → unwrap;
  `<local-command-caveat>` → drop, pure boilerplate). Wired into
  `src/adapters/claude.ts` + `src/render/claude.ts`.
- **codex** — preamble blocks injected into the first user turn:
  `<environment_context>` (cwd/shell/date), `<collaboration_mode>`,
  `<skills_instructions>` → all `drop`. The AGENTS.md project preamble codex
  injects as `<INSTRUCTIONS>` is also `drop` (by request — it's the project's own
  AGENTS.md, a file already on disk, not conversation); the plain
  `# AGENTS.md instructions for <path>` header line that labels it sits outside
  the tag and is stripped by a dedicated regex (`AGENTS_MD_HEADER`) in
  `stripHarnessTags`. Wired into `src/adapters/codex.ts` + `src/render/codex.ts`.
  Note: the nested env tags (`cwd`, `shell`) are removed as part of the dropped
  block, NOT registered individually — they're too generic to strip on their own.
- **pi** — clean. No injected wrapper tags (stray `<command-name>` hits were file
  content inside tool results, not annotations). Not wired.
- **opencode** — clean. No systematic wrapper tags. Not wired.

## Conversation-compaction markers (render-only)
The faithful renderer (`src/render/`) emits a dedicated compaction item per
compaction event so the web view can show a collapsible block instead of a giant
message bubble. A compaction item is `{role:'user', text:'', compaction:
CompactionDetail, filePath, lineNumbers, timestamp}` (role is a placeholder; the
view branches on `item.compaction` before tool/message). `CompactionDetail` =
`{summary: string, tokensBefore?: number, trigger?: string}`.

Compaction summaries are also EXCLUDED from the search index (adapters/source),
not just specially rendered: they are machine-generated recaps that duplicate
content already in the log. claude (`src/adapters/claude.ts`: skip
`isCompactSummary === true`) and opencode (`src/sources/opencode.ts`: skip all
parts of a `summary:true` message, in both `index()` and `readTranscript`).
codex and pi never indexed theirs — their compaction record types aren't in
those adapters' indexed-type sets.

Per-agent markers (verified against real logs):
- **claude** — two adjacent records: a `{type:'system',
  subtype:'compact_boundary', compactMetadata:{trigger, preTokens}}` boundary,
  then a `{type:'user', isCompactSummary:true, message:{content}}` summary. The
  parser stashes the boundary metadata, then on the summary record emits ONE
  compaction item (summary = the user message text joined as normal but NOT
  run through `stripHarnessTags` — it's synthetic; tokensBefore = preTokens;
  trigger = trigger) and does NOT also emit a plain user bubble. A boundary with
  no following summary is tolerated (no crash).
- **pi** — `{type:'compaction', summary, tokensBefore, fromHook}` →
  `{summary, tokensBefore, trigger: fromHook ? 'hook' : undefined}`.
- **codex** — `{type:'compacted', payload:{message:'', replacement_history}}` →
  boundary-only item `{summary:''}` (codex records no clean summary). The
  separate `event_msg`/`payload.type:'context_compacted'` marker is ignored to
  avoid double-counting.
- **opencode** — an assistant `message` with `summary:true` (mode/agent
  'compaction'); its `text` part holds the recap. `readTranscript` emits one
  compaction item `{summary: text}` (no tokens/trigger — opencode records none)
  and skips the message's reasoning/step parts. `index()` skips all its parts.

## Out of scope
- Hooks-based ingestion — kept open as a future per-agent capability, but adapters
  are about parsing, not triggering.
