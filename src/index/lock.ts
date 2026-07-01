/**
 * lock.ts
 *
 * Process-level lock for the index database. Prevents two `sift` processes
 * (e.g. `sift serve --watch` and `sift index --delete`) from writing to the
 * same `index.db` at the same time — which would silently produce split-brain
 * state where each process holds its own inode and writes to whichever it
 * opened first.
 *
 * Stored as `<dbPath>.lock` containing the owning PID. Stale locks (PID no
 * longer alive) are taken over automatically on the next `acquire()` — this is
 * the recovery path for crashes and force-kills (e.g. second Ctrl-C during
 * graceful shutdown).
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';

/** Thrown when {@link Lock.acquire} finds the lock held by a live other process. */
export class LockHeldError extends Error {
  constructor(
    public readonly pid: number,
    public readonly lockPath: string,
  ) {
    super(
      `Another process (PID ${pid}) holds ${lockPath}. ` +
        `If that process is no longer running, remove the lock file and try again.`,
    );
    this.name = 'LockHeldError';
  }
}

export interface LockOptions {
  /** Override the owning PID (testing). Defaults to `process.pid`. */
  pid?: number;
  /** Override the liveness check (testing). Defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
}

export class Lock {
  private readonly lockPath: string;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private acquired = false;

  constructor(dbPath: string, opts: LockOptions = {}) {
    this.lockPath = dbPath + '.lock';
    this.pid = opts.pid ?? process.pid;
    this.isAlive = opts.isAlive ?? defaultIsAlive;
  }

  /**
   * Try to take the lock. Throws {@link LockHeldError} if another live process
   * owns it; otherwise overwrites any stale lock file. Re-acquiring the lock
   * you already hold (same PID) is a no-op.
   *
   * Uses `wx` (create-exclusive) so two processes racing on a stale lock
   * don't both think they own it — the filesystem serialises the create,
   * and the loser sees EEXIST and re-reads the (now live) winner's PID.
   */
  acquire(): void {
    if (this.acquired) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        writeFileSync(this.lockPath, String(this.pid), { flag: 'wx' });
        this.acquired = true;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      // Lock exists. Inspect it.
      const existing = this.readExisting();
      if (existing === this.pid) {
        // Ours (e.g. second call from same process) — keep the file as-is.
        this.acquired = true;
        return;
      }
      if (existing === null) {
        // Garbled file. Try to remove and retry.
        this.unlinkQuiet();
        continue;
      }
      if (this.isAlive(existing)) {
        throw new LockHeldError(existing, this.lockPath);
      }
      // Stale. Try to remove and retry.
      this.unlinkQuiet();
    }
    throw new Error(`Failed to acquire lock at ${this.lockPath} after 3 attempts`);
  }

  private unlinkQuiet(): void {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Raced with another process removing the file — fine, retry loop will
      // re-check via readExisting().
    }
  }

  /**
   * Remove the lock file — but only if we still own it. Safe to call multiple
   * times; safe to call when no lock file exists.
   */
  release(): void {
    if (!existsSync(this.lockPath)) {
      this.acquired = false;
      return;
    }
    const existing = this.readExisting();
    if (existing !== this.pid) {
      // Not ours — leave it alone. Could happen if another process overwrote
      // our lock (shouldn't, but be defensive).
      this.acquired = false;
      return;
    }
    unlinkSync(this.lockPath);
    this.acquired = false;
  }

  private readExisting(): number | null {
    try {
      const content = readFileSync(this.lockPath, 'utf8').trim();
      const pid = parseInt(content, 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
