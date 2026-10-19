import test from 'node:test';
import assert from 'node:assert/strict';
import * as Plugin from '../src/index.js';
import { agent, fixtureCommand, harness, provideSettings, workspace, writeFixture } from './helpers.js';
const signal = () => new AbortController().signal;

/** Answerer stub: hands back the queued labels, or throws when the queue is empty. */
function provideQuestions(ctx, answers) {
  const asked = [];
  ctx.provide('userQuestions', {
    async ask(request) {
      asked.push(request);
      const next = answers.shift();
      if (next === undefined) throw Object.assign(new Error('no answerer accepted the request'), { code: 'NO_PROVIDER' });
      if (typeof next === 'object') throw Object.assign(new Error(next.error), { code: next.error });
      return { answers: [{ id: request.questions[0].id, selected: [next] }] };
    },
  });
  return asked;
}

const execute = (ctx, owner, name) => ctx.tools.execute({ name, arguments: {}, agent: owner, callId: `call-${name}`, signal: signal() });
const TOOL = 'mcp__same__identity';

/** Mount one fixture server through the per-workspace allowance, leaving the tool itself ungated. */
async function gated(t, { answers = [], mode = 'workspace-write', config = {}, questionless = false } = {}) {
  const ctx = await harness(t), dir = await workspace(t);
  await writeFixture(dir, '.mcp.json', { mcpServers: { same: fixtureCommand('gate') } });
  const a = agent(ctx, dir, 'gate-agent');
  ctx.agents.enter(a, undefined);
  const asked = questionless ? [] : provideQuestions(ctx, answers);
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode }) });
  const settings = provideSettings(ctx, { trustMode: 'manual', trustedWorkspaces: [], workspaceAllowances: [{ workspace: dir, allowMcp: ['same'], allowTools: [] }] });
  const merged = {
    trustMode: 'manual',
    workspaceAllowances: [{ workspace: dir, allowMcp: ['same'] }],
    ...config,
  };
  await ctx.plugin(Plugin, merged);
  await ctx.systemPrompt.assemble({ agent: a, scope: a, signal: signal() });
  return { ctx, dir, a, asked, settings };
}

test('a tool the workspace never allowed asks once, and each answer is honored', { timeout: 40000 }, async t => {
  const { ctx, a, asked, settings } = await gated(t, { answers: ['仅此次允许', '拒绝', '总是允许这个工具'] });

  // 1) Once: this call runs, nothing is written.
  assert.equal((await execute(ctx, a, TOOL)).isError, false);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].questions[0].options.length, 3, 'the gate offers once / always / never');
  assert.equal(settings.updates.length, 0, 'once must not write anything');

  // 2) Never: the call is refused with a reason the model can read.
  const denied = await execute(ctx, a, TOOL);
  assert.equal(denied.isError, true);
  assert.match(denied.error.message, /拒绝/);
  assert.equal(asked.length, 2);

  // 3) Always: the call runs and the tool is recorded in this workspace allowance.
  assert.equal((await execute(ctx, a, TOOL)).isError, false);
  assert.equal(asked.length, 3);
  const written = settings.updates.at(-1).patch.workspaceAllowances;
  assert.deepEqual(written.map(entry => entry.workspace), [settings.state.value.workspaceAllowances[0].workspace]);
  assert.ok(written[0].allowTools.includes('mcp__same__identity'), 'the public tool name is what gets stored');
  assert.deepEqual(written[0].allowMcp, ['same'], 'the allowance entry it already had is preserved');
});

test('a tool the project itself forbids is never asked about', { timeout: 40000 }, async t => {
  const ctx = await harness(t), dir = await workspace(t);
  await writeFixture(dir, '.codex/config.toml', `[mcp_servers.same]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify(fixtureCommand('forbidden').args)}\nenabled_tools=["identity","blocked"]\ndisabled_tools=["blocked"]\n`);
  const a = agent(ctx, dir, 'forbidden-agent');
  ctx.agents.enter(a, undefined);
  const asked = provideQuestions(ctx, ['仅此次允许', '仅此次允许']);
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) });
  provideSettings(ctx, { trustMode: 'manual', trustedWorkspaces: [], workspaceAllowances: [{ workspace: dir, allowMcp: ['same'], allowTools: [] }] });
  await ctx.plugin(Plugin, { trustMode: 'manual', workspaceAllowances: [{ workspace: dir, allowMcp: ['same'] }] });
  await ctx.systemPrompt.assemble({ agent: a, scope: a, signal: signal() });

  // The tool the declaration still enables asks as usual.
  assert.equal((await execute(ctx, a, 'mcp__same__identity')).isError, false);
  assert.equal(asked.length, 1);

  // The forbidden one is refused by the declaration's own guard, and the gate never asks: a
  // question whose only honest answer is "no" must not be put to the user at all.
  const forbidden = await execute(ctx, a, 'mcp__same__blocked');
  assert.equal(forbidden.isError, true);
  assert.match(forbidden.error.message, /disabled/);
  assert.equal(asked.length, 1, 'the declaration already answered this');
});

test('workspace authorization never gates an inherited global tool with the same textual server prefix', { timeout: 30000 }, async t => {
  const { ctx, a, asked } = await gated(t);
  ctx.tools.register({ name: 'mcp__same__global_only', description: 'Global MCP contribution',
    parameters: { type: 'object', properties: {} }, execute: () => 'global',
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: value }] } });
  const result = await execute(ctx, a, 'mcp__same__global_only');
  assert.equal(result.isError, false);
  assert.equal(result.value, 'global');
  assert.equal(asked.length, 0);
});

test('an answer that never arrives refuses the call instead of wedging it', { timeout: 30000 }, async t => {
  const { ctx, a, asked } = await gated(t, { answers: [] });
  const refused = await execute(ctx, a, TOOL);
  assert.equal(refused.isError, true);
  assert.match(refused.error.message, /授权未完成|NO_PROVIDER/);
  assert.equal(asked.length, 1);
});

test('nothing asks when the policy already allowed it, when the deployment is unconfined, or when no answerer is composed', { timeout: 40000 }, async t => {
  const trusted = await gated(t, { config: { trustMode: 'all' } });
  const allowed = await execute(trusted.ctx, trusted.a, TOOL);
  assert.equal(allowed.isError, false, `trustMode: all must leave the tool callable: ${JSON.stringify(allowed.error ?? allowed)}`);
  assert.equal(trusted.asked.length, 0, 'trustMode: all never asks');

  const unconfined = await gated(t, { mode: 'danger-full-access' });
  assert.equal((await execute(unconfined.ctx, unconfined.a, TOOL)).isError, false);
  assert.equal(unconfined.asked.length, 0, 'an unconfined deployment already answered this globally');

  const alone = await gated(t, { questionless: true });
  assert.equal((await execute(alone.ctx, alone.a, TOOL)).isError, false);
  assert.equal(alone.asked.length, 0, 'without an answerer the gate must not wedge the call');

  // A delegated child agent cannot open a human interaction at all: the gate must not refuse
  // the call either, because the server itself was already authorized.
  const delegated = await gated(t, { answers: [{ error: 'DELEGATED_CALLER' }] });
  assert.equal((await execute(delegated.ctx, delegated.a, TOOL)).isError, false, 'a child agent falls through instead of being denied');
  assert.equal(delegated.asked.length, 1);
});
