import { describe, it, expect, vi } from 'vitest';
import * as http from 'node:http';
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

  // Real http.Server regression: an in-flight slow request (the /api/status
  // long-poll) must be aborted, not waited for, so SIGINT exits in <1s.
  it('aborts in-flight http connections so server.close() resolves promptly', async () => {
    const server = http.createServer((_req, res) => {
      // Simulate a long-poll: never write a response, just hold the socket.
      res.on('close', () => { /* client went away */ });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    // Fire a request, then wait until the server is actually handling it.
    const clientDone = new Promise<{ aborted: boolean }>((resolve) => {
      const req = http.request({ port, method: 'GET', path: '/long' }, () => {
        resolve({ aborted: false });
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        // ECONNRESET is what we expect when closeAllConnections() kills the socket.
        resolve({ aborted: err.code === 'ECONNRESET' });
      });
      req.end();
    });

    // Give the server a tick to start serving the request.
    await new Promise((r) => setImmediate(r));

    const start = Date.now();
    const result = await gracefulShutdown({
      timeoutMs: 5000,
      steps: [
        {
          name: 'httpServer',
          run: () => new Promise<void>((resolve) => {
            server.close(() => resolve());
            // The actual fix lives in cli.ts; this test asserts the contract
            // that closeAllConnections() makes the close() callback fire.
            server.closeAllConnections();
          }),
        },
      ],
    });
    const elapsed = Date.now() - start;

    expect(result).toBe('success');
    expect(elapsed).toBeLessThan(500); // 5s timeout was the bug; should be near-instant
    expect(await clientDone).toEqual({ aborted: true });
  });
});
