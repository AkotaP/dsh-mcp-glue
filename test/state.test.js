import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceMcpSession } from '../src/runtime.js';
import * as Plugin from '../src/index.js';
import { agent, fakeHost, harness, session, workspace, writeFixture } from './helpers.js';
const signal = () => new AbortController().signal;

test('an invalid required declaration fails the generation, and an unauthorized workspace stays quiet', async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  const state = session(ctx, a, { trustMode: 'manual' });
  t.after(() => state.dispose());
  await writeFixture(dir, '.codex/config.toml', '[mcp_servers.required]\ncommand="node"\nrequired=true\nauth="oauth"');
  await assert.rejects(state.reconcile(signal()), /invalid required/);
  await writeFixture(dir, '.codex/config.toml', '[mcp_servers.required]\ncommand="node"\nrequired=true');
  // Nothing authorized this directory. The loader does not ask anybody: it stays unloaded.
  await state.reconcile(signal());
  assert.equal(state.group, undefined);
  const view = await state.status(signal());
  assert.equal(view.trusted, false);
  assert.equal(view.selectionMode, 'auto');
  assert.equal(view.servers[0].state, 'unauthorized');
  assert.equal(view.loaded, false);
});

test('required failure blocks requests without a retry storm; explicit retry repairs the same generation', async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  await writeFixture(dir, '.codex/config.toml', '[mcp_servers.same]\ncommand="fake-program"\nrequired=true');
  const host = fakeHost({ mount: (_record, index) => (index === 1 ? { error: new Error('temporary failure') } : {}) });
  const state = session(ctx, a, { trustMode: 'all' }, { nativePlugin: host.module });
  t.after(() => state.dispose());
  await assert.rejects(state.reconcile(signal()), /required server failed/);
  await assert.rejects(state.reconcile(signal()), /required server failed/);
  assert.equal(host.calls.mounts.length, 1, 'model requests must not remount a failed declaration');
  const repaired = await state.connect(signal(), 'same');
  assert.equal(repaired.requiredFailure, false);
  assert.equal(host.calls.mounts.length, 2);
});

test('the per-workspace allowance is what authorizes a server, and secrets never leave the Host side', async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  await writeFixture(dir, '.mcp.json', { mcpServers: { same: { command: 'program', args: ['${input:token}'] } } });
  const host = fakeHost();

  const off = session(ctx, a, { trustMode: 'manual' }, { nativePlugin: host.module });
  t.after(() => off.dispose());
  await off.reconcile(signal());
  assert.equal(off.group, undefined);
  assert.equal(host.calls.mounts.length, 0, 'an unauthorized declaration never starts on its own');

  const on = session(ctx, a, {
    trustMode: 'manual',
    workspaceAllowances: [{ workspace: dir, allowMcp: ['same'] }],
    inputValues: { token: 'EXPANDED-TOP-SECRET' },
  }, { nativePlugin: host.module });
  t.after(() => on.dispose());
  await on.reconcile(signal());
  assert.deepEqual([...on.policyAllowed], ['same'], 'the allowance authorizes exactly what it names');
  assert.equal(host.calls.mounts.length, 1, 'and the declared server starts');
  assert.equal(host.calls.mounts[0].config.command, 'program');
  const view = await on.status(signal());
  assert.ok(!JSON.stringify(view).includes('EXPANDED-TOP-SECRET'), 'the panel never sees an expanded input value');
  assert.deepEqual(view.servers[0].target.inputRefs, ['token']);
  assert.equal(on.allowance.workspace, dir, 'the panel can see which entry applies');
});

test('native startup errors and warnings are redacted before reaching plugin logs', async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  await writeFixture(dir, '.mcp.json', { mcpServers: { same: { command: 'fake' } } });
  const messages = [];
  const logger = Object.fromEntries(['warn', 'error', 'info', 'debug'].map(level => [level, (...values) => messages.push(values.join(' '))]));
  // The bridge keeps its own diagnostic (already redacted for templates) in the status; this
  // plugin logs only a bounded code, so an error body with a secret never reaches its log.
  const host = fakeHost({ mount: () => ({ error: Object.assign(new Error('STARTUP-TOP-SECRET'), { code: 'ENOENT' }) }) });
  const state = session(ctx, a, { trustMode: 'all' }, { nativePlugin: host.module, logger });
  t.after(() => state.dispose());
  await state.reconcile(signal());
  assert.ok(messages.some(message => message.includes('details redacted')));
  assert.ok(messages.every(message => !message.includes('STARTUP-TOP-SECRET')));
  assert.match(state.serverStates.get('same').detail, /STARTUP-TOP-SECRET/);
});

test('assembly delta refresh does not replay upstream middleware or discard unrelated contributions', async t => {
  const ctx = await harness(t), dir = await workspace(t), a = agent(ctx, dir);
  ctx.agents.enter(a, undefined);
  let calls = 0;
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    calls++;
    const result = await next();
    return { ...result, sections: [...result.sections, { name: 'audit-once', text: 'non-idempotent middleware' }] };
  });
  await ctx.plugin(Plugin, { trustMode: 'all' });
  const assembly = await ctx.systemPrompt.assemble({ scope: a, agent: a, signal: signal() });
  assert.equal(calls, 1);
  assert.equal(assembly.sections.filter(s => s.name === 'audit-once').length, 1);
  const second = await ctx.systemPrompt.assemble({ scope: a, agent: a, signal: signal() });
  assert.equal(calls, 2);
  assert.equal(second.sections.filter(s => s.name === 'audit-once').length, 1);
});
