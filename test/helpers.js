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
import { projectToolSchema } from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline';
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
  // 0.2.3 gives the agent registry and the prompt one projection registry, and both await a
  // registration during activation. This plugin reads no projection, so the harness supplies the
  // registration surface only: a handle whose state is always empty.
  ctx.provide('sessionProjections', {
    register: async () => ({ stateOf: () => undefined, dispose() {} }),
  });
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(McpResources);
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() });
  // Stand in for the runtime's Cordis loader service, which the plugin uses to obtain
  // the exact native bridge instance the host composed, and to find its own entry.
  ctx.provide('loader', {
    import: specifier => specifier.endsWith('/package.json') ? import(specifier, { with: { type: 'json' } }) : import(specifier),
    unwrapExports: exports => exports?.default ?? exports,
    entries: () => [{ options: { id: 'entry-workspace-mcp-glue', name: 'dsh-mcp-glue' }, fiber: {} }],
  });
  // The agent loop's native executor: the real policy pipeline, so pre-execute gates, guards and
  // argument validation behave exactly as they do in the running app.
  ctx.effect(() => ctx.tools.setExecutor({
    describe: tools => ({
      schemas: tools.map(tool => projectToolSchema(tool, true)),
      knownNames: new Set(tools.map(tool => tool.name)),
      restrictableNames: new Set(tools.map(tool => tool.name)),
    }),
    execute: input => executeToolBatch(input, new ToolExecutionPipeline(ctx), () => 8),
    sections: [],
  }), 'test.tool-executor');
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
/** One controllable connection-status cell, shaped like the bridge's handle. */
class FakeStatus {
  constructor(initial) {
    this.status = initial;
    this.listeners = new Set();
    this.closed = { closeConfirmed: true };
  }
  current() { return this.status; }
  closure() { return this.closed; }
  onChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  /** Publish one status to every observer, exactly like the bridge's cell. */
  publish(next) {
    this.status = next;
    for (const callback of [...this.listeners]) callback(next);
  }
}

/** The no-op plugin behind each fake instance fiber. */
const FAKE_MOUNT_PLUGIN = { name: 'fake-mcp-instance', inject: ['tools'], apply() {} };

/** A controllable browser-authorization owner; `changed` runs on every phase the test publishes. */
export function fakeAuthorization(initial = { phase: 'waiting-browser', authorizationUrl: 'https://auth.example/consent' }) {
  const owner = {
    view: { id: 'attempt-1', ...initial }, changed: undefined,
    cancelled: 0, disposed: 0,
    current() { return { ...owner.view }; },
    async start() { return { ...owner.view }; },
    async cancel() { owner.cancelled += 1; owner.publish({ phase: 'cancelled' }); },
    async dispose() { owner.disposed += 1; return { closeConfirmed: true }; },
    /** Move the attempt and notify the plugin, the way the bridge's owner does. */
    publish(next) { owner.view = { id: owner.view.id, ...next }; owner.changed?.(); },
  };
  return owner;
}

/**
 * A stand-in for the bridge's management host, `ctx.mcpClientHost`.
 *
 * The bridge is the only thing this plugin talks to now, so a fake host is a sharper test
 * surface than a fake native module: every mount gets its own status cell, and a test drives
 * the same typed state machine the real bridge publishes.
 *
 * @param spec.mount - `(record, mountIndex) => { status?, error?, toolCount? }`; the default
 *   settles as a live connection with one tool.
 * @param spec.dispose - replaces the instance disposal; its return value is the close result.
 * @param spec.probe - replaces `host.probe`.
 * @param spec.validate - replaces `host.validate`.
 * @param spec.authorization - replaces `host.authorization`.
 */
export function fakeHost(spec = {}) {
  const calls = { mounts: [], probes: [], validates: [], authorizations: [] };
  class McpClientHost {
    constructor(context) { this.ownerContext = context; }
    validate(config, path) {
      calls.validates.push({ config, path, context: this.ownerContext });
      return spec.validate === undefined ? { ...config } : spec.validate(config, path);
    }
    mount(config) {
      // Each instance gets its own child fiber, exactly like the bridge: a tool registered here
      // is scoped to the mounting agent and disappears when the instance is disposed.
      const fiber = this.ownerContext.plugin(FAKE_MOUNT_PLUGIN);
      const record = {
        config, context: fiber.ctx, fiber, disposed: 0, closeResult: { closeConfirmed: true },
        status: new FakeStatus({ state: 'connecting', attempt: 0 }),
      };
      calls.mounts.push(record);
      const plan = spec.mount?.(record, calls.mounts.length) ?? {};
      record.instance = {
        // A gate holds activation open, so a test can outlive the plugin's startup budget.
        ready: Promise.resolve(plan.gate).then(() => {
          if (plan.error !== undefined) throw plan.error;
          record.status.publish(plan.status ?? { state: 'connected', toolCount: plan.toolCount ?? 1, connectedAt: Date.now() });
          return record.status;
        }),
        dispose: async () => {
          record.disposed += 1;
          const result = spec.dispose === undefined ? record.closeResult : spec.dispose(record);
          record.status.publish({ state: 'closed', result: record.closeResult });
          await fiber.dispose();
          return result;
        },
      };
      return record.instance;
    }
    probe(config, options) {
      calls.probes.push({ config, options, context: this.ownerContext });
      return Promise.resolve().then(() => spec.probe?.(config, options)
        ?? { ok: true, toolNames: ['identity'], truncated: false, durationMs: 1, closeConfirmed: true });
    }
    authorization(config, changed) {
      const owner = spec.authorization?.(config, changed) ?? fakeAuthorization();
      owner.changed = changed;
      calls.authorizations.push({ config, changed, owner });
      return owner;
    }
  }
  return { module: { McpClientHost }, calls, Host: McpClientHost };
}

/**
 * One tool call through the same policy pipeline the model's own calls use.
 * @returns the canonical result (`{ isError, value, content }`), not the batch envelope.
 */
export async function callTool(ctx, owner, name, args = {}, { callId = `call-${name}`, signal = new AbortController().signal } = {}) {
  const { results } = await ctx.tools.execute({
    calls: [{ id: callId, name, arguments: JSON.stringify(args) }],
    signal,
    agent: owner,
  });
  return results[0]?.result;
}
/** The model-facing text of one canonical tool result. */
export const textOf = result => (result?.content ?? []).map(block => block?.text ?? '').join('');
