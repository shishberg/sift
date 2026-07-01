import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Lock, LockHeldError } from './lock.js';

describe('Lock', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lock-test-'));
    dbPath = join(dir, 'index.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires the lock when no lock file exists', () => {
    const lock = new Lock(dbPath, { pid: 100, isAlive: () => false });
    lock.acquire();
    expect(existsSync(dbPath + '.lock')).toBe(true);
    expect(readFileSync(dbPath + '.lock', 'utf8')).toBe('100');
    lock.release();
  });

  it('takes over a stale lock from a dead PID', () => {
    writeFileSync(dbPath + '.lock', '200');
    const lock = new Lock(dbPath, { pid: 300, isAlive: (pid: number) => pid === 200 ? false : true });
    lock.acquire();
    expect(readFileSync(dbPath + '.lock', 'utf8')).toBe('300');
    lock.release();
  });

  it('throws LockHeldError when a live PID holds the lock', () => {
    writeFileSync(dbPath + '.lock', '400');
    const lock = new Lock(dbPath, { pid: 500, isAlive: (pid: number) => pid === 400 });
    expect(() => lock.acquire()).toThrow(LockHeldError);
    // Lock file untouched.
    expect(readFileSync(dbPath + '.lock', 'utf8')).toBe('400');
  });

  it('lets a process re-acquire its own existing lock (e.g. double-open)', () => {
    writeFileSync(dbPath + '.lock', '600');
    const lock = new Lock(dbPath, { pid: 600, isAlive: () => true });
    expect(() => lock.acquire()).not.toThrow();
    expect(readFileSync(dbPath + '.lock', 'utf8')).toBe('600');
  });

  it('takes over a garbled lock file (non-numeric content)', () => {
    writeFileSync(dbPath + '.lock', 'not a pid at all\n');
    const lock = new Lock(dbPath, { pid: 1100, isAlive: () => false });
    expect(() => lock.acquire()).not.toThrow();
    expect(readFileSync(dbPath + '.lock', 'utf8')).toBe('1100');
    lock.release();
  });

  it('release() removes the lock file', () => {
    const lock = new Lock(dbPath, { pid: 700, isAlive: () => false });
    lock.acquire();
    lock.release();
    expect(existsSync(dbPath + '.lock')).toBe(false);
  });

  it('release() is a no-op if no lock file exists', () => {
    const lock = new Lock(dbPath, { pid: 800, isAlive: () => false });
    expect(() => lock.release()).not.toThrow();
  });

  it('release() does not remove a lock owned by another process', () => {
    writeFileSync(dbPath + '.lock', '900');
    const lock = new Lock(dbPath, { pid: 1000, isAlive: () => true });
    lock.release();
    expect(existsSync(dbPath + '.lock')).toBe(true);
    expect(readFileSync(dbPath + '.lock', 'utf8')).toBe('900');
  });

  it('LockHeldError carries the offending PID and lock path', () => {
    const err = new LockHeldError(42, '/tmp/foo.db.lock');
    expect(err.pid).toBe(42);
    expect(err.lockPath).toBe('/tmp/foo.db.lock');
    expect(err.message).toContain('42');
    expect(err.message).toContain('/tmp/foo.db.lock');
  });
});
