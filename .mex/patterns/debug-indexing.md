---
name: debug-indexing
description: Diagnose why a session isn't being indexed or doesn't show up in search. Walk the ingestion flow boundary by boundary.
triggers:
  - "not indexed"
  - "missing session"
  - "not showing up"
  - "debug index"
  - "watcher not firing"
  - "no results"
edges:
  - target: context/ingestion.md
    condition: to understand the watch → tail → parse → queue flow being debugged
  - target: context/agent-adapters.md
    condition: when the failure is in parsing a specific agent's format
last_updated: 2026-06-28
---

# Debug Indexing

## Context
Indexing has several boundaries; a session can fall out at any of them. Read
`context/ingestion.md` for the full flow. Work the boundaries in order — don't
guess.

## Steps (work in order)
1. **Watcher saw it?** Is the file's directory actually being watched? Did chokidar
   fire on the write? (Check the watched dirs in `context/ingestion.md`.)
2. **Offset read it?** Check the `source_files` row: did `last_offset` advance past
   the new bytes? A stuck offset = the tail didn't read the new lines. Look for
   truncation/rotation (size < offset, inode changed) not being handled.
3. **Adapter parsed it?** Did the right adapter claim the file, and did it parse the
   new lines without throwing? A malformed/unknown line shape fails here. See
   `context/agent-adapters.md`.
4. **Queued and embedded?** Did user/assistant chunks get embedded (local runtime
   up and reachable?) and written to the vector index?
5. **Written to FTS?** Did the text + compact tool-call form land in FTS5?
6. **Searchable?** Query both indexes directly — is it the index that's empty, or
   the search/ranking layer dropping it? (See `context/search.md`.)

## Gotchas
- Trailing partial line (no newline yet) is held back by design — it indexes on the
  next write, not immediately.
- Local embedding runtime (ollama) not running → embeddings silently stop; FTS may still work.
- Inspect with `sift status` (queue totals) and by querying the index DB
  directly (`~/.sift/index.db`, or `$SIFT_DB`). The `source_files`
  table tracks `last_offset` / `inode` / line-number / `cwd` per file.

## Verify (after fixing)
- [ ] The session now appears in search (vector and/or FTS as expected).
- [ ] `source_files` offset matches file size.
- [ ] The agent's log was not modified during debugging.

## Update Scaffold
- [ ] If the failure mode is new and recurring, add it to "Common Issues" in
  `context/setup.md` and to the Gotchas above.
- [ ] Update `.mex/ROUTER.md` "Known Issues" if this is an open problem.
