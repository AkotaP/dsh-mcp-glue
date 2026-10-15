import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as Plugin from '../src/index.js';
import { EDITABLE, VOLATILE_FIELDS, liveConfig } from '../src/config.js';
import { BUILTIN_PRESETS, resolvePresets } from '../src/presets.js';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFile(path.join(root, file), 'utf8');
const manifest = JSON.parse(await read('package.json'));

test('the five ids that must agree do agree', async () => {
  const patch = parseYaml(await read(manifest.dsh.bundle.patch));
  const rows = patch.flatMap(entry => entry.insert ?? []);
  assert.equal(rows.length, 1, 'the bundle patch inserts exactly one row');
  const [row] = rows;
  // The row's specifier is what the client module loader attaches the browser half by,
  // and its id is the settings namespace the Host reports for this entry — so the plugin
  // resolves its own entry through the package name and reads Config under the row id.
  assert.equal(row.name, manifest.name, 'the inserted row uses the package name');
  assert.equal(row.id, Plugin.name, 'the row id and the Cordis name export are the same');
  assert.ok(manifest.exports['./client'], 'the browser half is exported');
  assert.ok((await read(manifest.exports['./client'])).includes(`id: ${JSON.stringify(manifest.name)}`),
    'the bundle registers under the package name, which is also the "plugins.bundle.config" seat key');
});

test('exactly the editable Config fields are declared volatile', async () => {
  const resolved = new Plugin.Config({});
  const volatile = Object.entries(resolved)
    .filter(([, value]) => value !== null && typeof value === 'object' && typeof value.get === 'function')
    .map(([key]) => key)
    .sort();
  assert.deepEqual(volatile, [...VOLATILE_FIELDS].sort(),
    'a field the host cannot see as volatile is dropped from settings.describe() and the entry stops being configurable');
  assert.deepEqual([...VOLATILE_FIELDS].sort(), [...EDITABLE].sort());
  for (const secret of ['inputValues', 'maxFileBytes', 'maxServers', 'startupTimeoutMs', 'webControl', 'enabled']) {
    assert.ok(!volatile.includes(secret), `${secret} must keep the ordinary Loader lifecycle`);
  }
  // Cordis hands a volatile field to apply as a reference; the unwrapped view is what the
  // loader, the resolver and the write path all read.
  const live = liveConfig(resolved);
  assert.equal(live.trustMode, 'manual');
  // A profile carrying the value earlier versions wrote must keep loading: tightening an enum
  // under a live profile once dropped the whole row from the Loader, and the symptom was a 404.
  assert.equal(liveConfig(new Plugin.Config({ trustMode: 'ask' })).trustMode, 'manual');
  assert.equal(liveConfig(new Plugin.Config({ trustMode: 'all' })).trustMode, 'all');
  assert.deepEqual(live.workspaceAllowances, []);
  assert.deepEqual(live.enabledBuiltins, BUILTIN_PRESETS.map(preset => preset.id));
  assert.deepEqual(live.presets, []);
  assert.equal(resolvePresets(live).length, BUILTIN_PRESETS.length);

  // A composed row (the shape a profile patch writes) reads back as plain values too.
  const configured = liveConfig(new Plugin.Config({
    trustMode: 'manual',
    trustedWorkspaces: ['D:\\Data\\Project\\team'],
    workspaceAllowances: [{ workspace: 'D:\\Data\\Project\\team', allowMcp: ['team-tools'], allowTools: ['mcp__team-tools__identity'] }],
    enabledBuiltins: ['root'],
    presets: [{ id: 'team', files: ['.team/mcp.yaml'], serversPaths: ['/integrations/mcp'], format: 'yaml' }],
    inputValues: { token: 'secret' },
  }));
  assert.deepEqual(configured.trustedWorkspaces, ['D:\\Data\\Project\\team']);
  assert.deepEqual(configured.enabledBuiltins, ['root']);
  assert.deepEqual(configured.presets.map(preset => preset.id), ['team']);
  assert.deepEqual(resolvePresets(configured).map(preset => preset.id), ['root', 'team']);
  assert.equal(configured.inputValues.token, 'secret', 'a secret keeps its plain value on the Host side');
  assert.deepEqual(configured.workspaceAllowances.map(entry => entry.allowMcp), [['team-tools']], 'the per-workspace allowance survives as a plain value');
});

/**
 * Mirror of `volatileForm()` in @deepseek-ai/dsh-settings over a serialized schemastery
 * schema (`toJSON()` is a `{ uid, refs }` reference graph): a node has a form when it is
 * volatile itself, or is an object with at least one such descendant. The Host drops an
 * entry whose root form is empty, which is the failure this project shipped with.
 */
function hasForm(nodeOf, node) {
  const resolved = nodeOf(node);
  if (resolved?.meta?.volatile) return true;
  if (resolved?.type !== 'object') return false;
  return Object.values(resolved.dict ?? {}).some(child => hasForm(nodeOf, child));
}

test('the Host would expose exactly the editable fields as a settings form', async () => {
  const json = Plugin.Config.toJSON();
  const nodeOf = reference => (typeof reference === 'number' ? json.refs[reference] : reference);
  const root = nodeOf(json.uid);
  const form = Object.entries(root.dict ?? {}).filter(([, child]) => hasForm(nodeOf, child)).map(([key]) => key).sort();
  assert.deepEqual(form, [...EDITABLE].sort(),
    'settings.describe() drops an entry whose volatile form is empty, so this is exactly what the Plugins page can edit');
});

test('the manifest declares the client roster edges for both seats', async () => {
  const client = manifest.dsh.client;
  assert.equal(client.platform, 'web');
  assert.deepEqual(client.external ?? [], [], 'the bundle loads no Harness package as a module');
  for (const owner of ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-plugin-manager']) {
    assert.ok(client.inject.includes(owner), `dsh.client.inject must name the slot owner ${owner}`);
  }
});
