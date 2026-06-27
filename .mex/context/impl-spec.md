---
name: impl-spec
description: Concrete implementation spec for the first build — locked conventions, project layout, and the exact on-disk log formats for each agent adapter. Load when implementing any component.
last_updated: 2026-06-27
---

# Implementation Spec (V1 build)

This is the concrete build contract derived from the design in `architecture.md`,
`decisions.md`, `ingestion.md`, `search.md`, and `agent-adapters.md`. Read those for
the *why*; this file is the *what/how* for the first implementation. Everything here
is a locked decision unless marked OPEN.

## Locked conventions
- **Language/runtime:** TypeScript, ESM (`"type": "module"`), Node 20+.
- **Package manager:** npm.
- **Test runner:** vitest. Tests are co-located: `foo.ts` → `foo.test.ts`.
- **TDD is mandatory** (see `superpowers:test-driven-development`): red → green → refactor.
- **TS style:** camelCase for vars/functions, PascalCase for types/interfaces.
- **DB columns:** snake_case.
- **Agent type ids:** lowercase strings `claude` | `codex` | `pi`.
- **No cloud calls** anywhere. Embeddings local only.
- **Read-only:** never open a session log for writing.

## Project layout
```
package.json, tsconfig.json, vitest.config.ts
src/
  types.ts            # Chunk shape + shared types (the adapter contract)
  adapters/
    types.ts          # Adapter interface + registry types
    registry.ts       # buildRegistry(); pick adapter by dir/file
    claude.ts
    codex.ts
    pi.ts
  index/
    store.ts          # open db, load sqlite-vec, schema, FTS5, source_files
  ingest/
    tail.ts           # byte-offset tail reader (pure, testable)
    indexer.ts        # parse new lines -> embed -> write to store
    watcher.ts        # chokidar wiring + startup backfill
  embed/
    types.ts          # Embedder interface
    ollama.ts         # ollama nomic-embed-text impl
  search/
    search.ts         # vector + FTS query, RRF fusion, result shape
  cli/
    cli.ts            # entrypoint (search, show, --help)
  server/
    server.ts         # minimal HTTP API for the web app (/api/search, /api/session/:id)
web/                  # Vue 3 + Vite + shadcn-vue app
```

## Common chunk shape (the adapter contract)
A parsed chunk is one indexable unit produced by an adapter from one JSONL line.
```ts
type Role = 'user' | 'assistant' | 'tool';
interface Chunk {
  agentType: 'claude' | 'codex' | 'pi';
  sessionId: string;
  filePath: string;
  lineNumber: number;      // 1-based line in the file
  role: Role;
  text: string;            // natural-language content; '' if none
  toolCall?: { name: string; args: string }; // compact form for FTS; args is a short string
  timestamp: string;       // ISO 8601; best-effort from the record
}
```
A single JSONL line may yield 0, 1, or several chunks (e.g. an assistant message with
both text and tool_use blocks → one text chunk + one tool chunk). Adapters return
`Chunk[]` per line.

**Embedding rule:** embed `text` for `role` user/assistant only. Skip tool chunks and
empty text. **FTS rule:** index `text` plus, for tool chunks, `name + args`.

## Adapter interface
```ts
interface Adapter {
  agentType: 'claude' | 'codex' | 'pi';
  /** Absolute dir this adapter owns (expanded ~). */
  rootDir: string;
  /** True if this file path belongs to this agent. */
  claims(filePath: string): boolean;
  /** Parse one raw JSONL line into 0+ chunks. ctx carries filePath + lineNumber + any per-file state. */
  parseLine(line: string, ctx: { filePath: string; lineNumber: number }): Chunk[];
}
```
Session id: prefer an id carried on the record; otherwise derive from the filename
(see per-agent notes). Adapters must be pure and side-effect-free (no disk writes).

---

## CLAUDE format — `~/.claude/projects/<project-slug>/<sessionId>.jsonl`
- Filename (minus `.jsonl`) is the session id; also present as `sessionId` on most records.
- Each record has a top-level `type`. **Index only `type` `user` and `assistant`.**
  Ignore: `attachment`, `mode`, `ai-title`, `last-prompt`, `permission-mode`,
  `worktree-state`, `file-history-snapshot`, `system`, `queue-operation`.
- `timestamp` (ISO) on user/assistant records. `sessionId` field present.
- `message.role` = `user` | `assistant`. `message.content` is **either a string or an
  array of blocks**:
  - `{ type: 'text', text }` → text chunk (role from message.role).
  - `{ type: 'thinking', thinking }` → **skip** (not indexed in V1).
  - `{ type: 'tool_use', id, name, input }` → tool chunk: `toolCall.name=name`,
    `toolCall.args` = compact JSON of `input` (truncate ~200 chars).
  - `{ type: 'tool_result', tool_use_id, content, is_error }` (appears in `user`
    messages) → role `tool`, `text` = stringified result content (truncate ~500 chars),
    no embedding. OPEN: indexing tool_result text is allowed but keep it as role `tool`
    (FTS only). Default: include as FTS-only tool text.
  - String content → one text chunk with role = message.role.

## CODEX format — `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`
- `session_meta` record: `payload.id` = session id, `payload.cwd`. Capture session id
  from here; fall back to the `<id>` in the filename.
- Top-level `timestamp` (ISO) on every record.
- **Index `response_item` records** where `payload.type` is:
  - `message` with `payload.role` `user` | `assistant` → text chunk. Content is an array
    of `{ type: 'input_text'|'output_text', text }`; concatenate the `text` fields.
    **Skip `role: 'developer'`** (system instructions, noise).
  - `function_call` → tool chunk: `name`, `args` = the `arguments` string (truncate ~200).
  - `function_call_output` → role `tool`, FTS-only, `text` = `output` (truncate ~500).
  - `reasoning` → **skip** (encrypted/empty).
- Ignore `event_msg`, `turn_context` (duplicate/UI-event data; the response_items are the
  canonical transcript).

## PI format — `~/.pi/agent/sessions/<project-slug>/<id>.jsonl`
- `session` record: `id` = session id, `cwd`, `timestamp`. Fall back to filename stem.
- **Index `message` records.** `timestamp` top-level ISO. `message.role` =
  `user` | `assistant` | `toolResult`. `message.content` is an array of blocks:
  - `{ type: 'text', text }` → text chunk (role user/assistant).
  - `{ type: 'thinking', thinking }` → **skip**.
  - `{ type: 'toolCall', id, name, arguments }` → tool chunk: `name`,
    `args` = compact JSON of `arguments` (truncate ~200).
  - `toolResult` role: blocks are `{ type: 'text', text }` → role `tool`, FTS-only,
    text truncated ~500.
- Ignore `session`, `model_change`, `thinking_level_change`, `custom`.

---

## Index store (SQLite)
- One file, default `~/.agent-search/index.db` (override via env `AGENT_SEARCH_DB`).
- Load sqlite-vec via `sqliteVec.load(db)`.
- Tables:
  - `chunks(id INTEGER PK, agent_type, session_id, file_path, line_number, role,
    text, tool_name, tool_args, timestamp)`.
  - `source_files(path PK, agent_type, inode, last_offset, last_size)`.
  - `meta(key PK, value)` — store `embed_model`, `embed_dims`. A model/dims mismatch
    on open ⇒ the index must be rebuilt (surface clearly; V1 may just warn + reindex).
  - FTS5 virtual table `chunks_fts(text, tool_name, tool_args, content='chunks', content_rowid='id')`
    with triggers to keep it in sync (or populate manually on insert).
  - sqlite-vec virtual table `chunks_vec(embedding float[768])` keyed by chunk rowid;
    only user/assistant text chunks get a vector.

## Embedder
- Interface: `embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>`.
- Ollama impl: POST `http://localhost:11434/api/embed`, model `nomic-embed-text`.
  Prefix each text: `search_document: ` for documents, `search_query: ` for queries.
  Dims 768. Make the base URL + model overridable via env.
- Tests mock the HTTP call — never hit a real network in tests.

## Search
- Input: plain string. Embed as `query`. Run vector KNN (sqlite-vec) and FTS5 MATCH.
- Merge with RRF: `score = Σ 1/(60 + rank)` over the two ranked lists, sort desc.
- Result shape: `{ sessionId, agentType, filePath, lineNumber, role, snippet,
  timestamp, score }`. Every result MUST carry sessionId + filePath + lineNumber.
- Limit default 20.

## CLI
- `agent-search <query>` → ranked results (session id, agent, file:line, snippet).
- `agent-search show <sessionId>` → print the transcript (user/assistant messages by
  default). `--help` explains how to go from a result to a transcript.
- `agent-search index` → run a one-shot backfill/index. `agent-search watch` → watch.

## Server + web (lowest priority, after CLI works)
- `src/server/server.ts`: minimal HTTP API. `GET /api/search?q=` → results JSON.
  `GET /api/session/:id` → transcript JSON. Read-only.
- `web/`: Vue 3 + Vite + shadcn-vue. Search box → results list (each shows session id +
  matching line) → click → session view scrolled to the match. Session id in the URL.

## OPEN items (make a judgment call, leave a note)
- Exact chunking (currently: one block = one chunk). Fine for V1.
- Whether tool_result/function_call_output text is worth FTS indexing (currently: yes,
  FTS-only, truncated). Revisit if it adds noise.
- Server framework choice (Fastify vs node:http) — implementer picks the simplest.
</content>
