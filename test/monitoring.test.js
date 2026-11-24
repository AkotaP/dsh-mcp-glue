import test from 'node:test';
import assert from 'node:assert/strict';
import * as NativeMcp from '@deepseek-ai/dsh-mcp-client';
import { installWorkspaceLoader } from '../src/runtime.js';
import { agent, fakeHost, harness } from './helpers.js';

test('the bridge is resolved through the plugin’s loader, and only a host makes the feature work', async t => {
  const ctx = await harness(t), owner = agent(ctx, process.cwd(), 'monitoring');
  ctx.agents.enter(owner, undefined);
  const requests = [];
  const loader = {
    import(specifier) { requests.push(specifier); return NativeMcp; },
    unwrapExports: value => value,
  };
  const installed = await installWorkspaceLoader(ctx, {}, { resolveLoader: () => loader, health: false });
  assert.deepEqual(requests, ['@deepseek-ai/dsh-mcp-client'], 'one import, through the Host loader');
  assert.equal(installed.stateFor(owner).monitoring, true);
  assert.equal((await installed.stateFor(owner).status()).monitoring, 'supported');

  // A module that predates `McpClientHost` cannot mount, probe or authorize anything.
  const bare = await harness(t), other = agent(bare, process.cwd(), 'bare-module');
  bare.agents.enter(other, undefined);
  const disabled = await installWorkspaceLoader(bare, {}, { nativePlugin: { name: 'mcp-client', async apply() {} }, health: false });
  assert.equal(disabled.stateFor(other).monitoring, false);
  assert.equal((await disabled.stateFor(other).status()).monitoring, 'unsupported');
});

test('a background reconcile replaces the tool generation the next request sees', async t => {
  const ctx = await harness(t), owner = agent(ctx, process.cwd(), 'generations');
  ctx.agents.enter(owner, undefined);
  let generation = 0, move = false, middlewareCalls = 0;
  const host = fakeHost({
    mount: record => {
      const label = `generation-${++generation}`;
      record.context.tools.register({ name: `mcp__wire__tool_${generation}`, description: label,
        parameters: { type: 'object', properties: {} }, execute: () => label,
        output: { schema: {}, render: (_args, value) => [{ type: 'text', text: value }] } });
      record.context.inject(['systemPrompt'], inner => inner.systemPrompt.section({
        name: 'mcp:wire', text: label, order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'), interpolate: false,
      }));
      return {};
    },
  });
  const plan = { cwd: process.cwd(), fingerprint: 'generations', diagnostics: [], servers: [{
    source: { file: '.mcp.json', preset: 'root', server: 'wire' },
    spec: { config: { serverName: 'wire', transport: 'streamable-http', url: 'http://fixture.invalid/mcp' } },
  }] };
  const installed = await installWorkspaceLoader(ctx, { trustMode: 'all' }, { nativePlugin: host.module, load: async () => plan, health: false });
  const state = installed.stateFor(owner);
  await state.reconcile();
  assert.deepEqual(ctx.tools.schemas(owner).map(schema => schema.name).filter(name => name.startsWith('mcp__wire__')), ['mcp__wire__tool_1']);
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    middlewareCalls++;
    assembly.sections.push({ name: 'independent', text: 'keep this once' });
    if (move) {
      move = false;
      await state.disconnect(undefined, 'wire');
      await state.connect(undefined, 'wire');
    }
    return next();
  }, { prepend: true });
  move = true;
  await ctx.systemPrompt.assemble({ scope: owner, agent: owner, signal: new AbortController().signal });
  // The request that triggered the switch already assembled its providers, so the next request is
  // the one that must see the new generation — and only it.
  const assembly = await ctx.systemPrompt.assemble({ scope: owner, agent: owner, signal: new AbortController().signal });
  assert.deepEqual(ctx.tools.schemas(owner).map(schema => schema.name).filter(name => name.startsWith('mcp__wire__')), ['mcp__wire__tool_2']);
  assert.ok(assembly.sections.some(section => section.text === 'generation-2'), JSON.stringify(assembly.sections));
  assert.ok(!assembly.sections.some(section => section.text === 'generation-1'), 'the retired generation contributes nothing');
  assert.equal(assembly.sections.filter(section => section.name === 'independent').length, 1);
  assert.equal(middlewareCalls, 2);
  // The tool provider is the registry itself now, so a retired generation leaves no stale schema.
  assert.equal(ctx.tools.get('mcp__wire__tool_1', owner), undefined);
});