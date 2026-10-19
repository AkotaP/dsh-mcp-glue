import { isDeepStrictEqual } from 'node:util';
import { createDeclarationEditor } from './edit.js';
import { loadWorkspace } from './load.js';
import { publicToolName } from './normalize.js';
import { SERVER_STATES, buildStatus } from './status.js';
import { createNativeAdapter, classifyConnectionError, nativeBridgeSupport } from './bridge.js';
import { realClock, retryDelay, STABLE_MS, createConnectionLimiter } from './retry.js';
import { HEALTH, probeHttp, probeTarget } from './health.js';

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

// Read the public assembler's base without replaying unrelated waterfall middleware.
// `owner` must be a context that injects systemPrompt; the Agent travels in `context.scope`.
async function baseAssembly(owner, context) {
  const inner = owner.extend({ waterfall: (...args) => args[1] === 'system-prompt/assemble'
    ? args.at(-1)() : owner.waterfall(...args) });
  return inner.systemPrompt.assemble(context);
}
/**
 * Copy only what changed since `previous` into the assembly already built for
 * this request, so this very model request sees the new tools, resources and
 * server instructions without re-running any assemble middleware.
 */
function refreshBaseDelta(assembly, previous, fresh) {
  for (const field of ['sections', 'contexts', 'tools']) {
    const old = new Map(previous[field].map(item => [item.name, item]));
    const changed = new Set([...old.keys(), ...fresh[field].map(item => item.name)]
      .filter(name => !isDeepStrictEqual(old.get(name), fresh[field].find(item => item.name === name))));
    const replacements = new Map(fresh[field].filter(item => changed.has(item.name)).map(item => [item.name, item]));
    assembly[field] = assembly[field].flatMap(item => changed.has(item.name)
      ? replacements.has(item.name) ? [replacements.get(item.name)] : [] : [item]);
    for (let index = 0; index < fresh[field].length; index++) {
      const item = fresh[field][index];
      if (!changed.has(item.name) || assembly[field].some(current => current.name === item.name)) continue;
      const nextNames = fresh[field].slice(index + 1).map(next => next.name);
      const position = assembly[field].findIndex(current => nextNames.includes(current.name));
      assembly[field].splice(position < 0 ? assembly[field].length : position, 0, item);
    }
  }
  for (const name of new Set([...Object.keys(previous.variables), ...Object.keys(fresh.variables)])) {
    if (isDeepStrictEqual(previous.variables[name], fresh.variables[name])) continue;
    if (Object.hasOwn(fresh.variables, name)) assembly.variables[name] = fresh.variables[name];
    else delete assembly.variables[name];
  }
}

/** Idempotent, ordered per-Agent lifecycle. Never registers project tools globally. */
export class WorkspaceMcpSession {
  constructor(agent, config, { load = loadWorkspace, nativePlugin, nativeVersion = '0.2.0-rc.2', clock = realClock, fetchImpl = fetch, health = true, makeBoundary = createBoundary, logger, scopeOwner, optionalServices } = {}) {
    this.agent = agent; this.config = config; this.load = load;
    this.nativePlugin = nativePlugin; this.makeBoundary = makeBoundary;
    this.clock = clock;
    this.fetchImpl = fetchImpl;
    /** Probing can be switched off by an embedder that owns connectivity itself. */
    this.healthEnabled = health !== false;
    /** Last time this session did anything MCP-shaped: it gates the probe cadence. */
    this.lastActivityAt = clock.now();
    this.monitoring = nativeBridgeSupport(nativePlugin, nativeVersion) !== undefined;
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
    /** Services the Agent's own context may not reach (see the entry file's inject note). */
    this.optionalServices = optionalServices ?? {};
    this.abort = new AbortController(); this.queue = Promise.resolve(); this.closed = false;
    this.group = undefined; this.loadedFingerprint = undefined;
    this.diagnosticFingerprint = undefined; this.requiredFailure = false;
    this.plan = undefined;
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
      [...this.serverStates.entries()].map(([name, value]) => JSON.stringify([name, value.state, value.tools, value.error, value.reconnect, this.verified(value) ? 1 : 0])).sort().join(','),
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
          for (const { prefix, allow, deny } of this.toolFilters.values()) {
            if (!exec.name.startsWith(prefix)) continue;
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
    for (const { prefix, allow, deny } of this.toolFilters.values()) {
      if (!publicTool.startsWith(prefix)) continue;
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
    try {
      const policy = this.optionalServices.sandboxPolicy;
      const mode = policy?.resolve?.({ session: this.agent.session })?.mode;
      return mode === undefined || mode !== 'read-only';
    } catch { return true; }
  }
  /** The declaration files behind this session, shaped for the editor panel. */
  async declarationTargets(signal) {
    const fs = this.filesystem();
    const plan = this.plan ?? await this.preview(signal);
    if (!fs || !plan) return { writable: false, reason: '这个会话还没读到工作区声明', targets: [] };
    const writable = this.canWriteWorkspace();
    const editor = createDeclarationEditor({ fs, config: this.config });
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
    return createDeclarationEditor({ fs, config: this.config });
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
    try { this.plan = await this.load(fs, cwd, this.config, { signal }); }
    catch (error) { this.logger.warn(`workspace-mcp: ${error.code ?? 'WORKSPACE_READ_FAILED'}`); }
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
      mounted: this.group !== undefined,
      serverStates: this.serverStates,
      requiredFailure: this.requiredFailure,
      monitoring: this.monitoring,
      now: this.clock.now(),
      freshnessMs: this.freshnessMs(),
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
  /** Only native contributions: unrelated assembly middleware must not be replayed or removed. */
  nativeAssemblySlice(base) {
    const names = [...this.knownServers];
    const resourceTools = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'];
    return {
      sections: base.sections.filter(item => item.name === 'mcp-resource-servers' || names.some(name => item.name === `mcp:${name}`)),
      tools: base.tools.filter(item => resourceTools.includes(item.name) || names.some(name => item.name.startsWith(`mcp__${name}__`))),
      contexts: [], variables: {},
    };
  }
  /** Synchronous observer called by the Host's base tool provider, before assembly middleware. */
  assemblyFrame() {
    const tools = this.nativeAssemblySlice({ sections: [], tools: this.scopeOwner.tools.schemas(this.agent) }).tools
      .map(({ name, description, parameters, deferLoading }) => ({ name, description, parameters: structuredClone(parameters), ...(deferLoading === true ? { deferLoading } : {}) }));
    const servers = new Map([...this.knownServers].map(name => {
      const record = this.mounts.get(name);
      return [name, [record, record?.token, record?.boundary, this.serverStates.get(name)?.state]];
    }));
    return { tools, servers };
  }
  refreshAssembly(assembly, frame, fresh) {
    const current = this.assemblyFrame();
    const names = new Set([...frame.servers.keys(), ...current.servers.keys()]);
    const changed = [...names].filter(name => {
      const before = frame.servers.get(name) ?? [], after = current.servers.get(name) ?? [];
      return before.length !== after.length || before.some((value, index) => value !== after[index]);
    });
    const owned = this.nativeAssemblySlice(fresh);
    const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);
    const previousTools = changed.length > 0 ? frame.tools : frame.tools.filter(tool => !resourceTools.has(tool.name));
    if (changed.length === 0) owned.tools = owned.tools.filter(tool => !resourceTools.has(tool.name));
    // Preserve upstream presentation/privacy filters. An absent old schema is an
    // explicit omission, not a missing contribution for us to restore. If a filter
    // touched a server, defer its newly introduced tool names until the next snapshot.
    const hidden = new Set(frame.tools.filter(tool => !assembly.tools.some(item => item.name === tool.name)).map(tool => tool.name));
    const filteredServers = [...names].filter(name => frame.tools.some(tool => hidden.has(tool.name) && tool.name.startsWith(`mcp__${name}__`)));
    const oldNames = new Set(frame.tools.map(tool => tool.name));
    owned.tools = owned.tools.filter(tool => !hidden.has(tool.name)
      && (oldNames.has(tool.name) || !filteredServers.some(name => tool.name.startsWith(`mcp__${name}__`))));
    const sectionChanged = item => changed.some(name => item.name === `mcp:${name}`)
      || (changed.length > 0 && item.name === 'mcp-resource-servers');
    owned.sections = owned.sections.filter(section => {
      if (assembly.sections.some(item => item.name === section.name)) return true;
      if (section.name === 'mcp-resource-servers') return false;
      const server = changed.find(name => section.name === `mcp:${name}`);
      return !frame.servers.get(server)?.[2]; // Do not restore a deliberately omitted old section.
    });
    refreshBaseDelta(assembly, {
      sections: assembly.sections.filter(sectionChanged), tools: previousTools, contexts: [], variables: {},
    }, { ...owned, sections: owned.sections.filter(sectionChanged) });
  }
  /** A profile save revokes retry authority immediately, including an initialize in flight. */
  async policyChanged() {
    const interrupted = [];
    // Cancel initialization before waiting for the serialized work that owns it.
    if (this.plan) {
      await this.refreshPolicy(this.plan, this.abort.signal);
      for (const record of this.mounts.values()) {
        if (!this.effectiveSelection().has(record.name)) this.cancelRecord(record);
        else if (record.autoAuthority && record.connectedAt === undefined && !this.eligible(record)) {
          record.controller?.abort(new Error('automatic connection permission revoked'));
          if (record.task) interrupted.push(record.task);
        }
      }
    }
    await this.enqueue(async () => {
      if (!this.plan) return;
      await this.refreshPolicy(this.plan, this.abort.signal);
      for (const record of [...this.mounts.values()]) {
        if (record.stopped || !this.effectiveSelection().has(record.name)) { await this.retire(record); continue; }
        if (record.timer !== undefined && !this.eligible(record)) {
          this.clock.clearTimeout(record.timer); record.timer = undefined;
          this.viewRecord(record, SERVER_STATES.failed, record.error);
        } else if (record.down && record.retryable && this.eligible(record)) this.schedule(record);
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
  viewRecord(record, state, error, nextRetryAt = null) {
    this.serverStates.set(record.name, {
      state, tools: state === SERVER_STATES.connected ? this.toolNamesFor(record.name) : [], error,
      reconnect: { eligible: this.eligible(record), attempt: record.failures, nextRetryAt, reason: error ?? null },
      /** Whether this transport is covered by reachability probing at all. */
      http: probeTarget(record.entry?.spec) !== undefined,
      /** Cleared by a failed probe, so one bad probe withdraws the green claim immediately. */
      confirmed: record.confirmed !== false,
      lastVerifiedAt: record.lastVerifiedAt,
    });
    this.requiredFailure = [...this.mounts.values()].some(item => item.entry.spec.required
      && this.effectiveSelection().has(item.name) && this.serverStates.get(item.name)?.state !== SERVER_STATES.connected);
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
      this.viewRecord(record, SERVER_STATES.connected, undefined);
      return result;
    }
    record.probeFailures += 1;
    record.confirmed = false;
    this.viewRecord(record, SERVER_STATES.connected, undefined); // still connected, just unconfirmed
    if (record.probeFailures >= HEALTH.failuresToOffline) {
      this.logger.info(`workspace-mcp: ${record.name} unreachable (${result.code}); reconnecting`);
      await this.enqueue(() => this.current(record, token) && !record.down
        ? this.failed(record, { code: result.code ?? 'PROBE_FAILED', retryable: true }) : undefined).catch(() => {});
    } else this.scheduleHealth(record, HEALTH.confirmMs);
    return result;
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
    this.clock.clearTimeout(record.timer); record.timer = undefined;
    this.clock.clearTimeout(record.probeTimer); record.probeTimer = undefined;
    record.controller?.abort(new Error('workspace MCP connection stopped'));
  }
  async closeBoundary(record, boundary, token = record.token) {
    if (record.closingBoundary === boundary && record.closing) { await record.closing; return; }
    record.closingBoundary = boundary;
    record.closingToken = token;
    const closing = Promise.resolve().then(() => boundary.dispose()).catch(() => {
      this.unsafeNames.add(record.name);
      this.logger.warn(`workspace-mcp: ${record.name} CLOSE_UNCONFIRMED (details redacted)`);
    });
    record.closing = closing;
    try { await closing; }
    finally {
      if (record.closing === closing) { record.closing = undefined; record.closingBoundary = undefined; }
      if (record.closingToken === token) record.closingToken = undefined;
    }
  }
  async retire(record) {
    this.cancelRecord(record);
    this.mounts.delete(record.name);
    const boundary = record.boundary; record.boundary = undefined;
    if (boundary) await this.closeBoundary(record, boundary);
    if (record.closing) await record.closing;
    if (record.task) await record.task;
    this.toolFilters.delete(record.name);
    this.serverStates.delete(record.name);
  }
  /** Serialized background work cannot race declaration generations or user selection. */
  enqueue(run) {
    const operation = this.queue.then(() => this.closed ? undefined : run());
    this.queue = operation.catch(() => { this.logger.warn('workspace-mcp: background connection task failed (details redacted)'); });
    return operation.finally(() => this.publish());
  }
  nativeEvent(record, token, event) {
    // A answered request is proof of life and needs no queue: record it inline so the next
    // tool call skips its pre-check entirely.
    if (event.kind === 'request-ok') {
      if (!this.current(record, token)) return;
      record.lastVerifiedAt = this.clock.now();
      record.probeFailures = 0;
      record.confirmed = true;
      this.lastActivityAt = record.lastVerifiedAt;
      this.publish();
      return;
    }
    if (event.kind === 'unsafe-close' && (this.current(record, token) || record.closingToken === token)) this.unsafeNames.add(record.name);
    if (!this.current(record, token)) return;
    // Never dispose from the native logger/execute call stack.
    void this.enqueue(async () => {
      if (!this.current(record, token)) return;
      if (event.kind === 'unsafe-close') {
        this.clock.clearTimeout(record.timer); record.timer = undefined;
        if (!record.down) await this.failed(record, { code: 'CLOSE_UNCONFIRMED', retryable: false });
        record.error = 'CLOSE_UNCONFIRMED'; record.retryable = false;
        this.viewRecord(record, SERVER_STATES.failed, record.error);
      }
      else if (event.kind === 'disconnected' || event.kind === 'request-failed') {
        await this.failed(record, { code: event.code, retryable: event.retryable !== false });
      }
    }).catch(() => {});
  }
  schedule(record) {
    if (!this.current(record) || !record.down || record.closing || record.timer !== undefined) return;
    if (this.unsafeNames.has(record.name)) { record.error = 'CLOSE_UNCONFIRMED'; record.retryable = false; }
    if (!record.retryable || !this.eligible(record)) {
      this.viewRecord(record, SERVER_STATES.failed, record.error);
      return;
    }
    record.failures += 1;
    const delay = retryDelay(record.failures, this.clock.random);
    const token = record.token;
    const at = this.clock.now() + delay;
    record.timer = this.clock.setTimeout(() => {
      record.timer = undefined;
      void this.enqueue(() => this.current(record, token) ? this.retry(record) : undefined).catch(() => {});
    }, delay);
    this.viewRecord(record, SERVER_STATES.reconnecting, record.error, at);
    // State transitions and entry into the slow lane, not an endless warning per attempt.
    if (record.failures === 1 || record.failures === 7) this.logger.info(`workspace-mcp: ${record.name} reconnect scheduled (${record.failures === 7 ? 'slow' : 'initial'} backoff)`);
  }
  async failed(record, failure) {
    if (!this.current(record) || record.down) return;
    record.down = true;
    // The reconnect supervisor owns the server from here; its own attempts are the probe.
    this.clock.clearTimeout(record.probeTimer); record.probeTimer = undefined;
    record.probeFailures = 0;
    if (record.connectedAt !== undefined && this.clock.now() - record.connectedAt >= STABLE_MS) record.failures = 0;
    record.connectedAt = undefined;
    record.error = failure.code; record.retryable = failure.retryable;
    const boundary = record.boundary; record.boundary = undefined;
    if (boundary) await this.closeBoundary(record, boundary);
    if (!this.current(record)) return;
    this.toolFilters.delete(record.name);
    this.schedule(record);
  }
  async retry(record) {
    if (!this.current(record)) return;
    const signal = this.abort.signal;
    let fresh;
    try { fresh = await this.load(this.filesystem(), this.agent.session.header.cwd, this.config, { signal }); }
    catch {
      if (this.current(record)) { record.error = 'WORKSPACE_READ_FAILED'; this.schedule(record); }
      return;
    }
    await this.refreshPolicy(fresh, signal);
    if (!this.current(record)) return;
    const entry = fresh.servers.find(item => item.spec.config.serverName === record.name);
    if (!entry || !isDeepStrictEqual(entry, record.entry)) {
      record.error = 'DECLARATION_CHANGED'; record.retryable = false;
      this.viewRecord(record, SERVER_STATES.failed, record.error);
      return; // Apply changed declarations at the existing safe assembly/editor boundary.
    }
    if (!this.eligible(record)) { this.viewRecord(record, SERVER_STATES.failed, record.error); return; }
    // Only the decision is serialized. A slow remote initialize must not hold
    // optional-MCP model requests or other servers' recovery behind its timeout.
    const task = this.startRecord(record, signal, true).catch(() => {
      this.logger.warn('workspace-mcp: recovery task failed (details redacted)');
    }).finally(() => { this.background.delete(task); this.publish(); });
    record.task = task;
    this.background.add(task);
  }
  async startRecord(record, signal, automatic = false) {
    if (!this.current(record)) return;
    if (this.unsafeNames.has(record.name)) {
      record.down = true; record.retryable = false; record.error = 'CLOSE_UNCONFIRMED';
      this.viewRecord(record, SERVER_STATES.failed, record.error); return;
    }
    record.down = false;
    record.autoAuthority = automatic || this.eligible(record);
    record.controller = new AbortController();
    const combined = AbortSignal.any([signal, this.abort.signal, record.controller.signal]);
    const token = ++record.token;
    this.viewRecord(record, automatic ? SERVER_STATES.reconnecting : SERVER_STATES.pending);
    try {
      await this.connectionSlot(() => this.mount(this.group, record.entry.spec, combined, record, token), combined);
      combined.throwIfAborted();
      if (!this.current(record, token) || record.down) return;
      // A live profile can change while initialize waits. Never finish an automatic
      // connection under the permission snapshot captured before that wait.
      if (record.autoAuthority) {
        await this.refreshPolicy(this.plan, combined);
        if (!this.current(record, token) || record.down) return;
        if (!this.eligible(record)) {
          record.down = false;
          await this.failed(record, { code: 'AUTO_CONNECT_REVOKED', retryable: false }); return;
        }
      }
      record.connectedAt = this.clock.now(); record.error = undefined;
      // A just-opened connection is its own confirmation.
      record.lastVerifiedAt = record.connectedAt;
      record.confirmed = true;
      record.probeFailures = 0;
      this.viewRecord(record, SERVER_STATES.connected);
      this.scheduleHealth(record);
      if (record.failures > 0) this.logger.info(`workspace-mcp: ${record.name} reconnected`);
    } catch (error) {
      if (!this.current(record, token)) return;
      await this.failed(record, error?.code === 'STARTUP_TIMEOUT'
        ? { code: 'STARTUP_TIMEOUT', retryable: true } : classifyConnectionError(error));
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
      if (record.timer !== undefined && !this.eligible(record)) {
        this.clock.clearTimeout(record.timer); record.timer = undefined;
        this.viewRecord(record, SERVER_STATES.failed, record.error);
      } else if (record.down && record.retryable && record.timer === undefined && this.eligible(record)) this.schedule(record);
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
    this.group ??= this.makeBoundary(this.agent.ctx);
    await mapLimit(targets, MOUNT_CONCURRENCY, async entry => {
      const name = entry.spec.config.serverName;
      if (this.mounts.has(name) || combined.aborted || this.closed) return;
      const record = { name, entry, token: 0, failures: 0, stopped: false, down: false };
      this.knownServers.add(name);
      this.mounts.set(name, record);
      await this.startRecord(record, combined);
    });
    if (combined.aborted) { await this.closeGroup(); combined.throwIfAborted(); }
    this.loadedFingerprint = this.loadKey(plan);
    this.requiredFailure = targets.some(entry => entry.spec.required && this.serverStates.get(entry.spec.config.serverName)?.state !== SERVER_STATES.connected);
    if (this.requiredFailure) throw new Error('workspace-mcp: required server failed to start');
  }
  async mount(group, spec, signal, record, token) {
    const name = spec.config.serverName;
    // Even unsupported bridges keep the original secret-free logging boundary.
    const redacted = () => safeLogger;
    const safeLogger = Object.assign(redacted, Object.fromEntries(['warn', 'error', 'info', 'debug'].map(level =>
      [level, () => this.logger[level](`workspace-mcp: native ${level} (${name}; details redacted)`)])));
    const server = this.makeBoundary(group.ctx.extend({ logger: safeLogger }));
    record.boundary = server;
    const timeoutMs = spec.startupTimeoutMs ?? this.config.startupTimeoutMs ?? 15000;
    let timer, cancel;
    try {
      if (spec.includeTools !== undefined || spec.excludeTools !== undefined) {
        this.toolFilters.set(name, {
          prefix: `mcp__${name}__`,
          allow: spec.includeTools === undefined ? undefined : new Set(spec.includeTools.map(tool => publicToolName(name, tool))),
          deny: new Set((spec.excludeTools ?? []).map(tool => publicToolName(name, tool))),
        });
      }
      const plugin = this.monitoring ? createNativeAdapter(this.nativePlugin, {
        serverName: name, logger: this.logger, onEvent: event => this.nativeEvent(record, token, event),
      }) : this.nativePlugin;
      const config = this.monitoring ? { ...spec.config, failOnStartupError: true, reconnect: { enabled: false } } : spec.config;
      const fiber = server.ctx.plugin(plugin, config);
      const cancelled = new Promise((_, reject) => {
        cancel = () => reject(signal.reason ?? new Error('cancelled'));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        timer = this.clock.setTimeout(() => reject(Object.assign(new Error('startup timeout'), { code: 'STARTUP_TIMEOUT' })), timeoutMs);
      });
      await Promise.race([fiber.await(), cancelled]);
    } catch (error) {
      record.boundary = undefined;
      await this.closeBoundary(record, server, token);
      if (this.mounts.get(name) === record && record.token === token) this.toolFilters.delete(name);
      throw error;
    } finally {
      this.clock.clearTimeout(timer);
      if (cancel) signal.removeEventListener('abort', cancel);
    }
  }
  async closeGroup() {
    const group = this.group; this.group = undefined;
    for (const record of this.mounts.values()) this.cancelRecord(record);
    await Promise.all([...this.mounts.values()].map(record => this.retire(record)));
    this.toolFilters.clear(); this.serverStates.clear(); this.requiredFailure = false;
    if (group) await group.dispose();
  }
  /** Model-facing tool names this server currently publishes in the Agent scope. */
  toolNamesFor(serverName) {
    const prefix = `mcp__${serverName}__`;
    try { return this.scopeOwner.tools.schemas(this.agent).map(tool => tool.name).filter(name => name.startsWith(prefix)); }
    catch { return []; }
  }
  dispose() {
    if (this.disposing) return this.disposing;
    this.closed = true; this.abort.abort(new Error('workspace MCP owner disposed'));
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
    })();
    return this.disposing;
  }
}

/**
 * Read the native bridge's own version through the Host loader.
 *
 * The loader exposes two different import paths and only one of them can carry JSON
 * attributes, so every reasonable spelling is tried before giving up. Returning `null`
 * means "unknown", which the capability check then decides — it never means "unsupported".
 * @returns the version string, or null when no route produced one.
 */
async function detectNativeVersion(loader, logger) {
  const pkg = '@deepseek-ai/dsh-mcp-client/package.json';
  const versionOf = value => (value?.default ?? value)?.version;
  const read = async run => {
    const version = versionOf(await run());
    return typeof version === 'string' && version.length > 0 ? version : undefined;
  };
  const attempts = [];
  const tryRead = async run => {
    try { return await read(run); }
    catch (error) { attempts.push(typeof error?.code === 'string' ? error.code : 'IMPORT_FAILED'); return undefined; }
  };
  const baseUrl = loader?.ctx?.baseUrl;
  const internal = loader?.internal;
  if (internal !== undefined) {
    // Node's internal loader takes attributes directly; both spellings have shipped.
    for (const attributes of [{ type: 'json' }, { with: { type: 'json' } }]) {
      const version = await tryRead(() => internal.import(pkg, baseUrl, attributes));
      if (version !== undefined) return version;
    }
  }
  const version = await tryRead(() => loader.import(pkg));
  if (version !== undefined) return version;
  logger?.warn?.(`workspace-mcp: native bridge metadata unavailable (${[...new Set(attempts)].join(',') || 'NO_LOADER'}); verifying capabilities instead`);
  return null;
}

export async function installWorkspaceLoader(ctx, config, dependencies = {}) {
  if (config.enabled === false) return;
  const nativePlugin = dependencies.nativePlugin
    ?? await loadNativeBridge(ctx, dependencies.resolveLoader);
  let nativeVersion = dependencies.nativeVersion;
  if (nativeVersion === undefined && !dependencies.nativePlugin) {
    let loader;
    try { loader = dependencies.resolveLoader?.() ?? ctx.get('loader'); } catch { loader = undefined; }
    nativeVersion = loader === undefined ? null : await detectNativeVersion(loader, ctx.logger);
  }
  if (nativeVersion === undefined) nativeVersion = '0.2.0-rc.2'; // Explicit test/integration bridge.
  const support = nativeBridgeSupport(nativePlugin, nativeVersion);
  if (support === undefined) {
    ctx.logger.warn(`workspace-mcp: native bridge cannot be adapted (version ${String(nativeVersion)}); enhanced reconnect disabled`);
  } else if (support === 'capabilities') {
    // Say it out loud once: disconnect wording is the one thing not verified here, so the
    // version-independent detection (probes, typed request errors) is what carries this case.
    ctx.logger.warn(`workspace-mcp: native bridge version ${String(nativeVersion)} unverified; capabilities confirmed, monitoring enabled`);
  }
  const sessions = new Map();
  let stopping = false;
  function attach(agent) {
    if (stopping) return undefined;
    let state = sessions.get(agent);
    if (!state) {
      state = new WorkspaceMcpSession(agent, config, { logger: ctx.logger, scopeOwner: ctx, ...dependencies, nativePlugin, nativeVersion });
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
  // Base providers run synchronously before any assembly middleware. Capture
  // the actual registry generation here, not an already-filtered prompt later.
  const frames = new WeakMap();
  ctx.systemPrompt.tools(context => {
    const state = sessions.get(context.agent ?? context.scope);
    if (state) frames.set(context, state.assemblyFrame());
    return { schemas: [] };
  });
  // Assembly runs before `agent/pre-step`, so loading here makes the current
  // model request see the change instead of waiting a turn.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const agent = context.agent ?? context.scope;
    if (!agent || ctx.agents.get(agent.id) !== agent) return next();
    const state = attach(agent);
    if (!state) return next();
    // A model request is the moment the tool set is about to be used: keep the heartbeat
    // warm here. The probe itself stays off this path so assembly never waits on a socket.
    state.noteActivity();
    const frame = frames.get(context) ?? state.assemblyFrame();
    // Background recovery may move the registry after the Host's initial snapshot.
    // Compare against that raw frame while retaining upstream visibility filters.
    await state.reconcile(context.signal);
    const fresh = await baseAssembly(state.scopeOwner, context);
    state.refreshAssembly(assembly, frame, fresh);
    // Do not recurse through assemble middleware: each unrelated listener runs exactly once.
    return next();
  }, { prepend: true });
  // Existing sessions load at their next safe model-step boundary, never during a tool call.
  for (const agent of ctx.agents.list()) attach(agent);
  return {
    stateFor: agent => sessions.get(agent), sessions,
    policyChanged: () => Promise.all([...sessions.values()].map(state => state.policyChanged().catch(() => {}))),
  };
}
