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
last_updated: 2026-06-27
---

# Setup

> New project — nothing is built yet. Most of this is [TO BE DETERMINED] and
> should be filled in after the first implementation lands.

## Prerequisites
- Node.js [TO BE DETERMINED — pin version]
- **ollama** installed and running, with the model pulled: `ollama pull nomic-embed-text`
- No system SQLite needed — better-sqlite3 bundles SQLite (with FTS5); the `sqlite-vec` npm package provides the extension binary loaded at runtime. [TO BE DETERMINED — confirm a prebuilt sqlite-vec binary exists for macOS arm64]

## First-time Setup
[TO BE DETERMINED — populate after first implementation. Expected shape:]
1. Install dependencies (`npm install` or chosen package manager)
2. Ensure ollama is running and `nomic-embed-text` is pulled
3. Initialise the SQLite index (schema + sqlite-vec + FTS5)
4. Run the indexer to backfill existing sessions
5. Start the web app / use the CLI

## Environment Variables
[TO BE DETERMINED — populate as variables are introduced. Likely candidates:]
- Session directory overrides (defaults: `~/.claude/projects/`, `~/.codex/sessions/`, `~/.pi/agent/sessions/`)
- Embedding model / runtime selection
- Path to the SQLite index file
Do not commit actual values.

## Common Commands
[TO BE DETERMINED — fill from package.json once it exists. Expected:]
- Run the indexer/watcher
- Run the web app (Vite dev server)
- Run the CLI
- Run tests / typecheck / lint

## Common Issues
[TO BE DETERMINED — record real issues as they occur, e.g. sqlite-vec extension fails to load, embedding runtime not running, a session format the adapter doesn't recognise.]
