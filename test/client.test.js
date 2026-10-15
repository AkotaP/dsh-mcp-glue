import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = path.resolve(import.meta.dirname, '..');
const bundlePath = path.join(root, 'lib/client.js');
const require = createRequire(import.meta.url);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

/** The browser module table's baseline: every page has these, and nothing else is guaranteed. */
const BASELINE = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']);

/** Execute the built bundle exactly as the shell does, and return its exports. */
async function loadClientBundle() {
  const source = await fs.readFile(bundlePath, 'utf8');
  let entry;
  const window = { __ModuleLoader__: { load: value => { entry = value; } } };
  // The bundle is a classic script; evaluate it with `window` bound like a page global.
  new Function('window', source)(window);
  assert.ok(entry, 'bundle registered a module entry');
  return { entry, window, source, exports: entry.factory(require) };
}

/** The opening tag of the one button whose accessible name is exactly `label`. */
function controlFor(markup, label) {
  const at = markup.indexOf(`aria-label="${label}"`);
  assert.ok(at > 0, `no control is labelled "${label}"`);
  const start = markup.lastIndexOf('<button', at);
  const end = markup.indexOf('>', at);
  return markup.slice(start, end + 1);
}

test('built bundle registers the package id and a lazy CJS factory', async () => {
  const { entry, exports } = await loadClientBundle();
  assert.equal(entry.id, manifest.name);
  assert.equal(typeof entry.factory, 'function');
  assert.deepEqual(exports.inject, ['slots', 'locale']);
  assert.equal(typeof exports.apply, 'function');
});

test('the bundle loads no Harness Client package', async () => {
  const { source } = await loadClientBundle();
  const externals = new Set(manifest.dsh?.client?.external ?? []);
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
  assert.ok(required.length > 0, 'the factory requires React from the seed table');
  for (const specifier of required) {
    assert.ok(!specifier.startsWith('@deepseek-ai/'),
      `the client half must not load the Harness package "${specifier}": dsh.client.inject only orders activation, and one throwing import blanks the slot entry`);
    assert.ok(BASELINE.has(specifier) || externals.has(specifier),
      `"${specifier}" is neither a baseline module nor declared in dsh.client.external`);
  }
});

test('the manifest declares the client activation edges for both seats', async () => {
  assert.equal(manifest.dsh?.client?.platform, 'web');
  const inject = manifest.dsh?.client?.inject ?? [];
  for (const owner of ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-plugin-manager']) {
    assert.ok(inject.includes(owner), `dsh.client.inject must name the slot owner ${owner}`);
  }
});

test('client plugin registers the composer control and the bundle page', async () => {
  const { exports } = await loadClientBundle();
  const injections = [];
  const registrations = [];
  const ctx = {
    slots: {
      inject(key, callback) { injections.push(key); return callback(); },
      register(descriptor, component) { registrations.push({ descriptor, component }); return () => {}; },
    },
  };
  exports.apply(ctx);
  assert.deepEqual(injections, ['conversation.input.left', 'plugins.bundle.config']);
  assert.equal(registrations.length, 2);
  const [chip, manager] = registrations;
  assert.equal(chip.descriptor.name, 'conversation.input.left');
  assert.equal(chip.descriptor.id, 'workspace-mcp');
  assert.deepEqual(chip.descriptor.inject('session-42'), { sessionId: 'session-42' });
  assert.equal(typeof chip.component, 'function');
  // The bundle page seat is keyed by the package name the host dispatches with.
  assert.equal(manager.descriptor.name, 'plugins.bundle.config');
  assert.equal(manager.descriptor.key, manifest.name);
  assert.equal(typeof manager.component, 'function');
});

test('the client half registers zh/en dictionaries and translates through the locale service', async () => {
  const { exports } = await loadClientBundle();
  const { t, NS, dictOf } = exports.__internals;
  // Without a locale service the zh column answers, so an offline render stays readable.
  assert.equal(t('action.connect'), '连接');
  assert.equal(t('row.editAria', { id: 'demo' }), '编辑 demo');
  assert.equal(t('row.manageAria', { id: 'demo' }), '管理 demo');
  assert.equal(t('missing.key'), 'missing.key');
  // Both columns are complete and the English one carries no leftover Chinese.
  const columns = { zh: dictOf(0), en: dictOf(1) };
  assert.deepEqual(Object.keys(columns.zh).sort(), Object.keys(columns.en).sort());
  assert.ok(Object.keys(columns.en).length > 100, 'the dictionary covers the whole half');
  for (const [key, value] of Object.entries(columns.en)) {
    assert.ok(!/[\u4e00-\u9fff]/.test(value), `en copy for ${key} still contains Chinese`);
    assert.ok(value.length > 0, `en copy for ${key} is empty`);
  }
  const registered = [];
  let active = 'en';
  const ctx = {
    slots: { inject(key, callback) { return callback(); }, register() { return () => {}; } },
    effect(callback) { return callback(); },
    locale: {
      register(ns, dictionaries) { registered.push({ ns, dictionaries, dispose: () => {} }); return () => {}; },
      bind() {
        return (key, params) => {
          const template = columns[active][key] ?? key;
          return params === undefined ? template
            : template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
        };
      },
    },
  };
  exports.apply(ctx);
  assert.equal(registered.length, 1, 'the dictionaries register once, as an owned effect');
  assert.equal(registered[0].ns, NS);
  assert.deepEqual(Object.keys(registered[0].dictionaries), ['zh', 'en']);
  assert.equal(t('action.connect'), 'Connect');
  assert.equal(t('row.editAria', { id: 'demo' }), 'Edit demo');
  assert.equal(t('state.unloaded'), 'Not loaded');
  // Switching the active locale switches the copy with no reload.
  active = 'zh';
  assert.equal(t('action.connect'), '连接');
});

test('preset drafts round-trip into the validated config payload', async () => {
  const { exports } = await loadClientBundle();
  const { draftToPresets, toDraft } = exports.__internals;
  const preset = {
    id: 'team-tools',
    extends: 'vscode',
    files: ['.team/mcp.yaml'],
    serversPaths: ['/integrations/mcp'],
    format: 'yaml',
    dialect: 'standard',
    interpolation: 'shell',
    fields: { command: 'executable', args: 'arguments' },
  };
  assert.deepEqual(draftToPresets([toDraft(preset)]), [preset]);
  assert.equal(draftToPresets([{ ...toDraft(preset), extends: '  ', fields: '{}' }])[0].extends, undefined);
  assert.throws(() => draftToPresets([{ ...toDraft(preset), id: ' ' }]), /id/);
  assert.throws(() => draftToPresets([toDraft(preset), toDraft(preset)]), /重复/);
  assert.throws(() => draftToPresets([{ ...toDraft(preset), files: '  \n ' }]), /文件位置/);
  assert.throws(() => draftToPresets([{ ...toDraft(preset), fields: '{oops' }]), /JSON/);
  assert.throws(() => draftToPresets([{ ...toDraft(preset), fields: '{"command":1}' }]), /字符串/);
});

test('the chip summary mirrors the panel rows with severity precedence', async () => {
  const { exports } = await loadClientBundle();
  const { chipSummary, allSelected } = exports.__internals;
  const status = states => ({
    servers: states.map(state => ({ id: state, state })),
    counts: {
      declarations: states.length,
      connected: states.filter(state => state === 'connected').length,
      selected: states.length,
    },
  });

  // Nothing read yet, and a workspace with no declaration at all: neutral, not a warning.
  assert.deepEqual(chipSummary(undefined, undefined), { state: 'idle', label: 'MCP', aria: '工作区 MCP：无声明' });
  assert.deepEqual(chipSummary(status([]), undefined), { state: 'idle', label: 'MCP', aria: '工作区 MCP：无声明' });

  // All rows green is the only path to green.
  assert.equal(chipSummary(status(['connected', 'connected', 'connected']), undefined).state, 'connected');

  // One amber row and no red row turns the chip amber.
  assert.equal(chipSummary(status(['connected', 'unloaded']), undefined).state, 'unauthorized');
  assert.equal(chipSummary(status(['unauthorized']), undefined).state, 'unauthorized');

  // One red row wins over any number of amber or green rows.
  assert.equal(chipSummary(status(['connected', 'unloaded', 'failed']), undefined).state, 'failed');
  assert.equal(chipSummary(status(['connected', 'invalid']), undefined).state, 'failed');
  assert.equal(chipSummary(status(['failed', 'failed', 'failed']), undefined).state, 'failed');

  // A row that is neither (a pending one, mid-mount) neither escalates nor turns it green.
  assert.equal(chipSummary(status(['connected', 'pending']), undefined).state, 'idle');

  // The control channel itself is red on its own: those are the cases with no rows to read.
  assert.equal(chipSummary(undefined, 'HTTP 403').state, 'failed');
  assert.equal(chipSummary(status(['connected']), 'HTTP 403').state, 'failed');

  // Text and accessible name still come from the counts.
  assert.deepEqual(chipSummary(status(['connected', 'connected', 'failed']), undefined),
    { state: 'failed', label: 'MCP 2/3', aria: '工作区 MCP：2/3 已连接' });

  assert.equal(allSelected({ counts: { selected: 0 }, loaded: false }), false);
  assert.equal(allSelected({ counts: { selected: 1 }, loaded: false }), true);
  assert.equal(allSelected({ counts: { selected: 2 }, loaded: true }), true);
});

test('control requests take the injected token, else the handshake, and retry once on 403', async () => {
  const { window, exports } = await loadClientBundle();
  const { request } = exports.__internals;
  const calls = [];
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
  globalThis.fetch = async (url, init = {}) => {
    const token = init.headers?.['x-workspace-mcp-token'];
    calls.push({ url: String(url), token });
    if (String(url).endsWith('/handshake')) return reply(200, { token: 'fresh' });
    if (token === 'fresh' || token === 'injected') return reply(200, { ok: true });
    return reply(403, { error: 'stale workspace MCP token' });
  };
  try {
    window.__WORKSPACE_MCP_TOKEN__ = 'injected';
    assert.deepEqual(await request('/status?sessionId=s'), { ok: true });
    assert.equal(calls.at(-1).token, 'injected');
    assert.ok(!calls.some(call => call.url.endsWith('/handshake')), 'the injected token needs no handshake');

    // A page served before activation has no inline token: the handshake supplies one.
    delete window.__WORKSPACE_MCP_TOKEN__;
    assert.deepEqual(await request('/config'), { ok: true });
    assert.ok(calls.some(call => call.url.endsWith('/handshake')));
    assert.equal(calls.at(-1).token, 'fresh');

    // A token the Host rejects is replaced once, without asking the user to reload.
    window.__WORKSPACE_MCP_TOKEN__ = 'stale';
    calls.length = 0;
    assert.deepEqual(await request('/config', { patch: {} }), { ok: true });
    assert.deepEqual(calls.map(call => call.token), ['stale', undefined, 'fresh'],
      'the rejected attempt, the handshake, then the retry');
    assert.deepEqual(await request('/config'), { ok: true });
    assert.equal(calls.at(-1).token, 'fresh', 'the replacement token is remembered');
  } finally {
    delete globalThis.fetch;
  }
});

test('the dot follows the panel: fast while a row moves, settled only when nothing changes', async () => {
  const { exports } = await loadClientBundle();
  const { pollInterval, FAST_MS, IDLE_MS, WARM_MS } = exports.__internals;
  assert.equal(pollInterval(true, false, false), FAST_MS, 'an open panel polls fast');
  assert.equal(pollInterval(false, true, false), FAST_MS, 'a freshly attached workspace polls fast too');
  assert.equal(pollInterval(false, false, true), FAST_MS, 'any read that saw a row move keeps it fast');
  assert.equal(pollInterval(false, false, false), IDLE_MS);
  assert.ok(IDLE_MS > FAST_MS, 'a settled chip is slower than a moving one');
  assert.ok(IDLE_MS <= 5000, 'but it must still be sensitive enough to notice a change quickly');
  assert.ok(WARM_MS >= 10000 && WARM_MS <= 120000, 'the warm window has to outlast a server generation');
});

test('the status signature notices every row change the chip has to follow', async () => {
  const { exports } = await loadClientBundle();
  const { statusSignature } = exports.__internals;
  const view = (state, tools = 0) => ({ workspace: 'D:/w', trusted: true, servers: [{ id: 'demo', state, tools: new Array(tools).fill('t') }] });
  assert.equal(statusSignature(undefined), '');
  assert.equal(statusSignature(view('connected')), statusSignature(view('connected')), 'an unchanged panel keeps the cadence settled');
  assert.notEqual(statusSignature(view('connected')), statusSignature(view('failed')), 'a row state change is visible');
  assert.notEqual(statusSignature(view('connected', 1)), statusSignature(view('connected', 2)), 'a tool-count change is visible');
  assert.notEqual(statusSignature(view('connected', 1)),
    statusSignature({ workspace: 'D:/w', trusted: true, servers: [{ id: 'demo', state: 'connected', tools: ['u'] }] }),
    'the panel unfolds the tool names, so a rename at the same count is visible too');
  assert.notEqual(statusSignature(view('connected')), statusSignature({ ...view('connected'), trusted: false }), 'a trust change is visible');
  assert.notEqual(statusSignature(view('connected')), statusSignature({ ...view('connected'), workspace: 'D:/other' }), 'a workspace change is visible');
  assert.notEqual(statusSignature(view('connected')), statusSignature({ workspace: 'D:/w', trusted: true, servers: [{ id: 'demo2', state: 'connected', tools: [] }] }), 'a row appearing is visible');
});

test('a failed read retries on a short backoff before falling back to the idle cadence', async () => {
  const { exports } = await loadClientBundle();
  const { retryBackoff, RETRY_MS, RETRY_MAX_MS, FAST_MS, IDLE_MS } = exports.__internals;
  assert.equal(retryBackoff(0), RETRY_MS, 'the first retry must not wait out a whole period');
  assert.equal(retryBackoff(RETRY_MS), RETRY_MS * 2, 'repeated failures back off');
  assert.equal(retryBackoff(RETRY_MAX_MS), RETRY_MAX_MS, 'and the backoff is capped');
  assert.ok(RETRY_MS <= FAST_MS, 'a failing read never retries slower than the healthy fast cadence');
  assert.ok(RETRY_MAX_MS >= IDLE_MS, 'a long outage backs off past the settled cadence');
});

test('the request layer keeps the host error code, so not-ready is distinguishable from broken', async () => {
  const { exports } = await loadClientBundle();
  const { request } = exports.__internals;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/handshake')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ token: 't' }), json: async () => ({ token: 't' }) };
    }
    const body = { error: 'workspace-mcp: no live session with that id', code: 'SESSION_NOT_READY' };
    return { ok: false, status: 400, text: async () => JSON.stringify(body), json: async () => body };
  };
  try {
    await assert.rejects(request('/status?sessionId=fresh'), failure => {
      assert.equal(failure.code, 'SESSION_NOT_READY');
      assert.equal(failure.status, 400);
      return true;
    });
  } finally {
    delete globalThis.fetch;
  }
});

test('a long-poll read can be aborted and downgraded by its caller', async () => {
  const { exports } = await loadClientBundle();
  const { request, WAIT_PATH } = exports.__internals;
  assert.equal(WAIT_PATH, '/wait', 'the reader holds this one action open');
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), signal: init.signal });
    if (String(url).endsWith('/handshake')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ token: 't' }), json: async () => ({ token: 't' }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ version: 7 }), json: async () => ({ version: 7 }) };
  };
  try {
    const controller = new AbortController();
    assert.deepEqual(await request('/wait?sessionId=s&version=0', undefined, controller.signal), { version: 7 });
    assert.equal(seen.at(-1).signal, controller.signal, 'the caller signal reaches fetch, so a held request can be released');
  } finally {
    delete globalThis.fetch;
  }
});

test('the plugin page submits the trust decision together with the presets', async () => {
  const { exports } = await loadClientBundle();
  const { configPatch, toDraft, workspacesOf, withWorkspace, TRUST_MODES, trustModeOf } = exports.__internals;
  const preset = { id: 'team', files: ['.team/mcp.yaml'], serversPaths: ['/integrations/mcp'], format: 'yaml' };
  const patch = configPatch({
    drafts: [toDraft(preset)],
    enabled: ['root'],
    trustMode: 'manual',
    workspaces: '  D:\\work\\team-a \n\nD:\\work\\team-b\r\nD:\\work\\team-a ',
  });
  assert.equal(patch.trustMode, 'manual', 'the page owns the trust mode, so it must submit it');
  // The Host validates the mode against its own enum, so a copy of the page still carrying the
  // retired spelling must not put it back on the wire.
  assert.equal(configPatch({ drafts: [], enabled: [], trustMode: 'ask', workspaces: '' }).trustMode, 'manual');
  assert.deepEqual(patch.trustedWorkspaces, ['D:\\work\\team-a', 'D:\\work\\team-b'], 'blank lines dropped, duplicates removed, lines trimmed');
  assert.deepEqual(patch.enabledBuiltins, ['root']);
  assert.deepEqual(patch.presets.map(item => item.id), ['team']);

  // The chip panel trusts one workspace without touching the rest of the list.
  assert.deepEqual(withWorkspace(['D:\\a'], 'D:\\b'), ['D:\\a', 'D:\\b']);
  assert.deepEqual(withWorkspace(['D:\\a'], 'D:\\a'), ['D:\\a'], 'never trust the same path twice');
  assert.deepEqual(workspacesOf(''), []);

  assert.deepEqual(TRUST_MODES.map(mode => mode.id), ['manual', 'all'], 'manual stays first, all carries the warning');
  assert.equal(trustModeOf('all'), 'all');
  assert.equal(trustModeOf('manual'), 'manual');
  assert.equal(trustModeOf('ask'), 'manual', 'a profile written before the rename still shows the manual choice');
  assert.equal(trustModeOf(undefined), 'manual', 'and an unreadable mode is the safe one');
  assert.match(TRUST_MODES[1].note, /所有项目|本地程序/);
});

test('the chip renders this plugin own controls instead of host primitives', async () => {
  const { exports } = await loadClientBundle();
  const { Chip } = exports.__internals;
  const markup = renderToStaticMarkup(React.createElement(Chip, { sessionId: 'session-42' }));
  assert.match(markup, /class="wmcp-chip"/, 'the chip is the plugin own ghost control');
  assert.match(markup, /type="button"/);
  assert.match(markup, /class="wmcp-dot"/, 'the status dot is painted by our own CSS');
  assert.match(markup, /data-state="idle"/);
  assert.match(markup, /aria-label="工作区 MCP：无声明"/);
  assert.ok(!markup.includes('data-host'), 'no Harness component is rendered');
});

test('the panel trust switch works in both directions and exposes itself as a switch', async () => {
  const { exports } = await loadClientBundle();
  const { TrustSwitch } = exports.__internals;
  const on = renderToStaticMarkup(React.createElement(TrustSwitch, {
    checked: true, disabled: false, label: '始终信任此工作区', hint: '取消信任：不再自动加载这个工作区，并断开当前连接', onToggle: () => {},
  }));
  assert.match(on, /role="switch"/);
  assert.match(on, /aria-checked="true"/);
  assert.match(on, /始终信任此工作区/);
  assert.match(on, /取消信任/, 'the on state must offer turning it back off');
  const off = renderToStaticMarkup(React.createElement(TrustSwitch, {
    checked: false, disabled: true, label: '始终信任此工作区', hint: '信任并连接', onToggle: () => {},
  }));
  assert.match(off, /aria-checked="false"/);
  assert.match(off, /disabled/, 'a profile the page cannot write stays disabled');
});

test('the bundle page renders a one-line summary without reading the control channel', async () => {
  const { exports } = await loadClientBundle();
  const { PresetManager } = exports.__internals;
  const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); throw new Error('summary must not fetch'); };
  try {
    const markup = renderToStaticMarkup(React.createElement(PresetManager, { view: 'summary' }));
    assert.match(markup, /MCP 声明预设/);
    assert.equal(calls.length, 0, 'the Plugins page list asks for the summary view');
  } finally {
    delete globalThis.fetch;
  }
});

/** Handlers a rendered row needs; none of them fire under static markup. */
const noop = () => {};

test('one workspace allowance is written back whole, with the public tool names verbatim', async () => {
  const { exports } = await loadClientBundle();
  const { allowanceOf, withAllowance, withAllowedServer, withAllowedTool, sessionAllowance, toolNames } = exports.__internals;
  const other = { workspace: 'D:/other', allowMcp: ['keep'], allowTools: ['mcp__keep__tool'] };
  const list = [{ workspace: 'D:/w', allowMcp: [], allowTools: [] }, other];

  // A workspace without a row is the empty allowance, never a missing one.
  assert.deepEqual(allowanceOf(list, 'D:/w'), { workspace: 'D:/w', allowMcp: [], allowTools: [] });
  assert.deepEqual(allowanceOf(list, 'D:/absent'), { workspace: 'D:/absent', allowMcp: [], allowTools: [] });
  assert.deepEqual(allowanceOf(list, undefined), { workspace: null, allowMcp: [], allowTools: [] });

  // The server switch stores the server name in allowMcp and leaves every other row untouched.
  const granted = withAllowedServer(list, 'D:/w', 'demo');
  assert.deepEqual(granted, [{ workspace: 'D:/w', allowMcp: ['demo'], allowTools: [] }, other]);
  assert.deepEqual(withAllowedServer(granted, 'D:/w', 'demo'), [other], 'turning the last switch off drops the empty row');
  assert.deepEqual(list[0], { workspace: 'D:/w', allowMcp: [], allowTools: [] }, 'the write never mutates the read it was built from');
  assert.deepEqual(withAllowance(list, { workspace: 'D:/w', allowMcp: [], allowTools: ['t'] })[1], other,
    'a write to one workspace keeps another workspace entry exactly as it was');

  // The tool switch writes the public name the status row reported, with no prefix surgery.
  const row = { id: 'demo', state: 'connected', tools: ['mcp__demo__identity'] };
  const [publicName] = toolNames(row);
  assert.equal(publicName, 'mcp__demo__identity');
  const exempted = withAllowedTool(list, 'D:/w', publicName);
  assert.deepEqual(exempted[0].allowTools, ['mcp__demo__identity'], 'the public name goes into allowTools unchanged');
  assert.deepEqual(withAllowedTool(exempted, 'D:/w', publicName), [other], 'cancelling it removes exactly that string');
  assert.deepEqual(toolNames({ tools: [{ name: 'mcp__demo__blocked' }, 'mcp__demo__identity'] }), ['mcp__demo__blocked', 'mcp__demo__identity']);
  assert.deepEqual(toolNames({}), [], 'a server that is not mounted reports no tools');

  // What the switches read: the session own allowance, normalized when the Host has none.
  assert.deepEqual(sessionAllowance(undefined), { workspace: null, allowMcp: [], allowTools: [] });
  assert.deepEqual(sessionAllowance({ allowance: { workspace: null, allowMcp: [], allowTools: [] } }),
    { workspace: null, allowMcp: [], allowTools: [] });
  assert.deepEqual(sessionAllowance({ allowance: { workspace: 'D:/w', allowMcp: ['demo'], allowTools: ['mcp__demo__identity'] } }),
    { workspace: 'D:/w', allowMcp: ['demo'], allowTools: ['mcp__demo__identity'] });
});

test('every server row carries an auto-connect switch and unfolds its public tool names', async () => {
  const { exports } = await loadClientBundle();
  const { ServerRow } = exports.__internals;
  const row = { id: 'demo', state: 'connected', tools: ['mcp__demo__identity'], source: { preset: 'root', file: '.mcp.json' } };
  const allowance = { workspace: 'D:/w', allowMcp: ['demo'], allowTools: [] };
  const common = { expanded: true, busy: undefined, trusted: false, writable: true, onToggleAllow: noop, onToggleTool: noop, onToggleExpand: noop, onAct: noop };

  const markup = renderToStaticMarkup(React.createElement(ServerRow, { ...common, row, allowance }));
  const auto = controlFor(markup, '自动连接 demo');
  assert.match(auto, /type="button"/);
  assert.match(auto, /role="switch"/);
  assert.match(auto, /aria-checked="true"/, 'a server in allowMcp reads as on');
  assert.ok(!auto.includes('disabled'), 'a writable profile leaves the switch operable');
  assert.match(auto, /title="取消自动连接 demo：从 allowMcp 移除并断开"/, 'the on state offers turning it back off');
  const tool = controlFor(markup, '免批准工具 mcp__demo__identity');
  assert.match(tool, /type="button"/);
  assert.match(tool, /role="switch"/);
  assert.match(tool, /aria-checked="false"/, 'an exempted name still offers both directions');
  assert.match(markup, /mcp__demo__identity/, 'the name is rendered exactly as the Host reported it');
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /工具（1）/);

  // Nothing is mounted yet, so the row says so instead of unfolding an empty list.
  const empty = renderToStaticMarkup(React.createElement(ServerRow, {
    ...common,
    row: { id: 'demo', state: 'unauthorized', tools: [] },
    allowance: { workspace: 'D:/w', allowMcp: [], allowTools: [] },
  }));
  assert.match(controlFor(empty, '自动连接 demo'), /aria-checked="false"/);
  assert.match(controlFor(empty, '自动连接 demo'), /title="加入 allowMcp：这个工作区的 demo 不再需要逐项放行"/);
  assert.match(empty, /连接后可管理工具/);
  assert.ok(!empty.includes('免批准工具'), 'no tools were discovered, so there is nothing to switch');
  assert.match(controlFor(empty, '收起 demo 的工具列表'), /aria-expanded="true"/);

  // Folded rows list nothing at all.
  const folded = renderToStaticMarkup(React.createElement(ServerRow, { ...common, expanded: false, row, allowance }));
  assert.match(controlFor(folded, '展开 demo 的工具列表'), /aria-expanded="false"/);
  assert.ok(!folded.includes('免批准工具'));

  // A trusted workspace loads every declaration, so one row grant could not change anything.
  const trusted = renderToStaticMarkup(React.createElement(ServerRow, { ...common, expanded: false, row, allowance, trusted: true }));
  assert.match(controlFor(trusted, '自动连接 demo'), /disabled/);
  const readonly = renderToStaticMarkup(React.createElement(ServerRow, { ...common, expanded: false, row, allowance, writable: false }));
  assert.match(controlFor(readonly, '自动连接 demo'), /disabled/);
});

test('the panel offers the way back to the policy once a selection is pinned by hand', async () => {
  const { exports } = await loadClientBundle();
  const { PanelFooter } = exports.__internals;
  const calls = [];
  const props = {
    busy: undefined, anySelected: false, rowCount: 2,
    onRefresh: () => calls.push('refresh'),
    onFollow: () => calls.push('follow'),
    onToggleAll: () => calls.push('all'),
    onClose: () => calls.push('close'),
  };
  /** The one button whose label is exactly `text`, found in the element tree. */
  const buttonByText = (element, text) => element.props.children.find(child => child?.props?.children === text);

  // A pinned selection is the only state that can be handed back to the policy.
  const custom = PanelFooter({ ...props, status: { selectionMode: 'custom' } });
  const follow = buttonByText(custom, '恢复自动');
  assert.ok(follow, 'a custom selection offers going back to the policy');
  assert.equal(follow.props.type, 'button');
  assert.match(follow.props.title, /策略/);
  follow.props.onClick();
  assert.deepEqual(calls, ['follow'], 'and the button asks the Host to follow the policy again');
  assert.equal(buttonByText(PanelFooter({ ...props, busy: 'connect:demo', status: { selectionMode: 'custom' } }), '恢复自动').props.disabled,
    true, 'a write in flight blocks it like every other action');

  // A selection that already follows the policy has nothing to restore.
  for (const status of [{ selectionMode: 'auto' }, undefined, { }]) {
    const markup = renderToStaticMarkup(PanelFooter({ ...props, status }));
    assert.ok(!markup.includes('恢复自动'), 'the restore action only exists in custom mode');
    assert.match(markup, /重新读取/);
    assert.match(markup, /连接全部/);
    assert.match(markup, /关闭/);
  }
});

test('a tool the project itself forbids is reported, never offered as a switch', async () => {
  const { exports } = await loadClientBundle();
  const { ServerRow } = exports.__internals;
  const row = {
    id: 'same', state: 'connected', required: false,
    source: { preset: 'codex', file: '.codex/config.toml' },
    selected: true, tools: ['mcp__same__identity', 'mcp__same__blocked'],
    disabledTools: ['mcp__same__blocked'], error: undefined,
  };
  const markup = renderToStaticMarkup(React.createElement(ServerRow, {
    row,
    allowance: { workspace: 'D:/w', allowMcp: ['same'], allowTools: [] },
    expanded: true, busy: undefined, trusted: false, writable: true,
    onToggleAllow: () => {}, onToggleTool: () => {}, onToggleExpand: () => {}, onAct: () => {},
  }));
  assert.match(markup, /项目已禁用/, 'the prohibition is stated');
  assert.match(markup, /is-forbidden/, 'and drawn as a struck-through row');
  assert.equal((markup.match(/role="switch"/g) ?? []).length, 2,
    'only the row switch and the tool the project still enables: the forbidden tool has no switch at all');
});

test('the panel switch reads as a control against the panel fill', async () => {
  const { exports } = await loadClientBundle();
  const { CSS } = exports.__internals;
  const track = /\.wmcp-switch-track\{([^}]*)\}/.exec(CSS);
  assert.ok(track, 'the off-state track rule exists');
  assert.match(track[1], /background:var\(--dsw-alias-border-l3\)/, 'the track is filled with a token that differs from the panel');
  assert.match(track[1], /inset 0 0 0 1px var\(--dsw-alias-border-l2\)/, 'and ringed by an inset edge');
  assert.ok(!track[1].includes('--dsw-alias-bg-layer-3'), 'the panel fill is not a track colour');
  const knob = /\.wmcp-switch-track::after\{([^}]*)\}/.exec(CSS);
  assert.ok(knob, 'the knob rule exists');
  assert.match(knob[1], /background:var\(--dsw-alias-label-primary\)/, 'the knob contrasts with the off track');
  assert.match(CSS, /\.wmcp-switch\[aria-checked=true\] \.wmcp-switch-track\{background:var\(--dsw-alias-state-business-primary\)/,
    'the on state keeps the business colour');
  // The whole stylesheet lives in one template string: a backtick or a placeholder would end it.
  assert.ok(!CSS.includes(String.fromCharCode(96)), 'the CSS template never carries a backtick');
  assert.ok(!CSS.includes('$' + '{'), 'nor starts a template placeholder');
});

/** One entry of the frozen declaration view: the Host reports only the fields already in the file. */
const declarationTarget = (over = {}) => ({
  serverId: 'demo', preset: 'root', file: '.mcp.json', format: 'json', dialect: 'standard', editable: true,
  fields: [
    { name: 'command', path: ['mcpServers', 'demo', 'command'], value: 'node index.js', kind: 'text' },
    { name: 'args', path: ['mcpServers', 'demo', 'args'], value: ['serve', '--port', '1'], kind: 'list' },
    { name: 'env', path: ['mcpServers', 'demo', 'env'], value: { TOKEN: 'a' }, kind: 'map' },
    { name: 'cwd', path: ['mcpServers', 'demo', 'cwd'], value: 'D:/w', kind: 'text' },
  ],
  ...over,
});

test('the declaration editor lists every entry and marks the ones it cannot rewrite', async () => {
  const { exports } = await loadClientBundle();
  const { DeclarationListView, DeclarationOverlay } = exports.__internals;
  const readonly = declarationTarget({ serverId: 'same', preset: 'codex', file: '.codex/config.toml', format: 'toml', editable: false, reason: 'TOML 表格不能原地改写' });
  const payload = { writable: true, targets: [declarationTarget(), readonly] };
  const markup = renderToStaticMarkup(React.createElement(DeclarationListView, {
    payload, status: undefined, busy: false, onOpen: noop, onReload: noop, onClose: noop,
  }));
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /编辑配置/);
  assert.match(markup, /2 条/);
  assert.match(markup, /\.mcp\.json/, 'the entry says which file it came from');
  assert.match(markup, /\.codex\/config\.toml/);
  assert.match(markup, /只读/, 'an entry that cannot be rewritten in place is marked, not hidden');
  assert.match(markup, /title="TOML 表格不能原地改写"/, 'and it carries its reason');
  assert.equal((markup.match(/class="wmcp-entry"/g) ?? []).length, 2);
  assert.equal((markup.match(/type="button"/g) ?? []).length, 4, 'two entries plus 重新读取 and 关闭');
  assert.equal((markup.match(/字段/g) ?? []).length, 1, 'the editable entry counts its fields');

  // The overlay root is our own scrim, and a session that cannot write says so before anything else.
  const overlay = renderToStaticMarkup(React.createElement(DeclarationOverlay, {
    payload: { writable: false, reason: '会话运行在只读沙箱里', targets: [declarationTarget()] },
    busy: false, status: undefined, onClose: noop, onReload: noop, onSave: noop, onRemove: noop,
  }));
  assert.match(overlay, /class="wmcp-backdrop"/);
  assert.match(overlay, /只读：会话运行在只读沙箱里/);
  assert.equal((overlay.match(/aria-modal="true"/g) ?? []).length, 1, 'only the outer manager is modal');

  // Nothing to rewrite: the list says so instead of offering an empty box.
  const empty = renderToStaticMarkup(React.createElement(DeclarationListView, {
    payload: { writable: true, targets: [] }, status: undefined, busy: false, onOpen: noop, onReload: noop, onClose: noop,
  }));
  assert.match(empty, /没有可以原地编辑的声明条目/);
  assert.ok(!empty.includes('class="wmcp-entry"'));
});

test('a read-only declaration entry states why and offers neither save nor delete', async () => {
  const { exports } = await loadClientBundle();
  const { DeclarationEditorView, draftsOfTarget } = exports.__internals;
  const readonly = declarationTarget({ editable: false, reason: '这个格式不能保真改写' });
  const view = (target, over = {}) => renderToStaticMarkup(React.createElement(DeclarationEditorView, {
    target, drafts: draftsOfTarget(target), editable: true, reason: undefined, busy: false,
    status: undefined, problem: undefined, changeCount: 1,
    onChange: noop, onBack: noop, onDelete: noop, onSave: noop,
    ...over,
  }));

  const locked = view(readonly, { editable: false, reason: '这个格式不能保真改写', changeCount: 0 });
  assert.match(locked, /只读：这个格式不能保真改写/, 'the reason is stated, not implied by a missing button');
  assert.ok(!locked.includes('保存'), 'a read-only entry cannot be saved');
  assert.ok(!locked.includes('删除'), 'and cannot be deleted');
  assert.match(locked, /<input[^>]*disabled/, 'its fields are shown, but locked');
  assert.match(locked, /<textarea[^>]*disabled/);
  assert.match(locked, /返回列表/, 'the only way out is back to the list');

  const editable = view(declarationTarget());
  assert.match(editable, /保存/);
  assert.match(editable, /删除/);
  assert.ok(!editable.includes('disabled'), 'an editable entry leaves every control operable');
  assert.match(editable, /value="node index.js"/, 'a text field opens on its current value');
  assert.match(editable, /每行一条/, 'the list hint spells the format out');
  assert.match(editable, /JSON 对象/, 'and so does the map hint');
  assert.match(editable, /将提交 1 个字段/);

  // Nothing changed yet: there is nothing to submit, so the save does nothing.
  const untouched = view(declarationTarget(), { changeCount: 0 });
  assert.match(untouched, /<button[^>]*disabled[^>]*>保存<\/button>/, 'an unchanged entry cannot be saved');
  assert.match(untouched, /没有改动/);
  // A write in flight blocks both actions.
  const saving = view(declarationTarget(), { busy: true });
  assert.match(saving, /<button[^>]*disabled[^>]*>删除<\/button>/);
  assert.match(saving, /保存中…/);
});

test('a deletion asks a second time inside the overlay, never through a host dialog', async () => {
  const { exports } = await loadClientBundle();
  const { DeclarationConfirmView, scrimDismiss } = exports.__internals;
  const target = declarationTarget();
  const calls = [];
  const markup = renderToStaticMarkup(React.createElement(DeclarationConfirmView, {
    target, busy: false, onCancel: () => calls.push('cancel'), onConfirm: () => calls.push('confirm'),
  }));
  assert.match(markup, /role="alertdialog"/, 'the confirmation is our own surface, not the host Modal');
  assert.match(markup, /确认删除/);
  assert.match(markup, /取消/);
  assert.match(markup, /从 \.mcp\.json 里删掉/, 'the file it will be removed from is named');
  assert.match(markup, /无法撤销/);
  assert.match(markup, /删除 demo/);
  assert.equal((markup.match(/type="button"/g) ?? []).length, 2);
  const busy = renderToStaticMarkup(React.createElement(DeclarationConfirmView, { target, busy: true, onCancel: noop, onConfirm: noop }));
  assert.match(busy, /删除中…/);
  assert.equal((busy.match(/disabled/g) ?? []).length, 2, 'a delete in flight cannot be triggered twice');

  // The scrim is what dismisses the overlay — a pointer on the dialog itself never does.
  const dismiss = scrimDismiss(() => calls.push('close'));
  dismiss({ target: 'dialog', currentTarget: 'dialog' });
  assert.deepEqual(calls, ['close']);
  dismiss({ target: 'field', currentTarget: 'dialog' });
  assert.deepEqual(calls, ['close'], 'a pointer inside the card is not a dismissal');
});

test('list and map drafts round-trip into the JSON shapes the route stores', async () => {
  const { exports } = await loadClientBundle();
  const { draftOfField, draftsOfTarget, valueOfDraft, changesOfTarget, fieldKind } = exports.__internals;
  const target = declarationTarget();

  // The draft is not the stored value: a list is one item per line, a map is JSON, text verbatim.
  assert.equal(fieldKind({ kind: 'list' }), 'list');
  assert.equal(fieldKind({ name: 'transport' }), 'text', 'an unknown kind is edited as plain text');
  assert.equal(draftOfField(target.fields[0]), 'node index.js');
  assert.equal(draftOfField(target.fields[1]), 'serve\n--port\n1');
  assert.equal(draftOfField(target.fields[2]), '{\n  "TOKEN": "a"\n}');
  assert.equal(draftOfField({ name: 'cwd', kind: 'text' }), '', 'a missing value opens empty, never as "undefined"');
  assert.deepEqual(draftsOfTarget(target), {
    command: 'node index.js',
    args: 'serve\n--port\n1',
    env: '{\n  "TOKEN": "a"\n}',
    cwd: 'D:/w',
  });

  // Opening an entry and saving it without touching anything submits nothing at all.
  assert.deepEqual(changesOfTarget(target, draftsOfTarget(target)), []);

  // What the user typed comes back as exactly the JSON shape that field's kind stores.
  const drafts = {
    ...draftsOfTarget(target),
    args: ' serve\n\n--port\n2 ',
    env: '{"TOKEN":"a","MODE":"dev"}',
    cwd: 'D:/w2',
  };
  assert.deepEqual(changesOfTarget(target, drafts), [
    { name: 'args', value: ['serve', '--port', '2'] },
    { name: 'env', value: { TOKEN: 'a', MODE: 'dev' } },
    { name: 'cwd', value: 'D:/w2' },
  ], 'blank lines dropped, the object restored, and the untouched command left out');
  // A name the Host did not report has no field to change, so it can never reach the wire.
  assert.deepEqual(changesOfTarget(target, { ...drafts, command: 'node index.js', transport: 'stdio' }),
    changesOfTarget(target, drafts));
  assert.deepEqual(changesOfTarget(target, { transport: 'stdio' }), [], 'an unknown name is not a field');
  assert.deepEqual(changesOfTarget({ fields: [{ name: 'args', kind: 'list', value: [] }] }, { args: '' }), [],
    'an empty list draft matches the empty list');
  assert.deepEqual(changesOfTarget({ fields: [{ name: 'args', kind: 'list' }] }, { args: '' }), [],
    'an absent field stays absent when its blank draft is untouched');

  // A map draft that is not an object of strings blocks the save with the field named.
  assert.throws(() => valueOfDraft({ name: 'env', kind: 'map' }, '{oops'), /env 不是合法 JSON/);
  assert.throws(() => valueOfDraft({ name: 'headers', kind: 'map' }, '[1, 2]'), /headers 需要是 JSON 对象/);
  assert.throws(() => valueOfDraft({ name: 'headers', kind: 'map' }, '{"A":1}'), /headers 的值必须是字符串/);
  assert.throws(() => changesOfTarget(target, { ...drafts, env: '{"A":' }), /env 不是合法 JSON/,
    'a broken draft blocks the save instead of writing something unintended');
  assert.deepEqual(changesOfTarget(target, { ...drafts, env: '   ' }), [
    { name: 'args', value: ['serve', '--port', '2'] },
    { name: 'env', value: null },
    { name: 'cwd', value: 'D:/w2' },
  ], 'a box the user emptied that held something asks for the key to be deleted — null, never a parse error');
  // A box that was already empty is not a change, whatever its kind.
  assert.deepEqual(changesOfTarget({ fields: [{ name: 'cwd', kind: 'text', value: '' }] }, { cwd: '' }), [],
    'clearing an empty text box changes nothing');
  assert.deepEqual(changesOfTarget({ fields: [{ name: 'env', kind: 'map', value: {} }] }, { env: '' }), [{ name: 'env', value: null }],
    'clearing an existing empty object deletes its key');
  assert.deepEqual(valueOfDraft({ name: 'headers', kind: 'map' }, '  '), {}, 'an empty map draft is the empty object');
});

test('the declaration route is driven by the three frozen actions and their field names', async () => {
  const { exports } = await loadClientBundle();
  const { readDeclaration, saveDeclaration, removeDeclaration, DECLARATION_PATH } = exports.__internals;
  const calls = [];
  const send = (path, body) => { calls.push({ path, body }); return Promise.resolve({ ok: true }); };
  assert.equal(DECLARATION_PATH, '/declaration');

  const read = await readDeclaration(send, 's1');
  assert.deepEqual(read, { ok: true });
  assert.deepEqual(calls.at(-1), { path: '/declaration', body: { sessionId: 's1', action: 'list' } });

  await saveDeclaration(send, 's1', 'demo', [{ name: 'args', value: ['serve'] }, { name: 'env', value: { A: '1' } }]);
  assert.deepEqual(calls.at(-1), {
    path: '/declaration',
    body: {
      sessionId: 's1', action: 'save', serverId: 'demo',
      changes: [{ name: 'args', value: ['serve'] }, { name: 'env', value: { A: '1' } }],
    },
  }, 'a save carries the server id and only the changed fields, already JSON-safe');

  await removeDeclaration(send, 's1', 'demo');
  assert.deepEqual(calls.at(-1), { path: '/declaration', body: { sessionId: 's1', action: 'remove', serverId: 'demo' } });
  assert.deepEqual(calls.map(call => call.body.action), ['list', 'save', 'remove'], 'and nothing else is ever sent');
});

test('the panel offers the declaration editor only once a target exists', async () => {
  const { exports } = await loadClientBundle();
  const { PanelFooter } = exports.__internals;
  const calls = [];
  const props = {
    busy: undefined, anySelected: false, rowCount: 2, status: undefined,
    onRefresh: noop, onFollow: noop, onToggleAll: noop, onClose: noop, onEditDeclaration: () => calls.push('edit'),
  };
  /** The one button whose label is exactly the given text, found in the element tree. */
  const buttonByText = (element, text) => element.props.children.find(child => child?.props?.children === text);

  // No editable declaration: no entry point at all.
  const none = PanelFooter({ ...props, declarationCount: 0 });
  assert.ok(!renderToStaticMarkup(none).includes('编辑配置'), 'nothing to edit means nothing to click');
  assert.ok(!buttonByText(none, '编辑配置'));

  const some = PanelFooter({ ...props, declarationCount: 2 });
  const edit = buttonByText(some, '编辑配置');
  assert.ok(edit, 'one editable target is enough to offer the editor');
  assert.equal(edit.props.type, 'button');
  assert.match(edit.props.title, /command\/args\/env\/cwd\/url\/headers/);
  edit.props.onClick();
  assert.deepEqual(calls, ['edit'], 'and it opens the overlay');
  assert.equal(buttonByText(PanelFooter({ ...props, declarationCount: 2, busy: 'connect:demo' }), '编辑配置').props.disabled,
    true, 'a write in flight blocks it like every other action');
  // A target count with no handler is not an entry point either.
  assert.ok(!PanelFooter({ ...props, declarationCount: 2, onEditDeclaration: undefined }).props.children
    .some(child => child?.props?.children === '编辑配置'));
});

test('the declaration editor is a sibling surface, never nested inside the panel', async () => {
  const { exports } = await loadClientBundle();
  const { CSS } = exports.__internals;
  // Nesting it in the panel was wrong twice: a backdrop-filtered box inside another loses its
  // blur, so the host menu material degraded to a translucent slab, and the two surfaces also
  // overlapped. It now carries the panel's own recipe one level up.
  const overlay = /\.wmcp-overlay\{([^}]*)\}/.exec(CSS);
  assert.ok(overlay, 'the editor rule exists');
  assert.match(overlay[1], /position:fixed/);
  assert.match(overlay[1], /background:var\(--dsw-menu-surface-fill/, 'it reuses the host menu surface');
  assert.match(overlay[1], /backdrop-filter:var\(--dsw-menu-backdrop-filter\)/);
  const scrim = /\.wmcp-scrim\{([^}]*)\}/.exec(CSS);
  assert.ok(scrim, 'the inner container still exists');
  assert.ok(!/position:fixed/.test(scrim[1]), 'and is no longer a page-level scrim');
  assert.ok(!/color-mix/.test(scrim[1]), 'and paints nothing of its own');
  const overlayZ = Number(/z-index:(\d+)/.exec(overlay[1])?.[1]);
  const panelZ = Number(/z-index:(\d+)/.exec(/\.wmcp-panel\{([^}]*)\}/.exec(CSS)[1])?.[1]);
  assert.ok(overlayZ > panelZ, 'it sits above the panel it replaces');
  assert.match(CSS, /\.wmcp-dialog input:disabled/, 'a read-only entry still shows its fields as locked');
  // And only one of the two surfaces renders at a time, so they can never overlap.
  const source = await fs.readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  assert.match(source, /editing !== undefined \? editor : open \? panelSurface : null/, 'the manager remains independent after closing the small popover');
  assert.match(source, /createPortal\(modal, document.body\)/, 'the modal escapes composer clipping and stacking contexts');
  // The Host separates a clash in another declaration file (DECLARATION_CONFLICT, which overwriting
  // cannot fix) from a name the target file already holds (DECLARATION_EXISTS, which it does), so
  // only the second one may open the overwrite prompt.
  assert.match(source, /reason\?\.code === 'DECLARATION_EXISTS' \? 'exists'/, 'only an overwrite-able refusal opens that prompt');
  assert.match(source, /reason\?\.code === 'DECLARATION_CONFIRM_REQUIRED' \? 'confirm'/, 'TOML refusal opens the separate lossy rewrite confirmation');
});

/* ── Writing a declaration: a new server, and a copy into another preset ───────────── */

/** One preset as the frozen `list` view reports it: the flag is the Host's, not the format's. */
const presetView = (over = {}) => ({
  id: 'root', format: 'json', files: ['.mcp.json'], editable: true, builtin: true, ...over,
});
/** The whole button of a preset row, found by the id its row renders. */
const presetRow = (markup, id) => {
  const at = markup.indexOf('class="wmcp-entry-id">' + id + '<');
  assert.ok(at > 0, 'no preset row renders the id ' + id);
  const start = markup.lastIndexOf('<button', at);
  return markup.slice(start, markup.indexOf('</button>', at));
};
/**
 * The fields a standard-dialect preset reports now: the names it can write, in the Host's order,
 * each with the kind its draft is edited as. `transport` is a choice, and its options are the
 * vocabulary the loader accepts.
 */
const STANDARD_FIELDS = [
  { name: 'url', kind: 'text' },
  { name: 'transport', kind: 'choice', options: ['stdio', 'http'] },
  { name: 'command', kind: 'text' },
  { name: 'args', kind: 'list' },
  { name: 'env', kind: 'map' },
  { name: 'cwd', kind: 'text' },
  { name: 'headers', kind: 'map' },
];
/** One preset row that reports its fields, the way the current Host does. */
const presetWithFields = (over = {}) => presetView({ fields: STANDARD_FIELDS, ...over });
/** The same list for a dialect with nowhere to write a transport (Codex' TOML, Gemini's implied one). */
const withoutTransport = fields => fields.filter(field => field.name !== 'transport');
/** The one child of the dialog foot whose text is exactly `text`. */
const footControl = (element, text) => element.props.children
  .find(child => child?.props?.className === 'wmcp-dialog-foot').props.children
  .find(child => child?.props?.children === text);
/** The one labelled row of the write form. */
const formRow = (element, label) => element.props.children
  .find(child => child?.props?.className === 'wmcp-field-row' && child.props.children?.[0]?.props?.children === label);

test('the new-server entry exists only where a preset accepts the write', async () => {
  const { exports } = await loadClientBundle();
  const { canCreateEntry, DeclarationListView, DeclarationOverlay } = exports.__internals;
  const payload = over => ({ writable: true, targets: [declarationTarget()], ...over });

  // A payload with no preset list (an older Host) or with nothing that takes a write has no
  // entry point at all: the button would only be able to apologize.
  assert.equal(canCreateEntry(payload()), false);
  assert.equal(canCreateEntry(payload({ presets: [] })), false);
  assert.equal(canCreateEntry(payload({ presets: [presetView({ editable: false, reason: 'TOML 声明文件已经存在' })] })), false,
    'a preset the Host refused is not somewhere to write');
  assert.equal(canCreateEntry(payload({ writable: false, presets: [presetView()] })), false,
    'a read-only session cannot create anything, however willing the presets are');
  assert.equal(canCreateEntry(payload({ presets: [presetView({ editable: false }), presetView({ id: 'team', builtin: false })] })), true,
    'one editable preset is enough');

  const list = over => renderToStaticMarkup(React.createElement(DeclarationListView, {
    payload: payload(over), status: undefined, busy: false, onOpen: noop, onReload: noop, onClose: noop,
    canCreate: canCreateEntry(payload(over)), onNew: noop,
  }));
  assert.ok(!list({}).includes('新建服务器'), 'a payload without presets keeps the button out');
  assert.ok(!list({ writable: false, presets: [presetView()] }).includes('新建服务器'));
  assert.match(list({ presets: [presetView()] }), /新建服务器/, 'an editable preset brings it in');

  // The overlay reads the same flag off the payload it was handed.
  const overlay = over => renderToStaticMarkup(React.createElement(DeclarationOverlay, {
    payload: payload(over), busy: false, status: undefined, onClose: noop, onReload: noop,
    onSave: noop, onRemove: noop, onWrite: noop,
  }));
  assert.match(overlay({}), /<button[^>]*disabled[^>]*>＋ 新建服务器<\/button>/);
  assert.match(overlay({ writable: false, presets: [presetView()] }), /<button[^>]*disabled[^>]*>＋ 新建服务器<\/button>/);
  assert.match(overlay({ presets: [presetView()] }), /<button type="button"[^>]*>＋ 新建服务器<\/button>/);
});

test('the preset chooser lists every target and never lets a refused one through', async () => {
  const { exports } = await loadClientBundle();
  const { PresetPickView, presetsFor, editablePresets, copyPresets } = exports.__internals;
  const reason = 'TOML 声明文件已经存在，不能只改其中的一个条目';
  const presets = [
    presetView(),
    presetView({ id: 'team', format: 'yaml', files: ['.team/mcp.yaml'], builtin: false }),
    presetView({ id: 'codex', format: 'toml', files: ['.codex/config.toml'], editable: false, reason }),
  ];

  const picks = [];
  const tree = PresetPickView({
    mode: 'create', presets, busy: false, status: undefined,
    onPick: preset => picks.push(preset.id), onBack: noop,
  });
  const rows = tree.props.children.find(child => child?.type === 'ul').props.children;
  assert.equal(rows.length, 3, 'every preset is listed, the refused one included');
  rows[0].props.children.props.onClick();
  assert.deepEqual(picks, ['root'], 'an editable row reports the preset it stands for');
  assert.equal(rows[2].props.children.props.disabled, true, 'a refused row is not clickable');

  const markup = renderToStaticMarkup(tree);
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /新建服务器/);
  assert.match(presetRow(markup, 'codex'), /disabled/, 'the refused preset is a dead row in the DOM too');
  assert.match(presetRow(markup, 'codex'), /不可写/);
  assert.ok(!presetRow(markup, 'root').includes('disabled'));
  assert.match(markup, /内置/);
  assert.match(markup, /自定义/);
  assert.match(markup, /TOML 声明文件已经存在/, 'and it states the reason the Host gave');
  assert.match(markup, /\.team\/mcp\.yaml/, 'each row names the file it would write');

  // Nothing to write into: the chooser says so rather than showing an empty box.
  assert.match(renderToStaticMarkup(PresetPickView({
    mode: 'create', presets: [], busy: false, status: undefined, onPick: noop, onBack: noop,
  })), /没有可以写入的预设/);

  // The Host owns the flag: a TOML preset is writable exactly while its file does not exist yet,
  // so this side never re-derives it from the format.
  assert.deepEqual(editablePresets({ presets }).map(preset => preset.id), ['root', 'team']);
  assert.deepEqual(copyPresets({ presets }, { preset: 'root' }).map(preset => preset.id), ['team'],
    'an entry can only be copied to another preset');
  assert.deepEqual(presetsFor({ presets }, 'copy', { preset: 'root' }).map(preset => preset.id), ['team', 'codex'],
    'the copy chooser keeps the refused rows, so they can still say why');
  assert.deepEqual(presetsFor({ presets }, 'create', undefined).map(preset => preset.id), ['root', 'team', 'codex']);
});

test('the copy entry appears only when another preset could take the entry', async () => {
  const { exports } = await loadClientBundle();
  const { canCopyEntry, DeclarationEditorView, draftsOfTarget } = exports.__internals;
  const source = declarationTarget();
  const payload = over => ({ writable: true, presets: [presetView(), presetView({ id: 'team', builtin: false })], ...over });

  assert.equal(canCopyEntry(payload(), source), true);
  assert.equal(canCopyEntry(payload({ presets: [presetView()] }), source), false,
    'the preset it already lives in is not another preset');
  assert.equal(canCopyEntry(payload({ writable: false }), source), false,
    'a session that cannot write has nowhere to copy to');
  assert.equal(canCopyEntry(payload({ presets: [presetView(), presetView({ id: 'codex', editable: false })] }), source), false,
    'a refused target is not a destination');
  // Copying reads this entry and writes elsewhere, so a read-only entry is still a valid source.
  assert.equal(canCopyEntry(payload(), declarationTarget({ editable: false, reason: 'TOML 表格不能原地改写' })), true);

  const view = over => renderToStaticMarkup(React.createElement(DeclarationEditorView, {
    target: source, drafts: draftsOfTarget(source), editable: true, reason: undefined, busy: false,
    status: undefined, problem: undefined, changeCount: 1,
    onChange: noop, onBack: noop, onDelete: noop, onSave: noop,
    ...over,
  }));
  assert.ok(!view({}).includes('复制到其它预设'), 'no other writable preset means no copy action');
  assert.match(view({ copyable: true, onCopy: noop }), /复制到其它预设/);
  assert.match(view({ copyable: true, onCopy: noop, busy: true }), /<button[^>]*disabled[^>]*>复制到其它预设<\/button>/,
    'a write in flight blocks the copy like every other action');
  // A handler with no flag is not an entry point either.
  assert.ok(!view({ copyable: false, onCopy: noop }).includes('复制到其它预设'));
});

test('a write carries only the keys the form actually chose', async () => {
  const { exports } = await loadClientBundle();
  const { writeDeclaration, DECLARATION_PATH } = exports.__internals;
  const calls = [];
  const send = (path, body) => { calls.push({ path, body }); return Promise.resolve({ ok: true, file: '.mcp.json', created: true, removedSource: false }); };
  assert.equal(DECLARATION_PATH, '/declaration', 'the write rides the one declaration route');

  await writeDeclaration(send, 's1', { preset: 'root', name: 'demo', fields: [{ name: 'command', value: 'node index.js' }] });
  assert.deepEqual(calls.at(-1), {
    path: '/declaration',
    body: {
      sessionId: 's1', action: 'write', preset: 'root', name: 'demo',
      fields: [{ name: 'command', value: 'node index.js' }],
    },
  }, 'a new entry carries no copy key at all');

  await writeDeclaration(send, 's1', { preset: 'team', name: 'demo', fields: [], fromServerId: 'demo' });
  assert.deepEqual(calls.at(-1).body, {
    sessionId: 's1', action: 'write', preset: 'team', name: 'demo', fields: [], fromServerId: 'demo',
  });

  await writeDeclaration(send, 's1', { preset: 'team', name: 'demo', fields: [], fromServerId: 'demo', removeSource: false });
  assert.equal('removeSource' in calls.at(-1).body, false, 'an unchecked box is silence, not a false');
  await writeDeclaration(send, 's1', { preset: 'team', name: 'demo', fields: [], fromServerId: 'demo', removeSource: true });
  assert.equal(calls.at(-1).body.removeSource, true);

  await writeDeclaration(send, 's1', { preset: 'team', name: 'demo', fields: [], overwrite: true });
  assert.equal(calls.at(-1).body.overwrite, true, 'the target file already held the name');
  await writeDeclaration(send, 's1', { preset: 'team', name: 'demo', fields: [], overwrite: false });
  assert.equal('overwrite' in calls.at(-1).body, false, 'and the default stays the Host own');
  assert.deepEqual(calls.map(call => call.body.action), new Array(6).fill('write'));
});

test('the copy form opens on the source entry values, and what the user types wins', async () => {
  const { exports } = await loadClientBundle();
  const { WRITE_FIELDS, writeDraftsFrom, writeFieldsOf, emptyWriteDrafts, writeSpecOf } = exports.__internals;
  const source = declarationTarget();
  assert.deepEqual(WRITE_FIELDS.map(field => field.name), ['command', 'args', 'env', 'cwd', 'url', 'headers'],
    'the write form is the canonical field set the route accepts, in one order');

  assert.deepEqual(writeDraftsFrom(source), {
    command: 'node index.js',
    args: 'serve\n--port\n1',
    env: '{\n  "TOKEN": "a"\n}',
    cwd: 'D:/w',
    url: '',
    headers: '',
  }, 'the prefill is the source entry current values, and a field it lacks opens blank');
  assert.deepEqual(writeDraftsFrom(undefined), { command: '', args: '', env: '', cwd: '', url: '', headers: '' },
    'nothing to copy from opens empty, never as "undefined"');
  assert.deepEqual(writeFieldsOf(writeDraftsFrom(source)), [
    { name: 'command', value: 'node index.js' },
    { name: 'args', value: ['serve', '--port', '1'] },
    { name: 'env', value: { TOKEN: 'a' } },
    { name: 'cwd', value: 'D:/w' },
  ], 'the prefill is already the JSON shape the route stores, so a copy needs no retyping');
  assert.deepEqual(writeFieldsOf(emptyWriteDrafts()), [], 'a blank form has nothing to write');

  const form = {
    mode: 'copy',
    preset: presetView({ id: 'team', format: 'yaml', files: ['.team/mcp.yaml'], builtin: false }),
    source,
    name: 'demo',
    drafts: { ...writeDraftsFrom(source), command: 'deno run main.ts', cwd: '' },
    removeSource: false,
  };
  assert.deepEqual(writeSpecOf(form, false), {
    preset: 'team',
    name: 'demo',
    fromServerId: 'demo',
    fields: [
      { name: 'command', value: 'deno run main.ts' },
      { name: 'args', value: ['serve', '--port', '1'] },
      { name: 'env', value: { TOKEN: 'a' } },
      { name: 'cwd', value: null },
    ],
  }, 'the user override wins over the source entry, and a box emptied after the copy opened asks for that key to be deleted');
  assert.equal('removeSource' in writeSpecOf(form, false), false, 'the box is a choice, not a default');
  assert.equal(writeSpecOf({ ...form, removeSource: true }, false).removeSource, true);
  assert.equal(writeSpecOf(form, true).overwrite, true, 'overwrite is only asked for after the Host refused the name');
  assert.equal('overwrite' in writeSpecOf(form, false), false);

  // A new entry has no source, so the wire says nothing about copying.
  const create = { mode: 'create', preset: presetView(), source: undefined, name: ' fresh ', drafts: emptyWriteDrafts(), removeSource: false };
  assert.deepEqual(writeSpecOf(create, false).fromServerId, undefined);
  assert.equal('fromServerId' in writeSpecOf(create, false), false, 'a name is trimmed for the wire and no source is invented');
  assert.equal(writeSpecOf(create, false).name, 'fresh');

  // A draft that cannot be parsed blocks the write instead of reaching the route.
  assert.throws(() => writeFieldsOf({ env: '{oops' }), /env 不是合法 JSON/);
});

test('an unnamed entry cannot be submitted, and the form says why', async () => {
  const { exports } = await loadClientBundle();
  const { DeclarationWriteView, writeBlocked, emptyWriteDrafts, writeDraftsFrom } = exports.__internals;
  const preset = presetView();
  const create = over => DeclarationWriteView({
    mode: 'create', preset, source: undefined, name: '', drafts: emptyWriteDrafts(), removeSource: false,
    busy: false, status: undefined, problem: undefined, blocked: writeBlocked('', []),
    onName: noop, onChange: noop, onToggleRemove: noop, onSubmit: noop, onBack: noop,
    ...over,
  });

  assert.equal(writeBlocked('', [{ name: 'command', value: 'x' }]), '条目名不能为空');
  assert.equal(writeBlocked('   ', [{ name: 'command', value: 'x' }]), '条目名不能为空');
  assert.equal(writeBlocked('demo', []), '至少要填一个字段');
  assert.equal(writeBlocked(' demo ', [{ name: 'command', value: 'x' }]), undefined);

  const submit = over => footControl(create(over), '创建');
  assert.equal(submit({}).props.disabled, true, 'a blank name cannot be submitted');
  assert.equal(submit({}).props['data-variant'], 'primary');
  assert.match(renderToStaticMarkup(create({})), /条目名不能为空/, 'the reason for the dead button is on screen');
  assert.equal(submit({ name: 'demo', blocked: undefined }).props.disabled, false,
    'a name and one field open the submit');
  assert.match(renderToStaticMarkup(create({ name: 'demo', blocked: undefined })), /value="demo"/);
  // A broken draft is reported instead of written, and blocks the same button.
  assert.equal(submit({ name: 'demo', blocked: undefined, problem: 'env 不是合法 JSON' }).props.disabled, true);
  assert.match(renderToStaticMarkup(create({ name: 'demo', problem: 'env 不是合法 JSON' })), /env 不是合法 JSON/);
  assert.match(renderToStaticMarkup(create({ name: 'demo', busy: true })), /创建中…/);
  assert.ok(!renderToStaticMarkup(create({})).includes('复制后删除原条目'), 'the delete-original box belongs to the copy, not the create');
  // The named fields are the canonical six, each edited as its own kind.
  const markup = renderToStaticMarkup(create({ name: 'demo', blocked: undefined }));
  assert.ok(formRow(create({}), 'command'));
  assert.ok(formRow(create({}), 'args · 字符串数组'));
  assert.ok(formRow(create({}), 'env · 键值对象'));
  assert.match(markup, /每行一条/);
  assert.match(markup, /JSON 对象/);
});

test('the copy form prefills the source fields and offers the delete-original box unchecked', async () => {
  const { exports } = await loadClientBundle();
  const { DeclarationWriteView, writeDraftsFrom } = exports.__internals;
  const source = declarationTarget();
  const preset = presetView({ id: 'team', format: 'yaml', files: ['.team/mcp.yaml'], builtin: false });
  const view = over => DeclarationWriteView({
    mode: 'copy', preset, source, name: 'demo', drafts: writeDraftsFrom(source), removeSource: false,
    busy: false, status: undefined, problem: undefined, blocked: undefined,
    onName: noop, onChange: noop, onToggleRemove: noop, onSubmit: noop, onBack: noop,
    ...over,
  });

  const markup = renderToStaticMarkup(view({}));
  assert.match(markup, /复制到其它预设/);
  assert.match(markup, /字段预填自 demo 的当前值/, 'the form says where the values came from');
  assert.match(markup, /value="node index.js"/, 'a copied field opens on the source value');
  assert.match(markup, /--port/, 'including the list field');
  assert.match(markup, /目标：\.team\/mcp\.yaml · yaml/, 'and the file it will land in');
  assert.match(markup, /<button[^>]*>复制<\/button>/);
  assert.ok(!markup.includes('>创建</button>'), 'the copy form never offers the create');

  const box = view({}).props.children.find(child => child?.props?.className === 'wmcp-check');
  assert.ok(box, 'the copy offers deleting the original after it succeeded');
  assert.equal(box.props.children[0].props.type, 'checkbox');
  assert.equal(box.props.children[0].props.checked, false, 'and it starts unchecked');
  const toggles = [];
  const liveBox = view({ onToggleRemove: value => toggles.push(value) }).props.children
    .find(child => child?.props?.className === 'wmcp-check').props.children[0];
  liveBox.props.onChange();
  assert.deepEqual(toggles, [true], 'the box reports the state it is moving to');
  const checked = renderToStaticMarkup(view({ removeSource: true }));
  assert.match(checked, /<input[^>]*type="checkbox"[^>]*checked/);
  assert.match(renderToStaticMarkup(view({ busy: true })), /复制中…/);
});

test('a name the target file already holds is asked about before it is overwritten', async () => {
  const { exports } = await loadClientBundle();
  const { DeclarationOverwriteView } = exports.__internals;
  const preset = presetView({ id: 'team', format: 'yaml', files: ['.team/mcp.yaml'], builtin: false });
  const markup = renderToStaticMarkup(React.createElement(DeclarationOverwriteView, {
    preset, name: 'demo', busy: false, onCancel: noop, onConfirm: noop,
  }));
  assert.match(markup, /role="alertdialog"/, 'the second ask is our own surface, not a host dialog');
  assert.match(markup, /目标条目已存在/);
  assert.match(markup, /\.team\/mcp\.yaml/, 'the file that already holds the name is named');
  assert.match(markup, /覆盖写入/);
  assert.match(markup, /取消/);
  assert.equal((markup.match(/type="button"/g) ?? []).length, 2);
  const busy = renderToStaticMarkup(React.createElement(DeclarationOverwriteView, {
    preset, name: 'demo', busy: true, onCancel: noop, onConfirm: noop,
  }));
  assert.match(busy, /写入中…/);
  assert.equal((busy.match(/disabled/g) ?? []).length, 2, 'a write in flight cannot be asked twice');
});

test('the write surfaces are painted with the plugin own classes and tokens', async () => {
  const { exports } = await loadClientBundle();
  const { CSS } = exports.__internals;
  for (const rule of ['.wmcp-preset{', '.wmcp-preset-reason{', '.wmcp-actions{', '.wmcp-check{']) {
    assert.ok(CSS.includes(rule), 'the stylesheet carries ' + rule);
  }
  assert.match(CSS, /\.wmcp-entry:disabled\{cursor:not-allowed/, 'a refused preset row says it is not clickable');
  assert.match(CSS, /\.wmcp-preset-reason\{color:var\(--dsw-alias-label-tertiary\)/, 'the reason line reads as secondary text');
  assert.match(CSS, /\.wmcp-check input\{margin:0;accent-color:var\(--dsw-alias-state-business-primary\)/,
    'the checkbox borrows the host accent colour');
  assert.ok(!CSS.includes(String.fromCharCode(96)), 'the CSS template still never carries a backtick');
  // The overlay stays one flat layer: the chooser and the form are views of it, never a box
  // nested inside the panel.
  const source = await fs.readFile(new URL('../src/client.js', import.meta.url), 'utf8');
  const fixed = className => (source.match(new RegExp("className: '" + className + "'", 'g')) ?? []).length;
  assert.equal(fixed('wmcp-panel'), 1, 'exactly one panel surface exists');
  assert.equal(fixed('wmcp-overlay'), 1, 'and exactly one overlay: the write views are views of it, not boxes inside a box');
  assert.match(source, /dialogSurface\(title, children\)/, 'every write view is built by the one dialog surface');
});

test('a project with no declaration still reaches the editor when a preset could take one', async () => {
  const { exports } = await loadClientBundle();
  const { PanelFooter } = exports.__internals;
  const calls = [];
  const props = {
    busy: undefined, anySelected: false, rowCount: 0, status: undefined,
    onRefresh: noop, onFollow: noop, onToggleAll: noop, onClose: noop,
    onEditDeclaration: () => calls.push('edit'),
  };
  /** The one child of the footer whose text is exactly `text`. */
  const buttonByText = (element, text) => element.props.children.find(child => child?.props?.children === text);

  // Nothing to edit and nowhere to write: the button stays away.
  assert.ok(!buttonByText(PanelFooter({ ...props, declarationCount: 0, presetCount: 0 }), '编辑配置'));
  assert.ok(!buttonByText(PanelFooter({ ...props, declarationCount: 0 }), '编辑配置'), 'an older Host reports no presets');
  // A writable preset is where a new server would land, so the editor is the way in.
  const empty = PanelFooter({ ...props, declarationCount: 0, presetCount: 1 });
  const edit = buttonByText(empty, '编辑配置');
  assert.ok(edit, 'a writable preset alone opens the editor');
  assert.match(edit.props.title, /新建一台服务器/);
  assert.match(edit.props.title, /command\/args\/env\/cwd\/url\/headers/);
  edit.props.onClick();
  assert.deepEqual(calls, ['edit']);
  // The declared-entry wording still wins once there is something to rewrite.
  assert.match(buttonByText(PanelFooter({ ...props, declarationCount: 2, presetCount: 3 }), '编辑配置').props.title,
    /直接改这 2 条声明/);
});

/* ── Choosing how to connect: the field list and the picker both come from the Host ─────── */

test('the write form lists exactly the fields the Host reported, url first and transport second', async () => {
  const { exports } = await loadClientBundle();
  const { presetFields, DeclarationWriteView, emptyWriteDrafts, WRITE_FIELDS } = exports.__internals;
  assert.deepEqual(presetFields(presetWithFields()).map(field => field.name),
    ['url', 'transport', 'command', 'args', 'env', 'cwd', 'headers'],
    'the Host order is kept verbatim, so the address sits right under the entry name');
  // A dialect with nowhere to put a transport does not list one: Codex' TOML has no such key and
  // Gemini infers it from the address, so the form must not offer what the file cannot hold.
  for (const id of ['codex', 'gemini']) {
    assert.ok(!presetFields(presetWithFields({ id, fields: withoutTransport(STANDARD_FIELDS) }))
      .some(field => field.name === 'transport'), id + ' cannot write a transport');
  }
  assert.deepEqual(presetFields(presetView()).map(field => field.name), WRITE_FIELDS.map(field => field.name),
    'a Host that reports no fields still opens the canonical list');
  assert.deepEqual(presetFields(undefined), WRITE_FIELDS);
  assert.deepEqual(presetFields({ id: 'odd', fields: [{ kind: 'text' }] }), WRITE_FIELDS,
    'a field without a name cannot be sent, so it is not a field list at all');

  const view = preset => renderToStaticMarkup(React.createElement(DeclarationWriteView, {
    mode: 'create', preset, source: undefined, name: '', drafts: emptyWriteDrafts(presetFields(preset)),
    fields: presetFields(preset), busy: false, status: undefined, problem: undefined,
    blocked: '至少要填一个字段', onName: noop, onChange: noop, onToggleRemove: noop, onSubmit: noop, onBack: noop,
  }));
  // A plain text field's caption is just its name, so the labels no longer share a ' · ' marker.
  const labelOf = markup => [...markup.matchAll(/<span>([^<]+)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(labelOf(view(presetWithFields())),
    ['条目名 · 服务器名', 'transport · 调用方式', 'command',
      'args · 字符串数组', 'env · 键值对象', 'cwd'],
    'the form leads with the picker and shows only stdio fields by default');
  const codex = view(presetWithFields({
    id: 'codex', format: 'toml', files: ['.codex/config.toml'], fields: withoutTransport(STANDARD_FIELDS),
  }));
  assert.deepEqual(labelOf(codex),
    ['条目名 · 服务器名', '连接方式', 'command', 'args · 字符串数组',
      'env · 键值对象', 'cwd'],
    'a Codex form offers a UI-only connection picker, not a stored transport field');
  assert.ok(codex.includes('$transport'), 'the UI-only key never belongs to the submitted fields');
});

test('the transport picker is drawn from the Host options and reports the option it selects', async () => {
  const { exports } = await loadClientBundle();
  const { DeclarationWriteView, DeclarationEditorView, choiceOptions, draftsOfTarget,
    presetFields, emptyWriteDrafts } = exports.__internals;
  const transport = { name: 'transport', kind: 'choice', options: ['stdio', 'http'] };
  assert.deepEqual(choiceOptions(transport, '', true), ['', 'stdio', 'http'], 'a new entry may leave the transport unset');
  assert.deepEqual(choiceOptions(transport, 'http', false), ['stdio', 'http'], 'an entry that exists has one');
  assert.deepEqual(choiceOptions(transport, 'streamable-http', false), ['streamable-http', 'stdio', 'http'],
    'a spelling the Host did not list is shown verbatim, in front');
  assert.deepEqual(choiceOptions({ name: 'transport', kind: 'choice' }, '', false), []);
  assert.deepEqual(choiceOptions(transport, '', true).filter(option => option === 'sse'), [],
    'the client never invents an option the Host did not send');

  const preset = presetWithFields();
  const picks = [];
  const create = over => DeclarationWriteView({
    mode: 'create', preset, source: undefined, name: '', drafts: emptyWriteDrafts(presetFields(preset)),
    fields: presetFields(preset), busy: false, status: undefined, problem: undefined, blocked: undefined,
    onName: noop, onChange: (name, value) => picks.push([name, value]), onToggleRemove: noop,
    onSubmit: noop, onBack: noop,
    ...over,
  });
  const group = formRow(create({}), 'transport · 调用方式').props.children[1];
  assert.equal(group.props.className, 'wmcp-choice');
  assert.equal(group.props.role, 'group');
  assert.equal(group.props['aria-label'], 'transport');
  assert.deepEqual(group.props.children.map(button => button.props.children), ['不指定', 'stdio', 'http'],
    'the blank plus the Host options, in the Host order');
  assert.equal(group.props.children[0].props['aria-pressed'], true, 'a fresh entry starts unset');
  group.props.children[2].props.onClick();
  assert.deepEqual(picks, [['transport', 'http']], 'a segment reports the value it stands for');
  const markup = renderToStaticMarkup(create({
    drafts: { ...emptyWriteDrafts(presetFields(preset)), transport: 'http' },
  }));
  assert.match(/<button[^>]*data-value="http"[^>]*>/.exec(markup)[0], /aria-pressed="true"/, 'the picked segment is the pressed one');
  assert.equal((markup.match(/class="wmcp-choice-option"/g) ?? []).length, 3, 'three segments: unset, stdio, http');

  // The detail form reads the fields the Host reported for that entry, values included.
  const target = declarationTarget({ fields: [
    { name: 'url', path: ['mcpServers', 'demo', 'url'], value: 'https://example.test/mcp', kind: 'text' },
    { name: 'transport', path: ['mcpServers', 'demo', 'type'], value: 'streamable-http', kind: 'choice', options: ['stdio', 'http'] },
  ]});
  const editor = over => renderToStaticMarkup(React.createElement(DeclarationEditorView, {
    target, drafts: draftsOfTarget(target), editable: true, reason: undefined, busy: false,
    status: undefined, problem: undefined, changeCount: 1,
    onChange: noop, onBack: noop, onDelete: noop, onSave: noop,
    ...over,
  }));
  const detail = editor({});
  assert.match(detail, /value="https:\/\/example\.test\/mcp"/, 'the address opens on the value the Host reported');
  assert.match(/<button[^>]*data-value="streamable-http"[^>]*>/.exec(detail)[0], /aria-pressed="true"/,
    'an older spelling is the selected segment, not a blank or a rewrite');
  assert.ok(!detail.includes('>不指定<'), 'an entry that exists has a transport: there is no blank to pick');
  assert.match(editor({ editable: false }), /<button[^>]*disabled[^>]*>http<\/button>/, 'a read-only entry locks the picker too');
});

test('switching a remote entry to a local one deletes the url and changes the transport in one save', async () => {
  const { exports } = await loadClientBundle();
  const { changesOfTarget, draftsOfTarget, hasStoredValue } = exports.__internals;
  assert.equal(hasStoredValue('http'), true);
  assert.equal(hasStoredValue(''), false);
  assert.equal(hasStoredValue(['x']), true);
  assert.equal(hasStoredValue([]), false);
  assert.equal(hasStoredValue({ A: '1' }), true);
  assert.equal(hasStoredValue({}), false);
  assert.equal(hasStoredValue(undefined), false, 'a field the Host never reported holds nothing');
  assert.equal(hasStoredValue(null), false);

  const target = declarationTarget({ fields: [
    { name: 'url', path: ['mcpServers', 'demo', 'url'], value: 'https://a.test/mcp', kind: 'text' },
    { name: 'transport', path: ['mcpServers', 'demo', 'type'], value: 'http', kind: 'choice', options: ['stdio', 'http'] },
    { name: 'command', path: ['mcpServers', 'demo', 'command'], value: 'node index.js', kind: 'text' },
  ]});
  const opening = draftsOfTarget(target);
  assert.deepEqual(changesOfTarget(target, opening), [], 'opening an entry and saving it untouched submits nothing');
  assert.deepEqual(changesOfTarget(target, { ...opening, transport: 'stdio' }),
    [{ name: 'url', value: null }, { name: 'transport', value: 'stdio' }], 'switching transport automatically deletes the incompatible URL');
  assert.deepEqual(changesOfTarget(target, { ...opening, url: '' }),
    [{ name: 'url', value: null }], 'clearing the address deletes the key: an empty string would leave a url the loader still reads');
  assert.deepEqual(changesOfTarget(target, { ...opening, transport: 'stdio', url: '   ' }), [
    { name: 'url', value: null },
    { name: 'transport', value: 'stdio' },
  ], 'the Host order decides the order of the changes, and clearing means deleting');
});

test('a copy that clears a prefilled box asks for that key to be deleted, and an always-empty box is not sent', async () => {
  const { exports } = await loadClientBundle();
  const { presetFields, emptyWriteDrafts, writeDraftsFrom, writeFieldsOf, writeSpecOf } = exports.__internals;
  const preset = presetWithFields({ id: 'team', format: 'yaml', files: ['.team/mcp.yaml'], builtin: false });
  const fields = presetFields(preset);
  const source = declarationTarget();
  const opening = writeDraftsFrom(source, fields);
  assert.deepEqual(Object.keys(opening), fields.map(field => field.name), 'the form preloads one draft per field the preset takes');
  assert.equal(opening.url, '', 'a field the source entry does not carry opens blank');
  assert.equal(opening.command, 'node index.js');

  const blank = emptyWriteDrafts(fields);
  assert.deepEqual(writeFieldsOf(blank, fields, blank), [], 'a blank form writes nothing, and never a deletion');
  assert.deepEqual(writeFieldsOf({ ...blank, url: 'https://a.test/mcp' }, fields, blank),
    [{ name: 'url', value: 'https://a.test/mcp' }], 'an unset transport is simply absent, never sent as a value');
  assert.deepEqual(writeFieldsOf(opening, fields, opening), [
    { name: 'command', value: 'node index.js' },
    { name: 'args', value: ['serve', '--port', '1'] },
    { name: 'env', value: { TOKEN: 'a' } },
    { name: 'cwd', value: 'D:/w' },
  ], 'the copy carries the source values in the Host order, and nothing for the boxes that were empty to begin with');
  assert.deepEqual(writeFieldsOf({ ...opening, cwd: '' }, fields, opening), [
    { name: 'command', value: 'node index.js' },
    { name: 'args', value: ['serve', '--port', '1'] },
    { name: 'env', value: { TOKEN: 'a' } },
    { name: 'cwd', value: null },
  ], 'emptying a prefilled box has to delete it, or the source value would survive the copy');

  const form = {
    mode: 'copy', preset, source, name: 'demo', fields, baseline: opening,
    drafts: { ...opening, url: 'https://b.test/mcp', transport: 'stdio', cwd: '' },
    removeSource: false,
  };
  assert.deepEqual(writeSpecOf(form, false).fields, [
    { name: 'transport', value: 'stdio' },
    { name: 'command', value: 'node index.js' },
    { name: 'args', value: ['serve', '--port', '1'] },
    { name: 'env', value: { TOKEN: 'a' } },
    { name: 'cwd', value: null },
  ], 'the request carries the typed address, the chosen transport and the deletion of the emptied path');
});

test('a transport the Host refuses comes back as the reason on the form, never as a silent rewrite', async () => {
  const { exports } = await loadClientBundle();
  const { DeclarationWriteView, presetFields, emptyWriteDrafts } = exports.__internals;
  const preset = presetWithFields();
  const view = renderToStaticMarkup(React.createElement(DeclarationWriteView, {
    mode: 'create', preset, source: undefined, name: 'demo',
    drafts: { ...emptyWriteDrafts(presetFields(preset)), url: 'https://a.test/mcp', transport: 'sse' },
    fields: presetFields(preset), busy: false, problem: undefined, blocked: undefined,
    status: { kind: 'error', text: '不支持的调用方式：sse（只支持 stdio / http）' },
    onName: noop, onChange: noop, onToggleRemove: noop, onSubmit: noop, onBack: noop,
  }));
  assert.match(view, /data-kind="error"/, 'a refused transport is an error, not a note');
  assert.match(view, /不支持的调用方式：sse（只支持 stdio \/ http）/, 'the Host own wording is what the user reads');
  assert.match(view, /创建/, 'and the form is still there to be corrected');
});



