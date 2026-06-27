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

  // Persist updated tail state regardless of whether we got new lines.
  // This records inode/size changes even when no complete lines arrived.
  store.upsertSourceFile({
    path: filePath,
    agentType: adapter.agentType,
    inode: result.state.inode,
    lastOffset: result.state.lastOffset,
    lastSize: result.state.lastSize,
    lastLineNumber: result.state.lastLineNumber,
  });

  if (result.lines.length === 0) return 0;

  // Parse all new lines into chunks, then insert in a single transaction.
  const chunks = result.lines.flatMap((line) =>
    adapter.parseLine(line.text, { filePath, lineNumber: line.lineNumber }),
  );

  if (chunks.length > 0) {
    store.addChunks(chunks.map((chunk) => ({ chunk })));
  }

  return chunks.length;
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
