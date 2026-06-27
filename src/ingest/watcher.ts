/**
 * watcher.ts
 *
 * Watches the agent session directories with chokidar. On startup it scans
 * existing JSONL files (backfill) and thereafter reacts to new writes — both
 * paths call the same `indexFile` + embed `kick()` code. The embed queue
 * naturally covers backfill: no special case needed.
 *
 * Env overrides:
 *   AGENT_SEARCH_DIRS  — colon-separated list of dirs to watch (overrides defaults)
 */

import { watch } from 'chokidar';
import type { FSWatcher } from 'chokidar';
import { homedir } from 'node:os';
import { indexFile } from './indexer.js';
import type { Store } from '../index/store.js';
import type { Registry } from '../adapters/types.js';
import type { EmbedWorker } from './indexer.js';

// --------------------------------------------------------------------------- defaults

const DEFAULT_DIRS = [
  '~/.claude/projects',
  '~/.codex/sessions',
  '~/.pi/agent/sessions',
].map((d) => d.replace('~', homedir()));

function resolveDirs(): string[] {
  const env = process.env.AGENT_SEARCH_DIRS;
  if (env) return env.split(':').map((d) => d.replace('~', homedir()));
  return DEFAULT_DIRS;
}

// --------------------------------------------------------------------------- options

export interface WatcherOptions {
  /** Directories to watch. Defaults to the three agent log dirs (or AGENT_SEARCH_DIRS env). */
  dirs?: string[];
  /**
   * chokidar `awaitWriteFinish` option. Controls write-finish debouncing.
   * Default: { stabilityThreshold: 100, pollInterval: 50 }.
   * Set to `false` to disable (useful if you know writes are atomic).
   */
  awaitWriteFinish?: boolean | { stabilityThreshold: number; pollInterval: number };
}

// --------------------------------------------------------------------------- Watcher

export class Watcher {
  private fsWatcher: FSWatcher | null = null;

  // ---- backfill-ready tracking ----
  /** True once chokidar fires 'ready'. */
  private backfillReady = false;
  /** Resolvers for awaitBackfillEnqueued(). */
  private readonly backfillReadyResolvers: Array<() => void> = [];
  /**
   * Promises for handleFile() calls that fired before 'ready'.
   * awaitBackfillEnqueued() waits for both ready AND these.
   */
  private readonly preReadyPromises: Promise<void>[] = [];

  /** Per-file in-flight guard: prevents concurrent indexing of the same file. */
  private readonly indexing = new Set<string>();
  /**
   * Per-file rerun flag: set when a change event arrives for a file that is
   * already being indexed. After the current index pass finishes, the file is
   * indexed again to pick up bytes that arrived during the first pass.
   */
  private readonly rerequested = new Set<string>();

  private readonly dirs: string[];
  private readonly awaitWriteFinishOpt:
    | boolean
    | { stabilityThreshold: number; pollInterval: number };

  constructor(
    private readonly store: Store,
    private readonly registry: Registry,
    private readonly embedWorker: EmbedWorker,
    opts?: WatcherOptions,
  ) {
    this.dirs = opts?.dirs ?? resolveDirs();
    this.awaitWriteFinishOpt =
      opts?.awaitWriteFinish !== undefined
        ? opts.awaitWriteFinish
        : { stabilityThreshold: 100, pollInterval: 50 };
  }

  /**
   * Start watching. Fires `add` for all existing files (backfill) and then
   * `change` for new writes. Both paths are handled identically.
   */
  start(): void {
    if (this.fsWatcher) return; // already started

    this.fsWatcher = watch(this.dirs, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: this.awaitWriteFinishOpt,
    });

    this.fsWatcher.on('add', (filePath) => {
      const p = this.handleFile(filePath);
      if (!this.backfillReady) {
        // Track promises started before ready so awaitBackfillEnqueued() can join them.
        this.preReadyPromises.push(p);
      }
    });

    this.fsWatcher.on('change', (filePath) => void this.handleFile(filePath));

    this.fsWatcher.on('ready', () => {
      this.backfillReady = true;
      // Notify all callers that were waiting on the ready event.
      // They'll then also join preReadyPromises.
      const resolvers = this.backfillReadyResolvers.splice(0);
      for (const r of resolvers) r();
    });
  }

  /** Stop the watcher. Returns a promise that resolves when chokidar has closed. */
  stop(): Promise<void> {
    if (!this.fsWatcher) return Promise.resolve();
    const p = this.fsWatcher.close();
    this.fsWatcher = null;
    return p;
  }

  /**
   * Resolves after the initial scan is complete AND all file-index calls
   * triggered by it have finished. By the time this resolves, `kick()` has
   * been called for every backfill file, so pairing this with
   * `embedWorker.awaitIdle()` gives you full backfill completion.
   */
  async awaitBackfillEnqueued(): Promise<void> {
    if (!this.backfillReady) {
      await new Promise<void>((resolve) => {
        this.backfillReadyResolvers.push(resolve);
      });
    }
    // Also wait for any pre-ready handleFile() calls to settle.
    if (this.preReadyPromises.length > 0) {
      await Promise.all(this.preReadyPromises);
    }
  }

  // --------------------------------------------------------------------------- private

  private async handleFile(filePath: string): Promise<void> {
    if (!filePath.endsWith('.jsonl')) return;

    if (this.indexing.has(filePath)) {
      // A change arrived while this file is already being indexed.
      // Set the rerun flag — the current pass will loop and pick up the new bytes.
      this.rerequested.add(filePath);
      return;
    }

    this.indexing.add(filePath);
    try {
      do {
        this.rerequested.delete(filePath);
        await indexFile(filePath, this.store, this.registry);
        this.embedWorker.kick();
      } while (this.rerequested.has(filePath));
    } catch (err) {
      console.error(`[Watcher] Error indexing ${filePath}:`, err);
    } finally {
      this.indexing.delete(filePath);
      this.rerequested.delete(filePath);
    }
  }
}
