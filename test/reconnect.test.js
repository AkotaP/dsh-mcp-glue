import { test as runTest } from 'node:test';
import assert from 'node:assert/strict';
import { agent, fakeHost, harness, session } from './helpers.js';

// The bridge owns reconnection, its backoff and its attempt budget, so this suite covers the
// contract this plugin still has: mount through the host, mirror its typed status, and stop an
// instance exactly when this plugin's own policy revokes it.
const test = (name, run) => runTest(name, { timeout: 10000 }, run);
const signal = () => new AbortController().signal;
const connected = (toolCount = 1) => ({ state: 'connected', toolCount, connectedAt: 100000 });

/** Deterministic clock: the timers this session still owns are its startup wait and probes. */
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
        const next = [...timers.values()].filter(timer => timer.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        now = next.at; timers.delete(next.id); next.callback();
      }
      now = target;
    },
    get pending() { return [...timers.values()]; },
  };
}
/** Let already-scheduled microtasks (a mount activation, a status callback) run. */
const flush = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve)); };
/** Poll a real-clock condition, because declaration loading touches the filesystem. */
const waitFor = async predicate => {
  for (let index = 0; index < 200 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 5));
};

async function fixture(t, { names = ['same'], config = {}, servers = {}, spec = {}, clock = fakeClock() } = {}) {
  const ctx = await harness(t), owner = agent(ctx, process.cwd(), 'reconnect-owner');
  const host = fakeHost({
    // Every fake mount publishes the same tool, so a row's tool list reflects the registry the
    // plugin actually reads rather than a fabricated status field.
    mount: (record, index) => {
      record.context.tools.register({
        name: `mcp__${record.config.serverName}__identity`, description: 'reconnect fixture',
        parameters: { type: 'object', properties: {} }, execute: () => 'ok',
        output: { schema: {}, render: () => [{ type: 'text', text: 'ok' }] },
      });
      return spec.mount?.(record, index) ?? {};
    },
    probe: spec.probe,
    validate: spec.validate,
    authorization: spec.authorization,
    dispose: spec.dispose,
  });
  const plan = {
    cwd: process.cwd(), fingerprint: 'reconnect-generation', diagnostics: [],
    servers: names.map(name => ({
      source: { preset: 'fixture', file: '.mcp.json', server: name },
      spec: {
        ...(servers[name] ?? {}),
        config: { serverName: name, transport: 'streamable-http', url: 'http://fixture.invalid/mcp', ...(servers[name] ?? {}) },
      },
    })),
  };
  const state = session(ctx, owner, { trustMode: 'all', startupTimeoutMs: 5000, ...config }, {
    clock,
    // Reachability probing has its own suite; this one owns mounting and the status contract.
    health: false,
    nativePlugin: host.module,
    load: async () => plan,
  });
  t.after(() => state.dispose());
  return { ctx, owner, state, host, plan, clock };
}
const view = (fixture, name = 'same') => fixture.state.serverStates.get(name);
const tool = (fixture, name = 'same') => fixture.ctx.tools.get(`mcp__${name}__identity`, fixture.owner);

test('a mount goes through the host with resolved defaults and never fails its own startup', async t => {
  const f = await fixture(t, { servers: { same: { startupTimeoutMs: 4000 } } });
  await f.state.reconcile(signal());
  assert.equal(f.host.calls.mounts.length, 1);
  const mounted = f.host.calls.mounts[0].config;
  assert.equal(f.host.calls.validates.length, 1, 'the bridge resolves the configuration, not this plugin');
  assert.deepEqual(f.host.calls.validates[0].path, ['mcp', 'same']);
  // A failed first attempt is the status machine's news to report; rejecting the fiber would
  // hide `waiting-authorization` behind a startup error.
  assert.equal(mounted.failOnStartupError, false);
  assert.equal(mounted.toolLoading, 'on-demand', 'the new default keeps every catalog out of the tool list');
  assert.equal(mounted.catalogDescriptionMaxLength, 160);
  assert.equal(mounted.startupTimeoutMs, 4000, 'a declaration budget wins over the profile default');
  assert.equal(view(f).state, 'connected');
  assert.deepEqual(view(f).tools, ['mcp__same__identity']);
  assert.equal(view(f).toolLoading, 'on-demand');
});

test('a profile can ask for eager registration and a declaration can narrow the catalog', async t => {
  const eager = await fixture(t, { config: { toolLoading: 'eager', catalogDescriptionMaxLength: 60 } });
  await eager.state.reconcile(signal());
  assert.equal(eager.host.calls.mounts[0].config.toolLoading, 'eager');
  assert.equal(eager.host.calls.mounts[0].config.catalogDescriptionMaxLength, 60);
  const narrowed = await fixture(t, { servers: { same: { toolLoading: 'on-demand', catalogDescriptionMaxLength: 40 } } });
  await narrowed.state.reconcile(signal());
  assert.equal(narrowed.host.calls.mounts[0].config.toolLoading, 'on-demand');
  assert.equal(narrowed.host.calls.mounts[0].config.catalogDescriptionMaxLength, 40);
});

test('the typed status becomes the row: connecting, reconnecting, gave-up and disabled', async t => {
  const f = await fixture(t);
  await f.state.reconcile(signal());
  const record = f.host.calls.mounts[0];
  record.status.publish({ state: 'reconnecting', attempt: 3, maxAttempts: 10, nextRetryAtMs: 101500, lastError: 'socket hang up' });
  let row = view(f);
  assert.equal(row.state, 'reconnecting');
  assert.equal(row.error, 'CONNECTION_LOST');
  assert.deepEqual(row.reconnect, { eligible: true, attempt: 3, maxAttempts: 10, nextRetryAt: 101500, reason: 'socket hang up' });
  assert.deepEqual(row.tools, [], 'tools disappear while the generation is down');
  record.status.publish({ state: 'connecting', attempt: 4 });
  assert.equal(view(f).state, 'pending');
  record.status.publish({ state: 'failed', reason: 'gave-up', lastError: 'boom' });
  row = view(f);
  assert.equal(row.state, 'failed');
  assert.equal(row.error, 'RECONNECT_GAVE_UP');
  assert.equal(row.detail, 'boom');
  record.status.publish({ state: 'failed', reason: 'reconnect-disabled' });
  assert.equal(view(f).error, 'RECONNECT_DISABLED');
  record.status.publish({ state: 'failed', reason: 'unclosed-generation' });
  row = view(f);
  assert.equal(row.error, 'CLOSE_UNCONFIRMED');
  assert.equal(f.state.unsafeNames.has('same'), true, 'an unclosed generation may never respawn');
  await f.state.connect(signal(), 'same');
  assert.equal(f.host.calls.mounts.length, 1, 'the blocked name is not mounted again');
});

test('waiting for a browser grant is its own row state, with the bridge’s typed reason', async t => {
  const f = await fixture(t, { servers: { same: { oauth: { credentialKey: 'mcp-client/test' } } } });
  await f.state.reconcile(signal());
  const record = f.host.calls.mounts[0];
  record.status.publish({ state: 'waiting-authorization', reason: 'missing', lastError: 'no grant stored' });
  const row = view(f);
  assert.equal(row.state, 'authorization');
  assert.equal(row.error, 'AUTHORIZATION_REQUIRED');
  assert.equal(row.authorization.reason, 'missing');
  assert.equal(row.detail, 'no grant stored');
  assert.equal((await f.state.status()).counts.authorization, 1);
});

test('a credential template with no value is reported instead of looking like an outage', async t => {
  const f = await fixture(t);
  await f.state.reconcile(signal());
  f.host.calls.mounts[0].status.publish({ state: 'waiting-credentials', lastError: '${credential:token} is not configured' });
  const row = view(f);
  assert.equal(row.state, 'failed');
  assert.equal(row.error, 'MISSING_CREDENTIALS');
});

test('browser authorization starts through the host, exposes its page and can be cancelled', async t => {
  const f = await fixture(t, { servers: { same: { oauth: { credentialKey: 'mcp-client/test' } } } });
  await f.state.reconcile(signal());
  const attempt = (await f.state.authorize('same')).servers.find(row => row.id === 'same')?.authorization;
  assert.equal(f.host.calls.authorizations.length, 1);
  assert.equal(attempt.phase, 'waiting-browser');
  assert.equal(attempt.authorizationUrl, 'https://auth.example/consent');
  // The owner reports progress through the callback the plugin handed it, which is what moves
  // the row while the browser page is open.
  const owner = f.host.calls.authorizations[0].owner;
  owner.publish({ phase: 'exchanging' });
  assert.equal(view(f).authorization.phase, 'exchanging');
  await f.state.cancelAuthorization('same');
  assert.equal(owner.cancelled, 1);
  assert.equal(view(f).authorization.phase, 'cancelled');

  const stdio = await fixture(t, { servers: { same: { transport: 'stdio', command: 'node', url: undefined } } });
  await stdio.state.reconcile(signal());
  await assert.rejects(stdio.state.authorize('same'), failure => failure.code === 'OAUTH_UNSUPPORTED');
  await assert.rejects(f.state.authorize('missing'), failure => failure.code === 'UNKNOWN_SERVER');
});

test('a refused configuration fails the row instead of half-mounting it', async t => {
  const f = await fixture(t, { spec: { validate: () => { throw new Error('mcp.same: url must be a string'); } } });
  await f.state.reconcile(signal());
  assert.equal(f.host.calls.mounts.length, 0);
  const row = view(f);
  assert.equal(row.state, 'failed');
  assert.equal(row.error, 'INVALID_CONFIG');
  assert.match(row.detail, /url must be a string/);
  assert.equal(row.reconnect.attempt, 0, 'a refused declaration schedules no retry');
});

test('a mount that rejects reports the failure once and waits for a new declaration', async t => {
  const f = await fixture(t, { spec: { mount: () => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }) } });
  await f.state.reconcile(signal());
  assert.equal(f.host.calls.mounts.length, 1);
  const row = view(f);
  assert.equal(row.state, 'failed');
  assert.equal(row.error, 'ENOENT', 'the bridge’s own code is reported as-is');
  await f.state.reconcile(signal());
  assert.equal(f.host.calls.mounts.length, 1, 'an unchanged declaration is not remounted behind the bridge');
});

test('a mount that outlives its startup budget keeps running and publishes when it settles', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {
    config: { startupTimeoutMs: 100 },
    spec: { mount: () => ({ gate }) },
  });
  const started = f.state.reconcile(signal());
  await waitFor(() => f.clock.pending.length > 0);
  assert.equal(f.clock.pending.length, 1, 'the startup wait is the one timer');
  f.clock.tick(6000);
  await started;
  assert.equal(view(f).error, 'STARTUP_TIMEOUT');
  assert.equal(f.host.calls.mounts[0].disposed, 0, 'a timeout must not kill a connection that may still succeed');
  release();
  await flush();
  assert.equal(view(f).state, 'connected');
});

test('an instance that activates after its session moved on is disposed, not left running', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { spec: { mount: () => ({ gate }) } });
  const started = f.state.reconcile(signal());
  await waitFor(() => f.host.calls.mounts.length > 0);
  await f.state.dispose();
  release();
  await started.catch(() => {});
  assert.equal(f.host.calls.mounts[0]?.disposed, 1, 'the orphan is closed rather than left running');
});

test('disposal ends the instance and retires the host boundary with it', async t => {
  const f = await fixture(t);
  await f.state.reconcile(signal());
  const boundary = f.state.group;
  assert.notEqual(boundary, undefined);
  await f.state.dispose();
  assert.equal(f.host.calls.mounts[0].disposed, 1);
  assert.equal(f.state.group, undefined);
  for (const record of f.host.calls.mounts) record.status.publish({ state: 'closed', result: { closeConfirmed: true } });
});

test('a close result the bridge cannot confirm blocks the name until the Host restarts', async t => {
  const f = await fixture(t, { spec: { dispose: () => ({ closeConfirmed: false }) } });
  await f.state.reconcile(signal());
  await f.state.disconnect(signal(), 'same');
  assert.equal(f.host.calls.mounts[0].disposed, 1);
  await f.state.connect(signal(), 'same');
  assert.equal(f.host.calls.mounts.length, 1, 'a possibly orphaned child is never overlapped');
  assert.equal(view(f).error, 'CLOSE_UNCONFIRMED');
});

test('manual connect is one-shot where policy allows nothing, and disconnect keeps it off', async t => {
  const f = await fixture(t, { config: { trustMode: 'manual' } });
  await f.state.reconcile(signal());
  assert.equal(f.host.calls.mounts.length, 0);
  assert.equal(f.state.group, undefined);
  await f.state.connect(signal(), 'same');
  assert.equal(f.host.calls.mounts.length, 1);
  assert.equal(f.state.selectionMode, 'custom');
  await f.state.disconnect(signal(), 'same');
  assert.equal(f.host.calls.mounts[0].disposed, 1);
  await f.state.reconcile(signal());
  assert.equal(f.host.calls.mounts.length, 1, 'auto mode never re-adds what the user turned off');
  await f.state.follow(signal());
  assert.equal(f.state.selectionMode, 'auto');
});

test('losing authority stops the instance instead of leaving the bridge retrying it', async t => {
  const f = await fixture(t, { config: { trustMode: 'manual', workspaceAllowances: [{ workspace: process.cwd(), allowMcp: ['same'] }] } });
  await f.state.reconcile(signal());
  assert.equal(f.host.calls.mounts.length, 1);
  f.state.config.workspaceAllowances = [];
  await f.state.policyChanged();
  assert.equal(f.host.calls.mounts[0].disposed, 1);
  assert.equal(f.state.mounts.size, 0);
});

test('a required server that cannot mount fails the generation and a manual connect repairs it', async t => {
  const f = await fixture(t, { servers: { same: { required: true } }, spec: { mount: (_record, index) => (index === 1 ? { error: new Error('first attempt fails') } : {}) } });
  await assert.rejects(f.state.reconcile(signal()), /required server failed/);
  assert.equal(f.state.requiredFailure, true);
  const repaired = await f.state.connect(signal(), 'same');
  assert.equal(f.host.calls.mounts.length, 2);
  assert.equal(repaired.requiredFailure, false);
  assert.equal(view(f).state, 'connected');
});

test('the six-connection cap still bounds concurrent mounts', async t => {
  const names = Array.from({ length: 9 }, (_, index) => `s${index}`);
  let active = 0, peak = 0;
  const f = await fixture(t, {
    names,
    spec: {
      mount: () => {
        active += 1; peak = Math.max(peak, active);
        return { gate: new Promise(resolve => setTimeout(resolve, 0)).then(() => { active -= 1; }) };
      },
    },
  });
  await f.state.reconcile(signal());
  assert.equal(f.host.calls.mounts.length, names.length);
  assert.ok(peak <= 6, `at most six mounts in flight, saw ${peak}`);
});

test('a probe settles the row’s confidence without touching the live mount', async t => {
  const f = await fixture(t, { spec: { probe: () => ({ ok: true, toolNames: ['identity'], truncated: false, durationMs: 2, closeConfirmed: true }) } });
  await f.state.reconcile(signal());
  const before = f.host.calls.mounts.length;
  const outcome = await f.state.probe('same');
  assert.equal(outcome.ok, true);
  assert.equal(f.host.calls.probes.length, 1);
  assert.equal(f.host.calls.probes[0].options.timeoutMs, 10000);
  assert.equal(f.host.calls.mounts.length, before, 'a probe never mounts');
  assert.equal(view(f).state, 'connected');
  await assert.rejects(f.state.probe('missing'), failure => failure.code === 'UNKNOWN_SERVER');
});
