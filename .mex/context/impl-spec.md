---
name: impl-spec
description: Concrete implementation spec for the first build — locked conventions, project layout, and the exact on-disk log formats for each agent adapter. Load when implementing any component.
last_updated: 2026-06-28
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
- **Agent type ids:** lowercase strings `claude` | `codex` | `pi` | `opencode`.
  The three JSONL ones are *adapters* (`JsonlAgentType`); `opencode` is a *source*
  (SQLite, see below), not a file-watched adapter.
- **No cloud calls** anywhere. Embeddings local only.
- **Read-only:** never open a session log for writing.

## Project layout
```
package.json, tsconfig.json, vitest.config.ts
src/
  types.ts            # Chunk shape + shared types (the adapter contract)
  text.ts             # shared truncation limits (TOOL_ARGS_MAX, TOOL_RESULT_MAX)
  harness-tags.ts     # strip harness-injected XML wrapper tags from user text
  adapters/
    types.ts          # Adapter interface + registry types
    registry.ts       # buildRegistry(); pick adapter by dir/file
    claude.ts, codex.ts, pi.ts
  sources/
    opencode.ts       # OpenCodeSource: index + readTranscript from opencode's SQLite DB
  index/
    store.ts          # open db, load sqlite-vec, schema, FTS5, source_files
  ingest/
    tail.ts           # byte-offset tail reader (pure, testable)
    indexer.ts        # EmbedWorker (drain queue) + backfillCwd
    watcher.ts        # chokidar wiring + startup backfill
  embed/
    types.ts          # Embedder interface
    ollama.ts         # ollama nomic-embed-text impl
    guard.ts          # assertEmbedModel (model/dims must match the index)
  search/
    search.ts         # vector + FTS query, RRF fusion, result shape
  render/
    transcript.ts     # faithful (untruncated) transcript from raw logs, per agent
    claude.ts, codex.ts, pi.ts, shared.ts
  cli/
    cli.ts            # entrypoint (search, show, index, watch, status, serve)
  server/
    server.ts         # HTTP API (/api/search, /api/recent, /api/session/:id, /api/status)
web/                  # Vue 3 + Vite + shadcn-vue + Tailwind 4 app
```

## Common chunk shape (the adapter contract)
A parsed chunk is one indexable unit produced by an adapter from one JSONL line.
```ts
type Role = 'user' | 'assistant' | 'tool';
type AgentType = 'claude' | 'codex' | 'pi' | 'opencode';
interface Chunk {
  agentType: AgentType;
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

**Harness wrapper tags:** agents inject XML annotation tags into *user* turns
(claude's `<command-name>`/`<local-command-*>`, codex's `<environment_context>` etc.).
Adapters (and the renderers) run user text through `stripHarnessTags` (`harness-tags.ts`,
a closed `HARNESS_TAGS` registry: `unwrap` keeps inner text, `drop` removes the block).
No-op unless a registered tag is present. See `context/agent-adapters.md`.

## Adapter interface
```ts
interface Adapter {
  agentType: JsonlAgentType; // 'claude' | 'codex' | 'pi'
  /** Absolute dir this adapter owns (expanded ~). */
  rootDir: string;
  /** True if this file path belongs to this agent. */
  claims(filePath: string): boolean;
  /** Parse one raw JSONL line into 0+ chunks. ctx carries filePath + lineNumber. */
  parseLine(line: string, ctx: { filePath: string; lineNumber: number }): Chunk[];
  /** Pull the session's working dir from a line, if present. */
  extractCwd(line: string): string | undefined;
}
```
Session id: prefer an id carried on the record; otherwise derive from the filename
(see per-agent notes). Adapters must be pure and side-effect-free (no disk writes).

Non-JSONL agents are *sources*, not adapters: `OpenCodeSource` (`sources/opencode.ts`)
reads opencode's SQLite DB, emits the same `Chunk` shape, persists a cursor, and is
imported one-shot at index/watch/serve startup (cwd from `session.directory`).

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

## PI format — `~/.pi/agent/sessions/<project-slug>/<timestamp>_<id>.jsonl`
- Filename is `<timestamp>_<id>.jsonl`; the session id is the part after the last `_`
  (matches the `session` record's `id`). Fall back to the full stem if no `_`.
- `session` record: `id` = session id, `cwd`, `timestamp`.
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
- One file, default `~/.sift/index.db` (override via env `SIFT_DB`).
- Load sqlite-vec via `sqliteVec.load(db)`.
- Tables:
  - `chunks(id INTEGER PK, agent_type, session_id, file_path, line_number, role,
    text, tool_name, tool_args, timestamp, needs_embed INTEGER NOT NULL DEFAULT 0)`.
    Partial index on `needs_embed` where `needs_embed = 1`. Set `needs_embed = 1`
    only for user/assistant chunks with non-empty text; everything else stays 0.
  - `source_files(path PK, agent_type, inode, last_offset, last_size,
    last_line_number, cwd)`. `cwd` is per-file; a session's cwd is resolved by
    joining chunks → source_files (backfilled once via `backfillCwd`). opencode
    gets a `source_files` row under a virtual `opencode://<id>` path.
  - `meta(key PK, value)` — store `embed_model`, `embed_dims`. A model/dims mismatch
    on open ⇒ the index must be rebuilt (surface clearly; V1 may just warn + reindex).
  - FTS5 virtual table `chunks_fts(text, tool_name, tool_args, content='chunks', content_rowid='id')`
    with triggers to keep it in sync (or populate manually on insert).
  - sqlite-vec virtual table `chunks_vec(embedding float[768])` keyed by chunk rowid;
    only user/assistant text chunks get a vector.

## Embedding queue / consumer (decouples ingestion from embedding)
See the "Persistent embedding queue" decision in `decisions.md`. Ingestion writes
chunk + FTS rows immediately and marks user/assistant text chunks `needs_embed = 1`.
A **single-flight** in-process consumer drains them:
- Store methods: `addChunk(chunk)` (no inline embedding; sets needs_embed),
  `takePendingEmbeds(limit): {id, text}[]`, `setEmbedding(id, embedding)` (writes vec
  row + clears needs_embed, in a transaction), `queueStats(): {total, embedded, pending}`.
- Consumer: a `kick()`-able worker. If already running, `kick()` is a no-op; otherwise it
  loops `takePendingEmbeds → embed batch → setEmbedding` until pending is 0. Failed batch ⇒
  leave `needs_embed = 1` (retries next kick), log, brief backoff.
- The watcher calls `kick()` after writing new rows. **Backfill is just the startup scan
  feeding the same queue — not a separate operation.**

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
  timestamp, score, cwd }`. Every result MUST carry sessionId + filePath +
  lineNumber. `cwd` is absolute here; the HTTP/CLI layers render it $HOME-relative.
- Limit default 20.

## CLI
No framework: arg parsing is hand-rolled in `parseCli`, help is the `HELP_TEXT`
constant, and each command is a pure `cmd*` handler taking injected deps; `main()`
wires them. (Both in `cli/cli.ts`.)
- `sift <query> [--limit N] [--format text|json] [--cwd PATH | --all]` →
  ranked results. Text = a two-line block per result: header
  (`sessionId:line  [agent]  [role]  cwd  datetime`, cwd $HOME-relative, datetime via
  `formatTimestamp`) then the snippet on its own indented line (whitespace squashed),
  blank line between. The locator is `sessionId:lineNumber` (the redundant filename is
  dropped; `show <id>` resolves the file). cwd is shown only under `--all` — when the
  search is scoped to one directory it's omitted (the scope note on stderr covers it).
  Header is ANSI-coloured only on a TTY (honours `NO_COLOR`). `--format json` dumps the
  raw `SearchResult[]` (full ISO timestamps, absolute cwd).
- `sift show <sessionId> [--tools]` → print the transcript (user/assistant by
  default; `--tools` includes tool chunks). Role marker is ANSI-coloured on a TTY (same
  scheme as search), blank line between messages. `--help` explains result → transcript.
- `sift index` → one-shot: scan all dirs + opencode, write rows, drain the
  embed queue to completion (live progress bar), then exit. `sift watch` →
  watch + keep draining. `sift status` → print `queueStats` + a text bar.
- `sift serve [--port N] [--watch]` → start the HTTP API + web app.
- Progress bar: hand-rolled (carriage-return), no heavy dep, driven by `queueStats()`.

## Server + web
- `src/server/server.ts`: read-only HTTP API. `GET /api/search?q=` → results JSON.
  `GET /api/recent` → most-recently-touched sessions (one row per session) for the
  no-query sidebar. `GET /api/session/:id` → a FAITHFUL transcript read from the raw
  logs via `src/render/` (untruncated, tool calls paired with output) — NOT the lossy
  index. `GET /api/status` → `queueStats` JSON. `--watch` also starts the watcher so
  the web app indexes live. `ServerDeps`: `search`, `getRecent`, `getSession`, `getStatus`.
- `web/`: Vue 3 + Vite + **shadcn-vue + Tailwind 4**. Persistent left search sidebar
  (search box + results / recent list) and a main panel showing the open session,
  scrolled to + highlighting the match. Session id in the URL (`?q=` for the query). A
  queue progress bar polls `/api/status`. See ROUTER "Current Project State" for the
  full layout.

## Resolved / notes (was OPEN)
- Chunking: one block = one chunk. Kept; fine in practice.
- tool_result/function_call_output text: indexed FTS-only, truncated. Kept; no noise issues.
- Server framework: plain `node:http` (no framework).
- CLI output: human-readable text by default + `--format json`. (Was OPEN in `add-cli-command`.)
</content>
