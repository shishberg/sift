import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, EMBED_DIMS } from '../index/store.js';
import type { Chunk } from '../types.js';
import type { Adapter, Registry } from '../adapters/types.js';
import type { Embedder } from '../embed/types.js';
import { indexFile, EmbedWorker, backfillCwd } from './indexer.js';

// ---- helpers ----

const SCRATCHPAD =
  '/private/tmp/claude-502/-Users-agent-src-agent-search/4f5a42c3-0fd4-419a-a089-6c6297ac6150/scratchpad';

function makeTmpDir(): string {
  mkdirSync(SCRATCHPAD, { recursive: true });
  return mkdtempSync(join(SCRATCHPAD, 'indexer-test-'));
}

function makeEmbedding(value = 0.1): number[] {
  return Array(EMBED_DIMS).fill(value);
}

/** Adapter that claims any file in the given dir and parses each JSON line as a user chunk. */
function fakeAdapter(dir: string): Adapter {
  return {
    agentType: 'claude',
    rootDir: dir,
    claims: (filePath: string) => filePath.startsWith(dir),
    extractCwd: (line: string): string | undefined => {
      try {
        const o = JSON.parse(line) as { cwd?: string };
        return typeof o.cwd === 'string' ? o.cwd : undefined;
      } catch {
        return undefined;
      }
    },
    parseLine: (line: string, ctx): Chunk[] => {
      try {
        const obj = JSON.parse(line) as { role?: string; text?: string };
        if (!obj.role || !obj.text) return [];
        return [
          {
            agentType: 'claude',
            sessionId: 'test-session',
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
  return {
    adapters: [adapter],
    forFile: (filePath: string) =>
      filePath.startsWith(dir) ? adapter : undefined,
  };
}

/** Deterministic embedder: unique vector per text string, no network. */
function makeEmbedder(opts?: { failCount?: number }): Embedder & { callCount: number } {
  let callCount = 0;
  let failsLeft = opts?.failCount ?? 0;

  return {
    model: 'test-model',
    dims: EMBED_DIMS,
    callCount: 0,
    async embed(texts: string[]): Promise<number[][]> {
      callCount++;
      (this as { callCount: number }).callCount = callCount;
      if (failsLeft > 0) {
        failsLeft--;
        throw new Error('fake embed error');
      }
      // deterministic: first byte of each text determines the fill value
      return texts.map((t) => Array(EMBED_DIMS).fill(t.charCodeAt(0) / 255));
    },
  };
}

// ---- tests ----

describe('indexFile', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes a JSONL file and writes chunks to the store', async () => {
    const filePath = join(tmpDir, 'test.jsonl');
    writeFileSync(
      filePath,
      [
        JSON.stringify({ role: 'user', text: 'hello there' }),
        JSON.stringify({ role: 'assistant', text: 'hello back' }),
      ].join('\n') + '\n',
    );

    const count = await indexFile(filePath, store, fakeRegistry(tmpDir));
    expect(count).toBe(2);

    const chunks = store.getSessionChunks('test-session');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe('hello there');
    expect(chunks[1].text).toBe('hello back');
  });

  it('marks user/assistant chunks as pending embed', async () => {
    const filePath = join(tmpDir, 'pending.jsonl');
    writeFileSync(
      filePath,
      JSON.stringify({ role: 'user', text: 'embed me' }) + '\n',
    );

    await indexFile(filePath, store, fakeRegistry(tmpDir));

    const pending = store.takePendingEmbeds(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toBe('embed me');
  });

  it('indexes tool chunks as FTS-only (not pending embed)', async () => {
    const adapter = fakeAdapter(tmpDir);
    const toolAdapter: Adapter = {
      ...adapter,
      parseLine: (line, ctx): Chunk[] => [
        {
          agentType: 'claude',
          sessionId: 'test-session',
          filePath: ctx.filePath,
          lineNumber: ctx.lineNumber,
          role: 'tool',
          text: '',
          toolCall: { name: 'bash', args: '{}' },
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
    };
    const registry: Registry = {
      adapters: [toolAdapter],
      forFile: () => toolAdapter,
    };

    const filePath = join(tmpDir, 'tool.jsonl');
    writeFileSync(filePath, JSON.stringify({ x: 1 }) + '\n');

    await indexFile(filePath, store, registry);
    expect(store.takePendingEmbeds(10)).toHaveLength(0);
    // tool chunks appear in FTS
    const ftsResults = store.ftsSearch('bash', 10);
    expect(ftsResults.length).toBeGreaterThan(0);
  });

  it('updates source_files with offset and line number after indexing', async () => {
    const filePath = join(tmpDir, 'offsets.jsonl');
    const line = JSON.stringify({ role: 'user', text: 'hi' }) + '\n';
    writeFileSync(filePath, line);

    await indexFile(filePath, store, fakeRegistry(tmpDir));

    const sf = store.getSourceFile(filePath);
    expect(sf).toBeDefined();
    expect(sf!.lastOffset).toBe(Buffer.byteLength(line, 'utf8'));
    expect(sf!.lastLineNumber).toBe(1);
  });

  it('does not advance the tail state if the chunk insert fails (atomic)', async () => {
    const filePath = join(tmpDir, 'atomic.jsonl');
    writeFileSync(filePath, JSON.stringify({ role: 'user', text: 'hi' }) + '\n');

    // Simulate the chunk insert blowing up (e.g. a non-bindable field).
    const spy = vi.spyOn(store, 'addChunks').mockImplementation(() => {
      throw new Error('insert failed');
    });

    await expect(indexFile(filePath, store, fakeRegistry(tmpDir))).rejects.toThrow('insert failed');

    // Tail state must NOT have advanced — otherwise the next pass would skip these
    // lines and the content would be lost forever.
    expect(store.getSourceFile(filePath)).toBeUndefined();

    // With the insert working again, the same lines are re-read and indexed.
    spy.mockRestore();
    const count = await indexFile(filePath, store, fakeRegistry(tmpDir));
    expect(count).toBe(1);
    expect(store.getSessionChunks('test-session')).toHaveLength(1);
    expect(store.getSourceFile(filePath)!.lastLineNumber).toBe(1);
  });

  it('captures the working directory from the log onto the source file', async () => {
    const filePath = join(tmpDir, 'cwd.jsonl');
    writeFileSync(
      filePath,
      JSON.stringify({ role: 'user', text: 'hi', cwd: '/Users/agent/src/agent-search' }) + '\n',
    );

    await indexFile(filePath, store, fakeRegistry(tmpDir));

    expect(store.getSourceFile(filePath)!.cwd).toBe('/Users/agent/src/agent-search');
    expect(store.getSessionCwd('test-session')).toBe('/Users/agent/src/agent-search');
  });

  it('captures cwd from a metadata line that produces no chunks', async () => {
    const filePath = join(tmpDir, 'cwd-sep.jsonl');
    writeFileSync(
      filePath,
      [
        JSON.stringify({ cwd: '/Users/agent/src/proj' }), // metadata only — no chunk
        JSON.stringify({ role: 'user', text: 'hi' }), // chunk, no cwd
      ].join('\n') + '\n',
    );

    await indexFile(filePath, store, fakeRegistry(tmpDir));

    expect(store.getSessionCwd('test-session')).toBe('/Users/agent/src/proj');
  });

  it('backfillCwd fills cwd for an already-indexed file by reading its head', async () => {
    const filePath = join(tmpDir, 'old.jsonl');
    writeFileSync(
      filePath,
      [
        JSON.stringify({ cwd: '/Users/agent/src/proj' }),
        JSON.stringify({ role: 'user', text: 'hi' }),
      ].join('\n') + '\n',
    );
    // Simulate prior indexing that predates the cwd column: a source_files row and
    // a chunk exist, but cwd was never recorded.
    store.upsertSourceFile({ path: filePath, agentType: 'claude', lastOffset: 0, lastSize: 0, lastLineNumber: 0 });
    store.addChunk({
      agentType: 'claude',
      sessionId: 'test-session',
      filePath,
      lineNumber: 2,
      role: 'user',
      text: 'hi',
      timestamp: '2026-01-01T00:00:00Z',
    });

    const filled = await backfillCwd(store, fakeRegistry(tmpDir));

    expect(filled).toBe(1);
    expect(store.getSessionCwd('test-session')).toBe('/Users/agent/src/proj');
  });

  it('backfillCwd leaves files that already have a cwd untouched', async () => {
    const filePath = join(tmpDir, 'has-cwd.jsonl');
    writeFileSync(filePath, JSON.stringify({ cwd: '/x' }) + '\n');
    store.upsertSourceFile({ path: filePath, agentType: 'claude', lastOffset: 0, lastSize: 0, lastLineNumber: 0 });
    store.setSourceFileCwd(filePath, '/already/set', 'claude');

    const filled = await backfillCwd(store, fakeRegistry(tmpDir));

    expect(filled).toBe(0);
    expect(store.getSourceFile(filePath)!.cwd).toBe('/already/set');
  });

  it('returns 0 for a file not claimed by any adapter', async () => {
    // Use a completely separate temp dir so it doesn't start with tmpDir
    const otherDir = mkdtempSync(join(SCRATCHPAD, 'other-'));
    try {
      const filePath = join(otherDir, 'ignored.jsonl');
      writeFileSync(filePath, JSON.stringify({ role: 'user', text: 'nope' }) + '\n');

      // Registry only claims tmpDir, not otherDir
      const count = await indexFile(filePath, store, fakeRegistry(tmpDir));
      expect(count).toBe(0);
      expect(store.getSourceFile(filePath)).toBeUndefined();
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('incremental re-index of appended file only adds new lines', async () => {
    const filePath = join(tmpDir, 'incremental.jsonl');
    const line1 = JSON.stringify({ role: 'user', text: 'line one' }) + '\n';
    writeFileSync(filePath, line1);

    // First index
    await indexFile(filePath, store, fakeRegistry(tmpDir));
    expect(store.getSessionChunks('test-session')).toHaveLength(1);

    // Append a second line
    const line2 = JSON.stringify({ role: 'assistant', text: 'line two' }) + '\n';
    appendFileSync(filePath, line2);

    // Second index — should only add line 2
    await indexFile(filePath, store, fakeRegistry(tmpDir));
    const chunks = store.getSessionChunks('test-session');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe('line one');
    expect(chunks[1].text).toBe('line two');
    // Line numbers should be continuous
    expect(chunks[0].lineNumber).toBe(1);
    expect(chunks[1].lineNumber).toBe(2);
  });

  it('handles a file with no parseable lines gracefully', async () => {
    const filePath = join(tmpDir, 'empty.jsonl');
    writeFileSync(filePath, 'not-json\n');

    const count = await indexFile(filePath, store, fakeRegistry(tmpDir));
    expect(count).toBe(0);
    const sf = store.getSourceFile(filePath);
    expect(sf).toBeDefined();
    expect(sf!.lastLineNumber).toBe(1); // line was read, just no chunks produced
  });
});

describe('EmbedWorker', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedPending(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const filePath = join(tmpDir, `f${i}.jsonl`);
      writeFileSync(filePath, JSON.stringify({ role: 'user', text: `text ${i}` }) + '\n');
      await indexFile(filePath, store, fakeRegistry(tmpDir));
    }
  }

  it('drains pending embeds and writes vec rows', async () => {
    await seedPending(3);
    expect(store.queueStats().pending).toBe(3);

    const embedder = makeEmbedder();
    const worker = new EmbedWorker(store, embedder);
    worker.kick();
    await worker.awaitIdle();

    const stats = store.queueStats();
    expect(stats.pending).toBe(0);
    expect(stats.embedded).toBe(3);
  });

  it('awaitIdle resolves immediately when not running', async () => {
    const worker = new EmbedWorker(store, makeEmbedder());
    // Should resolve without hanging
    await expect(worker.awaitIdle()).resolves.toBeUndefined();
  });

  it('kick is single-flight: concurrent kicks do not double-embed', async () => {
    await seedPending(2);
    const embedder = makeEmbedder();
    const worker = new EmbedWorker(store, embedder, { batchSize: 1 });

    // Fire multiple kicks
    worker.kick();
    worker.kick();
    worker.kick();
    await worker.awaitIdle();

    // Each item embedded exactly once
    const stats = store.queueStats();
    expect(stats.embedded).toBe(2);
    expect(stats.pending).toBe(0);
    // Vec table should have exactly 2 rows
    const vecResults = store.vecSearch(Array(EMBED_DIMS).fill(0.5), 10);
    expect(vecResults).toHaveLength(2);
  });

  it('embed failure leaves rows pending and a later kick recovers', async () => {
    await seedPending(2);
    const embedder = makeEmbedder({ failCount: 1 });
    const worker = new EmbedWorker(store, embedder, { backoffMs: 0 });

    // First kick: embed fails
    worker.kick();
    await worker.awaitIdle();

    // Still pending after failure
    expect(store.queueStats().pending).toBe(2);

    // Second kick: succeeds
    worker.kick();
    await worker.awaitIdle();

    expect(store.queueStats().pending).toBe(0);
    expect(store.queueStats().embedded).toBe(2);
  });

  it('isRunning is true while draining, false after idle', async () => {
    await seedPending(1);
    const embedder = makeEmbedder();
    const worker = new EmbedWorker(store, embedder);

    worker.kick();
    expect(worker.isRunning).toBe(true);
    await worker.awaitIdle();
    expect(worker.isRunning).toBe(false);
  });

  it('a kick during a run triggers one more drain pass', async () => {
    // Start with 1 pending, then add 1 more during the drain
    await seedPending(1);
    const embedder = makeEmbedder();
    let secondAdded = false;

    const slowEmbedder: Embedder = {
      model: 'test',
      dims: EMBED_DIMS,
      async embed(texts: string[]): Promise<number[][]> {
        // On first call, add another pending item AND kick
        if (!secondAdded) {
          secondAdded = true;
          const fp = join(tmpDir, 'late.jsonl');
          writeFileSync(fp, JSON.stringify({ role: 'user', text: 'late add' }) + '\n');
          await indexFile(fp, store, fakeRegistry(tmpDir));
          worker.kick(); // kick during run
        }
        return embedder.embed(texts, 'document');
      },
    };

    const worker = new EmbedWorker(store, slowEmbedder);
    worker.kick();
    await worker.awaitIdle();

    // Both items should be embedded
    expect(store.queueStats().pending).toBe(0);
    expect(store.queueStats().embedded).toBe(2);
  });

  it('lastError is undefined before any run', () => {
    const worker = new EmbedWorker(store, makeEmbedder(), { backoffMs: 0 });
    expect(worker.lastError).toBeUndefined();
  });

  it('lastError is set to the embed error after a failing run', async () => {
    await seedPending(1);
    const errorMessage = 'ollama connection refused: ECONNREFUSED';
    const failEmbedder: Embedder = {
      model: 'test',
      dims: EMBED_DIMS,
      embed: async () => { throw new Error(errorMessage); },
    };
    const worker = new EmbedWorker(store, failEmbedder, { backoffMs: 0 });
    worker.kick();
    await worker.awaitIdle();

    expect(worker.lastError).toBeInstanceOf(Error);
    expect(worker.lastError!.message).toBe(errorMessage);
    // Worker is no longer running; pending rows remain.
    expect(worker.isRunning).toBe(false);
    expect(store.queueStats().pending).toBe(1);
  });

  it('lastError is cleared (stays undefined) after a successful run', async () => {
    // No pending work → drain immediately, no error
    const worker = new EmbedWorker(store, makeEmbedder(), { backoffMs: 0 });
    worker.kick();
    await worker.awaitIdle();
    expect(worker.lastError).toBeUndefined();
  });

  it('lastError is cleared after a subsequent successful kick following an earlier failure', async () => {
    await seedPending(1);

    let failNext = true;
    const conditionalEmbedder: Embedder = {
      model: 'test',
      dims: EMBED_DIMS,
      async embed(texts: string[]): Promise<number[][]> {
        if (failNext) {
          failNext = false;
          throw new Error('first attempt fails');
        }
        return texts.map(() => Array(EMBED_DIMS).fill(0.1));
      },
    };

    const worker = new EmbedWorker(store, conditionalEmbedder, { backoffMs: 0 });

    // First kick: fails
    worker.kick();
    await worker.awaitIdle();
    expect(worker.lastError).toBeInstanceOf(Error);

    // Second kick: succeeds
    worker.kick();
    await worker.awaitIdle();
    expect(worker.lastError).toBeUndefined();
    expect(store.queueStats().pending).toBe(0);
  });
});
