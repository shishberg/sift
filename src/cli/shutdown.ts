/**
 * shutdown.ts
 *
 * Bounded graceful shutdown for CLI entry points. Runs a list of cleanup
 * steps in order; if the deadline is hit, resolves with 'timeout' (caller
 * force-exits) instead of blocking the process forever. A step that throws
 * is recorded but doesn't stop the remaining steps — the goal is to release
 * every resource we can before the process dies.
 *
 * The motivating case: `sift serve --watch` SIGINT handler awaits
 * `server.close()`, which waits for any in-flight HTTP connection (notably
 * the /api/status long-poll, up to 30s) to drain. Without a deadline, a
 * second Ctrl-C is needed to kill the process — and on the second Ctrl-C
 * the lock file and other cleanup never run, leaving a stale lock for the
 * next process to discover.
 */

export interface ShutdownStep {
  /** Human-readable name for logging. */
  name: string;
  /** Sync or async cleanup work. Throwing is recorded but not fatal. */
  run: () => void | Promise<void>;
}

export interface GracefulShutdownOptions {
  steps: ShutdownStep[];
  /** Max total time, ms. Default 5000. */
  timeoutMs?: number;
  /** Called once when the deadline fires. Default: no-op. */
  onTimeout?: () => void;
  /** Called once with the first error a step throws, if any. Default: no-op. */
  onError?: (err: unknown, stepName: string) => void;
}

export type ShutdownResult = 'success' | 'timeout' | 'fail';

export async function gracefulShutdown(opts: GracefulShutdownOptions): Promise<ShutdownResult> {
  const { steps, timeoutMs = 5000, onTimeout, onError } = opts;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let firstError: { err: unknown; stepName: string } | undefined;

  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      onTimeout?.();
      resolve('timeout');
    }, timeoutMs);
  });

  const runPromise = (async (): Promise<'success' | 'fail'> => {
    for (const step of steps) {
      if (timedOut) return 'fail';
      try {
        await step.run();
      } catch (err) {
        if (!firstError) {
          firstError = { err, stepName: step.name };
          onError?.(err, step.name);
        }
        // Keep going — releasing the lock is more important than surfacing
        // the error, and a later step might depend on the failing one.
      }
    }
    return firstError ? 'fail' : 'success';
  })();

  const result = await Promise.race([runPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);
  return result;
}
