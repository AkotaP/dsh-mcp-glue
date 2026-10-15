import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const source = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
function load(react = React) {
  let entry;
  new Function('window', source)({ __ModuleLoader__: { load: value => { entry = value; } } });
  return entry.factory(name => name === 'react' ? react : name === 'react-dom' ? { createPortal: value => value } : require(name)).__internals;
}
/** Deterministic hook state, for testing the manager's event transitions without a DOM dependency. */
function mount(props) {
  let cursor = 0;
  const slots = [];
  const fake = { ...React,
    useState(initial) { const at = cursor++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial;
      return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value; }]; },
    useRef(initial) { const at = cursor++; if (!(at in slots)) slots[at] = { current: initial }; return slots[at]; },
    useEffect() { cursor++; },
  };
  const internals = load(fake);
  return { internals, props, render() { cursor = 0; return internals.DeclarationManager(this.props); } };
}
function all(tree) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return [];
  return [tree, ...React.Children.toArray(tree.props?.children).flatMap(all)];
}
const viewOf = (tree, name) => all(tree).find(node => node.type?.name === name);
const button = (tree, text) => all(tree).find(node => node.type === 'button' && node.props.children === text);
const tick = () => new Promise(resolve => setImmediate(resolve));
const fields = [
  { name: 'url', kind: 'text' }, { name: 'transport', kind: 'choice', options: ['stdio', 'http'] },
  { name: 'command', kind: 'text' }, { name: 'args', kind: 'list' }, { name: 'env', kind: 'map' },
  { name: 'cwd', kind: 'text' }, { name: 'headers', kind: 'map' },
];
const preset = (over = {}) => ({ id: 'root', files: ['.mcp.json'], format: 'jsonc', editable: true, fields, exists: true, ...over });
const target = (over = {}) => ({ serverId: 'demo', file: '.mcp.json', preset: 'root', format: 'jsonc', editable: true, version: 'v1',
  fields: fields.map(field => ({ ...field, value: field.name === 'command' ? 'node' : field.name === 'transport' ? 'stdio' : undefined })), ...over });
const payload = (over = {}) => ({ writable: true, presets: [preset(), preset({ id: 'codex', format: 'toml', files: ['.codex/config.toml'], lossy: true })], targets: [target()], ...over });
const noop = () => {};
const props = (over = {}) => ({ payload: payload(), workspace: 'D:\\project', busy: false, onClose: noop, onReload: noop,
  onSave: async () => true, onRemove: async () => true, onWrite: async () => 'ok', ...over });

test('direct create opens a form with a configuration-location selector, not a chooser', () => {
  const ui = load();
  const markup = renderToStaticMarkup(React.createElement(ui.DeclarationManager, props({ initial: { mode: 'create' } })));
  assert.match(markup, /新建服务器/);
  assert.match(markup, /aria-label="配置位置"/);
  assert.match(markup, /项目配置（推荐）/);
  assert.match(markup, /启动命令/);
  assert.match(markup, /＋ 添加环境变量/);
  assert.doesNotMatch(markup, /选目标预设/);
  assert.equal((markup.match(/aria-modal="true"/g) ?? []).length, 1);
  assert.match(markup, /wmcp-manager-sidebar/);
});

test('create default prefers a writable project location and skips unwritable presets', () => {
  const { preferredPreset, makeWriteForm } = load();
  const list = payload({ presets: [preset({ id: 'custom' }), preset()] });
  assert.equal(preferredPreset(list, 'D:\\p').id, 'root');
  list.presets[1].editable = false;
  assert.equal(preferredPreset(list, 'D:\\p').id, 'custom');
  assert.equal(makeWriteForm(list.presets[0]).drafts.transport, 'stdio');
  assert.equal(makeWriteForm(preset({ fields: fields.filter(field => field.name !== 'transport') })).drafts.$transport, 'stdio');
});

test('changing configuration location preserves typed fields and switches to a UI-only transport for Codex', () => {
  const h = mount(props({ initial: { mode: 'create' } }));
  let form = viewOf(h.render(), 'DeclarationWriteView');
  form.props.onName('remote'); form.props.onChange('transport', 'http'); form.props.onChange('url', 'https://example.test/mcp');
  form = viewOf(h.render(), 'DeclarationWriteView');
  form.props.onPreset(preset({ id: 'codex', format: 'toml', files: ['.codex/config.toml'], fields: fields.filter(field => field.name !== 'transport') }));
  form = viewOf(h.render(), 'DeclarationWriteView');
  assert.equal(form.props.name, 'remote');
  assert.equal(form.props.drafts.url, 'https://example.test/mcp');
  assert.equal(form.props.drafts.$transport, 'http');
  assert.ok(!form.props.fields.some(field => field.name === 'transport'));
});

test('dirty navigation asks before discarding, and cancelling preserves the form', () => {
  let closed = 0;
  const h = mount(props({ initial: { mode: 'create' }, onClose: () => { closed++; } }));
  viewOf(h.render(), 'DeclarationWriteView').props.onName('unsaved');
  all(h.render()).find(node => node.props?.['aria-label'] === '关闭 MCP 管理').props.onClick();
  let confirmation = viewOf(h.render(), 'ManagerConfirmation');
  assert.equal(confirmation.props.confirmation.kind, 'discard'); assert.equal(closed, 0);
  confirmation.props.onCancel();
  assert.equal(viewOf(h.render(), 'DeclarationWriteView').props.name, 'unsaved');
  all(h.render()).find(node => node.props?.['aria-label'] === '关闭 MCP 管理').props.onClick();
  confirmation = viewOf(h.render(), 'ManagerConfirmation'); confirmation.props.onConfirm();
  assert.equal(closed, 1);
});

test('TOML save is separately confirmed, carries the original file version, and does not connect by default', async () => {
  const calls = [];
  const toml = target({ format: 'toml', file: '.codex/config.toml', preset: 'codex', lossy: true });
  const h = mount(props({ payload: payload({ targets: [toml] }), onSave: async (...args) => { calls.push(args); return true; } }));
  viewOf(h.render(), 'DeclarationEditorView').props.onChange('command', 'bun');
  viewOf(h.render(), 'DeclarationEditorView').props.onSave();
  const confirmation = viewOf(h.render(), 'ManagerConfirmation');
  assert.equal(confirmation.props.confirmation.kind, 'toml'); assert.equal(calls.length, 0);
  confirmation.props.onConfirm(); await tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][2], { version: 'v1', allowLossy: true, connect: false });
});

test('TOML append is confirmed, a new TOML file is not, and connect is an explicit action', async () => {
  for (const exists of [true, false]) {
    const calls = [];
    const codex = preset({ id: 'codex', format: 'toml', files: ['.codex/config.toml'], lossy: true, exists });
    const h = mount(props({ initial: { mode: 'create' }, payload: payload({ presets: [codex] }), onWrite: async spec => { calls.push(spec); return 'ok'; } }));
    let form = viewOf(h.render(), 'DeclarationWriteView'); form.props.onName('new'); form.props.onChange('command', 'node');
    form = viewOf(h.render(), 'DeclarationWriteView'); form.props.onSubmitConnect();
    if (exists) { assert.equal(calls.length, 0); viewOf(h.render(), 'ManagerConfirmation').props.onConfirm(); }
    await tick();
    assert.equal(calls.length, 1); assert.equal(calls[0].connect, true); assert.equal(calls[0].allowLossy === true, exists);
  }
});

test('TOML delete confirmation includes whole-file rewrite warning', () => {
  const ui = load();
  const markup = renderToStaticMarkup(React.createElement(ui.ManagerConfirmation, {
    confirmation: { kind: 'delete', name: 'demo', file: '.codex/config.toml', lossy: true }, onCancel: noop, onConfirm: noop,
  }));
  assert.match(markup, /注释和排版可能丢失/);
  assert.match(markup, /确认删除/);
});

test('backend confirmation-required race opens a warning instead of retrying silently', async () => {
  let calls = 0;
  const h = mount(props({ onSave: async () => { calls++; return 'confirm'; } }));
  viewOf(h.render(), 'DeclarationEditorView').props.onChange('command', 'bun');
  viewOf(h.render(), 'DeclarationEditorView').props.onSave(); await tick();
  assert.equal(calls, 1);
  assert.equal(viewOf(h.render(), 'ManagerConfirmation').props.confirmation.kind, 'toml');
});

test('key/value drafts reject missing or duplicate keys and preserve numeric env values and prototype-looking keys', () => {
  const { draftOfMapRows, mapStateOf } = load();
  assert.throws(() => draftOfMapRows([{ key: '', value: 'secret' }]), /键名/);
  assert.throws(() => draftOfMapRows([{ key: 'X', value: 'a' }, { key: 'X', value: 'b' }]), /重复/);
  assert.equal(draftOfMapRows([{ key: '', value: '' }]), '');
  assert.deepEqual(JSON.parse(draftOfMapRows([{ key: '__proto__', value: 'literal' }, { key: 'PORT', value: 42 }])), JSON.parse('{"__proto__":"literal","PORT":42}'));
  assert.equal(mapStateOf({ name: 'env', kind: 'map' }, '{"PORT":42}').rows[0].value, 42);
  assert.equal(mapStateOf({ name: 'env', kind: 'map' }, '{oops').mode, 'json');
});

test('the tools count is a generous, labelled expand button; the quick panel has no auto-connect switch', () => {
  const ui = load();
  const markup = renderToStaticMarkup(React.createElement(ui.ServerRow, {
    row: { id: 'unityMCP', state: 'connected', tools: ['tool'] }, allowance: {}, showPolicy: false,
    expanded: false, writable: true, onToggleExpand: noop, onAct: noop, onEdit: noop,
  }));
  assert.match(markup, /class="wmcp-tools-trigger"/);
  assert.match(markup, /工具（1）/);
  assert.match(markup, /aria-label="展开 unityMCP 的工具列表"/);
  assert.match(markup, /class="wmcp-tools-arrow" aria-hidden="true">▾<\/span>/);
  assert.doesNotMatch(markup, /aria-label="自动连接/);
  assert.match(ui.CSS, /\.wmcp-tools-trigger\{[^}]*min-height:32px/);
});

test('the trust shortcut remains in the quick panel and is shared with management', () => {
  assert.match(source, /\.\.\.body,\s*trustRow,\s*footer/);
  assert.match(source, /policy: React\.createElement\(React\.Fragment, null, \[trustRow/);
});

test('an incomplete connection is blocked before editing an existing declaration', () => {
  const h = mount(props());
  viewOf(h.render(), 'DeclarationEditorView').props.onChange('command', '');
  assert.match(viewOf(h.render(), 'DeclarationEditorView').props.problem, /启动命令/);
});

test('lossy consent is explicit on the wire, while UI-only connect never reaches declaration endpoints', async () => {
  const ui = load(); const calls = [];
  const send = async (path, body) => { calls.push(body); };
  await ui.saveDeclaration(send, 's', 'demo', [], 'v1', { allowLossy: true });
  await ui.removeDeclaration(send, 's', 'demo', 'v1', { allowLossy: 'true' });
  await ui.writeDeclaration(send, 's', { preset: 'codex', name: 'new', fields: [], allowLossy: true, connect: true });
  assert.equal(calls[0].allowLossy, true);
  assert.ok(!('allowLossy' in calls[1]));
  assert.equal(calls[2].allowLossy, true);
  assert.ok(!('connect' in calls[2]));
});
