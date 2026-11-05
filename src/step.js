/**
 * DSH 0.2.2 admits tools before prompt assembly. Its assembly waterfall only
 * owns text: changing assembly.tools is both too late and no longer supported.
 * There is no pre-admission event, so bridge resolve() for this plugin's agents
 * only, retaining the native receiver, arguments, selection and cancellation.
 */
export function installToolPreparation(ctx, prepare) {
  const service = ctx.tools[Symbol.for('cordis.original')] ?? ctx.tools;
  if (typeof service.resolve !== 'function') return false; // Legacy Host.
  ctx.effect(() => {
    const descriptor = Object.getOwnPropertyDescriptor(service, 'resolve');
    const original = service.resolve;
    let active = true;
    async function resolve(context, ...rest) {
      if (active) await prepare(context);
      return Reflect.apply(original, this, [context, ...rest]);
    }
    Object.defineProperty(service, 'resolve', {
      configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false,
      value: resolve,
    });
    return () => {
      active = false;
      // Do not overwrite another plugin's later wrapper. If it retained ours,
      // that retained wrapper becomes a transparent pass-through after unload.
      if (service.resolve !== resolve) return;
      if (descriptor) Object.defineProperty(service, 'resolve', descriptor);
      else delete service.resolve;
    };
  }, 'workspace-mcp: prepare before tool admission');
  return true;
}
