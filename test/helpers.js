import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import McpResources from '@deepseek-ai/dsh-mcp-resources';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import { createScope } from '@deepseek-ai/dsh-scope';
import * as NativeMcp from '@deepseek-ai/dsh-mcp-client';
import { WorkspaceMcpSession } from '../src/runtime.js';

export async function workspace(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mcp-glue-test-')));
  t.after(async () => {
    // Assert the resolved absolute deletion target is this exact test-owned temporary directory.
    if (!path.isAbsolute(dir) || !path.basename(dir).startsWith('dsh-mcp-glue-test-') || path.dirname(dir) !== await fs.realpath(os.tmpdir())) throw new Error('unsafe cleanup target');
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}
export async function writeFixture(dir, file, value) {
  const target = path.join(dir, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
}
export async function harness(t) {
  const ctx = new Context();
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(McpResources);
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() });
  // Stand in for the runtime's Cordis loader service, which the plugin uses to obtain
  // the exact native bridge instance the host composed, and to find its own entry.
  ctx.provide('loader', {
    import: specifier => import(specifier),
    unwrapExports: exports => exports?.default ?? exports,
    entries: () => [{ options: { id: 'entry-workspace-mcp-glue', name: 'dsh-mcp-glue' }, fiber: {} }],
  });
  // Match agent-loop's global native tool-schema provider.
  ctx.systemPrompt.tools(context => ({ schemas: ctx.tools.schemas(context.scope) }));
  t.after(async () => { await ctx.fiber.dispose(); while (ctx.fiber.inertia) await ctx.fiber.inertia; });
  return ctx;
}
export function agent(ctx, dir, id = 'test-agent') {
  const value = { id, status: 'running', session: { id, header: { id, cwd: dir } } };
  const scope = createScope(ctx, value);
  value.ctx = scope.ctx;
  value.scope = scope;
  return value;
}
/**
 * Settings stub mirroring @deepseek-ai/dsh-settings: one descriptor per editable entry,
 * keyed by the Loader row id, with revision-checked merges.
 */
export function provideSettings(ctx, initial) {
  const state = { value: { ...initial }, revision: 1 };
  const updates = [];
  ctx.provide('settings', {
    writable: true,
    describe: () => [{ ns: 'entry-workspace-mcp-glue', revision: state.revision, applies: 'live', value: state.value }],
    update: async (ns, patch, revision) => {
      updates.push({ ns: String(ns), patch, revision });
      if (revision !== undefined && revision !== state.revision) throw new Error('stale settings revision');
      state.value = { ...state.value, ...patch };
      state.revision += 1;
    },
  });
  return { state, updates };
}
/** Mirror the plugin path: the Agent is the scope key and the plugin context owns the services. */
export const session = (ctx, value, config, dependencies = {}) => new WorkspaceMcpSession(value, config, { scopeOwner: ctx, nativePlugin: NativeMcp, ...dependencies });
export const fixtureCommand = label => ({ command: process.execPath, args: [path.resolve('test/fixtures/mcp-server.mjs'), label] });
