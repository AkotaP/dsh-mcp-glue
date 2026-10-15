import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import TOML from '@iarna/toml';
import { setPath } from '../src/serialize.js';
import { createDeclarationEditor } from '../src/edit.js';
import { loadWorkspace } from '../src/load.js';
import { harness, workspace, writeFixture } from './helpers.js';

const signal = () => new AbortController().signal;
const text = (dir, file) => fs.readFile(path.join(dir, file), 'utf8');

/** The editor over one freshly written workspace, plus the plan it reads. */
async function editorFor(t, files, config = {}) {
  const ctx = await harness(t);
  const dir = await workspace(t);
  for (const [file, body] of Object.entries(files)) await writeFixture(dir, file, body);
  const plan = await loadWorkspace(ctx.fs, dir, config);
  return { ctx, dir, plan, editor: createDeclarationEditor({ fs: ctx.fs, config }) };
}

test('a field edit rewrites only that path, and a removal only that entry', async t => {
  const source = [
    '{',
    '  // keep this comment',
    '  "mcpServers": {',
    '    "demo": { "command": "node", "args": ["a"] },',
    '    "other": { "command": "deno", "custom": { "team": true } }',
    '  },',
    '  "unrelated": [1, 2]',
    '}',
  ].join('\n');
  const { dir, plan, editor } = await editorFor(t, { '.mcp.json': source });

  const targets = await editor.list(plan, signal());
  assert.deepEqual(targets.map(target => target.serverId).sort(), ['demo', 'other']);
  const demo = targets.find(target => target.serverId === 'demo');
  assert.equal(demo.preset, 'root');
  assert.equal(demo.file, '.mcp.json');
  assert.equal(demo.editable, true);
  // `transport` is inferred even though the declaration omits `type`: `command` means stdio.
  assert.deepEqual(demo.fields.map(field => field.name).sort(), ['args', 'command', 'cwd', 'env', 'headers', 'transport', 'url']);
  assert.equal(demo.fields.find(field => field.name === 'command').kind, 'text');
  assert.equal(demo.fields.find(field => field.name === 'args').kind, 'list');

  await editor.save(plan, 'demo', [{ name: 'command', value: 'bun' }, { name: 'args', value: ['x', 'y'] }], signal());
  const afterSave = await text(dir, '.mcp.json');
  assert.match(afterSave, /\/\/ keep this comment/, 'the comment survives');
  assert.match(afterSave, /"unrelated": \[/, 'an unrelated top-level key survives');
  assert.match(afterSave, /"custom"/, 'an unknown nested key survives');
  assert.match(afterSave, /"command": "bun"/);
  assert.match(afterSave, /"command": "deno"/, 'the other server is untouched');

  await editor.remove(plan, 'other', signal());
  const afterRemove = await text(dir, '.mcp.json');
  assert.ok(!afterRemove.includes('deno'), 'the removed entry is gone');
  assert.match(afterRemove, /"demo"/, 'its neighbour is not');
  assert.match(afterRemove, /\/\/ keep this comment/);
});

test('a yaml declaration keeps its comments too', async t => {
  const source = [
    '# team declarations',
    'mcp:',
    '  demo: # inline note',
    '    command: node',
    '    args: [a, b]',
    '  left: { command: deno }',
  ].join('\n');
  const config = { enabledBuiltins: [], presets: [{ id: 'mine', files: ['mcp.yaml'], format: 'yaml', serversPaths: ['mcp'] }] };
  const { dir, plan, editor } = await editorFor(t, { 'mcp.yaml': source }, config);

  const targets = await editor.list(plan, signal());
  const demo = targets.find(target => target.serverId === 'demo');
  assert.equal(demo.preset, 'mine');
  assert.deepEqual(demo.fields.map(field => field.name).sort(), ['args', 'command', 'cwd', 'env', 'headers', 'transport', 'url']);

  await editor.save(plan, 'demo', [{ name: 'args', value: ['c'] }], signal());
  const after = await text(dir, 'mcp.yaml');
  assert.match(after, /# team declarations/);
  assert.match(after, /# inline note/);
  assert.match(after, /command: node/);
  assert.match(after, /left: \{ command: deno \}/, 'the other entry is untouched');
});

test('TOML edits require explicit confirmation and preserve unrelated configuration semantics', async t => {
  const source = '# team settings\nmodel = "gpt"\nflags = [true, false]\ncreated = 2024-01-02T03:04:05Z\nprecise = 9223372036854775807\n[profile]\nlimit = 42\n[mcp_servers.demo]\ncommand = "node"\nargs = ["a"]\ncustom = { mode = "keep" }\n[mcp_servers.other]\ncommand = "deno"\n';
  const { dir, plan, editor } = await editorFor(t, { '.codex/config.toml': source });
  const targets = await editor.list(plan, signal());
  const demo = targets.find(target => target.serverId === 'demo');
  assert.equal(demo.editable, true);
  assert.equal(demo.lossy, true);
  assert.match(demo.warning, /整个文件.*注释.*排版.*丢失/);
  const changes = [{ name: 'command', value: 'bun' }, { name: 'args', value: null }];
  for (const options of [undefined, { allowLossy: false }, { allowLossy: 'true' }]) {
    await assert.rejects(editor.save(plan, 'demo', changes, signal(), demo.version, options), { code: 'DECLARATION_CONFIRM_REQUIRED' });
    await assert.rejects(editor.remove(plan, 'other', signal(), undefined, options), { code: 'DECLARATION_CONFIRM_REQUIRED' });
    assert.equal(await text(dir, '.codex/config.toml'), source);
  }
  await editor.save(plan, 'demo', changes, signal(), demo.version, { allowLossy: true });
  const expected = TOML.parse(source);
  expected.mcp_servers.demo.command = 'bun';
  delete expected.mcp_servers.demo.args;
  assert.deepEqual(TOML.parse(await text(dir, '.codex/config.toml')), expected);
  await editor.remove(plan, 'other', signal(), undefined, { allowLossy: true });
  delete expected.mcp_servers.other;
  assert.deepEqual(TOML.parse(await text(dir, '.codex/config.toml')), expected);
});

test('TOML setPath handles own __proto__ keys without traversing or changing prototypes', () => {
  const source = 'untouched = 7\n["__proto__"]\nkeep = "value"\n';
  const next = TOML.parse(setPath(source, 'toml', ['__proto__', 'added'], 'safe'));
  assert.equal(Object.hasOwn(next, '__proto__'), true);
  assert.deepEqual(next.__proto__, { keep: 'value', added: 'safe' });
  const added = TOML.parse(setPath('untouched = 7\n', 'toml', ['__proto__', 'added'], 'safe'));
  assert.equal(Object.hasOwn(added, '__proto__'), true);
  assert.equal(added.__proto__.added, 'safe');
  const removed = TOML.parse(setPath(TOML.stringify(next), 'toml', ['__proto__', 'added'], undefined));
  assert.deepEqual(removed.__proto__, { keep: 'value' });
  const direct = TOML.parse(setPath('untouched = 7\n', 'toml', ['__proto__'], { added: 'safe' }));
  assert.equal(Object.hasOwn(direct, '__proto__'), true);
  assert.equal(direct.__proto__.added, 'safe');
  const deleted = TOML.parse(setPath(TOML.stringify(direct), 'toml', ['__proto__'], undefined));
  assert.equal(Object.hasOwn(deleted, '__proto__'), false);
  assert.equal(Object.prototype.added, undefined);
  assert.equal(removed.untouched, 7);
});

test('a file changed under the editor is a conflict, not an overwrite', async t => {
  const source = '{ "mcpServers": { "demo": { "command": "node" } } }';
  const { dir, plan, editor } = await editorFor(t, { '.mcp.json': source });
  const [listed] = await editor.list(plan, signal());
  assert.ok(typeof listed.version === 'string', 'the listing carries the version the editor read');

  // Someone else edits the file between our read and our write.
  await fs.writeFile(path.join(dir, '.mcp.json'), '{ "mcpServers": { "demo": { "command": "node", "args": ["theirs"] } } }');

  await assert.rejects(editor.save(plan, 'demo', [{ name: 'command', value: 'ours' }], signal(), listed.version), failure => {
    assert.equal(failure.code, 'DECLARATION_STALE');
    return true;
  });
  assert.match(await text(dir, '.mcp.json'), /theirs/, 'their edit is still there');
});

test('a change that would break loading is rolled back byte for byte', async t => {
  const source = '{ "mcpServers": { "demo": { "command": "node" } } }';
  const { dir, plan, editor } = await editorFor(t, { '.mcp.json': source });
  // An empty command parses fine but leaves the entry unusable, so the loader stops reporting the
  // server: the writer has to notice and put back exactly what was there.
  await assert.rejects(editor.save(plan, 'demo', [{ name: 'command', value: '' }], signal()), failure => {
    assert.equal(failure.code, 'DECLARATION_INVALID');
    return true;
  });
  assert.equal(await text(dir, '.mcp.json'), source, 'the file is exactly as it was');
});
test('a new entry creates its declaration file when the file is missing', async t => {
  const { dir, plan, editor } = await editorFor(t, {});
  const result = await editor.write(plan, {
    preset: 'root', name: 'demo',
    fields: [{ name: 'command', value: 'node' }, { name: 'args', value: ['a'] }],
  }, signal());
  assert.equal(result.ok, true);
  assert.equal(result.file, '.mcp.json');
  assert.equal(result.created, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8')), { mcpServers: { demo: { command: 'node', args: ['a'] } } });
});

test('a same-name copy has to be a move, and the move converts the format', async t => {
  const source = '{ "mcpServers": { "demo": { "command": "node", "args": ["a", "b"], "env": { "K": "v" } } } }';
  const { dir, plan, editor } = await editorFor(t, { '.mcp.json': source });

  // Leaving the original behind would put one server name in two declaration files, which the
  // loader resolves by disabling the conflict — so the copy is refused rather than landing and
  // then vanishing on the next load.
  await assert.rejects(
    editor.write(plan, { preset: 'codex', name: 'demo', fromServerId: 'demo' }, signal()),
    failure => {
      // A distinct code from DECLARATION_EXISTS: overwrite cannot help here, so the panel must not
      // offer it — the name has to change, or the entry has to move.
      assert.equal(failure.code, 'DECLARATION_CONFLICT');
      assert.match(failure.message, /冲突/);
      return true;
    },
  );
  assert.deepEqual((await fs.readdir(path.join(dir, '.codex')).catch(() => [])), [], 'nothing was created');

  const result = await editor.write(plan, { preset: 'codex', name: 'demo', fromServerId: 'demo', removeSource: true }, signal());
  assert.equal(result.file, '.codex/config.toml');
  assert.equal(result.created, true);
  assert.equal(result.removedSource, true);
  const toml = await fs.readFile(path.join(dir, '.codex/config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.demo\]/);
  assert.match(toml, /command = "node"/);
  assert.match(toml, /"a"/);
  assert.match(toml, /\[mcp_servers\.demo\.env\]/);
  assert.ok(!(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8')).includes('"demo"'), 'the source moved');
});

test('a copy can clean up after itself, and leaves its neighbours alone', async t => {
  const source = '{ "mcpServers": { "demo": { "command": "node" }, "keep": { "command": "deno" } } }';
  const { dir, plan, editor } = await editorFor(t, { '.mcp.json': source, '.gemini/settings.json': '{ "mcpServers": {} }' });
  const result = await editor.write(plan, { preset: 'gemini', name: 'demo', fromServerId: 'demo', removeSource: true }, signal());
  assert.equal(result.removedSource, true);
  const left = await fs.readFile(path.join(dir, '.mcp.json'), 'utf8');
  assert.ok(!left.includes('"demo"'), 'the source entry is gone');
  assert.match(left, /"keep"/, 'its neighbour is not');
  assert.match(await fs.readFile(path.join(dir, '.gemini/settings.json'), 'utf8'), /"demo"/);
});

test('existing TOML append/overwrite needs consent, and presets expose existence and warning', async t => {
  const source = '# keep settings\nmodel = "gpt"\n[mcp_servers.other]\ncommand = "x"\n';
  const { dir, plan, editor } = await editorFor(t, { '.codex/config.toml': source });
  const presets = await editor.presets(plan, signal());
  const codex = presets.find(entry => entry.id === 'codex');
  assert.equal(codex.editable, true);
  assert.equal(codex.exists, true);
  assert.equal(codex.lossy, true);
  assert.match(codex.warning, /整个文件.*注释.*排版.*丢失/);
  assert.equal(presets.find(entry => entry.id === 'root').exists, false);
  const request = { preset: 'codex', name: 'demo', fields: [{ name: 'command', value: 'node' }] };
  await assert.rejects(editor.write(plan, request, signal()), { code: 'DECLARATION_CONFIRM_REQUIRED' });
  assert.equal(await text(dir, '.codex/config.toml'), source);
  await editor.write(plan, { ...request, allowLossy: true }, signal());
  const expected = TOML.parse(source);
  expected.mcp_servers.demo = { command: 'node' };
  assert.deepEqual(TOML.parse(await text(dir, '.codex/config.toml')), expected);
  const beforeOverwrite = await text(dir, '.codex/config.toml');
  const overwrite = { ...request, overwrite: true, fields: [{ name: 'command', value: 'bun' }] };
  await assert.rejects(editor.write(plan, overwrite, signal()), { code: 'DECLARATION_CONFIRM_REQUIRED' });
  assert.equal(await text(dir, '.codex/config.toml'), beforeOverwrite);
  await editor.write(plan, { ...overwrite, allowLossy: true }, signal());
  expected.mcp_servers.demo.command = 'bun';
  assert.deepEqual(TOML.parse(await text(dir, '.codex/config.toml')), expected);
});

test('a new TOML file needs no lossy confirmation', async t => {
  const { dir, plan, editor } = await editorFor(t, {});
  const codex = (await editor.presets(plan, signal())).find(entry => entry.id === 'codex');
  assert.equal(codex.exists, false);
  assert.equal(codex.lossy, true);
  const result = await editor.write(plan, { preset: 'codex', name: 'demo', fields: [{ name: 'command', value: 'node' }] }, signal());
  assert.equal(result.created, true);
  assert.deepEqual(TOML.parse(await text(dir, '.codex/config.toml')), { mcp_servers: { demo: { command: 'node' } } });
});

test('an existing entry is not overwritten unless the caller asks', async t => {
  const { dir, plan, editor } = await editorFor(t, { '.mcp.json': '{ "mcpServers": { "demo": { "command": "node" } } }' });
  await assert.rejects(
    editor.write(plan, { preset: 'root', name: 'demo', fields: [{ name: 'command', value: 'bun' }] }, signal()),
    failure => failure.code === 'DECLARATION_EXISTS',
  );
  assert.match(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8'), /"node"/, 'nothing was written');
  const replaced = await editor.write(plan, { preset: 'root', name: 'demo', fields: [{ name: 'command', value: 'bun' }], overwrite: true }, signal());
  assert.equal(replaced.created, false);
  assert.match(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8'), /"bun"/);
});

test('an entry needs a name and at least one field', async t => {
  const { plan, editor } = await editorFor(t, {});
  await assert.rejects(editor.write(plan, { preset: 'root', name: '  ', fields: [{ name: 'command', value: 'node' }] }, signal()), /条目名不能为空/);
  await assert.rejects(editor.write(plan, { preset: 'root', name: 'demo', fields: [] }, signal()), /至少要填一个字段/);
});
test('the transport is offered where it can be written, and the url leads', async t => {
  const { dir, plan, editor } = await editorFor(t, { '.mcp.json': '{ "mcpServers": { "demo": { "type": "http", "url": "https://example.test/mcp" } } }' });
  const [demo] = await editor.list(plan, signal());
  assert.deepEqual(demo.fields.map(field => field.name), ['url', 'transport', 'command', 'args', 'env', 'cwd', 'headers'], 'absent fields are available for transport changes');
  assert.equal(demo.fields[0].kind, 'text');
  assert.equal(demo.fields[1].kind, 'choice');
  assert.deepEqual(demo.fields[1].options, ['stdio', 'http'], 'SSE is not in the loader vocabulary');

  // A transport the loader would refuse is caught at the form, not written and rolled back.
  await assert.rejects(
    editor.save(plan, 'demo', [{ name: 'transport', value: 'sse' }], signal(), demo.version),
    failure => failure.code === 'DECLARATION_INVALID' && /不支持的调用方式/.test(failure.message),
  );

  // Switching to stdio needs the fields that make stdio valid: a command, and the stale url gone
  // (a `url` on a stdio server is exactly what the loader would refuse). A null value deletes the
  // key, which is how a form expresses "this field no longer applies".
  await editor.save(plan, 'demo', [
    { name: 'transport', value: 'stdio' },
    { name: 'command', value: 'node' },
    { name: 'url', value: null },
  ], signal(), demo.version);
  const after = JSON.parse(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8'));
  assert.deepEqual(after.mcpServers.demo, { type: 'stdio', command: 'node' });
});

test('a dialect without a transport field is not offered one, and refuses to write one', async t => {
  const config = { enabledBuiltins: ['root', 'codex', 'gemini'] };
  const { plan, editor } = await editorFor(t, { '.mcp.json': '{ "mcpServers": {} }' }, config);
  const presets = await editor.presets(plan, signal());
  const by = id => presets.find(entry => entry.id === id);
  assert.deepEqual(by('root').fields.map(field => field.name), ['url', 'transport', 'command', 'args', 'env', 'cwd', 'headers']);
  assert.ok(!by('codex').fields.some(field => field.name === 'transport'), 'codex has no such key');
  assert.ok(!by('gemini').fields.some(field => field.name === 'transport'), 'gemini implies it from url vs httpUrl');
  assert.equal(by('codex').dialect, 'codex');

  await assert.rejects(
    editor.write(plan, { preset: 'gemini', name: 'remote', fields: [{ name: 'transport', value: 'http' }, { name: 'url', value: 'https://x.test/mcp' }] }, signal()),
    failure => failure.code === 'DECLARATION_UNSUPPORTED',
  );
});

test('a new remote server can be created with its transport', async t => {
  const { dir, plan, editor } = await editorFor(t, {});
  const result = await editor.write(plan, {
    preset: 'root', name: 'remote',
    fields: [{ name: 'url', value: 'https://x.test/mcp' }, { name: 'transport', value: 'http' }],
  }, signal());
  assert.equal(result.created, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, '.mcp.json'), 'utf8')), {
    mcpServers: { remote: { type: 'http', url: 'https://x.test/mcp' } },
  });
});
test('a custom preset decides for itself whether it has a transport', async t => {
  const config = {
    enabledBuiltins: [],
    presets: [
      { id: 'plain', files: ['plain.json'], serversPaths: ['servers'] },
      { id: 'nokind', files: ['nokind.json'], serversPaths: ['servers'], fields: { transport: '' } },
      { id: 'foreign', files: ['foreign.yaml'], format: 'yaml', serversPaths: ['servers'], dialect: 'gemini' },
    ],
  };
  const { plan, editor } = await editorFor(t, {}, config);
  const presets = await editor.presets(plan, signal());
  const by = id => presets.find(entry => entry.id === id);
  assert.ok(by('plain').fields.some(field => field.name === 'transport'), 'no dialect means standard, so it has one');
  assert.ok(!by('nokind').fields.some(field => field.name === 'transport'), 'mapping it to nothing opts out');
  assert.ok(!by('foreign').fields.some(field => field.name === 'transport'), 'a non-standard dialect never has one');

  await assert.rejects(
    editor.write(plan, { preset: 'nokind', name: 'x', fields: [{ name: 'transport', value: 'http' }] }, signal()),
    failure => failure.code === 'DECLARATION_UNSUPPORTED',
  );
});



