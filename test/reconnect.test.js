import { test as runTest } from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay, STABLE_MS } from '../src/retry.js';
import { agent, harness, session } from './helpers.js';

// Run with `node test/reconnect.test.js`: no test-runner child-process pipes,
// real transports, wall-clock sleeps, or changes to the shared harness are needed.
const test = (name, run) => runTest(name, { timeout: 5000 }, run);
const signal = () => new AbortController().signal;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const networkError = () => Object.assign(new Error('fixture offline'), { code: 'ECONNREFUSED' });
const lost = name => `mcp-client(${name}): connection lost and reconnect is disabled — registered tools will fail until an HMR reload or Host restart`;
const unsafe = name => `mcp-client(${name}): transport closure could not be confirmed during disposal — server shutdown may be incomplete`;

function fakeClock(randomValue = 1) {
  let now = 100000, sequence = 0;
  const timers = new Map(), history = [];
  return {
    now: () => now,
    random: () => randomValue,
    setTimeout(callback, delay) {
      const timer = { id: ++sequence, callback, delay, at: now + delay };
      timers.set(timer.id, timer); history.push(timer);
      return timer.id;
    },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.values()].filter(timer => timer.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        now = next.at; timers.delete(next.id); next.callback();
      }
      now = target;
    },
    get pending() { return [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id); },
    history,
  };
}

// Notifications can append work while an earlier queue item is finishing.
async function drain(state) {
  for (;;) {
    const queued = state.queue;
    await queued;
    await Promise.allSettled([...state.background]);
    await Promise.resolve();
    if (queued === state.queue && state.background.size === 0) return;
  }
}
async function advance(fixture, ms) {
  fixture.clock.tick(ms);
  await drain(fixture.state);
}
function nextDelay(fixture) {
  assert.equal(fixture.clock.pending.length, 1, 'exactly one retry timer; no leaked startup timeout');
  return fixture.clock.pending[0].at - fixture.clock.now();
}

function fakeBridge() {
  const attempts = [], modes = new Map();
  const mode = name => {
    if (!modes.has(name)) modes.set(name, {});
    return modes.get(name);
  };
  const plugin = {
    name: 'mcp-client', inject: ['tools'],
    async apply(child, config) {
      const behavior = mode(config.serverName);
      const attempt = { child, config, disposed: 0, requestError: undefined };
      attempts.push(attempt);
      const gate = behavior.gate;
      child.effect(() => () => {
        attempt.disposed++;
        gate?.resolve();
        if (attempt.unsafeOnDispose) child.logger.error(unsafe(config.serverName));
      });
      behavior.entered?.resolve(attempt);
      if (gate) await gate.promise;
      if (attempt.disposed) return;
      if (behavior.offline) throw networkError();
      child.tools.register({
        name: `mcp__${config.serverName}__identity`, description: 'reconnect fixture',
        parameters: { type: 'object', properties: {} },
        output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute() {
          if (attempt.requestError) throw attempt.requestError;
          return { server: config.serverName, generation: attempts.indexOf(attempt) + 1 };
        },
      });
    },
  };
  return { plugin, attempts, mode, release: () => { for (const behavior of modes.values()) behavior.gate?.resolve(); }, for: name => attempts.filter(attempt => attempt.config.serverName === name) };
}

async function fixture(t, { names = ['same'], required = [], config = {}, random = 1 } = {}) {
  const ctx = await harness(t), owner = agent(ctx, process.cwd(), 'reconnect-owner');
  const clock = fakeClock(random), bridge = fakeBridge(), logs = [];
  const settings = { trustMode: 'all', startupTimeoutMs: 5000, ...config };
  const plan = {
    cwd: process.cwd(), fingerprint: 'reconnect-generation', diagnostics: [],
    servers: names.map(name => ({
      source: { preset: 'fixture', file: '.mcp.json', server: name },
      spec: { required: required.includes(name), config: { serverName: name, transport: 'streamable-http', url: 'http://fixture.invalid/mcp' } },
    })),
  };
  let loads = 0;
  const state = session(ctx, owner, settings, {
    clock, nativePlugin: bridge.plugin,
    // Reachability probing has its own suite; this one owns the retry timeline and counts
    // every injected timer, so it runs without the health heartbeat.
    health: false,
    load: async (_fs, _cwd, _config, { signal: abortSignal }) => {
      abortSignal?.throwIfAborted(); loads++; return plan;
    },
    logger: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, text => logs.push({ level, text })])),
  });
  t.after(async () => {
    bridge.release();
    await state.dispose();
    assert.equal(clock.pending.length, 0, 'session teardown clears every injected timeout');
  });
  assert.equal(state.monitoring, true, 'supported shape uses the explicit-session rc.2 default');
  return { ctx, owner, state, clock, bridge, settings, plan, logs, get loads() { return loads; } };
}
const tool = (fixture, name = 'same') => fixture.ctx.tools.get(`mcp__${name}__identity`, fixture.owner);
const view = (fixture, name = 'same') => fixture.state.serverStates.get(name);
const drop = (fixture, attempt = fixture.bridge.for('same').at(-1)) => attempt.child.logger.error(lost(attempt.config.serverName));

test('retry delays have deterministic jitter, exponential steps, a 60-second ceiling and no attempt cap', () => {
  const bases = [1000, 2000, 4000, 8000, 16000, 30000, 60000];
  for (const [index, base] of bases.entries()) {
    assert.equal(retryDelay(index + 1, () => 0), Math.round(base * 0.8));
    assert.equal(retryDelay(index + 1, () => 0.5), Math.round(base * 0.9));
    assert.equal(retryDelay(index + 1, () => 1), base);
  }
  for (const attempt of [8, 20, 1000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(retryDelay(attempt, () => 0), 48000);
    assert.equal(retryDelay(attempt, () => 1), 60000);
  }
});

test('offline startup recovers in the background without reconcile, UI, assembly or another message', async t => {
  const f = await fixture(t, { random: 0.5 });
  f.bridge.mode('same').offline = true;
  await f.state.reconcile(signal());
  assert.equal(f.bridge.attempts.length, 1);
  assert.equal(f.bridge.attempts[0].disposed, 1);
  assert.equal(view(f).state, 'reconnecting');
  assert.deepEqual(view(f).reconnect, { eligible: true, attempt: 1, nextRetryAt: 100900, reason: 'ECONNREFUSED' });
  assert.equal(tool(f), undefined);
  assert.equal(nextDelay(f), 900);
  await advance(f, 899);
  assert.equal(f.bridge.attempts.length, 1);
  f.bridge.mode('same').offline = false;
  await advance(f, 1);
  assert.equal(f.bridge.attempts.length, 2);
  assert.equal(f.loads, 2, 'initial declaration load and autonomous retry only');
  assert.equal(view(f).state, 'connected');
  assert.equal(view(f).reconnect.nextRetryAt, null);
  assert.ok(tool(f));
  assert.equal(f.clock.pending.length, 0, 'successful startup cleared its timeout');
  for (const attempt of f.bridge.attempts) {
    assert.equal(attempt.config.failOnStartupError, true);
    assert.deepEqual(attempt.config.reconnect, { enabled: false }, 'only workspace runtime owns retries');
  }
});

test('an outage keeps retrying indefinitely at the ceiling without leaking startup timers', async t => {
  const f = await fixture(t);
  f.bridge.mode('same').offline = true;
  await f.state.reconcile(signal());
  const delays = [1000, 2000, 4000, 8000, 16000, 30000, ...Array(12).fill(60000)];
  for (const [index, delay] of delays.entries()) {
    assert.equal(nextDelay(f), delay);
    assert.equal(view(f).reconnect.attempt, index + 1);
    await advance(f, delay);
    assert.equal(f.bridge.attempts.length, index + 2);
  }
  f.bridge.mode('same').offline = false;
  await advance(f, nextDelay(f));
  assert.equal(view(f).state, 'connected', 'late recovery is not disabled by an attempt budget');
  assert.equal(f.clock.pending.length, 0);
});

test('manual connect without automatic permission is one-shot, including after a later connection loss', async t => {
  const f = await fixture(t, { config: { trustMode: 'manual' } });
  f.bridge.mode('same').offline = true;
  await f.state.reconcile(signal());
  assert.equal(f.bridge.attempts.length, 0);
  await f.state.connect(signal(), 'same');
  assert.equal(f.bridge.attempts.length, 1);
  assert.equal(view(f).state, 'failed');
  assert.equal(view(f).reconnect.eligible, false);
  assert.equal(f.clock.pending.length, 0);
  await advance(f, 600000);
  await f.state.reconcile(signal());
  assert.equal(f.bridge.attempts.length, 1, 'requests cannot turn one-shot consent into background authority');
  f.bridge.mode('same').offline = false;
  await f.state.connect(signal(), 'same');
  assert.equal(f.bridge.attempts.length, 2);
  assert.equal(view(f).state, 'connected');
  drop(f); await drain(f.state);
  assert.equal(view(f).state, 'failed');
  assert.equal(f.clock.pending.length, 0);
});

test('custom selection still retries automatically when policy allows the selected server', async t => {
  const f = await fixture(t);
  f.bridge.mode('same').offline = true;
  await f.state.connect(signal(), 'same');
  assert.equal(f.state.selectionMode, 'custom');
  assert.equal(view(f).reconnect.eligible, true);
  f.bridge.mode('same').offline = false;
  await advance(f, nextDelay(f));
  assert.equal(view(f).state, 'connected');
  assert.equal(f.bridge.attempts.length, 2);
});

test('manual disconnect cancels a retry timer, and its already-captured callback is harmless', async t => {
  const f = await fixture(t);
  f.bridge.mode('same').offline = true;
  await f.state.reconcile(signal());
  const staleTimer = f.clock.pending[0];
  await f.state.disconnect(signal(), 'same');
  assert.equal(f.clock.pending.length, 0);
  assert.equal(f.state.mounts.size, 0);
  staleTimer.callback(); await drain(f.state);
  await advance(f, 600000);
  assert.equal(f.bridge.attempts.length, 1);
  assert.equal(tool(f), undefined);
});

test('manual disconnect interrupts retry initialize in flight and removes all startup timeouts', async t => {
  const f = await fixture(t);
  f.bridge.mode('same').offline = true;
  await f.state.reconcile(signal());
  const behavior = f.bridge.mode('same');
  behavior.offline = false; behavior.gate = deferred(); behavior.entered = deferred();
  f.clock.tick(nextDelay(f));
  const pending = await behavior.entered.promise;
  const record = f.state.mounts.get('same');
  assert.equal(record.controller.signal.aborted, false);
  assert.equal(f.clock.pending.length, 1, 'only initialize deadline is live');
  const disconnecting = f.state.disconnect(signal(), 'same');
  assert.equal(record.controller.signal.aborted, true, 'abort initialize before waiting for its queue');
  // Cordis joins async apply before running effects. Release the simulated remote
  // handshake only after checking cancellation; it may not publish after abort.
  behavior.gate.resolve();
  await disconnecting;
  assert.equal(pending.disposed, 1);
  assert.equal(f.clock.pending.length, 0);
  assert.equal(tool(f), undefined);
  await advance(f, 600000);
  assert.equal(f.bridge.attempts.length, 2);
});

test('retrying or manually toggling one server never restarts a healthy sibling fiber', async t => {
  const f = await fixture(t, { names: ['same', 'healthy'] });
  await f.state.reconcile(signal());
  const healthy = f.bridge.for('healthy')[0], healthyTool = tool(f, 'healthy');
  const boundary = f.state.mounts.get('healthy').boundary;
  drop(f); await drain(f.state);
  await advance(f, nextDelay(f));
  await f.state.disconnect(signal(), 'same');
  await f.state.connect(signal(), 'same');
  assert.equal(f.bridge.for('healthy').length, 1);
  assert.equal(healthy.disposed, 0);
  assert.equal(f.state.mounts.get('healthy').boundary, boundary);
  assert.equal(tool(f, 'healthy'), healthyTool);
  assert.equal(view(f, 'healthy').state, 'connected');
});

test('a slow optional MCP recovery does not hold model requests or healthy tools behind initialize', async t => {
  const f = await fixture(t, { names: ['same', 'healthy'] });
  f.bridge.mode('same').offline = true;
  await f.state.reconcile(signal());
  const behavior = f.bridge.mode('same');
  behavior.offline = false; behavior.gate = deferred(); behavior.entered = deferred();
  f.clock.tick(nextDelay(f));
  await behavior.entered.promise;
  assert.equal(f.state.background.size, 1);
  // Deliberately leave initialize unresolved: reconcile must not await the recovery task.
  await f.state.reconcile(signal());
  assert.equal(view(f).state, 'reconnecting');
  assert.deepEqual(await tool(f, 'healthy').execute({}, { signal: signal() }), { server: 'healthy', generation: 2 });
  assert.equal(f.bridge.for('healthy').length, 1);
  behavior.gate.resolve();
  await drain(f.state);
  assert.equal(view(f).state, 'connected');
});

test('simultaneous background recoveries share the six-connection cap and cancelled slot waiters never start late', async t => {
  const names = Array.from({ length: 8 }, (_value, index) => `server${index}`);
  const f = await fixture(t, { names });
  for (const name of names) f.bridge.mode(name).offline = true;
  await f.state.reconcile(signal());
  for (const name of names) {
    const behavior = f.bridge.mode(name);
    behavior.offline = false; behavior.gate = deferred(); behavior.entered = deferred();
  }
  const sixEntered = deferred(); let entered = 0;
  for (const name of names) void f.bridge.mode(name).entered.promise.then(() => { if (++entered === 6) sixEntered.resolve(); });
  f.clock.tick(1000);
  await sixEntered.promise;
  await f.state.queue;
  assert.equal(f.bridge.attempts.length, 8 + 6, 'only six retry handshakes entered native apply');
  const stopping = f.state.disconnect(signal());
  for (const name of names) f.bridge.mode(name).gate.resolve();
  await stopping; await drain(f.state);
  assert.equal(f.bridge.attempts.length, 8 + 6, 'the two cancelled waiters never enter native apply');
  assert.equal(f.state.background.size, 0);
  assert.equal(f.clock.pending.length, 0);
});

test('repeated native lost and request-failed notifications deduplicate disposal and retry scheduling', async t => {
  const f = await fixture(t);
  await f.state.reconcile(signal());
  const first = f.bridge.attempts[0], oldTool = tool(f);
  first.requestError = networkError();
  drop(f); drop(f); drop(f);
  await assert.rejects(() => oldTool.execute({}, { signal: signal() }), { code: 'ECONNREFUSED' });
  await drain(f.state);
  assert.equal(first.disposed, 1);
  assert.equal(view(f).reconnect.attempt, 1);
  assert.equal(nextDelay(f), 1000);
  drop(f, first); await drain(f.state);
  assert.equal(nextDelay(f), 1000);
  assert.equal(view(f).reconnect.attempt, 1);
  await advance(f, 1000);
  assert.equal(f.bridge.attempts.length, 2);
  assert.equal(view(f).state, 'connected');
});

test('required failure blocks reconcile without request-driven hammering, then clears on background recovery', async t => {
  const f = await fixture(t, { required: ['same'] });
  f.bridge.mode('same').offline = true;
  await assert.rejects(() => f.state.reconcile(signal()), /required server failed/);
  assert.equal(f.state.requiredFailure, true);
  const timer = f.clock.pending[0];
  for (let index = 0; index < 8; index++) {
    await assert.rejects(() => f.state.reconcile(signal()), /required server failed/);
  }
  assert.equal(f.bridge.attempts.length, 1);
  assert.equal(f.clock.pending[0], timer, 'requests do not restart or postpone the backoff');
  f.bridge.mode('same').offline = false;
  await advance(f, nextDelay(f));
  assert.equal(f.state.requiredFailure, false);
  assert.equal(view(f).state, 'connected');
  await f.state.reconcile(signal());
  assert.equal(f.bridge.attempts.length, 2);
});

test('policyChanged revocation cancels a queued retry immediately', async t => {
  const f = await fixture(t, { config: { trustMode: 'manual', workspaceAllowances: [{ workspace: process.cwd(), allowMcp: ['same'] }] } });
  f.bridge.mode('same').offline = true;
  await f.state.reconcile(signal());
  const timer = f.clock.pending[0];
  f.settings.workspaceAllowances = [];
  await f.state.policyChanged();
  assert.equal(f.clock.pending.length, 0);
  assert.equal(f.state.mounts.size, 0);
  timer.callback(); await drain(f.state);
  await advance(f, 600000);
  assert.equal(f.bridge.attempts.length, 1);
});

test('policyChanged revocation aborts an automatic initialize already in flight, even in custom mode', async t => {
  const f = await fixture(t, { config: { trustMode: 'manual', workspaceAllowances: [{ workspace: process.cwd(), allowMcp: ['same'] }] } });
  f.bridge.mode('same').offline = true;
  await f.state.connect(signal(), 'same');
  const behavior = f.bridge.mode('same');
  behavior.offline = false; behavior.gate = deferred(); behavior.entered = deferred();
  f.clock.tick(nextDelay(f));
  const pending = await behavior.entered.promise;
  const record = f.state.mounts.get('same');
  const aborted = deferred();
  record.controller.signal.addEventListener('abort', aborted.resolve, { once: true });
  f.settings.workspaceAllowances = [];
  const changing = f.state.policyChanged();
  await aborted.promise;
  assert.equal(record.controller.signal.aborted, true);
  behavior.gate.resolve();
  await changing;
  assert.equal(pending.disposed, 1);
  assert.equal(view(f).state, 'failed');
  assert.equal(view(f).reconnect.eligible, false);
  assert.equal(f.clock.pending.length, 0);
  assert.equal(tool(f), undefined);
  await advance(f, 600000);
  assert.equal(f.bridge.attempts.length, 2);
});

test('owner disposal aborts pending startup without retrying or retaining deadline timers', async t => {
  const f = await fixture(t);
  const behavior = f.bridge.mode('same');
  behavior.gate = deferred(); behavior.entered = deferred();
  const starting = f.state.reconcile(signal());
  // Attach rejection handling before disposal aborts the queued update.
  const rejected = assert.rejects(starting, /disposed/);
  const pending = await behavior.entered.promise;
  const disposing = f.state.dispose();
  assert.equal(f.state.abort.signal.aborted, true);
  behavior.gate.resolve();
  await disposing;
  await rejected;
  assert.equal(pending.disposed, 1);
  assert.equal(f.clock.pending.length, 0);
  assert.equal(tool(f), undefined);
  drop(f, pending); await drain(f.state);
  await advance(f, 600000);
  assert.equal(f.bridge.attempts.length, 1);
});

test('aborting the initiating request leaves no startup, retry timer or native tool behind', async t => {
  const f = await fixture(t), controller = new AbortController();
  const behavior = f.bridge.mode('same');
  behavior.gate = deferred(); behavior.entered = deferred();
  const starting = f.state.reconcile(controller.signal);
  const rejected = assert.rejects(starting, /fixture request aborted/);
  const pending = await behavior.entered.promise;
  controller.abort(new Error('fixture request aborted'));
  behavior.gate.resolve();
  await rejected;
  assert.equal(pending.disposed, 1);
  assert.equal(f.clock.pending.length, 0);
  assert.equal(tool(f), undefined);
  await advance(f, 600000);
  assert.equal(f.bridge.attempts.length, 1);
});

test('unsafe closure stops automatic and explicit manual retries for the session', async t => {
  const f = await fixture(t);
  await f.state.reconcile(signal());
  const first = f.bridge.attempts[0];
  first.child.logger.error(unsafe('same'));
  await drain(f.state);
  assert.equal(first.disposed, 1);
  assert.equal(view(f).state, 'failed');
  assert.equal(view(f).error, 'CLOSE_UNCONFIRMED');
  assert.equal(f.clock.pending.length, 0);
  await f.state.connect(signal(), 'same');
  await f.state.disconnect(signal(), 'same');
  await f.state.connect(signal(), 'same');
  await advance(f, 600000);
  assert.equal(f.bridge.attempts.length, 1, 'unconfirmed shutdown must never overlap a new process');
  assert.equal(tool(f), undefined);
});

test('unsafe-close reported during loss cleanup supersedes the retry timer', async t => {
  const f = await fixture(t);
  await f.state.reconcile(signal());
  f.bridge.attempts[0].unsafeOnDispose = true;
  drop(f); await drain(f.state);
  assert.equal(view(f).state, 'failed');
  assert.equal(view(f).error, 'CLOSE_UNCONFIRMED');
  assert.equal(f.clock.pending.length, 0);
  await f.state.connect(signal(), 'same');
  assert.equal(f.bridge.attempts.length, 1);
});

test('stale lost notifications, request callbacks and timer callbacks cannot affect a replacement record', async t => {
  const f = await fixture(t);
  await f.state.reconcile(signal());
  const first = f.bridge.attempts[0], oldTool = tool(f);
  first.requestError = networkError();
  drop(f); await drain(f.state);
  const staleTimer = f.clock.pending[0];
  await f.state.connect(signal(), 'same');
  const replacement = tool(f), version = f.state.statusVersion;
  drop(f, first);
  await assert.rejects(() => oldTool.execute({}, { signal: signal() }), { code: 'ECONNREFUSED' });
  staleTimer.callback(); await drain(f.state);
  assert.equal(tool(f), replacement);
  assert.equal(view(f).state, 'connected');
  assert.equal(f.state.statusVersion, version);
  assert.equal(f.bridge.attempts.length, 2);
  assert.equal(f.clock.pending.length, 0);
});

test('stale native callbacks are ignored after retry advances the token on the same record', async t => {
  const f = await fixture(t);
  await f.state.reconcile(signal());
  const first = f.bridge.attempts[0], oldTool = tool(f), record = f.state.mounts.get('same');
  first.requestError = networkError();
  drop(f); await drain(f.state);
  await advance(f, nextDelay(f));
  assert.equal(f.state.mounts.get('same'), record, 'background retries retain the record but advance its token');
  const replacement = tool(f), version = f.state.statusVersion;
  drop(f, first);
  await assert.rejects(() => oldTool.execute({}, { signal: signal() }), { code: 'ECONNREFUSED' });
  await drain(f.state);
  assert.equal(tool(f), replacement);
  assert.equal(view(f).state, 'connected');
  assert.equal(f.state.statusVersion, version);
  assert.equal(f.bridge.attempts.length, 2);
  assert.equal(f.clock.pending.length, 0);
});

test('stale unsafe-close callbacks cannot poison a replacement generation or its future retries', async t => {
  const f = await fixture(t);
  await f.state.reconcile(signal());
  const stale = f.bridge.attempts[0];
  await f.state.disconnect(signal(), 'same');
  await f.state.connect(signal(), 'same');
  stale.child.logger.error(unsafe('same'));
  await drain(f.state);
  assert.equal(f.state.unsafeNames.has('same'), false, 'ignore old generation lifecycle callbacks before changing shutdown safety');
  drop(f); await drain(f.state);
  await advance(f, nextDelay(f));
  assert.equal(view(f).state, 'connected');
  assert.equal(f.bridge.attempts.length, 3);
});

test('a throwing teardown fails closed instead of leaving a false connected state or spawning another instance', async t => {
  const f = await fixture(t);
  await f.state.reconcile(signal());
  const boundary = f.state.mounts.get('same').boundary;
  const dispose = boundary.dispose;
  boundary.dispose = async () => { throw new Error('CLEANUP_SECRET'); };
  drop(f); await drain(f.state);
  assert.equal(view(f).state, 'failed');
  assert.equal(view(f).error, 'CLOSE_UNCONFIRMED');
  assert.equal(f.clock.pending.length, 0);
  await f.state.connect(signal(), 'same');
  assert.equal(f.bridge.attempts.length, 1);
  assert.ok(!JSON.stringify(f.logs).includes('CLEANUP_SECRET'));
  await dispose();
});

test('unstable reconnects retain their backoff budget; a stable connection resets it', async t => {
  const f = await fixture(t);
  f.bridge.mode('same').offline = true;
  await f.state.reconcile(signal());
  await advance(f, nextDelay(f));
  assert.equal(nextDelay(f), 2000);
  f.bridge.mode('same').offline = false;
  await advance(f, 2000);
  await advance(f, STABLE_MS - 1);
  drop(f); await drain(f.state);
  assert.equal(nextDelay(f), 4000, 'a brief healthy interval must not reset the outage budget');
  await advance(f, 4000);
  await advance(f, STABLE_MS);
  drop(f); await drain(f.state);
  assert.equal(nextDelay(f), 1000, 'a genuinely stable connection earns fresh initial backoff');
});

test('startup timeout disposes initialize, replaces its deadline with one retry, and clears all timers after recovery', async t => {
  const f = await fixture(t);
  const behavior = f.bridge.mode('same');
  behavior.gate = deferred(); behavior.entered = deferred();
  const starting = f.state.reconcile(signal());
  const pending = await behavior.entered.promise;
  assert.equal(f.clock.pending.length, 1);
  assert.equal(f.clock.pending[0].delay, 5000);
  f.clock.tick(5000);
  behavior.gate.resolve();
  await starting;
  assert.equal(pending.disposed, 1);
  assert.equal(tool(f), undefined);
  assert.equal(nextDelay(f), 1000);
  behavior.gate = undefined;
  await advance(f, 1000);
  assert.equal(view(f).state, 'connected');
  assert.equal(f.bridge.attempts.length, 2);
  assert.equal(f.clock.pending.length, 0);
});
