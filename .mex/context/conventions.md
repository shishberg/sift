---
name: conventions
description: How code is written in this project — naming, structure, patterns, and style. Load when writing new code or reviewing existing code.
triggers:
  - "convention"
  - "pattern"
  - "naming"
  - "style"
  - "how should I"
  - "what's the right way"
edges:
  - target: context/architecture.md
    condition: when a convention depends on understanding the system structure
  - target: context/agent-adapters.md
    condition: when writing per-agent code — it must stay behind the adapter interface
last_updated: 2026-06-27
---

# Conventions

## Naming
[TO BE DETERMINED — set file/function/variable casing after first implementation. Decide once and record here.]
- Database columns: [TO BE DETERMINED] — pick snake_case or camelCase and keep it consistent across the schema.
- Agent type identifiers: stable lowercase strings (`claude`, `codex`, `pi`) used as keys in the adapter registry.

## Structure
- Agent-specific knowledge (on-disk format, JSON schema, paths) lives ONLY inside that agent's adapter. Indexing, search, CLI, and web never branch on agent type — they go through the adapter interface. See `context/agent-adapters.md`.
- Indexing, search, CLI, and web are separate concerns. [TO BE DETERMINED — fix the exact directory layout after first implementation]
- [TO BE DETERMINED — decide where tests live relative to source]

## Patterns
**Everything goes through the agent adapter interface.** No part of the system
outside `adapters/` should know what Claude vs Codex vs pi JSON looks like.
Adding an agent = adding an adapter, nothing else changes.

**Results always carry a source locator.** Every search result — CLI or web —
must include enough to find the original: session id at minimum, plus file path
and line number. A result an agent can't trace back to a log is a bug.
- Web: session id appears in the URL and is shown on results and the session view.
- CLI: session id is printed with each result; `--help` explains how to read a transcript from an id.

**Read-only, always.** Nothing in this codebase writes to or modifies agent
session logs. They are the source of truth.

**Plain string queries.** No filter/query syntax in V1. Take a string, search
both indexes, sort. Don't add query operators without an explicit decision.

## Verify Checklist
Before presenting any code:
- [ ] No agent-specific format logic leaked outside an adapter.
- [ ] Nothing writes to or mutates the agent session logs (read-only).
- [ ] Search results carry session id (+ file path / line number where applicable).
- [ ] No cloud embedding call introduced — embeddings stay local.
- [ ] CLI changes keep `--help` accurate and discoverable.
- [ ] [TO BE DETERMINED — add lint/typecheck/test commands once they exist]
