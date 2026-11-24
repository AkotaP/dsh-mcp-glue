import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { agent, callTool, fixtureCommand, harness, session, textOf, workspace, writeFixture } from './helpers.js';

const signal = () => new AbortController().signal;
const call = (ctx, owner, name = 'mcp__wire__identity') => callTool(ctx, owner, name, {}, { callId: name });
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
  const state = session(ctx, owner, { trustMode: 'all', toolLoading: 'eager', startupTimeoutMs: 10000 });
  t.after(() => state.dispose());
  await state.reconcile(signal());
  // The bridge owns reconnection now: a refused first attempt is its `reconnecting` state with
  // its own backoff, which is what the row shows.
  assert.equal(state.serverStates.get('wire').state, 'reconnecting');
  assert.equal(state.serverStates.get('wire').error, 'CONNECTION_LOST');
  assert.ok(state.serverStates.get('wire').reconnect.attempt >= 1);
  assert.equal(endpoint.state.initializes, 0);
  await listen(endpoint.server, endpoint.port);
  await until(state, () => state.serverStates.get('wire')?.state === 'connected');
  assert.equal(textOf(await call(ctx, owner)), '1');
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
  // The bridge owns disconnect detection, and an endpoint that answers 404 is still reachable, so
  // this plugin never guesses "the session died" from a request error: the row keeps its last
  // authoritative state until something changes it.
  assert.equal(state.serverStates.get('wire').state, 'connected');
  assert.equal(endpoint.state.initializes, 1, 'no reconnect was guessed from a failed call');
  // An explicit repair is the authoritative action, and it performs a fresh initialize.
  await state.disconnect(signal(), 'wire');
  const reconnected = (await state.connect(signal(), 'wire')).servers.find(row => row.id === 'wire');
  assert.equal(reconnected.state, 'connected');
  assert.equal(endpoint.state.initializes, 2, 'an explicit connect performs a fresh initialize');
  assert.equal(textOf(await call(ctx, owner)), '2');
  const assembly = await ctx.systemPrompt.assemble({ scope: owner });
  assert.ok(assembly.sections.some(section => section.text.includes('Generation 2')));
  assert.ok(!assembly.sections.some(section => section.text.includes('Generation 1')));
});

test('real HTTP: uncertain side effects are never replayed and auth pauses until explicit retry', { timeout: 20000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t), owner = agent(ctx, dir);
  const endpoint = await wire(t);
  await writeFixture(dir, '.mcp.json', { mcpServers: { wire: { type: 'http', url: endpoint.url } } });
  const state = session(ctx, owner, { trustMode: 'all', toolLoading: 'eager', startupTimeoutMs: 10000 });
  t.after(() => state.dispose());
  await state.reconcile(signal());
  assert.equal((await call(ctx, owner, 'mcp__wire__mutate')).isError, true);
  // A destroyed response is not replayed: the call fails once and the side effect stays single.
  assert.equal(endpoint.state.mutations, 1, 'a tool with possible committed side effects must not be called twice');
  const repaired = (await state.connect(signal(), 'wire')).servers.find(row => row.id === 'wire');
  assert.equal(repaired.state, 'connected');
  assert.ok(endpoint.state.initializes >= 1);
  endpoint.state.auth = true;
  assert.equal((await call(ctx, owner)).isError, true, 'a rejected call fails; it is never replayed');
  endpoint.state.auth = false;
  // Whether the transport reports the rejection as a lost connection is the bridge's call, so
  // this asserts what this plugin still owns: an explicit connect brings the server back.
  const recovered = (await state.connect(signal(), 'wire')).servers.find(row => row.id === 'wire');
  assert.equal(recovered.state, 'connected');
  assert.equal(textOf(await call(ctx, owner)), '1');
});

test('real stdio: process exits after a call, reconnects, and the healthy sibling PID stays unchanged', { timeout: 20000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t), owner = agent(ctx, dir);
  const lifecycle = label => ({ ...fixtureCommand(label), env: { FIXTURE_LIFECYCLE: '1' } });
  await writeFixture(dir, '.mcp.json', { mcpServers: { wire: lifecycle('crashing'), healthy: lifecycle('healthy') } });
  const state = session(ctx, owner, { trustMode: 'all', toolLoading: 'eager', startupTimeoutMs: 10000 });
  t.after(() => state.dispose());
  await state.reconcile(signal());
  const identity = async name => {
    const result = await call(ctx, owner, `mcp__${name}__identity`);
    return result.isError ? undefined : JSON.parse(textOf(result));
  };
  const beforeWire = await identity('wire'), beforeHealthy = await identity('healthy');
  assert.equal((await call(ctx, owner, 'mcp__wire__exit')).isError, false);
  // A child exit reaches the bridge as a closed transport, so it reconnects on its own. The
  // outage can be shorter than one polling step, which is why this waits for the new process
  // rather than for the transient `reconnecting` row.
  let recovered;
  for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
    const current = await identity('wire');
    if (current !== undefined && current.pid !== beforeWire.pid) { recovered = current; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(recovered, 'the crashed server came back on its own');
  assert.equal(state.serverStates.get('healthy').state, 'connected');
  assert.equal((await identity('healthy')).pid, beforeHealthy.pid, 'a sibling is never restarted');
});
