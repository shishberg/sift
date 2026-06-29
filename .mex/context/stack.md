---
name: stack
description: Technology stack, library choices, and the reasoning behind them. Load when working with specific technologies or making decisions about libraries and tools.
triggers:
  - "library"
  - "package"
  - "dependency"
  - "which tool"
  - "technology"
edges:
  - target: context/decisions.md
    condition: when the reasoning behind a tech choice is needed
  - target: context/conventions.md
    condition: when understanding how to use a technology in this codebase
  - target: context/search.md
    condition: when working with sqlite-vec or FTS5
last_updated: 2026-06-30
---

# Stack

## Core Technologies
- **TypeScript** — single language across backend (indexer, CLI) and frontend, so there's no language split.
- **Node.js** — runtime for the watcher, indexer, and CLI. [TO BE DETERMINED — pin minimum version after first implementation]
- **SQLite** — the only datastore. One local file, no server.
- *Vue 3 + Vite* — web frontend framework and build tool.

## Key Libraries
- **sqlite-vec** — vector index for embedding search, inside SQLite.
- *FTS5* (SQLite built-in) — full-text search index.
- **chokidar** — cross-platform directory watcher for detecting new session writes. Chosen over agent hooks for V1 (agent-agnostic, handles existing files + new writes uniformly). See `context/decisions.md`.
- *shadcn-vue* — UI components for the web app.
- *markdown-it* — renders user/assistant message text as markdown in the web session view (`web/src/lib/markdown.ts`). Configured with `html: false`, so the output is safe to render with `v-html`.
- *ollama* — local embedding runtime (default). Model: *nomic-embed-text* (768 dims). Uses Metal GPU on Apple Silicon. Runs as a separate local service. Never a cloud embedding API.
- *fastembed* — alternative local embedder (`optionalDependencies`), in-process ONNX via onnxruntime-node — no separate service. Model: *bge-base-en-v1.5* (768 dims, matches the fixed sqlite-vec schema). Selected with `AGENT_SEARCH_EMBED_PROVIDER=fastembed`. `createEmbedder()` (`src/embed/factory.ts`) is the only place that picks a provider; everything else depends on the `Embedder` interface. The package is dynamic-`import()`ed and given an actionable "npm install fastembed" error if missing. fastembed's `passageEmbed`/`queryEmbed` apply the model's retrieval prefixes, so the fastembed embedder does NOT add the nomic `search_document:`/`search_query:` prefixes the ollama one does.
- **better-sqlite3** — SQLite driver. Synchronous, fast; loads the sqlite-vec extension via the `sqlite-vec` package's `load(db)` helper. FTS5 is built into SQLite. Chosen over node:sqlite (experimental) and node-sqlite3 (superseded).

## What We Deliberately Do NOT Use
- **No cloud embedding API** (OpenAI, Cohere, etc.) — embeddings are local only. Hard rule.
- **No separate backend language** — TypeScript both sides on purpose.
- **No heavyweight DB** (Postgres, a vector server like Qdrant/Pinecone) — SQLite is enough for a local, single-user, non-scaling tool.
- **No complex query language** — plain string queries only; ranking surfaces the best results.

## Version Constraints
[TO BE DETERMINED — populate once Node, SQLite, sqlite-vec, and the embedding model versions are pinned. Note any sqlite-vec / driver version coupling here.]
