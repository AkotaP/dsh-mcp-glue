/** One outage keeps its budget until a connection has stayed up for this long. */
export const STABLE_MS = 30000;
const DELAYS = [1000, 2000, 4000, 8000, 16000, 30000, 60000];
export const realClock = {
  now: () => Date.now(), random: () => Math.random(),
  setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clearTimeout: timer => clearTimeout(timer),
};
/** Bounded jitter never exceeds the 60-second ceiling. No permanent attempt cap. */
export function retryDelay(attempt, random = Math.random) {
  return Math.round(DELAYS[Math.min(Math.max(0, attempt - 1), DELAYS.length - 1)] * (0.8 + 0.2 * random()));
}

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
