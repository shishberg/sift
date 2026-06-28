---
name: agents
description: Always-loaded project anchor. Read this first. Contains project identity, non-negotiables, commands, and pointer to ROUTER.md for full context.
last_updated: 2026-06-28
---

# agent-search

## What This Is
A local tool that indexes agent session logs (Claude, Codex, pi, opencode) into a single SQLite hybrid (vector + full-text) index and searches them from a CLI and a web app.

## Non-Negotiables
- READ-ONLY on session logs — never write to or modify the agents' log files; they are the source of truth.
- Embeddings stay LOCAL (ollama) — never call a cloud embedding API.
- Agent-specific format logic lives ONLY in `src/adapters/` (JSONL) or `src/sources/` (non-JSONL); nothing else branches on agent type.
- Every search result must carry a source locator: session id (+ file path / line number) so it traces back to the log.
- Plain string queries only — no query/filter syntax without an explicit decision.

## Commands
- Build: `npm run build` (tsc → `dist/`)
- Test: `npm test` (vitest) · Types: `npm run typecheck`
- Index / watch: `agent-search index` · `agent-search watch` · `agent-search status`
- Search / read: `agent-search <query> [--limit N] [--format json]` · `agent-search show <id> [--tools]`
- Web: `agent-search serve [--port N] [--watch]` · dev frontend `npm run web:dev`

## After Every Task
After meaningful work, run GROW:
- Ground: what changed in reality?
- Record: update `.mex/ROUTER.md` and relevant `.mex/context/` files
- Orient: create or update a `.mex/patterns/` runbook if this can recur
- Write: bump `last_updated` on changed scaffold files and run `mex log` when rationale matters

## Navigation
At the start of every session, read `.mex/ROUTER.md` before doing anything else.
For full project context, patterns, and task guidance — everything is there.
