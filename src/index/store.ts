import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Chunk } from '../types.js';

/** Embedding dimension for nomic-embed-text. One place to change if the model changes. */
export const EMBED_DIMS = 768;

export interface SourceFile {
  path: string;
  agentType: 'claude' | 'codex' | 'pi';
  inode?: number;
  lastOffset: number;
  lastSize: number;
  /** 1-based line number of the last indexed complete line (0 on first index). */
  lastLineNumber: number;
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
}

// ----- Store -----

export class Store {
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
  private readonly stmtGetMeta: Database.Statement;
  private readonly stmtSetMeta: Database.Statement;
  private readonly stmtFtsSearch: Database.Statement;
  private readonly stmtCountVec: Database.Statement;
  private readonly stmtVecSearch: Database.Statement;
  private readonly stmtGetChunk: Database.Statement;
  private readonly stmtGetSessionChunks: Database.Statement;

  // Cached transactions.
  private readonly txnBatch: (items: Array<{ chunk: Chunk }>) => number[];
  private readonly txnSetEmbedding: (id: number, embedding: number[]) => void;

  /**
   * Open (or create) the index database.
   *
   * @param dbPath  Explicit path, or `:memory:` for tests. Defaults to
   *                `$AGENT_SEARCH_DB` or `~/.agent-search/index.db`.
   */
  constructor(dbPath?: string) {
    const resolved =
      dbPath ?? process.env.AGENT_SEARCH_DB ?? join(homedir(), '.agent-search', 'index.db');

    if (resolved !== ':memory:') {
      mkdirSync(dirname(resolved), { recursive: true });
    }

    this.db = new Database(resolved);
    sqliteVec.load(this.db);
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

    this.stmtCountVec = this.db.prepare('SELECT COUNT(*) AS n FROM chunks_vec');

    this.stmtVecSearch = this.db.prepare(`
      SELECT rowid AS id, distance
      FROM   chunks_vec
      WHERE  embedding MATCH ?
        AND  k = ?
      ORDER  BY distance
    `);

    this.stmtGetChunk = this.db.prepare('SELECT * FROM chunks WHERE id = ?');

    this.stmtGetSessionChunks = this.db.prepare(`
      SELECT * FROM chunks
      WHERE  session_id = ?
      ORDER  BY file_path, line_number
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
        last_line_number INTEGER NOT NULL DEFAULT 0
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
      agentType: row.agent_type as SourceFile['agentType'],
      inode: row.inode ?? undefined,
      lastOffset: row.last_offset,
      lastSize: row.last_size,
      lastLineNumber: row.last_line_number,
    };
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
   */
  ftsSearch(query: string, limit = 20): Array<{ id: number; rank: number }> {
    return this.stmtFtsSearch.all(query, limit) as Array<{ id: number; rank: number }>;
  }

  /**
   * Vector KNN search (L2 distance).
   * Returns rows ordered by distance ascending (nearest first).
   * Returns an empty array when no vec rows exist.
   * The search layer uses this for the vector side of RRF fusion.
   */
  vecSearch(embedding: number[], limit = 20): Array<{ id: number; distance: number }> {
    // Guard: sqlite-vec KNN on an empty table may throw; check first.
    const { n } = this.stmtCountVec.get() as { n: number };
    if (n === 0) return [];
    return this.stmtVecSearch.all(JSON.stringify(embedding), limit) as Array<{
      id: number;
      distance: number;
    }>;
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

  // ------------------------------------------------------------------ lifecycle

  close(): void {
    this.db.close();
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
