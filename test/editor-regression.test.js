import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDeclarationEditor } from '../src/edit.js';
import { loadWorkspace } from '../src/load.js';
import { harness, workspace, writeFixture } from './helpers.js';

const signal = () => new AbortController().signal;
async function setup(t, files = {}, config = {}) {
  const ctx = await harness(t);
  const dir = await workspace(t);
  for (const [file, value] of Object.entries(files)) await writeFixture(dir, file, value);
  const plan = await loadWorkspace(ctx.fs, dir, config);
  return { dir, plan, ctx, editor: createDeclarationEditor({ fs: ctx.fs, config }) };
}
async function client() {
  const source = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let entry;
  new Function('window', source)({ __ModuleLoader__: { load: value => { entry = value; } } });
  return entry.factory(createRequire(import.meta.url)).__internals;
}

test('new field metadata uses arrays and objects, including absent fields on existing entries', async t => {
  const { editor, plan } = await setup(t, { '.mcp.json': '{"mcpServers":{"demo":{"command":"node"}}}' });
  const preset = (await editor.presets(plan, signal())).find(item => item.id === 'root');
  for (const fields of [preset.fields, (await editor.list(plan, signal()))[0].fields]) {
    assert.equal(fields.find(field => field.name === 'args').kind, 'list');
    assert.equal(fields.find(field => field.name === 'env').kind, 'map');
    assert.equal(fields.find(field => field.name === 'headers').kind, 'map');
  }
});

test('new entries use the existing servers table rather than introducing an ambiguous second table', async t => {
  const { editor, plan, dir, ctx } = await setup(t, { '.mcp.json': '{"servers":{"keep":{"command":"node"}}}' });
  await editor.write(plan, { preset: 'root', name: 'demo', fields: [{ name: 'command', value: 'node' }] }, signal());
  const doc = JSON.parse(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8'));
  assert.equal(doc.mcpServers, undefined);
  assert.ok(doc.servers.keep && doc.servers.demo);
  assert.equal((await loadWorkspace(ctx.fs, dir)).servers.length, 2);
});

test('an invalid new entry is rejected and restores an existing declaration exactly', async t => {
  const original = '{\n// preserve\n"mcpServers": {"keep":{"command":"node"}}\n}';
  const { editor, plan, dir } = await setup(t, { '.mcp.json': original });
  await assert.rejects(editor.write(plan, { preset: 'root', name: 'bad', fields: [{ name: 'command', value: 'node' }, { name: 'args', value: 'not-an-array' }] }, signal()), { code: 'DECLARATION_INVALID' });
  assert.equal(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8'), original);
});

test('a failed migration restores both the source and destination', async t => {
  const source = '{"mcpServers":{"demo":{"command":"node"}}}';
  const destination = '{"servers":{}}';
  const { editor, plan, dir } = await setup(t, { '.mcp.json': source, '.vscode/mcp.json': destination });
  await assert.rejects(editor.write(plan, { preset: 'vscode', name: 'demo', fromServerId: 'demo', removeSource: true, fields: [{ name: 'command', value: '' }] }, signal()), { code: 'DECLARATION_INVALID' });
  assert.equal(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8'), source);
  assert.equal(await fs.readFile(path.join(dir, '.vscode/mcp.json'), 'utf8'), destination);
});

test('TOML migration refuses before creating its destination until explicitly confirmed', async t => {
  const source = '# original\nmodel = "gpt"\n[mcp_servers.demo]\ncommand = "node"\n';
  const { editor, plan, dir } = await setup(t, { '.codex/config.toml': source });
  const request = { preset: 'root', name: 'demo', fromServerId: 'demo', removeSource: true };
  await assert.rejects(editor.write(plan, request, signal()), { code: 'DECLARATION_CONFIRM_REQUIRED' });
  await assert.rejects(fs.stat(path.join(dir, '.mcp.json')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(dir, '.codex/config.toml'), 'utf8'), source);
  const moved = await editor.write(plan, { ...request, allowLossy: true }, signal());
  assert.equal(moved.removedSource, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8')), { mcpServers: { demo: { command: 'node' } } });
  const remaining = await fs.readFile(path.join(dir, '.codex/config.toml'), 'utf8');
  assert.match(remaining, /model = "gpt"/);
  assert.doesNotMatch(remaining, /command|mcp_servers\.demo/);
});

test('a confirmed TOML save and append roll back the original bytes when validation fails', async t => {
  const source = '# preserve exact bytes on failure\nmodel="gpt"\n[mcp_servers.demo]\ncommand="node"\n';
  const { editor, plan, dir } = await setup(t, { '.codex/config.toml': source });
  await assert.rejects(editor.save(plan, 'demo', [{ name: 'command', value: '' }], signal(), undefined, { allowLossy: true }), { code: 'DECLARATION_INVALID' });
  assert.equal(await fs.readFile(path.join(dir, '.codex/config.toml'), 'utf8'), source);
  await assert.rejects(editor.write(plan, { preset: 'codex', name: 'bad', allowLossy: true, fields: [{ name: 'command', value: '' }] }, signal()), { code: 'DECLARATION_INVALID' });
  assert.equal(await fs.readFile(path.join(dir, '.codex/config.toml'), 'utf8'), source);
});

test('a failed confirmed TOML migration restores source and destination byte for byte', async t => {
  const source = '# source comments\n[mcp_servers.demo]\ncommand = "node"\n';
  const destination = '{\n// destination comments\n"mcpServers":{}\n}';
  const { editor, plan, dir } = await setup(t, { '.codex/config.toml': source, '.mcp.json': destination });
  await assert.rejects(editor.write(plan, { preset: 'root', name: 'demo', fromServerId: 'demo', removeSource: true, allowLossy: true, fields: [{ name: 'command', value: '' }] }, signal()), { code: 'DECLARATION_INVALID' });
  assert.equal(await fs.readFile(path.join(dir, '.codex/config.toml'), 'utf8'), source);
  assert.equal(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8'), destination);
});

test('confirmed TOML save/remove still reject stale version tokens', async t => {
  const { editor, plan, dir } = await setup(t, { '.codex/config.toml': '[mcp_servers.demo]\ncommand = "node"\n' });
  const [target] = await editor.list(plan, signal());
  const changed = '# concurrent edit\n[mcp_servers.demo]\ncommand = "bun"\n';
  await writeFixture(dir, '.codex/config.toml', changed);
  await assert.rejects(editor.save(plan, 'demo', [{ name: 'command', value: 'deno' }], signal(), target.version, { allowLossy: true }), { code: 'DECLARATION_STALE' });
  await assert.rejects(editor.remove(plan, 'demo', signal(), target.version, { allowLossy: true }), { code: 'DECLARATION_STALE' });
  assert.equal(await fs.readFile(path.join(dir, '.codex/config.toml'), 'utf8'), changed);
});

test('same-file copy aliases cannot delete their own destination', async t => {
  const config = { presets: [{ id: 'alias', extends: 'root' }] };
  const original = '{"mcpServers":{"demo":{"command":"node"}}}';
  const { editor, plan, dir } = await setup(t, { '.mcp.json': original }, config);
  await assert.rejects(editor.write(plan, { preset: 'alias', name: 'demo', fromServerId: 'demo', removeSource: true, overwrite: true }, signal()), { code: 'DECLARATION_CONFLICT' });
  assert.equal(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8'), original);
});

test('mapped command fields infer transport, and opting out of a stored transport still loads', async t => {
  const config = { enabledBuiltins: [], presets: [
    { id: 'mapped', files: ['mapped.json'], serversPaths: ['servers'], fields: { command: 'process.executable', url: 'connection.url' } },
    { id: 'implicit', files: ['implicit.json'], serversPaths: ['servers'], fields: { transport: '' } },
  ] };
  const { editor, plan } = await setup(t, { 'mapped.json': '{"servers":{"demo":{"process":{"executable":"node"}}}}', 'implicit.json': '{"servers":{"other":{"command":"node"}}}' }, config);
  assert.equal(plan.servers.length, 2);
  const targets = await editor.list(plan, signal());
  assert.equal(targets.find(item => item.serverId === 'demo').fields.find(field => field.name === 'transport').value, 'stdio');
  assert.ok(!targets.find(item => item.serverId === 'other').fields.some(field => field.name === 'transport'));
});

test('stdio/http forms render only the relevant fields, with multiline args and maps', async () => {
  const { DeclarationWriteView, visibleFields, writeFieldsOf } = await client();
  const fields = [
    { name: 'url', kind: 'text' }, { name: 'transport', kind: 'choice', options: ['stdio', 'http'] },
    { name: 'command', kind: 'text' }, { name: 'args', kind: 'list' },
    { name: 'env', kind: 'map' }, { name: 'cwd', kind: 'text' }, { name: 'headers', kind: 'map' },
  ];
  const render = transport => renderToStaticMarkup(React.createElement(DeclarationWriteView, {
    preset: { id: 'root', fields }, fields, mode: 'create', name: 'demo', drafts: { transport },
  }));
  assert.deepEqual(visibleFields(fields, { transport: 'http' }).map(field => field.name), ['transport', 'url', 'headers']);
  assert.deepEqual(visibleFields(fields, { transport: 'stdio' }).map(field => field.name), ['transport', 'command', 'args', 'env', 'cwd']);
  assert.equal((render('stdio').match(/<textarea/g) ?? []).length, 2);
  assert.equal((render('http').match(/<textarea/g) ?? []).length, 1);
  assert.doesNotMatch(render('http'), />command</);
  assert.doesNotMatch(render('stdio'), />url</);
  assert.deepEqual(writeFieldsOf({ transport: 'http', url: 'https://example.test/mcp', env: 'broken hidden JSON' }, fields), [
    { name: 'url', value: 'https://example.test/mcp' }, { name: 'transport', value: 'http' },
  ]);
});

test('switching transport deletes incompatible stored fields but keeps inactive drafts out of parsing', async () => {
  const { changesOfTarget, draftsOfTarget, valueOfDraft } = await client();
  const target = { fields: [
    { name: 'transport', kind: 'choice', value: 'stdio' }, { name: 'command', kind: 'text', value: 'node' },
    { name: 'env', kind: 'map', value: {} }, { name: 'url', kind: 'text' },
  ] };
  assert.deepEqual(changesOfTarget(target, draftsOfTarget(target)), []);
  assert.deepEqual(changesOfTarget(target, { ...draftsOfTarget(target), transport: 'http', env: 'broken hidden JSON', url: 'https://example.test/mcp' }), [
    { name: 'transport', value: 'http' }, { name: 'command', value: null }, { name: 'env', value: null }, { name: 'url', value: 'https://example.test/mcp' },
  ]);
  assert.deepEqual(valueOfDraft({ name: 'env', kind: 'map' }, '{"PORT":3000}'), { PORT: 3000 });
});

test('copying advanced tool restrictions fails closed instead of widening access', async t => {
  const { editor, plan, dir } = await setup(t, { '.mcp.json': '{"mcpServers":{"demo":{"command":"node","excludeTools":["danger"]}}}' });
  await assert.rejects(editor.write(plan, { preset: 'vscode', name: 'renamed', fromServerId: 'demo' }, signal()), { code: 'DECLARATION_UNSUPPORTED' });
  await assert.rejects(fs.stat(path.join(dir, '.vscode/mcp.json')), { code: 'ENOENT' });
});

test('transport switching also removes auxiliary environment forwarding', async t => {
  const { editor, plan, dir } = await setup(t, { '.mcp.json': '{"mcpServers":{"demo":{"command":"node","env_vars":[]}}}' });
  await editor.save(plan, 'demo', [
    { name: 'transport', value: 'http' }, { name: 'command', value: null }, { name: 'url', value: 'https://example.test/mcp' },
  ], signal());
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.demo, { type: 'http', url: 'https://example.test/mcp' });
});

test('lossy editable TOML entries expose values for inspection and renamed copying', async t => {
  const { editor, plan } = await setup(t, { '.codex/config.toml': '[mcp_servers.demo]\ncommand = "node"\nargs = ["a"]\n' });
  const [target] = await editor.list(plan, signal());
  assert.equal(target.editable, true);
  assert.equal(target.lossy, true);
  assert.equal(target.fields.find(field => field.name === 'command').value, 'node');
  assert.deepEqual(target.fields.find(field => field.name === 'args').value, ['a']);
});
