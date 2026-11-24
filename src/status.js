/**
 * Pure view-model for the management UI: no secrets, no live objects.
 *
 * Rows come from two sources so the panel can show every declared server even
 * when nothing is mounted: the normalized plan (loadable servers) and the
 * content-free diagnostics (declaration errors). Live mount bookkeeping then
 * supplies the connection state.
 */

import { loaderToolName } from './normalize.js';

/**
 * Connection state of one declared server.
 *
 * These are the panel's own words, derived from the native connection status plus this
 * plugin's policy: `authorization` is the native `waiting-authorization` state (the server
 * wants a browser grant this Host has not stored yet), and `pending`/`reconnecting` mirror
 * the native `connecting`/`reconnecting` states.
 */
export const SERVER_STATES = Object.freeze({
  authorization: 'authorization',
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
    oauth: approval.oauth === true,
    toolLoading: approval.toolLoading ?? undefined,
  };
}

export function buildStatus({ cwd, plan, trusted, trustMode, allowance, restrictions, selected, autoAllowed, selectionMode, mounted, serverStates, requiredFailure, monitoring, now, freshnessMs, lastDeclarationChangeAt }) {
  const rows = [];
  // Warnings describe a loadable server (a Windows shim command, say); they never make it invalid.
  const warningsByServer = new Map();
  for (const item of plan?.warnings ?? []) {
    const list = warningsByServer.get(item.server) ?? [];
    list.push({ code: item.code, detail: item.detail });
    warningsByServer.set(item.server, list);
  }
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
    // A server the bridge refuses to configure is worth reporting even when it is not selected:
    // the declaration is wrong, and that is the same problem whether or not it is turned on.
    const state = live?.state === SERVER_STATES.invalid ? SERVER_STATES.invalid
      : !isSelected ? (excluded ? SERVER_STATES.unloaded : SERVER_STATES.unauthorized)
        : mounted ? live?.state ?? SERVER_STATES.pending
          : SERVER_STATES.unloaded;
    const tools = live?.tools ?? [];
    // The project's own include/exclude list still wins over anything the user allows here: a
    // `tools.guard` denies those calls after this gate, and the panel shows them as unusable
    // instead of offering a switch that could never take effect.
    const declared = restrictions?.get(serverName);
    const loading = live?.toolLoading ?? entry.spec.config.toolLoading ?? undefined;
    // The on-demand loader is the transport every filtered tool arrives through, so the project's
    // own allow/deny list is never shown as disabling it.
    const loader = loading === 'on-demand' ? loaderToolName(serverName) : undefined;
    const disabledTools = declared === undefined ? [] : tools.filter(tool =>
      tool !== loader && (declared.deny.includes(tool) || (declared.allow !== undefined && !declared.allow.includes(tool))));
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
      // The native diagnostic behind a code, already redacted by the bridge. Bounded once more
      // here because the panel renders it in a tooltip rather than a log.
      detail: typeof live?.detail === 'string' ? live.detail.slice(0, 400) : undefined,
      warnings: warningsByServer.get(serverName) ?? [],
      reconnect: live?.reconnect ?? { eligible: false, attempt: 0, maxAttempts: null, nextRetryAt: null, reason: null },
      /** Browser authorization: the attempt the user drives, and the phase it reached. */
      authorization: live?.authorization,
      /** `on-demand` lists this server's tools in the prompt catalog instead of registering them. */
      loading,
      /** Tools the live connection offers; for `on-demand` this is the catalog size. */
      offeredTools: live?.toolCount,
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
      ...(issue.detail === undefined ? {} : { errorDetail: issue.detail, detail: issue.detail }),
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
    lastDeclarationChangeAt: lastDeclarationChangeAt ?? null,
    monitoring: monitoring === true ? 'supported' : 'unsupported',
    counts: {
      declarations: rows.length,
      connected: rows.filter(row => row.state === SERVER_STATES.connected).length,
      selected: rows.filter(row => row.selected).length,
      // A declaration the loader refused is a different problem from one that will not connect,
      // and a hand edit needs the first number on its own.
      invalid: rows.filter(row => row.state === SERVER_STATES.invalid).length,
      // Waiting for the user to finish a browser authorization is not a failure and not "off".
      authorization: rows.filter(row => row.state === SERVER_STATES.authorization).length,
      warnings: plan?.warnings?.length ?? 0,
      problems: rows.filter(row => row.state !== SERVER_STATES.connected && row.state !== SERVER_STATES.pending && row.state !== SERVER_STATES.unloaded).length,
    },
    servers: rows,
  };
}
