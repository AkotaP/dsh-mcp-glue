import { randomBytes } from 'node:crypto';

const TOKEN_GLOBAL = '__WORKSPACE_MCP_TOKEN__';
const ROUTE = '/workspace-mcp';
const TOKEN_HEADER = 'x-workspace-mcp-token';
const MAX_BODY_BYTES = 4096;
/** Cap on the JSON response; the status view is small and bounded by maxServers. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
/** A body problem the route reports with its own status instead of a generic 400. */
const bodyError = (code, message) => Object.assign(new Error(message), { code });
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw bodyError('REQUEST_TOO_LARGE', 'request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw bodyError('INVALID_JSON', 'request body must be JSON'); }
}
const sessionOf = value => (typeof value?.sessionId === 'string' ? value.sessionId : undefined);
const serverOf = value => (typeof value?.serverId === 'string' ? value.serverId : undefined);
/** One token per Host process, so reloading the plugin never invalidates an open page. */
let processToken;

/**
 * Whether a request plausibly originates from the page this Host served.
 *
 * Browsers send `Origin` (and `Sec-Fetch-Site`) on cross-origin requests; a request
 * without either cannot be a page in another origin. This is the second fence after
 * the loopback check, and it is what keeps another web page from driving the control
 * channel even though it could reach the loopback port.
 */
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

/**
 * Same-origin control channel for the management UI.
 *
 * Only loopback peers holding the per-process token may drive it. The token is
 * injected into index.html, but a page served before this plugin activated would miss
 * it, so `handshake` also hands the token to a same-origin caller: a cross-origin page
 * cannot read that JSON (no CORS headers) and a local process could already do
 * everything the channel does, so this trades no real authority for robustness.
 */
export function createWebHandler(control, token, logger) {
  return async function handle(req, res) {
    try {
      if (!LOOPBACK.has(req.socket?.remoteAddress ?? '')) { sendJson(res, 403, { error: 'loopback clients only' }); return; }
      if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross-origin requests are not accepted' }); return; }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const action = url.pathname.slice(ROUTE.length).replace(/^\//, '');
      if (action === 'handshake') {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'use GET' }); return; }
        sendJson(res, 200, { token });
        return;
      }
      if (req.headers[TOKEN_HEADER] !== token) { sendJson(res, 403, { error: 'stale workspace MCP token; the page reloads it automatically' }); return; }
      if (action === 'status') {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'use GET' }); return; }
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) { sendJson(res, 400, { error: 'sessionId is required' }); return; }
        sendJson(res, 200, await control.status(sessionId, { refresh: url.searchParams.get('refresh') === '1' }));
        return;
      }
      if (action === 'wait') {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'use GET' }); return; }
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) { sendJson(res, 400, { error: 'sessionId is required' }); return; }
        // Held until the view moves or the hold expires; a client that navigates away aborts
        // the request, which releases the hold instead of leaving it to its timeout.
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.on('close', abort);
        try {
          const version = Number(url.searchParams.get('version'));
          const view = await control.wait(sessionId, version, controller.signal);
          if (!res.destroyed && !res.writableEnded) sendJson(res, 200, view);
        } finally {
          res.off('close', abort);
        }
        return;
      }
      if (action === 'connect' || action === 'disconnect' || action === 'follow') {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'use POST' }); return; }
        const body = await readJson(req);
        const sessionId = sessionOf(body);
        if (!sessionId) { sendJson(res, 400, { error: 'sessionId is required' }); return; }
        const serverId = serverOf(body);
        if (action === 'connect') {
          logger?.warn(`workspace-mcp: manual connect requested for session ${sessionId}${serverId === undefined ? '' : ` server ${serverId}`}`);
          sendJson(res, 200, await control.connect(sessionId, serverId));
        } else if (action === 'disconnect') {
          sendJson(res, 200, await control.disconnect(sessionId, serverId));
        } else {
          sendJson(res, 200, await control.follow(sessionId));
        }
        return;
      }
      if (action === 'declaration') {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'use POST' }); return; }
        const body = await readJson(req);
        const sessionId = sessionOf(body);
        if (!sessionId) { sendJson(res, 400, { error: 'sessionId is required' }); return; }
        if (body?.action === 'list') { sendJson(res, 200, await control.declarations(sessionId)); return; }
        if (body?.action === 'write') {
          logger?.warn(`workspace-mcp: declaration created in session ${sessionId}`);
          sendJson(res, 200, await control.writeDeclaration(sessionId, {
            preset: body.preset, name: body.name, fields: body.fields,
            fromServerId: body.fromServerId, removeSource: body.removeSource, overwrite: body.overwrite,
            allowLossy: body.allowLossy === true,
          }));
          return;
        }
        const serverId = serverOf(body);
        if (serverId === undefined) { sendJson(res, 400, { error: 'serverId is required' }); return; }
        if (body?.action === 'save') {
          logger?.warn(`workspace-mcp: declaration edit requested for ${serverId} in session ${sessionId}`);
          sendJson(res, 200, await control.saveDeclaration(sessionId, serverId, body.changes, body.version, { allowLossy: body.allowLossy === true }));
        } else if (body?.action === 'remove') {
          logger?.warn(`workspace-mcp: declaration removal requested for ${serverId} in session ${sessionId}`);
          sendJson(res, 200, await control.removeDeclaration(sessionId, serverId, body.version, { allowLossy: body.allowLossy === true }));
        } else {
          sendJson(res, 400, { error: `unknown declaration action "${String(body?.action)}"` });
        }
        return;
      }
      if (action === 'config') {
        if (req.method === 'GET') { sendJson(res, 200, await control.readConfig()); return; }
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'use GET or POST' }); return; }
        const body = await readJson(req);
        logger?.warn('workspace-mcp: management UI updated the preset configuration');
        sendJson(res, 200, await control.writeConfig(body?.patch));
        return;
      }
      sendJson(res, 404, { error: `unknown workspace MCP action "${action}"` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error?.code === 'string' ? error.code : undefined;
      logger?.warn(`workspace-mcp: control route failed: ${message}`);
      // A stale revision is a conflict, not a bad request: the page re-reads and retries.
      const status = code === 'SETTINGS_CONFLICT' || code === 'DECLARATION_STALE' || code === 'DECLARATION_CONFLICT' ? 409
        : code === 'DECLARATION_READ_ONLY' ? 403
          : code === 'REQUEST_TOO_LARGE' ? 413 : code === 'INVALID_JSON' ? 415 : 400;
      sendJson(res, status, { error: message, ...(code === undefined ? {} : { code }), ...(error?.reason === undefined ? {} : { reason: error.reason }) });
    }
  };
}

/** Resolve the web server through injection, with a lazy fallback for bare contexts. */
function resolveWebServer(ctx) {
  try { if (ctx?.webServer !== undefined) return ctx.webServer; } catch { /* not injected here */ }
  try { return ctx?.get?.('webServer'); } catch { return undefined; }
}

/** Inject the control token into the page shell and register the route; returns the disposer. */
export function installWebControl(ctx, control) {
  const webServer = resolveWebServer(ctx);
  if (!webServer) {
    ctx.logger?.warn('workspace-mcp: webServer service is unavailable; the management UI has no data source');
    return () => {};
  }
  // One token for the whole Host process: a page served before this activation still
  // gets it through `handshake`, and a plugin reload no longer invalidates the page.
  const token = processToken ??= randomBytes(24).toString('hex');
  const disposers = [];
  const tap = html => html.includes(TOKEN_GLOBAL)
    ? html
    : html.includes('</head>')
      ? html.replace('</head>', `<script>window.${TOKEN_GLOBAL}=${JSON.stringify(token)}</script></head>`)
      : `<script>window.${TOKEN_GLOBAL}=${JSON.stringify(token)}</script>${html}`;
  disposers.push(webServer.tapIndex(tap));
  disposers.push(webServer.register({ kind: 'prefix', path: ROUTE, handler: createWebHandler(control, token, ctx.logger) }));
  return () => { for (const dispose of disposers) { try { dispose(); } catch { /* already gone */ } } };
}
