# sift

Search your AI agent session logs from one place. sift indexes the conversation
logs from Claude, Codex, pi, and opencode into a single local SQLite hybrid
index (vector + full-text) and lets you search them from a CLI or a web app.

- **Local only** — embeddings run locally (via [ollama](https://ollama.com) or
  in-process [fastembed](https://github.com/Anush008/fastembed-js)); nothing is
  sent to a cloud API.
- **Read-only** — sift never modifies the agents' log files. They stay the
  source of truth.
- **Traceable** — every result carries a source locator (session id, file path,
  line number) back to the original log.

## Requirements

- Node.js >= 20
- An embedding provider (see [Embedding providers](#embedding-providers)). The
  default is [ollama](https://ollama.com) running, with the model pulled:
  ```sh
  ollama pull nomic-embed-text
  ```
- No system SQLite needed — `better-sqlite3` bundles SQLite (with FTS5) and
  `sqlite-vec` provides the vector extension.

## Embedding providers

Embeddings are always generated locally — never a cloud API. Pick a provider
with `AGENT_SEARCH_EMBED_PROVIDER`:

| Provider | Model | How it runs |
| --- | --- | --- |
| `ollama` (default) | `nomic-embed-text` (768 dims) | Talks to a local ollama service (`ollama serve`). Pull the model first: `ollama pull nomic-embed-text`. |
| `fastembed` | `bge-base-en-v1.5` (768 dims) | In-process ONNX — no separate service. Install the optional package once (`npm install fastembed`); the model downloads to `~/.sift/fastembed` on first use. |

```sh
export AGENT_SEARCH_EMBED_PROVIDER=fastembed
npm install fastembed   # optional dependency, installed by default with `npm install`
sift index              # reindex — see below
```

The index records which model built it. Switching providers (or models) changes
the embedding space, so sift refuses to mix them — delete the index and reindex:

```sh
rm ~/.sift/index.db
sift index
```

## Setup

```sh
npm install
npm run build          # compiles src/ → dist/ (the `sift` bin points at dist/cli/cli.js)
sift index             # backfill existing sessions and embed them
```

The index DB is created at `~/.sift/index.db` (WAL mode).

## Usage

```sh
# Index / watch
sift index             # backfill + drain the embedding queue
sift watch             # keep the index live as new sessions are written
sift status            # index stats

# Search / read
sift <query> [--limit N] [--format json] [--cwd PATH | --all]
sift show <id>[:LINE|:A-B] [--lines RANGE] [--tools]

# Web app
sift serve [--port N] [--watch]
```

Search defaults to sessions from the current directory. Use `--all` to search
everywhere, or `--cwd PATH` to scope elsewhere. Queries are plain strings — no
filter syntax.

## Web frontend (development)

```sh
npm run web:dev        # Vite dev server, proxies /api to a running `sift serve`
npm run web:build
```

The dev server binds to `localhost` by default. To reach it from another machine
on your LAN, set the host and the allowed hostnames explicitly:

```sh
VITE_HOST=0.0.0.0 VITE_ALLOWED_HOSTS=my-host.local npm run web:dev
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `SIFT_DB` | Path to the SQLite index file (default `~/.sift/index.db`). |
| `AGENT_SEARCH_EMBED_PROVIDER` | Embedding provider: `ollama` (default) or `fastembed`. See [Embedding providers](#embedding-providers). |
| `AGENT_SEARCH_EMBED_MODEL` | Override the model for the chosen provider (`nomic-embed-text`; or `bge-base-en-v1.5` / `bge-base-en` for fastembed). Must be 768 dims. |
| `OLLAMA_BASE_URL` | ollama endpoint (default `http://localhost:11434`). |
| `FASTEMBED_CACHE_DIR` | Where fastembed caches model files (default `~/.sift/fastembed`). |
| `AGENT_SEARCH_DIRS` | Colon-separated dirs to watch, overriding the defaults (`~/.claude/projects/`, `~/.codex/sessions/`, `~/.pi/agent/sessions/`). `~` is expanded. opencode is read from its own SQLite DB. |
| `AGENT_SEARCH_PORT` | Port for `serve` (default 3737; `--port` also works). |
| `NO_COLOR` | Disables ANSI colour in CLI search output. |

## Development

```sh
npm test               # vitest
npm run test:watch
npm run typecheck      # tsc --noEmit
```

Agent-specific format logic lives only in `src/adapters/` (JSONL sources) or
`src/sources/` (non-JSONL sources). Nothing else branches on agent type.

## License

[MIT](./LICENSE)
