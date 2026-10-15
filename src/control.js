/**
 * Transport-agnostic control facade for the management UI.
 *
 * Every method takes an explicit session id and returns plain JSON-safe values,
 * so the same object can back a typert remote or an HTTP route without leaking
 * live services, agents, or configuration secrets to the browser.
 */
/** The session is still being created: the page must keep polling, not show a failure. */
const notReady = message => Object.assign(new Error(message), { code: 'SESSION_NOT_READY' });

/** How long one long-poll request is held before it answers "nothing moved yet". */
const WAIT_TIMEOUT_MS = 25000;

export function createControl(ctx, stateFor) {
  const resolve = id => {
    if (typeof id !== 'string' || !id) throw new Error('workspace-mcp: a session id is required');
    const agent = ctx.agents.get(id);
    if (!agent) throw notReady('workspace-mcp: no live session with that id');
    const state = stateFor(agent);
    if (!state) throw notReady('workspace-mcp: this session has no workspace MCP state');
    return state;
  };
  return {
    /** Declarations, trust state and live connection state for one session. */
    async status(id, options = {}) {
      return resolve(id).status(undefined, { refresh: options?.refresh === true });
    },
    /** Explicit connect: authorize the declaration generation and load it (all, or one server). */
    async connect(id, serverId) {
      const state = resolve(id);
      const view = await state.connect(undefined, serverId);
      if (!view) throw notReady('workspace-mcp: this session has no workspace to read');
      return view;
    },
    /** Manual disconnect: the selection stays off until the user connects or follows the policy. */
    async disconnect(id, serverId) {
      return resolve(id).disconnect(undefined, serverId);
    },
    /** Drop the manual override: load exactly what the trust policy allows for this workspace. */
    async follow(id) {
      return resolve(id).follow(undefined);
    },
    /** The declaration files behind one session, plus whether that session may write them. */
    async declarations(id) {
      return resolve(id).declarationTargets(undefined);
    },
    /** Rewrite fields of one declaration; `version` is the token the reader was given. */
    async saveDeclaration(id, serverId, changes, version, options = { allowLossy: false }) {
      return resolve(id).saveDeclaration(serverId, changes, version, undefined, options);
    },
    /** Create one entry here, or copy an existing one into another preset. */
    async writeDeclaration(id, request) {
      return resolve(id).writeDeclaration(request, undefined);
    },
    /** Remove one declaration entry. */
    async removeDeclaration(id, serverId, version, options = { allowLossy: false }) {
      return resolve(id).removeDeclaration(serverId, version, undefined, options);
    },
    /**
     * Long-poll one session: hold the request until its management view moves past `version`,
     * or until the hold times out. The page re-reads `status` only when this answers.
     * @param version - the revision the caller already saw; a stale number answers at once.
     * @param signal - aborts when the caller goes away, releasing the hold immediately.
     * @returns the revision to send back with the next wait.
     */
    async wait(id, version, signal) {
      const state = resolve(id);
      return { version: await state.waitForChange(version, WAIT_TIMEOUT_MS, signal) };
    },
  };
}
