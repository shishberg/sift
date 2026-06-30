/**
 * opencode-poller.ts
 *
 * opencode is a SQLite DB source, not a watched JSONL file, so the chokidar
 * watcher never sees its writes. opencode also runs SQLite in WAL mode, so new
 * data lands in the `-wal` file and the `.db` mtime does NOT reliably change —
 * file-mtime watching would miss writes. So instead we POLL on a fixed interval:
 * each tick runs the cheap cursor-based import (only rows past the persisted
 * cursor) and, if it indexed anything, kicks the embed worker to drain the new
 * `needs_embed` rows.
 *
 * This class owns only the polling lifecycle. It takes callbacks so it can be
 * unit-tested in isolation with fake timers — it knows nothing about
 * OpenCodeSource, the Store, or the EmbedWorker directly.
 */

/** Default poll interval: cheap cursor read, frequent enough to feel live. */
export const DEFAULT_OPENCODE_POLL_INTERVAL_MS = 2000;

export interface OpencodePollerOptions {
  /**
   * Run one import pass. Returns the number of chunks indexed (0 when nothing
   * is new). May be sync or async. Should be the cursor-based import.
   */
  poll: () => number | Promise<number>;
  /** Called after a poll that indexed > 0 chunks — e.g. kick the embed worker. */
  onChunksIndexed: () => void;
  /** Poll interval in ms. Defaults to {@link DEFAULT_OPENCODE_POLL_INTERVAL_MS}. */
  intervalMs?: number;
  /**
   * Called when a poll throws/rejects (e.g. transient "database is locked").
   * The error is swallowed so the loop never dies; this is just for logging.
   */
  onError?: (err: unknown) => void;
  /** Called once by stop(), after the interval is cleared — e.g. close the DB source. */
  onStop?: () => void;
}

export class OpencodePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** In-flight guard: skip a tick if the previous poll hasn't finished. */
  private inFlight = false;
  private stopped = false;

  private readonly poll: () => number | Promise<number>;
  private readonly onChunksIndexed: () => void;
  private readonly intervalMs: number;
  private readonly onError?: (err: unknown) => void;
  private readonly onStop?: () => void;

  constructor(opts: OpencodePollerOptions) {
    this.poll = opts.poll;
    this.onChunksIndexed = opts.onChunksIndexed;
    this.intervalMs = opts.intervalMs ?? DEFAULT_OPENCODE_POLL_INTERVAL_MS;
    this.onError = opts.onError;
    this.onStop = opts.onStop;
  }

  /**
   * Begin polling. The first tick fires after one interval (not immediately) —
   * the caller's one-shot startup import already covers the existing backlog.
   * Idempotent: a second start() while running is a no-op.
   */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Don't let the interval keep the process alive on its own.
    this.timer.unref?.();
  }

  /** Stop polling, clear the interval, and release resources (onStop). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.onStop?.();
  }

  private async tick(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    try {
      const count = await this.poll();
      if (!this.stopped && count > 0) this.onChunksIndexed();
    } catch (err) {
      this.onError?.(err);
    } finally {
      this.inFlight = false;
    }
  }
}
