import test from 'node:test';
import assert from 'node:assert/strict';
import { session } from './helpers.js';
import { agent, fixtureCommand, harness, workspace, writeFixture } from './helpers.js';
const signal = () => new AbortController().signal;

test('status lists declarations before anything is mounted, without secrets', async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  await writeFixture(dir, '.mcp.json', { mcpServers: { demo: { ...fixtureCommand('ui'), args: ['${input:token}'] } } });
  const state = session(ctx, a, { inputValues: { token: 'UI-TOP-SECRET' } });
  t.after(() => state.dispose());
  const status = await state.status(signal());
  assert.equal(status.workspace, dir);
  assert.equal(status.loaded, false);
  assert.equal(status.trusted, false);
  assert.equal(status.counts.declarations, 1);
  assert.equal(status.servers[0].state, 'unauthorized');
  assert.deepEqual(status.servers[0].target.inputRefs, ['token']);
  assert.ok(!JSON.stringify(status).includes('UI-TOP-SECRET'));
});

test('manual connect loads and lists tools; disconnect unloads and survives auto-reconcile', { timeout: 30000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  await writeFixture(dir, '.mcp.json', { mcpServers: { demo: fixtureCommand('ui') } });
  const state = session(ctx, a, { trustMode: 'manual' });
  t.after(() => state.dispose());
  const connected = await state.connect(signal());
  assert.equal(connected.servers[0].state, 'connected');
  assert.deepEqual(connected.servers[0].tools, ['mcp__demo__identity', 'mcp__demo__blocked']);
  assert.equal(connected.counts.connected, 1);
  const off = await state.disconnect(signal());
  assert.equal(off.loaded, false);
  assert.equal(off.selectionMode, 'custom');
  assert.equal(off.servers[0].state, 'unloaded');
  await state.reconcile(signal());
  assert.equal(state.group, undefined, 'manual disconnect is not undone by the next assembly');
  const back = await state.connect(signal());
  assert.equal(back.servers[0].state, 'connected');
  assert.deepEqual(back.selected, ['demo']);
});

test('declaration errors and failed startups are reported per server', { timeout: 30000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  await writeFixture(dir, '.mcp.json', { mcpServers: {
    broken: { command: 'x', oauth: {} },
    missing: { command: '${env:ABSENT_VARIABLE}' },
    dead: { command: process.execPath, args: ['-e', 'process.exit(3)'] },
    good: fixtureCommand('ui-ok'),
  } });
  const state = session(ctx, a, { trustMode: 'all', startupTimeoutMs: 8000 });
  t.after(() => state.dispose());
  const status = await state.connect(signal());
  const byId = new Map(status.servers.map(row => [row.id, row]));
  assert.equal(byId.get('broken').state, 'invalid');
  assert.equal(byId.get('broken').error, 'UNSUPPORTED_AUTH_OR_POLICY');
  assert.equal(byId.get('missing').state, 'invalid');
  assert.equal(byId.get('missing').error, 'MISSING_ENVIRONMENT_VARIABLE');
  assert.equal(byId.get('dead').state, 'reconnecting');
  assert.equal(byId.get('dead').reconnect.eligible, true);
  assert.ok(Number.isFinite(byId.get('dead').reconnect.nextRetryAt));
  assert.equal(byId.get('dead').error, 'CONNECTION_CLOSED');
  assert.equal(byId.get('good').state, 'connected');
  assert.equal(status.counts.connected, 1);
  assert.equal(status.counts.problems, 3);
});

test('retrying a policy-authorized server keeps the automatic intent; granting an unauthorized one pins it', async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  await writeFixture(dir, '.mcp.json', { mcpServers: { one: fixtureCommand('one'), two: fixtureCommand('two') } });

  // Fully authorized: connecting is only a retry, so no manual override is recorded.
  const automated = session(ctx, a, { trustMode: 'all' });
  t.after(() => automated.dispose());
  await automated.reconcile(signal());
  assert.equal(automated.selectionMode, 'auto');
  const retried = await automated.connect(signal(), 'one');
  assert.equal(retried.selectionMode, 'auto', 'a retry must not show the "follow policy" escape hatch');
  assert.equal(retried.counts.connected, 2);
  const all = await automated.connect(signal());
  assert.equal(all.selectionMode, 'auto', 'connecting all is still a retry when the policy already allows all');
  await automated.disconnect(signal(), 'one');
  assert.equal(automated.selectionMode, 'custom', 'a manual disconnect is a real intent change');
  const followed = await automated.follow(signal());
  assert.equal(followed.selectionMode, 'auto');

  // Partially authorized: connecting the unauthorized server is an explicit grant.
  // A separate agent keeps both sessions free to mount the same server names.
  const partial = session(ctx, agent(ctx, dir, 'intent-partial'), { trustMode: 'manual', workspaceAllowances: [{ workspace: dir, allowMcp: ['one'] }] });
  t.after(() => partial.dispose());
  await partial.reconcile(signal());
  assert.equal(partial.selectionMode, 'auto');
  const granted = await partial.connect(signal(), 'two');
  assert.equal(granted.selectionMode, 'custom');
  assert.deepEqual(granted.selected.sort(), ['one', 'two']);
  assert.equal(granted.counts.connected, 2);
});

test('manual selection: all-off is sticky, and per-server connect/disconnect work', async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  await writeFixture(dir, '.mcp.json', { mcpServers: { one: fixtureCommand('one') } });
  const state = session(ctx, a, { trustMode: 'manual' });
  t.after(() => state.dispose());
  await state.connect(signal());
  await state.disconnect(signal());
  await writeFixture(dir, '.mcp.json', { mcpServers: { one: fixtureCommand('one'), two: fixtureCommand('two') } });
  await state.reconcile(signal());
  const sticky = await state.status(signal(), { refresh: true });
  assert.equal(sticky.selectionMode, 'custom', 'a manual disconnect survives a declaration change');
  assert.deepEqual(sticky.selected, []);
  assert.equal(sticky.loaded, false);
  assert.deepEqual(sticky.servers.map(row => row.id).sort(), ['one', 'two']);

  const onlyTwo = await state.connect(signal(), 'two');
  assert.equal(onlyTwo.selectionMode, 'custom');
  assert.deepEqual(onlyTwo.selected, ['two']);
  assert.equal(onlyTwo.loaded, true);
  assert.equal(onlyTwo.servers.find(row => row.id === 'two').state, 'connected');
  assert.equal(onlyTwo.servers.find(row => row.id === 'one').state, 'unloaded');

  const both = await state.connect(signal(), 'one');
  assert.deepEqual(both.selected.sort(), ['one', 'two']);
  assert.equal(both.counts.connected, 2);

  const droppedOne = await state.disconnect(signal(), 'one');
  assert.deepEqual(droppedOne.selected, ['two']);
  assert.equal(droppedOne.servers.find(row => row.id === 'one').state, 'unloaded');
  assert.equal(droppedOne.servers.find(row => row.id === 'two').state, 'connected');

  const allBack = await state.connect(signal());
  assert.equal(allBack.selectionMode, 'custom', 'connecting everything is an explicit choice too');
  assert.deepEqual(allBack.selected.sort(), ['one', 'two']);
  assert.equal(allBack.counts.connected, 2);
});
