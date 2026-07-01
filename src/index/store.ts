import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentType, Chunk, JsonlAgentType } from '../types.js';
import { Lock } from './lock.js';

/** Embedding dimension for nomic-embed-text. One place to change if the model changes. */
export const EMBED_DIMS = 768;

/**
 * Resolve the index database path: explicit arg → `$SIFT_DB` → `~/.sift/index.db`.
 * Single source of truth shared by the Store constructor and the reindex/delete
 * path in the CLI, so both always agree on which file is the index.
 */
export function resolveDbPath(dbPath?: string): string {
  return dbPath ?? process.env.SIFT_DB ?? join(homedir(), '.sift', 'index.db');
}

/**
 * Subquery (one `?` bind = an absolute cwd) yielding the chunk ids of every
 * session that ran in that directory. cwd is stored on source_files, so we go
 * cwd → file paths → chunk ids. Used to scope vec/FTS search to one cwd.
 */
const CHUNK_IDS_IN_CWD = `
  SELECT id FROM chunks
  WHERE  file_path IN (SELECT path FROM source_files WHERE cwd = ?)
`;

export interface SourceFile {
  path: string;
  agentType: JsonlAgentType;
  inode?: number;
  lastOffset: number;
  lastSize: number;
  /** 1-based line number of the last indexed complete line (0 on first index). */
  lastLineNumber: number;
  /** Working directory the session ran in, captured from the log. Undefined until known. */
  cwd?: string;
}

/**
 * A session summary for the "recently touched" sidebar list. Shaped to match
 * SearchResult (minus score) so the web layer can render it the same way: it is
 * the session's most recent message, used as both the preview snippet and the
 * source locator the row links to.
 */
export interface RecentSession {
  sessionId: string;
  agentType: AgentType;
  filePath: string;
  lineNumber: number;
  role: 'user' | 'assistant' | 'tool';
  /** Text of the most recent message in the session. */
  snippet: string;
  /** Timestamp of the most recent message — the value the list is ordered by. */
  timestamp: string;
  /** Working directory the session ran in ('' if unknown). Absolute here. */
  cwd: string;
}

export interface EmbedModelCheck {
  matches: boolean;
  /** Populated when there is stored metadata to compare against. */
  stored?: { model: string; dims: number };
}

// ----- internal row shapes -----

interface ChunkRow {
  id: number;
  agent_type: string;
  session_id: string;
  file_path: string;
  line_number: number;
  role: string;
  text: string;
  tool_name: string | null;
  tool_args: string | null;
  timestamp: string;
}

interface SourceFileRow {
  path: string;
  agent_type: string;
  inode: number | null;
  last_offset: number;
  last_size: number;
  last_line_number: number;
  cwd: string | null;
}

// ----- Store -----

export class Store {
  /** The resolved path this store was opened with (`:memory:` for in-process tests). */
  readonly dbPath: string;

  private readonly db: Database.Database;

  // Prepared statements — created once after schema is ready.
  private readonly stmtInsertChunk: Database.Statement;
  private readonly stmtInsertVec: Database.Statement;
  private readonly stmtClearNeedsEmbed: Database.Statement;
  private readonly stmtTakePendingEmbeds: Database.Statement;
  private readonly stmtQueueTotal: Database.Statement;
  private readonly stmtQueuePending: Database.Statement;
  private readonly stmtGetSourceFile: Database.Statement;
  private readonly stmtUpsertSourceFile: Database.Statement;
  private readonly stmtUpdateCwd: Database.Statement;
  private readonly stmtInsertCwd: Database.Statement;
  private readonly stmtGetSessionCwd: Database.Statement;
  private readonly stmtSourceFilesMissingCwd: Database.Statement;
  private readonly stmtGetMeta: Database.Statement;
  private readonly stmtSetMeta: Database.Statement;
  private readonly stmtFtsSearch: Database.Statement;
  private readonly stmtFtsSearchCwd: Database.Statement;
  private readonly stmtCountVec: Database.Statement;
  private readonly stmtVecSearch: Database.Statement;
  private readonly stmtVecSearchCwd: Database.Statement;
  private readonly stmtGetChunk: Database.Statement;
  private readonly stmtGetSessionChunks: Database.Statement;
  private readonly stmtGetSessionFiles: Database.Statement;
  private readonly stmtRecentSessions: Database.Statement;

  // Cached transactions.
  private readonly txnBatch: (items: Array<{ chunk: Chunk }>) => number[];
  private readonly txnSetEmbedding: (id: number, embedding: number[]) => void;

  /** Process-level lock on the index file. Released by {@link close}. */
  private readonly lock: Lock | undefined;

  /**
   * Open (or create) the index database.
   *
   * For file-backed stores, takes a process-level lock on `<dbPath>.lock` so
   * two `sift` processes can't both write to the same DB (which would split
   * the DB across two inodes and silently lose data). Stale locks held by a
   * dead PID are taken over automatically.
   *
   * Read-only callers (`sift search`, `sift show`, `sift status`,
   * `sift serve` without `--watch`) pass `readOnly: true` to skip the lock —
   * SQLite's WAL mode lets multiple readers coexist, and the lock is only
   * needed to keep two writers from racing or splitting the file.
   *
   * @param dbPath  Explicit path, or `:memory:` for tests. Defaults to
   *                `$SIFT_DB` or `~/.sift/index.db`.
   * @param readOnly  When true, skip the process lock. Use for any command
   *                  that doesn't write to the index. Defaults to false.
   */
  constructor(dbPath?: string, readOnly = false) {
    const resolved = resolveDbPath(dbPath);

    this.dbPath = resolved;

    const isMemory = resolved === ':memory:';
    if (!isMemory) {
      mkdirSync(dirname(resolved), { recursive: true });
      if (!readOnly) {
        this.lock = new Lock(resolved);
        this.lock.acquire();
      }
    }

    try {
      this.db = new Database(resolved);
      sqliteVec.load(this.db);
    } catch (err) {
      // If the DB open fails (corrupt file, disk full, etc.) and we already
      // took the lock, release it so the next process isn't blocked behind
      // a dead process's lock. (Stale-PID recovery would also clean it up,
      // but cleaning up here is faster and more obviously correct.)
      this.lock?.release();
      throw err;
    }

    // WAL mode lets readers run concurrently with a single writer — the core
    // use case is searching while a backfill writes. Skip for :memory: because
    // SQLite ignores the pragma there and better-sqlite3 returns 'memory'.
    if (resolved !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
      // NORMAL sync is safe with WAL (committed data survives crashes) and
      // avoids the per-write fsync overhead of the default FULL mode.
      this.db.pragma('synchronous = NORMAL');
    }
    // Wait up to 5 s before throwing "database is locked" so the searcher and
    // the writer can share the file without manual retry logic.
    this.db.pragma('busy_timeout = 5000');

    this.createSchema();

    // ---- prepared statements ----
    this.stmtInsertChunk = this.db.prepare(`
      INSERT INTO chunks
        (agent_type, session_id, file_path, line_number, role, text, tool_name, tool_args, timestamp, needs_embed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertVec = this.db.prepare(
      'INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)',
    );

    this.stmtClearNeedsEmbed = this.db.prepare(
      'UPDATE chunks SET needs_embed = 0 WHERE id = ?',
    );

    this.stmtTakePendingEmbeds = this.db.prepare(`
      SELECT id, text FROM chunks WHERE needs_embed = 1 LIMIT ?
    `);

    this.stmtQueueTotal = this.db.prepare(`
      SELECT COUNT(*) AS total FROM chunks
      WHERE (role = 'user' OR role = 'assistant') AND text != ''
    `);

    this.stmtQueuePending = this.db.prepare(`
      SELECT COUNT(*) AS pending FROM chunks WHERE needs_embed = 1
    `);

    this.stmtGetSourceFile = this.db.prepare('SELECT * FROM source_files WHERE path = ?');

    this.stmtUpsertSourceFile = this.db.prepare(`
      INSERT INTO source_files (path, agent_type, inode, last_offset, last_size, last_line_number)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        agent_type       = excluded.agent_type,
        inode            = excluded.inode,
        last_offset      = excluded.last_offset,
        last_size        = excluded.last_size,
        last_line_number = excluded.last_line_number
    `);

    this.stmtUpdateCwd = this.db.prepare('UPDATE source_files SET cwd = ? WHERE path = ?');

    this.stmtInsertCwd = this.db.prepare(
      'INSERT INTO source_files (path, agent_type, cwd) VALUES (?, ?, ?)',
    );

    // cwd lives on source_files (keyed by file path); resolve a session's cwd by
    // joining through any of its chunks' file paths. Works for opencode too, whose
    // virtual `opencode://<id>` path gets a source_files row with the directory.
    this.stmtGetSessionCwd = this.db.prepare(`
      SELECT sf.cwd AS cwd
      FROM   source_files sf
      WHERE  sf.cwd IS NOT NULL
        AND  sf.path IN (SELECT DISTINCT file_path FROM chunks WHERE session_id = ?)
      LIMIT  1
    `);

    this.stmtSourceFilesMissingCwd = this.db.prepare(
      'SELECT path, agent_type FROM source_files WHERE cwd IS NULL',
    );

    this.stmtGetMeta = this.db.prepare('SELECT value FROM meta WHERE key = ?');

    this.stmtSetMeta = this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    this.stmtFtsSearch = this.db.prepare(`
      SELECT rowid AS id, rank
      FROM   chunks_fts
      WHERE  chunks_fts MATCH ?
      ORDER  BY rank
      LIMIT  ?
    `);

    // cwd-filtered FTS: restrict matches to chunks whose session ran in `cwd`.
    // cwd lives on source_files (keyed by file path), so the rowid filter maps
    // cwd → file paths → chunk ids. Params: match, cwd, limit.
    this.stmtFtsSearchCwd = this.db.prepare(`
      SELECT rowid AS id, rank
      FROM   chunks_fts
      WHERE  chunks_fts MATCH ?
        AND  rowid IN (${CHUNK_IDS_IN_CWD})
      ORDER  BY rank
      LIMIT  ?
    `);

    this.stmtCountVec = this.db.prepare('SELECT COUNT(*) AS n FROM chunks_vec');

    this.stmtVecSearch = this.db.prepare(`
      SELECT rowid AS id, distance
      FROM   chunks_vec
      WHERE  embedding MATCH ?
        AND  k = ?
      ORDER  BY distance
    `);

    // cwd-filtered vec KNN: sqlite-vec applies the rowid filter BEFORE ranking,
    // so this returns the k nearest *within* the cwd (not the global k then
    // filtered). Params: embedding, k, cwd.
    this.stmtVecSearchCwd = this.db.prepare(`
      SELECT rowid AS id, distance
      FROM   chunks_vec
      WHERE  embedding MATCH ?
        AND  k = ?
        AND  rowid IN (${CHUNK_IDS_IN_CWD})
      ORDER  BY distance
    `);

    this.stmtGetChunk = this.db.prepare('SELECT * FROM chunks WHERE id = ?');

    this.stmtGetSessionChunks = this.db.prepare(`
      SELECT * FROM chunks
      WHERE  session_id = ?
      ORDER  BY file_path, line_number
    `);

    this.stmtGetSessionFiles = this.db.prepare(`
      SELECT DISTINCT file_path AS filePath, agent_type AS agentType
      FROM   chunks
      WHERE  session_id = ?
      ORDER  BY file_path
    `);

    // Most recent message per session, newest first. Ordered by the session's
    // latest message TIMESTAMP — not line_number: line_number is a per-file line
    // offset, so long sessions (e.g. opencode, thousands of lines) would sort
    // above short but newer ones. Done in two index-backed steps so it never
    // scans the whole chunks table: `top` picks the N most recently active
    // sessions (GROUP BY + MAX(timestamp), covered by chunks_session_line_ts_idx),
    // then each session's single latest chunk is fetched (line_number desc, id asc —
    // the id tiebreak is needed for the claude adapter, which emits two chunks
    // at the same lineNumber+timestamp for a single assistant message that
    // contains both text and tool_use blocks; the text block is pushed first,
    // so id asc surfaces the text, not the tool). Within a session the max-line
    // chunk also carries the max timestamp (append-only log), so top.ts matches
    // the fetched chunk's timestamp. The correlated subquery resolves cwd like
    // getSessionCwd. (A ROW_NUMBER() window over all chunks did the same thing
    // but took ~60s on a 195k-row index — see chunks_session_line_ts_idx.)
    this.stmtRecentSessions = this.db.prepare(`
      WITH top AS (
        SELECT session_id, MAX(timestamp) AS ts
        FROM   chunks
        GROUP  BY session_id
        ORDER  BY ts DESC
        LIMIT  ?
      )
      SELECT
        c.session_id  AS sessionId,
        c.agent_type  AS agentType,
        c.file_path   AS filePath,
        c.line_number AS lineNumber,
        c.role        AS role,
        c.text        AS snippet,
        c.timestamp   AS timestamp,
        (
          SELECT sf.cwd FROM source_files sf
          WHERE sf.cwd IS NOT NULL
            AND sf.path IN (SELECT DISTINCT file_path FROM chunks WHERE session_id = c.session_id)
          LIMIT 1
        ) AS cwd
      FROM top
      JOIN chunks c ON c.id = (
        SELECT id FROM chunks
        WHERE session_id = top.session_id
        ORDER BY line_number DESC, id ASC
        LIMIT 1
      )
      ORDER BY c.timestamp DESC
    `);

    // ---- transactions ----

    // setEmbedding: write vec row + clear needs_embed flag, atomically.
    this.txnSetEmbedding = this.db.transaction((id: number, embedding: number[]) => {
      this.stmtInsertVec.run(BigInt(id), JSON.stringify(embedding));
      this.stmtClearNeedsEmbed.run(id);
    });

    // addChunks: wrap multiple addChunk calls in one transaction.
    this.txnBatch = this.db.transaction(
      (items: Array<{ chunk: Chunk }>) => items.map(({ chunk }) => this.addChunk(chunk)),
    );
  }

  // ------------------------------------------------------------------ schema

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id          INTEGER PRIMARY KEY,
        agent_type  TEXT    NOT NULL,
        session_id  TEXT    NOT NULL,
        file_path   TEXT    NOT NULL,
        line_number INTEGER NOT NULL,
        role        TEXT    NOT NULL,
        text        TEXT    NOT NULL DEFAULT '',
        tool_name   TEXT,
        tool_args   TEXT,
        timestamp   TEXT    NOT NULL,
        needs_embed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS source_files (
        path             TEXT    PRIMARY KEY,
        agent_type       TEXT    NOT NULL,
        inode            INTEGER,
        last_offset      INTEGER NOT NULL DEFAULT 0,
        last_size        INTEGER NOT NULL DEFAULT 0,
        last_line_number INTEGER NOT NULL DEFAULT 0,
        cwd              TEXT
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- FTS5 external-content table: text, tool_name, tool_args indexed together.
      -- Content is read back from the chunks table; triggers keep the index in sync.
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text, tool_name, tool_args,
        content='chunks', content_rowid='id'
      );

      -- sqlite-vec KNN table.
      -- Only user/assistant chunks with non-empty text get a row here.
      -- Rowids are bound as BigInt in better-sqlite3 (plain number throws).
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        embedding float[${EMBED_DIMS}]
      );

      -- Keep FTS5 in sync on INSERT.
      CREATE TRIGGER IF NOT EXISTS chunks_fts_ai
      AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text, tool_name, tool_args)
        VALUES (new.id, new.text, new.tool_name, new.tool_args);
      END;

      -- Keep FTS5 in sync on DELETE.
      CREATE TRIGGER IF NOT EXISTS chunks_fts_ad
      AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text, tool_name, tool_args)
        VALUES ('delete', old.id, old.text, old.tool_name, old.tool_args);
      END;
    `);

    // Idempotent migrations for existing databases that predate these columns.
    // When needs_embed is newly added, re-queue any eligible rows that lack a vec row
    // so they don't silently appear as "embedded" with queueStats().
    const migrations: Array<{ ddl: string; followUp?: string }> = [
      {
        ddl: 'ALTER TABLE chunks ADD COLUMN needs_embed INTEGER NOT NULL DEFAULT 0',
        followUp: `
          UPDATE chunks
          SET    needs_embed = 1
          WHERE  (role = 'user' OR role = 'assistant')
            AND  text != ''
            AND  id NOT IN (SELECT rowid FROM chunks_vec)
        `,
      },
      { ddl: 'ALTER TABLE source_files ADD COLUMN last_line_number INTEGER NOT NULL DEFAULT 0' },
      { ddl: 'ALTER TABLE source_files ADD COLUMN cwd TEXT' },
    ];

    for (const { ddl, followUp } of migrations) {
      try {
        this.db.exec(ddl);
        // Column was just added — run the follow-up if there is one.
        if (followUp) this.db.exec(followUp);
      } catch {
        // Column already exists — safe to ignore; do NOT run followUp again.
      }
    }

    // Partial index: only rows that need embedding. Created after the column exists.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS chunks_needs_embed_idx
      ON chunks(id) WHERE needs_embed = 1
    `);

    // Composite index on (session_id, line_number, timestamp): serves every
    // per-session lookup — recentSessions' grouping + latest-row fetch,
    // getSessionChunks/getSessionFiles' session_id equality, and the cwd
    // resolution subquery. The trailing `timestamp` makes recentSessions'
    // `MAX(timestamp)` a covering-index scan (no per-row table lookup); without
    // it, ordering the recent list by timestamp forces a rowid fetch per row.
    // Without the index at all these are full table scans; recentSessions in
    // particular went from ~60s to ~25ms.
    this.db.exec(`
      DROP INDEX IF EXISTS chunks_session_ts_idx;
      DROP INDEX IF EXISTS chunks_session_line_idx;
      CREATE INDEX IF NOT EXISTS chunks_session_line_ts_idx
      ON chunks(session_id, line_number, timestamp)
    `);
  }

  // ------------------------------------------------------------------ chunks

  /**
   * Insert one chunk. Returns the new row id.
   *
   * Sets `needs_embed = 1` only for user/assistant chunks with non-empty text.
   * Embedding is done later via `setEmbedding()` (queue-drain model).
   */
  addChunk(chunk: Chunk): number {
    const needsEmbed =
      (chunk.role === 'user' || chunk.role === 'assistant') && chunk.text.length > 0 ? 1 : 0;

    const result = this.stmtInsertChunk.run(
      chunk.agentType,
      chunk.sessionId,
      chunk.filePath,
      chunk.lineNumber,
      chunk.role,
      chunk.text,
      chunk.toolCall?.name ?? null,
      chunk.toolCall?.args ?? null,
      chunk.timestamp,
      needsEmbed,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Insert multiple chunks in a single transaction.
   * Returns all new row ids in insertion order.
   */
  addChunks(items: Array<{ chunk: Chunk }>): number[] {
    return this.txnBatch(items);
  }

  // ------------------------------------------------------------------ embedding queue

  /**
   * Take up to `limit` chunks that still need embedding.
   * Returns `{ id, text }` pairs — the caller embeds them and calls `setEmbedding`.
   */
  takePendingEmbeds(limit: number): { id: number; text: string }[] {
    return this.stmtTakePendingEmbeds.all(limit) as { id: number; text: string }[];
  }

  /**
   * Write the embedding for chunk `id` and clear `needs_embed`.
   * Both the vec insert and the flag clear happen in a single transaction.
   * Throws if `embedding.length !== EMBED_DIMS`.
   */
  setEmbedding(id: number, embedding: number[]): void {
    if (embedding.length !== EMBED_DIMS) {
      throw new Error(
        `setEmbedding: embedding has ${embedding.length} dimensions; expected ${EMBED_DIMS}`,
      );
    }
    this.txnSetEmbedding(id, embedding);
  }

  /**
   * Counts for CLI/web progress display.
   * - total:    user/assistant non-empty chunks (those that should get a vec row)
   * - pending:  still waiting for embedding (needs_embed = 1)
   * - embedded: already have a vec row (total - pending)
   */
  queueStats(): { total: number; embedded: number; pending: number } {
    const { total } = this.stmtQueueTotal.get() as { total: number };
    const { pending } = this.stmtQueuePending.get() as { pending: number };
    return { total, embedded: total - pending, pending };
  }

  // ------------------------------------------------------------------ source_files

  getSourceFile(path: string): SourceFile | undefined {
    const row = this.stmtGetSourceFile.get(path) as SourceFileRow | undefined;
    if (!row) return undefined;
    return {
      path: row.path,
      agentType: row.agent_type as JsonlAgentType,
      inode: row.inode ?? undefined,
      lastOffset: row.last_offset,
      lastSize: row.last_size,
      lastLineNumber: row.last_line_number,
      cwd: row.cwd ?? undefined,
    };
  }

  /**
   * Record the working directory for a source file. Updates the existing row;
   * if there is none (opencode's virtual path has no tail row), inserts one.
   * Leaves the tail columns at their defaults — only the cwd is set here.
   */
  setSourceFileCwd(path: string, cwd: string, agentType: string): void {
    const res = this.stmtUpdateCwd.run(cwd, path);
    if (res.changes === 0) {
      this.stmtInsertCwd.run(path, agentType, cwd);
    }
  }

  /** The working directory for a session, or undefined if not recorded yet. */
  getSessionCwd(sessionId: string): string | undefined {
    const row = this.stmtGetSessionCwd.get(sessionId) as { cwd: string } | undefined;
    return row?.cwd;
  }

  /** Source files that have no recorded cwd yet — input for the cwd backfill. */
  sourceFilesMissingCwd(): Array<{ path: string; agentType: string }> {
    const rows = this.stmtSourceFilesMissingCwd.all() as Array<{ path: string; agent_type: string }>;
    return rows.map((r) => ({ path: r.path, agentType: r.agent_type }));
  }

  upsertSourceFile(sf: SourceFile): void {
    this.stmtUpsertSourceFile.run(
      sf.path,
      sf.agentType,
      sf.inode ?? null,
      sf.lastOffset,
      sf.lastSize,
      sf.lastLineNumber,
    );
  }

  // ------------------------------------------------------------------ meta

  getMeta(key: string): string | undefined {
    const row = this.stmtGetMeta.get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.stmtSetMeta.run(key, value);
  }

  // ------------------------------------------------------------------ search helpers

  /**
   * Full-text search via FTS5 MATCH.
   * Returns rows ordered by FTS5 rank (negative; more-negative = better match).
   * The search layer uses this for the FTS side of RRF fusion.
   *
   * @param cwd  When set (absolute path), restrict matches to sessions that ran
   *             in that working directory.
   */
  ftsSearch(query: string, limit = 20, cwd?: string): Array<{ id: number; rank: number }> {
    const rows = cwd
      ? this.stmtFtsSearchCwd.all(query, cwd, limit)
      : this.stmtFtsSearch.all(query, limit);
    return rows as Array<{ id: number; rank: number }>;
  }

  /**
   * Vector KNN search (L2 distance).
   * Returns rows ordered by distance ascending (nearest first).
   * Returns an empty array when no vec rows exist.
   * The search layer uses this for the vector side of RRF fusion.
   *
   * @param cwd  When set (absolute path), restrict the KNN to sessions that ran
   *             in that working directory (filtered before ranking, so it's the
   *             k nearest within the cwd).
   */
  vecSearch(embedding: number[], limit = 20, cwd?: string): Array<{ id: number; distance: number }> {
    // Guard: sqlite-vec KNN on an empty table may throw; check first.
    const { n } = this.stmtCountVec.get() as { n: number };
    if (n === 0) return [];
    const json = JSON.stringify(embedding);
    const rows = cwd
      ? this.stmtVecSearchCwd.all(json, limit, cwd)
      : this.stmtVecSearch.all(json, limit);
    return rows as Array<{ id: number; distance: number }>;
  }

  // ------------------------------------------------------------------ session view

  /** Fetch a single chunk by its primary key id. Returns undefined if not found. */
  getChunk(id: number): Chunk | undefined {
    const row = this.stmtGetChunk.get(id) as ChunkRow | undefined;
    if (!row) return undefined;
    return rowToChunk(row);
  }

  /** All chunks for a session, ordered by file_path then line_number. */
  getSessionChunks(sessionId: string): Chunk[] {
    const rows = this.stmtGetSessionChunks.all(sessionId) as ChunkRow[];
    return rows.map(rowToChunk);
  }

  /** Distinct (file_path, agent_type) for a session, ordered by file_path. */
  getSessionFiles(sessionId: string): { filePath: string; agentType: string }[] {
    const rows = this.stmtGetSessionFiles.all(sessionId) as { filePath: string; agentType: string }[];
    return rows;
  }

  /**
   * The most recently touched sessions: one row per session (its most recent
   * message), ordered by that message's timestamp descending. Used to populate
   * the sidebar when there is no search query.
   */
  recentSessions(limit = 30): RecentSession[] {
    const rows = this.stmtRecentSessions.all(limit) as Array<{
      sessionId: string;
      agentType: string;
      filePath: string;
      lineNumber: number;
      role: string;
      snippet: string;
      timestamp: string;
      cwd: string | null;
    }>;
    return rows.map((r) => ({
      sessionId: r.sessionId,
      agentType: r.agentType as AgentType,
      filePath: r.filePath,
      lineNumber: r.lineNumber,
      role: r.role as RecentSession['role'],
      snippet: r.snippet,
      timestamp: r.timestamp,
      cwd: r.cwd ?? '',
    }));
  }

  // ------------------------------------------------------------------ embed guard

  /**
   * Check whether the stored embed_model/embed_dims match the current values.
   * Returns `{ matches: true }` when nothing is stored yet (virgin db — no conflict).
   * The caller decides what to do on mismatch (warn, reindex, etc.).
   */
  checkEmbedModel(model: string, dims: number): EmbedModelCheck {
    const storedModel = this.getMeta('embed_model');
    const storedDimsStr = this.getMeta('embed_dims');

    if (storedModel === undefined && storedDimsStr === undefined) {
      return { matches: true };
    }

    const storedDims = storedDimsStr !== undefined ? parseInt(storedDimsStr, 10) : undefined;
    const matches = storedModel === model && storedDims === dims;

    return {
      matches,
      stored: {
        model: storedModel ?? '',
        dims: storedDims ?? 0,
      },
    };
  }

  // ------------------------------------------------------------------ transaction helper

  /**
   * Run `fn` inside a single SQLite transaction. When called from within an
   * already-active transaction (e.g. from addChunks), better-sqlite3 promotes
   * the inner call to a SAVEPOINT automatically, keeping the whole operation
   * atomic.
   *
   * Use this when you need to combine two store operations (e.g. addChunks +
   * setMeta) atomically — the opencode source uses it to update the cursor and
   * insert chunks in one go.
   */
  runTransaction<T>(fn: () => T): T {
    return (this.db.transaction(fn) as () => T)();
  }

  // ------------------------------------------------------------------ lifecycle

  close(): void {
    this.db.close();
    this.lock?.release();
  }
}

// ------------------------------------------------------------------ helpers

function rowToChunk(row: ChunkRow): Chunk {
  return {
    agentType: row.agent_type as Chunk['agentType'],
    sessionId: row.session_id,
    filePath: row.file_path,
    lineNumber: row.line_number,
    role: row.role as Chunk['role'],
    text: row.text,
    toolCall:
      row.tool_name != null
        ? { name: row.tool_name, args: row.tool_args ?? '' }
        : undefined,
    timestamp: row.timestamp,
  };
}
