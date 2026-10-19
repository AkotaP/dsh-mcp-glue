/**
 * Pure view-model for the management UI: no secrets, no live objects.
 *
 * Rows come from two sources so the panel can show every declared server even
 * when nothing is mounted: the normalized plan (loadable servers) and the
 * content-free diagnostics (declaration errors). Live mount bookkeeping then
 * supplies the connection state.
 */

/** Connection state of one declared server. */
export const SERVER_STATES = Object.freeze({
  connected: 'connected',
  failed: 'failed',
  pending: 'pending',
  reconnecting: 'reconnecting',
  unauthorized: 'unauthorized',
  unloaded: 'unloaded',
  invalid: 'invalid',
});

/** Redact anything that could carry an expanded credential. */
function safeTarget(approval) {
  if (!approval) return undefined;
  return {
    command: approval.command,
    argumentCount: approval.argumentCount,
    cwd: approval.cwd,
    endpoint: approval.endpoint,
    environmentKeys: approval.environmentKeys,
    credentialRefs: approval.credentialRefs,
    inputRefs: approval.inputRefs,
  };
}

export function buildStatus({ cwd, plan, trusted, trustMode, allowance, restrictions, selected, autoAllowed, selectionMode, mounted, serverStates, requiredFailure, monitoring, now, freshnessMs }) {
  const rows = [];
  const loadable = new Map();
  for (const entry of plan?.servers ?? []) {
    const { serverName, transport } = entry.spec.config;
    loadable.set(serverName, true);
    const live = mounted ? serverStates.get(serverName) : undefined;
    const isSelected = selected === undefined || selected.has(serverName);
    // Not in this generation's effective set. Under a manual override that is simply "not
    // connected"; under the policy it is "nothing authorized it" unless the policy does allow
    // it and the user turned it off by hand.
    const excluded = autoAllowed?.has(serverName) === true || selectionMode === 'custom';
    const state = !isSelected ? (excluded ? SERVER_STATES.unloaded : SERVER_STATES.unauthorized)
      : mounted ? live?.state ?? SERVER_STATES.pending
        : SERVER_STATES.unloaded;
    const tools = live?.tools ?? [];
    // The project's own include/exclude list still wins over anything the user allows here: a
    // `tools.guard` denies those calls after this gate, and the panel shows them as unusable
    // instead of offering a switch that could never take effect.
    const declared = restrictions?.get(serverName);
    const disabledTools = declared === undefined ? [] : tools.filter(tool =>
      declared.deny.includes(tool) || (declared.allow !== undefined && !declared.allow.includes(tool)));
    // A green dot is a claim about the recent past, so it expires on its own: only a probe
    // (or real traffic) renews it. stdio rows are always confirmed, because a child exit
    // reaches the native bridge directly.
    const http = live?.http === true;
    const verified = state !== SERVER_STATES.connected ? false
      : !http || (live?.confirmed !== false && live?.lastVerifiedAt !== undefined && now !== undefined && now - live.lastVerifiedAt <= freshnessMs);
    rows.push({
      id: serverName,
      transport,
      required: entry.spec.required === true,
      source: entry.source,
      target: safeTarget(entry.spec.approval),
      selected: isSelected,
      state,
      verified,
      lastVerifiedAt: live?.lastVerifiedAt,
      tools,
      disabledTools,
      error: live?.error,
      reconnect: live?.reconnect ?? { eligible: false, attempt: 0, nextRetryAt: null, reason: null },
    });
  }
  for (const issue of plan?.diagnostics ?? []) {
    if (issue.server !== undefined && loadable.has(issue.server)) continue;
    rows.push({
      id: issue.server ?? `${issue.preset}:${issue.file}`,
      transport: undefined,
      required: issue.required === true,
      source: { preset: issue.preset, file: issue.file, ...(issue.server === undefined ? {} : { server: issue.server }) },
      selected: false,
      state: SERVER_STATES.invalid,
      tools: [],
      error: issue.code,
    });
  }
  const loaded = mounted === true;
  return {
    workspace: plan?.cwd ?? cwd ?? undefined,
    generation: plan?.fingerprint,
    trusted,
    trustMode: trustMode ?? 'manual',
    allowance: allowance ?? { workspace: null, allowMcp: [], allowTools: [] },
    selectionMode: selectionMode ?? 'auto',
    selected: selected === undefined ? rows.filter(row => row.selected).map(row => row.id) : [...selected],
    loaded,
    requiredFailure,
    monitoring: monitoring === true ? 'supported' : 'unsupported',
    counts: {
      declarations: rows.length,
      connected: rows.filter(row => row.state === SERVER_STATES.connected).length,
      selected: rows.filter(row => row.selected).length,
      problems: rows.filter(row => row.state !== SERVER_STATES.connected && row.state !== SERVER_STATES.pending && row.state !== SERVER_STATES.unloaded).length,
    },
    servers: rows,
  };
}
