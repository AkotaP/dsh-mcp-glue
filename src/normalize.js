import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { COMMON_FIELDS, select } from './presets.js';

export class DeclarationError extends Error {
  /**
   * @param code - the stable code a caller may switch on.
   * @param detail - the field, key, variable or value that failed, phrased for the declaration's
   *   author: a bare code leaves a hand edit with no idea which line to change.
   */
  constructor(code, detail) {
    super(code);
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, detail) => { throw new DeclarationError(code, detail); };
export const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = v => typeof v === 'string' && v.length > 0;
const list = (v, code, field) => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) fail(code, field === undefined ? '值必须是字符串数组' : `${field} 必须是字符串数组`);
  return v;
};

export function interpolate(text, context, mode = 'standard') {
  if (typeof text !== 'string') fail('INVALID_STRING', `期望字符串，收到 ${typeof text}`);
  if (mode === 'none') return text;
  const getEnv = (key, fallback) => {
    if (Object.hasOwn(context.env, key) && context.env[key] !== undefined) return context.env[key];
    if (fallback !== undefined) return fallback;
    fail('MISSING_ENVIRONMENT_VARIABLE', `变量 ${key} 没有值`);
  };
  const expand = token => {
    if (token === 'workspaceFolder') return context.cwd;
    if (token === 'workspaceFolderBasename') return path.basename(context.cwd);
    if (token === 'userHome') return context.home ?? os.homedir();
    if (token === 'pathSeparator' || token === '/') return path.sep;
    if (token === 'configDir') return context.configDir;
    if (token.startsWith('input:')) {
      const id = token.slice(6);
      if (!Object.hasOwn(context.inputs ?? {}, id)) fail('MISSING_INPUT_VALUE', `input:${id} 没有配置值`);
      return context.inputs[id];
    }
    const raw = token.startsWith('env:') ? token.slice(4) : token;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/s.exec(raw);
    if (!match) fail('UNSUPPORTED_VARIABLE', `不认识的变量写法 \${${raw}}`);
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
  if (!isRecord(v)) fail(code, '必须是一个对象');
  const result = {};
  for (const [key, value] of Object.entries(v)) {
    if (typeof value === 'string') Object.defineProperty(result, key, { value: expand(value), enumerable: true, writable: true, configurable: true });
    else if (numbers && typeof value === 'number' && Number.isFinite(value)) Object.defineProperty(result, key, { value: String(value), enumerable: true, writable: true, configurable: true });
    else fail(code, `${key} 的值必须是字符串${numbers ? '或数字' : ''}`);
  }
  return result;
}
const positive = (v, code, field) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 2147483647) fail(code, `${field} 必须是正的有限数，收到 ${String(v)}`);
  return v;
};

/**
 * Credential-record address for an OAuth server that does not name one.
 *
 * The native credential store keys a grant by this string, so it has to stay stable across
 * reloads and unique across endpoints: the server name alone would let two workspaces that
 * declare the same name share (and overwrite) one grant, while the endpoint digest keeps them
 * apart and makes a moved endpoint ask for authorization again instead of reusing a stale grant.
 */
export function derivedCredentialKey(serverName, url) {
  return `mcp-client/workspace-mcp/${serverName}-${createHash('sha256').update(url).digest('hex').slice(0, 8)}`;
}

const OAUTH_KEYS = new Set(['credentialKey', 'clientId', 'scope', 'requestTimeoutMs', 'authorizationTimeoutMs']);

/**
 * Normalize the `oauth` field of an HTTP server.
 *
 * `true` is the shorthand for "browser authorization with defaults": dynamic client
 * registration, no requested scope, and a derived credential key. An object narrows that with
 * the native options. Only Streamable HTTP can carry a grant, and a declared Authorization
 * header means the caller already chose header authentication, so the two never combine.
 */
function oauthOf(raw, serverName, url, headers) {
  if (raw === undefined || raw === false) return undefined;
  const value = raw === true ? {} : raw;
  if (!isRecord(value)) fail('INVALID_OAUTH', 'oauth 必须是 true 或一个对象');
  for (const key of Object.keys(value)) if (!OAUTH_KEYS.has(key)) fail('INVALID_OAUTH', `oauth 不支持字段 ${key}；可用 ${[...OAUTH_KEYS].join(' / ')}`);
  if (Object.keys(headers ?? {}).some(name => name.toLowerCase() === 'authorization')) {
    fail('CONFLICTING_AUTH_HEADERS', '声明了 oauth 就不能同时用 Authorization 头（bearer_token_env_var 也算）：浏览器授权会自己换取令牌');
  }
  const credentialKey = value.credentialKey ?? derivedCredentialKey(serverName, url);
  if (typeof credentialKey !== 'string' || !/^mcp-client\/\S+$/.test(credentialKey)) fail('INVALID_OAUTH', 'oauth.credentialKey 必须是 "mcp-client/..." 形式的凭据地址');
  const budget = (amount, name) => {
    if (amount === undefined) return undefined;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 2147483647) fail('INVALID_OAUTH', `oauth.${name} 必须是正的有限数`);
    return amount;
  };
  const oauth = { credentialKey };
  if (value.clientId !== undefined) {
    if (!string(value.clientId)) fail('INVALID_OAUTH', 'oauth.clientId 必须是非空字符串');
    oauth.clientId = value.clientId;
  }
  if (value.scope !== undefined) {
    if (typeof value.scope !== 'string') fail('INVALID_OAUTH', 'oauth.scope 必须是字符串');
    oauth.scope = value.scope;
  }
  const requestTimeoutMs = budget(value.requestTimeoutMs, 'requestTimeoutMs');
  if (requestTimeoutMs !== undefined) oauth.requestTimeoutMs = requestTimeoutMs;
  const authorizationTimeoutMs = budget(value.authorizationTimeoutMs, 'authorizationTimeoutMs');
  if (authorizationTimeoutMs !== undefined) oauth.authorizationTimeoutMs = authorizationTimeoutMs;
  return oauth;
}

/** Convert supported semantics only. Unsupported security/auth fields fail closed. */
export function normalizeServer(rawName, raw, preset, context, fileEnv = {}) {
  if (!isRecord(raw)) fail('INVALID_SERVER', `${rawName} 的条目必须是一个对象`);
  const fields = { ...COMMON_FIELDS, ...preset.fields };
  const get = key => fields[key] === undefined || (key === 'transport' && fields[key] === '')
    ? undefined : select(raw, fields[key]);
  for (const key of ['enabled', 'disabled']) if (get(key) !== undefined && typeof get(key) !== 'boolean') fail('INVALID_ENABLED_FLAG', `${fields[key]} 必须是布尔值`);
  if (get('enabled') === false || get('disabled') === true) return undefined;
  // These fields change authentication, execution location, or security policy. `oauth` is
  // supported below through the native host's own authorization owner, so it is not refused here;
  // the shapes it does accept are spelled out in `oauthOf`.
  for (const key of ['auth', 'authProviderType', 'headersHelper', 'http_headers_helper', 'experimental_environment', 'default_tools_approval_mode', 'tools']) {
    if (Object.hasOwn(raw, key)) fail('UNSUPPORTED_AUTH_OR_POLICY', `字段 ${key} 会改变鉴权、执行位置或安全策略，插件不会静默降级，请手动移除或改用受支持的写法`);
  }
  if (raw.sandboxEnabled === true || Object.hasOwn(raw, 'sandbox')) fail('UNSUPPORTED_SANDBOX', '服务器级 sandbox 策略暂不支持');
  const serverName = normalizeServerName(rawName);
  const expand = value => interpolate(value, context, preset.interpolation ?? 'standard');
  let transport = get('transport');
  if (transport !== undefined && typeof transport !== 'string') fail('INVALID_TRANSPORT', `type 必须是字符串，收到 ${typeof transport}`);
  if (transport === 'http') transport = 'streamable-http';
  if (!transport) {
    if (get('command') !== undefined) transport = 'stdio';
    else if (get('url') !== undefined) transport = 'streamable-http';
    else if (preset.dialect === 'gemini' && raw.url !== undefined) fail('UNSUPPORTED_SSE', 'URL 形式的 SSE 暂不支持，请改用 streamable-http');
  }
  if (transport !== 'stdio' && transport !== 'streamable-http') fail(transport === 'sse' ? 'UNSUPPORTED_SSE' : 'UNSUPPORTED_TRANSPORT', `不支持的调用方式：${String(transport)}`);
  const config = { serverName, transport, failOnStartupError: true };
  if (get('timeoutMs') !== undefined) config.toolCallTimeoutMs = positive(get('timeoutMs'), 'INVALID_TIMEOUT', fields.timeoutMs);
  else if (get('timeoutSeconds') !== undefined) config.toolCallTimeoutMs = positive(get('timeoutSeconds') * 1000, 'INVALID_TIMEOUT', fields.timeoutSeconds);
  else if (preset.dialect === 'gemini') config.toolCallTimeoutMs = 600000;
  if (raw.oauth !== undefined && raw.oauth !== false && transport !== 'streamable-http') {
    fail('INVALID_OAUTH', 'oauth 只适用于 streamable-http 远程端点；stdio 本地进程没有授权服务器');
  }
  if (transport === 'stdio') {
    if (!string(get('command')) || get('url') !== undefined || (preset.dialect === 'gemini' && raw.url !== undefined)) fail('AMBIGUOUS_TRANSPORT', 'command 与 url 只能声明一个：它们分别代表本地进程和远程端点');
    config.command = expand(get('command'));
    if (!config.command || config.command.includes('\0')) fail('INVALID_COMMAND', 'command 为空或含 NUL 字节');
    config.args = (list(get('args'), 'INVALID_ARGS', 'args') ?? []).map(expand);
    config.cwd = get('cwd') === undefined ? context.cwd : path.resolve(context.cwd, expand(get('cwd')));
    if (config.command.startsWith('.') || config.command.includes('/') || config.command.includes('\\')) config.command = path.resolve(config.cwd, config.command);
    if (config.args.some(arg => arg.includes('\0')) || config.cwd.includes('\0')) fail('INVALID_PROCESS_ARGUMENT', 'args 或 cwd 含 NUL 字节');
    config.env = { ...fileEnv };
    const vars = get('envVars');
    if (vars !== undefined) {
      if (!Array.isArray(vars)) fail('INVALID_ENV_VARS', 'env_vars 必须是数组');
      for (const item of vars) {
        const key = typeof item === 'string' ? item : isRecord(item) && (item.source === undefined || item.source === 'local') ? item.name : undefined;
        if (!string(key)) fail('UNSUPPORTED_REMOTE_ENV', `env_vars 只支持本地变量；收到 ${JSON.stringify(item)}`);
        if (context.env[key] === undefined) fail('MISSING_ENVIRONMENT_VARIABLE', `变量 ${key} 没有值（env_vars 引用了它）`);
        Object.defineProperty(config.env, key, { value: context.env[key], enumerable: true, writable: true, configurable: true });
      }
    }
    config.env = { ...config.env, ...dictionary(get('env'), expand, 'INVALID_ENV', { numbers: true }) };
    if (Object.values(config.env).some(v => v.includes('\0')) || Object.keys(config.env).some(k => k.includes('=') || k.includes('\0'))) fail('INVALID_ENV', 'env 的键不能含 = 或 NUL，值不能含 NUL');
  } else {
    if (get('command') !== undefined || get('env') !== undefined || get('envFile') !== undefined || get('envVars') !== undefined) fail('AMBIGUOUS_TRANSPORT', '远程服务器不能同时声明 command / env / envFile / envVars');
    if (!string(get('url'))) fail('INVALID_URL', '远程服务器缺少 url');
    config.url = expand(get('url'));
    let parsed;
    try { parsed = new URL(config.url); } catch { fail('INVALID_URL', `url 无法解析：${config.url}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('UNSUPPORTED_URL', '只支持 http/https，且 url 不能内嵌用户名或密码');
    config.headers = dictionary(get('headers'), expand, 'INVALID_HEADERS');
    const envHeaders = dictionary(get('envHeaders'), v => v, 'INVALID_ENV_HEADERS');
    for (const [header, key] of Object.entries(envHeaders)) {
      if (context.env[key] === undefined) fail('MISSING_ENVIRONMENT_VARIABLE', `变量 ${key} 没有值（env_http_headers 的 ${header} 引用了它）`);
      Object.defineProperty(config.headers, header, { value: context.env[key], enumerable: true, configurable: true, writable: true });
    }
    if (get('bearerTokenEnv') !== undefined) {
      const key = get('bearerTokenEnv');
      if (!string(key)) fail('MISSING_ENVIRONMENT_VARIABLE', 'bearer_token_env_var 必须是一个环境变量名');
      if (context.env[key] === undefined) fail('MISSING_ENVIRONMENT_VARIABLE', `变量 ${key} 没有值（bearer_token_env_var 引用了它）`);
      if (Object.keys(config.headers).some(k => k.toLowerCase() === 'authorization')) fail('CONFLICTING_AUTH_HEADERS', 'headers 里已经有 Authorization，不能再声明 bearer_token_env_var');
      config.headers.Authorization = `Bearer ${context.env[key]}`;
    }
    const invalidHeader = Object.entries(config.headers).find(([k, v]) => !/^[!#$%&'*+.^`|~0-9A-Za-z-]+$/.test(k) || /[\r\n\0]/.test(v));
    if (invalidHeader !== undefined) fail('INVALID_HEADERS', `头 ${invalidHeader[0]} 的名称或值不合法`);
    const oauth = oauthOf(raw.oauth, serverName, config.url, config.headers);
    if (oauth !== undefined) config.oauth = oauth;
  }
  const includeTools = list(preset.dialect === 'codex' ? raw.enabled_tools : raw.includeTools, 'INVALID_TOOL_FILTER', preset.dialect === 'codex' ? 'enabled_tools' : 'includeTools');
  const excludeTools = list(preset.dialect === 'codex' ? raw.disabled_tools : raw.excludeTools, 'INVALID_TOOL_FILTER', preset.dialect === 'codex' ? 'disabled_tools' : 'excludeTools');
  if (raw.required !== undefined && typeof raw.required !== 'boolean') fail('INVALID_REQUIRED', 'required 必须是布尔值');
  // Plugin-specific, not part of any dialect: the new Host can list a server's tools for the
  // agent to load instead of registering all of them up front, which is what keeps a workspace
  // with many servers from spending its whole prompt budget on tool schemas.
  if (raw.toolLoading !== undefined) {
    if (raw.toolLoading !== 'eager' && raw.toolLoading !== 'on-demand') fail('INVALID_TOOL_LOADING', 'toolLoading 只能是 eager 或 on-demand');
    config.toolLoading = raw.toolLoading;
  }
  if (raw.catalogDescriptionMaxLength !== undefined) {
    const value = raw.catalogDescriptionMaxLength;
    if (!Number.isSafeInteger(value) || value < 4 || value > 4096) fail('INVALID_CATALOG_DESCRIPTION', 'catalogDescriptionMaxLength 必须是 4 到 4096 之间的整数');
    config.catalogDescriptionMaxLength = value;
  }
  const startupTimeoutMs = raw.startup_timeout_sec !== undefined ? positive(raw.startup_timeout_sec * 1000, 'INVALID_TIMEOUT', 'startup_timeout_sec') : undefined;
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
    credentialRefs: [...credentialRefs].sort(), inputRefs: [...inputRefs].sort(),
    // Browser authorization is a new kind of access this declaration asks for, so the panel
    // shows it before anything starts rather than after a grant appears in the credential store.
    oauth: config.oauth !== undefined, toolLoading: config.toolLoading ?? null };
  return { config, includeTools, excludeTools, startupTimeoutMs, required: raw.required === true, approval };
}
export function normalizeServerName(name) {
  // Native names use an unescaped "__" delimiter. Prefix guards and clean-case
  // tool identities would overlap for foo/foo_ or foo/foo__bar; hash those IDs.
  if (/^[A-Za-z0-9_-]{1,32}$/.test(name) && !name.includes('__') && !name.endsWith('_')) return name;
  const base = name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 19).replace(/_+$/, '');
  return `${base}_${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
}
/** Raw name of the bridge's own `on-demand` loader inside a server's tool namespace. */
export const LOADER_TOOL = 'load_tools';
/** The loader's public name, which a project's tool filter must never be able to disable. */
export function loaderToolName(serverName) { return publicToolName(serverName, LOADER_TOOL); }
/** Match the verified native dsh-mcp-client v0.2.0-rc.2 naming invariant. */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (joined === normalized && normalized.length <= 64) return normalized;
  return `${normalized.slice(0, 51)}_${createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)}`;
}
