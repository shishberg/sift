import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpencodePoller, DEFAULT_OPENCODE_POLL_INTERVAL_MS } from './opencode-poller.js';

describe('OpencodePoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the import on each tick', async () => {
    const poll = vi.fn(() => 0);
    const onChunksIndexed = vi.fn();
    const poller = new OpencodePoller({ poll, onChunksIndexed, intervalMs: 1000 });

    poller.start();
    expect(poll).not.toHaveBeenCalled(); // does not fire immediately

    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it('kicks the embed worker only when new chunks were indexed', async () => {
    let next = 0;
    const poll = vi.fn(() => next);
    const onChunksIndexed = vi.fn();
    const poller = new OpencodePoller({ poll, onChunksIndexed, intervalMs: 1000 });

    poller.start();

    next = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChunksIndexed).not.toHaveBeenCalled();

    next = 3;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChunksIndexed).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it('survives an import that throws and keeps polling', async () => {
    const poll = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('database is locked');
      })
      .mockImplementation(() => 0);
    const onChunksIndexed = vi.fn();
    const onError = vi.fn();
    const poller = new OpencodePoller({ poll, onChunksIndexed, intervalMs: 1000, onError });

    poller.start();

    await vi.advanceTimersByTimeAsync(1000); // throws
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onChunksIndexed).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000); // recovers
    expect(poll).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it('survives an async import that rejects', async () => {
    const poll = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('locked')))
      .mockImplementation(() => Promise.resolve(0));
    const onError = vi.fn();
    const poller = new OpencodePoller({ poll, onChunksIndexed: vi.fn(), intervalMs: 1000, onError });

    poller.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it('does not overlap ticks when a poll is still in flight', async () => {
    let resolve!: (n: number) => void;
    const poll = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const poller = new OpencodePoller({ poll, onChunksIndexed: vi.fn(), intervalMs: 1000 });

    poller.start();
    await vi.advanceTimersByTimeAsync(1000); // tick 1 starts, never resolves
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000); // tick 2 skipped — tick 1 still running
    expect(poll).toHaveBeenCalledTimes(1);

    resolve(0); // let tick 1 finish
    await vi.advanceTimersByTimeAsync(1000); // now tick 3 runs
    expect(poll).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it('stop() halts further ticks and closes the source', async () => {
    const poll = vi.fn(() => 0);
    const onStop = vi.fn();
    const poller = new OpencodePoller({ poll, onChunksIndexed: vi.fn(), intervalMs: 1000, onStop });

    poller.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);

    poller.stop();
    expect(onStop).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).toHaveBeenCalledTimes(1); // no further ticks
  });

  it('exposes a sane default interval', () => {
    expect(DEFAULT_OPENCODE_POLL_INTERVAL_MS).toBe(2000);
  });
});
