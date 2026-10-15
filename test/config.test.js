import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigControl, liveConfig, VOLATILE_FIELDS, EDITABLE } from '../src/config.js';

const loaderStub = entry => ({ entries: () => (entry === undefined ? [] : [entry]) });
const entryStub = (id = 'entry-1') => ({ options: { id, name: 'dsh-mcp-glue' }, fiber: {} });
const controlFor = ({ settings, entry = entryStub(), fallback = () => ({ enabledBuiltins: [], presets: [] }) }) =>
  createConfigControl({ settings: () => settings, loader: () => loaderStub(entry), packageNames: ['dsh-mcp-glue'], fallback });

test('read reports the entry id, revision, effect timing and the live config', async () => {
  const settings = {
    writable: true,
    describe: () => [{
      ns: 'entry-1',
      revision: 7,
      applies: 'live',
      value: { enabledBuiltins: ['root', 'vscode'], presets: [{ id: 'x' }], trustMode: 'ask', trustedWorkspaces: ['D:\\w'], conflictPolicy: 'error' },
    }],
  };
  const view = await controlFor({ settings }).readConfig();
  assert.equal(view.entryId, 'entry-1');
  assert.equal(view.revision, 7);
  assert.equal(view.editable, true);
  assert.equal(view.writable, true);
  assert.equal(view.applies, 'live');
  assert.equal(view.reason, undefined);
  assert.deepEqual(view.config.enabledBuiltins, ['root', 'vscode']);
  assert.deepEqual(view.config.presets, [{ id: 'x' }]);
  assert.deepEqual(view.builtins.map(preset => preset.id), ['root', 'vscode', 'codex', 'cursor', 'gemini']);
  assert.ok(view.builtins.every(preset => preset.files.length > 0 && preset.serversPaths.length > 0));
});

test('each way of having no form is reported with its own reason, and the write is refused', async () => {
  // The row exists but its Config declares no volatile field: the Host drops the entry.
  const noForm = controlFor({ settings: { writable: true, describe: () => [] } });
  const view = await noForm.readConfig();
  assert.equal(view.editable, false);
  assert.equal(view.entryId, null);
  assert.equal(view.rowId, 'entry-1', 'the row is still resolved, which is what the reason explains');
  assert.deepEqual(view.config.presets, []);
  assert.match(view.reason, /volatile/);
  await assert.rejects(noForm.writeConfig({ presets: [] }), failure => {
    assert.match(failure.message, /设置|settings/);
    assert.equal(failure.code, 'SETTINGS_UNAVAILABLE');
    assert.match(failure.reason, /volatile/);
    return true;
  });

  // No settings provider at all (a composition without @deepseek-ai/dsh-settings).
  const unavailable = controlFor({ settings: undefined });
  const absentView = await unavailable.readConfig();
  assert.equal(absentView.editable, false);
  assert.match(absentView.reason, /settings 服务不可用/);

  // The plugin cannot find its own Loader row.
  const lost = controlFor({ settings: { writable: true, describe: () => [] }, entry: null });
  const lostView = await lost.readConfig();
  assert.equal(lostView.rowId, null);
  assert.match(lostView.reason, /找不到自己的 Loader 条目/);
});

test('write only forwards editable fields, validates presets, and keeps the revision', async () => {
  const settings = {
    writable: true,
    calls: [],
    describe: () => [{ ns: 'entry-1', revision: 3, applies: 'live', value: { enabledBuiltins: ['root'], presets: [] } }],
    async update(...args) { settings.calls.push(args); },
  };
  await controlFor({ settings }).writeConfig({
    presets: [{ id: 'team', files: ['a.json'], serversPaths: ['mcpServers'] }],
    enabledBuiltins: ['root', 'vscode'],
    inputValues: { token: 'must-not-be-forwarded' },
    maxServers: 999,
    unknownField: true,
  });
  assert.equal(settings.calls.length, 1);
  const [ns, patch, revision] = settings.calls[0];
  assert.equal(ns, 'entry-1');
  assert.equal(revision, 3);
  assert.deepEqual(Object.keys(patch).sort(), ['enabledBuiltins', 'presets']);
  assert.equal(patch.inputValues, undefined);
  assert.equal(patch.unknownField, undefined);
});

test('write rejects a config that would break activation, and surfaces stale revisions', async () => {
  const settings = {
    writable: true,
    describe: () => [{ ns: 'entry-1', revision: 5, applies: 'live', value: { enabledBuiltins: ['root'], presets: [] } }],
    async update() { throw Object.assign(new Error('settings namespace "entry-1" changed since it was read'), { code: 'SETTINGS_CONFLICT' }); },
  };
  const control = controlFor({ settings });
  await assert.rejects(control.writeConfig({ presets: [{ id: 'bad', files: ['a.json'], serversPaths: ['mcpServers'], fields: { nope: 'x' } }] }), /字段映射|invalid field mapping/);
  await assert.rejects(control.writeConfig({ enabledBuiltins: ['not-a-preset'] }), /unknown builtin preset/);
  await assert.rejects(control.writeConfig({ presets: [{ id: 'ok', files: ['a.json'], serversPaths: ['mcpServers'] }] }), failure => {
    assert.match(failure.message, /changed since it was read/);
    assert.equal(failure.code, 'SETTINGS_CONFLICT', 'the route maps this code to 409');
    return true;
  });
  await assert.rejects(control.writeConfig({}), /没有要保存的改动/);
});

test('a workspace allowance is matched loosely, so a differently spelled path is updated, not duplicated', async () => {
  const store = {
    value: { trustMode: 'manual', trustedWorkspaces: [], workspaceAllowances: [{ workspace: 'D:\\Work\\Team-A\\', allowMcp: ['same'], allowTools: [] }] },
    revision: 3,
    updates: [],
  };
  const settings = {
    writable: true,
    describe: () => [{ ns: 'entry-1', revision: store.revision, applies: 'live', value: store.value }],
    async update(ns, patch, revision) {
      store.updates.push({ ns: String(ns), patch, revision });
      store.value = { ...store.value, ...patch };
    },
  };
  const control = createConfigControl({
    settings: () => settings,
    loader: () => loaderStub(entryStub('entry-1')),
    packageNames: ['dsh-mcp-glue'],
    fallback: () => ({ enabledBuiltins: [], presets: [] }),
  });
  const view = await control.updateAllowance('D:\\work\\team-a', entry => ({
    ...entry,
    allowTools: [...entry.allowTools, 'mcp__same__identity'],
  }));
  const written = store.updates.at(-1).patch.workspaceAllowances;
  assert.equal(written.length, 1, 'the Host canonicalizes the path, so the writer must not add a second entry for it');
  assert.deepEqual(written[0].allowMcp, ['same'], 'what the entry already allowed survives');
  assert.deepEqual(written[0].allowTools, ['mcp__same__identity']);
  assert.equal(written[0].workspace, 'D:\\Work\\Team-A\\', 'and its original spelling is preserved');
  assert.deepEqual(view.config.workspaceAllowances.map(entry => entry.allowTools), [['mcp__same__identity']]);
});

test('exactly the volatile fields are writable', async () => {
  assert.deepEqual([...EDITABLE].sort(), [...VOLATILE_FIELDS].sort(),
    'the fields the form exposes are the fields the Host lets it write');
  assert.ok(!EDITABLE.includes('inputValues'), 'secrets never round-trip through the browser');
  for (const field of ['maxFileBytes', 'maxServers', 'startupTimeoutMs']) assert.ok(!EDITABLE.includes(field), field);
});

test('liveConfig unwraps the volatile references Cordis hands to apply', async () => {
  const reference = value => Object.freeze({ get: () => value });
  const live = liveConfig({
    enabled: true,
    enabledBuiltins: reference(['root']),
    presets: reference([{ id: 'x' }]),
    trustMode: reference('all'),
    trustedWorkspaces: reference(['D:\\w']),
    conflictPolicy: reference('first-wins'),
    maxServers: 32,
  });
  assert.deepEqual(live.enabledBuiltins, ['root']);
  assert.deepEqual(live.presets, [{ id: 'x' }]);
  assert.equal(live.trustMode, 'all');
  assert.deepEqual(live.trustedWorkspaces, ['D:\\w']);
  assert.equal(live.conflictPolicy, 'first-wins');
  assert.equal(live.maxServers, 32);
  // A plain config (tests, direct use) passes through untouched.
  assert.deepEqual(liveConfig({ presets: [], trustMode: 'ask' }).presets, []);
});

test('the plugin wires the config control through provided services', async () => {
  const services = new Map();
  services.set('settings', { writable: true, describe: () => [{ ns: 'entry-x', revision: 2, applies: 'live', value: { enabledBuiltins: ['codex'], presets: [] } }] });
  services.set('loader', loaderStub(entryStub('entry-x')));
  const control = createConfigControl({ settings: () => services.get('settings'), loader: () => services.get('loader'), packageNames: ['dsh-mcp-glue'], fallback: () => ({ enabledBuiltins: [], presets: [] }) });
  assert.deepEqual((await control.readConfig()).config.enabledBuiltins, ['codex']);
});
