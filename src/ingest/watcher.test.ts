import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store, EMBED_DIMS } from '../index/store.js';
import type { Chunk } from '../types.js';
import type { Adapter, Registry } from '../adapters/types.js';
import type { Embedder } from '../embed/types.js';
import { indexFile, EmbedWorker } from './indexer.js';
import { Watcher } from './watcher.js';

// ---- helpers ----

const SCRATCHPAD =
  '/private/tmp/claude-502/-Users-agent-src-agent-search/4f5a42c3-0fd4-419a-a089-6c6297ac6150/scratchpad';

function makeTmpDir(): string {
  mkdirSync(SCRATCHPAD, { recursive: true });
  return mkdtempSync(join(SCRATCHPAD, 'watcher-test-'));
}

function makeEmbedding(): number[] {
  return Array(EMBED_DIMS).fill(0.1);
}

/** Adapter that claims any file in the given dir and parses each JSON line as a user chunk. */
function fakeAdapter(dir: string): Adapter {
  return {
    agentType: 'claude',
    rootDir: dir,
    claims: (filePath: string) => filePath.startsWith(dir),
    parseLine: (line: string, ctx): Chunk[] => {
      try {
        const obj = JSON.parse(line) as { role?: string; text?: string };
        if (!obj.role || !obj.text) return [];
        return [
          {
            agentType: 'claude',
            sessionId: 'watcher-session',
            filePath: ctx.filePath,
            lineNumber: ctx.lineNumber,
            role: obj.role as Chunk['role'],
            text: obj.text,
            timestamp: '2026-01-01T00:00:00Z',
          },
        ];
      } catch {
        return [];
      }
    },
  };
}

function fakeRegistry(dir: string): Registry {
  const adapter = fakeAdapter(dir);
  return { adapters: [adapter], forFile: (f) => (f.startsWith(dir) ? adapter : undefined) };
}

/** Immediate embedder with no network calls. */
function fakeEmbedder(): Embedder {
  return {
    model: 'test-model',
    dims: EMBED_DIMS,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => makeEmbedding());
    },
  };
}

/**
 * Wait until `predicate` returns true, checking every `intervalMs` up to `timeoutMs`.
 * Throws if timed out.
 */
async function waitUntil(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 5000, intervalMs = 50, label = 'condition' } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

// ---- tests ----

describe('Watcher', () => {
  let tmpDir: string;
  let store: Store;
  let embedWorker: EmbedWorker;
  let watcher: Watcher | null;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new Store(':memory:');
    embedWorker = new EmbedWorker(store, fakeEmbedder(), { backoffMs: 0 });
    watcher = null;
  });

  afterEach(async () => {
    if (watcher) {
      await watcher.stop();
      watcher = null;
    }
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes an existing JSONL file on startup (backfill)', async () => {
    // Write file before watcher starts
    const filePath = join(tmpDir, 'session.jsonl');
    writeFileSync(
      filePath,
      JSON.stringify({ role: 'user', text: 'existing line' }) + '\n',
    );

    watcher = new Watcher(store, fakeRegistry(tmpDir), embedWorker, { dirs: [tmpDir] });
    watcher.start();
    await watcher.awaitBackfillEnqueued();
    await embedWorker.awaitIdle();

    const chunks = store.getSessionChunks('watcher-session');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('existing line');
  });

  it('indexes a new JSONL file created after start', async () => {
    watcher = new Watcher(store, fakeRegistry(tmpDir), embedWorker, { dirs: [tmpDir] });
    watcher.start();
    await watcher.awaitBackfillEnqueued();

    // Create file after watcher is ready
    const filePath = join(tmpDir, 'new-session.jsonl');
    writeFileSync(
      filePath,
      JSON.stringify({ role: 'user', text: 'new line' }) + '\n',
    );

    await waitUntil(
      () => store.getSessionChunks('watcher-session').length >= 1,
      { label: 'new file indexed', timeoutMs: 5000 },
    );
    await embedWorker.awaitIdle();

    const chunks = store.getSessionChunks('watcher-session');
    expect(chunks[0].text).toBe('new line');
  });

  it('incrementally indexes an appended file', async () => {
    const filePath = join(tmpDir, 'incremental.jsonl');
    writeFileSync(
      filePath,
      JSON.stringify({ role: 'user', text: 'line one' }) + '\n',
    );

    watcher = new Watcher(store, fakeRegistry(tmpDir), embedWorker, { dirs: [tmpDir] });
    watcher.start();
    await watcher.awaitBackfillEnqueued();
    await embedWorker.awaitIdle();

    expect(store.getSessionChunks('watcher-session')).toHaveLength(1);

    // Append a second line
    appendFileSync(
      filePath,
      JSON.stringify({ role: 'assistant', text: 'line two' }) + '\n',
    );

    await waitUntil(
      () => store.getSessionChunks('watcher-session').length >= 2,
      { label: 'second line indexed', timeoutMs: 5000 },
    );
    await embedWorker.awaitIdle();

    const chunks = store.getSessionChunks('watcher-session');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe('line one');
    expect(chunks[1].text).toBe('line two');
    // Line numbers are continuous
    expect(chunks[0].lineNumber).toBe(1);
    expect(chunks[1].lineNumber).toBe(2);
  });

  it('ignores non-JSONL files', async () => {
    watcher = new Watcher(store, fakeRegistry(tmpDir), embedWorker, { dirs: [tmpDir] });
    watcher.start();
    await watcher.awaitBackfillEnqueued();

    // Write a non-JSONL file
    writeFileSync(join(tmpDir, 'notes.txt'), 'this is not jsonl');
    // Give chokidar time to fire (if it would)
    await new Promise<void>((r) => setTimeout(r, 300));

    expect(store.getSessionChunks('watcher-session')).toHaveLength(0);
  });

  it('kicks the embed worker after indexing', async () => {
    const filePath = join(tmpDir, 'embeds.jsonl');
    writeFileSync(
      filePath,
      JSON.stringify({ role: 'user', text: 'should get embedded' }) + '\n',
    );

    watcher = new Watcher(store, fakeRegistry(tmpDir), embedWorker, { dirs: [tmpDir] });
    watcher.start();
    await watcher.awaitBackfillEnqueued();
    await embedWorker.awaitIdle();

    // After watcher + worker drain, the chunk should be embedded
    const stats = store.queueStats();
    expect(stats.embedded).toBe(1);
    expect(stats.pending).toBe(0);
  });

  it('defaults watched dirs to the adapter rootDirs when none are passed', async () => {
    // No opts.dirs and no AGENT_SEARCH_DIRS → the watcher should derive dirs
    // from the registry's adapter rootDirs (tmpDir here), not a hardcoded list.
    const prevEnv = process.env.AGENT_SEARCH_DIRS;
    delete process.env.AGENT_SEARCH_DIRS;
    try {
      const filePath = join(tmpDir, 'default-dirs.jsonl');
      writeFileSync(
        filePath,
        JSON.stringify({ role: 'user', text: 'from adapter rootDir' }) + '\n',
      );

      watcher = new Watcher(store, fakeRegistry(tmpDir), embedWorker);
      watcher.start();
      await watcher.awaitBackfillEnqueued();
      await embedWorker.awaitIdle();

      const chunks = store.getSessionChunks('watcher-session');
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe('from adapter rootDir');
    } finally {
      if (prevEnv !== undefined) process.env.AGENT_SEARCH_DIRS = prevEnv;
    }
  });

  it('stop() closes the watcher cleanly', async () => {
    watcher = new Watcher(store, fakeRegistry(tmpDir), embedWorker, { dirs: [tmpDir] });
    watcher.start();
    await watcher.awaitBackfillEnqueued();
    await expect(watcher.stop()).resolves.toBeUndefined();
    watcher = null; // prevent afterEach from stopping again
  });
});
