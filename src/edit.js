/**
 * Writing declarations back: the half of this plugin that touches the user's own files.
 *
 * Three rules keep it safe enough to ship:
 *   1. touch one path, preserve other values — JSONC/YAML retain document structure; TOML
 *      reprints the whole file and requires explicit consent to lose comments and formatting;
 *   2. read, then compare versions — the Host refuses the write when the file moved underneath
 *      us (`FS_STALE_VERSION`), so a concurrent edit is a conflict, never a silent overwrite;
 *   3. verify after writing and roll back on failure — the loader runs over the new text, and the
 *      write answer carries the previous content, so a candidate that would break loading is
 *      reverted immediately.
 */
import { stringify as stringifyYaml } from 'yaml';
import TOML from '@iarna/toml';
import { BUILTIN_PRESETS, COMMON_FIELDS, pathOfSelector, resolvePresets, select } from './presets.js';
import { loadWorkspace, parseDeclaration } from './load.js';
import { DeclarationError, isRecord, normalizeServerName } from './normalize.js';
import { isEditableFormat, setPath } from './serialize.js';

/**
 * The canonical fields this editor offers, in display order. Everything else is left alone.
 *
 * `url` leads because for a remote server it is the whole declaration and `command` is noise —
 * the same reason the host's own pickers lead with the address. `transport` follows it, and the
 * local-server fields come after.
 */
export const EDITABLE_FIELDS = Object.freeze(['url', 'transport', 'command', 'args', 'env', 'cwd', 'headers']);

/**
 * The transports a declaration may name, in the order a picker should offer them.
 *
 * Exactly the vocabulary `normalizeServer` accepts as written: it folds `http` into
 * `streamable-http` and rejects `sse` outright (`UNSUPPORTED_SSE`), so offering SSE would produce
 * a declaration the loader refuses.
 */
export const TRANSPORTS = Object.freeze(['stdio', 'http']);

/** The picker options for one field, with the current value kept selectable if it is unusual. */
const optionsFor = (name, value) => {
  if (name !== 'transport') return undefined;
  const known = [...TRANSPORTS];
  return typeof value === 'string' && !known.includes(value) ? [value, ...known] : known;
};

const failure = (code, message) => Object.assign(new DeclarationError(code), { message });
const TOML_WARNING = '修改 TOML 会重写整个文件，整个文件的注释和排版可能丢失；其他配置值会保留。';
const lossyMetadata = format => format === 'toml' ? { lossy: true, warning: TOML_WARNING } : {};
/** Existing TOML files are never rewritten without a literal, explicit confirmation. */
const assertLossyAllowed = (preset, options) => {
  if (preset.format === 'toml' && options?.allowLossy !== true) {
    throw failure('DECLARATION_CONFIRM_REQUIRED', `${TOML_WARNING} 请明确确认后再修改（allowLossy: true）。`);
  }
};
/**
 * Reject a value the loader would refuse, before anything is written.
 *
 * A transport outside the vocabulary does not degrade: the loader rejects the entire server with
 * `UNSUPPORTED_SSE` or `UNSUPPORTED_TRANSPORT`, so it has to be caught at the form.
 */
const assertFieldValue = (name, value) => {
  if (value === null || value === undefined) return;
  if (name === 'transport' && !TRANSPORTS.includes(value)) {
    throw failure('DECLARATION_INVALID', `不支持的调用方式：${String(value)}（只支持 ${TRANSPORTS.join(' / ')}）`);
  }
};
const kindOf = name => (name === 'transport' ? 'choice'
  : name === 'args' ? 'list' : ['env', 'headers'].includes(name) ? 'map' : 'text');

/**
 * Whether this preset can name a canonical field at all.
 *
 * `transport` is dialect-bound: the standard presets spell it `type`, Gemini implies it from
 * `url` versus `httpUrl`, and Codex' TOML has no such field at all. Offering the control where
 * it cannot be written would produce a key nobody reads.
 */
const supportsField = (preset, name) => {
  if (name !== 'transport') return true;
  if ((preset.dialect ?? 'standard') !== 'standard') return false;
  // A preset whose format simply has no notion of a transport can say so by mapping the field to
  // nothing: the default mapping would otherwise write a `type` key that nothing ever reads.
  return preset.fields?.transport !== '';
};

/** Formats we can create. A new file has no existing comments or formatting to preserve. */
const CREATABLE_FORMATS = Object.freeze(['json', 'jsonc', 'yaml', 'toml']);

/** Write one value at `keys` inside a plain object, creating intermediate objects. */
const setNested = (object, keys, value) => {
  let node = object;
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(node, key) || !isRecord(node[key])) {
      Object.defineProperty(node, key, { value: Object.create(null), enumerable: true, writable: true, configurable: true });
    }
    node = node[key];
  }
  Object.defineProperty(node, keys[keys.length - 1], { value, enumerable: true, writable: true, configurable: true });
};

/**
 * Build the read/write surface for one workspace.
 * @param fs - the session filesystem, already fenced by its own sandbox provider.
 * @param config - the live plugin config; its presets decide format, table path and field names.
 * @returns list/save/remove, each taking the loader plan the caller already holds.
 */
export function createDeclarationEditor({ fs, config }) {
  /** The plan entry and its recorded origin: preset id, file, and the declaration's own key. */
  const locate = (plan, serverId) => {
    const entry = (plan?.servers ?? []).find(item => item.spec.config.serverName === serverId);
    if (entry === undefined) throw failure('DECLARATION_NOT_FOUND', `声明里没有这台服务器：${serverId}`);
    const source = entry.source ?? {};
    if (typeof source.file !== 'string' || typeof source.preset !== 'string' || typeof source.server !== 'string') {
      throw failure('DECLARATION_UNSUPPORTED', '这个条目没有可定位的来源，只能手动编辑');
    }
    return { entry, source };
  };
  const presetOf = source => {
    const preset = resolvePresets(config).find(item => item.id === source.preset);
    if (preset === undefined) throw failure('DECLARATION_UNSUPPORTED', `找不到预设 ${source.preset}`);
    return preset;
  };
  /** The declaration's own selector for a canonical field name. */
  const selectorOf = (preset, name) => ({ ...COMMON_FIELDS, ...preset.fields })[name];
  /** The entry's location and value inside a parsed document. */
  const locateRaw = (doc, preset, source) => {
    for (const selector of preset.serversPaths) {
      const table = select(doc, selector);
      if (!isRecord(table) || !Object.hasOwn(table, source.server)) continue;
      return { itemPath: [...pathOfSelector(selector), source.server], raw: table[source.server] };
    }
    throw failure('DECLARATION_NOT_FOUND', '声明文件里找不到这个条目');
  };
  /** The editable fields the entry actually declares, each with the path it lives at. */
  const fieldsOf = (preset, raw, itemPath) => {
    const out = [];
    for (const name of EDITABLE_FIELDS) {
      if (!supportsField(preset, name)) continue;
      const selector = selectorOf(preset, name);
      if (typeof selector !== 'string') continue;
      let value = select(raw, selector);
      if (name === 'transport' && value === 'streamable-http') value = 'http';
      // A declaration usually omits `type` entirely (`command` implies stdio, `url` implies http),
      // so the transport is inferred when it is absent — otherwise an existing entry could never
      // switch between a local program and a remote endpoint.
      if (value === undefined && name === 'transport') {
        value = select(raw, selectorOf(preset, 'command')) !== undefined ? 'stdio'
          : select(raw, selectorOf(preset, 'url')) !== undefined ? 'http' : undefined;
      }
      // Offer absent fields as well: changing transport must be able to add a command or URL.
      out.push({ name, path: [...itemPath, ...pathOfSelector(selector)], value, kind: kindOf(name, value), options: optionsFor(name, value) });
    }
    return out;
  };
  /** Read one declaration file, fenced to the workspace and carrying the Host's version token. */
  const readFile = async (plan, source, preset, signal) => {
    const root = await fs.resolve(plan.cwd, { signal });
    const target = await fs.resolve(source.file, { cwd: plan.cwd, signal });
    if (!fs.contains(root, target)) throw failure('DECLARATION_OUTSIDE_WORKSPACE', '声明文件不在工作区内');
    const info = await fs.stat(target, signal);
    if (!info || info.type !== 'file') throw failure('DECLARATION_NOT_FOUND', `读不到 ${source.file}`);
    const bytes = await fs.readBytes(target, signal, config.maxFileBytes ?? 1048576);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { target, version: info.version, text, preset };
  };
  /** Re-read a candidate the way the loader will, before anything is written. */
  const assertReadable = (text, preset, source, expectPresent) => {
    let doc;
    try { doc = parseDeclaration(text, preset.format); } catch { throw failure('DECLARATION_INVALID', '改完之后解析不通过，已放弃这次修改'); }
    if (!isRecord(doc)) throw failure('DECLARATION_INVALID', '改完之后文件根不是对象，已放弃这次修改');
    let found = true;
    try { locateRaw(doc, preset, source); } catch { found = false; }
    if (found !== expectPresent) {
      throw failure('DECLARATION_INVALID', expectPresent ? '改完之后找不到这个条目，已放弃这次修改' : '改完之后这个条目还在，已放弃这次删除');
    }
  };
  /**
   * Write, tolerating the one transient fault this platform produces.
   *
   * Windows can refuse an atomic replace with Win32 1175 while something else briefly holds a
   * handle on the target (an indexer or a scanner, typically). The staged write never mutates the
   * target, so retrying once with the same version token cannot lose an edit or defeat the guard.
   */
  const writeWithRetry = async (target, content, expected, signal) => {
    try { return await fs.writeText(target, content, expected, signal); }
    catch (error) {
      if (error?.code !== 'EIO') throw error;
      await new Promise(resolve => setTimeout(resolve, 60));
      return fs.writeText(target, content, expected, signal);
    }
  };
  /**
   * Apply one edit, verify it, and undo it when the new text would not load.
   * @param expectPresent - true for an edit (the entry must survive), false for a removal.
   * @param version - the token the caller read with; a save against a newer file is a conflict.
   */
  const commit = async (plan, serverId, mutate, signal, { expectPresent = true, version, allowLossy = false } = {}) => {
    const { source } = locate(plan, serverId);
    const preset = presetOf(source);
    if (!isEditableFormat(preset.format)) {
      throw failure('DECLARATION_UNSUPPORTED', `${String(preset.format).toUpperCase()} 声明暂时只支持手动编辑`);
    }
    assertLossyAllowed(preset, { allowLossy });
    const file = await readFile(plan, source, preset, signal);
    // The interesting window is not this call: it is the minute the user spent in the editor.
    // A caller that read earlier hands its token back, and a file that moved in the meantime is
    // a conflict to report rather than a change to silently discard.
    if (version !== undefined && String(file.version) !== String(version)) {
      throw failure('DECLARATION_STALE', '这个声明文件在你打开编辑器之后被改过了，请重新读取再改');
    }
    const doc = parseDeclaration(file.text, preset.format);
    if (!isRecord(doc)) throw failure('DECLARATION_INVALID', '声明文件根不是对象');
    const { itemPath, raw } = locateRaw(doc, preset, source);
    const text = mutate({ text: file.text, preset, itemPath, raw });
    assertReadable(text, preset, source, expectPresent);
    const written = await writeWithRetry(file.target, text, { kind: 'replaceIfVersion', version: file.version }, signal);
    try {
      const after = await loadWorkspace(fs, plan.cwd, config, { signal });
      if (expectPresent) {
        const present = (after.servers ?? []).some(item => item.spec.config.serverName === serverId
          && item.source?.file === source.file && item.source?.preset === source.preset);
        if (!present) throw failure('DECLARATION_INVALID', '保存后的声明里找不到这台服务器，已还原');
      }
      return { ok: true, version: written?.version };
    } catch (error) {
      // The write answer carries the previous text, so the revert is exact — no guessing.
      if (typeof written?.before === 'string') {
        await writeWithRetry(file.target, written.before, { kind: 'replaceIfVersion', version: written.version }, signal).catch(() => {});
      }
      throw error;
    }
  };

  /** Canonical field values → the shape this preset's format declares. */
  const fieldsToRaw = (preset, values) => {
    const raw = {};
    for (const [name, value] of Object.entries(values)) {
      const selector = selectorOf(preset, name);
      const keys = typeof selector === 'string' ? pathOfSelector(selector) : [name];
      if (keys.length === 0) continue;
      setNested(raw, keys, value);
    }
    return raw;
  };
  /** Compose a brand-new declaration document holding exactly one entry. */
  const composeNew = (preset, name, values) => {
    const root = Object.create(null);
    const keys = pathOfSelector(preset.serversPaths?.[0] ?? '');
    if (keys.length === 0) root[name] = fieldsToRaw(preset, values);
    else {
      let node = root;
      for (const key of keys) { node[key] = Object.create(null); node = node[key]; }
      node[name] = fieldsToRaw(preset, values);
    }
    if (preset.format === 'yaml') return stringifyYaml(root);
    if (preset.format === 'toml') return TOML.stringify(root);
    return `${JSON.stringify(root, null, 2)}\n`;
  };
  /** Validate both the written file and its exact loaded origin; the caller rolls back both sides. */
  const settle = async (plan, preset, name, file, target, written, created, signal, removedServerId) => {
    const info = await fs.stat(target, signal);
    if (info === undefined) throw failure('DECLARATION_INVALID', '写完之后文件不见了');
    const bytes = await fs.readBytes(target, signal, config.maxFileBytes ?? 1048576);
    const doc = parseDeclaration(new TextDecoder('utf-8', { fatal: true }).decode(bytes), preset.format);
    if (!isRecord(doc)) throw failure('DECLARATION_INVALID', '写完之后文件根不是对象');
    try { locateRaw(doc, preset, { server: name }); } catch { throw failure('DECLARATION_INVALID', '写完之后这个条目不在文件里'); }
    const after = await loadWorkspace(fs, plan.cwd, config, { signal });
    const blocked = (after.diagnostics ?? []).find(issue => issue.code === 'DUPLICATE_SERVER' && normalizeServerName(issue.server ?? '') === normalizeServerName(name));
    if (blocked !== undefined) throw failure('DECLARATION_CONFLICT', `声明里有两台同名服务器，加载器会按冲突策略把它们都禁用：${String(blocked.server ?? name)}`);
    const present = after.servers.some(item => item.source?.file === file
      && item.source?.preset === preset.id && item.source?.server === name);
    if (!present) throw failure('DECLARATION_INVALID', '新声明无法被加载（字段、变量或服务器表无效），已放弃这次写入');
    const lost = (plan.servers ?? []).some(item => item.spec.config.serverName !== removedServerId
      && item.spec.config.serverName !== normalizeServerName(name)
      && !after.servers.some(next => next.spec.config.serverName === item.spec.config.serverName));
    if (lost) throw failure('DECLARATION_INVALID', '写入会导致其他服务器无法加载（可能达到服务器数量上限），已放弃这次写入');
    return { ok: true, file, created, version: written?.version };
  };
  /** Remove one entry; shared by the panel action and by the copy-with-cleanup path. */
  const removeEntry = (plan, serverId, signal, version, options = { allowLossy: false }) => commit(
    plan, serverId,
    ({ text, preset, itemPath }) => setPath(text, preset.format, itemPath, undefined),
    signal, { expectPresent: false, version, allowLossy: options?.allowLossy },
  );

  return {
    /** Every declaration this session loaded that lives in a file we can rewrite. */
    async list(plan, signal) {
      const targets = [];
      const files = new Map();
      for (const entry of plan?.servers ?? []) {
        const source = entry.source ?? {};
        if (typeof source.file !== 'string' || typeof source.preset !== 'string' || typeof source.server !== 'string') continue;
        let preset;
        try { preset = presetOf(source); } catch { continue; }
        const editable = isEditableFormat(preset.format);
        const target = {
          serverId: entry.spec.config.serverName,
          preset: preset.id,
          file: source.file,
          format: preset.format,
          dialect: preset.dialect ?? 'standard',
          editable,
          ...lossyMetadata(preset.format),
          ...(editable ? {} : { reason: `${String(preset.format).toUpperCase()} 声明暂时只支持手动编辑` }),
          fields: [],
        };
        // Read-only formats still need their values for inspection and copying.
        {
          try {
            const cacheKey = `${source.preset}\u0000${source.file}`;
            if (!files.has(cacheKey)) files.set(cacheKey, await readFile(plan, source, preset, signal));
            const file = files.get(cacheKey);
            const doc = parseDeclaration(file.text, preset.format);
            const { itemPath, raw } = locateRaw(doc, preset, source);
            target.version = file.version;
            target.fields = fieldsOf(preset, raw, itemPath);
          } catch (error) {
            target.editable = false;
            target.reason = error?.message ?? '读不出这个条目';
          }
        }
        targets.push(target);
      }
      return targets;
    },
    /** Rewrite named fields, preserving other values; TOML requires consent to reprint. */
    async save(plan, serverId, changes, signal, version, options = { allowLossy: false }) {
      const oldTransport = locate(plan, serverId).entry.spec.config.transport;
      return commit(plan, serverId, ({ text, preset, itemPath }) => {
        let next = text;
        const remote = (changes ?? []).some(change => (change.name === 'transport' && change.value === 'http')
          || (change.name === 'url' && typeof change.value === 'string' && change.value.length > 0));
        const local = (changes ?? []).some(change => (change.name === 'transport' && change.value === 'stdio')
          || (change.name === 'command' && typeof change.value === 'string' && change.value.length > 0));
        const obsolete = oldTransport === 'stdio' && remote ? ['envFile', 'envVars']
          : oldTransport === 'streamable-http' && local ? ['envHeaders', 'bearerTokenEnv'] : [];
        for (const name of obsolete) {
          const selector = selectorOf(preset, name);
          if (typeof selector === 'string' && selector !== '') next = setPath(next, preset.format, [...itemPath, ...pathOfSelector(selector)], undefined);
        }
        for (const change of changes ?? []) {
          if (typeof change?.name !== 'string' || !EDITABLE_FIELDS.includes(change.name) || !supportsField(preset, change.name)) {
            throw failure('DECLARATION_UNSUPPORTED', `不能改这个字段：${String(change?.name)}`);
          }
          assertFieldValue(change.name, change.value);
          const selector = selectorOf(preset, change.name);
          const own = typeof selector === 'string' ? pathOfSelector(selector) : [change.name];
          next = setPath(next, preset.format, [...itemPath, ...own], change.value === null ? undefined : change.value);
        }
        if (next === text) throw failure('DECLARATION_INVALID', '没有要改的字段');
        return next;
      }, signal, { version, allowLossy: options?.allowLossy });
    },
    /** Remove one entry from its declaration file. */
    remove: removeEntry,
    /**
     * Every preset that could be a write target here, and whether it can be one right now.
     *
     * New files need no lossy confirmation. Existing TOML files remain editable but advertise
     * their whole-document rewrite warning so the UI can ask for explicit consent.
     */
    async presets(plan, signal) {
      const out = [];
      for (const preset of resolvePresets(config)) {
        const file = preset.files?.[0];
        const entry = {
          id: preset.id,
          format: preset.format,
          dialect: preset.dialect ?? 'standard',
          files: preset.files ?? [],
          builtin: BUILTIN_PRESETS.some(builtin => builtin.id === preset.id),
          exists: false,
          ...lossyMetadata(preset.format),
          // What a fresh form may offer for THIS preset, in the same shape the entry fields use (minus
          // the values): `transport` only exists in the standard dialect.
          fields: EDITABLE_FIELDS.filter(name => supportsField(preset, name))
            .map(name => ({ name, kind: kindOf(name, undefined), options: optionsFor(name, undefined) })),
          editable: true,
        };
        if (typeof file !== 'string') {
          entry.editable = false;
          entry.reason = '这个预设没有声明文件路径';
        } else if (!CREATABLE_FORMATS.includes(preset.format)) {
          entry.editable = false;
          entry.reason = `${String(preset.format).toUpperCase()} 不能写入`;
        } else {
          const target = await fs.resolve(file, { cwd: plan.cwd, signal });
          const info = await fs.stat(target, signal);
          entry.exists = info !== undefined;
        }
        out.push(entry);
      }
      return out;
    },
    /**
     * Create one entry, optionally seeded from an existing one.
     *
     * This is the "copy to another preset" path as well: reading the source into canonical field
     * values and writing them through the target preset is exactly a format conversion — the only
     * thing that changes between the two cases is which document gets touched.
     */
    async write(plan, request, signal) {
      const preset = resolvePresets(config).find(item => item.id === request?.preset);
      if (preset === undefined) throw failure('DECLARATION_UNSUPPORTED', `找不到预设 ${String(request?.preset)}`);
      const name = typeof request?.name === 'string' ? request.name.trim() : '';
      if (name.length === 0) throw failure('DECLARATION_INVALID', '条目名不能为空');
      const values = {};
      let sourceFile;
      if (request?.removeSource === true && request?.fromServerId === undefined) {
        throw failure('DECLARATION_INVALID', '迁移必须指定源服务器');
      }
      if (request?.fromServerId !== undefined) {
        const { source } = locate(plan, request.fromServerId);
        const from = presetOf(source);
        const file = await readFile(plan, source, from, signal);
        sourceFile = { ...file, source };
        if (request?.removeSource === true) {
          if (!isEditableFormat(from.format)) throw failure('DECLARATION_UNSUPPORTED', '源声明只读，不能迁移；请改名复制');
          // Preflight before touching the destination: a refused migration must not create a file.
          assertLossyAllowed(from, request);
        }
        const doc = parseDeclaration(file.text, from.format);
        const { itemPath, raw } = locateRaw(doc, from, source);
        // Do not silently widen tool access or drop credential forwarding during conversion.
        const unconverted = ['envFile', 'envVars', 'envHeaders', 'bearerTokenEnv', 'timeoutMs', 'timeoutSeconds']
          .some(key => typeof selectorOf(from, key) === 'string' && select(raw, selectorOf(from, key)) !== undefined);
        if (unconverted || ['includeTools', 'excludeTools', 'enabled_tools', 'disabled_tools', 'required', 'startup_timeout_sec'].some(key => Object.hasOwn(raw, key))) {
          throw failure('DECLARATION_UNSUPPORTED', '此声明含工具过滤、凭证引用或超时等高级字段；为避免复制时丢失语义，请手动迁移完整配置');
        }
        for (const field of fieldsOf(from, raw, itemPath)) {
          if (field.value !== undefined && supportsField(preset, field.name)) values[field.name] = field.value;
        }
      }
      for (const field of request?.fields ?? []) {
        if (typeof field?.name !== 'string' || !EDITABLE_FIELDS.includes(field.name) || !supportsField(preset, field.name)) {
          throw failure('DECLARATION_UNSUPPORTED', `不能写这个字段：${String(field?.name)}`);
        }
        assertFieldValue(field.name, field.value);
        if (field.value === null || field.value === undefined) delete values[field.name];
        else values[field.name] = field.value;
      }
      if (Object.keys(values).length === 0) throw failure('DECLARATION_INVALID', '至少要填一个字段');
      const file = preset.files?.[0];
      if (typeof file !== 'string') throw failure('DECLARATION_UNSUPPORTED', '这个预设没有声明文件路径');
      // Two declaration files both naming a server is a conflict the loader resolves by disabling
      // it (`conflictPolicy`), so a copy that leaves the original behind would land and then be
      // dropped on the next load. Either the name changes, or this is a move.
      const elsewhere = (plan.servers ?? []).find(item => item.source?.server === name && item.source?.preset !== preset.id);
      if (elsewhere !== undefined && request?.removeSource !== true) {
        // A different code on purpose: `overwrite` cannot fix this one, because the clash is with a
        // server in ANOTHER declaration file. The panel must offer a rename or a move, not an
        // "overwrite?" prompt that would fail again.
        throw failure('DECLARATION_CONFLICT', `声明里已经有叫 ${name} 的服务器（${String(elsewhere.source?.file)}）：两个文件同名会让加载器按冲突策略禁用它。换个名字，或勾选「复制后删除原条目」把它移过来。`);
      }
      const root = await fs.resolve(plan.cwd, { signal });
      const target = await fs.resolve(file, { cwd: plan.cwd, signal });
      if (!fs.contains(root, target)) throw failure('DECLARATION_OUTSIDE_WORKSPACE', '目标文件不在工作区内');
      if (sourceFile !== undefined && fs.processPath(sourceFile.target) === fs.processPath(target)) {
        throw failure('DECLARATION_CONFLICT', '源预设和目标预设指向同一个文件，不能从这里复制或迁移');
      }
      let itemPath = [...pathOfSelector(preset.serversPaths?.[0] ?? ''), name];
      const info = await fs.stat(target, signal);
      let written;
      let writtenTarget;
      let created;
      if (info === undefined) {
        if (!CREATABLE_FORMATS.includes(preset.format)) {
          throw failure('DECLARATION_UNSUPPORTED', `${String(preset.format).toUpperCase()} 不能写入`);
        }
        const text = composeNew(preset, name, values);
        assertReadable(text, preset, { server: name }, true);
        writtenTarget = target;
        created = true;
        written = await writeWithRetry(target, text, { kind: 'createIfAbsent' }, signal);
      } else {
        if (!isEditableFormat(preset.format)) {
          throw failure('DECLARATION_UNSUPPORTED', `${String(preset.format).toUpperCase()} 不能追加`);
        }
        assertLossyAllowed(preset, request);
        const existing = await readFile(plan, { file, preset: preset.id, server: name }, preset, signal);
        const doc = parseDeclaration(existing.text, preset.format);
        if (!isRecord(doc)) throw failure('DECLARATION_INVALID', '声明文件根不是对象');
        const tables = preset.serversPaths.filter(selector => select(doc, selector) !== undefined);
        if (tables.length > 1 || (tables.length === 1 && !isRecord(select(doc, tables[0])))) {
          throw failure('DECLARATION_INVALID', '声明文件中的服务器表有歧义，不能追加');
        }
        itemPath = [...pathOfSelector(tables[0] ?? preset.serversPaths[0]), name];
        if (request?.overwrite !== true) {
          let taken = true;
          try { locateRaw(doc, preset, { server: name }); } catch { taken = false; }
          if (taken) throw failure('DECLARATION_EXISTS', `${file} 里已经有一台叫 ${name} 的服务器`);
        }
        const text = setPath(existing.text, preset.format, itemPath, fieldsToRaw(preset, values));
        assertReadable(text, preset, { server: name }, true);
        writtenTarget = existing.target;
        created = false;
        written = await writeWithRetry(existing.target, text, { kind: 'replaceIfVersion', version: existing.version }, signal);
      }
      // The order matters: delete the source BEFORE verifying, because two files naming one server
      // is a conflict the loader disables, and that intermediate state is not what we are checking.
      // A failed cleanup throws, which rolls the new file back and leaves both sides as they were.
      let removed;
      try {
        if (request?.fromServerId !== undefined && request?.removeSource === true) {
          removed = await removeEntry(plan, request.fromServerId, signal, sourceFile.version, { allowLossy: request.allowLossy });
        }
        return { ...(await settle(plan, preset, name, file, writtenTarget, written, created, signal, removed === undefined ? undefined : request.fromServerId)), removedSource: removed !== undefined };
      } catch (error) {
        // Roll both sides back, including a failed source deletion. Never overwrite concurrent edits.
        const restoreSignal = new AbortController().signal;
        let rollbackFailed = false;
        const restore = typeof written?.before === 'string' ? written.before : created ? '' : undefined;
        if (restore !== undefined) {
          try { await writeWithRetry(writtenTarget, restore, { kind: 'replaceIfVersion', version: written.version }, restoreSignal); }
          catch { rollbackFailed = true; }
        }
        if (removed !== undefined) {
          try { await writeWithRetry(sourceFile.target, sourceFile.text, { kind: 'replaceIfVersion', version: removed.version }, restoreSignal); }
          catch { rollbackFailed = true; }
        }
        if (rollbackFailed) error.message += '（回滚遇到冲突，请检查源和目标文件）';
        else if (created) error.message += `（新建的文件已清空，请手动删除 ${file}）`;
        throw error;
      }
    },
  };
}
