import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { COMMON_FIELDS, select } from './presets.js';

export class DeclarationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new DeclarationError(code); };
export const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = v => typeof v === 'string' && v.length > 0;
const list = (v, code) => { if (v === undefined) return undefined; if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) fail(code); return v; };

export function interpolate(text, context, mode = 'standard') {
  if (typeof text !== 'string') fail('INVALID_STRING');
  if (mode === 'none') return text;
  const getEnv = (key, fallback) => {
    if (Object.hasOwn(context.env, key) && context.env[key] !== undefined) return context.env[key];
    if (fallback !== undefined) return fallback;
    fail('MISSING_ENVIRONMENT_VARIABLE');
  };
  const expand = token => {
    if (token === 'workspaceFolder') return context.cwd;
    if (token === 'workspaceFolderBasename') return path.basename(context.cwd);
    if (token === 'userHome') return context.home ?? os.homedir();
    if (token === 'pathSeparator' || token === '/') return path.sep;
    if (token === 'configDir') return context.configDir;
    if (token.startsWith('input:')) {
      const id = token.slice(6);
      if (!Object.hasOwn(context.inputs ?? {}, id)) fail('MISSING_INPUT_VALUE');
      return context.inputs[id];
    }
    const raw = token.startsWith('env:') ? token.slice(4) : token;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/s.exec(raw);
    if (!match) fail('UNSUPPORTED_VARIABLE');
    return getEnv(match[1], match[2]);
  };
  // One pass: a secret containing "$..." is data, never recursively expanded.
  const matcher = mode === 'shell'
    ? /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/g
    : /\$\{([^}]+)\}/g;
  return text.replace(matcher, (_match, braced, dollar, percent) => expand(braced ?? dollar ?? percent));
}
function dictionary(v, expand, code, { numbers = false } = {}) {
  if (v === undefined) return {};
  if (!isRecord(v)) fail(code);
  const result = {};
  for (const [key, value] of Object.entries(v)) {
    if (typeof value === 'string') Object.defineProperty(result, key, { value: expand(value), enumerable: true, writable: true, configurable: true });
    else if (numbers && typeof value === 'number' && Number.isFinite(value)) Object.defineProperty(result, key, { value: String(value), enumerable: true, writable: true, configurable: true });
    else fail(code);
  }
  return result;
}
const positive = (v, code) => { if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 2147483647) fail(code); return v; };

/** Convert supported semantics only. Unsupported security/auth fields fail closed. */
export function normalizeServer(rawName, raw, preset, context, fileEnv = {}) {
  if (!isRecord(raw)) fail('INVALID_SERVER');
  const fields = { ...COMMON_FIELDS, ...preset.fields };
  const get = key => fields[key] === undefined || (key === 'transport' && fields[key] === '')
    ? undefined : select(raw, fields[key]);
  for (const key of ['enabled', 'disabled']) if (get(key) !== undefined && typeof get(key) !== 'boolean') fail('INVALID_ENABLED_FLAG');
  if (get('enabled') === false || get('disabled') === true) return undefined;
  // These fields change authentication, execution location, or security policy.
  for (const key of ['oauth', 'auth', 'authProviderType', 'headersHelper', 'http_headers_helper', 'experimental_environment', 'default_tools_approval_mode', 'tools']) {
    if (Object.hasOwn(raw, key)) fail('UNSUPPORTED_AUTH_OR_POLICY');
  }
  if (raw.sandboxEnabled === true || Object.hasOwn(raw, 'sandbox')) fail('UNSUPPORTED_SANDBOX');
  const serverName = normalizeServerName(rawName);
  const expand = value => interpolate(value, context, preset.interpolation ?? 'standard');
  let transport = get('transport');
  if (transport !== undefined && typeof transport !== 'string') fail('INVALID_TRANSPORT');
  if (transport === 'http') transport = 'streamable-http';
  if (!transport) {
    if (get('command') !== undefined) transport = 'stdio';
    else if (get('url') !== undefined) transport = 'streamable-http';
    else if (preset.dialect === 'gemini' && raw.url !== undefined) fail('UNSUPPORTED_SSE');
  }
  if (transport !== 'stdio' && transport !== 'streamable-http') fail(transport === 'sse' ? 'UNSUPPORTED_SSE' : 'UNSUPPORTED_TRANSPORT');
  const config = { serverName, transport, failOnStartupError: true };
  if (get('timeoutMs') !== undefined) config.toolCallTimeoutMs = positive(get('timeoutMs'), 'INVALID_TIMEOUT');
  else if (get('timeoutSeconds') !== undefined) config.toolCallTimeoutMs = positive(get('timeoutSeconds') * 1000, 'INVALID_TIMEOUT');
  else if (preset.dialect === 'gemini') config.toolCallTimeoutMs = 600000;
  if (transport === 'stdio') {
    if (!string(get('command')) || get('url') !== undefined || (preset.dialect === 'gemini' && raw.url !== undefined)) fail('AMBIGUOUS_TRANSPORT');
    config.command = expand(get('command'));
    if (!config.command || config.command.includes('\0')) fail('INVALID_COMMAND');
    config.args = (list(get('args'), 'INVALID_ARGS') ?? []).map(expand);
    config.cwd = get('cwd') === undefined ? context.cwd : path.resolve(context.cwd, expand(get('cwd')));
    if (config.command.startsWith('.') || config.command.includes('/') || config.command.includes('\\')) config.command = path.resolve(config.cwd, config.command);
    if (config.args.some(arg => arg.includes('\0')) || config.cwd.includes('\0')) fail('INVALID_PROCESS_ARGUMENT');
    config.env = { ...fileEnv };
    const vars = get('envVars');
    if (vars !== undefined) {
      if (!Array.isArray(vars)) fail('INVALID_ENV_VARS');
      for (const item of vars) {
        const key = typeof item === 'string' ? item : isRecord(item) && (item.source === undefined || item.source === 'local') ? item.name : undefined;
        if (!string(key)) fail('UNSUPPORTED_REMOTE_ENV');
        if (context.env[key] === undefined) fail('MISSING_ENVIRONMENT_VARIABLE');
        Object.defineProperty(config.env, key, { value: context.env[key], enumerable: true, writable: true, configurable: true });
      }
    }
    config.env = { ...config.env, ...dictionary(get('env'), expand, 'INVALID_ENV', { numbers: true }) };
    if (Object.values(config.env).some(v => v.includes('\0')) || Object.keys(config.env).some(k => k.includes('=') || k.includes('\0'))) fail('INVALID_ENV');
  } else {
    if (get('command') !== undefined || get('env') !== undefined || get('envFile') !== undefined || get('envVars') !== undefined) fail('AMBIGUOUS_TRANSPORT');
    if (!string(get('url'))) fail('INVALID_URL');
    config.url = expand(get('url'));
    let parsed;
    try { parsed = new URL(config.url); } catch { fail('INVALID_URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('UNSUPPORTED_URL');
    config.headers = dictionary(get('headers'), expand, 'INVALID_HEADERS');
    const envHeaders = dictionary(get('envHeaders'), v => v, 'INVALID_ENV_HEADERS');
    for (const [header, key] of Object.entries(envHeaders)) {
      if (context.env[key] === undefined) fail('MISSING_ENVIRONMENT_VARIABLE');
      Object.defineProperty(config.headers, header, { value: context.env[key], enumerable: true, configurable: true, writable: true });
    }
    if (get('bearerTokenEnv') !== undefined) {
      const key = get('bearerTokenEnv');
      if (!string(key) || context.env[key] === undefined) fail('MISSING_ENVIRONMENT_VARIABLE');
      if (Object.keys(config.headers).some(k => k.toLowerCase() === 'authorization')) fail('CONFLICTING_AUTH_HEADERS');
      config.headers.Authorization = `Bearer ${context.env[key]}`;
    }
    if (Object.entries(config.headers).some(([k, v]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || /[\r\n\0]/.test(v))) fail('INVALID_HEADERS');
  }
  const includeTools = list(preset.dialect === 'codex' ? raw.enabled_tools : raw.includeTools, 'INVALID_TOOL_FILTER');
  const excludeTools = list(preset.dialect === 'codex' ? raw.disabled_tools : raw.excludeTools, 'INVALID_TOOL_FILTER');
  if (raw.required !== undefined && typeof raw.required !== 'boolean') fail('INVALID_REQUIRED');
  const startupTimeoutMs = raw.startup_timeout_sec !== undefined ? positive(raw.startup_timeout_sec * 1000, 'INVALID_TIMEOUT') : undefined;
  const credentialRefs = new Set();
  const inputRefs = new Set();
  const collect = value => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) credentialRefs.add(match[1]);
      for (const match of value.matchAll(/\$\{input:([^}]+)\}/g)) inputRefs.add(match[1]);
      if (preset.interpolation === 'shell') for (const match of value.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/g)) credentialRefs.add(match[1] ?? match[2]);
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (isRecord(value)) Object.values(value).forEach(collect);
  };
  if (preset.interpolation !== 'none') for (const key of Object.keys(fields)) collect(get(key));
  for (const item of get('envVars') ?? []) credentialRefs.add(typeof item === 'string' ? item : item.name);
  for (const key of Object.values(get('envHeaders') ?? {})) credentialRefs.add(key);
  if (get('bearerTokenEnv')) credentialRefs.add(get('bearerTokenEnv'));
  for (const name of ['workspaceFolder', 'workspaceFolderBasename', 'userHome', 'pathSeparator', 'configDir']) credentialRefs.delete(name);
  const originalUrl = get('url');
  // Never put expanded secrets or URL query/path tokens in an approval summary.
  const endpoint = typeof originalUrl === 'string' ? originalUrl.match(/^https?:\/\/[^/?#]+/i)?.[0] ?? '[templated endpoint; inspect declaration]' : undefined;
  const approval = { command: get('command'), argumentCount: config.args?.length,
    cwd: get('cwd') ?? '[workspace]', endpoint, environmentKeys: Object.keys(config.env ?? {}),
    credentialRefs: [...credentialRefs].sort(), inputRefs: [...inputRefs].sort() };
  return { config, includeTools, excludeTools, startupTimeoutMs, required: raw.required === true, approval };
}
export function normalizeServerName(name) {
  // Native names use an unescaped "__" delimiter. Prefix guards and clean-case
  // tool identities would overlap for foo/foo_ or foo/foo__bar; hash those IDs.
  if (/^[A-Za-z0-9_-]{1,32}$/.test(name) && !name.includes('__') && !name.endsWith('_')) return name;
  const base = name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 19).replace(/_+$/, '');
  return `${base}_${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
}
/** Match the verified native dsh-mcp-client v0.2.0-rc.2 naming invariant. */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (joined === normalized && normalized.length <= 64) return normalized;
  return `${normalized.slice(0, 51)}_${createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)}`;
}
