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
last_updated: 2026-06-30
---

# Add a CLI Command

## Context
The CLI is the agent-facing interface. Agents discover what it can do from
`--help`, so help text is a feature, not an afterthought. Read `context/search.md`
for query/result behaviour. The CLI is read-only — it searches and reads
transcripts, it never modifies sessions.

No CLI framework: arg parsing is hand-rolled in `parseCli` and help is the
`HELP_TEXT` constant, both in `src/cli/cli.ts`. Each command's logic lives in an
exported pure function (`cmdSearch`, `cmdShow`, …) that takes injected deps, so it
unit-tests without spawning processes or hitting ollama; `main()` is the thin
wiring layer. Follow that shape for new commands.

## Steps
1. Add the command/flags to `parseCli` (return a field on `ParsedCli`) and a pure
   `cmdX` handler; wire it in `main()`. Keep queries as a plain string argument —
   no query syntax (see `context/decisions.md`).
2. Write clear `--help` in `HELP_TEXT`: what it does, args, and crucially how an
   agent uses the output (e.g. take a session id from a search result, then read
   its transcript, messages-only by default). Also add a focused per-subcommand
   block to `SUBCOMMAND_HELP` so `sift <cmd> --help` shows command-specific help
   (`parseCli` returns `{ command: 'help', helpTopic }` when a known subcommand is
   followed by `--help`/`-h`; `main()` prints `helpText(topic)`).
3. Print results so each carries its session id (+ file path / line number).
4. Output format (decided): human-readable text by default; offer `--format json`
   for machine use where it helps (search has both). Validate bad flag values in
   `main()` and exit non-zero with a friendly message.

## Output conventions (search, `formatResult`)
- Text result = a two-line block: a header (`sessionId:line  [agent]  [role]  cwd
  datetime`, cwd home-relative, datetime via `formatTimestamp`) then the snippet
  on its own indented line, whitespace squashed, blank line between.
- Locator is `sessionId:lineNumber` — no filename (the id IS the filename minus
  extension; `show <id>` resolves the actual file from the index).
- cwd is shown only under `--all`; when scoped to one directory (default / `--cwd`)
  it's omitted, since the stderr scope note already states it (`showCwd` opt).
- Header is ANSI-coloured only when `process.stdout.isTTY` and `NO_COLOR` is
  unset; piped / `--format json` output stays plain. `cmdShow` uses the same role
  colouring and a blank line between messages.
- `--format json` dumps the raw objects (full ISO timestamps, absolute cwd).

## Gotchas
- Every result must include the session id — that's how an agent gets back to the log.
- Don't add a write/resume command — read-only only.
- Keep `--help` in sync when flags change — both `HELP_TEXT` and the matching
  `SUBCOMMAND_HELP` entry.
- Subcommand `--help` must be checked before the generic top-level `--help`
  handling in `parseCli`, or `sift show --help` falls through to top-level help.
- When a flag takes a value (e.g. `--lines RANGE`), skip that value when scanning
  for positional args, or it gets misread as the session id / query.
- Strip flags out of the joined query string so they don't leak into the search
  (see the value-flag loop in `parseCli`).

## Verify
- [ ] `--help` is accurate and explains how to go from a result to a transcript.
- [ ] Results carry session id (+ file path / line number).
- [ ] Command is read-only — no writes to session logs.
- [ ] Plain string query; no query syntax added.
- [ ] New flags are stripped from the query and bad values rejected in `main()`.

## Debug
- No/odd results → check the search path (`context/search.md`) and whether the
  sessions are indexed at all (`patterns/debug-indexing.md`).

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if a new command exists.
- [ ] Update `context/setup.md` "Common Commands" with the new command.
- [ ] If a new recurring gotcha appears, update this pattern.
