/**
 * Reachability feedback for HTTP MCP servers.
 *
 * The native bridge reports a lost connection when its transport says so; a silently
 * stopped Streamable HTTP server leaves the row green until some call happens to fail.
 * A probe answers the cheap question — "is anything still listening" — without touching
 * the MCP session: no credentials, no initialize, no business tool call, no new session.
 *
 * A reachable endpoint is not proof that the MCP session is healthy. The point is the
 * opposite direction: an unreachable endpoint is proof that it is not, and that proof is
 * worth having within a second or two instead of after a 60-second tool timeout.
 */

/** Network-level failures that mean nothing answered; any HTTP response means alive. */
const UNREACHABLE = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'ETIMEDOUT', 'ERR_SOCKET_CLOSED',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * Fixed policy, deliberately not configurable: these numbers only trade a little
 * background work for detection latency, and a user-facing setting would invite
 * values that make the feature silently useless.
 */
export const HEALTH = Object.freeze({
  /** Per-probe deadline; the panel should learn the truth within a couple of seconds. */
  probeTimeoutMs: 1500,
  /** Hot cadence while MCP traffic keeps happening, then the warm one, then silence. */
  hotMs: 10000,
  warmMs: 30000,
  hotWindowMs: 120000,
  warmWindowMs: 300000,
  /** A confirmation probe follows the first failure this quickly. */
  confirmMs: 1200,
  /** Consecutive failures before the connection is treated as down. */
  failuresToOffline: 2,
  /** Real traffic younger than this makes a probe unnecessary. */
  freshMs: 5000,
});

/**
 * Probe only Streamable HTTP endpoints.
 *
 * stdio is left alone on purpose: a child process exit reaches the native bridge as a
 * close signal, so the event path already works and a probe would add nothing.
 * @returns the URL to probe, or undefined when this transport is not probed.
 */
export function probeTarget(spec) {
  const config = spec?.config;
  if (config?.transport !== 'streamable-http' || typeof config.url !== 'string') return undefined;
  try {
    const url = new URL(config.url);
    // Only the bare origin+path is probed; query strings may carry credentials.
    return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}${url.pathname}` : undefined;
  } catch { return undefined; }
}

/** Why one probe attempt failed, as a bounded code the panel may show. */
function probeFailure(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'ETIMEDOUT';
  const seen = new Set();
  for (let current = error, depth = 0; current && depth < 8 && !seen.has(current); depth++) {
    seen.add(current);
    if (typeof current.code === 'string' && UNREACHABLE.has(current.code)) return current.code;
    current = current.cause;
  }
  return 'PROBE_FAILED';
}

/**
 * One reachability probe.
 *
 * Any HTTP status counts as reachable — 401/404/405 still prove that something answered.
 * Only a network-level failure is evidence the server is gone, so a server that rejects
 * an unauthenticated `HEAD` is never mistaken for a stopped one.
 *
 * @param url - endpoint to probe, already stripped of credentials.
 * @param options - deadline, fetch substitution for tests, and a cancellation signal.
 * @returns `{ reachable: true }`, `{ reachable: false, code }`, or `{ cancelled: true }`.
 */
export async function probeHttp(url, { timeoutMs = HEALTH.probeTimeoutMs, fetchImpl = fetch, signal } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const attempt = async method => {
    try {
      // `redirect: 'manual'` keeps an auth redirect from becoming a second request, and
      // no headers are sent at all: probing must never leak a credential.
      const response = await fetchImpl(url, { method, redirect: 'manual', signal: combined });
      try { await response.body?.cancel(); } catch { /* a cancelled body is the point */ }
      return { reachable: true };
    } catch (error) {
      if (signal?.aborted) return { cancelled: true };
      return { reachable: false, code: probeFailure(error) };
    }
  };
  const head = await attempt('HEAD');
  if (head.reachable || head.cancelled) return head;
  // Some servers answer HEAD with a protocol error before any HTTP response exists;
  // one plain GET (headers only, body cancelled) settles whether that was really an outage.
  const get = await attempt('GET');
  if (get.reachable || get.cancelled) return get;
  // Prefer the more specific of the two diagnoses.
  return head.code === 'PROBE_FAILED' ? get : head;
}
