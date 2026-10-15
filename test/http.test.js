import test from 'node:test';
import assert from 'node:assert/strict';
import * as Plugin from '../src/index.js';
import { agent, fixtureCommand, harness, provideSettings, workspace, writeFixture } from './helpers.js';
import WebServer from '@deepseek-ai/dsh-host-webserver';

/** Start the real host web server on an OS-assigned port and serve the shell index. */
async function startServer(t, ctx) {
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  ctx.webServer.registerFallback((_req, res) => {
    const html = ctx.webServer.renderIndex('<html><head><title>t</title></head><body></body></html>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return `http://127.0.0.1:${ctx.webServer.port}`;
}
const get = async (url, headers = {}) => {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, text, json };
};

test('the management route works over real HTTP: token injection, status, connect, disconnect', { timeout: 60000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t);
  await writeFixture(dir, '.mcp.json', { mcpServers: { demo: fixtureCommand('http') } });
  const base = await startServer(t, ctx);
  const agentA = agent(ctx, dir, 'http-session');
  ctx.agents.enter(agentA, undefined);
  await ctx.plugin(Plugin, { trustMode: 'manual' });

  const index = await get(`${base}/`);
  assert.equal(index.status, 200);
  const token = /window\.__WORKSPACE_MCP_TOKEN__="([0-9a-f]{48})"/.exec(index.text)?.[1];
  assert.ok(token, 'index carries the control token');

  // A page served before this plugin activated has no inline token; the handshake covers it.
  const handshake = await get(`${base}/workspace-mcp/handshake`);
  assert.equal(handshake.status, 200);
  assert.equal(handshake.json.token, token, 'the handshake returns the same per-process token');

  const auth = { 'x-workspace-mcp-token': token };

  const anonymous = await get(`${base}/workspace-mcp/status?sessionId=http-session`);
  assert.equal(anonymous.status, 403);

  const status = await get(`${base}/workspace-mcp/status?sessionId=http-session`, auth);
  assert.equal(status.status, 200);
  assert.equal(status.json.workspace, dir);
  assert.equal(status.json.loaded, false);
  assert.equal(status.json.trusted, false);
  assert.deepEqual(status.json.servers.map(row => row.id), ['demo']);
  assert.equal(status.json.servers[0].state, 'unauthorized', 'nothing authorized this workspace yet');
  assert.equal(status.json.trustMode, 'manual');
  assert.deepEqual(status.json.allowance, { workspace: null, allowMcp: [], allowTools: [] });

  const connected = await get(`${base}/workspace-mcp/connect`, auth);
  assert.equal(connected.status, 405, 'connect requires POST');
  const connectResponse = await fetch(`${base}/workspace-mcp/connect`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'http-session' }),
  });
  const connectedBody = await connectResponse.json();
  assert.equal(connectResponse.status, 200);
  assert.equal(connectedBody.servers[0].state, 'connected');
  assert.deepEqual(connectedBody.servers[0].tools, ['mcp__demo__identity', 'mcp__demo__blocked']);
  assert.equal(connectedBody.selectionMode, 'custom', 'a manual connect pins the selection');
  assert.deepEqual(connectedBody.selected, ['demo']);

  const perServer = await fetch(`${base}/workspace-mcp/disconnect`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'http-session', serverId: 'demo' }),
  });
  const droppedBody = await perServer.json();
  assert.equal(perServer.status, 200);
  assert.equal(droppedBody.servers[0].state, 'unloaded');
  assert.deepEqual(droppedBody.selected, []);

  const unknown = await get(`${base}/workspace-mcp/nope`, auth);
  assert.equal(unknown.status, 404);
});

test('the declaration route lists, edits and removes a project file over real HTTP', { timeout: 60000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t);
  const source = [
    '{',
    '  // keep me',
    '  "mcpServers": {',
    '    "demo": { "command": "node", "args": ["a"] },',
    '    "other": { "command": "deno" }',
    '  }',
    '}',
  ].join('\n');
  await writeFixture(dir, '.mcp.json', source);
  const base = await startServer(t, ctx);
  const agentA = agent(ctx, dir, 'declaration-session');
  ctx.agents.enter(agentA, undefined);
  await ctx.plugin(Plugin, { trustMode: 'all' });

  const index = await get(`${base}/`);
  const token = /window\.__WORKSPACE_MCP_TOKEN__="([0-9a-f]{48})"/.exec(index.text)?.[1];
  const headers = { 'content-type': 'application/json', 'x-workspace-mcp-token': token };
  const post = async body => {
    const response = await fetch(`${base}/workspace-mcp/declaration`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, json };
  };
  const { readFile } = await import('node:fs/promises');
  const file = `${dir}/.mcp.json`;

  const listed = await post({ sessionId: 'declaration-session', action: 'list' });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.writable, true);
  assert.deepEqual(listed.json.targets.map(target => target.serverId).sort(), ['demo', 'other']);
  const demo = listed.json.targets.find(target => target.serverId === 'demo');
  assert.ok(typeof demo.version === 'string', 'each target carries the version it was read at');

  const saved = await post({ sessionId: 'declaration-session', action: 'save', serverId: 'demo', changes: [{ name: 'command', value: 'bun' }] });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true);
  const afterSave = await readFile(file, 'utf8');
  assert.match(afterSave, /"command": "bun"/);
  assert.match(afterSave, /\/\/ keep me/);

  const removed = await post({ sessionId: 'declaration-session', action: 'remove', serverId: 'other' });
  assert.equal(removed.status, 200);
  const afterRemove = await readFile(file, 'utf8');
  assert.ok(!afterRemove.includes('deno'));

  // A file that moved under the editor is a conflict the page can retry, not a silent overwrite.
  await writeFixture(dir, '.mcp.json', '{ "mcpServers": { "demo": { "command": "node" } } }');
  const stale = await post({ sessionId: 'declaration-session', action: 'save', serverId: 'demo', changes: [{ name: 'command', value: 'x' }], version: demo.version });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'DECLARATION_STALE');

  // Creating is a write too, and it works even for a preset whose file does not exist yet.
  const created = await post({ sessionId: 'declaration-session', action: 'write', preset: 'vscode', name: 'fresh', fields: [{ name: 'command', value: 'node' }] });
  assert.equal(created.status, 200);
  assert.equal(created.json.file, '.vscode/mcp.json');
  assert.equal(created.json.created, true);

  const unknown = await post({ sessionId: 'declaration-session', action: 'nope' });
  assert.equal(unknown.status, 400);
});

test('TOML allowLossy crosses HTTP, control and runtime for save, append, remove and migration', { timeout: 60000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t);
  const source = '# original comments\nmodel = "gpt"\n[mcp_servers.demo]\ncommand = "node"\n[mcp_servers.other]\ncommand = "deno"\n';
  await writeFixture(dir, '.codex/config.toml', source);
  const base = await startServer(t, ctx);
  ctx.agents.enter(agent(ctx, dir, 'toml-session'), undefined);
  await ctx.plugin(Plugin, { trustMode: 'manual' });
  const token = /window\.__WORKSPACE_MCP_TOKEN__="([0-9a-f]{48})"/.exec((await get(`${base}/`)).text)?.[1];
  const headers = { 'content-type': 'application/json', 'x-workspace-mcp-token': token };
  const post = async body => {
    const response = await fetch(`${base}/workspace-mcp/declaration`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'toml-session', ...body }) });
    return { status: response.status, json: await response.json() };
  };
  const { readFile, stat } = await import('node:fs/promises');
  const listed = await post({ action: 'list' });
  const demo = listed.json.targets.find(item => item.serverId === 'demo');
  assert.equal(demo.editable, true);
  assert.equal(demo.lossy, true);
  assert.equal(listed.json.presets.find(item => item.id === 'codex').exists, true);
  const save = { action: 'save', serverId: 'demo', changes: [{ name: 'command', value: 'bun' }], version: demo.version };
  const append = { action: 'write', preset: 'codex', name: 'fresh', fields: [{ name: 'command', value: 'node' }] };
  const remove = { action: 'remove', serverId: 'other' };
  const migrate = { action: 'write', preset: 'root', name: 'demo', fromServerId: 'demo', removeSource: true };
  for (const action of [save, append, remove, migrate]) {
    for (const allowLossy of [undefined, 'true']) {
      const rejected = await post({ ...action, allowLossy });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.json.code, 'DECLARATION_CONFIRM_REQUIRED');
      assert.equal(await readFile(`${dir}/.codex/config.toml`, 'utf8'), source);
    }
  }
  await assert.rejects(stat(`${dir}/.mcp.json`), { code: 'ENOENT' });
  for (const action of [save, append, remove, migrate]) {
    const accepted = await post({ ...action, allowLossy: true });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    assert.equal(accepted.json.ok, true);
  }
  assert.equal(JSON.parse(await readFile(`${dir}/.mcp.json`, 'utf8')).mcpServers.demo.command, 'bun');
  const remaining = await readFile(`${dir}/.codex/config.toml`, 'utf8');
  assert.match(remaining, /model = "gpt"/);
  assert.match(remaining, /mcp_servers\.fresh/);
  assert.doesNotMatch(remaining, /mcp_servers\.(demo|other)/);
});

test('nested under another fiber the route still registers', { timeout: 30000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t);
  await writeFixture(dir, '.mcp.json', { mcpServers: { demo: fixtureCommand('nested') } });
  const base = await startServer(t, ctx);
  ctx.agents.enter(agent(ctx, dir, 'nested-session'), undefined);

  // Load the plugin the way the Cordis loader does: from inside another plugin's fiber.
  // In the real host `webServer` belongs to a sibling row, so only an injected lookup
  // can reach it; a bare `ctx.get('webServer')` silently returned undefined there.
  const host = ctx.plugin({
    name: 'test-host',
    apply(inner) { inner.plugin(Plugin, { trustMode: 'manual' }); },
  });
  await host;
  await host.await();

  const index = await get(`${base}/`);
  const token = /window\.__WORKSPACE_MCP_TOKEN__="([0-9a-f]{48})"/.exec(index.text)?.[1];
  assert.ok(token, 'the nested plugin injected the control token');
  const status = await get(`${base}/workspace-mcp/status?sessionId=nested-session`, { 'x-workspace-mcp-token': token });
  assert.equal(status.status, 200);
  assert.deepEqual(status.json.servers.map(row => row.id), ['demo']);
});

test('the preset configuration is editable over the same route', { timeout: 30000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t);
  const settings = provideSettings(ctx, { enabledBuiltins: ['root'], presets: [] });
  const base = await startServer(t, ctx);
  ctx.agents.enter(agent(ctx, dir, 'config-session'), undefined);
  await ctx.plugin(Plugin, {});

  const token = /window\.__WORKSPACE_MCP_TOKEN__="([0-9a-f]{48})"/.exec((await get(`${base}/`)).text)?.[1];
  const auth = { 'x-workspace-mcp-token': token };

  const before = await get(`${base}/workspace-mcp/config`, auth);
  assert.equal(before.status, 200);
  assert.equal(before.json.editable, true);
  assert.deepEqual(before.json.config.enabledBuiltins, ['root']);
  assert.deepEqual(before.json.builtins.map(preset => preset.id), ['root', 'vscode', 'codex', 'cursor', 'gemini']);

  const patch = {
    enabledBuiltins: ['root', 'codex'],
    presets: [{ id: 'team', files: ['.team/mcp.yaml'], serversPaths: ['/integrations/mcp'], format: 'yaml' }],
    inputValues: { secret: 'never-forwarded' },
  };
  const saved = await fetch(`${base}/workspace-mcp/config`, { method: 'POST', headers: auth, body: JSON.stringify({ patch }) });
  const savedBody = await saved.json();
  assert.equal(saved.status, 200);
  assert.deepEqual(savedBody.config.enabledBuiltins, ['root', 'codex']);
  assert.deepEqual(savedBody.config.presets.map(preset => preset.id), ['team']);
  assert.equal(settings.updates.length, 1);
  assert.equal(settings.updates[0].ns, 'entry-workspace-mcp-glue');
  assert.equal(settings.updates[0].revision, 1);
  assert.deepEqual(Object.keys(settings.updates[0].patch).sort(), ['enabledBuiltins', 'presets']);
  assert.equal(settings.state.value.inputValues, undefined);

  const invalid = await fetch(`${base}/workspace-mcp/config`, {
    method: 'POST', headers: auth, body: JSON.stringify({ patch: { presets: [{ id: 'bad', files: [], serversPaths: ['x'] }] } }),
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /files must be nonempty/);
});

test('webControl: false leaves the workspace state without a control route', { timeout: 30000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t);
  await writeFixture(dir, '.mcp.json', { mcpServers: { demo: fixtureCommand('off') } });
  const base = await startServer(t, ctx);
  ctx.agents.enter(agent(ctx, dir, 'off-session'), undefined);
  await ctx.plugin(Plugin, { trustMode: 'manual', webControl: false });
  const index = await get(`${base}/`);
  assert.ok(!index.text.includes('__WORKSPACE_MCP_TOKEN__'), 'no token is injected');
  // Without the route the shell fallback answers, so the body is never our JSON.
  const probe = await get(`${base}/workspace-mcp/status?sessionId=off-session`);
  assert.equal(probe.json, undefined);
  assert.equal(probe.status, 200);
});
