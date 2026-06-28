---
name: decisions
description: Key architectural and technical decisions with reasoning. Load when making design choices or understanding why something is built a certain way.
triggers:
  - "why do we"
  - "why is it"
  - "decision"
  - "alternative"
  - "we chose"
edges:
  - target: context/architecture.md
    condition: when a decision relates to system structure
  - target: context/stack.md
    condition: when a decision relates to technology choice
last_updated: 2026-06-27
---

# Decisions

<!-- When a decision changes: do not delete the old entry. Mark it superseded,
     add the new entry above it. History is the event clock. -->

## Decision Log

### opencode now supported via a read-only SQLite "source" (no longer V1-excluded)
*Date:* 2026-06-27
*Status:* Active
*Decision:* Index opencode sessions by reading its SQLite DB
(`~/.local/share/opencode/opencode.db`) directly, read-only, through a parallel
**source** abstraction (`src/sources/opencode.ts`) — NOT the JSONL adapter/tail/
watcher path. The source queries opencode's `part`+`message` tables, maps rows to
the common `Chunk` shape (`agentType: 'opencode'`), and feeds the same store +
embedding queue. Incremental via an `opencode_cursor` (max rowid) in `meta`;
inserts + cursor advance are one transaction (idempotent). The CLI `index`/`watch`
commands import opencode alongside the JSONL dirs.
*Reasoning:* The user asked for opencode support. Its sessions live in a live
SQLite DB, not append-only JSONL, so the file-watcher/byte-offset model doesn't
apply — but a read-only query path is straightforward and keeps all
opencode-specific knowledge behind one module (same boundary principle as adapters).
**Supersedes:** the earlier "No opencode support in V1" note (it used its own DB,
not JSONL). That reasoning still explains why it's a *source*, not an *adapter*.
*Consequences:* `agentType` union is `claude|codex|pi|opencode`; adapters stay
`claude|codex|pi` (`JsonlAgentType`). opencode.db is opened `{ readonly: true }`
(WAL allows concurrent reads while opencode runs). Never written to.

### Persistent embedding queue decouples ingestion from embedding
*Date:* 2026-06-27
*Status:* Active
*Decision:* Ingestion writes the `chunks` row + FTS immediately and marks
user/assistant text chunks with `needs_embed = 1`. A single-flight in-process
consumer drains pending chunks in batches — embed via ollama, write the vec row,
set `needs_embed = 0` — in a transaction. Ingestion never blocks on embedding.
Failed embeds keep `needs_embed = 1` and retry on the next drain.
*Reasoning:* Agent logs can be written faster than embedding (the slow step)
can keep up. Persisting the pending state in the DB makes it crash-safe (pending
chunks survive a restart) and gives natural backpressure — the watcher just
appends rows; the consumer catches up independently. This is the user's
"text row with a NULL vector FK, drained by a single-flight consumer" idea,
implemented as an indexed flag column.
*Alternatives considered:* Inline embedding in addChunk (rejected — blocks
ingestion, loses progress on crash); an external job queue (rejected — overkill
for a local single-user tool, SQLite is the queue).
*Consequences:* `chunks.needs_embed` column + partial index. Store exposes
`takePendingEmbeds`, `setEmbedding`, `queueStats`. **Backfill is NOT a separate
operation** — it's the watcher's startup scan writing rows, drained by the same
consumer. Progress = `queueStats() {total, embedded, pending}`.

### Queue progress is surfaced in both CLI and web
*Date:* 2026-06-27
*Status:* Active
*Decision:* `queueStats()` drives a progress indicator in both interfaces.
CLI: an `agent-search status` command + a live progress bar during index/watch.
Web: `GET /api/status` returns the stats; the app polls it and renders the
shadcn-vue `Progress` component. Covers backfill automatically (it's just the
queue draining).
*Reasoning:* The user wants visibility into indexing/embedding progress,
especially during the initial large backfill.
*Consequences:* Web stack is Vue 3 + Vite + shadcn-vue + Tailwind 4.

### Reciprocal Rank Fusion (RRF) to merge vector + FTS results
*Date:* 2026-06-27
*Status:* Active
*Decision:* Merge the sqlite-vec and FTS5 result lists with RRF — rank-based, `score = Σ 1/(k + rank)`, k ≈ 60 — and sort by the combined score.
*Reasoning:* Vector distance and FTS5 BM25 scores aren't on comparable scales, so blending raw scores needs normalization and tuning. RRF uses only rank positions, so it's robust out of the box and the standard hybrid-search default.
*Alternatives considered:* Weighted score blend (normalize + α weight) — rejected for now, more tuning and outlier-sensitive; simple interleave — rejected, too crude though fine as a fallback.
*Consequences:* No score normalization needed. One tuning knob (k). Validate on real session-log queries after first implementation; only move to weighted blending if RRF underperforms.

### better-sqlite3 as the SQLite driver
*Date:* 2026-06-27
*Status:* Active
*Decision:* Use better-sqlite3 to open the database, load the sqlite-vec extension (`sqliteVec.load(db)`), and run FTS5.
*Reasoning:* It's what sqlite-vec's docs target, it's the most popular/maintained Node driver, and its synchronous API suits a local indexer + single-user web app where blocking the event loop doesn't matter.
*Alternatives considered:* node:sqlite (built-in, zero-dep) — rejected, experimental and needs very recent Node; node-sqlite3/mapbox — rejected, superseded and clunkier; libsql — rejected, a different engine that would partly reopen the SQLite + sqlite-vec storage decision.
*Consequences:* Native module — confirm a prebuilt `sqlite-vec` binary exists for the target platform (macOS arm64) to avoid a build step. Synchronous DB calls throughout.

### ollama with nomic-embed-text as the default embedder
*Date:* 2026-06-27
*Status:* Active
*Decision:* Use ollama as the local embedding runtime, model `nomic-embed-text` (768 dims). Keep the embedder behind an interface so other implementations can be swapped in.
*Reasoning:* On Apple Silicon ollama uses Metal GPU, so a large initial backfill and bigger models stay fast. Easy model management. nomic-embed-text is a strong, widely-used local retrieval model.
*Alternatives considered:* fastembed (in-process, CPU-only via onnxruntime-node) — simpler, no daemon, but no GPU; kept as a future swappable option. Cloud embedding APIs — rejected (hard rule, see below).
*Consequences:* ollama is a prerequisite and a separate service that must be running to index (failure mode covered in `patterns/debug-indexing.md`). Vector dimension is 768; store the model + dims in the index so a model change triggers a reindex. nomic-embed-text expects task prefixes (`search_document:` for indexed text, `search_query:` for queries) — apply consistently.

### Local embeddings only, never a cloud API
*Date:* 2026-06-27
*Status:* Active
*Decision:* All embeddings are produced on-device (ollama or fastembed or the best local option). No cloud embedding service.
*Reasoning:* Session logs are private working data; sending them to a third party is unacceptable. Hard rule.
*Alternatives considered:* Cloud embedding APIs (OpenAI, Cohere) — rejected, privacy and the hard rule.
*Consequences:* Embedding quality and model choice are bounded by what runs locally. The local runtime is a prerequisite to index anything.

### Read-only index — never modify session logs
*Date:* 2026-06-27
*Status:* Active
*Decision:* The agent's session log is the source of truth. This project only reads and indexes; it never writes, edits, or resumes sessions.
*Reasoning:* Corrupting an agent's own record would be worse than having no index. Keeps the tool safe to run continuously.
*Alternatives considered:* A richer tool that could resume/replay chats — rejected, out of scope and risky.
*Consequences:* No write path exists. The web/CLI are viewers, not controllers.

### SQLite with sqlite-vec + FTS5 as the only datastore
*Date:* 2026-06-27
*Status:* Active
*Decision:* One SQLite file holds both the vector index (sqlite-vec) and the text index (FTS5).
*Reasoning:* Local, single-user, doesn't need to scale. SQLite is lightweight, file-based, and can do both vector and full-text search in one place.
*Alternatives considered:* Postgres + pgvector, a dedicated vector DB (Qdrant/Pinecone) — rejected, operational weight far beyond what a local tool needs.
*Consequences:* Both search modes share one store and one transaction model. Bound by SQLite/sqlite-vec limits; fine at this scale.

### TypeScript across the whole stack
*Date:* 2026-06-27
*Status:* Active
*Decision:* Backend (watcher, indexer, CLI) and frontend are all TypeScript.
*Reasoning:* A web frontend is wanted for browsing; using one language avoids a backend/frontend language split.
*Alternatives considered:* A separate backend language (Python, Go) with a JS frontend — rejected to avoid the split.
*Consequences:* Shared types between indexer and frontend are possible. Node is the runtime everywhere.

### Directory watching over agent hooks for V1
*Date:* 2026-06-27
*Status:* Active
*Decision:* Index by watching the session directories (chokidar). Do not use agent hooks in V1.
*Reasoning:* Watching is agent-agnostic — one mechanism covers all agents, indexes existing files on startup and new writes the same way. Hooks must be configured per-agent and only fire for agents that were wired up.
*Alternatives considered:* Agent hooks — kept open as a future addition (especially for opencode, which isn't append-only JSONL), but not V1.
*Consequences:* The watcher is the single ingestion trigger. A hook-based path can be added later without changing the index or adapters.
