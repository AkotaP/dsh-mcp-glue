import { isDeepStrictEqual } from 'node:util';
import { createDeclarationEditor } from './edit.js';
import { loadWorkspace } from './load.js';
import { publicToolName } from './normalize.js';
import { SERVER_STATES, buildStatus } from './status.js';

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
  constructor(agent, config, { load = loadWorkspace, nativePlugin, makeBoundary = createBoundary, logger, scopeOwner, optionalServices } = {}) {
    this.agent = agent; this.config = config; this.load = load;
    this.nativePlugin = nativePlugin; this.makeBoundary = makeBoundary;
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
      [...this.serverStates.entries()].map(([name, value]) => name + ':' + value.state + ':' + value.tools.length).sort().join(','),
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
    });
  }
  /**
   * Explicit user consent from the panel: load this server, or every declared one, right now.
   *
   * The selection is pinned to `custom`, so what the user asked for by hand is never silently
   * re-derived from the policy, and a later declaration change cannot re-add what they turned
   * off. `follow()` is the way back to the policy.
   */
  async connect(signal, serverId) {
    const plan = await this.preview(signal);
    if (!plan) return undefined;
    if (serverId === undefined) this.selection = new Set(plan.servers.map(entry => entry.spec.config.serverName));
    else {
      if (this.selectionMode !== 'custom') this.selection = this.effectiveSelection(plan);
      this.selection.add(serverId);
    }
    this.selectionMode = 'custom';
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
    this.loadedFingerprint = undefined;
    this.requiredFailure = false;
    try { await this.reconcile(signal); } // Remount the servers that stay selected.
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
  async update(signal, beforeChange) {
    if (this.closed) return;
    const combined = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    combined.throwIfAborted();
    const fs = this.filesystem();
    if (!fs || !this.agent.session?.header?.cwd) {
      this.logger.warn('workspace-mcp: missing filesystem or session workspace; skipped');
      return;
    }
    let plan;
    try { plan = await this.load(fs, this.agent.session?.header.cwd, this.config, { signal: combined }); }
    catch (error) {
      if (combined.aborted) throw error;
      await beforeChange?.();
      await this.closeGroup();
      this.loadedFingerprint = undefined;
      this.logger.warn(`workspace-mcp: ${error.code ?? 'WORKSPACE_READ_FAILED'}`);
      return;
    }
    this.plan = plan;
    // The policy layer is cheap and decides both the cache key and what may start, so it is
    // computed before the cache check rather than after it. Nothing here asks anybody for
    // permission: a declaration loads only when the user already allowed its workspace.
    this.trustedWorkspace = await this.isTrusted(fs, plan.cwd, combined).catch(() => false);
    await this.loadAllowance(fs, plan.cwd, combined).catch(() => this.allowance);
    this.policyAllowed = new Set(plan.servers
      .map(entry => entry.spec.config.serverName)
      .filter(name => this.canAutoConnect(name)));
    if (this.loadKey(plan) === this.loadedFingerprint) {
      if (this.requiredFailure) throw new Error('workspace-mcp: required server failed to start');
      return;
    }
    // Changed/removed declarations unmount the old generation before anything new starts.
    await beforeChange?.();
    await this.closeGroup();
    this.loadedFingerprint = undefined; this.requiredFailure = false;
    if (plan.diagnostics.some(issue => issue.required)) throw new Error('workspace-mcp: invalid required server declaration');
    if (plan.fingerprint !== this.diagnosticFingerprint) {
      for (const issue of plan.diagnostics) this.logger.warn(`workspace-mcp: ${JSON.stringify(issue)}`);
      this.diagnosticFingerprint = plan.fingerprint;
    }
    const selected = this.effectiveSelection(plan);
    // Nothing authorized for this workspace: stay unloaded, silently. The panel is where a
    // user turns a server on (connect, or the per-server allowance switch).
    if (!selected.size) { this.loadedFingerprint = this.loadKey(plan); return; }
    const targets = plan.servers.filter(entry => selected.has(entry.spec.config.serverName));
    combined.throwIfAborted();
    if (targets.some(entry => entry.spec.includeTools !== undefined || entry.spec.excludeTools !== undefined)) this.ensureGuard();
    this.group = this.makeBoundary(this.agent.ctx);
    const group = this.group;
    combined.throwIfAborted();
    // Servers start concurrently: each already owns an independent child fiber, so one slow
    // server no longer delays every server declared after it, and a failure still only
    // takes its own row.
    await mapLimit(targets, MOUNT_CONCURRENCY, async entry => {
      const name = entry.spec.config.serverName;
      try {
        await this.mount(group, entry.spec, combined);
        this.serverStates.set(name, { state: SERVER_STATES.connected, tools: this.toolNamesFor(name) });
      } catch (error) {
        if (combined.aborted) return; // The abort path below closes the whole group once.
        this.serverStates.set(name, { state: SERVER_STATES.failed, tools: [], error: startupCode(error) });
        this.logger.warn(`workspace-mcp: SERVER_START_FAILED ${JSON.stringify(entry.source)}`);
        if (entry.spec.required) this.requiredFailure = true;
      }
    });
    if (combined.aborted) { await this.closeGroup(); combined.throwIfAborted(); }
    this.loadedFingerprint = this.loadKey(plan);
    this.deniedFingerprint = undefined;
    if (this.requiredFailure) {
      this.loadedFingerprint = undefined; // A failed generation is not a successful cache hit.
      await this.closeGroup();
      throw new Error('workspace-mcp: required server failed to start');
    }
  }
  async mount(group, spec, signal) {
    // Redact the native bridge's own logging: its messages may embed spawn errors
    // that contain an expanded credential from args/env.
    const redacted = () => safeLogger;
    const safeLogger = Object.assign(redacted, Object.fromEntries(['warn', 'error', 'info', 'debug'].map(level =>
      [level, () => this.logger[level](`workspace-mcp: native ${level} (${spec.config.serverName}; details redacted)`)])));
    // Independent child permits one failed server to roll back without affecting siblings.
    const server = this.makeBoundary(group.ctx.extend({ logger: safeLogger }));
    const timeoutMs = spec.startupTimeoutMs ?? this.config.startupTimeoutMs ?? 15000;
    let timer, cancel;
    try {
      if (spec.includeTools !== undefined || spec.excludeTools !== undefined) {
        const prefix = `mcp__${spec.config.serverName}__`;
        this.toolFilters.set(spec.config.serverName, {
          prefix,
          allow: spec.includeTools === undefined ? undefined : new Set(spec.includeTools.map(name => publicToolName(spec.config.serverName, name))),
          deny: new Set((spec.excludeTools ?? []).map(name => publicToolName(spec.config.serverName, name))),
        });
      }
      const fiber = server.ctx.plugin(this.nativePlugin, spec.config);
      const cancelled = new Promise((_, reject) => {
        cancel = () => reject(signal.reason ?? new Error('cancelled'));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        timer = setTimeout(() => reject(new Error('startup timeout')), timeoutMs);
      });
      await Promise.race([fiber.await(), cancelled]);
    } catch (error) {
      await server.dispose();
      this.toolFilters.delete(spec.config.serverName);
      throw error;
    } finally {
      clearTimeout(timer);
      if (cancel) signal.removeEventListener('abort', cancel);
    }
  }
  async closeGroup() {
    const group = this.group;
    this.group = undefined;
    this.toolFilters.clear();
    this.serverStates.clear();
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
    this.disposing = (async () => { await this.closeGroup(); await this.queue; await this.closeGroup(); })();
    return this.disposing;
  }
}

export async function installWorkspaceLoader(ctx, config, dependencies = {}) {
  if (config.enabled === false) return;
  const nativePlugin = dependencies.nativePlugin
    ?? await loadNativeBridge(ctx, dependencies.resolveLoader);
  const sessions = new Map();
  let stopping = false;
  function attach(agent) {
    if (stopping) return undefined;
    let state = sessions.get(agent);
    if (!state) {
      state = new WorkspaceMcpSession(agent, config, { logger: ctx.logger, scopeOwner: ctx, ...dependencies, nativePlugin });      sessions.set(agent, state);
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
  // Assembly runs before `agent/pre-step`, so loading here makes the current
  // model request see the change instead of waiting a turn.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const agent = context.agent ?? context.scope;
    if (!agent || ctx.agents.get(agent.id) !== agent) return next();
    const state = attach(agent);
    if (!state) return next();
    let previous;
    await state.reconcile(context.signal,
      async () => { previous = await baseAssembly(state.scopeOwner, context); });
    if (previous) refreshBaseDelta(assembly, previous, await baseAssembly(state.scopeOwner, context));
    // Do not recurse through assemble middleware: each unrelated listener runs exactly once.
    return next();
  }, { prepend: true });
  // Existing sessions load at their next safe model-step boundary, never during a tool call.
  for (const agent of ctx.agents.list()) attach(agent);
  return { stateFor: agent => sessions.get(agent), sessions };
}
