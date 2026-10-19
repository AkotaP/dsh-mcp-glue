import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as NativeMcp from '@deepseek-ai/dsh-mcp-client';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { agent, harness } from './helpers.js';
import { createNativeAdapter, classifyConnectionError, nativeBridgeSupport, supportsNativeBridge } from '../src/bridge.js';

// Use the SDK resolved BY the installed native module, not another bundled copy.
const require = createRequire(import.meta.url);
const nativeRequire = createRequire(require.resolve('@deepseek-ai/dsh-mcp-client'));
const { SdkError, SdkErrorCode, SdkHttpError, ProtocolError } = await import(pathToFileURL(nativeRequire.resolve('@modelcontextprotocol/client')).href);
const signal = () => new AbortController().signal;
const exec = owner => ({ agent: owner, signal: signal(), callId: 'bridge-call', arguments: {} });
const sink = () => {
  const records = [];
  const logger = Object.fromEntries(['warn', 'error', 'info', 'debug'].map(level => [level, function (...args) {
    assert.equal(this, logger, 'the supplied logger keeps its receiver');
    records.push({ level, args });
  }]));
  return { logger, records };
};
async function dispose(fiber) {
  await fiber.dispose();
  while (fiber.inertia !== undefined) await fiber.inertia;
}
const httpError = status => new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'credential=DO_NOT_LOG', { status, text: 'DO_NOT_LOG' });
const definition = (name, execute) => ({
  name, description: 'bridge fixture', parameters: { type: 'object', properties: {} },
  output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute,
});

test('a verified release is trusted by version, any other by proven capabilities', () => {
  for (const version of ['0.2.0-rc.2', '0.2.1-rc.2']) {
    assert.equal(nativeBridgeSupport(NativeMcp, version), 'verified');
    assert.equal(supportsNativeBridge(NativeMcp, version), true);
  }
  // An upgraded or unreadable version must not disable the feature: the two capabilities
  // the adapter really needs are proved against the loaded module instead.
  for (const version of [null, undefined, '0.2.0-rc.3', '0.2.2-rc.1', 'v0.2.0-rc.2']) {
    assert.equal(nativeBridgeSupport(NativeMcp, version), 'capabilities');
    assert.equal(supportsNativeBridge(NativeMcp, version), true);
  }
  // Shape or capability gaps are still refusals.
  for (const plugin of [undefined, {}, { apply() {} }, { ...NativeMcp, inject: [] }]) {
    assert.equal(supportsNativeBridge(plugin, '0.2.0-rc.2'), false);
  }
  for (const plugin of [{ ...NativeMcp, createMcpToolDefinition: undefined }, { ...NativeMcp, Config: undefined }]) {
    assert.equal(nativeBridgeSupport(plugin, null), undefined);
    assert.equal(supportsNativeBridge(plugin, null), false);
  }
});

test('startup classification reads bounded structured causes, never error-message substrings', () => {
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    assert.deepEqual(classifyConnectionError(new Error('outer', { cause: Object.assign(new Error('secret'), { code }) })), { code, retryable: false });
  }
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'ETIMEDOUT']) {
    assert.deepEqual(classifyConnectionError(new Error('fetch failed', { cause: Object.assign(new Error('secret'), { code }) })), { code, retryable: true });
  }
  for (const status of [401, 403]) assert.deepEqual(classifyConnectionError(httpError(status)), { code: 'AUTH_REQUIRED', retryable: false });
  for (const status of [429, 500, 502, 503, 599]) assert.deepEqual(classifyConnectionError(httpError(status)), { code: `HTTP_${status}`, retryable: true });
  assert.deepEqual(classifyConnectionError(httpError(404)), { code: 'SESSION_EXPIRED', retryable: true });
  assert.deepEqual(classifyConnectionError(new SdkError(SdkErrorCode.ConnectionClosed, 'secret')), { code: 'CONNECTION_CLOSED', retryable: true });
  const wrapped = new SdkError(SdkErrorCode.EraNegotiationFailed, 'secret', { cause: Object.assign(new Error(), { code: 'EACCES' }) });
  assert.deepEqual(classifyConnectionError(wrapped), { code: 'EACCES', retryable: false });
  const unknowns = [null, undefined, 'ECONNRESET', new Error('HTTP 401 ECONNREFUSED connection closed ENOENT'),
    Object.assign(new Error(), { data: { status: 401 } }), new SdkError(SdkErrorCode.RequestTimeout, 'secret')];
  const cycle = new Error('cyclic'); cycle.cause = cycle; unknowns.push(cycle);
  let deep = Object.assign(new Error(), { code: 'EACCES' });
  for (let i = 0; i < 9; i++) deep = new Error('wrapper', { cause: deep });
  unknowns.push(deep, Object.defineProperty(new Error(), 'cause', { get() { throw new Error('getter'); } }));
  for (const error of unknowns) assert.deepEqual(classifyConnectionError(error), { code: 'START_FAILED', retryable: true });
});

test('scoped registration overlays preserve every definition field, receivers, injected child effects and global services', async t => {
  const ctx = await harness(t), owner = agent(ctx, process.cwd(), 'bridge-owner'), sibling = agent(ctx, process.cwd(), 'bridge-sibling');
  const { logger, records } = sink(), events = [];
  const globalTool = definition('bridge_tool', () => 'global');
  const globalProvider = { request() { return 'global-resource'; } };
  ctx.tools.register(globalTool);
  ctx.mcpResources.register('bridge', globalProvider);
  const toolsService = ctx.tools[Symbol.for('cordis.original')], resourceService = ctx.mcpResources[Symbol.for('cordis.original')];
  const registerTools = toolsService.register, registerResources = resourceService.register;
  const symbol = Symbol('definition metadata'), projection = () => [{ type: 'text', text: 'projected' }];
  const original = definition('bridge_tool', function (_args, execution) {
    assert.equal(this, original);
    assert.equal(execution.agent, owner);
    return { original: true };
  });
  Object.assign(original, { projectContent: projection, timeoutMs: 3210, customField: { kept: true }, [symbol]: 42 });
  Object.defineProperty(original, 'hidden', { value: 'kept', enumerable: false });
  Object.freeze(original);
  const provider = Object.freeze({ request(_request, execution) { assert.equal(this, provider); assert.equal(execution.agent, owner); return 'scoped-resource'; }, metadata: 17 });
  let disposed = 0, innerDisposed = 0, actualContext;
  const native = {
    name: NativeMcp.name, inject: NativeMcp.inject,
    async apply(child) {
      assert.equal(this, native);
      actualContext = child;
      assert.equal(scopeOf(child), owner);
      child.effect(() => () => { disposed++; });
      child.tools.register(original);
      child.inject(['mcpResources'], inner => {
        assert.equal(scopeOf(inner), owner);
        inner.effect(() => () => { innerDisposed++; });
        inner.mcpResources.register('bridge', provider);
        inner.logger('DO_NOT_LOG').debug('DO_NOT_LOG', { token: 'DO_NOT_LOG' });
      });
    },
  };
  const adapter = createNativeAdapter(native, { logger, serverName: 'bridge', onEvent: event => events.push(event) });
  assert.equal(adapter.name, native.name); assert.equal(adapter.inject, native.inject);
  assert.equal(adapter.apply.constructor.name, 'AsyncFunction');
  const fiber = owner.ctx.plugin(adapter, {});
  await fiber;
  assert.equal(actualContext.fiber, fiber.ctx.fiber, 'no replacement child scope');
  const wrapped = ctx.tools.get('bridge_tool', owner);
  assert.notEqual(wrapped, original);
  for (const key of Reflect.ownKeys(original).filter(key => key !== 'execute')) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(wrapped, key), Object.getOwnPropertyDescriptor(original, key));
  }
  assert.equal(wrapped.projectContent, projection);
  assert.deepEqual(await wrapped.execute({}, exec(owner)), { original: true });
  const projected = await ctx.tools.execute({ name: 'bridge_tool', ...exec(owner) });
  assert.deepEqual(projected.content, projection());
  assert.equal(await ctx.mcpResources.request('bridge', { method: 'resources/list' }, exec(owner)), 'scoped-resource');
  assert.equal(ctx.tools.get('bridge_tool'), globalTool);
  assert.equal(ctx.tools.get('bridge_tool', sibling), globalTool);
  assert.equal(ctx.mcpResources.request('bridge', { method: 'resources/list' }, exec(sibling)), 'global-resource');
  assert.equal(ctx.tools[Symbol.for('cordis.original')], toolsService);
  assert.equal(ctx.mcpResources[Symbol.for('cordis.original')], resourceService);
  assert.equal(toolsService.register, registerTools);
  assert.equal(resourceService.register, registerResources);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], { level: 'debug', args: ['workspace-mcp: native debug (bridge; details redacted)'] });
  // Two tool calls and one resource read all reached the (fake) server: each is a liveness proof.
  assert.deepEqual(events, [{ kind: 'request-ok' }, { kind: 'request-ok' }, { kind: 'request-ok' }]);
  await dispose(fiber);
  assert.equal(disposed, 1); assert.equal(innerDisposed, 1);
  assert.equal(ctx.tools.get('bridge_tool', owner), globalTool);
  assert.equal(ctx.mcpResources.request('bridge', { method: 'resources/list' }, exec(owner)), 'global-resource');
});

test('only exact verified native lifecycle records emit events; every native log is redacted', async t => {
  const ctx = await harness(t), { logger, records } = sink(), events = [];
  const label = 'mcp-client(logs)';
  const lost = `${label}: connection lost and reconnect is disabled — registered tools will fail until an HMR reload or Host restart`;
  const failedClose = `${label}: failed generation could not confirm transport closure — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry`;
  const disposalClose = `${label}: transport closure could not be confirmed during disposal — server shutdown may be incomplete`;
  const native = { name: 'mcp-client', inject: ['tools'], async apply(child) {
    child.logger.error(`${label}: connection failed and reconnect is disabled — no tools were registered; reload the plugin or restart the Host to connect`);
    child.logger.error(`${label}: connection attempt failed: token=DO_NOT_LOG`);
    child.logger.error(`foreign ${lost}`);
    child.logger.error(lost, 'DO_NOT_LOG');
    child.logger.warn(lost);
    child.logger.error(lost);
    child.logger('DO_NOT_LOG').error(failedClose);
    child.effect(() => () => child.logger.error(disposalClose));
    for (const level of ['warn', 'error', 'info', 'debug']) child.logger[level]('DO_NOT_LOG %o', { password: 'DO_NOT_LOG' });
  } };
  const fiber = ctx.plugin(createNativeAdapter(native, { logger, serverName: 'logs', onEvent: event => events.push(event) }), {});
  await fiber;
  assert.deepEqual(events, [{ kind: 'disconnected', code: 'CONNECTION_LOST' }, { kind: 'unsafe-close', code: 'CLOSE_UNCONFIRMED' }]);
  await dispose(fiber);
  assert.deepEqual(events.at(-1), { kind: 'unsafe-close', code: 'CLOSE_UNCONFIRMED' });
  assert.equal(records.length, 12);
  for (const { level, args } of records) assert.deepEqual(args, [`workspace-mcp: native ${level} (logs; details redacted)`]);
  assert.ok(!JSON.stringify({ events, records }).includes('DO_NOT_LOG'));
});

test('raw typed tool/provider exceptions are observed before ToolRuntime normalizes them and rethrown unchanged', async t => {
  const ctx = await harness(t), owner = agent(ctx, process.cwd(), 'typed-errors');
  const { logger } = sink(), events = [];
  let thrown;
  const provider = { request() { assert.equal(this, provider); throw thrown; } };
  const tool = definition('bridge_failure', function () { assert.equal(this, tool); throw thrown; });
  const native = { name: 'mcp-client', inject: ['tools'], async apply(child) {
    child.tools.register(tool);
    child.inject(['mcpResources'], inner => inner.mcpResources.register('typed', provider));
  } };
  const fiber = owner.ctx.plugin(createNativeAdapter(native, { logger, serverName: 'typed', onEvent: event => events.push(event) }), {});
  await fiber;
  const wrapped = ctx.tools.get('bridge_failure', owner);
  const cases = [
    [new SdkError(SdkErrorCode.ConnectionClosed, 'DO_NOT_LOG'), 'CONNECTION_CLOSED', true],
    [httpError(401), 'AUTH_REQUIRED', false], [httpError(403), 'AUTH_REQUIRED', false],
    [httpError(404), 'SESSION_EXPIRED', true], [httpError(429), 'HTTP_429', true], [httpError(503), 'HTTP_503', true],
    [new Error('outer', { cause: Object.assign(new Error('DO_NOT_LOG'), { code: 'ECONNRESET' }) }), 'ECONNRESET', true],
    [new Error('business ECONNRESET HTTP 401 connection closed'), undefined],
    [new ProtocolError(-32000, 'business', { status: 503 }), undefined],
    [new SdkError(SdkErrorCode.RequestTimeout, 'DO_NOT_LOG'), undefined],
    [Object.assign(new Error('DO_NOT_LOG'), { name: 'AbortError', cause: httpError(503) }), undefined],
    [Object.assign(new Error('business'), { data: { status: 503 } }), undefined],
  ];
  for (const [error, code, retryable] of cases) {
    thrown = error;
    for (const operation of [() => wrapped.execute({}, exec(owner)), () => ctx.mcpResources.request('typed', { method: 'resources/list' }, exec(owner))]) {
      events.length = 0;
      await assert.rejects(operation, caught => caught === error);
      assert.deepEqual(events.filter(event => event.kind !== 'request-ok'), code ? [{ kind: 'request-failed', code, retryable }] : []);
    }
  }
  thrown = httpError(503);
  const controller = new AbortController(); controller.abort();
  events.length = 0;
  await assert.rejects(() => wrapped.execute({}, { ...exec(owner), signal: controller.signal }), caught => caught === thrown);
  await assert.rejects(() => ctx.mcpResources.request('typed', { method: 'resources/list' }, { ...exec(owner), signal: controller.signal }), caught => caught === thrown);
  assert.deepEqual(events, []);
  const result = await ctx.tools.execute({ name: 'bridge_failure', ...exec(owner) });
  assert.equal(result.isError, true);
  assert.deepEqual(events.filter(event => event.kind !== 'request-ok'), [{ kind: 'request-failed', code: 'HTTP_503', retryable: true }]);
  assert.equal(result.error.code, undefined, 'ToolRuntime drops the raw transport code');
  await dispose(fiber);
});

/** In-process real wire server: native HTTP transport, SDK and scoped services, with no stdio pipes. */
async function wireServer(t, { zeroTools = false, startupStatus } = {}) {
  const state = { failure: undefined, requests: [] };
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(405).end(); return; }
    if (request.method === 'DELETE') { response.writeHead(200).end(); return; }
    let text = '';
    for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    state.requests.push(message.method);
    if (startupStatus || state.failure && ['tools/call', 'resources/list', 'resources/read', 'resources/templates/list'].includes(message.method)) {
      response.writeHead(startupStatus ?? state.failure, { 'content-type': 'text/plain' }).end('DO_NOT_LOG'); return;
    }
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    const result = (() => {
      switch (message.method) {
        case 'initialize': return { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'bridge-wire', version: '1' }, instructions: 'Bridge scoped instructions' };
        case 'tools/list': return { tools: zeroTools ? [] : [{ name: 'identity', inputSchema: { type: 'object', properties: {} } }, { name: 'image', inputSchema: { type: 'object', properties: {} } }] };
        case 'tools/call': return { content: message.params.name === 'image' ? [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] : [{ type: 'text', text: 'wire-result' }] };
        case 'resources/list': return { resources: [{ name: 'wire-resource', uri: 'bridge://identity' }] };
        case 'resources/templates/list': return { resourceTemplates: [] };
        case 'resources/read': return { contents: [{ uri: message.params.uri, text: 'wire-resource' }] };
      }
    })();
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id,
      ...(result === undefined ? { error: { code: -32601, message: 'Method not found' } } : { result }) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { state, url: `http://127.0.0.1:${server.address().port}/mcp` };
}
const config = (url, serverName) => ({ transport: 'streamable-http', url, serverName, failOnStartupError: true, reconnect: { enabled: false }, toolCallTimeoutMs: 2000 });

test('real native scoped tools, resources and image projection work; global native connection stays untouched', { timeout: 20000 }, async t => {
  const ctx = await harness(t), { state, url } = await wireServer(t);
  const owner = agent(ctx, process.cwd(), 'native-owner'), other = agent(ctx, process.cwd(), 'native-other');
  const { logger, records } = sink(), events = [];
  const nativeApply = NativeMcp.apply, nativeInject = NativeMcp.inject;
  const global = ctx.plugin(NativeMcp, config(url, 'wire'));
  await global;
  const globalDefinition = ctx.tools.get('mcp__wire__identity');
  const wrapped = owner.ctx.plugin(createNativeAdapter(NativeMcp, { logger, serverName: 'wire', onEvent: event => events.push(event) }), config(url, 'wire'));
  await wrapped;
  assert.equal(NativeMcp.apply, nativeApply); assert.equal(NativeMcp.inject, nativeInject);
  assert.equal(ctx.tools.get('mcp__wire__identity'), globalDefinition);
  assert.equal(ctx.tools.get('mcp__wire__identity', other), globalDefinition);
  assert.notEqual(ctx.tools.get('mcp__wire__identity', owner), globalDefinition);
  const identity = await ctx.tools.execute({ name: 'mcp__wire__identity', ...exec(owner) });
  assert.equal(identity.isError, false); assert.equal(identity.value.content[0].text, 'wire-result');
  const image = await ctx.tools.execute({ name: 'mcp__wire__image', ...exec(owner) });
  assert.equal(image.isError, false);
  assert.ok(image.content[0].text.includes('image unavailable'), 'native definition-owned image projection survives wrapping');
  const resource = await ctx.tools.execute({ name: 'read_mcp_resource', ...exec(owner), arguments: { server: 'wire', uri: 'bridge://identity' } });
  assert.equal(resource.isError, false); assert.equal(resource.value.contents[0].text, 'wire-resource');
  const assembly = await ctx.systemPrompt.assemble({ scope: owner });
  assert.ok(assembly.sections.some(section => section.text.includes('Bridge scoped instructions')));
  state.failure = 404;
  const failed = await ctx.tools.execute({ name: 'mcp__wire__identity', ...exec(owner) });
  assert.equal(failed.isError, true);
  assert.deepEqual(events.filter(event => event.kind !== 'request-ok'), [{ kind: 'request-failed', code: 'SESSION_EXPIRED', retryable: true }]);
  events.length = 0;
  await assert.rejects(() => ctx.mcpResources.request('wire', { method: 'resources/list' }, exec(owner)), error => error instanceof SdkHttpError && error.data.status === 404);
  assert.deepEqual(events.filter(event => event.kind !== 'request-ok'), [{ kind: 'request-failed', code: 'SESSION_EXPIRED', retryable: true }]);
  events.length = 0;
  await ctx.tools.execute({ name: 'mcp__wire__identity', ...exec(other) });
  assert.deepEqual(events, [], 'global requests are never intercepted');
  state.failure = undefined;
  await dispose(wrapped);
  assert.equal(ctx.tools.get('mcp__wire__identity', owner), globalDefinition);
  assert.equal((await ctx.tools.execute({ name: 'mcp__wire__identity', ...exec(other) })).isError, false);
  assert.ok(!JSON.stringify(records).includes('DO_NOT_LOG'));
  await dispose(global);
});

test('real native zero-tool server is ready and its resources remain scoped', { timeout: 15000 }, async t => {
  const ctx = await harness(t), { url } = await wireServer(t, { zeroTools: true });
  const owner = agent(ctx, process.cwd(), 'zero-owner'), other = agent(ctx, process.cwd(), 'zero-other');
  const { logger } = sink(), events = [];
  const fiber = owner.ctx.plugin(createNativeAdapter(NativeMcp, { logger, serverName: 'zero', onEvent: event => events.push(event) }), config(url, 'zero'));
  await fiber;
  assert.deepEqual(ctx.tools.schemas(owner).filter(tool => tool.name.startsWith('mcp__zero__')), []);
  const resources = await ctx.mcpResources.request('zero', { method: 'resources/list' }, exec(owner));
  assert.equal(resources.resources[0].name, 'wire-resource');
  assert.throws(() => ctx.mcpResources.request('zero', { method: 'resources/list' }, exec(other)), /unavailable/);
  assert.deepEqual(events, [{ kind: 'request-ok' }], 'the scoped resource read answered, so it confirmed liveness');
  await dispose(fiber);
  assert.throws(() => ctx.mcpResources.request('zero', { method: 'resources/list' }, exec(owner)), /unavailable/);
});

test('real native initial auth failure propagates through fiber.await, not a disconnected event, and logs are redacted', { timeout: 15000 }, async t => {
  const ctx = await harness(t), { url } = await wireServer(t, { startupStatus: 401 });
  const owner = agent(ctx, process.cwd(), 'auth-owner');
  const { logger, records } = sink(), events = [];
  const fiber = owner.ctx.plugin(createNativeAdapter(NativeMcp, { logger, serverName: 'auth', onEvent: event => events.push(event) }), config(url, 'auth'));
  await assert.rejects(() => fiber.await(), error => {
    assert.deepEqual(classifyConnectionError(error), { code: 'AUTH_REQUIRED', retryable: false });
    return true;
  });
  assert.deepEqual(events, []);
  assert.ok(records.length >= 1);
  assert.ok(records.every(record => record.args.length === 1 && record.args[0] === `workspace-mcp: native ${record.level} (auth; details redacted)`));
  assert.ok(!JSON.stringify(records).includes('DO_NOT_LOG'));
  await dispose(fiber);
});
