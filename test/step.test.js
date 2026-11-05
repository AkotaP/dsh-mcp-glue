import test from 'node:test';
import assert from 'node:assert/strict';
import { installToolPreparation } from '../src/step.js';
import { installWorkspaceLoader } from '../src/runtime.js';
import { agent, harness } from './helpers.js';

function context(tools) {
  const disposers = [];
  return { tools, effect: run => disposers.push(run()), dispose: () => disposers.reverse().forEach(run => run()) };
}

test('tool preparation precedes native admission, preserves receiver/arguments and restores on unload', async () => {
  const events = [], selection = {}, input = { signal: new AbortController().signal };
  const prototype = { async resolve(...args) { assert.equal(this, tools); assert.deepEqual(args, [input, 42]); events.push('admit'); return selection; } };
  const tools = Object.create(prototype), ctx = context(tools);
  assert.equal(installToolPreparation(ctx, async value => { assert.equal(value, input); await Promise.resolve(); events.push('prepare'); }), true);
  assert.equal(await tools.resolve(input, 42), selection);
  assert.deepEqual(events, ['prepare', 'admit']);
  ctx.dispose();
  assert.equal(Object.hasOwn(tools, 'resolve'), false);
  assert.equal(tools.resolve, prototype.resolve);
});

test('failed preparation never admits tools; unload leaves later wrappers intact and ours inert', async () => {
  const failure = new Error('required MCP unavailable');
  let prepares = 0, admits = 0;
  const tools = { async resolve() { admits++; return 'native'; } }, original = tools.resolve, ctx = context(tools);
  installToolPreparation(ctx, async () => { prepares++; throw failure; });
  await assert.rejects(tools.resolve({}), error => error === failure);
  assert.equal(admits, 0);
  const ours = tools.resolve;
  tools.resolve = function (...args) { return Reflect.apply(ours, this, args); };
  const later = tools.resolve;
  ctx.dispose();
  assert.equal(tools.resolve, later);
  assert.equal(await tools.resolve({}), 'native');
  assert.equal(prepares, 1);
  assert.equal(admits, 1);
  assert.notEqual(later, original);
  assert.equal(installToolPreparation(context({}), () => assert.fail('legacy Host')), false);
});

test('0.2.2 text-only waterfall never reads tools or reconciles after native admission', async t => {
  const ctx = await harness(t), owner = agent(ctx, process.cwd(), 'text-only');
  ctx.agents.enter(owner, undefined);
  const raw = ctx.tools[Symbol.for('cordis.original')];
  let loads = 0, admits = 0;
  raw.resolve = async function (input) { assert.equal(input.agent, owner); admits++; return { admitted: true }; };
  const installed = await installWorkspaceLoader(ctx, {}, {
    nativePlugin: { name: 'mcp-client', inject: ['tools'], async apply() {} }, health: false,
    load: async () => { loads++; return { cwd: process.cwd(), fingerprint: 'empty', servers: [], diagnostics: [] }; },
  });
  const input = { agent: owner, signal: new AbortController().signal };
  assert.deepEqual(await ctx.tools.resolve(input), { admitted: true });
  assert.equal(loads, 1);
  assert.equal(admits, 1);
  const assembly = { sections: [], contexts: [], variables: {} };
  let downstream = 0;
  const result = await ctx.waterfall('system-prompt/assemble', assembly, { ...input, scope: owner }, async () => { downstream++; return assembly; });
  assert.equal(result, assembly);
  assert.equal(Object.hasOwn(result, 'tools'), false);
  assert.equal(loads, 1, 'do not change registrations after admission');
  assert.equal(downstream, 1);
  assert.ok(installed.stateFor(owner));
});
