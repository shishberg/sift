/**
 * indexer.ts
 *
 * Two exports:
 *  - `indexFile(filePath, store, registry)` — reads new lines from a JSONL file
 *    via the byte-offset tail reader, parses them with the matching adapter, writes
 *    chunk rows to the store, and persists the new tail state.
 *
 *  - `EmbedWorker` — single-flight consumer that drains `chunks.needs_embed = 1`
 *    rows by calling the embedder and writing vec rows via `store.setEmbedding`.
 *    Start a drain pass with `kick()`; repeated kicks while running are coalesced
 *    into at most one additional pass.
 */

import { openSync, readSync, closeSync } from 'node:fs';
import { tailFile } from './tail.js';
import type { Store } from '../index/store.js';
import type { Registry } from '../adapters/types.js';
import type { Embedder } from '../embed/types.js';
import type { TailState } from './tail.js';

// --------------------------------------------------------------------------- indexFile

/**
 * Read newly-appended lines from `filePath`, parse them with the matching
 * adapter, and write the resulting chunks to the store.
 *
 * @returns The number of chunks written (0 if no adapter claims the file or
 *          no new complete lines were available).
 */
export async function indexFile(
  filePath: string,
  store: Store,
  registry: Registry,
): Promise<number> {
  const adapter = registry.forFile(filePath);
  if (!adapter) return 0;

  // Reconstruct TailState from the persisted source_files row (if any).
  const prior = store.getSourceFile(filePath);
  const priorState: TailState | undefined = prior
    ? {
        inode: prior.inode ?? 0,
        lastOffset: prior.lastOffset,
        lastSize: prior.lastSize,
        lastLineNumber: prior.lastLineNumber,
      }
    : undefined;

  const result = await tailFile(filePath, priorState);

  const sourceFile = {
    path: filePath,
    agentType: adapter.agentType,
    inode: result.state.inode,
    lastOffset: result.state.lastOffset,
    lastSize: result.state.lastSize,
    lastLineNumber: result.state.lastLineNumber,
  };

  // No new complete lines: just record inode/size/offset movement and stop.
  if (result.lines.length === 0) {
    store.upsertSourceFile(sourceFile);
    return 0;
  }

  // Parse first. If an adapter throws here, we fall through WITHOUT advancing the
  // tail state, so the next pass re-reads these same lines instead of skipping them.
  const chunks = result.lines.flatMap((line) =>
    adapter.parseLine(line.text, { filePath, lineNumber: line.lineNumber }),
  );

  // Insert the chunks and advance the tail state atomically: either both commit
  // or neither does. If the chunk insert fails, the offset is not advanced, so the
  // next pass re-reads the lines cleanly — no dropped content, no duplicates.
  store.runTransaction(() => {
    if (chunks.length > 0) {
      store.addChunks(chunks.map((chunk) => ({ chunk })));
    }
    store.upsertSourceFile(sourceFile);
  });

  // Capture the working directory once. It's recorded on a metadata line that
  // may not itself produce a chunk (codex/pi), so scan the raw lines — not just
  // the parsed chunks. Skip if we already have it for this file.
  if (!prior?.cwd) {
    for (const line of result.lines) {
      const cwd = adapter.extractCwd(line.text);
      if (cwd) {
        store.setSourceFileCwd(filePath, cwd, adapter.agentType);
        break;
      }
    }
  }

  return chunks.length;
}

// --------------------------------------------------------------------------- backfillCwd

/** Read up to `maxBytes` from the start of a file as complete lines. */
function readHeadLines(filePath: string, maxBytes = 1_000_000): string[] {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    const lines = buf.toString('utf8', 0, bytes).split('\n');
    // If we filled the buffer we may have cut a line in half — drop the tail.
    if (bytes === maxBytes) lines.pop();
    return lines;
  } finally {
    closeSync(fd);
  }
}

/**
 * One-time backfill of the `cwd` column for data indexed before it existed.
 *
 * The incremental tail never re-reads old lines, so existing source files keep
 * a null cwd. This reads the head of each such file, extracts the working
 * directory via the matching adapter, and records it. opencode (which has no
 * JSONL files) is handled by its source's own backfill, if provided.
 *
 * @returns the number of cwds newly recorded.
 */
export async function backfillCwd(
  store: Store,
  registry: Registry,
  opencodeSource?: { backfillCwd(store: Store): number },
): Promise<number> {
  let filled = 0;

  for (const { path: filePath } of store.sourceFilesMissingCwd()) {
    const adapter = registry.forFile(filePath);
    if (!adapter) continue;

    let cwd: string | undefined;
    try {
      for (const line of readHeadLines(filePath)) {
        const c = adapter.extractCwd(line);
        if (c) {
          cwd = c;
          break;
        }
      }
    } catch {
      continue; // file missing or unreadable — skip it
    }

    if (cwd) {
      store.setSourceFileCwd(filePath, cwd, adapter.agentType);
      filled++;
    }
  }

  if (opencodeSource) filled += opencodeSource.backfillCwd(store);

  return filled;
}

// --------------------------------------------------------------------------- EmbedWorker

export interface EmbedWorkerOptions {
  /** How many pending embeds to fetch per embed() call. Default: 50. */
  batchSize?: number;
  /**
   * Milliseconds to wait after an embed error before stopping the current run.
   * The next kick() will retry. Default: 1000. Set to 0 in tests for speed.
   */
  backoffMs?: number;
}

/**
 * Single-flight embedding consumer.
 *
 * Call `kick()` to start (or schedule) a drain pass. If a pass is already
 * running, `kick()` is a no-op but sets a flag so one more pass runs when
 * the current one finishes. On embed error, the current pass stops (rows
 * keep `needs_embed = 1`); the next `kick()` retries.
 */
export class EmbedWorker {
  private running = false;
  private rerunRequested = false;
  private _lastError: Error | undefined;
  private readonly idleResolvers: Array<() => void> = [];
  private readonly batchSize: number;
  private readonly backoffMs: number;

  constructor(
    private readonly store: Store,
    private readonly embedder: Embedder,
    opts?: EmbedWorkerOptions,
  ) {
    this.batchSize = opts?.batchSize ?? 50;
    this.backoffMs = opts?.backoffMs ?? 1000;
  }

  /** Start a drain pass. If one is already running, schedule one more. */
  kick(): void {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = true;
    // Fire-and-forget; errors are caught inside drain().
    void this.drain();
  }

  /** True while a drain pass is in progress. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * The most recent embed error, or undefined if the last pass succeeded
   * (or no pass has run yet). Updated every time a batch fails.
   */
  get lastError(): Error | undefined {
    return this._lastError;
  }

  /**
   * Resolves when the worker becomes idle (no pass running and no pass
   * scheduled). Resolves immediately if already idle.
   */
  awaitIdle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  // ---- private ----

  private async drain(): Promise<void> {
    try {
      do {
        this.rerunRequested = false;
        this._lastError = undefined; // reset at the start of each pass
        let errorOccurred = false;

        while (!errorOccurred) {
          const pending = this.store.takePendingEmbeds(this.batchSize);
          if (pending.length === 0) break;

          try {
            const texts = pending.map((p) => p.text);
            const embeddings = await this.embedder.embed(texts, 'document');
            for (let i = 0; i < pending.length; i++) {
              this.store.setEmbedding(pending[i]!.id, embeddings[i]!);
            }
          } catch (err) {
            this._lastError = err instanceof Error ? err : new Error(String(err));
            console.error(
              '[EmbedWorker] embed error — rows stay pending, will retry on next kick:',
              err,
            );
            if (this.backoffMs > 0) {
              await new Promise<void>((r) => setTimeout(r, this.backoffMs));
            }
            this.rerunRequested = false; // Don't loop again on this error
            errorOccurred = true;
          }
        }
      } while (this.rerunRequested);
    } finally {
      this.running = false;
      this.notifyIdle();
    }
  }

  private notifyIdle(): void {
    const resolvers = this.idleResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }
}
