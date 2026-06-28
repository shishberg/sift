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
last_updated: 2026-06-27
---

# Search

## Query model
Plain string in, ranked results out. No filters, operators, or query syntax in
V1 (see `context/decisions.md`). Keep it simple; rely on ranking to surface the
best matches.

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
  (messages only by default). See `patterns/add-cli-command.md`.
- **Web (Vue/Vite/shadcn-vue):** list of matching sessions, each with the matching
  line. Click → load the session, scroll to the match. Shows user/assistant
  messages only by default (tool calls maybe later). Session id is in the URL and
  shown on results and the session view.

[TO BE DETERMINED — after first implementation:]
- Embedding the query uses the same local model as indexing (confirm + record).
- Result limit / pagination behaviour.
- How session-level grouping works when many lines in one session match.
