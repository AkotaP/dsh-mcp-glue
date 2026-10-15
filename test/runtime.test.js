import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceMcpSession, installWorkspaceLoader } from '../src/runtime.js';
import * as Plugin from '../src/index.js';
import { agent, fixtureCommand, harness, session, workspace, writeFixture } from './helpers.js';
const signal = () => new AbortController().signal;
const execute = (ctx, owner, name = 'mcp__same__identity') => ctx.tools.execute({ name, arguments: {}, agent: owner, callId: 'call-test', signal: signal() });
const identity = result => JSON.parse(result.value.content[0].text);

test('native MCP connections, tools, instructions and resources are isolated for two concurrent workspaces', { timeout: 30000 }, async t => {
  const ctx = await harness(t), dirA = await workspace(t), dirB = await workspace(t);
  for (const [dir, label] of [[dirA, 'A'], [dirB, 'B']]) await writeFixture(dir, '.mcp.json', { mcpServers: { same: { ...fixtureCommand(label), env: { WORKSPACE_MARKER: label } } } });
  const a = agent(ctx, dirA, 'A'), b = agent(ctx, dirB, 'B');
  const states = [a, b].map(value => session(ctx, value, { trustMode: 'all' }));
  t.after(async () => { await Promise.all(states.map(s => s.dispose())); });
  await Promise.all(states.map(s => s.reconcile(signal())));
  assert.equal(ctx.tools.schemas().some(s => s.name.startsWith('mcp__same__')), false);
  const [ra, rb] = await Promise.all([execute(ctx, a), execute(ctx, b)]);
  assert.equal(ra.isError, false); assert.equal(rb.isError, false);
  assert.deepEqual(identity(ra), { label: 'A', cwd: dirA, marker: 'A', method: 'identity' });
  assert.deepEqual(identity(rb), { label: 'B', cwd: dirB, marker: 'B', method: 'identity' });
  const assemblyA = await ctx.systemPrompt.assemble({ scope: a });
  const assemblyB = await ctx.systemPrompt.assemble({ scope: b });
  assert.ok(assemblyA.sections.some(s => s.text.includes('Workspace A: keep ${literal} literal.')));
  assert.ok(!assemblyA.sections.some(s => s.text.includes('Workspace B:')));
  assert.ok(assemblyB.sections.some(s => s.text.includes('Workspace B:')));
  const resource = await ctx.tools.execute({ name: 'read_mcp_resource', arguments: { server: 'same', uri: 'fixture://identity' }, agent: a, callId: 'resource-call', signal: signal() });
  assert.equal(resource.isError, false);
  assert.ok(JSON.stringify(resource.value).includes('A'));
  await states[0].dispose();
  assert.equal((await execute(ctx, a)).isError, true);
  assert.equal(identity(await execute(ctx, b)).label, 'B');
});

test('reload changes only its owner, removes deleted config, scopes do not retain names after unload', { timeout: 30000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  await writeFixture(dir, '.mcp.json', { mcpServers: { same: fixtureCommand('old') } });
  const state = session(ctx, a, { trustMode: 'all' });
  t.after(() => state.dispose());
  await state.reconcile(signal());
  const before = state.group;
  await state.reconcile(signal());
  assert.equal(state.group, before, 'unchanged files retain transports');
  await writeFixture(dir, '.mcp.json', { mcpServers: { same: fixtureCommand('new') } });
  await state.reconcile(signal());
  assert.equal(identity(await execute(ctx, a)).label, 'new');
  // The deletion target is an exact fixture file inside this test-owned directory.
  const declaration = path.join(dir, '.mcp.json');
  assert.equal(path.dirname(declaration), dir);
  await fs.unlink(declaration);
  await state.reconcile(signal());
  assert.equal((await execute(ctx, a)).isError, true);
  assert.ok(!(await ctx.systemPrompt.assemble({ scope: a })).sections.some(s => s.text.includes('Workspace new:')));
  await writeFixture(dir, '.mcp.json', { mcpServers: { same: fixtureCommand('again') } });
  await state.reconcile(signal());
  assert.equal(identity(await execute(ctx, a)).label, 'again');
});

test('an untrusted declaration never spawns, trust matches the exact root, and an allowance authorizes one server', { timeout: 20000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  await writeFixture(dir, '.mcp.json', { mcpServers: { same: fixtureCommand('never-start') } });
  // A parent directory is not the same trust root: the match is the canonical identity of the
  // directory itself, so nothing is authorized here and the loader stays silent.
  const untrusted = session(ctx, a, { trustMode: 'manual', trustedWorkspaces: [path.dirname(dir)] });
  t.after(() => untrusted.dispose());
  await untrusted.reconcile(signal());
  assert.equal(untrusted.group, undefined);
  assert.equal(untrusted.policyAllowed.size, 0);
  assert.deepEqual(ctx.tools.schemas(a).filter(s => s.name.startsWith('mcp__same__')), []);

  // The per-workspace allowance is what turns exactly the named servers on.
  const allowed = session(ctx, a, { trustMode: 'manual', workspaceAllowances: [{ workspace: dir, allowMcp: ['same'] }] });
  t.after(() => allowed.dispose());
  await allowed.reconcile(signal());
  assert.deepEqual([...allowed.policyAllowed], ['same']);
  assert.notEqual(allowed.group, undefined);
});

test('native tool allow/deny filters cannot be bypassed by dispatching the name directly', { timeout: 20000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  await writeFixture(dir, '.codex/config.toml', `[mcp_servers.same]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify(fixtureCommand('filtered').args)}\nenabled_tools=["identity","blocked"]\ndisabled_tools=["blocked"]\n`);
  const state = session(ctx, a, { trustMode: 'all' });
  t.after(() => state.dispose());
  await state.reconcile(signal());
  assert.equal((await execute(ctx, a)).isError, false);
  const denied = await execute(ctx, a, 'mcp__same__blocked');
  assert.equal(denied.isError, true);
  assert.ok(denied.error.message.includes('disabled'));
  // The panel can see which tools the declaration itself forbids, so it can report them
  // instead of offering a switch no local allowance could ever make effective.
  const view = await state.status(signal());
  const row = view.servers.find(entry => entry.id === 'same');
  assert.deepEqual(row.disabledTools, ['mcp__same__blocked']);
  assert.deepEqual([...row.tools].sort(), ['mcp__same__blocked', 'mcp__same__identity']);
});

test('assembly hook loads approved servers into the very first request and plugin unload removes all contributions', { timeout: 30000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  await writeFixture(dir, '.mcp.json', { mcpServers: { same: fixtureCommand('first-request') } });
  ctx.agents.enter(a, undefined);
  // A trusted directory loads during the very first assembly, with no approval step at all.
  const plugin = ctx.plugin(Plugin, { trustMode: 'manual', trustedWorkspaces: [dir] });
  await plugin;
  const assembly = await ctx.systemPrompt.assemble({ agent: a, scope: a, signal: signal() });
  assert.ok(assembly.tools.some(s => s.name === 'mcp__same__identity'));
  assert.ok(assembly.sections.some(s => s.text.includes('Workspace first-request:')));
  await ctx.systemPrompt.assemble({ agent: a, scope: a, signal: signal() });
  await plugin.dispose();
  await plugin.await();
  assert.equal((await execute(ctx, a)).isError, true);
});

test('disposal interrupts pending startup and cancelled work never publishes project tools', { timeout: 10000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  await writeFixture(dir, '.mcp.json', { mcpServers: { same: { command: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'] } } });
  const state = session(ctx, a, { trustMode: 'all', startupTimeoutMs: 3000 });
  t.after(() => state.dispose());
  const started = state.reconcile(signal());
  // A separate deferred scope creation signal avoids time-based polling.
  await new Promise(resolve => setTimeout(resolve, 100));
  await state.dispose();
  await assert.rejects(started);
  assert.equal(ctx.tools.schemas(a).some(s => s.name.startsWith('mcp__same__')), false);
});
