---
name: add-agent-adapter
description: Add support for a new agent type by writing an adapter, without touching ingestion, search, CLI, or web.
triggers:
  - "new agent"
  - "add adapter"
  - "support codex"
  - "support pi"
  - "another agent type"
edges:
  - target: context/agent-adapters.md
    condition: to understand the adapter contract and common chunk shape
  - target: context/ingestion.md
    condition: to wire the adapter into the watcher and offset tracking
last_updated: 2026-06-28
---

# Add an Agent Adapter

## Context
Read `context/agent-adapters.md` first. Adding an agent touches two parallel
layers and nothing else: the **adapter** (`src/adapters/<agent>.ts`, what gets
indexed — truncated, embeddable chunks) and the **renderer**
(`src/render/<agent>.ts`, the faithful untruncated transcript). If you find
yourself editing ingestion, search, CLI, or web to special-case the new agent,
stop: that logic belongs in the adapter/renderer.

JSONL vs not: append-only JSONL → an adapter (file-watched). A SQLite DB or other
format → a polled **source** instead, modelled on `src/sources/opencode.ts`
(`OpenCodeSource`: read rows, emit the same chunk shape, persist a cursor, import
one-shot at index/watch/serve startup). Not the same as an adapter, but a known
path now — not a blocker.

## Steps
1. Inspect real session files for the agent and document its on-disk schema in
   `context/agent-adapters.md`.
2. Implement the adapter against the `Adapter` interface (`src/adapters/types.ts`):
   `agentType`, `rootDir`, `claims(filePath)`, `parseLine(line, ctx)` → common
   chunk shape (role, text, tool-call, timestamp, sessionId, lineNumber,
   agentType), and `extractCwd(line)`.
3. Register it in `buildRegistry()` (`src/adapters/registry.ts`) so the watcher
   picks it up for its directory.
4. Add a renderer in `src/render/<agent>.ts` (pair tool calls with their output,
   keep text untruncated) and wire it into `src/render/transcript.ts`.
5. Check for harness-injected wrapper tags in user turns (see Gotchas) and handle
   them via the shared registry.
6. Backfill: run the indexer over existing files for that agent and confirm they
   land in the index and render in the web view.

## Gotchas
- Don't leak agent-specific JSON shapes past the adapter/renderer boundary.
- Map roles correctly — only user/assistant text should be queued for embedding.
- Extract a stable session id; results depend on it to point back to the log.
- Watch for trailing partial lines (last line may have no newline yet).
- **Harness wrapper tags:** agents inject XML annotations into *user* turns
  (claude's `<command-name>`/`<local-command-*>`, codex's `<environment_context>`
  etc.). If the new agent does this, add the tag names to `HARNESS_TAGS` in
  `src/harness-tags.ts` (`unwrap` keeps inner text, `drop` removes the block) and
  call `stripHarnessTags` on user text in BOTH the adapter and the renderer. The
  registry is shared; it's a no-op unless a registered tag is present.

## Verify
- [ ] No code outside the adapter/renderer branches on this agent type.
- [ ] Sessions for the new agent appear in search (both vector and FTS).
- [ ] Each result carries session id + file path + line number.
- [ ] The web transcript renders (tool calls paired with output).
- [ ] Nothing wrote to the agent's logs.

## Debug
If sessions don't show up, follow `patterns/debug-indexing.md`.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if a new agent is now supported.
- [ ] Document this agent's schema (and any harness tags) in `context/agent-adapters.md`.
- [ ] If you hit a new recurring gotcha, update this pattern.
