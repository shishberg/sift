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
}

// ----- Store -----

export class Store {
  private readonly db: Database.Database;

  // Prepared statements — created once after schema is ready.
  private readonly stmtInsertChunk: Database.Statement;
  private readonly stmtInsertVec: Database.Statement;
  private readonly stmtGetSourceFile: Database.Statement;
  private readonly stmtUpsertSourceFile: Database.Statement;
  private readonly stmtGetMeta: Database.Statement;
  private readonly stmtSetMeta: Database.Statement;
  private readonly stmtFtsSearch: Database.Statement;
  private readonly stmtCountVec: Database.Statement;
  private readonly stmtVecSearch: Database.Statement;
  private readonly stmtGetSessionChunks: Database.Statement;

  // Cached transactions.
  private readonly txnChunkWithVec: (chunk: Chunk, embedding: number[]) => number;
  private readonly txnBatch: (items: Array<{ chunk: Chunk; embedding?: number[] }>) => number[];

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
        (agent_type, session_id, file_path, line_number, role, text, tool_name, tool_args, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertVec = this.db.prepare(
      'INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)',
    );

    this.stmtGetSourceFile = this.db.prepare('SELECT * FROM source_files WHERE path = ?');

    this.stmtUpsertSourceFile = this.db.prepare(`
      INSERT INTO source_files (path, agent_type, inode, last_offset, last_size)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        agent_type  = excluded.agent_type,
        inode       = excluded.inode,
        last_offset = excluded.last_offset,
        last_size   = excluded.last_size
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

    this.stmtGetSessionChunks = this.db.prepare(`
      SELECT * FROM chunks
      WHERE  session_id = ?
      ORDER  BY file_path, line_number
    `);

    // ---- transactions ----
    // Used by addChunk when an embedding is being written.
    // better-sqlite3 promotes inner transactions to savepoints when already inside a transaction.
    this.txnChunkWithVec = this.db.transaction((chunk: Chunk, embedding: number[]) => {
      const r = this.stmtInsertChunk.run(
        chunk.agentType,
        chunk.sessionId,
        chunk.filePath,
        chunk.lineNumber,
        chunk.role,
        chunk.text,
        chunk.toolCall?.name ?? null,
        chunk.toolCall?.args ?? null,
        chunk.timestamp,
      );
      // Use rawId directly for the BigInt conversion — avoid Number() intermediary
      // which loses precision beyond Number.MAX_SAFE_INTEGER.
      const rawId = r.lastInsertRowid;
      this.stmtInsertVec.run(BigInt(rawId), JSON.stringify(embedding));
      return Number(rawId);
    });

    // Used by addChunks — wraps multiple addChunk calls in one transaction.
    this.txnBatch = this.db.transaction(
      (items: Array<{ chunk: Chunk; embedding?: number[] }>) =>
        items.map(({ chunk, embedding }) => this.addChunk(chunk, embedding)),
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
        timestamp   TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_files (
        path        TEXT    PRIMARY KEY,
        agent_type  TEXT    NOT NULL,
        inode       INTEGER,
        last_offset INTEGER NOT NULL DEFAULT 0,
        last_size   INTEGER NOT NULL DEFAULT 0
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
  }

  // ------------------------------------------------------------------ chunks

  /**
   * Insert one chunk. Returns the new row id.
   *
   * Pass `embedding` to also write a KNN row. Spec rule enforced here:
   * only `role` user/assistant with non-empty `text` get a vec row. Passing
   * an embedding for a tool or empty-text chunk is silently ignored.
   *
   * When an embedding IS written, both the chunk row and the vec row are
   * committed atomically (the whole addChunk rolls back if the vec insert fails).
   */
  addChunk(chunk: Chunk, embedding?: number[]): number {
    // Per spec: embed only user/assistant chunks with non-empty text.
    const canEmbed = embedding != null && chunk.role !== 'tool' && chunk.text.length > 0;

    if (canEmbed) {
      // Validate dimension upfront for a clear error; also prevents a partial write.
      if (embedding!.length !== EMBED_DIMS) {
        throw new Error(
          `Embedding has ${embedding!.length} dimensions; expected ${EMBED_DIMS}`,
        );
      }
      // txnChunkWithVec wraps both the chunk insert (+ FTS trigger) and vec insert atomically.
      return this.txnChunkWithVec(chunk, embedding!);
    }

    // No embedding: single INSERT (+ FTS trigger fires in SQLite's implicit transaction).
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
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Insert multiple chunks in a single transaction.
   * Returns all new row ids in insertion order.
   */
  addChunks(items: Array<{ chunk: Chunk; embedding?: number[] }>): number[] {
    return this.txnBatch(items);
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
    };
  }

  upsertSourceFile(sf: SourceFile): void {
    this.stmtUpsertSourceFile.run(
      sf.path,
      sf.agentType,
      sf.inode ?? null,
      sf.lastOffset,
      sf.lastSize,
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
