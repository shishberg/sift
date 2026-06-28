---
name: router
description: Session bootstrap and navigation hub. Read at the start of every session before any task. Contains project state, routing table, and behavioural contract.
edges:
  - target: context/architecture.md
    condition: when working on system design, integrations, or understanding how components connect
  - target: context/stack.md
    condition: when working with specific technologies, libraries, or making tech decisions
  - target: context/conventions.md
    condition: when writing new code, reviewing code, or unsure about project patterns
  - target: context/decisions.md
    condition: when making architectural choices or understanding why something is built a certain way
  - target: context/setup.md
    condition: when setting up the dev environment or running the project for the first time
  - target: patterns/INDEX.md
    condition: when starting a task — check the pattern index for a matching pattern file
  - target: context/ingestion.md
    condition: when working on the watcher, parsing, or how sessions get indexed
  - target: context/search.md
    condition: when working on querying, ranking, or how results are returned
  - target: context/agent-adapters.md
    condition: when adding an agent or touching agent-specific parsing
last_updated: 2026-06-28
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State

**V1 is built and working.** Implemented via TDD, on `main`, 303 tests passing.
See `context/impl-spec.md` for the concrete build and `context/decisions.md` for the why.

**Working (all verified end-to-end against real logs, ~35k chunks):**
- chokidar watcher over the agent session dirs (dirs derived from adapter `rootDir`s)
- Agent adapters: claude, codex, pi (JSONL) + an opencode SQLite **source**
- Byte-offset JSONL tail + `source_files` (offset/inode/line-number) tracking
- SQLite index: sqlite-vec (768-dim) + FTS5, WAL mode, BigInt vec rowids
- Persistent embedding queue (`needs_embed`) drained by a single-flight consumer;
  backfill = the watcher's startup scan (not a separate op)
- Local embedder: ollama `nomic-embed-text`, with task prefixes + a model/dims guard
- Hybrid search: vec + FTS5 merged with RRF (k=60); FTS queries sanitized for punctuation
- CLI: search, show, index, watch, status, serve (+ live progress bar)
- Working directory per session: captured at ingest via `adapter.extractCwd` (claude/codex/pi)
  or opencode's `session.directory`, stored on `source_files.cwd`, resolved per session by
  joining chunks→source_files. A one-time `backfillCwd` (run at index/watch/serve startup)
  fills it for data indexed before the column existed. The session API returns it home-relative.
- Web app: Vue 3 + Vite + shadcn-vue + Tailwind 4; search + session view. Results are real
  links (open in new tab); the query lives in the URL (`/?q=…`) so back-nav restores it, plus
  a localStorage recent-search dropdown. The session view renders a FAITHFUL transcript read
  from the raw log (not the lossy index): `/api/session/:id` → `src/render/` parses each of the
  session's files (claude/codex/pi JSONL + opencode SQLite via `OpenCodeSource.readTranscript`),
  pairing tool calls with their untruncated output, and returns `items: TranscriptItem[]`. The
  index only supplies which files belong to a session (`store.getSessionFiles`) + cwd. The view
  renders these with vendored ai-elements `Message` bubbles (user right / assistant left, keeping
  the existing colours, markdown-it for prose) and collapsible `Tool` blocks (paired
  input/output, open on match); it scrolls to and ring-highlights the matched item. On a session
  page the global header hosts the session controls (back / agent / session id + copy / working
  dir + copy-log-path) via a shared `sessionHeader`
  store. Live queue Progress bar polls `/api/status`. Copy buttons go through
  `lib/clipboard.ts` `copyText`, which falls back to a hidden-textarea
  `execCommand('copy')` when `navigator.clipboard` is absent (insecure http:// origins).

**Known issues / follow-ups (non-blocking):**
- See the handoff doc for the remaining minor notes. RRF validated qualitatively on real
  queries (results look good); no tuning needed so far.

## Routing Table

Load the relevant file based on the current task. Always load `context/architecture.md` first if not already in context this session.

| Task type | Load |
|-----------|------|
| Understanding how the system works | `context/architecture.md` |
| Working with a specific technology | `context/stack.md` |
| Writing or reviewing code | `context/conventions.md` |
| Making a design decision | `context/decisions.md` |
| Setting up or running the project | `context/setup.md` |
| Watcher / parsing / how sessions get indexed | `context/ingestion.md` |
| Querying / ranking / how results come out | `context/search.md` |
| Adding an agent or agent-specific parsing | `context/agent-adapters.md` |
| Any specific task | Check `patterns/INDEX.md` for a matching pattern |

## Behavioural Contract

For every task, follow this loop:

1. **CONTEXT** — Load the relevant context file(s) from the routing table above. Check `patterns/INDEX.md` for a matching pattern. If one exists, follow it. Narrate what you load: "Loading architecture context..."
2. **BUILD** — Do the work. If a pattern exists, follow its Steps. If you are about to deviate from an established pattern, say so before writing any code — state the deviation and why.
3. **VERIFY** — Load `context/conventions.md` and run the Verify Checklist item by item. State each item and whether the output passes. Do not summarise — enumerate explicitly.
4. **DEBUG** — If verification fails or something breaks, check `patterns/INDEX.md` for a debug pattern. Follow it. Fix the issue and re-run VERIFY.
5. **GROW** — After meaningful work, run this binary checklist:
   - **Ground:** What changed in reality? Name the changed behavior, system, command, dependency, or workflow.
   - **Record:** If project state changed, update the "Current Project State" section above. If documented facts changed, update the relevant `context/` file surgically.
   - **Orient:** If this task can recur and no pattern exists, create one in `patterns/` using `patterns/README.md`, then add it to `patterns/INDEX.md`. If a pattern exists but you learned a gotcha, update it.
   - **Write:** Bump `last_updated` in every scaffold file you changed. If the why matters, run `mex log --type decision "<what changed and why>"` or `mex log "<note>"`.
