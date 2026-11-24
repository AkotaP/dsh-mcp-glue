/**
 * The only connection policy this plugin still owns.
 *
 * Reconnection, its backoff and its attempt budget belong to the native MCP client supervisor
 * (see `McpConnectionStatus`), so what remains here is the startup/recovery concurrency cap.
 */

export const realClock = {
  now: () => Date.now(), random: () => Math.random(),
  setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clearTimeout: timer => clearTimeout(timer),
};

/** A shared startup/recovery cap; cancelled waiters never retain a permit or start late. */
export function createConnectionLimiter(limit) {
  let active = 0;
  const waiting = new Set();
  const release = () => {
    active--;
    const next = waiting.values().next().value;
    next?.();
  };
  return async function run(operation, signal) {
    signal.throwIfAborted();
    if (active < limit) active++;
    else await new Promise((resolve, reject) => {
      const abort = () => { waiting.delete(grant); signal.removeEventListener('abort', abort); reject(signal.reason); };
      const grant = () => {
        waiting.delete(grant); signal.removeEventListener('abort', abort);
        active++; resolve();
      };
      waiting.add(grant);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try { signal.throwIfAborted(); return await operation(); }
    finally { release(); }
  };
}