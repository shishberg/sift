---
name: architecture
description: How the major pieces of this project connect and flow. Load when working on system design, integrations, or understanding how components interact.
triggers:
  - "architecture"
  - "system design"
  - "how does X connect to Y"
  - "integration"
  - "flow"
edges:
  - target: context/stack.md
    condition: when specific technology details are needed
  - target: context/decisions.md
    condition: when understanding why the architecture is structured this way
  - target: context/ingestion.md
    condition: when working on the watcher, parsing, or how sessions get into the index
  - target: context/search.md
    condition: when working on querying, ranking, or how results come out
  - target: context/agent-adapters.md
    condition: when working with per-agent schema or formats
last_updated: 2026-06-27
---

# Architecture

## System Overview
Two flows over one SQLite database.

**Index flow:** a directory watcher (chokidar) watches the agent session
directories → on a new write it reads only the appended bytes of the changed
JSONL file (byte-offset tail) → the matching agent adapter parses the new lines
into a common shape → user/assistant text is queued for local embedding and
written to the vector index; user/assistant text plus a compact form of tool
calls is written to the FTS5 index. Every indexed chunk carries its session id,
source file path, and line number.

**Search flow:** a plain string query hits both indexes (vector via sqlite-vec,
text via FTS5) → results are interleaved and sorted → returned to one of two
read-only interfaces: the CLI (for agents) and the web app (Vue/Vite). Both
surface enough identity (session id, file path) to find the original log.

## Key Components
- **Watcher** — watches the agent session dirs, detects appends, hands changed files to ingestion. Depends on chokidar. See `context/ingestion.md`.
- **Agent adapters** — one per agent type (claude, codex, pi). Hide each agent's on-disk format behind a common interface so the rest of the system never sees agent-specific JSON. See `context/agent-adapters.md`.
- **Index store** — SQLite with sqlite-vec (embeddings) and FTS5 (text). Holds chunks plus a `source_files` table tracking byte offsets. See `context/search.md`.
- **Embedder** — local only. Default: ollama running `nomic-embed-text` (768 dims). Turns user/assistant text into vectors. Behind an interface so it's swappable. Never a cloud API.
- **CLI** — agent-facing read-only search with good `--help`. See `patterns/add-cli-command.md`.
- **Web app** — Vue/Vite/shadcn-vue read-only search and session browsing.

## External Dependencies
- **Agent session logs** (`~/.claude/projects/`, `~/.codex/sessions/`, `~/.pi/agent/sessions/`) — append-only JSONL written by the agents. READ ONLY. Source of truth. We index them, never write them.
- **Local embedding runtime** (ollama or fastembed) — produces embeddings on-device. No network/cloud embedding service, ever.
- **SQLite** (with sqlite-vec + FTS5) — the only datastore. Lightweight, local, single-file.

## What Does NOT Exist Here
- No write path to agent sessions — read-only, the agent owns the logs.
- No chat resume / replay — this indexes and displays, it does not drive agents.
- No cloud services, no auth, no multi-user, no hosted/remote deployment — local single-user tool.
- opencode is supported, but via a read-only **source** that reads its SQLite DB
  directly (`src/sources/opencode.ts`) — not the JSONL adapter/watcher path. See
  `context/decisions.md`.
- No agent hooks in V1 — directory watching is the only trigger (hooks kept open for later, esp. opencode).
