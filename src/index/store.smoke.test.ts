import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { describe, it, expect } from 'vitest';

describe('native stack smoke test', () => {
  it('loads better-sqlite3 and sqlite-vec, confirms vec_version() returns a string', () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);

    const row = db.prepare('SELECT vec_version() AS version').get() as { version: string };
    expect(typeof row.version).toBe('string');
    expect(row.version.length).toBeGreaterThan(0);

    db.close();
  });

  it('creates a vec0 virtual table and runs a KNN MATCH query', () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);

    db.exec('CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[3])');
    // vec0 requires the rowid bound as a true integer; better-sqlite3 needs a BigInt for that.
    db.prepare('INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)').run(
      1n,
      JSON.stringify([1, 2, 3]),
    );

    const rows = db
      .prepare('SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 1')
      .all(JSON.stringify([1, 2, 3])) as Array<{ rowid: number; distance: number }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].rowid).toBe(1);

    // The real store uses 768-dim vectors; confirm that dimensionality is accepted too.
    expect(() => {
      db.exec('CREATE VIRTUAL TABLE chunks_vec_768 USING vec0(embedding float[768])');
    }).not.toThrow();

    db.close();
  });

  it('confirms FTS5 is available', () => {
    const db = new Database(':memory:');

    expect(() => {
      db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    }).not.toThrow();

    db.close();
  });
});
