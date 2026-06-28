# Pattern Index

Lookup table for all pattern files in this directory. Check here before starting any task — if a pattern exists, follow it.

<!-- This file is populated during setup and updated whenever patterns are added.
     Each row maps a pattern file (or section) to its trigger — when should the agent load it?

     Row format: a markdown link to the pattern, then a one-line trigger.
       - simple (one task per file): link text and target are both the filename, e.g. foo.md
       - anchored (multi-section file): target a heading anchor, e.g. foo.md#task-add-endpoint,
         one row per task
     See the live rows below for the exact shape (example links omitted here so they don't
     trip mex check's broken-link scan).

     Keep this table sorted alphabetically. One row per task (not per file).
     If you create a new pattern, add it here. If you delete one, remove it. -->

| Pattern | Use when |
|---------|----------|
| [add-agent-adapter.md](add-agent-adapter.md) | Adding support for a new agent type (write an adapter only) |
| [add-cli-command.md](add-cli-command.md) | Adding or changing a CLI command, flag, or its --help |
| [debug-indexing.md](debug-indexing.md) | A session isn't indexed or doesn't show up in search |
