import { BUILTIN_PRESETS, resolvePresets } from './presets.js';

/**
 * Compare two workspace paths the way the Host will: case-insensitively, with either slash
 * and with a trailing separator ignored.
 *
 * The loader matches an entry by canonical identity, so a hand-written `D:\Work\A\` and the
 * `D:\work\a` the Host reports are the same workspace. A writer that compared strings exactly
 * would append a second entry for it, and the loader only ever reads the first.
 */
const sameWorkspace = (left, right) => String(left).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  === String(right).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** Fields the management UI may write. Secrets and limits stay out of the browser. */
export const EDITABLE = ['enabledBuiltins', 'presets', 'trustMode', 'trustedWorkspaces', 'workspaceAllowances', 'conflictPolicy'];

/**
 * The subset of `Config` the Host may rewrite live, and the only fields the management
 * UI edits.
 *
 * DSH derives a plugin entry's editable settings from its Config schema: a field is
 * form-editable exactly when it is declared `.volatile()`. `volatileForm()` in
 * `@deepseek-ai/dsh-settings` returns undefined for a schema with no volatile field and
 * `describe()` then drops the whole entry, which is what turns every write into "no
 * configurable entry". `index.js` marks exactly these five volatile, so:
 *
 *   - `settings.describe()` reports this entry under its Loader id,
 *   - `settings.update(id, patch, revision)` rewrites that row's `config` in the profile
 *     patch through `configEditor`, and the Loader applies it to the volatile reference
 *     in place — the plugin is not remounted.
 *
 * Every other Config field (limits, secrets, `enabled`, `webControl`) keeps the ordinary
 * Loader lifecycle and stays out of the form.
 */
export const VOLATILE_FIELDS = Object.freeze(['enabledBuiltins', 'presets', 'trustMode', 'trustedWorkspaces', 'workspaceAllowances', 'conflictPolicy']);

/**
 * A live view of the activation config.
 *
 * Cordis resolves a `.volatile()` field into an immutable reference that is updated in
 * place when the Loader applies a new config, so its value is only reachable through
 * `.get()`. Every other field is a plain value and is left untouched. The five volatile
 * fields are arrays, strings and booleans, so no plain value can match the reference by
 * accident.
 */
export function liveConfig(config) {
  const view = { ...config };
  for (const field of VOLATILE_FIELDS) {
    const reference = config?.[field];
    if (reference === null || typeof reference !== 'object' || typeof reference.get !== 'function') continue;
    Object.defineProperty(view, field, { enumerable: true, configurable: true, get: () => reference.get() });
  }
  // A profile written by an older version can still say `ask`, which means the same as `manual`
  // and is read that way. Rejecting it instead fails schema resolution for the whole row, and the
  // Loader then drops the plugin entirely — a far worse outcome than a legacy spelling.
  const mode = config?.trustMode;
  const readMode = mode !== null && typeof mode === 'object' && typeof mode.get === 'function'
    ? () => mode.get()
    : () => config?.trustMode;
  Object.defineProperty(view, 'trustMode', {
    enumerable: true,
    configurable: true,
    get: () => (readMode() === 'all' ? 'all' : 'manual'),
  });
  return view;
}

/**
 * Why this entry has no editable form, phrased for the management UI. The three cases are
 * distinguishable on purpose: a deployment can see whether the settings service is
 * missing, whether the plugin failed to find its own Loader row, or whether the row simply
 * declares no volatile field.
 */
function unavailableReason(service, rowId) {
  if (!service) return 'settings 服务不可用：这个 composition 没有挂载 @deepseek-ai/dsh-settings';
  if (rowId === undefined) return '找不到自己的 Loader 条目：loader 服务不可用，或条目的模块名不是本包名';
  return `Loader 条目 "${rowId}" 没有可热改字段（Config 里缺 .volatile()），所以 settings.describe() 不会收录它`;
}

/**
 * Read and write this plugin's own profile entry through the settings service.
 *
 * The entry is found by the module specifier its Loader row uses, which is the package
 * name (`dsh-mcp-glue`) — not this plugin's Cordis `name` export. The namespace
 * `describe()` reports is the row's id, and that id is what a write addresses.
 *
 * `settings.update` merges only the supplied fields, so secrets (`inputValues`) and
 * limits are never round-tripped from the browser; the preset payload is validated with
 * the same resolver the loader uses, so a broken preset never reaches disk.
 */
export function createConfigControl({ settings, loader, packageNames, fallback, onChange }) {
  const names = new Set(packageNames);
  const rowId = () => {
    const registry = loader();
    if (!registry) return undefined;
    for (const entry of registry.entries()) {
      if (entry?.fiber !== undefined && names.has(entry?.options?.name)) return entry.options.id;
    }
    return undefined;
  };
  /** The provider, this plugin's Loader row id, and the descriptor the Host reports for it. */
  const lookup = () => {
    const service = settings();
    const id = rowId();
    const found = service === undefined || id === undefined
      ? undefined
      : service.describe({ redactSecrets: true }).find(item => String(item.ns) === String(id));
    return { service, id, found };
  };
  const read = () => {
    const { service, id, found } = lookup();
    const value = found?.value ?? fallback();
    return {
      /** The settings namespace a write addresses; null means no form is served. */
      entryId: found === undefined ? null : String(found.ns),
      /** The Loader row this plugin resolved to, whether or not a form exists for it. */
      rowId: id ?? null,
      revision: found?.revision ?? null,
      /** A form exists and the provider accepts writes. */
      editable: found !== undefined && service?.writable !== false,
      /** Whether the Host accepts writes at all, independent of this entry. */
      writable: service?.writable !== false,
      /** How a written value takes effect; a volatile field applies without a remount. */
      applies: found?.applies ?? 'restart',
      reason: found === undefined ? unavailableReason(service, id) : undefined,
      builtins: BUILTIN_PRESETS.map(({ id: presetId, files, serversPaths, format, dialect, interpolation }) =>
        ({ id: presetId, files, serversPaths, format, dialect, interpolation })),
      config: {
        enabledBuiltins: value.enabledBuiltins ?? [],
        presets: value.presets ?? [],
        trustMode: value.trustMode,
        trustedWorkspaces: value.trustedWorkspaces ?? [],
        workspaceAllowances: value.workspaceAllowances ?? [],
        conflictPolicy: value.conflictPolicy,
      },
    };
  };
  return {
    async readConfig() { return read(); },
    async writeConfig(patch) {
      const { service, found } = lookup();
      if (!service || found === undefined) {
        const failure = new Error(service
          ? '这个插件条目没有可编辑的设置表单'
          : '这个插件没有可编辑的设置条目（settings 服务不可用）');
        failure.code = 'SETTINGS_UNAVAILABLE';
        failure.reason = unavailableReason(service, rowId());
        throw failure;
      }
      const next = {};
      for (const key of EDITABLE) if (patch?.[key] !== undefined) next[key] = patch[key];
      if (Object.keys(next).length === 0) throw new Error('没有要保存的改动');
      resolvePresets({ ...fallback(), ...next }); // Reject a config that would break activation.
      await service.update(found.ns, next, found.revision);
      await onChange?.();
      return read();
    },
    /**
     * Rewrite one workspace's allowance entry and leave every other entry untouched.
     *
     * Read-modify-write over the descriptor: the panel adds one server or one tool at a time
     * and the tool gate does the same when the user chooses "always allow", so neither can be
     * asked to restate the whole document. An entry that ends up empty is deleted rather than
     * kept as a no-op row.
     * @param workspace - the workspace path this entry names.
     * @param mutate - receives the current entry and returns the next one.
     * @returns the fresh read view, the same shape {@link readConfig} returns.
     */
    async updateAllowance(workspace, mutate) {
      const { service, found } = lookup();
      if (!service || found === undefined) {
        const failure = new Error('这个插件没有可编辑的设置条目（settings 服务不可用）');
        failure.code = 'SETTINGS_UNAVAILABLE';
        throw failure;
      }
      const view = read();
      const entries = view.config.workspaceAllowances ?? [];
      const existing = entries.find(entry => sameWorkspace(entry.workspace, workspace));
      const current = existing ?? { workspace, allowMcp: [], allowTools: [] };
      const proposed = mutate({ workspace: current.workspace, allowMcp: [...current.allowMcp], allowTools: [...current.allowTools] });
      const rest = entries.filter(entry => !sameWorkspace(entry.workspace, workspace));
      const next = proposed !== undefined && (proposed.allowMcp.length > 0 || proposed.allowTools.length > 0)
        ? [...rest, proposed]
        : rest;
      await service.update(found.ns, { workspaceAllowances: next }, found.revision);
      await onChange?.();
      return read();
    },
  };
}
