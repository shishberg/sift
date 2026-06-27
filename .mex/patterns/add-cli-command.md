---
name: add-cli-command
description: Add or change a CLI command so it stays read-only, agent-discoverable via --help, and returns traceable results.
triggers:
  - "cli"
  - "command"
  - "--help"
  - "flag"
  - "option"
edges:
  - target: context/search.md
    condition: when the command searches or reads sessions
  - target: context/conventions.md
    condition: to check the read-only and result-locator rules
last_updated: 2026-06-27
---

# Add a CLI Command

## Context
The CLI is the agent-facing interface. Agents discover what it can do from
`--help`, so help text is a feature, not an afterthought. Read `context/search.md`
for query/result behaviour. The CLI is read-only — it searches and reads
transcripts, it never modifies sessions.

## Steps
1. Define the command and its flags. Keep queries as a plain string argument — no
   query syntax (see `context/decisions.md`).
2. Write clear `--help`: what it does, args, and crucially how an agent uses the
   output (e.g. take a session id from a search result, then read its transcript,
   messages-only by default).
3. Print results so each carries its session id (+ file path / line number).
4. Make sure output is easy for an agent to parse. [VERIFY AFTER FIRST IMPLEMENTATION — decide plain text vs `--json` and record it.]

## Gotchas
- Every result must include the session id — that's how an agent gets back to the log.
- Don't add a write/resume command — read-only only.
- Keep `--help` in sync when flags change.
- [VERIFY AFTER FIRST IMPLEMENTATION — confirm the CLI framework and help conventions once chosen.]

## Verify
- [ ] `--help` is accurate and explains how to go from a result to a transcript.
- [ ] Results carry session id (+ file path / line number).
- [ ] Command is read-only — no writes to session logs.
- [ ] Plain string query; no query syntax added.

## Debug
- No/odd results → check the search path (`context/search.md`) and whether the
  sessions are indexed at all (`patterns/debug-indexing.md`).

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if a new command exists.
- [ ] Update `context/setup.md` "Common Commands" with the new command.
- [ ] If a new recurring gotcha appears, update this pattern.
