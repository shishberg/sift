import { describe, it, expect, vi } from 'vitest';
import { gracefulShutdown } from './shutdown.js';

describe('gracefulShutdown', () => {
  it('runs all steps in order and resolves to "success"', async () => {
    const order: string[] = [];
    const result = await gracefulShutdown({
      steps: [
        { name: 'first', run: () => { order.push('first'); } },
        { name: 'second', run: () => { order.push('second'); } },
        { name: 'third', run: () => { order.push('third'); } },
      ],
    });
    expect(result).toBe('success');
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('awaits async steps before continuing', async () => {
    const order: string[] = [];
    const result = await gracefulShutdown({
      steps: [
        {
          name: 'slow',
          run: () => new Promise<void>((r) => setTimeout(() => { order.push('slow-done'); r(); }, 20)),
        },
        { name: 'after', run: () => { order.push('after'); } },
      ],
    });
    expect(result).toBe('success');
    expect(order).toEqual(['slow-done', 'after']);
  });

  it('resolves to "timeout" when a step takes longer than timeoutMs', async () => {
    const onTimeout = vi.fn();
    const result = await gracefulShutdown({
      timeoutMs: 30,
      onTimeout,
      steps: [
        {
          name: 'hung',
          run: () => new Promise<void>(() => { /* never resolves */ }),
        },
      ],
    });
    expect(result).toBe('timeout');
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('does not call steps after the deadline', async () => {
    const second = vi.fn();
    const result = await gracefulShutdown({
      timeoutMs: 20,
      steps: [
        {
          name: 'hung',
          run: () => new Promise<void>(() => { /* never resolves */ }),
        },
        { name: 'never-runs', run: second },
      ],
    });
    expect(result).toBe('timeout');
    expect(second).not.toHaveBeenCalled();
  });

  it('keeps going when a step throws — does not abort subsequent steps', async () => {
    const order: string[] = [];
    const result = await gracefulShutdown({
      steps: [
        { name: 'ok-1', run: () => { order.push('ok-1'); } },
        { name: 'throws', run: () => { order.push('throws'); throw new Error('boom'); } },
        { name: 'ok-2', run: () => { order.push('ok-2'); } },
      ],
    });
    // The first throw should propagate so the caller can see something went wrong.
    // (We choose "fail" as a third outcome for this case.)
    expect(result).toBe('fail');
    expect(order).toEqual(['ok-1', 'throws', 'ok-2']);
  });
});
