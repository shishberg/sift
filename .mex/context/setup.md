---
name: setup
description: Dev environment setup and commands. Load when setting up the project for the first time or when environment issues arise.
triggers:
  - "setup"
  - "install"
  - "environment"
  - "getting started"
  - "how do I run"
  - "local development"
edges:
  - target: context/stack.md
    condition: when specific technology versions or library details are needed
  - target: context/ingestion.md
    condition: when configuring which session directories get watched
last_updated: 2026-06-28
---

# Setup

## Prerequisites
- Node.js >= 20 (see `package.json` engines).
- *ollama* installed and running, with the model pulled: `ollama pull nomic-embed-text`.
- No system SQLite needed — better-sqlite3 bundles SQLite (with FTS5); the
  `sqlite-vec` npm package provides the extension binary, loaded at runtime.

## First-time Setup
1. `npm install`
2. `npm run build` (compiles `src/` → `dist/`; the `sift` bin points at
   `dist/cli/cli.js`).
3. Ensure ollama is running and `nomic-embed-text` is pulled.
4. `node dist/cli/cli.js index` (or `sift index` if linked) — backfills
   existing sessions and drains the embedding queue. The index DB is created at
   `~/.sift/index.db` (WAL mode).
5. Use the CLI (`… <query>`, `… show <id>`) or run `… serve` for the web app.
   For the web frontend in dev: `npm run web:dev`.

## Environment Variables
- `SIFT_DB` — path to the SQLite index file (default `~/.sift/index.db`).
- `AGENT_SEARCH_DIRS` — colon-separated list of dirs to watch, overriding the
  defaults (`~/.claude/projects/`, `~/.codex/sessions/`, `~/.pi/agent/sessions/`).
  `~` is expanded. opencode is read separately from its SQLite DB.
- `AGENT_SEARCH_PORT` — port for `serve` (default 3737; `--port` also works).
- `NO_COLOR` — disables ANSI colour in CLI search output.
Do not commit actual values.

## Common Commands
- Index / watch: `sift index`, `sift watch`, `sift status`
- Search / read: `sift <query> [--limit N] [--format json] [--cwd PATH | --all]`, `sift show <id> [--tools]`
  (search defaults to the current directory's sessions; `--all` searches everywhere, `--cwd PATH` scopes elsewhere)
- Web app: `sift serve [--port N] [--watch]`; dev frontend `npm run web:dev`, build `npm run web:build`
- Tests / types: `npm test` (vitest), `npm run test:watch`, `npm run typecheck`

## Common Issues
- **ollama not running** → embeddings stop (clear error: "Is ollama running?
  Start it with: ollama serve"). FTS5 search still works on already-indexed text.
- **Embed model mismatch** → search/index abort with a guard error if the index
  was built with a different model than the current embedder.
- **A session shows raw harness tags in old search snippets** → re-index; the
  renderer strips them live but indexed chunks only update on re-index.
- For "session not indexed / not in search", follow `patterns/debug-indexing.md`.
