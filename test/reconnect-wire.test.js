import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { agent, fixtureCommand, harness, session, workspace, writeFixture } from './helpers.js';

const signal = () => new AbortController().signal;
const call = (ctx, owner, name = 'mcp__wire__identity') => ctx.tools.execute({ name, arguments: {}, agent: owner, callId: name, signal: signal() });
async function until(state, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    const version = state.statusVersion;
    const left = deadline - Date.now();
    assert.ok(left > 0, 'connection did not reach the expected state');
    await state.waitForChange(version, left, AbortSignal.timeout(left));
  }
}
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
});
const stop = server => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

/** A real stateful MCP endpoint: restarting invalidates every pre-restart session. */
async function wire(t) {
  const state = { generation: 1, initializes: 0, calls: 0, mutations: 0, businessError: false, auth: false };
  const server = http.createServer(async (req, res) => {
    res.setHeader('connection', 'close'); // Restart tests must reach the HTTP/session layer, not a stale pooled socket.
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const msg = JSON.parse(text);
    if (state.auth) { res.writeHead(401).end('WIRE_TOP_SECRET'); return; }
    if (msg.method !== 'initialize' && req.headers['mcp-session-id'] !== `session-${state.generation}`) {
      res.writeHead(404).end('WIRE_TOP_SECRET'); return;
    }
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    switch (msg.method) {
      case 'initialize':
        state.initializes++;
        res.setHeader('mcp-session-id', `session-${state.generation}`);
        result = { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'wire', version: '1' }, instructions: `Generation ${state.generation}` }; break;
      case 'tools/list': result = { tools: ['identity', 'mutate'].map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) }; break;
      case 'tools/call':
        state.calls++;
        if (msg.params.name === 'mutate') { state.mutations++; res.destroy(); return; }
        result = { content: [{ type: 'text', text: String(state.generation) }], ...(state.businessError ? { isError: true } : {}) }; break;
      case 'resources/list': result = { resources: [{ name: 'identity', uri: 'wire://identity' }] }; break;
      case 'resources/templates/list': result = { resourceTemplates: [] }; break;
      case 'resources/read': result = { contents: [{ uri: 'wire://identity', text: String(state.generation) }] }; break;
      default: result = {};
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await listen(server, 0);
  const port = server.address().port;
  t.after(() => stop(server));
  return { server, state, port, url: `http://127.0.0.1:${port}/mcp` };
}

test('real HTTP: service starts late, restarts with expired session, and business errors do not reconnect', { timeout: 20000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t), owner = agent(ctx, dir);
  const endpoint = await wire(t);
  await stop(endpoint.server);
  await writeFixture(dir, '.mcp.json', { mcpServers: { wire: { type: 'http', url: endpoint.url } } });
  const state = session(ctx, owner, { trustMode: 'all', startupTimeoutMs: 10000 });
  t.after(() => state.dispose());
  await state.reconcile(signal());
  assert.equal(state.serverStates.get('wire').state, 'reconnecting');
  assert.equal(endpoint.state.initializes, 0);
  await listen(endpoint.server, endpoint.port);
  await until(state, () => state.serverStates.get('wire')?.state === 'connected');
  assert.equal((await call(ctx, owner)).value.content[0].text, '1');
  endpoint.state.businessError = true;
  assert.equal((await call(ctx, owner)).isError, true);
  await state.queue;
  assert.equal(state.serverStates.get('wire').state, 'connected');
  assert.equal(endpoint.state.initializes, 1);
  endpoint.state.businessError = false;
  await stop(endpoint.server);
  endpoint.state.generation++;
  await listen(endpoint.server, endpoint.port);
  assert.equal((await call(ctx, owner)).isError, true, 'the old request fails; it is not replayed');
  await until(state, () => state.serverStates.get('wire')?.state === 'reconnecting');
  assert.equal(state.serverStates.get('wire').error, 'SESSION_EXPIRED');
  assert.equal(ctx.tools.get('mcp__wire__identity', owner), undefined);
  await until(state, () => state.serverStates.get('wire')?.state === 'connected');
  assert.equal(endpoint.state.initializes, 2, 'recovery performs a fresh initialize');
  assert.equal(endpoint.state.calls, 2, 'session-expired call never reached the business handler');
  assert.equal((await call(ctx, owner)).value.content[0].text, '2');
  const assembly = await ctx.systemPrompt.assemble({ scope: owner });
  assert.ok(assembly.sections.some(section => section.text.includes('Generation 2')));
  assert.ok(!assembly.sections.some(section => section.text.includes('Generation 1')));
});

test('real HTTP: uncertain side effects are never replayed and auth pauses until explicit retry', { timeout: 20000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t), owner = agent(ctx, dir);
  const endpoint = await wire(t);
  await writeFixture(dir, '.mcp.json', { mcpServers: { wire: { type: 'http', url: endpoint.url } } });
  const state = session(ctx, owner, { trustMode: 'all', startupTimeoutMs: 10000 });
  t.after(() => state.dispose());
  await state.reconcile(signal());
  assert.equal((await call(ctx, owner, 'mcp__wire__mutate')).isError, true);
  await until(state, () => state.serverStates.get('wire')?.state === 'reconnecting');
  await until(state, () => state.serverStates.get('wire')?.state === 'connected');
  assert.equal(endpoint.state.mutations, 1, 'a tool with possible committed side effects must not be called twice');
  endpoint.state.auth = true;
  assert.equal((await call(ctx, owner)).isError, true);
  await until(state, () => state.serverStates.get('wire')?.state === 'failed');
  assert.equal(state.serverStates.get('wire').error, 'AUTH_REQUIRED');
  assert.equal(state.serverStates.get('wire').reconnect.nextRetryAt, null);
  endpoint.state.auth = false;
  assert.equal((await state.connect(signal(), 'wire')).servers[0].state, 'connected');
});

test('real stdio: process exits after a call, reconnects, and the healthy sibling PID stays unchanged', { timeout: 20000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t), owner = agent(ctx, dir);
  const lifecycle = label => ({ ...fixtureCommand(label), env: { FIXTURE_LIFECYCLE: '1' } });
  await writeFixture(dir, '.mcp.json', { mcpServers: { wire: lifecycle('crashing'), healthy: lifecycle('healthy') } });
  const state = session(ctx, owner, { trustMode: 'all', startupTimeoutMs: 10000 });
  t.after(() => state.dispose());
  await state.reconcile(signal());
  const identity = async name => JSON.parse((await call(ctx, owner, `mcp__${name}__identity`)).value.content[0].text);
  const beforeWire = await identity('wire'), beforeHealthy = await identity('healthy');
  assert.equal((await call(ctx, owner, 'mcp__wire__exit')).isError, false);
  await until(state, () => state.serverStates.get('wire')?.state === 'reconnecting');
  assert.equal(state.serverStates.get('healthy').state, 'connected');
  await until(state, () => state.serverStates.get('wire')?.state === 'connected');
  assert.notEqual((await identity('wire')).pid, beforeWire.pid);
  assert.equal((await identity('healthy')).pid, beforeHealthy.pid);
});
