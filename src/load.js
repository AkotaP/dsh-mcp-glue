import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import TOML from '@iarna/toml';
import { parse as parseJsonc, printParseErrorCode, visit } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import { COMMON_FIELDS, resolvePresets, select } from './presets.js';
import { DeclarationError, interpolate, isRecord, normalizeServer } from './normalize.js';

/** 1-based line and column of a character offset, so a syntax error names the place to fix. */
function lineColumn(text, offset) {
  let line = 1, column = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') { line += 1; column = 1; } else column += 1;
  }
  return { line, column };
}

export function parseDeclaration(text, format) {
  text = text.replace(/^\uFEFF/, '');
  if (format === 'json' || format === 'jsonc') {
    // Reject duplicate keys rather than silently choosing a different credential/command.
    const objects = [];
    let duplicate;
    visit(text, {
      onObjectBegin: () => objects.push(new Set()),
      onObjectProperty: key => {
        if (objects.at(-1).has(key) && duplicate === undefined) duplicate = key;
        objects.at(-1).add(key);
      },
      onObjectEnd: () => objects.pop(),
    }, { allowTrailingComma: format === 'jsonc', disallowComments: format === 'json' });
    const errors = [];
    const value = parseJsonc(text, errors, { allowTrailingComma: format === 'jsonc', disallowComments: format === 'json' });
    if (errors.length) {
      const at = lineColumn(text, errors[0].offset);
      throw new DeclarationError('INVALID_DECLARATION', `${format === 'json' ? 'JSON' : 'JSONC'} 语法错误：第 ${at.line} 行第 ${at.column} 列（${printParseErrorCode(errors[0].error)}）`);
    }
    if (duplicate !== undefined) {
      throw new DeclarationError('INVALID_DECLARATION', `重复的键 "${duplicate}"：解析器只保留一个，无法判断你想用哪个值`);
    }
    return value;
  }
  if (format === 'toml') {
    try { return TOML.parse(text); }
    catch (error) {
      const at = typeof error?.line === 'number' ? `：第 ${error.line} 行第 ${error.col} 列` : '';
      const why = typeof error?.message === 'string' ? `（${error.message}）` : '';
      throw new DeclarationError('INVALID_DECLARATION', `TOML 语法错误${at}${why}`);
    }
  }
  if (format === 'yaml') {
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length) {
      const start = doc.errors[0].linePos?.start;
      const at = start === undefined ? '' : `第 ${start.line} 行第 ${start.col} 列：`;
      throw new DeclarationError('INVALID_DECLARATION', `YAML 语法错误：${at}${doc.errors[0].message}`);
    }
    try { return doc.toJS({ maxAliasCount: 50 }); }
    catch (error) { throw new DeclarationError('INVALID_DECLARATION', `YAML 结构无法转换：${error?.message ?? error}`); }
  }
  throw new DeclarationError('UNSUPPORTED_FORMAT', `不支持的声明格式 ${String(format)}`);
}
export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value, (_key, val) => isRecord(val)
    ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val)).digest('hex');
}
/** A failure as the panel reports it: the code it switches on, plus the detail its author can act on. */
function safeError(error) {
  return error instanceof DeclarationError
    ? { code: error.code, ...(error.detail === undefined ? {} : { detail: error.detail }) }
    : { code: 'FILE_READ_FAILED' };
}
const diagnostic = (code, source, detail) => ({ code, ...source, ...(detail === undefined ? {} : { detail }) });

/** Command spellings Windows cannot spawn directly: `.cmd`/`.bat` files, and the Node package shims. */
const WINDOWS_SHIMS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'corepack']);
function windowsShim(command) {
  const base = path.basename(command).toLowerCase();
  const stem = base.replace(/\.(cmd|bat)$/, '');
  return base.endsWith('.cmd') || base.endsWith('.bat') || WINDOWS_SHIMS.has(stem) ? stem : undefined;
}
/**
 * Report (and optionally rewrite) a command Windows refuses to spawn as written.
 *
 * Node returns EINVAL for a `.cmd`/`.bat` without a shell, which is the most common reason a
 * hand-written declaration loads and then never connects. The default is a warning, because a
 * rewrite makes the declaration differ from the command that runs; `rewrite` is opt-in and never
 * touches the file.
 */
function windowsCommandFix(config, mode) {
  const original = config.command;
  const stem = windowsShim(original);
  if (stem === undefined) return undefined;
  if (mode === 'rewrite') {
    config.command = 'cmd';
    config.args = ['/d', '/s', '/c', original, ...config.args];
    return { code: 'WINDOWS_SHIM_REWRITTEN', detail: `command "${original}" 已按 Windows 规则改写为 cmd /d /s /c（声明文件未改动）` };
  }
  return { code: 'WINDOWS_SHIM_COMMAND', detail: `command "${original}" 在 Windows 上无法直接 spawn（EINVAL）：${stem} 是 shell 脚本。改用 node 入口，或写成 cmd /d /s /c ${stem} …` };
}

/** Read only explicit workspace files, never walk parents or inspect global client settings. */
export async function loadWorkspace(fs, cwd, config = {}, { signal, env = process.env, home, platform = process.platform } = {}) {
  const diagnostics = [], warnings = [], servers = new Map(), blockedNames = new Set();
  if (!cwd || !path.isAbsolute(cwd)) return { servers: [], diagnostics: [diagnostic('NO_ABSOLUTE_WORKSPACE', {})], warnings: [], fingerprint: 'no-workspace' };
  const root = await fs.resolve(cwd, { signal });
  const canonical = fs.processPath(root);
  // The native MCP stdio transport spawns on the Host, not in an SSH backend.
  if (fs.processPathFromHostPath(canonical) !== canonical) throw new DeclarationError('NONLOCAL_FILESYSTEM_UNSUPPORTED');
  const maxBytes = config.maxFileBytes ?? 1048576, maxServers = config.maxServers ?? 32;
  const presets = resolvePresets(config);
  let examined = 0;
  async function readInside(file) {
    const target = await fs.resolve(file, { cwd: canonical, signal });
    if (!fs.contains(root, target)) throw new DeclarationError('FILE_OUTSIDE_WORKSPACE');
    const info = await fs.stat(target, signal);
    if (!info) return undefined;
    if (info.type !== 'file') throw new DeclarationError('NOT_A_REGULAR_FILE');
    const bytes = await fs.readBytes(target, signal, maxBytes);
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), file: fs.processPath(target) };
  }
  for (const preset of presets) for (const file of preset.files) {
    signal?.throwIfAborted();
    const source = { preset: preset.id, file };
    try {
      // Preset paths must stay relative even when authored in trusted Host config.
      if (path.isAbsolute(file) || path.win32.isAbsolute(file) || /^[a-z][a-z\d+.-]*:/i.test(file)) throw new DeclarationError('INVALID_PRESET_PATH');
      const loaded = await readInside(file);
      if (!loaded) continue;
      const doc = parseDeclaration(loaded.text, preset.format);
      if (!isRecord(doc)) throw new DeclarationError('INVALID_ROOT', '声明文件的根必须是一个对象');
      const tables = preset.serversPaths.map(p => select(doc, p)).filter(v => v !== undefined);
      if (!tables.length) continue; // settings/config files may contain no MCP declarations.
      if (tables.length !== 1 || !isRecord(tables[0])) throw new DeclarationError('AMBIGUOUS_SERVER_TABLE', `服务器表必须恰好有一个：候选 ${preset.serversPaths.join(' / ')}`);
      if (Object.hasOwn(doc, 'sandbox')) throw new DeclarationError('UNSUPPORTED_SANDBOX', '文件级的 sandbox 策略暂不支持');
      for (const [rawName, raw] of Object.entries(tables[0])) {
        const serverSource = { ...source, server: rawName };
        try {
          if (++examined > maxServers) throw new DeclarationError('SERVER_LIMIT_EXCEEDED', `每个工作区最多检查 ${maxServers} 台服务器`);
          const context = { cwd: canonical, configDir: path.dirname(loaded.file), env, home, inputs: config.inputValues ?? {} };
          const fields = { ...COMMON_FIELDS, ...preset.fields };
          const isDisabled = select(raw, fields.enabled) === false || select(raw, fields.disabled) === true;
          let fileEnv = {};
          const envFile = select(raw, fields.envFile);
          if (!isDisabled && envFile !== undefined) {
            if (typeof envFile !== 'string') throw new DeclarationError('INVALID_ENV_FILE', 'envFile 必须是字符串');
            const envPath = interpolate(envFile, context, preset.interpolation ?? 'standard');
            const result = await readInside(envPath);
            if (!result) throw new DeclarationError('ENV_FILE_NOT_FOUND', `envFile 指向的文件不存在：${envFile}`);
            try { fileEnv = parseEnv(result.text); } catch { throw new DeclarationError('INVALID_ENV_FILE', `envFile 不是合法的 .env：${envFile}`); }
          }
          // Gemini's project allow/exclude lists affect this file's servers, not other presets.
          const allowed = select(doc, 'mcp.allowed'), excluded = select(doc, 'mcp.excluded');
          if (preset.dialect === 'gemini' && ((Array.isArray(allowed) && !allowed.includes(rawName)) || (Array.isArray(excluded) && excluded.includes(rawName)))) continue;
          const server = normalizeServer(rawName, raw, preset, context, fileEnv);
          if (!server) continue;
          const key = server.config.serverName;
          if (blockedNames.has(key)) continue;
          if (servers.has(key)) {
            if (fingerprint(servers.get(key).spec) === fingerprint(server)) continue;
            const conflict = config.conflictPolicy ?? 'error';
            diagnostics.push(diagnostic('DUPLICATE_SERVER', { ...serverSource, required: server.required || servers.get(key).spec.required }, `同名服务器已在 ${String(servers.get(key).source?.file)} 里声明`));
            if (conflict === 'first-wins') continue;
            if (conflict === 'error') { servers.delete(key); blockedNames.add(key); continue; }
          }
          if (platform === 'win32' && server.config.transport === 'stdio') {
            const fix = windowsCommandFix(server.config, config.windowsShim);
            if (fix !== undefined) {
              warnings.push({ ...fix, ...serverSource, server: key });
              server.approval.command = server.config.command;
            }
          }
          // `source.server` is the declaration's OWN name for the entry, which is what an editor
          // needs to address it: `serverName` may have been normalized or hashed on the way in.
          servers.set(key, { spec: server, source: serverSource });
        } catch (error) {
          if (signal?.aborted) throw error;
          const failure = safeError(error);
          diagnostics.push(diagnostic(failure.code, { ...serverSource,
            required: preset.dialect === 'codex' && raw?.required === true && raw?.enabled !== false }, failure.detail));
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const failure = safeError(error);
      diagnostics.push(diagnostic(failure.code, source, failure.detail));
    }
  }
  // Warnings describe loadable servers; keeping them out of the fingerprint means a display-only
  // hint never forces a reconnect.
  const result = { cwd: canonical, servers: [...servers.values()], diagnostics };
  return { ...result, warnings, fingerprint: fingerprint(result) };
}
