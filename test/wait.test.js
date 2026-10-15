import test from 'node:test';
import assert from 'node:assert/strict';
import { createControl } from '../src/control.js';
import { agent, harness, session } from './helpers.js';

/** A session whose view nobody is mounting: enough to exercise the long-poll waiter. */
async function waiting(t) {
  const ctx = await harness(t);
  const value = agent(ctx, process.cwd(), 'wait-agent');
  ctx.agents.enter(value, undefined); // the control facade resolves sessions by id
  const state = session(ctx, value, { trustMode: 'all' });
  return { ctx, value, state };
}

test('a caller that is already behind is answered at once', async t => {
  const { state } = await waiting(t);
  const started = Date.now();
  const version = await state.waitForChange(-1, 5000);
  assert.equal(version, state.statusVersion);
  assert.ok(Date.now() - started < 1000, 'a stale revision must not hold the request');
});

test('an idle view holds the request until the timeout, then answers the same revision', async t => {
  const { state } = await waiting(t);
  const started = Date.now();
  const version = await state.waitForChange(state.statusVersion, 40);
  assert.equal(version, state.statusVersion);
  assert.ok(Date.now() - started >= 30, 'the hold must actually wait');
});

test('a view that moves releases every held reader at once, and only moves when it really moved', async t => {
  const { state } = await waiting(t);
  const first = state.waitForChange(state.statusVersion, 5000);
  const second = state.waitForChange(state.statusVersion, 5000);
  state.serverStates.set('demo', { state: 'connected', tools: ['mcp__demo__identity'] });
  state.publish();
  assert.equal(await first, state.statusVersion);
  assert.equal(await second, state.statusVersion);
  assert.equal(state.statusVersion, 1, 'the tool count is part of the view identity');
  state.publish();
  assert.equal(state.statusVersion, 1, 'an unchanged view must not wake anybody');
});

test('aborting the caller releases the hold without waiting for the timeout', async t => {
  const { state } = await waiting(t);
  const controller = new AbortController();
  const held = state.waitForChange(state.statusVersion, 60000, controller.signal);
  controller.abort();
  assert.equal(await held, state.statusVersion);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  assert.equal(await state.waitForChange(state.statusVersion, 60000, alreadyAborted.signal), state.statusVersion);
});

test('disposal releases held readers instead of leaving them to their timeout', async t => {
  const { state } = await waiting(t);
  const held = state.waitForChange(state.statusVersion, 60000);
  await state.dispose();
  assert.equal(await held, state.statusVersion);
});

test('the control facade waits on one session and reports an unready one', async t => {
  const { ctx, value, state } = await waiting(t);
  const control = createControl(ctx, candidate => (candidate === value ? state : undefined));
  const controller = new AbortController();
  const held = control.wait('wait-agent', state.statusVersion, controller.signal);
  controller.abort();
  assert.deepEqual(await held, { version: state.statusVersion });
  await assert.rejects(control.wait('missing-session', 0), failure => failure.code === 'SESSION_NOT_READY');
});
