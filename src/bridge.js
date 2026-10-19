/** Compatibility boundary for the host's exact native MCP module (never import a second copy). */
const NATIVE_VERSION = '0.2.0-rc.2';
const CAUSE_LIMIT = 8;
const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND',
  'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN',
  'ETIMEDOUT', 'ERR_SOCKET_CLOSED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);
const PERMANENT_CODES = new Set(['ENOENT', 'EACCES', 'EPERM']);

function isSdkError(error) {
  // SDK 2 uses cross-bundle brands; the names also support older unbranded SDK errors.
  return error?.[Symbol.for('mcp.sdk.errorBrands')]?.has?.('mcp.SdkError') === true
    || error?.name === 'SdkError' || error?.name === 'SdkHttpError';
}

function causes(error) {
  const chain = [], seen = new Set();
  while (error && (typeof error === 'object' || typeof error === 'function')
    && chain.length < CAUSE_LIMIT && !seen.has(error)) {
    seen.add(error);
    chain.push(error);
    // SDK negotiation wraps the original transport error in data.cause, not Error.cause.
    error = error.cause ?? (isSdkError(error) ? error.data?.cause : undefined);
  }
  return chain;
}

function structuredFailure(chain, startup) {
  // Permanent configuration/auth failures take precedence over a wrapping transport error.
  for (const error of chain) {
    if (startup && PERMANENT_CODES.has(error.code)) return { code: error.code, retryable: false };
    if ((isSdkError(error) && (error.data?.status === 401 || error.data?.status === 403
      || error.code === 'CLIENT_HTTP_AUTHENTICATION' || error.code === 'CLIENT_HTTP_FORBIDDEN'))
      || error.name === 'UnauthorizedError') return { code: 'AUTH_REQUIRED', retryable: false };
  }
  for (const error of chain) {
    if (NETWORK_CODES.has(error.code)) return { code: error.code, retryable: true };
    if (!isSdkError(error)) continue;
    if (error.code === 'CONNECTION_CLOSED' || error.code === 'NOT_CONNECTED') {
      return { code: error.code, retryable: true };
    }
    const status = error.data?.status;
    if (status === 404) return { code: 'SESSION_EXPIRED', retryable: true };
    if (status === 429 || Number.isInteger(status) && status >= 500 && status <= 599) {
      return { code: `HTTP_${status}`, retryable: true };
    }
  }
}

/** Secret-free startup classification. Runtime owns cancellation and its special startup-timeout code. */
export function classifyConnectionError(error) {
  try { return structuredFailure(causes(error), true) ?? { code: 'START_FAILED', retryable: true }; }
  catch { return { code: 'START_FAILED', retryable: true }; }
}

/** Log wording and registration seams below have only been verified against this exact native release. */
export function supportsNativeBridge(nativePlugin, version) {
  return version === NATIVE_VERSION && nativePlugin?.name === 'mcp-client'
    && typeof nativePlugin.apply === 'function' && Array.isArray(nativePlugin.inject)
    && nativePlugin.inject.includes('tools');
}

// Copy descriptors, symbols, prototype and ALL definition fields (notably projectContent).
function replaceMethod(object, key, value) {
  const descriptors = Object.getOwnPropertyDescriptors(object);
  descriptors[key] = {
    value, enumerable: descriptors[key]?.enumerable ?? true,
    configurable: descriptors[key]?.configurable ?? true,
    writable: descriptors[key]?.writable ?? true,
  };
  return Object.create(Object.getPrototypeOf(object), descriptors);
}

/**
 * Adapt only registrations made through this plugin's child context. Services and the native
 * module remain untouched. `logger` is the caller's sink, not a pre-redacted native logger.
 * onEvent receives bounded {kind, code, retryable?} records, never errors or server payloads.
 */
export function createNativeAdapter(nativePlugin, { onEvent, logger, serverName } = {}) {
  return {
    ...nativePlugin,
    // Must remain async: Cordis constructs ordinary prototype-bearing plugin functions.
    async apply(ctx, config) {
      const name = serverName ?? config.serverName;
      const sink = logger ?? ctx.logger;
      const label = `mcp-client(${name})`;
      const lost = `${label}: connection lost and reconnect is disabled — registered tools will fail until an HMR reload or Host restart`;
      const failedClose = `${label}: failed generation could not confirm transport closure — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry`;
      const disposalClose = `${label}: transport closure could not be confirmed during disposal — server shutdown may be incomplete`;
      function emit(event) {
        // An observer must never replace the original exception or break native disposal.
        try { Promise.resolve(onEvent?.(event)).catch(() => {}); } catch {}
      }
      const safeLogger = Object.assign(() => safeLogger, Object.fromEntries(
        ['warn', 'error', 'info', 'debug'].map(level => [level, (...args) => {
          // Only the verified native error-level, single-string records carry lifecycle signals.
          if (level === 'error' && args.length === 1) {
            if (args[0] === lost) emit({ kind: 'disconnected', code: 'CONNECTION_LOST' });
            if (args[0] === failedClose || args[0] === disposalClose) {
              emit({ kind: 'unsafe-close', code: 'CLOSE_UNCONFIRMED' });
            }
          }
          sink[level](`workspace-mcp: native ${level} (${name}; details redacted)`);
        }]),
      ));
      function observe(object, key) {
        const method = object[key];
        return replaceMethod(object, key, async function (...args) {
          try { return await Reflect.apply(method, object, args); }
          catch (error) {
            try {
              const chain = causes(error);
              const cancelled = args[1]?.signal?.aborted || chain.some(item => item.name === 'AbortError');
              // A slow tool alone is not evidence that its connection is down.
              const timedOut = chain.some(item => isSdkError(item) && item.code === 'REQUEST_TIMEOUT');
              const failure = !cancelled && !timedOut && structuredFailure(chain, false);
              if (failure) emit({ kind: 'request-failed', ...failure });
            } catch { /* hostile error accessors must not mask the original exception */ }
            throw error;
          }
        });
      }
      function registrationProxy(service, wrapArguments) {
        if (!service) return service;
        // A plain facade deliberately carries no Cordis Service.tracker: re-tracing a service
        // proxy would change its receiver/effect owner. Every call targets the original service.
        return new Proxy(Object.create(null), {
          get(_target, key) {
            if (key === Symbol.for('cordis.tracker')) return undefined;
            const value = Reflect.get(service, key, service);
            if (key === 'register') return (...args) => Reflect.apply(value, service, wrapArguments(args));
            return typeof value === 'function' ? value.bind(service) : value;
          },
        });
      }
      const overlay = ctx.extend({
        logger: safeLogger,
        // Resolve against the actual accessing context, including native ctx.inject children.
        // Capturing ctx.mcpResources here would attach its effects to the wrong fiber.
        get tools() {
          return registrationProxy(this.get('tools'), ([definition, ...rest]) => [observe(definition, 'execute'), ...rest]);
        },
        get mcpResources() {
          return registrationProxy(this.get('mcpResources'), ([server, provider, ...rest]) => [server, observe(provider, 'request'), ...rest]);
        },
      });
      return await Reflect.apply(nativePlugin.apply, nativePlugin, [overlay, config]);
    },
  };
}
