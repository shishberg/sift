---
name: search
description: How queries run against the vector and text indexes, and how results are ranked and returned. Load when working on querying, sqlite-vec, FTS5, ranking, or interleaving.
triggers:
  - "search"
  - "query"
  - "sqlite-vec"
  - "fts5"
  - "ranking"
  - "interleave"
  - "results"
edges:
  - target: context/architecture.md
    condition: when understanding where search sits in the overall flow
  - target: context/ingestion.md
    condition: when what was indexed affects what can be searched
  - target: context/stack.md
    condition: when working with sqlite-vec or FTS5 specifics
  - target: patterns/add-cli-command.md
    condition: when exposing search through a CLI command
last_updated: 2026-06-28
---

# Search

## Query model
Plain string in, ranked results out. No operators or query syntax in the query
string itself (see `context/decisions.md`). The one structured filter is the
**working directory**, set out-of-band via a flag (not parsed from the query):
the CLI scopes results to a cwd. Keep the query plain; rely on ranking to surface
the best matches.

## cwd scoping
The CLI defaults to searching only sessions that ran in the current directory,
with `--all` to search everywhere and `--cwd PATH` to scope to another directory
(`resolveCwd` normalises `~`/relative/`.` to the absolute path the index stores).
Mechanism: `search()` takes an optional `cwd`; the store has cwd-filtered variants
of both index queries that add `rowid IN (chunk ids whose session ran in cwd)`.
cwd lives on `source_files`, so the filter maps cwd → file paths → chunk ids.
sqlite-vec applies the `rowid IN` filter *before* KNN ranking, so a scoped vector
search returns the k nearest *within* that cwd, not the global k then filtered.
Web search is unscoped (no cwd filter on `/api/search`).

## Two indexes, one query
- **Vector (sqlite-vec):** embed the query string locally (ollama `nomic-embed-text`,
  768 dims), nearest-neighbour over user/assistant embeddings. Prefix the query with
  `search_query:` (nomic expects it; indexed text uses `search_document:`).
- **Text (FTS5):** match the query over user/assistant text + compact tool-call text.

Run both, then merge into one ranked list with **Reciprocal Rank Fusion (RRF)**:
use each result's rank position in each list, `score = Σ 1/(k + rank)` (k ≈ 60),
sort by combined score. RRF ignores the raw scores, which is the point — vector
distance and FTS5 BM25 aren't on comparable scales.
[VALIDATE AFTER FIRST IMPLEMENTATION — confirm RRF behaves well on real session-log
queries; tune k, or revisit weighted-score blending, only if results are poor.]

## Result shape
Every result must carry enough to find the original log:
- session id (required)
- source file path + line number
- the matching line/snippet
- role + timestamp

This is a hard convention (see `context/conventions.md`) — a result an agent
can't trace back to a session is a bug.

## Interfaces (both read-only)
- **CLI:** agent-facing. Prints results with session ids. Default text format is
  a two-line block per result: a header (session id, agent, file:line, role, cwd
  home-relative, datetime via `formatTimestamp` — same format as the web UI) then
  the snippet on its own indented line, whitespace/newlines squashed, blank line
  between results. The header is ANSI-coloured when stdout is a TTY (agent
  colour-coded; honours `NO_COLOR`); piped/non-TTY output stays plain. `--format
  json` dumps the raw `SearchResult[]` (full ISO timestamps, absolute cwd) for
  machine use. `--help` must explain how to read a transcript from an id
  (messages only by default). Search is scoped to the current directory by
  default (`--all` / `--cwd PATH` to change); text mode prints the active scope
  to stderr. See `patterns/add-cli-command.md`.
- **Web (Vue/Vite/shadcn-vue):** list of matching sessions, each with the matching
  line. Click → load the session, scroll to the match. Shows user/assistant
  messages only by default (tool calls maybe later). Session id is in the URL and
  shown on results and the session view.

[TO BE DETERMINED — after first implementation:]
- Embedding the query uses the same local model as indexing (confirm + record).
- Result limit / pagination behaviour.
- How session-level grouping works when many lines in one session match.
