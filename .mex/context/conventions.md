---
name: conventions
description: How code is written in this project — naming, structure, patterns, and style. Load when writing new code or reviewing existing code.
triggers:
  - "convention"
  - "pattern"
  - "naming"
  - "style"
  - "how should I"
  - "what's the right way"
edges:
  - target: context/architecture.md
    condition: when a convention depends on understanding the system structure
  - target: context/agent-adapters.md
    condition: when writing per-agent code — it must stay behind the adapter interface
last_updated: 2026-06-30
---

# Conventions

## Naming
- TypeScript: `camelCase` for variables/functions, `PascalCase` for types/classes.
- Database columns: `snake_case` (e.g. `source_files`, `last_offset`, `needs_embed`).
- Agent type identifiers: stable lowercase strings (`claude`, `codex`, `pi`,
  `opencode`) used as keys in the adapter registry / agent_type column.

## Structure
- Agent-specific knowledge (on-disk format, JSON schema, paths) lives ONLY inside that agent's adapter. Indexing, search, CLI, and web never branch on agent type — they go through the adapter interface. See `context/agent-adapters.md`.
- Concerns are separate top-level dirs under `src/`: `adapters/`, `sources/`
  (non-JSONL, e.g. opencode), `ingest/` (watcher + indexer), `index/` (store),
  `embed/`, `search/`, `render/` (faithful transcript), `cli/`, `server/`. The
  web app is a separate Vite project under `web/`.
- Tests are colocated: `foo.ts` ↔ `foo.test.ts` in the same directory (vitest).

## Patterns
**Everything goes through the agent adapter interface.** No part of the system
outside `adapters/` should know what Claude vs Codex vs pi JSON looks like.
Adding an agent = adding an adapter, nothing else changes.

**Results always carry a source locator.** Every search result — CLI or web —
must include enough to find the original: session id at minimum, plus file path
and line number. A result an agent can't trace back to a log is a bug.
- Web: session id appears in the URL and is shown on results and the session view.
- CLI: session id is printed with each result; `--help` explains how to read a transcript from an id.

**Read-only, always.** Nothing in this codebase writes to or modifies agent
session logs. They are the source of truth.

**Plain string queries.** No filter/query syntax in V1. Take a string, search
both indexes, sort. Don't add query operators without an explicit decision.

**Safe-by-default for a public repo.** This repo is public, so committed
defaults must be safe and free of personal values (hostnames, paths). The web
dev server (`web/vite.config.ts`) defaults to `localhost` with no
`allowedHosts` override; LAN exposure is opt-in via `VITE_HOST` /
`VITE_ALLOWED_HOSTS`. Never hardcode a personal host into config.

## Verify Checklist
Before presenting any code:
- [ ] No agent-specific format logic leaked outside an adapter.
- [ ] Nothing writes to or mutates the agent session logs (read-only).
- [ ] Search results carry session id (+ file path / line number where applicable).
- [ ] No cloud embedding call introduced — embeddings stay local.
- [ ] CLI changes keep `--help` accurate and discoverable.
- [ ] `npm test` (vitest) and `npm run typecheck` (tsc --noEmit) pass. (No linter configured.)
