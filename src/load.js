import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import TOML from '@iarna/toml';
import { parse as parseJsonc, visit } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import { COMMON_FIELDS, resolvePresets, select } from './presets.js';
import { DeclarationError, interpolate, isRecord, normalizeServer } from './normalize.js';

export function parseDeclaration(text, format) {
  text = text.replace(/^\uFEFF/, '');
  try {
    if (format === 'json' || format === 'jsonc') {
      // Reject duplicate keys rather than silently choosing a different credential/command.
      const objects = [];
      let duplicate = false;
      visit(text, {
        onObjectBegin: () => objects.push(new Set()),
        onObjectProperty: key => { if (objects.at(-1).has(key)) duplicate = true; objects.at(-1).add(key); },
        onObjectEnd: () => objects.pop(),
      }, { allowTrailingComma: format === 'jsonc', disallowComments: format === 'json' });
      const errors = [];
      const value = parseJsonc(text, errors, { allowTrailingComma: format === 'jsonc', disallowComments: format === 'json' });
      if (errors.length || duplicate) throw new Error();
      return value;
    }
    if (format === 'toml') return TOML.parse(text);
    if (format === 'yaml') {
      const doc = parseDocument(text, { uniqueKeys: true });
      if (doc.errors.length) throw new Error();
      return doc.toJS({ maxAliasCount: 50 });
    }
  } catch { throw new DeclarationError('INVALID_DECLARATION'); }
  throw new DeclarationError('UNSUPPORTED_FORMAT');
}
export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value, (_key, val) => isRecord(val)
    ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b))) : val)).digest('hex');
}
function safeError(error) { return error instanceof DeclarationError ? error.code : 'FILE_READ_FAILED'; }
const diagnostic = (code, source) => ({ code, ...source });

/** Read only explicit workspace files, never walk parents or inspect global client settings. */
export async function loadWorkspace(fs, cwd, config = {}, { signal, env = process.env, home } = {}) {
  const diagnostics = [], servers = new Map(), blockedNames = new Set();
  if (!cwd || !path.isAbsolute(cwd)) return { servers: [], diagnostics: [diagnostic('NO_ABSOLUTE_WORKSPACE', {})], fingerprint: 'no-workspace' };
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
      if (!isRecord(doc)) throw new DeclarationError('INVALID_ROOT');
      const tables = preset.serversPaths.map(p => select(doc, p)).filter(v => v !== undefined);
      if (!tables.length) continue; // settings/config files may contain no MCP declarations.
      if (tables.length !== 1 || !isRecord(tables[0])) throw new DeclarationError('AMBIGUOUS_SERVER_TABLE');
      if (Object.hasOwn(doc, 'sandbox')) throw new DeclarationError('UNSUPPORTED_SANDBOX');
      for (const [rawName, raw] of Object.entries(tables[0])) {
        const serverSource = { ...source, server: rawName };
        try {
          if (++examined > maxServers) throw new DeclarationError('SERVER_LIMIT_EXCEEDED');
          const context = { cwd: canonical, configDir: path.dirname(loaded.file), env, home, inputs: config.inputValues ?? {} };
          const fields = { ...COMMON_FIELDS, ...preset.fields };
          const isDisabled = select(raw, fields.enabled) === false || select(raw, fields.disabled) === true;
          let fileEnv = {};
          const envFile = select(raw, fields.envFile);
          if (!isDisabled && envFile !== undefined) {
            if (typeof envFile !== 'string') throw new DeclarationError('INVALID_ENV_FILE');
            const envPath = interpolate(envFile, context, preset.interpolation ?? 'standard');
            const result = await readInside(envPath);
            if (!result) throw new DeclarationError('ENV_FILE_NOT_FOUND');
            try { fileEnv = parseEnv(result.text); } catch { throw new DeclarationError('INVALID_ENV_FILE'); }
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
            diagnostics.push(diagnostic('DUPLICATE_SERVER', { ...serverSource, required: server.required || servers.get(key).spec.required }));
            if (conflict === 'first-wins') continue;
            if (conflict === 'error') { servers.delete(key); blockedNames.add(key); continue; }
          }
          // `source.server` is the declaration's OWN name for the entry, which is what an editor
          // needs to address it: `serverName` may have been normalized or hashed on the way in.
          servers.set(key, { spec: server, source: serverSource });
        } catch (error) {
          if (signal?.aborted) throw error;
          diagnostics.push(diagnostic(safeError(error), { ...serverSource,
            required: preset.dialect === 'codex' && raw?.required === true && raw?.enabled !== false }));
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      diagnostics.push(diagnostic(safeError(error), source));
    }
  }
  const result = { cwd: canonical, servers: [...servers.values()], diagnostics };
  return { ...result, fingerprint: fingerprint(result) };
}
