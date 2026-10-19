import test from 'node:test';
import assert from 'node:assert/strict';
import { HEALTH, probeHttp, probeTarget } from '../src/health.js';
import { agent, harness, session } from './helpers.js';

const signal = () => new AbortController().signal;

/** Deterministic clock: probes and retries are the only timers this session owns. */
function fakeClock() {
  let now = 100000, sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    random: () => 1,
    setTimeout(callback, delay) {
      const timer = { id: ++sequence, callback, at: now + delay };
      timers.set(timer.id, timer);
      return timer.id;
    },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.values()].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        now = next.at; timers.delete(next.id); next.callback();
      }
      now = target;
    },
    get pending() { return [...timers.values()]; },
  };
}
async function drain(state) {
  // Probes settle outside the session queue (they must never hold it), so a probe result
  // can enqueue its next step only after the queue was already read. Loop until quiet.
  for (let round = 0; round < 8; round++) {
    const queue = state.queue;
    await Promise.allSettled([
      queue, ...state.background,
      ...[...state.mounts.values()].map(record => record.probing).filter(Boolean),
    ]);
    await Promise.resolve();
    await Promise.resolve();
    const busy = state.background.size > 0 || [...state.mounts.values()].some(record => record.probing);
    if (!busy && state.queue === queue) return;
  }
}
const refusal = () => Object.assign(new Error('fixture offline'), { code: 'ECONNREFUSED' });

test('a probe treats any HTTP answer as alive and only network failures as gone', async () => {
  const alive = async () => ({ body: { cancel() {} } });
  assert.deepEqual(await probeHttp('http://x.test/mcp', { fetchImpl: async () => ({ status: 405 }) }), { reachable: true });
  assert.deepEqual(await probeHttp('http://x.test/mcp', { fetchImpl: alive }), { reachable: true });
  assert.deepEqual(await probeHttp('http://x.test/mcp', { fetchImpl: async () => { throw refusal(); } }), { reachable: false, code: 'ECONNREFUSED' });
  assert.deepEqual(await probeHttp('http://x.test/mcp', { fetchImpl: async () => { throw Object.assign(new Error('outer'), { cause: refusal() }); } }), { reachable: false, code: 'ECONNREFUSED' });
  assert.deepEqual(await probeHttp('http://x.test/mcp', { fetchImpl: async () => { throw new Error('opaque'); } }), { reachable: false, code: 'PROBE_FAILED' });
  // HEAD rejected outright is not an outage: one GET decides.
  let calls = 0;
  assert.deepEqual(await probeHttp('http://x.test/mcp', { fetchImpl: async () => { calls++; if (calls === 1) throw new Error('head rejected'); return alive(); } }), { reachable: true });
  assert.equal(calls, 2);
  // Credentials never travel in a probe, and only HTTP endpoints are probed at all.
  assert.equal(probeTarget({ config: { transport: 'streamable-http', url: 'https://h.test/mcp?token=secret' } }), 'https://h.test/mcp');
  assert.equal(probeTarget({ config: { transport: 'stdio', command: 'node' } }), undefined);
  assert.equal(probeTarget({ config: { transport: 'streamable-http', url: 'file:///etc/passwd' } }), undefined);
});

/** One HTTP server mounted through a native bridge stub of the verified shape. */
async function fixture(t) {
  const ctx = await harness(t), owner = agent(ctx, process.cwd(), 'health-owner');
  const clock = fakeClock(), probe = { reachable: true }, logs = [];
  const nativePlugin = { name: 'mcp-client', inject: ['tools'], async apply(child, config) {
    child.tools.register({
      name: `mcp__${config.serverName}__identity`, description: 'health fixture',
      parameters: { type: 'object', properties: {} }, execute: () => 'ok',
      output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
    });
  } };
  const entry = name => ({
    source: { preset: 'fixture', file: '.mcp.json', server: name },
    spec: { config: { serverName: name, transport: 'streamable-http', url: 'http://fixture.invalid/mcp' } },
  });
  const plan = { cwd: process.cwd(), fingerprint: 'health-generation', diagnostics: [], servers: [entry('wire')] };
  const state = session(ctx, owner, { trustMode: 'all' }, {
    clock, nativePlugin,
    load: async () => plan,
    logger: Object.fromEntries(['warn', 'error', 'info', 'debug'].map(level => [level, text => logs.push(`${level}: ${text}`)])),
    fetchImpl: async () => { if (!probe.reachable) throw refusal(); return { body: { cancel() {} } }; },
  });
  t.after(() => state.dispose());
  return { ctx, owner, state, clock, probe, plan };
}
const rowOf = async state => (await state.status()).servers.find(row => row.id === 'wire');

test('an unreachable HTTP server turns the row unconfirmed first and reconnects on confirmation', async t => {
  const f = await fixture(t);
  await f.state.reconcile(signal());
  assert.equal((await rowOf(f.state)).verified, true, 'a fresh connection is its own confirmation');

  f.probe.reachable = false;
  f.clock.tick(HEALTH.hotMs);
  await drain(f.state);
  let row = await rowOf(f.state);
  assert.equal(row.state, 'connected', 'one failed probe must not tear down a possibly working connection');
  assert.equal(row.verified, false, 'but the green claim is withdrawn immediately');

  f.clock.tick(HEALTH.confirmMs);
  await drain(f.state);
  row = await rowOf(f.state);
  assert.equal(row.state, 'reconnecting', 'the confirmation probe hands the server to the reconnect supervisor');
  assert.equal(f.ctx.tools.get('mcp__wire__identity', f.owner), undefined, 'its tools are withdrawn while down');

  f.probe.reachable = true;
  f.clock.tick(60000);
  await drain(f.state);
  row = await rowOf(f.state);
  assert.equal(row.state, 'connected');
  assert.equal(row.verified, true, 'a recovered connection is confirmed again');
});

test('a working connection survives a blocked probe once real traffic answers', async t => {
  const f = await fixture(t);
  await f.state.reconcile(signal());
  const tool = f.ctx.tools.get('mcp__wire__identity', f.owner);
  f.probe.reachable = false;
  f.clock.tick(HEALTH.hotMs);
  await drain(f.state);
  assert.equal((await rowOf(f.state)).verified, false);

  // The bridge reports a real answer, which outranks a probe that a firewall may be eating.
  assert.equal(typeof tool.execute, 'function');
  await tool.execute({}, { agent: f.owner, signal: signal(), callId: 'health-call' });
  await drain(f.state);
  assert.equal(f.state.serverStates.get('wire').state, 'connected');
  assert.equal(f.state.mounts.get('wire').probeFailures, 0, 'traffic clears the strike count');
});

test('stdio servers are never probed, and a pre-call check never waits on a fresh connection', async t => {
  const f = await fixture(t);
  f.plan.servers = [{ source: { preset: 'fixture', file: '.mcp.json', server: 'wire' },
    spec: { config: { serverName: 'wire', transport: 'stdio', command: 'node', args: [] } } }];
  await f.state.reconcile(signal());
  const record = f.state.mounts.get('wire');
  assert.equal(record.probeTimer, undefined, 'a child process exit reaches us as an event; no probe is needed');
  assert.equal((await rowOf(f.state)).verified, true);

  const fresh = await f.state.verifyBeforeCall('wire', signal());
  assert.equal(fresh, undefined, 'a stdio call is never delayed by a probe');
  assert.equal(await f.state.verifyBeforeCall('missing', signal()), undefined);
});
