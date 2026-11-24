import { isDeepStrictEqual } from 'node:util';
import { createDeclarationEditor } from './edit.js';
import { loadWorkspace } from './load.js';
import { publicToolName, loaderToolName } from './normalize.js';
import { SERVER_STATES, buildStatus } from './status.js';
import { realClock, createConnectionLimiter } from './retry.js';
import { HEALTH, probeHttp, probeTarget } from './health.js';
import { installToolPreparation } from './step.js';

/**
 * Registration boundary used for one configuration generation.
 *
 * A child fiber inherits its parent's scope tag through the context prototype
 * chain, so everything registered under it belongs to the Agent's scope while
 * staying individually disposable. This deliberately avoids importing
 * `@deepseek-ai/dsh-scope`: its scope tag and parent links are module-private
 * symbols, so a second copy of that package would make every scoped
 * registration look global.
 */
const SCOPE_PLUGIN = { name: 'workspace-mcp-scope', apply() {} };

async function disposeFiber(fiber) {
  await Promise.resolve(fiber.dispose());
  while (fiber.inertia !== undefined) await fiber.inertia;
}
/**
 * How many MCP servers may start at once.
 *
 * Startup is almost entirely waiting: spawn a child process, then run the initialize
 * handshake. Measured on this host, one stdio fixture server takes ~470 ms, so a serial
 * generation costs N × 470 ms — five declared servers made a new workspace feel slow for
 * ~2.4 s while reading the declarations themselves took ~3 ms. Six in flight covers every
 * realistic workspace while still never spawning all `maxServers` (up to 128) at once.
 */
const MOUNT_CONCURRENCY = 6;

/**
 * Extra wait on top of the bridge's own startup budget.
 *
 * The bridge already bounds one connection attempt plus its initial tool sync, so this only
 * covers reporting: the mount settles a moment after its budget expires. It deliberately does
 * not tear the instance down — a supervisor that is still trying is more truthful than a
 * timeout, and the next status update replaces this one.
 */
const NATIVE_STARTUP_GRACE_MS = 5000;

/** The panel's bounded reason code for a native terminal state. */
function failureCodeOf(reason) {
  if (reason === 'unclosed-generation') return 'CLOSE_UNCONFIRMED';
  if (reason === 'gave-up') return 'RECONNECT_GAVE_UP';
  if (reason === 'reconnect-disabled') return 'RECONNECT_DISABLED';
  return 'CONNECTION_LOST';
}

/** Run `run` over `items` with at most `limit` in flight; `run` owns its own failures. */
async function mapLimit(items, limit, run) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await run(next);
  });
  await Promise.all(workers);
}

/** Bounded, secret-free failure code for the management UI. */
function startupCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,39}$/.test(code) ? code : 'START_FAILED';
}
function createBoundary(parentCtx) {
  const fiber = parentCtx.plugin(SCOPE_PLUGIN);
  return { ctx: fiber.ctx, dispose: () => disposeFiber(fiber) };
}

/**
 * Load `@deepseek-ai/dsh-mcp-client` the way the runtime composes its own rows.
 * Node caches ES modules by resolved URL, so this returns the exact instance the
 * runtime already uses; a plain `import()` from this package would return a
 * second copy whose scope lookups silently fail.
 */
export async function loadNativeBridge(ctx, resolveLoader = () => ctx.get('loader')) {
  const loader = resolveLoader();
  if (!loader) throw new Error('workspace-mcp: the Cordis loader service is unavailable, so the native MCP bridge cannot be loaded without risking a second module instance');
  return loader.unwrapExports(await loader.import('@deepseek-ai/dsh-mcp-client'));
}

/** Idempotent, ordered per-Agent lifecycle. Never registers project tools globally. */
export class WorkspaceMcpSession {
  constructor(agent, config, { load = loadWorkspace, nativePlugin, clock = realClock, fetchImpl = fetch, health = true, makeBoundary = createBoundary, logger, scopeOwner, optionalServices } = {}) {
    this.agent = agent; this.config = config; this.load = load;
    this.nativePlugin = nativePlugin; this.makeBoundary = makeBoundary;
    this.clock = clock;
    this.fetchImpl = fetchImpl;
    /** Probing can be switched off by an embedder that owns connectivity itself. */
    this.healthEnabled = health !== false;
    /** Last time this session did anything MCP-shaped: it gates the probe cadence. */
    this.lastActivityAt = clock.now();
    /**
     * Whether this Host publishes the MCP client host. Everything else here is built on it:
     * mounting, probing and authorization all go through the bridge's own API instead of
     * re-implementing its lifecycle, so its absence is the only unsupported composition.
     */
    this.monitoring = typeof nativePlugin?.McpClientHost === 'function';
    this.mounts = new Map();
    this.knownServers = new Set();
    this.background = new Set();
    this.connectionSlot = createConnectionLimiter(MOUNT_CONCURRENCY);
    this.retryRequested = new Set();
    // An unconfirmed shutdown must never spawn a second process under the same name.
    this.unsafeNames = new Set();
    this.logger = logger ?? agent.ctx.logger;
    // A context that injects `tools`/`systemPrompt`, used for the guard and base assemblies.
    this.scopeOwner = scopeOwner ?? agent.ctx;
    /** The native host of this session; see {@link WorkspaceMcpSession#sessionHost}. */
    this.host = undefined;
    /** Browser-authorization owners by server name; see {@link WorkspaceMcpSession#authorizationOwner}. */
    this.authOwners = new Map();
    /** Disposal verdict per native instance, so a late activation cannot end it a second time. */
    this.releaseResults = new WeakMap();
    /** Services the Agent's own context may not reach (see the entry file's inject note). */
    this.optionalServices = optionalServices ?? {};
    this.abort = new AbortController(); this.queue = Promise.resolve(); this.closed = false;
    this.group = undefined; this.loadedFingerprint = undefined;
    this.diagnosticFingerprint = undefined; this.requiredFailure = false;
    this.plan = undefined;
    /** When the declaration set last changed, so a hand edit can be told apart from a reconnect. */
    this.lastDeclarationChangeAt = undefined;
    /** 'auto' follows the policy; 'custom' loads exactly `selection`, which panel actions set. */
    this.selectionMode = 'auto'; this.selection = new Set();
    /** Policy layer for this generation: what may load, whether the directory is trusted, and its allowances. */
    this.policyAllowed = new Set();
    this.trustedWorkspace = false;
    this.allowance = { workspace: null, allowMcp: [], allowTools: [] };
    this.guardDisposer = undefined; this.toolFilters = new Map();
    /** Live mount bookkeeping for the management UI: server name → state. */
    this.serverStates = new Map();
    /** Management-view revision, bumped only when the view would actually look different. */
    this.version = 0;
    this.published = undefined;
    /** Readers held by `waitForChange`, released as soon as the view moves. */
    this.watchers = new Set();
  }
  /** Current management-view revision; a reader sends it back to skip what it already saw. */
  get statusVersion() { return this.version; }
  /**
   * The workspace path a new allowance entry should name: what the Host itself reported for
   * this session, so the entry written by the tool gate matches the entries the panel reads.
   */
  get workspacePath() { return this.plan?.cwd ?? undefined; }
  /**
   * Recompute the identity of the management view and bump the revision when it moved.
   *
   * The UI mirrors this view, so "would the panel look different?" is the only question a
   * waiting reader asks. The signature costs no filesystem work and covers every input that
   * changes a row: the declaration generation, the loaded generation, the trust mode, the
   * directory trust, the workspace allowance, the effective selection, a required failure,
   * and each server state with its tool count.
   */
  publish() {
    const signature = [
      this.plan?.fingerprint ?? '',
      this.loadedFingerprint ?? '',
      this.selectionMode,
      this.config.trustMode,
      this.trustedWorkspace ? 'trusted' : '-',
      this.allowance.workspace ?? '-',
      [...this.effectiveSelection()].sort().join(','),
      this.requiredFailure ? 'required-failed' : '-',
      [...this.serverStates.entries()].map(([name, value]) => JSON.stringify([name, value.state, value.tools, value.error, value.reconnect, this.verified(value) ? 1 : 0, this.authorizationView(name)?.phase ?? '-'])).sort().join(','),
      JSON.stringify(this.allowance),
      this.monitoring ? 'monitored' : 'unsupported',
    ].join('|');
    if (signature === this.published) return;
    this.published = signature;
    this.version += 1;
    this.release();
  }
  /** Release every reader currently held by `waitForChange`. */
  release() {
    for (const wake of [...this.watchers]) wake();
  }
  /**
   * Resolve once the view moves past `version`, or when `timeoutMs` elapses or `signal`
   * aborts. The long-poll waiter: the Host holds the request instead of the page polling.
   * @returns the revision the caller should send back with its next wait.
   */
  waitForChange(version, timeoutMs, signal) {
    if (!Number.isSafeInteger(version) || this.version > version) return Promise.resolve(this.version);
    if (signal?.aborted) return Promise.resolve(this.version);
    return new Promise(resolve => {
      let timer;
      const settle = () => {
        clearTimeout(timer);
        this.watchers.delete(settle);
        signal?.removeEventListener('abort', settle);
        resolve(this.version);
      };
      this.watchers.add(settle);
      signal?.addEventListener('abort', settle, { once: true });
      timer = setTimeout(settle, timeoutMs);
    });
  }
  /**
   * One guard per session decides every project tool call for this Agent: allow/deny
   * lists are matched against the exact scoped registration, never by a bare prefix,
   * and an unrelated global MCP that shares a textual prefix is left alone.
   */
  ensureGuard() {
    if (this.guardDisposer) return;
    const owners = [this.scopeOwner, this.agent.ctx].filter((value, index, list) => value && list.indexOf(value) === index);
    for (const owner of owners) {
      try {
        this.guardDisposer = owner.tools.guard(exec => {
          if (exec.agent !== this.agent) return undefined;
          for (const { prefix, loader, allow, deny } of this.toolFilters.values()) {
            if (!exec.name.startsWith(prefix)) continue;
            if (loader !== undefined && exec.name === loader) continue;
            if (owner.tools.get(exec.name, this.agent) === owner.tools.get(exec.name)) continue;
            if (deny.has(exec.name) || (allow !== undefined && !allow.has(exec.name))) return 'Tool disabled by workspace MCP declaration';
          }
          return undefined;
        });
        return;
      } catch { /* A context without `tools` cannot own the guard; try the next one. */ }
    }
    // Fail closed: a declaration asked for filtering, so never mount it unfiltered.
    throw new Error('workspace-mcp: cannot enforce the declared tool filters in this composition');
  }
  reconcile(signal, beforeChange) {
    const operation = this.queue.then(() => this.update(signal, beforeChange));
    this.queue = operation.catch(() => {});
    // Publish after every attempt, success or failure: a failed generation changes the view
    // too (a row turns red, the cache is dropped), and a waiting reader must see that.
    return operation.then(
      value => { this.publish(); return value; },
      error => { this.publish(); throw error; },
    );
  }
  /**
   * Whether the policy lets this server load on its own, in this workspace:
   * `trustMode: all`, or the directory is in `trustedWorkspaces`, or this workspace lists it
   * in `workspaceAllowances[].allowMcp`. Nothing else authorizes a project declaration — the
   * loader never asks for approval on a project's behalf.
   */
  canAutoConnect(name) {
    if (this.config.trustMode === 'all') return true;
    if (this.trustedWorkspace) return true;
    return this.allowance.allowMcp.includes(name);
  }
  /**
   * Whether one of this session's own tools may run without asking the user.
   *
   * Loading a server and calling one of its tools are separate decisions: a workspace can
   * authorize a server to start while still asking about each tool. `allowTools` holds the
   * Host's public tool names (`mcp__<server>__<tool>`), which is exactly what the panel writes.
   */
  canInvokeWithoutApproval(publicTool) {
    if (this.config.trustMode === 'all') return true;
    if (this.trustedWorkspace) return true;
    return this.allowance.allowTools.includes(publicTool);
  }
  /**
   * The servers this session has mounted, keyed the way their public tool names embed them.
   * The gate uses this to leave every global or sibling-plugin MCP alone.
   */
  mountedServers() {
    return new Set(this.serverStates.keys());
  }
  /**
   * Whether the declaration itself refuses this tool.
   *
   * A project can exclude its own tools (`includeTools` / `excludeTools`, Codex
   * `enabled_tools` / `disabled_tools`). That filter is enforced by a `tools.guard` **after**
   * this plugin's gate, and a guard can only deny — so asking the user about a tool the
   * project already forbade is a question with no possible answer. The gate skips it and lets
   * the guard refuse the call with its own, accurate reason.
   * @returns the reason code when the declaration refuses the tool, else undefined.
   */
  declaredUnavailable(publicTool) {
    for (const { prefix, loader, allow, deny } of this.toolFilters.values()) {
      if (!publicTool.startsWith(prefix)) continue;
      if (loader !== undefined && publicTool === loader) continue;
      if (deny.has(publicTool)) return 'declared-disabled';
      if (allow !== undefined && !allow.has(publicTool)) return 'declared-not-enabled';
    }
    return undefined;
  }
  /** The project's own tool filter for every mounted server, as public names, for the panel. */
  declaredFilters() {
    return new Map([...this.toolFilters].map(([name, filter]) => [name, {
      allow: filter.allow === undefined ? undefined : [...filter.allow],
      deny: [...filter.deny],
    }]));
  }
  /**
   * Whether this session's sandbox lets the plugin write inside the workspace.
   *
   * Editing a declaration is a filesystem write like any other, so it answers to the same policy:
   * a read-only session may look but not save. An absent policy service means an unsandboxed
   * provider — the plain local filesystem — which is writable.
   */
  canWriteWorkspace() {
    const policy = this.optionalServices.sandboxPolicy;
    // No policy service means the unfenced local filesystem, which is always writable.
    if (policy === undefined) return true;
    try {
      const mode = policy.resolve?.({ session: this.agent.session })?.mode;
      return mode === undefined || mode !== 'read-only';
    } catch {
      // A policy this session cannot resolve is not permission to write: fail closed, so the
      // panel keeps its editor shut instead of advertising a save the sandbox would refuse.
      return false;
    }
  }
  /**
   * The per-call sandbox policy a declaration write must carry.
   *
   * A sandboxed filesystem fences every mutation by the policy supplied with the call. Without
   * one it falls back to the deployment default, whose workspace root is NOT this session's
   * workspace, so a save inside the workspace is denied. The session is the boundary.
   * @returns the resolved policy for this session, or undefined when nothing fences writes.
   */
  writePolicy() {
    const policy = this.optionalServices.sandboxPolicy;
    if (policy === undefined) return undefined;
    try { return policy.resolve?.({ session: this.agent.session }); }
    catch (error) {
      this.logger.warn(`workspace-mcp: sandbox policy unresolved: ${error?.message ?? error}`);
      return undefined;
    }
  }
  /** The declaration files behind this session, shaped for the editor panel. */
  async declarationTargets(signal) {
    const fs = this.filesystem();
    const plan = this.plan ?? await this.preview(signal);
    if (!fs || !plan) return { writable: false, reason: '这个会话还没读到工作区声明', targets: [] };
    const writable = this.canWriteWorkspace();
    const editor = createDeclarationEditor({ fs, config: this.config, policy: () => this.writePolicy() });
    const [targets, presets] = await Promise.all([editor.list(plan, signal), editor.presets(plan, signal)]);
    return {
      writable,
      ...(writable ? {} : { reason: '当前会话是只读沙箱，不能改工作区里的文件' }),
      presets,
      targets,
    };
  }
  /** Rewrite fields of one declaration through the editor, then reload so the panel agrees. */
  async saveDeclaration(serverId, changes, version, signal, options = { allowLossy: false }) {
    const result = await this.editor().save(await this.planOrPreview(signal), serverId, changes, signal, version, options);
    await this.reconcile(signal).catch(() => {});
    return result;
  }
  /** Create one entry, or copy an existing one into another preset, then reload. */
  async writeDeclaration(request, signal) {
    const result = await this.editor().write(await this.planOrPreview(signal), request, signal);
    await this.reconcile(signal).catch(() => {});
    return result;
  }
  /** Remove one declaration entry, then reload so the panel agrees. */
  async removeDeclaration(serverId, version, signal, options = { allowLossy: false }) {
    const result = await this.editor().remove(await this.planOrPreview(signal), serverId, signal, version, options);
    await this.reconcile(signal).catch(() => {});
    return result;
  }
  /** The editor, fenced by this session's sandbox and its own live config. */
  editor() {
    const fs = this.filesystem();
    if (!fs) throw Object.assign(new Error('这个会话没有可用的文件系统'), { code: 'DECLARATION_UNSUPPORTED' });
    if (!this.canWriteWorkspace()) {
      throw Object.assign(new Error('当前会话是只读沙箱，不能改工作区里的文件'), { code: 'DECLARATION_READ_ONLY' });
    }
    return createDeclarationEditor({ fs, config: this.config, policy: () => this.writePolicy() });
  }
  /** The current declaration plan, read on demand when nothing is loaded yet. */
  async planOrPreview(signal) {
    const plan = this.plan ?? await this.preview(signal);
    if (!plan) throw Object.assign(new Error('这个会话还没读到工作区声明'), { code: 'DECLARATION_UNSUPPORTED' });
    return plan;
  }
  /** Declared names this generation will actually load, honoring the manual override. */
  effectiveSelection(plan = this.plan) {
    const declared = (plan?.servers ?? []).map(entry => entry.spec.config.serverName);
    if (this.selectionMode === 'custom') return new Set(declared.filter(name => this.selection.has(name)));
    return new Set(declared.filter(name => this.policyAllowed.has(name)));
  }
  /** Cache key for one loaded generation: declarations plus the effective selection. */
  loadKey(plan) {
    return [plan?.fingerprint, this.selectionMode, [...this.effectiveSelection(plan)].sort().join(',')].join('|');
  }
  /** Read declarations without any trust check, mount, or side effect. */
  async preview(signal) {
    const fs = this.filesystem();
    const cwd = this.agent.session?.header?.cwd;
    if (!fs || !cwd) return undefined;
    try {
      const loaded = await this.load(fs, cwd, this.config, { signal });
      if (this.plan?.fingerprint !== loaded.fingerprint) this.lastDeclarationChangeAt = this.clock.now();
      this.plan = loaded;
    } catch (error) { this.logger.warn(`workspace-mcp: ${error.code ?? 'WORKSPACE_READ_FAILED'}`); }
    return this.plan;
  }
  /** Management-UI view: declarations, trust state, live connection state. */
  async status(signal, { refresh = false } = {}) {
    // Someone is looking, which is exactly when a stale confirmation is worth refreshing.
    this.noteActivity();
    if (refresh || !this.plan) await this.preview(signal);
    const cwd = this.agent.session?.header?.cwd;
    const fs = this.filesystem();
    const trusted = fs && cwd ? await this.isTrusted(fs, cwd, signal).catch(() => false) : false;
    return buildStatus({
      cwd,
      plan: this.plan,
      trusted: this.config.trustMode === 'all' ? true : trusted,
      trustMode: this.config.trustMode,
      allowance: this.allowance,
      restrictions: this.declaredFilters(),
      selected: this.effectiveSelection(),
      autoAllowed: this.policyAllowed,
      selectionMode: this.selectionMode,
      // "Loaded" means a generation is mounted right now, not that the session ever had one:
      // the session's own boundary outlives a disconnect.
      mounted: this.mounts.size > 0,
      serverStates: this.serverStates,
      requiredFailure: this.requiredFailure,
      monitoring: this.monitoring,
      now: this.clock.now(),
      freshnessMs: this.freshnessMs(),
      lastDeclarationChangeAt: this.lastDeclarationChangeAt,
    });
  }
  /**
   * Explicit user action from the panel: connect a server, or every declared one, right now.
   *
   * Two different things reach this method and they must not be conflated:
   *
   * - **Granting** a server the policy does not authorize is an intent change. It pins
   *   `custom`, so a later declaration or policy change cannot silently re-add what the
   *   user turned off by hand, and `follow()` is the way back to the policy.
   * - **Retrying** a server the policy already authorizes ("连接" on a failed row, or
   *   "立即重试") is *not* an intent change. Pinning `custom` there would freeze the set and
   *   show an unnecessary "恢复自动" for a decision the user never made.
   */
  async connect(signal, serverId) {
    const plan = await this.preview(signal);
    if (!plan) return undefined;
    // The declaration may be newer than the last policy snapshot; authorize against fresh policy.
    await this.refreshPolicy(plan, signal);
    const names = serverId === undefined
      ? plan.servers.map(entry => entry.spec.config.serverName) : [serverId];
    const unauthorized = names.filter(name => !this.policyAllowed.has(name));
    if (this.selectionMode === 'custom') {
      // Already manual: an added server is part of the manual set, never a mode change.
      this.selection = new Set([...this.selection, ...names]);
    } else if (unauthorized.length > 0) {
      this.selection = new Set([...this.effectiveSelection(plan), ...unauthorized]);
      this.selectionMode = 'custom';
    }
    for (const name of names) {
      const record = this.mounts.get(name);
      if (!record || record.down) this.retryRequested.add(name);
    }
    this.loadedFingerprint = undefined;
    try { await this.reconcile(signal); }
    catch (error) { this.logger.warn(`workspace-mcp: ${error.message}`); }
    return this.status(signal);
  }
  /** Manual disconnect: the selection stays off until the user connects again or follows the policy. */
  async disconnect(signal, serverId) {
    const plan = this.plan ?? await this.preview(signal);
    if (plan) {
      const effective = this.effectiveSelection(plan);
      if (serverId === undefined) this.selection = new Set();
      else { effective.delete(serverId); this.selection = effective; }
      this.selectionMode = 'custom';
    }
    for (const [name, record] of this.mounts) {
      if (!this.selection.has(name)) this.cancelRecord(record);
    }
    this.loadedFingerprint = undefined;
    this.requiredFailure = false;
    try { await this.reconcile(signal); } // Healthy siblings keep their child fibers.
    catch (error) { this.logger.warn(`workspace-mcp: ${error.message}`); }
    return this.status(signal);
  }
  /** Drop the manual override and load exactly what the policy allows. */
  async follow(signal) {
    this.selectionMode = 'auto'; this.selection = new Set();
    this.loadedFingerprint = undefined;
    try { await this.reconcile(signal); }
    catch (error) { this.logger.warn(`workspace-mcp: ${error.message}`); }
    return this.status(signal);
  }
  /** The Agent's own filesystem when its context reaches one, else the injected fallback. */
  filesystem() {
    try { return this.agent.ctx.get('fs') ?? this.optionalServices.fs; }
    catch { return this.optionalServices.fs; }
  }
  async isTrusted(fs, cwd, signal) {
    if (this.config.trustMode === 'all') return true;
    const target = await fs.resolve(cwd, { signal });
    for (const root of this.config.trustedWorkspaces ?? []) {
      const trusted = await fs.resolve(root, { signal });
      if (trusted.targetKey === target.targetKey) return true;
    }
    return false;
  }
  /**
   * Resolve this session's per-workspace allowance, if the user wrote one.
   *
   * Entries are matched by canonical identity exactly like `trustedWorkspaces`, so a
   * differently spelled path still selects the same directory; an entry naming a path that
   * does not resolve is skipped instead of failing the whole generation.
   */
  async loadAllowance(fs, cwd, signal) {
    const found = { workspace: null, allowMcp: [], allowTools: [] };
    const target = await fs.resolve(cwd, { signal });
    for (const entry of this.config.workspaceAllowances ?? []) {
      try {
        const candidate = await fs.resolve(entry.workspace, { signal });
        if (candidate.targetKey !== target.targetKey) continue;
      } catch { continue; }
      found.workspace = entry.workspace;
      found.allowMcp = [...(entry.allowMcp ?? [])];
      found.allowTools = [...(entry.allowTools ?? [])];
      break;
    }
    this.allowance = found;
    return found;
  }
  /** A profile save revokes connection authority immediately, including an attempt in flight. */
  async policyChanged() {
    const interrupted = [];
    // Interrupt the in-flight activation before waiting for the serialized work that owns it.
    if (this.plan) {
      await this.refreshPolicy(this.plan, this.abort.signal);
      for (const record of this.mounts.values()) {
        if (!this.effectiveSelection().has(record.name)) this.cancelRecord(record);
        else if (record.autoAuthority && record.instance !== undefined && !this.eligible(record)) {
          record.controller?.abort(new Error('automatic connection permission revoked'));
          if (record.task) interrupted.push(record.task);
        }
      }
    }
    await this.enqueue(async () => {
      if (!this.plan) return;
      await this.refreshPolicy(this.plan, this.abort.signal);
      for (const record of [...this.mounts.values()]) {
        // Losing authority is not a retry condition any more: the bridge would keep reconnecting
        // a server this profile no longer allows, so the instance is retired instead.
        if (record.stopped || !this.effectiveSelection().has(record.name) || !this.eligible(record)) { await this.retire(record); continue; }
        const live = this.serverStates.get(record.name);
        if (live?.reconnect) live.reconnect.eligible = this.eligible(record);
      }
      this.loadedFingerprint = undefined;
    });
    await Promise.allSettled(interrupted);
  }
  refreshPolicy(plan, signal) {
    // Concurrent initialize completions must not let an older trust lookup
    // overwrite the result of a newer profile revocation.
    const operation = (this.policyQueue ?? Promise.resolve()).then(async () => {
      signal?.throwIfAborted();
      const fs = this.filesystem();
      this.trustedWorkspace = await this.isTrusted(fs, plan.cwd, signal).catch(() => false);
      await this.loadAllowance(fs, plan.cwd, signal).catch(() => {
        this.allowance = { workspace: null, allowMcp: [], allowTools: [] };
      });
      signal?.throwIfAborted();
      this.policyAllowed = new Set(plan.servers.map(entry => entry.spec.config.serverName).filter(name => this.canAutoConnect(name)));
    });
    this.policyQueue = operation.catch(() => {});
    return operation;
  }
  eligible(record) {
    return this.monitoring && !this.closed && !record.stopped
      && this.effectiveSelection().has(record.name) && this.policyAllowed.has(record.name);
  }
  current(record, token = record.token) {
    return !this.closed && !record.stopped && this.mounts.get(record.name) === record && record.token === token;
  }
  /**
   * The native host every mount, probe and authorization of this session goes through.
   *
   * The bridge publishes `ctx.mcpClientHost` for exactly this purpose, so this plugin stops
   * re-implementing the connection lifecycle. The host is created below this agent's own scope
   * boundary rather than reusing an injected one: the instances it mounts register their tools
   * in that agent's scope and end with it, which is the isolation this plugin exists to provide.
   * @returns the host, or undefined when the loaded bridge is too old to publish one.
   */
  sessionHost() {
    if (this.host !== undefined) return this.host;
    const HostClass = this.nativePlugin?.McpClientHost;
    if (typeof HostClass !== 'function') return undefined;
    this.group ??= this.makeBoundary(this.agent.ctx);
    try {
      // The host is a Cordis service, and one provider slot exists per service name — so each
      // session provides its own under an isolated name. Sharing a slot would make the second
      // session's host construction throw, and reusing a composition's host would put this
      // agent's tools in that host's scope instead of this one.
      this.host = new HostClass(this.group.ctx.isolate('mcpClientHost'));
    } catch (error) {
      this.logger.warn(`workspace-mcp: the MCP client host could not be created: ${error?.message ?? error}`);
      this.host = undefined;
    }
    return this.host;
  }
  /**
   * The configuration actually handed to the bridge: declaration values plus what this plugin
   * owns. Reconnection and startup budgets stay the bridge's, so there is one supervisor.
   */
  mountConfig(spec) {
    const config = { ...spec.config };
    // The typed status is what reports a failed attempt now, so a failed first connect must
    // not reject the plugin fiber: that would hide `waiting-authorization` behind an error.
    config.failOnStartupError = false;
    config.toolLoading = config.toolLoading ?? this.loadingMode();
    config.catalogDescriptionMaxLength = config.catalogDescriptionMaxLength
      ?? this.config.catalogDescriptionMaxLength ?? 160;
    const startupTimeoutMs = spec.startupTimeoutMs ?? this.config.startupTimeoutMs;
    if (startupTimeoutMs !== undefined) config.startupTimeoutMs = startupTimeoutMs;
    return config;
  }
  /** `on-demand` unless this profile asked for eager registration. */
  loadingMode() {
    return this.config.toolLoading === 'eager' ? 'eager' : 'on-demand';
  }
  /**
   * Resolve one server configuration through the bridge's own schema.
   *
   * This is the half of validation this plugin cannot duplicate: field defaults, the server-name
   * pattern, template syntax and the OAuth/Authorization conflict are the bridge's contract, and
   * asking it means a declaration is refused with the same wording its own loader would use.
   * @throws a {@link DeclarationError}-shaped error carrying the bridge's message.
   */
  validateConfig(config, name) {
    const host = this.sessionHost();
    if (host === undefined || typeof host.validate !== 'function') return config;
    try { return host.validate(config, ['mcp', name]); }
    catch (error) {
      throw Object.assign(new Error(error?.message ?? 'invalid MCP server configuration'), { code: 'INVALID_CONFIG' });
    }
  }
  /**
   * The parts of a management row this plugin owns, independent of the native state machine.
   *
   * They are re-read on every status publication so a probe's confirmation, a changed loading
   * mode and the current authorization attempt are never lost to a transitional native state.
   */
  viewBase(record) {
    return {
      tools: [],
      error: undefined,
      detail: undefined,
      /** Native attempt bookkeeping; replaced wholesale by a `reconnecting` status. */
      reconnect: { eligible: this.eligible(record), attempt: 0, maxAttempts: null, nextRetryAt: null, reason: null },
      /** Whether this transport is covered by reachability probing at all. */
      http: probeTarget(record.entry?.spec) !== undefined,
      /** Cleared by a failed probe, so one bad probe withdraws the green claim immediately. */
      confirmed: record.confirmed !== false,
      lastVerifiedAt: record.lastVerifiedAt,
      toolLoading: record.entry?.spec.config.toolLoading ?? this.loadingMode(),
      authorization: this.authorizationView(record.name),
    };
  }
  /** Publish one row's state; everything else in the view is recomputed from the record. */
  setView(record, patch) {
    this.serverStates.set(record.name, { ...this.viewBase(record), ...patch });
    this.publish();
  }
  /**
   * Mirror one native connection status into the row.
   *
   * The bridge's state machine is the single source of truth for connection state, including
   * `waiting-authorization` and its typed reason: this plugin translates it into panel
   * vocabulary and adds the two things the row shows beyond it (reachability confirmation and
   * the authorization attempt).
   */
  nativeView(record, status) {
    const view = this.viewBase(record);
    switch (status?.state) {
      case 'connected':
        record.down = false;
        this.serverStates.set(record.name, { ...view, state: SERVER_STATES.connected, tools: this.toolNamesFor(record.name), toolCount: status.toolCount, connectedAt: status.connectedAt });
        break;
      case 'connecting':
        this.serverStates.set(record.name, { ...view, state: SERVER_STATES.pending });
        break;
      case 'reconnecting':
        record.down = true;
        this.serverStates.set(record.name, {
          ...view, state: SERVER_STATES.reconnecting, error: 'CONNECTION_LOST', detail: status.lastError,
          reconnect: { ...view.reconnect, attempt: status.attempt, maxAttempts: status.maxAttempts, nextRetryAt: status.nextRetryAtMs, reason: status.lastError },
        });
        break;
      case 'failed':
        record.down = true;
        // An unclosed generation can overlap a new child process, so this name may never respawn.
        if (status.reason === 'unclosed-generation') this.unsafeNames.add(record.name);
        this.serverStates.set(record.name, {
          ...view, state: SERVER_STATES.failed, error: failureCodeOf(status.reason), detail: status.lastError,
        });
        break;
      case 'waiting-authorization':
        record.down = true;
        this.serverStates.set(record.name, {
          ...view, state: SERVER_STATES.authorization, error: 'AUTHORIZATION_REQUIRED', detail: status.lastError,
          authorization: { ...view.authorization, reason: status.reason, lastError: status.lastError },
        });
        break;
      case 'waiting-credentials':
        record.down = true;
        this.serverStates.set(record.name, { ...view, state: SERVER_STATES.failed, error: 'MISSING_CREDENTIALS', detail: status.lastError });
        break;
      case 'closed':
        this.serverStates.set(record.name, { ...view, state: record.stopped ? SERVER_STATES.unloaded : SERVER_STATES.failed, error: status.result?.closeConfirmed === false || status.result?.cleanupError !== undefined ? 'CLOSE_UNCONFIRMED' : undefined });
        break;
      default:
        this.serverStates.set(record.name, view);
    }
    this.publish();
  }
  /**
   * Whether a connected row's state was confirmed recently enough to be shown as fact.
   *
   * This is the honest half of the feature and it costs no network: a row that has not
   * been confirmed within two probe intervals simply stops claiming to be green. stdio
   * rows are always "confirmed" because a child exit reaches the native bridge directly.
   */
  verified(state) {
    if (!state || state.state !== SERVER_STATES.connected) return false;
    if (state.http !== true) return true;
    if (state.confirmed === false) return false;
    return state.lastVerifiedAt !== undefined && this.clock.now() - state.lastVerifiedAt <= this.freshnessMs();
  }
  /** How long a confirmation stays valid: two probe intervals of the current cadence. */
  freshnessMs() {
    return this.clock.now() - this.lastActivityAt <= HEALTH.hotWindowMs ? HEALTH.hotMs * 2 : HEALTH.warmMs * 2;
  }
  /** Any MCP-shaped work restarts the heartbeat and refreshes the staleness clock. */
  noteActivity() {
    this.lastActivityAt = this.clock.now();
    for (const record of this.mounts.values()) {
      if (record.probeTimer === undefined && record.probing === undefined) this.scheduleHealth(record);
    }
    this.publish();
  }
  healthApplies(record) {
    return this.healthEnabled && this.monitoring && !this.closed && !record.stopped && record.down !== true
      && this.serverStates.get(record.name)?.state === SERVER_STATES.connected
      && probeTarget(record.entry?.spec) !== undefined;
  }
  /**
   * When the next probe is due. `undefined` means the session has been idle long enough
   * that nothing should run: activity restarts it, and the staleness rule keeps the panel
   * honest in the meantime.
   */
  healthDelay(record, override) {
    if (override !== undefined) return override;
    const idle = this.clock.now() - this.lastActivityAt;
    if (idle > HEALTH.warmWindowMs) return undefined;
    const interval = idle <= HEALTH.hotWindowMs ? HEALTH.hotMs : HEALTH.warmMs;
    const due = (record.lastVerifiedAt ?? 0) + interval;
    return Math.max(0, due - this.clock.now());
  }
  scheduleHealth(record, override) {
    this.clock.clearTimeout(record.probeTimer); record.probeTimer = undefined;
    if (!this.healthApplies(record)) return;
    const delay = this.healthDelay(record, override);
    if (delay === undefined) return;
    const token = record.token;
    record.probeTimer = this.clock.setTimeout(() => {
      record.probeTimer = undefined;
      void this.checkHealth(record, token);
    }, delay);
  }
  /** The heartbeat tick: probe, then either record the confirmation or reschedule. */
  async checkHealth(record, token) {
    if (!this.current(record, token) || !this.healthApplies(record)) return;
    const result = await this.probeRecord(record);
    if (!this.current(record, token) || result === undefined || result.cancelled === true) return;
    if (this.serverStates.get(record.name)?.state === SERVER_STATES.connected) this.scheduleHealth(record, result.reachable ? undefined : HEALTH.confirmMs);
  }
  /**
   * Probe one mounted record, sharing any in-flight probe.
   *
   * One failure only withholds the green dot and schedules a fast confirmation; a second
   * consecutive failure hands the server to the existing reconnect supervisor, which owns
   * disposal and recovery. Successful real traffic resets the strike count, so a blocked
   * probe can never tear down a connection that demonstrably still works.
   */
  async probeRecord(record, signal) {
    const url = probeTarget(record.entry?.spec);
    if (url === undefined) return { reachable: true, skipped: true };
    if (record.probing !== undefined) return record.probing;
    const token = record.token;
    record.lastProbeAt = this.clock.now();
    const probe = probeHttp(url, {
      timeoutMs: HEALTH.probeTimeoutMs, fetchImpl: this.fetchImpl,
      signal: signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal,
    });
    record.probing = probe;
    let result;
    try { result = await probe; }
    finally { if (record.probing === probe) record.probing = undefined; }
    if (!this.current(record, token) || result?.cancelled === true) return result;
    if (result.reachable) {
      record.probeFailures = 0;
      record.confirmed = true;
      record.lastVerifiedAt = this.clock.now();
      this.setView(record, { state: SERVER_STATES.connected, tools: this.toolNamesFor(record.name) });
      return result;
    }
    record.probeFailures += 1;
    record.confirmed = false;
    // Still connected as far as the bridge knows, just no longer confirmed by anyone.
    this.setView(record, { state: SERVER_STATES.connected, tools: this.toolNamesFor(record.name), error: result.code ?? 'PROBE_FAILED' });
    if (record.probeFailures >= HEALTH.failuresToOffline) {
      this.logger.info(`workspace-mcp: ${record.name} unreachable (${result.code}); replacing the connection`);
      await this.enqueue(() => this.current(record, token) ? this.reconnectRecord(record) : undefined).catch(() => {});
    } else this.scheduleHealth(record, HEALTH.confirmMs);
    return result;
  }
  /**
   * Replace one connection generation.
   *
   * Reachability probing exists for transports whose death is silent. When it proves the
   * endpoint gone, the honest recovery is the one the bridge performs itself: end the instance
   * (which stops its supervisor) and mount a fresh one. An unconfirmed cleanup still blocks the
   * respawn, exactly as it does for every other path.
   */
  async reconnectRecord(record) {
    const instance = record.instance; record.instance = undefined;
    if (instance === undefined) return;
    await this.release(record, instance);
    if (!this.current(record) || !this.eligible(record)) return;
    if (this.unsafeNames.has(record.name)) {
      this.setView(record, { state: SERVER_STATES.failed, error: 'CLOSE_UNCONFIRMED' });
      return;
    }
    await this.startRecord(record, this.abort.signal, true);
  }
  /**
   * The model is about to call one of this server's tools: a stale confirmation is worth
   * a bounded probe, because failing here costs a second while failing inside the call
   * costs the whole tool timeout.
   * @returns the probe result when one ran, else undefined (fresh, stdio, or not mounted).
   */
  async verifyBeforeCall(serverName, signal) {
    const record = this.mounts.get(serverName);
    if (!this.healthEnabled || record === undefined || record.stopped || this.closed) return undefined;
    if (probeTarget(record.entry?.spec) === undefined) return undefined;
    if (this.serverStates.get(serverName)?.state !== SERVER_STATES.connected) return undefined;
    const at = record.lastVerifiedAt;
    if (at !== undefined && this.clock.now() - at <= HEALTH.freshMs) return undefined;
    this.noteActivity();
    return this.probeRecord(record, signal);
  }
  cancelRecord(record) {
    record.stopped = true;
    this.clock.clearTimeout(record.probeTimer); record.probeTimer = undefined;
    // Teardown must never depend on a listener staying quiet: an abort reason is data, not a
    // failure of the disposal that raises it.
    // No custom reason: a cancellation reads as the platform's AbortError, which every consumer
    // (including the bridge's own supervisors) already treats as "stop, do not report".
    try { record.controller?.abort(); }
    catch { /* a throwing abort listener is not a teardown failure */ }
  }
  /**
   * Dispose one native instance and keep its cleanup verdict.
   *
   * The bridge returns the transport and local cleanup outcome itself, so an instance that
   * "disposed" but left a child process behind is reported here instead of guessed from logs.
   * An unconfirmed closure marks the name unsafe: respawning under it could overlap the old
   * process, so it never happens without a Host restart.
   */
  async release(record, instance, { checkName = true } = {}) {
    if (instance === undefined) return { closeConfirmed: true };
    // An activation that settles after its instance was already ended must not end it twice.
    const previous = this.releaseResults.get(instance);
    if (previous !== undefined) return previous;
    // Detach first: a second caller (a retirement racing the startup catch) must not dispose the
    // same instance twice.
    if (record.instance === instance) record.instance = undefined;
    record.unsubscribe?.(); record.unsubscribe = undefined;
    if (record.handle !== undefined && record.instance === instance) record.handle = undefined;
    let result = { closeConfirmed: true };
    try { result = (await instance.dispose()) ?? result; }
    catch (error) { result = { closeConfirmed: false, cleanupError: String(error?.message ?? error) }; }
    this.releaseResults.set(instance, result);
    if (result.closeConfirmed === false || typeof result.cleanupError === 'string') {
      if (checkName) this.unsafeNames.add(record.name);
      this.logger.warn(`workspace-mcp: ${record.name} CLOSE_UNCONFIRMED (details redacted)`);
      this.setView(record, { state: SERVER_STATES.failed, error: 'CLOSE_UNCONFIRMED' });
    }
    return result;
  }
  /** End one server's authorization owner, releasing its callback route and any pending attempt. */
  async retireAuthorization(name) {
    const entry = this.authOwners.get(name);
    this.authOwners.delete(name);
    if (entry === undefined) return;
    try { await entry.owner.dispose(); }
    catch (error) { this.logger.warn(`workspace-mcp: ${name} OAuth owner cleanup failed (details redacted)`); }
  }
  async retire(record) {
    this.cancelRecord(record);
    this.mounts.delete(record.name);
    const instance = record.instance; record.instance = undefined;
    if (instance !== undefined) await this.release(record, instance);
    else { record.unsubscribe?.(); record.unsubscribe = undefined; }
    if (record.task) await record.task.catch(() => {});
    await this.retireAuthorization(record.name);
    this.toolFilters.delete(record.name);
    this.serverStates.delete(record.name);
  }
  /** Serialized background work cannot race declaration generations or user selection. */
  enqueue(run) {
    const operation = this.queue.then(() => this.closed ? undefined : run());
    this.queue = operation.catch(() => { this.logger.warn('workspace-mcp: background connection task failed (details redacted)'); });
    return operation.finally(() => this.publish());
  }
  /** Mirror one native status change into the row; the bridge owns the state machine. */
  nativeStatus(record, token, status) {
    if (status === undefined || !this.current(record, token)) return;
    // A live connection is its own confirmation: reachability probing only exists for
    // transports whose death the transport itself cannot report.
    if (status.state === 'connected') {
      record.connectedAt = status.connectedAt;
      record.lastVerifiedAt = this.clock.now();
      record.confirmed = true;
      record.probeFailures = 0;
    }
    this.nativeView(record, status);
    // Schedule after the row is published: the heartbeat only applies to a row the view already
    // reports as connected.
    if (status.state === 'connected') this.scheduleHealth(record);
  }
  /**
   * Attach the status handle once an instance finishes activating.
   *
   * A mount that settles after this session moved on owns an orphan process, so it is disposed
   * here instead of being left behind. Everything else subscribes and immediately reads the
   * current status, which is what makes a first-attempt `waiting-authorization` or `reconnecting`
   * visible without waiting for a transition that may never come.
   */
  attach(record, token, instance, handle) {
    if (!this.current(record, token) || record.instance !== instance) {
      void this.release(record, instance, { checkName: false });
      return;
    }
    record.handle = handle;
    record.unsubscribe = handle.onChange(status => this.nativeStatus(record, token, status));
    this.nativeStatus(record, token, handle.current());
  }
  /** Stop one instance where nothing would restart it: the native supervisor only runs while it lives. */
  async stop(record, code) {
    const instance = record.instance; record.instance = undefined;
    record.down = true;
    this.clock.clearTimeout(record.probeTimer); record.probeTimer = undefined;
    if (instance !== undefined) await this.release(record, instance);
    if (!this.current(record)) return;
    this.setView(record, { state: SERVER_STATES.failed, error: code });
    this.toolFilters.delete(record.name);
  }
  async startRecord(record, signal, automatic = false) {
    if (!this.current(record)) return;
    if (this.unsafeNames.has(record.name)) {
      this.setView(record, { state: SERVER_STATES.failed, error: 'CLOSE_UNCONFIRMED' });
      return;
    }
    record.down = false;
    record.autoAuthority = automatic || this.eligible(record);
    record.controller = new AbortController();
    const combined = AbortSignal.any([signal, this.abort.signal, record.controller.signal]);
    const token = ++record.token;
    this.setView(record, { state: automatic ? SERVER_STATES.reconnecting : SERVER_STATES.pending });
    try {
      await this.connectionSlot(() => this.mount(record, combined, token), combined);
      combined.throwIfAborted();
      if (!this.current(record, token)) return;
      // A live profile can change while the first attempt runs. Never finish an automatic
      // connection under the permission snapshot captured before that wait.
      if (record.autoAuthority) {
        await this.refreshPolicy(this.plan, combined);
        if (!this.current(record, token)) return;
        if (!this.eligible(record)) { await this.stop(record, 'AUTO_CONNECT_REVOKED'); return; }
      }
      this.publish();
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,39}$/.test(error.code) ? error.code : 'START_FAILED';
      const dead = error?.activationFailed === true || record.instance === undefined;
      if (!this.current(record, token)) {
        // Cancelled by a disposal or a replacement generation: end the instance, report nothing.
        const instance = record.instance; record.instance = undefined;
        if (instance !== undefined) await this.release(record, instance, { checkName: false });
        return;
      }
      if (dead) {
        // No supervisor is left to retry, so this row waits for a new declaration or a manual
        // connect instead of pretending a retry is scheduled.
        const instance = record.instance; record.instance = undefined;
        if (instance !== undefined) await this.release(record, instance, { checkName: false });
        record.down = true;
        this.toolFilters.delete(record.name);
        this.setView(record, { state: SERVER_STATES.failed, error: code, detail: error?.message });
      } else {
        // A startup timeout: the bridge is still trying and owns the retry, so the row only
        // carries the code until the next status arrives.
        this.setView(record, { error: code, detail: error?.message });
      }
      this.logger.warn(`workspace-mcp: ${record.name} ${code} (details redacted)`);
    }
  }
  async update(signal, beforeChange) {
    if (this.closed) return;
    const combined = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    combined.throwIfAborted();
    const fs = this.filesystem();
    if (!fs || !this.agent.session?.header?.cwd) {
      this.logger.warn('workspace-mcp: missing filesystem or session workspace; skipped'); return;
    }
    let plan;
    try { plan = await this.load(fs, this.agent.session.header.cwd, this.config, { signal: combined }); }
    catch (error) {
      if (combined.aborted) throw error;
      await beforeChange?.(); await this.closeGroup(); this.loadedFingerprint = undefined;
      this.logger.warn(`workspace-mcp: ${startupCode(error)}`); return;
    }
    this.plan = plan;
    await this.refreshPolicy(plan, combined);
    for (const record of this.mounts.values()) {
      // A manual connect is legitimate while the policy allows nothing, so this loop only
      // refreshes what the row reports; revoking authority is policyChanged's job.
      const live = this.serverStates.get(record.name);
      if (live?.reconnect) live.reconnect.eligible = this.eligible(record);
    }
    if (this.loadKey(plan) === this.loadedFingerprint && this.retryRequested.size === 0) {
      if (this.requiredFailure) throw new Error('workspace-mcp: required server failed to start');
      return;
    }
    await beforeChange?.();
    if (plan.diagnostics.some(issue => issue.required)) {
      await this.closeGroup(); this.loadedFingerprint = undefined;
      throw new Error('workspace-mcp: invalid required server declaration');
    }
    if (plan.fingerprint !== this.diagnosticFingerprint) {
      for (const issue of plan.diagnostics) this.logger.warn(`workspace-mcp: ${JSON.stringify(issue)}`);
      this.diagnosticFingerprint = plan.fingerprint;
    }
    const selected = this.effectiveSelection(plan);
    const targets = plan.servers.filter(entry => selected.has(entry.spec.config.serverName));
    const byName = new Map(targets.map(entry => [entry.spec.config.serverName, entry]));
    for (const record of [...this.mounts.values()]) {
      const entry = byName.get(record.name);
      const force = this.retryRequested.has(record.name) && this.serverStates.get(record.name)?.state !== SERVER_STATES.connected;
      if (record.stopped || !entry || !isDeepStrictEqual(entry, record.entry) || force) await this.retire(record);
    }
    this.retryRequested.clear();
    if (!targets.length) {
      await this.closeGroup(); this.loadedFingerprint = this.loadKey(plan); this.requiredFailure = false; return;
    }
    if (targets.some(entry => entry.spec.includeTools !== undefined || entry.spec.excludeTools !== undefined)) this.ensureGuard();
    await mapLimit(targets, MOUNT_CONCURRENCY, async entry => {
      const name = entry.spec.config.serverName;
      if (this.mounts.has(name) || combined.aborted || this.closed) return;
      // One record per server for as long as its declaration is unchanged: the native
      // supervisor keeps the connection alive, so a drop is a status change, not a new record.
      const record = { name, entry, token: 0, stopped: false, down: false, confirmed: true, probeFailures: 0 };
      this.knownServers.add(name);
      this.mounts.set(name, record);
      await this.startRecord(record, combined);
    });
    if (combined.aborted) { await this.closeGroup(); combined.throwIfAborted(); }
    this.loadedFingerprint = this.loadKey(plan);
    this.requiredFailure = targets.some(entry => entry.spec.required && this.serverStates.get(entry.spec.config.serverName)?.state !== SERVER_STATES.connected);
    if (this.requiredFailure) throw new Error('workspace-mcp: required server failed to start');
  }
  /**
   * Mount one server through the bridge's own management host.
   *
   * The bridge starts the instance, owns its reconnect supervisor and publishes a typed status
   * handle for it; this call only bounds the activation wait and publishes what the handle says.
   * A mount that outlives its startup budget is *not* torn down: the supervisor may still be
   * trying, and its next status update is more truthful than a timeout the panel already shows.
   */
  async mount(record, signal, token) {
    const name = record.name;
    const host = this.sessionHost();
    if (host === undefined || typeof host.mount !== 'function') {
      throw Object.assign(new Error('workspace-mcp: this Host does not publish an MCP client host'), { code: 'NATIVE_UNAVAILABLE' });
    }
    if (record.entry.spec.includeTools !== undefined || record.entry.spec.excludeTools !== undefined) {
      this.toolFilters.set(name, {
        prefix: `mcp__${name}__`,
        // The bridge's loader is this declaration's transport, not one of its tools: an include
        // list that does not name it must not make every tool behind it unreachable.
        loader: (record.entry.spec.config.toolLoading ?? this.loadingMode()) === 'on-demand' ? loaderToolName(name) : undefined,
        allow: record.entry.spec.includeTools === undefined ? undefined : new Set(record.entry.spec.includeTools.map(tool => publicToolName(name, tool))),
        deny: new Set((record.entry.spec.excludeTools ?? []).map(tool => publicToolName(name, tool))),
      });
    }
    const config = this.validateConfig(this.mountConfig(record.entry.spec), name);
    const instance = host.mount(config);
    record.instance = instance;
    // Settle the instance's own activation in the background: whichever way this call ends,
    // an activated instance must publish its status and an orphaned one must be disposed.
    const ready = instance.ready;
    void ready.then(handle => this.attach(record, token, instance, handle), () => {});
    const budgetMs = (config.startupTimeoutMs ?? this.config.startupTimeoutMs ?? 15000) + NATIVE_STARTUP_GRACE_MS;
    // The wait resolves instead of rejecting on every path. A rejected promise raised from
    // inside a synchronous teardown is briefly unhandled, which the Host treats as fatal.
    let cleanup = () => {};
    const settled = await Promise.race([
      ready.then(handle => ({ handle }), error => ({ error })),
      new Promise(resolve => {
        const timer = this.clock.setTimeout(() => resolve({ timeout: true }), budgetMs);
        const cancel = () => resolve({ aborted: true });
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        cleanup = () => { this.clock.clearTimeout(timer); signal.removeEventListener('abort', cancel); };
      }),
    ]);
    cleanup();
    if (settled.handle !== undefined) return settled.handle;
    if (settled.timeout === true) throw Object.assign(new Error('startup timeout'), { code: 'STARTUP_TIMEOUT' });
    if (settled.aborted === true) throw Object.assign(new Error('mount cancelled'), { code: 'CANCELLED' });
    // A rejected activation means the bridge fiber is gone: nothing will retry it, so the caller
    // ends the instance and reports the failure.
    throw Object.assign(settled.error, { activationFailed: true });
  }
  /** End every mount of the current generation, keeping the session's host for the next one. */
  async closeGroup() {
    const records = [...this.mounts.values()];
    for (const record of records) this.cancelRecord(record);
    await Promise.all(records.map(record => this.retire(record)));
    this.toolFilters.clear(); this.serverStates.clear(); this.requiredFailure = false;
  }
  /**
   * Test one declared server without touching its live mount.
   *
   * Uses the loaded bridge's own one-shot probe (0.2.2+) so the answer reflects a real MCP
   * handshake and tool listing instead of the reachability guess the heartbeat makes. Nothing
   * registers and no name is reserved, so a probe works for a connected, stopped or failed row.
   * @param serverId - the normalized server name the panel shows.
   * @returns the bridge's probe outcome (connect/list result plus cleanup confirmation).
   */
  async probe(serverId) {
    const entry = (this.plan?.servers ?? []).find(item => item.spec.config.serverName === serverId);
    if (entry === undefined) throw Object.assign(new Error('workspace-mcp: no such declared server'), { code: 'UNKNOWN_SERVER' });
    const host = this.sessionHost();
    if (host === undefined || typeof host.probe !== 'function') {
      throw Object.assign(new Error('workspace-mcp: the loaded MCP bridge cannot probe servers'), { code: 'PROBE_UNSUPPORTED' });
    }
    const config = this.validateConfig(this.mountConfig(entry.spec), serverId);
    this.noteActivity();
    const outcome = await host.probe(config, { timeoutMs: this.config.probeTimeoutMs ?? 10000 });
    // The probe is the only MCP-level evidence available on demand, so let it settle this
    // row's confidence. A success confirms the session; a failure only withholds the green
    // claim, because a short budget or a busy server is not proof that the live mount died.
    const record = this.mounts.get(serverId);
    if (record !== undefined && this.serverStates.get(serverId)?.state === SERVER_STATES.connected && this.current(record)) {
      if (outcome?.ok === true) {
        record.confirmed = true;
        record.probeFailures = 0;
        record.lastVerifiedAt = this.clock.now();
        this.setView(record, { state: SERVER_STATES.connected, tools: this.toolNamesFor(serverId) });
      } else if (record.confirmed !== false) {
        record.confirmed = false;
        this.setView(record, { state: SERVER_STATES.connected, tools: this.toolNamesFor(serverId) });
      }
    }
    return outcome;
  }
  /** The browser-authorization attempt of one server, as the panel may show it. */
  authorizationView(serverId) {
    const view = this.authOwners.get(serverId)?.owner.current();
    if (view === undefined) return undefined;
    return {
      id: view.id,
      phase: view.phase,
      reason: this.serverStates.get(serverId)?.authorization?.reason,
      lastError: view.lastError,
      // Handed to the browser as-is; it is the authorization server's own page.
      ...(view.authorizationUrl === undefined ? {} : { authorizationUrl: view.authorizationUrl }),
    };
  }
  /**
   * The authorization owner of one server, created on first use and replaced when its
   * configuration changes, because an owner is bound to one endpoint, client and scope.
   */
  authorizationOwner(serverId, config, host) {
    const fingerprint = JSON.stringify([config.url, config.oauth]);
    const existing = this.authOwners.get(serverId);
    if (existing !== undefined && existing.fingerprint === fingerprint) return existing.owner;
    if (existing !== undefined) void existing.owner.dispose();
    const owner = host.authorization(config, () => {
      const record = this.mounts.get(serverId);
      if (record !== undefined) this.setView(record, {});
      else this.publish();
    });
    this.authOwners.set(serverId, { fingerprint, owner });
    return owner;
  }
  /**
   * Start (or resume) browser authorization for one declared server.
   *
   * The bridge's owner registers the callback route, opens the flow and publishes the attempt
   * phase, so this plugin only has to name the server, hand the URL to the panel and let the
   * credential update reconnect the live mount on its own.
   */
  async authorize(serverId) {
    const entry = (this.plan?.servers ?? []).find(item => item.spec.config.serverName === serverId);
    if (entry === undefined) throw Object.assign(new Error('workspace-mcp: no such declared server'), { code: 'UNKNOWN_SERVER' });
    const host = this.sessionHost();
    if (host === undefined || typeof host.authorization !== 'function') {
      throw Object.assign(new Error('workspace-mcp: the loaded MCP bridge cannot authorize servers'), { code: 'OAUTH_UNSUPPORTED' });
    }
    const config = this.validateConfig(this.mountConfig(entry.spec), serverId);
    if (config.transport !== 'streamable-http' || config.oauth === undefined) {
      throw Object.assign(new Error('workspace-mcp: this server is not declared for browser authorization'), { code: 'OAUTH_UNSUPPORTED' });
    }
    this.noteActivity();
    // The attempt itself travels through the owner's change callback, so the answer is just the
    // refreshed view: its row carries the phase and the page to open.
    await this.authorizationOwner(serverId, config, host).start();
    const record = this.mounts.get(serverId);
    if (record !== undefined) this.setView(record, {});
    else this.publish();
    return this.status(undefined);
  }
  /** Cancel the active authorization attempt of one server, leaving its grant untouched. */
  async cancelAuthorization(serverId) {
    const owner = this.authOwners.get(serverId)?.owner;
    const view = owner?.current();
    if (owner !== undefined && view !== undefined) await owner.cancel(view.id);
    this.publish();
    return this.status(undefined);
  }
  /** Retire every authorization owner; their callback routes must not outlive the session. */
  async disposeAuthorizations() {
    await Promise.all([...this.authOwners.keys()].map(name => this.retireAuthorization(name)));
  }
  /** Model-facing tool names this server currently publishes in the Agent scope. */
  toolNamesFor(serverName) {
    const prefix = `mcp__${serverName}__`;
    try { return this.scopeOwner.tools.schemas(this.agent).map(tool => tool.name).filter(name => name.startsWith(prefix)); }
    catch { return []; }
  }
  dispose() {
    if (this.disposing) return this.disposing;
    this.closed = true;
    try { this.abort.abort(); }
    catch { /* a throwing abort listener is not a teardown failure */ }
    // Release held waiters instead of leaving them to their timeout: the session is gone and
    // their next wait will be answered with SESSION_NOT_READY.
    this.release();
    this.guardDisposer?.();
    this.guardDisposer = undefined;
    // Interrupt startup immediately; only then drain its queue.
    this.disposing = (async () => {
      await this.closeGroup(); await this.queue;
      await Promise.allSettled([...this.background]);
      await this.closeGroup();
      // Authorization owners own callback routes and flows, so they end here rather than with
      // the last mount: a pending attempt has to be withdrawn.
      await this.disposeAuthorizations().catch(() => {});
      const boundary = this.group; this.group = undefined;
      if (boundary) await Promise.resolve(boundary.dispose()).catch(() => {});
    })();
    return this.disposing;
  }
}

export async function installWorkspaceLoader(ctx, config, dependencies = {}) {
  if (config.enabled === false) return;
  const nativePlugin = dependencies.nativePlugin
    ?? await loadNativeBridge(ctx, dependencies.resolveLoader);
  // No version probe and no export guessing: the bridge publishes `McpClientHost` for exactly
  // this job, so its presence is the whole capability question. A Host without it is reported
  // once here and left unconfigured rather than half-supported.
  if (typeof nativePlugin?.McpClientHost !== 'function') {
    ctx.logger.warn('workspace-mcp: the loaded MCP client does not publish ctx.mcpClientHost; workspace MCP is disabled');
  }
  const sessions = new Map();
  let stopping = false;
  function attach(agent) {
    if (stopping) return undefined;
    let state = sessions.get(agent);
    if (!state) {
      state = new WorkspaceMcpSession(agent, config, { logger: ctx.logger, scopeOwner: ctx, ...dependencies, nativePlugin });
      sessions.set(agent, state);
      // Both Agent disposal and plugin unload own the same idempotent teardown.
      agent.ctx.effect(() => () => { sessions.delete(agent); return state.dispose(); }, 'workspace-mcp.agent');
    }
    return state;
  }
  ctx.effect(() => async () => {
    stopping = true;
    await Promise.all([...sessions.values()].map(s => s.dispose()));
    sessions.clear();
  }, 'workspace-mcp.sessions');
  ctx.on('agent/created', async ({ agent, signal }) => {
    await attach(agent)?.reconcile(signal);
    return undefined;
  });
  // 0.2.2 fixes the step's executable tool set before assembling its prompt.
  // Reconcile before that admission, not by adding schemas to a text waterfall.
  installToolPreparation(ctx, async ({ agent, signal }) => {
    if (!agent || ctx.agents.get(agent.id) !== agent) return;
    const state = attach(agent);
    if (!state) return;
    signal?.throwIfAborted();
    state.noteActivity();
    await state.reconcile(signal);
    signal?.throwIfAborted();
  });
  // Existing sessions load at their next safe model-step boundary, never during a tool call.
  for (const agent of ctx.agents.list()) attach(agent);
  return {
    stateFor: agent => sessions.get(agent), sessions,
    policyChanged: () => Promise.all([...sessions.values()].map(state => state.policyChanged().catch(() => {}))),
  };
}
