/** Declarative presets: no eval, dynamic imports, or project-provided JavaScript. */
export const COMMON_FIELDS = Object.freeze({
  transport: 'type', command: 'command', args: 'args', env: 'env', cwd: 'cwd',
  url: 'url', headers: 'headers', enabled: 'enabled', disabled: 'disabled',
  envFile: 'envFile', envVars: 'env_vars', envHeaders: 'env_http_headers',
  bearerTokenEnv: 'bearer_token_env_var', timeoutSeconds: 'tool_timeout_sec',
});
export const BUILTIN_PRESETS = Object.freeze([
  { id: 'root', files: ['.mcp.json'], format: 'jsonc', serversPaths: ['mcpServers', 'servers'], dialect: 'standard', fields: { timeoutMs: 'timeout' } },
  { id: 'vscode', files: ['.vscode/mcp.json'], format: 'jsonc', serversPaths: ['servers'], dialect: 'standard' },
  { id: 'codex', files: ['.codex/config.toml'], format: 'toml', serversPaths: ['mcp_servers'], dialect: 'codex', interpolation: 'none', fields: { headers: 'http_headers' } },
  { id: 'cursor', files: ['.cursor/mcp.json'], format: 'jsonc', serversPaths: ['mcpServers'], dialect: 'standard' },
  { id: 'gemini', files: ['.gemini/settings.json'], format: 'jsonc', serversPaths: ['mcpServers'], dialect: 'gemini', interpolation: 'shell', fields: { url: 'httpUrl', timeoutMs: 'timeout' } },
].map(p => Object.freeze(p)));

export function resolvePresets(config = {}) {
  const enabled = config.enabledBuiltins ?? BUILTIN_PRESETS.map(p => p.id);
  const catalog = new Map(BUILTIN_PRESETS.map(p => [p.id, p]));
  const custom = config.presets ?? [];
  const seen = new Set();
  for (const item of custom) {
    if (!item.id || seen.has(item.id)) throw new Error('preset id must be unique');
    seen.add(item.id);
    const parent = item.extends ? catalog.get(item.extends) : undefined;
    if (item.extends && !parent) throw new Error('unknown parent preset');
    const inherited = parent ?? catalog.get(item.id);
    const preset = { format: 'jsonc', dialect: 'standard', interpolation: 'standard', ...inherited, ...item,
      fields: { ...inherited?.fields, ...item.fields } };
    if (!Array.isArray(preset.files) || !preset.files.length || preset.files.some(f => typeof f !== 'string' || !f)) throw new Error('preset files must be nonempty');
    if (!Array.isArray(preset.serversPaths) || !preset.serversPaths.length || preset.serversPaths.some(p => typeof p !== 'string')) throw new Error('preset serversPaths required');
    if (!['json', 'jsonc', 'toml', 'yaml'].includes(preset.format)) throw new Error('unsupported preset format');
    if (!['standard', 'codex', 'gemini'].includes(preset.dialect)) throw new Error('unsupported preset dialect');
    if (!['standard', 'shell', 'none'].includes(preset.interpolation ?? 'standard')) throw new Error('unsupported interpolation');
    for (const [key, value] of Object.entries(preset.fields)) {
      if (![...Object.keys(COMMON_FIELDS), 'timeoutMs'].includes(key) || typeof value !== 'string') throw new Error('invalid field mapping');
    }
    catalog.set(item.id, preset);
  }
  for (const id of enabled) if (!BUILTIN_PRESETS.some(p => p.id === id)) throw new Error('unknown builtin preset');
  return [...new Set([...enabled, ...custom.filter(p => !BUILTIN_PRESETS.some(b => b.id === p.id)).map(p => p.id)])]
    .map(id => catalog.get(id)).filter(p => p.enabled !== false);
}

/**
 * Dot paths or RFC6901 JSON pointers. Empty string selects the root. Own properties only.
 *
 * The key path is shared with the declaration editor so that a writer addresses exactly what a
 * reader read: an editor resolving `connection.url` differently from `select` would silently
 * rewrite the wrong field.
 */
export function pathOfSelector(selector) {
  return selector === '' ? [] : selector.startsWith('/')
    ? selector.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~')) : selector.split('.');
}
/** Dot paths or RFC6901 JSON pointers. Empty string selects the root. Own properties only. */
export function select(value, selector) {
  const keys = pathOfSelector(selector);
  for (const key of keys) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
