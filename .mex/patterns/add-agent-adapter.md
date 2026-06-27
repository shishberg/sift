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
last_updated: 2026-06-27
---

# Add an Agent Adapter

## Context
Read `context/agent-adapters.md` first — the whole point is that adding an agent
touches ONLY the adapter layer. If you find yourself editing ingestion, search,
CLI, or web to special-case the new agent, stop: that logic belongs in the adapter.

## Steps
1. Inspect real session files for the agent. Confirm it's append-only JSONL (if
   it's a SQLite DB or other format, it's a different, larger task — raise it).
2. Document its on-disk schema in `context/agent-adapters.md` (replace the
   `[TO BE DETERMINED]` for that agent).
3. Implement the adapter against the common interface: directory, file claiming,
   line → common chunk shape (role, text, tool-call, timestamp, sessionId,
   lineNumber, agentType).
4. Register the adapter so the watcher picks it up for its directory.
5. Backfill: run the indexer over existing files for that agent and confirm they
   land in the index.

## Gotchas
- Don't leak agent-specific JSON shapes past the adapter boundary. [VERIFY AFTER FIRST IMPLEMENTATION]
- Map roles correctly — only user/assistant text should be queued for embedding.
- Extract a stable session id; results depend on it to point back to the log.
- Watch for trailing partial lines (last line may have no newline yet).
- [VERIFY AFTER FIRST IMPLEMENTATION — confirm the exact interface/registry signature once it exists.]

## Verify
- [ ] No code outside the adapter branches on this agent type.
- [ ] Sessions for the new agent appear in search (both vector and FTS).
- [ ] Each result carries session id + file path + line number.
- [ ] Nothing wrote to the agent's logs.

## Debug
If sessions don't show up, follow `patterns/debug-indexing.md`.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if a new agent is now supported.
- [ ] Replace the `[TO BE DETERMINED]` schema for this agent in `context/agent-adapters.md`.
- [ ] If you hit a new recurring gotcha, update this pattern.
