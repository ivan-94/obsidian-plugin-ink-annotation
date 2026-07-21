import {
  INK_TILE_WORKER_DIGEST,
  INK_TILE_WORKER_PROTOCOL_VERSION,
  INK_TILE_WORKER_SOURCE,
} from './ink-tile-worker-artifact';

export type InkTileWorkerProbeFailure =
  | 'artifact-unavailable'
  | 'construct-failed'
  | 'presenter-unavailable'
  | 'probe-timeout'
  | 'protocol-mismatch'
  | 'raster-validation-failed'
  | 'transfer-failed';

export type InkTileWorkerProbeResult =
  | {
      readonly artifactDigest: string;
      readonly capabilities: {
        readonly highlighterRaster: true;
        readonly imageBitmapTransfer: true;
        readonly offscreenCanvas2d: true;
        readonly penRaster: true;
        readonly presenterAdoption: true;
      };
      readonly kind: 'ready';
    }
  | {
      readonly artifactDigest: string;
      readonly failure: InkTileWorkerProbeFailure;
      readonly kind: 'unavailable';
    };

export interface InkTileWorkerProbeScheduler {
  cancel(handle: unknown): void;
  schedule(callback: () => void, delayMs: number): unknown;
}

interface WorkerLike {
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

interface ProbeBitmapLike {
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 1_000;
const MAXIMUM_TIMEOUT_MS = 5_000;
const DEFAULT_SCHEDULER: InkTileWorkerProbeScheduler = Object.freeze({
  cancel: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
});
let nextProbeId = 0;

/**
 * Proves the exact embedded Tile Worker artifact through worker-local physical Brush raster,
 * transferable ImageBitmap presentation, alpha inspection, and terminal cleanup.
 */
export function probeInkTileWorkerProductionArtifact(
  input: {
    readonly artifact?: { readonly digest: string; readonly source: string };
    readonly document?: Document;
    readonly host?: unknown;
    readonly scheduler?: InkTileWorkerProbeScheduler;
    readonly timeoutMs?: number;
  } = {},
): Promise<InkTileWorkerProbeResult> {
  const artifact = input.artifact ?? {
    digest: INK_TILE_WORKER_DIGEST,
    source: INK_TILE_WORKER_SOURCE,
  };
  if (artifact.source.length === 0 || !/^[a-f0-9]{64}$/u.test(artifact.digest)) {
    return Promise.resolve(unavailable(artifact.digest, 'artifact-unavailable'));
  }
  const runtime = asRecord(input.host ?? globalThis);
  const workerResource = constructWorker(runtime, artifact.source);
  if (workerResource === null) {
    return Promise.resolve(unavailable(artifact.digest, 'construct-failed'));
  }
  const document = input.document ?? globalThis.document;
  const scheduler = input.scheduler ?? DEFAULT_SCHEDULER;
  const timeoutMs = boundedTimeout(input.timeoutMs);
  nextProbeId += 1;
  const requestId = `tile-probe-${nextProbeId}`;

  return new Promise((resolve) => {
    let settled = false;
    let timeoutHandle: unknown;
    let timeoutScheduled = false;
    const { worker } = workerResource;

    const settle = (result: InkTileWorkerProbeResult, bitmap?: ProbeBitmapLike): void => {
      if (settled) {
        safeClose(bitmap);
        return;
      }
      settled = true;
      safeClose(bitmap);
      if (timeoutScheduled) {
        try {
          scheduler.cancel(timeoutHandle);
        } catch {
          // The Worker epoch is terminal even when a host timer closer fails.
        }
      }
      clearWorkerHandlers(worker);
      safeTerminate(worker);
      resolve(result);
    };

    worker.onmessage = ({ data }) => {
      const message = asRecord(data);
      const bitmap = bitmapLike(message.bitmap);
      if (
        message.type !== 'probe-result' ||
        message.requestId !== requestId ||
        message.protocolVersion !== INK_TILE_WORKER_PROTOCOL_VERSION ||
        message.width !== 64 ||
        message.height !== 32
      ) {
        settle(unavailable(artifact.digest, 'protocol-mismatch'), bitmap ?? undefined);
        return;
      }
      if (bitmap === null) {
        settle(unavailable(artifact.digest, 'transfer-failed'));
        return;
      }
      const validation = validatePresentedProbe(document, bitmap, 64, 32);
      if (validation === 'presenter-unavailable') {
        settle(unavailable(artifact.digest, validation), bitmap);
        return;
      }
      if (validation === 'raster-validation-failed') {
        settle(unavailable(artifact.digest, validation), bitmap);
        return;
      }
      settle(
        Object.freeze({
          artifactDigest: artifact.digest,
          capabilities: Object.freeze({
            highlighterRaster: true,
            imageBitmapTransfer: true,
            offscreenCanvas2d: true,
            penRaster: true,
            presenterAdoption: true,
          }),
          kind: 'ready',
        }),
        bitmap,
      );
    };
    worker.onerror = (event) => {
      preventDefault(event);
      settle(unavailable(artifact.digest, 'raster-validation-failed'));
    };
    worker.onmessageerror = () => {
      settle(unavailable(artifact.digest, 'protocol-mismatch'));
    };

    try {
      timeoutHandle = scheduler.schedule(
        () => settle(unavailable(artifact.digest, 'probe-timeout')),
        timeoutMs,
      );
      timeoutScheduled = true;
      worker.postMessage({
        protocolVersion: INK_TILE_WORKER_PROTOCOL_VERSION,
        requestId,
        type: 'probe',
      });
    } catch {
      settle(unavailable(artifact.digest, 'construct-failed'));
    }
  });
}

function constructWorker(
  runtime: Readonly<Record<PropertyKey, unknown>>,
  source: string,
): { readonly worker: WorkerLike } | null {
  const WorkerConstructor = runtime.Worker;
  const BlobConstructor = runtime.Blob;
  const urlApi = asRecord(runtime.URL);
  const createObjectURL = urlApi.createObjectURL;
  const revokeObjectURL = urlApi.revokeObjectURL;
  if (
    typeof WorkerConstructor !== 'function' ||
    typeof BlobConstructor !== 'function' ||
    typeof createObjectURL !== 'function' ||
    typeof revokeObjectURL !== 'function'
  ) {
    return null;
  }
  let objectUrl: unknown;
  try {
    const blob = Reflect.construct(BlobConstructor, [
      [source],
      { type: 'text/javascript' },
    ]) as unknown;
    objectUrl = Reflect.apply(createObjectURL, runtime.URL, [blob]);
    if (typeof objectUrl !== 'string') return null;
    const worker = Reflect.construct(WorkerConstructor, [objectUrl]) as WorkerLike;
    try {
      Reflect.apply(revokeObjectURL, runtime.URL, [objectUrl]);
    } catch {
      safeTerminate(worker);
      return null;
    }
    return Object.freeze({ worker });
  } catch {
    if (typeof objectUrl === 'string') {
      try {
        Reflect.apply(revokeObjectURL, runtime.URL, [objectUrl]);
      } catch {
        // Construction already failed closed.
      }
    }
    return null;
  }
}

function validatePresentedProbe(
  document: Document | undefined,
  bitmap: ProbeBitmapLike,
  width: number,
  height: number,
): 'presenter-unavailable' | 'raster-validation-failed' | 'valid' {
  if (document === undefined) return 'presenter-unavailable';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) return 'presenter-unavailable';
    context.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    if (pixels.length !== width * height * 4) return 'raster-validation-failed';
    let penMaximumAlpha = 0;
    let highlighterMaximumAlpha = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const alpha = pixels[(y * width + x) * 4 + 3] ?? 0;
        if (x < width / 2) penMaximumAlpha = Math.max(penMaximumAlpha, alpha);
        else highlighterMaximumAlpha = Math.max(highlighterMaximumAlpha, alpha);
      }
    }
    return penMaximumAlpha > 0 &&
      highlighterMaximumAlpha > 0 &&
      highlighterMaximumAlpha < penMaximumAlpha
      ? 'valid'
      : 'raster-validation-failed';
  } catch {
    return 'presenter-unavailable';
  }
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAXIMUM_TIMEOUT_MS, Math.max(1, Math.round(value)));
}

function bitmapLike(value: unknown): ProbeBitmapLike | null {
  const close = asRecord(value).close;
  return typeof close === 'function' ? (value as ProbeBitmapLike) : null;
}

function unavailable(
  artifactDigest: string,
  failure: InkTileWorkerProbeFailure,
): InkTileWorkerProbeResult {
  return Object.freeze({ artifactDigest, failure, kind: 'unavailable' });
}

function asRecord(value: unknown): Readonly<Record<PropertyKey, unknown>> {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<PropertyKey, unknown>>)
    : Object.freeze({});
}

function clearWorkerHandlers(worker: WorkerLike): void {
  try {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
  } catch {
    // Termination remains authoritative.
  }
}

function safeTerminate(worker: WorkerLike): void {
  try {
    worker.terminate();
  } catch {
    // The Worker is already fenced and cannot publish through cleared handlers.
  }
}

function safeClose(bitmap: ProbeBitmapLike | undefined): void {
  if (bitmap === undefined) return;
  try {
    bitmap.close();
  } catch {
    // A transferred probe bitmap may already have been closed by the presenter.
  }
}

function preventDefault(event: unknown): void {
  const prevent = asRecord(event).preventDefault;
  if (typeof prevent !== 'function') return;
  try {
    Reflect.apply(prevent, event, []);
  } catch {
    // Error detail is intentionally suppressed from capability evidence.
  }
}
