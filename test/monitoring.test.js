import test from 'node:test';
import assert from 'node:assert/strict';
import * as NativeMcp from '@deepseek-ai/dsh-mcp-client';
import { installWorkspaceLoader } from '../src/runtime.js';
import { agent, harness } from './helpers.js';

test('host JSON metadata uses the same loader resolver and parent URL, not the stack-callback argument', async t => {
  const ctx = await harness(t), owner = agent(ctx, process.cwd(), 'monitoring');
  ctx.agents.enter(owner, undefined);
  const requests = [], baseUrl = 'file:///host/profile/cordis.patch.yml';
  const loader = {
    ctx: { baseUrl },
    import(...args) { requests.push(['module', ...args]); assert.deepEqual(args, ['@deepseek-ai/dsh-mcp-client']); return NativeMcp; },
    unwrapExports: value => value,
    internal: {
      import(...args) { requests.push(['metadata', ...args]); assert.deepEqual(args, ['@deepseek-ai/dsh-mcp-client/package.json', baseUrl, { type: 'json' }]); return { default: { version: '0.2.0-rc.2' } }; },
    },
  };
  const installed = await installWorkspaceLoader(ctx, {}, { resolveLoader: () => loader });
  assert.equal(installed.stateFor(owner).monitoring, true);
  assert.equal(requests.length, 2);
});

test('assembly refresh catches background registry changes after the Host snapshot without replaying middleware', async t => {
  const ctx = await harness(t), owner = agent(ctx, process.cwd(), 'snapshot');
  ctx.agents.enter(owner, undefined);
  let generation = 1, move = false, middlewareCalls = 0;
  const nativePlugin = { name: 'mcp-client', inject: ['tools'], async apply(child) {
    const label = `generation-${generation}`;
    child.tools.register({ name: `mcp__wire__tool_${generation}`, description: label,
      parameters: { type: 'object', properties: {} }, execute: () => label,
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: value }] } });
    child.inject(['systemPrompt'], inner => inner.systemPrompt.section({ name: 'mcp:wire', text: label, order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'), interpolate: false }));
  } };
  const plan = { cwd: process.cwd(), fingerprint: 'snapshot', diagnostics: [], servers: [{
    source: { file: '.mcp.json', preset: 'root', server: 'wire' },
    spec: { config: { serverName: 'wire', transport: 'streamable-http', url: 'http://fixture.invalid/mcp' } },
  }] };
  const installed = await installWorkspaceLoader(ctx, { trustMode: 'all' }, { nativePlugin, load: async () => plan, health: false });
  const state = installed.stateFor(owner);
  await state.reconcile();
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    middlewareCalls++;
    assembly.sections.push({ name: 'independent', text: 'keep this once' });
    if (move) {
      move = false;
      await state.disconnect(undefined, 'wire');
      generation++;
      await state.connect(undefined, 'wire');
    }
    return next();
  }, { prepend: true });
  move = true;
  const assembly = await ctx.systemPrompt.assemble({ scope: owner, agent: owner, signal: new AbortController().signal });
  assert.ok(assembly.tools.some(tool => tool.name === 'mcp__wire__tool_2'));
  assert.ok(!assembly.tools.some(tool => tool.name === 'mcp__wire__tool_1'));
  assert.ok(assembly.sections.some(section => section.text === 'generation-2'), JSON.stringify(assembly.sections));
  assert.ok(!assembly.sections.some(section => section.text === 'generation-1'));
  assert.equal(assembly.sections.filter(section => section.name === 'independent').length, 1);
  assert.equal(middlewareCalls, 1);
});

test('refresh preserves upstream MCP visibility filters, including unrelated global resource tools and changed generations', async t => {
  const ctx = await harness(t), owner = agent(ctx, process.cwd(), 'filtered');
  ctx.agents.enter(owner, undefined);
  ctx.mcpResources.register('global', { request: async () => ({ resources: [] }) });
  let loadable = false, generation = 0, replace = false;
  const nativePlugin = { name: 'mcp-client', inject: ['tools'], async apply(child) {
    const label = `filtered-${++generation}`;
    child.tools.register({ name: `mcp__wire__tool_${generation}`, description: label,
      parameters: { type: 'object', properties: {} }, execute: () => label,
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: value }] } });
    child.inject(['systemPrompt'], inner => inner.systemPrompt.section({ name: 'mcp:wire', text: label, order: inner.systemPrompt.getSectionOrder('MCP_SERVERS') }));
  } };
  const load = async () => ({ cwd: process.cwd(), fingerprint: String(loadable), diagnostics: [], servers: loadable ? [{
    source: { file: '.mcp.json', preset: 'root', server: 'wire' }, spec: { config: { serverName: 'wire', transport: 'streamable-http', url: 'http://fixture.invalid/mcp' } },
  }] : [] });
  const installed = await installWorkspaceLoader(ctx, { trustMode: 'all' }, { nativePlugin, load, health: false });
  const state = installed.stateFor(owner);
  await state.reconcile();
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    assembly.tools = assembly.tools.filter(tool => tool.name !== 'read_mcp_resource' && !tool.name.startsWith('mcp__wire__'));
    assembly.sections = assembly.sections.filter(section => section.name !== 'mcp:wire');
    if (replace) { replace = false; await state.disconnect(undefined, 'wire'); await state.connect(undefined, 'wire'); }
    return next();
  }, { prepend: true });
  const assemble = () => ctx.systemPrompt.assemble({ scope: owner, agent: owner, signal: new AbortController().signal });
  const empty = await assemble();
  assert.equal(state.knownServers.size, 0);
  assert.ok(!empty.tools.some(tool => tool.name === 'read_mcp_resource'), 'no workspace mount may restore a filtered global resource tool');
  loadable = true;
  await state.reconcile();
  const unchanged = await assemble();
  assert.ok(!unchanged.tools.some(tool => tool.name.startsWith('mcp__wire__')), 'unchanged raw registrations must not override middleware omissions');
  replace = true;
  const changed = await assemble();
  assert.ok(ctx.tools.get('mcp__wire__tool_2', owner));
  assert.ok(!changed.tools.some(tool => tool.name.startsWith('mcp__wire__')), 'do not introduce new tool names behind a server filter during refresh');
  assert.ok(!changed.sections.some(section => section.name === 'mcp:wire'));
  assert.ok(!changed.tools.some(tool => tool.name === 'read_mcp_resource'));
  assert.ok(ctx.tools.get('read_mcp_resource', owner), 'global registration remains intact');
});

test('a different known native version is refused, while unreadable metadata falls back to capability proof', async t => {
  for (const version of ['0.2.0-rc.3', undefined]) {
    const ctx = await harness(t), owner = agent(ctx, process.cwd(), `unsupported-${version}`);
    ctx.agents.enter(owner, undefined);
    const loader = {
      import: async specifier => {
        if (!specifier.endsWith('/package.json')) return NativeMcp;
        if (version === undefined) throw new Error('metadata unavailable');
        return { default: { version } };
      },
      unwrapExports: value => value,
    };
    const installed = await installWorkspaceLoader(ctx, {}, { resolveLoader: () => loader });
    const state = installed.stateFor(owner);
    if (version === undefined) {
      // Metadata is a diagnostic, not the gate: the adapter's two capabilities decide.
      assert.equal(state.monitoring, true);
      assert.equal((await state.status()).monitoring, 'supported');
    } else {
      assert.equal(state.monitoring, false);
      assert.equal((await state.status()).monitoring, 'unsupported');
    }
  }
});
