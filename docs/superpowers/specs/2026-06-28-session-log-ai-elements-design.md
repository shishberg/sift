# Session log view: render from the raw log, styled with ai-elements

**Date:** 2026-06-28
**Status:** Approved (design)

## Goal

Replace the hand-rolled message styling in the web session view with the
`ai-elements-vue` `Message` and `Tool` components, and make the session view a
**faithful viewer of the raw session log** rather than of the search index.

This came out of a real drift: the session view currently renders from the
SQLite index, which is a lossy, search-optimised projection of the log. The
recorded decision "Read-only index — never modify session logs"
(`.mex/context/decisions.md:112`) makes the log the source of truth and the
web/CLI viewers of it. Rendering from a truncated, unpaired DB projection is not
faithful to that.

## Why the DB can't drive this (the two blockers)

The DB *does* store tool input and output (as separate `role:'tool'` chunks —
`src/adapters/claude.ts:87-105`), so output is not lost. But:

1. **Truncation.** Tool args are capped at 200 chars (`TOOL_ARGS_MAX`), results
   at 500 (`TOOL_RESULT_MAX`) — `src/text.ts:10,13`. Correct for an FTS index,
   wrong for a viewer.
2. **No pairing.** The `tool_use.id` ↔ `tool_result.tool_use_id` link that pairs
   a call with its output is read at ingest but **not stored**. From the DB you
   cannot reliably say which result belongs to which call. The raw log has it.

The ai-elements `Tool` component wants input + output together in one collapsible
block, so pairing is required. Therefore: render from the log.

## Architecture

Two layers. Build A first; B depends on A's paired data.

### Layer A — backend: faithful transcript read path

- **`getSession` reads the raw log file(s), not `store.getSessionChunks`.**
  The session endpoint (`src/cli/cli.ts:708`) currently calls
  `store.getSessionChunks(sessionId)`. Replace that with a read path that parses
  the session's raw log file(s).
- **The DB still answers "which files belong to this session" and supplies
  `cwd`.** Query distinct `file_path` for the `session_id` from the index, and
  keep `getSessionCwd`. Clean split: **DB = search index + file lookup; log =
  render.**
- **Per-agent full-transcript parsers.** New, richer than the per-line ingest
  `parseLine`. Covers claude / codex / pi JSONL + the opencode SQLite source.
  Each produces, in order:
  - user/assistant items with **untruncated** text;
  - tool items with `{ name, input, output?, isError? }`, **paired** via the
    agent's call/result id link (`tool_use.id` ↔ `tool_result.tool_use_id` for
    claude; the codex/pi/opencode equivalents).
- **Thinking blocks stay dropped** (as today, `src/adapters/claude.ts:84`).
- **New response shape.** A transcript item carries:
  - `role`: `'user' | 'assistant' | 'tool'`
  - `text`: untruncated, for user/assistant
  - for tools: `{ name, input, output?, isError? }`
  - `lineNumber` + `filePath` — so match-scroll still works; line numbers now map
    straight to log lines
  - `timestamp`

  This supersedes the current `Chunk`/`SessionResponse` shape for the session
  endpoint (`web/src/types.ts:17-34`). Search results keep using the DB.

### Layer B — frontend: ai-elements swap

- **Vendor** `Message` + `Tool` component source into
  `src/components/ai-elements/`. Do **not** use the `ai-elements-vue` CLI: there
  is no `components.json` and the project hand-manages shadcn components
  (`web/src/components/ui/progress`). Both components rely only on `cn` +
  `reka-ui`, already dependencies.
- **Messages:** `Message`/`MessageContent` per user/assistant item. User →
  right-aligned bubble, assistant → left-aligned bubble, `max-w-[80%]`, using the
  **existing colours** (`--user-bg/border/text`, `--assistant-bg/border/text`),
  overriding ai-elements' default `bg-secondary`.
- **Tools:** `Tool`/`ToolHeader`/`ToolContent`/`ToolInput`/`ToolOutput`,
  collapsed by default, showing real **paired input + output**.
  `ToolInput`/`ToolOutput` render via a plain `<pre>` (try `JSON.parse`, fall
  back to the raw string) — **no shiki / CodeBlock** dependency.
- **Markdown:** keep `markdown-it` `renderMarkdown` (`web/src/lib/markdown.ts`)
  piped into `MessageContent`. Do **not** adopt `MessageResponse` /
  `vue-stream-markdown` — pointless for a static log and it would drop the
  new-tab link handling.
- **Kept:** match-highlight ring + auto-scroll (`data-matched` + `.chunk-matched`
  move onto the matched item); line numbers as a small muted `:42` label beside
  each item.
- **Dropped:**
  - the role divider rules;
  - the **global hide-tools toggle** and its "this session only has tool calls"
    empty state — per-tool collapse replaces it. Remove
    `sessionHeader.canToggleTools` / `showTools` wiring.
- **CSS removed** (`web/src/style.css`): `.msg`, `.msg-user`, `.msg-assistant`,
  `.role-rule`, `.role-label`, `.rule-line`, the inline tool-mono style. **Kept:**
  `.md-body` (prose typography inside the bubble), `.chunk-matched`.

## Testing

- Layer A: per-adapter transcript-parser tests over real log fixtures —
  untruncated text, correct tool input/output pairing, correct ordering, error
  results flagged. Multi-file sessions parse all files in order.
- Layer B: session view renders user/assistant bubbles with the right colours and
  alignment; tool calls render as collapsed `Tool` blocks with paired
  input/output; match highlight + scroll still land on the right item; line
  numbers shown.

## Out of scope

- Showing thinking blocks (kept hidden for now).
- Syntax highlighting in tool input/output (plain `<pre>`).
- Any change to search, ingest, or the index schema. The DB stays as-is.
