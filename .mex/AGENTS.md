---
name: agents
description: Always-loaded project anchor. Read this first. Contains project identity, non-negotiables, commands, and pointer to ROUTER.md for full context.
last_updated: 2026-06-27
---

# sift

## What This Is
A searchable index of agent session logs (Claude, Codex, pi) with local CLI and web search.

## Non-Negotiables
- Never modify agent session logs — they are the source of truth; this is only an index. Read-only.
- Never use a cloud embedding API — embeddings are local only (ollama / fastembed / best local option).
- Keep agent types pluggable — all agent-specific format knowledge stays behind the adapter interface.
- Plain string queries only — no complex query/filter syntax.
- Every result must carry its session id so the original log can be found.

## Commands
Backend/CLI (root `package.json`):
- `npm test` — run the vitest suite. `npm run typecheck` — `tsc --noEmit`. `npm run build` — compile to `dist/`.
- `node dist/cli/cli.js <query>` — search. `... show <sessionId>` — print a transcript.
  `... index` — one-shot backfill + drain embed queue. `... watch` — watch + keep indexing.
  `... status` — queue progress. `... serve [--port N] [--watch]` — HTTP API + web app.
  (After `npm link` or via the `sift` bin once installed.)
Web (`web/package.json`): `npm run web:dev` — Vite dev server. `npm run web:build` — build to `web/dist/`.
Prereq: ollama running with `nomic-embed-text` pulled (local embeddings).

## Scaffold Growth
After meaningful work, run GROW:
- Ground: what changed in reality?
- Record: update `ROUTER.md` and relevant `context/` files
- Orient: create or update a `patterns/` runbook if this can recur
- Write: bump `last_updated` on changed scaffold files and run `mex log` when rationale matters

The scaffold grows from real work, not just setup. See the GROW step in `ROUTER.md` for details.

## Navigation
At the start of every session, read `ROUTER.md` before doing anything else.
For full project context, patterns, and task guidance — everything is there.
