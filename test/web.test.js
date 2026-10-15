import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebHandler, installWebControl } from '../src/web.js';

function fakeRequest({ method = 'GET', url = '/workspace-mcp/status', headers = {}, body, rawBody, remoteAddress = '127.0.0.1' } = {}) {
  const chunks = rawBody !== undefined ? [Buffer.from(rawBody)] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
}
function fakeResponse() {
  return {
    status: undefined, headers: undefined, body: '', destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    end(text) { this.body = text ?? ''; },
    on() { return this; },
    off() { return this; },
  };
}
const control = {
  status: async (id, options) => ({ sessionId: id, refresh: options.refresh, servers: [] }),
  connect: async (id, serverId) => ({ sessionId: id, connected: serverId ?? 'all' }),
  disconnect: async (id, serverId) => ({ sessionId: id, disconnected: serverId ?? 'all' }),
  wait: async (id, version) => ({ version: Number.isSafeInteger(version) ? version + 1 : 1 }),
};
const call = async (handler, request) => {
  const response = fakeResponse();
  await handler(request, response);
  return { status: response.status, headers: response.headers, json: response.body === '' ? undefined : JSON.parse(response.body) };
};

test('status route requires loopback, the injected token, and a session id', async () => {
  const handler = createWebHandler(control, 'tok', { warn() {} });
  assert.equal((await call(handler, fakeRequest({ remoteAddress: '10.0.0.9' }))).status, 403);
  assert.equal((await call(handler, fakeRequest())).status, 403);
  assert.equal((await call(handler, fakeRequest({ headers: { 'x-workspace-mcp-token': 'other' } }))).status, 403);
  assert.equal((await call(handler, fakeRequest({ headers: { 'x-workspace-mcp-token': 'tok' } }))).status, 400);
  const ok = await call(handler, fakeRequest({ url: '/workspace-mcp/status?sessionId=s1&refresh=1', headers: { 'x-workspace-mcp-token': 'tok' } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { sessionId: 's1', refresh: true, servers: [] });
  assert.equal(ok.headers['cache-control'], 'no-store');
});

test('the handshake hands the token to same-origin callers only', async () => {
  const handler = createWebHandler(control, 'tok', { warn() {} });
  const opened = await call(handler, fakeRequest({ url: '/workspace-mcp/handshake' }));
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.json, { token: 'tok' });
  assert.equal((await call(handler, fakeRequest({ method: 'POST', url: '/workspace-mcp/handshake' }))).status, 405);
  // Another page in the browser reports itself as cross-site or with a foreign origin.
  assert.equal((await call(handler, fakeRequest({ url: '/workspace-mcp/handshake', headers: { 'sec-fetch-site': 'cross-site' } }))).status, 403);
  assert.equal((await call(handler, fakeRequest({ url: '/workspace-mcp/handshake', headers: { origin: 'https://evil.test' } }))).status, 403);
  const sameOrigin = await call(handler, fakeRequest({
    url: '/workspace-mcp/handshake',
    headers: { origin: 'http://127.0.0.1:19387', host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' },
  }));
  assert.equal(sameOrigin.status, 200);
});

test('connect and disconnect take POST plus a JSON body and forward the server id', async () => {
  const handler = createWebHandler(control, 'tok', { warn() {} });
  const headers = { 'x-workspace-mcp-token': 'tok' };
  assert.equal((await call(handler, fakeRequest({ url: '/workspace-mcp/connect', headers }))).status, 405);
  assert.equal((await call(handler, fakeRequest({ method: 'POST', url: '/workspace-mcp/connect', headers, body: {} }))).status, 400);
  const connected = await call(handler, fakeRequest({ method: 'POST', url: '/workspace-mcp/connect', headers, body: { sessionId: 's1', serverId: 'demo' } }));
  assert.equal(connected.status, 200);
  assert.deepEqual(connected.json, { sessionId: 's1', connected: 'demo' });
  const disconnected = await call(handler, fakeRequest({ method: 'POST', url: '/workspace-mcp/disconnect', headers, body: { sessionId: 's1' } }));
  assert.deepEqual(disconnected.json, { sessionId: 's1', disconnected: 'all' });
});

test('unknown actions, oversized bodies and service failures stay bounded error JSON', async () => {
  const handler = createWebHandler(control, 'tok', { warn() {} });
  const headers = { 'x-workspace-mcp-token': 'tok' };
  const unknown = await call(handler, fakeRequest({ url: '/workspace-mcp/nope', headers }));
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /unknown/);
  const big = fakeRequest({ method: 'POST', url: '/workspace-mcp/connect', headers, body: { sessionId: 's1', padding: 'x'.repeat(5000) } });
  const tooLarge = await call(handler, big);
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.json.code, 'REQUEST_TOO_LARGE');
  const notJson = await call(handler, fakeRequest({ method: 'POST', url: '/workspace-mcp/connect', headers, rawBody: 'not json' }));
  assert.equal(notJson.status, 415);
  assert.equal(notJson.json.code, 'INVALID_JSON');
  const failing = createWebHandler({ ...control, status: async () => { throw new Error('no live session with that id'); } }, 'tok', { warn() {} });
  const failed = await call(failing, fakeRequest({ url: '/workspace-mcp/status?sessionId=gone', headers }));
  assert.equal(failed.status, 400);
  assert.equal(failed.json.error, 'no live session with that id');
});

test('the wait route long-polls one session and stays quiet once the caller is gone', async () => {
  const handler = createWebHandler(control, 'tok', { warn() {} });
  const headers = { 'x-workspace-mcp-token': 'tok' };
  assert.equal((await call(handler, fakeRequest({ method: 'POST', url: '/workspace-mcp/wait', headers }))).status, 405);
  assert.equal((await call(handler, fakeRequest({ url: '/workspace-mcp/wait', headers }))).status, 400);
  const held = await call(handler, fakeRequest({ url: '/workspace-mcp/wait?sessionId=s1&version=3', headers }));
  assert.equal(held.status, 200);
  assert.deepEqual(held.json, { version: 4 });
  // A page that navigated away has already closed the response: answer nothing.
  const gone = fakeResponse();
  gone.destroyed = true;
  await handler(fakeRequest({ url: '/workspace-mcp/wait?sessionId=s1&version=3', headers }), gone);
  assert.equal(gone.status, undefined, 'a closed response is never written to');
});

test('a stale settings revision is a 409 conflict, not a bad request', async () => {
  const stale = {
    ...control,
    writeConfig: async () => {
      const failure = new Error('settings namespace "workspace-mcp-glue" changed since it was read');
      failure.code = 'SETTINGS_CONFLICT';
      throw failure;
    },
    readConfig: async () => ({ entryId: 'workspace-mcp-glue', editable: true, builtins: [], config: { presets: [] } }),
  };
  const handler = createWebHandler(stale, 'tok', { warn() {} });
  const headers = { 'x-workspace-mcp-token': 'tok' };
  const read = await call(handler, fakeRequest({ url: '/workspace-mcp/config', headers }));
  assert.equal(read.status, 200);
  assert.equal(read.json.entryId, 'workspace-mcp-glue');
  const conflict = await call(handler, fakeRequest({ method: 'POST', url: '/workspace-mcp/config', headers, body: { patch: { presets: [] } } }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 'SETTINGS_CONFLICT');
  assert.match(conflict.json.error, /changed since it was read/);
});

test('a missing settings form is reported together with the host reason', async () => {
  const unavailable = {
    ...control,
    writeConfig: async () => {
      const failure = new Error('这个插件条目没有可编辑的设置表单');
      failure.code = 'SETTINGS_UNAVAILABLE';
      failure.reason = 'settings 服务里没有这个条目的表单：它的 Config 缺少可热改字段（.volatile()）';
      throw failure;
    },
    readConfig: async () => ({ entryId: null, editable: false, builtins: [], config: { presets: [] } }),
  };
  const handler = createWebHandler(unavailable, 'tok', { warn() {} });
  const headers = { 'x-workspace-mcp-token': 'tok' };
  const failed = await call(handler, fakeRequest({ method: 'POST', url: '/workspace-mcp/config', headers, body: { patch: { presets: [] } } }));
  assert.equal(failed.status, 400);
  assert.equal(failed.json.code, 'SETTINGS_UNAVAILABLE');
  assert.match(failed.json.reason, /volatile/);
});

test('installWebControl injects one token into the page and registers one route', async () => {
  const taps = [];
  const routes = [];
  const ctx = {
    logger: { warn() {} },
    get: name => name === 'webServer' ? {
      tapIndex: tap => { taps.push(tap); return () => {}; },
      register: route => { routes.push(route); return () => {}; },
    } : undefined,
  };
  const dispose = installWebControl(ctx, control);
  assert.equal(taps.length, 1);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/workspace-mcp');
  const html = taps[0]('<html><head><title>t</title></head><body></body></html>');
  const token = /window\.__WORKSPACE_MCP_TOKEN__="([0-9a-f]{48})"/.exec(html);
  assert.ok(token, 'token script is injected');
  assert.equal(taps[0](html), html, 'index rendering is idempotent');
  assert.match(html, /<\/head><body>/);
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('declaration save/remove/write forward only literal allowLossy true', async () => {
  const calls = [];
  const handler = createWebHandler({
    saveDeclaration: async (...args) => { calls.push(['save', ...args]); return { ok: true }; },
    removeDeclaration: async (...args) => { calls.push(['remove', ...args]); return { ok: true }; },
    writeDeclaration: async (...args) => { calls.push(['write', ...args]); return { ok: true }; },
  }, 'tok', { warn() {} });
  for (const allowLossy of [undefined, false, 'true', true]) {
    for (const action of ['save', 'remove', 'write']) {
      const response = await call(handler, fakeRequest({
        method: 'POST', url: '/workspace-mcp/declaration', headers: { 'x-workspace-mcp-token': 'tok' },
        body: { sessionId: 's1', serverId: 'demo', action, changes: [], version: 'v1', preset: 'codex', name: 'fresh', allowLossy },
      }));
      assert.equal(response.status, 200);
      const args = calls.at(-1);
      assert.equal(args[1], 's1');
      if (action === 'write') assert.equal(args[2].allowLossy, allowLossy === true);
      else assert.deepEqual(args.at(-1), { allowLossy: allowLossy === true });
    }
  }
});

test('missing lossy confirmation is exposed as structured declaration error', async () => {
  const handler = createWebHandler({ saveDeclaration: async () => {
    throw Object.assign(new Error('TOML needs confirmation'), { code: 'DECLARATION_CONFIRM_REQUIRED' });
  } }, 'tok', { warn() {} });
  const response = await call(handler, fakeRequest({ method: 'POST', url: '/workspace-mcp/declaration',
    headers: { 'x-workspace-mcp-token': 'tok' }, body: { action: 'save', sessionId: 's1', serverId: 'demo' } }));
  assert.equal(response.status, 400);
  assert.equal(response.json.code, 'DECLARATION_CONFIRM_REQUIRED');
});

test('installWebControl is a no-op without a web server', async () => {
  const warnings = [];
  const dispose = installWebControl({ logger: { warn: message => warnings.push(message) }, get: () => undefined }, control);
  assert.equal(typeof dispose, 'function');
  assert.equal(warnings.length, 1);
});
