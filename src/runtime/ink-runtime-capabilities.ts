export type InkRuntimeCapabilityFailureCategory =
  | 'api-unavailable'
  | 'blob-module-unavailable'
  | 'construct-failed'
  | 'context-unavailable'
  | 'module-load-failed'
  | 'needs-active-probe'
  | 'none'
  | 'not-isolated'
  | 'probe-failed'
  | 'probe-timeout'
  | 'transfer-failed'
  | 'validation-failed';

export type InkRuntimeCapabilityOutcome =
  | { readonly available: true; readonly failureCategory: 'none' }
  | {
      readonly available: false;
      readonly failureCategory: Exclude<InkRuntimeCapabilityFailureCategory, 'none'>;
    };

export interface InkRuntimeCapabilities {
  readonly crossOriginIsolated: InkRuntimeCapabilityOutcome;
  readonly dedicatedWorkerConstruct: InkRuntimeCapabilityOutcome;
  /** Module evaluation needs a bounded asynchronous worker handshake; this synchronous probe does not infer it. */
  readonly dedicatedWorkerModule: InkRuntimeCapabilityOutcome;
  readonly navigatorGpu: InkRuntimeCapabilityOutcome;
  readonly offscreenCanvas2d: InkRuntimeCapabilityOutcome;
  /** Confirms disposable `transferControlToOffscreen()` plus a local 2D context, not Worker receipt. */
  readonly offscreenCanvasTransfer: InkRuntimeCapabilityOutcome;
  readonly offscreenWebgl2: InkRuntimeCapabilityOutcome;
  readonly pointerPredictedEvents: InkRuntimeCapabilityOutcome;
  readonly sharedArrayBuffer: InkRuntimeCapabilityOutcome;
  readonly wasm: InkRuntimeCapabilityOutcome;
  readonly wasmSimd: InkRuntimeCapabilityOutcome;
  /** Worker rAF needs a bounded asynchronous worker handshake; Window rAF is never used as evidence. */
  readonly workerAnimationFrame: InkRuntimeCapabilityOutcome;
}

export interface InkActiveWorkerCapabilities {
  readonly dedicatedWorkerConstruct: InkRuntimeCapabilityOutcome;
  readonly dedicatedWorkerModule: InkRuntimeCapabilityOutcome;
  readonly workerAnimationFrame: InkRuntimeCapabilityOutcome;
}

export interface InkActiveWorkerProbeScheduler {
  cancel(handle: unknown): void;
  schedule(callback: () => void, delayMs: number): unknown;
}

export interface InkActiveWorkerProbeOptions {
  readonly host?: unknown;
  readonly scheduler?: InkActiveWorkerProbeScheduler;
  readonly timeoutMs?: number;
}

const ACTIVE_WORKER_MODULE_READY = 'inkstone:module-ready';
const ACTIVE_WORKER_RAF_READY = 'inkstone:worker-raf-ready';
const ACTIVE_WORKER_RAF_UNAVAILABLE = 'inkstone:worker-raf-unavailable';
const DEFAULT_ACTIVE_WORKER_TIMEOUT_MS = 1_000;
const MAX_ACTIVE_WORKER_TIMEOUT_MS = 5_000;
const ACTIVE_WORKER_SOURCE = `
self.postMessage('${ACTIVE_WORKER_MODULE_READY}');
if (typeof self.requestAnimationFrame !== 'function') {
  self.postMessage('${ACTIVE_WORKER_RAF_UNAVAILABLE}');
} else {
  self.requestAnimationFrame(() => self.postMessage('${ACTIVE_WORKER_RAF_READY}'));
}
export {};
`;

const DEFAULT_ACTIVE_WORKER_SCHEDULER: InkActiveWorkerProbeScheduler = Object.freeze({
  cancel: (handle: unknown) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  schedule: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
});

/**
 * Returns bounded, version-free runtime capability evidence.
 *
 * The probe never selects a rendering Adapter and never retains a Worker or GPU resource.
 */
export function probeInkRuntimeCapabilities(host: unknown = globalThis): InkRuntimeCapabilities {
  const runtime = asRecord(host);
  const offscreen2d = guardOutcome(() => probeOffscreenContext(runtime.OffscreenCanvas, '2d'));
  const offscreenTransfer = guardOutcome(() => probeOffscreenTransfer(runtime.document));
  const offscreenWebgl2 = guardOutcome(() =>
    probeOffscreenContext(runtime.OffscreenCanvas, 'webgl2'),
  );
  const wasm = guardWasmProbe(() => probeWasm(runtime.WebAssembly));
  const worker = guardWorkerProbe(() => probeWorker(runtime));
  return Object.freeze({
    crossOriginIsolated: guardOutcome(() => probeCrossOriginIsolation(runtime)),
    dedicatedWorkerConstruct: worker.construct,
    dedicatedWorkerModule: worker.module,
    navigatorGpu: probeNavigatorGpu(runtime),
    offscreenCanvas2d: offscreen2d,
    offscreenCanvasTransfer: offscreenTransfer,
    offscreenWebgl2,
    pointerPredictedEvents: guardOutcome(() => probePointerPredictedEvents(runtime)),
    sharedArrayBuffer: guardOutcome(() =>
      typeof runtime.SharedArrayBuffer === 'function'
        ? available()
        : unavailable('api-unavailable'),
    ),
    wasm: wasm.core,
    wasmSimd: wasm.simd,
    workerAnimationFrame: worker.animationFrame,
  });
}

function probePointerPredictedEvents(
  runtime: Record<PropertyKey, unknown>,
): InkRuntimeCapabilityOutcome {
  const constructor = runtime.PointerEvent;
  if (typeof constructor !== 'function') return unavailable('api-unavailable');
  const prototype = asRecord(asRecord(constructor).prototype);
  return typeof prototype.getPredictedEvents === 'function'
    ? available()
    : unavailable('api-unavailable');
}

/**
 * Actively proves Blob module evaluation and Worker rAF with one bounded, disposable Worker.
 * The result is evidence only; it never selects a rendering Adapter.
 */
export function probeActiveInkWorkerCapabilities(
  input: InkActiveWorkerProbeOptions = {},
): Promise<InkActiveWorkerCapabilities> {
  const runtime = asRecord(input.host ?? globalThis);
  const scheduler = input.scheduler ?? DEFAULT_ACTIVE_WORKER_SCHEDULER;
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const workerConstructor = runtime.Worker;
  if (typeof workerConstructor !== 'function') {
    return Promise.resolve(activeWorkerResult(unavailable('api-unavailable')));
  }
  const blobConstructor = runtime.Blob;
  const urlApi = asRecord(runtime.URL);
  const createObjectURL = urlApi.createObjectURL;
  const revokeObjectURL = urlApi.revokeObjectURL;
  if (
    typeof blobConstructor !== 'function' ||
    typeof createObjectURL !== 'function' ||
    typeof revokeObjectURL !== 'function'
  ) {
    return Promise.resolve(blobModuleUnavailableResult());
  }

  let objectUrl: unknown;
  try {
    const blob = Reflect.construct(blobConstructor, [
      [ACTIVE_WORKER_SOURCE],
      { type: 'text/javascript' },
    ]) as unknown;
    objectUrl = Reflect.apply(createObjectURL, runtime.URL, [blob]) as unknown;
    if (typeof objectUrl !== 'string') {
      return Promise.resolve(blobModuleUnavailableResult());
    }
  } catch {
    return Promise.resolve(blobModuleUnavailableResult());
  }

  let worker: unknown;
  try {
    worker = Reflect.construct(workerConstructor, [objectUrl, { type: 'module' }]) as unknown;
  } catch {
    const revoked = safeRevokeObjectUrl(revokeObjectURL, runtime.URL, objectUrl);
    return Promise.resolve(
      activeWorkerResult(unavailable(revoked ? 'construct-failed' : 'probe-failed')),
    );
  }

  const objectUrlValue = objectUrl;
  const workerValue = worker;
  return new Promise((resolve) => {
    let moduleReady = false;
    let settled = false;
    let timeoutHandle: unknown;
    let timeoutScheduled = false;

    const settle = (
      moduleOutcome: InkRuntimeCapabilityOutcome,
      animationFrameOutcome: InkRuntimeCapabilityOutcome,
    ): void => {
      if (settled) return;
      settled = true;
      let cleanupFailed = false;
      if (timeoutScheduled) {
        try {
          scheduler.cancel(timeoutHandle);
        } catch {
          cleanupFailed = true;
        }
      }
      const workerRecord = asRecord(workerValue);
      try {
        workerRecord.onmessage = null;
        workerRecord.onerror = null;
      } catch {
        cleanupFailed = true;
      }
      try {
        const terminate = workerRecord.terminate;
        if (typeof terminate !== 'function') cleanupFailed = true;
        else Reflect.apply(terminate, workerValue, []);
      } catch {
        cleanupFailed = true;
      }
      if (!safeRevokeObjectUrl(revokeObjectURL, runtime.URL, objectUrlValue)) {
        cleanupFailed = true;
      }
      if (cleanupFailed) {
        resolve(activeWorkerResult(unavailable('probe-failed')));
        return;
      }
      resolve(
        Object.freeze({
          dedicatedWorkerConstruct: available(),
          dedicatedWorkerModule: moduleOutcome,
          workerAnimationFrame: animationFrameOutcome,
        }),
      );
    };

    const workerRecord = asRecord(workerValue);
    try {
      workerRecord.onmessage = (event: unknown) => {
        const data = asRecord(event).data;
        if (data === ACTIVE_WORKER_MODULE_READY) {
          moduleReady = true;
          return;
        }
        if (data === ACTIVE_WORKER_RAF_READY) {
          if (!moduleReady) {
            settle(unavailable('probe-failed'), unavailable('probe-failed'));
          } else {
            settle(available(), available());
          }
          return;
        }
        if (data === ACTIVE_WORKER_RAF_UNAVAILABLE) {
          if (!moduleReady) {
            settle(unavailable('probe-failed'), unavailable('probe-failed'));
          } else {
            settle(available(), unavailable('api-unavailable'));
          }
        }
      };
      workerRecord.onerror = (event: unknown) => {
        preventDefault(event);
        settle(
          moduleReady ? available() : unavailable('module-load-failed'),
          unavailable('module-load-failed'),
        );
      };
      timeoutHandle = scheduler.schedule(() => {
        settle(
          moduleReady ? available() : unavailable('probe-timeout'),
          unavailable('probe-timeout'),
        );
      }, timeoutMs);
      timeoutScheduled = true;
    } catch {
      settle(unavailable('probe-failed'), unavailable('probe-failed'));
    }
  });
}

function activeWorkerResult(outcome: InkRuntimeCapabilityOutcome): InkActiveWorkerCapabilities {
  return Object.freeze({
    dedicatedWorkerConstruct: outcome,
    dedicatedWorkerModule: outcome,
    workerAnimationFrame: outcome,
  });
}

function blobModuleUnavailableResult(): InkActiveWorkerCapabilities {
  const unavailableBlobModule = unavailable('blob-module-unavailable');
  return Object.freeze({
    dedicatedWorkerConstruct: unavailable('needs-active-probe'),
    dedicatedWorkerModule: unavailableBlobModule,
    workerAnimationFrame: unavailableBlobModule,
  });
}

function boundedTimeout(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_ACTIVE_WORKER_TIMEOUT_MS;
  return Math.min(MAX_ACTIVE_WORKER_TIMEOUT_MS, Math.max(1, Math.round(timeoutMs ?? 0)));
}

function preventDefault(event: unknown): void {
  try {
    const callback = asRecord(event).preventDefault;
    if (typeof callback === 'function') Reflect.apply(callback, event, []);
  } catch {
    // Error details remain outside the privacy-safe capability result.
  }
}

function safeRevokeObjectUrl(revoke: unknown, owner: unknown, objectUrl: string): boolean {
  if (typeof revoke !== 'function') return false;
  try {
    Reflect.apply(revoke, owner, [objectUrl]);
    return true;
  } catch {
    return false;
  }
}

function probeCrossOriginIsolation(
  runtime: Record<PropertyKey, unknown>,
): InkRuntimeCapabilityOutcome {
  if (!('crossOriginIsolated' in runtime)) return unavailable('api-unavailable');
  return runtime.crossOriginIsolated === true ? available() : unavailable('not-isolated');
}

function guardOutcome(probe: () => InkRuntimeCapabilityOutcome): InkRuntimeCapabilityOutcome {
  try {
    return probe();
  } catch {
    return unavailable('probe-failed');
  }
}

function guardWasmProbe(probe: () => ReturnType<typeof probeWasm>): ReturnType<typeof probeWasm> {
  try {
    return probe();
  } catch {
    const failed = unavailable('probe-failed');
    return { core: failed, simd: failed };
  }
}

function guardWorkerProbe(
  probe: () => ReturnType<typeof probeWorker>,
): ReturnType<typeof probeWorker> {
  try {
    return probe();
  } catch {
    const failed = unavailable('probe-failed');
    return { animationFrame: failed, construct: failed, module: failed };
  }
}

function probeNavigatorGpu(runtime: Record<PropertyKey, unknown>): InkRuntimeCapabilityOutcome {
  try {
    const gpu = asRecord(runtime.navigator).gpu;
    return gpu === undefined || gpu === null ? unavailable('api-unavailable') : available();
  } catch {
    return unavailable('probe-failed');
  }
}

function probeWorker(runtime: Record<PropertyKey, unknown>): {
  readonly animationFrame: InkRuntimeCapabilityOutcome;
  readonly construct: InkRuntimeCapabilityOutcome;
  readonly module: InkRuntimeCapabilityOutcome;
} {
  const workerConstructor = runtime.Worker;
  if (typeof workerConstructor !== 'function') {
    const missing = unavailable('api-unavailable');
    return { animationFrame: missing, construct: missing, module: missing };
  }

  const activeProbeRequired = unavailable('needs-active-probe');
  const blobConstructor = runtime.Blob;
  const urlApi = asRecord(runtime.URL);
  const createObjectURL = urlApi.createObjectURL;
  const revokeObjectURL = urlApi.revokeObjectURL;
  const prototypeTerminate = asRecord(asRecord(workerConstructor).prototype).terminate;
  if (
    typeof blobConstructor !== 'function' ||
    typeof createObjectURL !== 'function' ||
    typeof revokeObjectURL !== 'function' ||
    typeof prototypeTerminate !== 'function'
  ) {
    return {
      animationFrame: activeProbeRequired,
      construct: activeProbeRequired,
      module: activeProbeRequired,
    };
  }

  let objectUrl: unknown;
  let worker: unknown;
  let construct: InkRuntimeCapabilityOutcome;
  try {
    const blob = Reflect.construct(blobConstructor, [[''], { type: 'text/javascript' }]) as unknown;
    objectUrl = Reflect.apply(createObjectURL, runtime.URL, [blob]) as unknown;
    if (typeof objectUrl !== 'string') {
      construct = unavailable('probe-failed');
    } else {
      worker = Reflect.construct(workerConstructor, [objectUrl]) as unknown;
      construct = available();
    }
  } catch {
    construct = unavailable('construct-failed');
  } finally {
    if (worker !== undefined) {
      try {
        Reflect.apply(prototypeTerminate, worker, []);
      } catch {
        construct = unavailable('probe-failed');
      }
    }
    if (typeof objectUrl === 'string') {
      try {
        Reflect.apply(revokeObjectURL, runtime.URL, [objectUrl]);
      } catch {
        construct = unavailable('probe-failed');
      }
    }
  }

  return {
    animationFrame: activeProbeRequired,
    construct,
    module: activeProbeRequired,
  };
}

function probeOffscreenTransfer(value: unknown): InkRuntimeCapabilityOutcome {
  const document = asRecord(value);
  const createElement = document.createElement;
  if (typeof createElement !== 'function') return unavailable('api-unavailable');
  let canvas: unknown;
  try {
    canvas = Reflect.apply(createElement, value, ['canvas']) as unknown;
  } catch {
    return unavailable('construct-failed');
  }
  const transfer = asRecord(canvas).transferControlToOffscreen;
  if (typeof transfer !== 'function') return unavailable('api-unavailable');
  let offscreen: unknown;
  try {
    offscreen = Reflect.apply(transfer, canvas, []) as unknown;
  } catch {
    return unavailable('transfer-failed');
  }
  const getContext = asRecord(offscreen).getContext;
  if (typeof getContext !== 'function') return unavailable('context-unavailable');
  try {
    const context = Reflect.apply(getContext, offscreen, ['2d']) as unknown;
    return context === null || context === undefined
      ? unavailable('context-unavailable')
      : available();
  } catch {
    return unavailable('probe-failed');
  }
}

function probeOffscreenContext(
  constructor: unknown,
  kind: '2d' | 'webgl2',
): InkRuntimeCapabilityOutcome {
  if (typeof constructor !== 'function') return unavailable('api-unavailable');
  let canvas: unknown;
  try {
    canvas = Reflect.construct(constructor, [1, 1]) as unknown;
  } catch {
    return unavailable('construct-failed');
  }
  const getContext = asRecord(canvas).getContext;
  if (typeof getContext !== 'function') return unavailable('context-unavailable');
  try {
    const context = Reflect.apply(getContext, canvas, [kind]) as unknown;
    if (context === null || context === undefined) return unavailable('context-unavailable');
    if (kind === 'webgl2') releaseWebglContext(context);
    return available();
  } catch {
    return unavailable('probe-failed');
  }
}

function releaseWebglContext(context: unknown): void {
  try {
    const getExtension = asRecord(context).getExtension;
    if (typeof getExtension !== 'function') return;
    const extension = Reflect.apply(getExtension, context, ['WEBGL_lose_context']) as unknown;
    const loseContext = asRecord(extension).loseContext;
    if (typeof loseContext === 'function') Reflect.apply(loseContext, extension, []);
  } catch {
    // Releasing a disposable probe context is best-effort and does not change support evidence.
  }
}

function probeWasm(value: unknown): {
  readonly core: InkRuntimeCapabilityOutcome;
  readonly simd: InkRuntimeCapabilityOutcome;
} {
  const webAssembly = asRecord(value);
  const validate = webAssembly.validate;
  if (typeof validate !== 'function') {
    return {
      core: unavailable('api-unavailable'),
      simd: unavailable('api-unavailable'),
    };
  }
  try {
    const core = Reflect.apply(validate, value, [
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    ]) as unknown;
    const simd = Reflect.apply(validate, value, [
      new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
        0x03, 0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62,
        0x0b,
      ]),
    ]) as unknown;
    return {
      core: core === true ? available() : unavailable('validation-failed'),
      simd: simd === true ? available() : unavailable('validation-failed'),
    };
  } catch {
    return {
      core: unavailable('probe-failed'),
      simd: unavailable('probe-failed'),
    };
  }
}

function asRecord(value: unknown): Record<PropertyKey, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? (value as Record<PropertyKey, unknown>)
    : (Object.create(null) as Record<PropertyKey, unknown>);
}

function available(): InkRuntimeCapabilityOutcome {
  return Object.freeze({ available: true, failureCategory: 'none' });
}

function unavailable(
  failureCategory: Exclude<InkRuntimeCapabilityFailureCategory, 'none'>,
): InkRuntimeCapabilityOutcome {
  return Object.freeze({ available: false, failureCategory });
}
