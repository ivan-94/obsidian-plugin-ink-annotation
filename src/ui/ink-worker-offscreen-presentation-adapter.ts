import {
  INK_WORKER_FRAME_HEADER_BYTES,
  INK_WORKER_MAX_PROVISIONAL_POINTS,
  decodeInkWorkerFrame,
  encodeInkWorkerFrame,
  validateInkWorkerFrameAck,
} from '../runtime/ink-worker-protocol';
import { InkTransferBufferPool } from '../runtime/ink-transfer-buffer-pool';

export const INK_OFFSCREEN_WORKER_SOURCE_MARKER = 'inkstone-offscreen-worker-v1';

export type InkWorkerPresentationFailureCategory =
  | 'api-unavailable'
  | 'backpressured'
  | 'construct-failed'
  | 'context-unavailable'
  | 'handshake-timeout'
  | 'message-error'
  | 'post-message-failed'
  | 'protocol-failed'
  | 'transfer-failed';

export interface InkWorkerPresentationAck {
  readonly contactSequence: number;
  readonly frameEpoch: number;
  readonly generation: number;
  readonly packetSequence: number;
}

export interface InkWorkerXYPath {
  readonly length: number;
  at(index: number): Readonly<{ x: number; y: number }> | undefined;
}

export interface InkWorkerPresentationFrameConfig {
  readonly backingHeight: number;
  readonly backingWidth: number;
  readonly frameEpoch: number;
  readonly transform: readonly [number, number, number, number, number, number];
}

export interface InkWorkerPresentationContactConfig {
  readonly color: string;
  readonly contactSequence: number;
  readonly eraserColor?: string;
  readonly opacity: number;
  readonly startPoint?: Readonly<{ x: number; y: number }>;
  readonly tool: 'eraser' | 'highlighter' | 'pen';
  readonly width: number;
}

export interface InkWorkerPresentationSubmission {
  readonly generation: number;
  readonly provisionalPoints?: InkWorkerXYPath;
  readonly stablePoints: InkWorkerXYPath;
  readonly stableStart: number;
  readonly tailPoints: InkWorkerXYPath;
}

export type InkWorkerPresentationSubmitResult =
  | {
      readonly kind: 'submitted-async';
      readonly packetSequence: number;
      readonly submittedSegmentCount: number;
    }
  | { readonly kind: 'backpressured' | 'unavailable' };

export type InkWorkerPresentationActivationResult =
  | { readonly adapter: InkWorkerOffscreenPresentationAdapter; readonly kind: 'ready' }
  | {
      readonly failureCategory: InkWorkerPresentationFailureCategory;
      readonly kind: 'unavailable';
    };

export interface InkWorkerPresentationActivation {
  readonly canvases: {
    readonly stable: HTMLCanvasElement;
    readonly tail: HTMLCanvasElement;
  };
  cancel(): void;
  readonly result: Promise<InkWorkerPresentationActivationResult>;
}

export interface InkWorkerPreparedPresentation {
  activate(): InkWorkerPresentationActivation;
  dispose(): void;
}

export type InkWorkerPresentationPreparation =
  | { readonly kind: 'ready'; readonly prepared: InkWorkerPreparedPresentation }
  | {
      readonly failureCategory: InkWorkerPresentationFailureCategory;
      readonly kind: 'unavailable';
    };

export interface InkWorkerProbeScheduler {
  cancel(handle: unknown): void;
  schedule(callback: () => void, delayMs: number): unknown;
}

interface WorkerLike {
  onerror: ((event: unknown) => unknown) | null;
  onmessage: ((event: { readonly data: unknown }) => unknown) | null;
  onmessageerror: ((event: unknown) => unknown) | null;
  postMessage(message: Record<string, unknown>, transfer?: readonly unknown[]): void;
  terminate(): void;
}

interface InFlightFrame {
  readonly bufferId: number;
  readonly contactSequence: number;
  readonly frameEpoch: number;
  readonly generation: number;
  readonly leaseSequence: number;
  readonly packetSequence: number;
}

const DEFAULT_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 5_000;
const INITIAL_BUFFER_BYTES = 16 * 1024;
const MAXIMUM_BUFFER_BYTES = 4 * 1024 * 1024;
const UINT32_MAX = 0xffff_ffff;
const PROBE_BYTES = 64;
const PROBE_MAGIC = 0x494e4b50;
const EMPTY_XY_PATH: InkWorkerXYPath = Object.freeze({
  at: () => undefined,
  length: 0,
});
let nextSessionEpoch = 1;

const DEFAULT_SCHEDULER: InkWorkerProbeScheduler = Object.freeze({
  cancel: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
});

/**
 * Prewarms one bounded classic Worker without creating Canvas stores. The caller activates the
 * prepared Worker only at an idle cutover after retiring the main-thread pair.
 */
export function prepareInkWorkerOffscreenPresentationAdapter(input: {
  readonly document: Document;
  readonly host?: unknown;
  readonly onAck: (ack: InkWorkerPresentationAck) => void;
  readonly onFault: (failure: InkWorkerPresentationFailureCategory) => void;
  readonly scheduler?: InkWorkerProbeScheduler;
  readonly sessionEpoch?: number;
  readonly timeoutMs?: number;
}): Promise<InkWorkerPresentationPreparation> {
  const runtime = asRecord(input.host ?? globalThis);
  const scheduler = input.scheduler ?? DEFAULT_SCHEDULER;
  const session = input.sessionEpoch ?? allocateSessionEpoch();
  assertPositiveUint32(session, 'Ink Worker session epoch');
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const workerResource = createWorker(runtime);
  if (workerResource === null) return Promise.resolve(unavailable('api-unavailable'));
  if (workerResource.kind === 'failed') return Promise.resolve(unavailable(workerResource.failure));
  const { revoke, worker } = workerResource;

  const probeBuffer = new ArrayBuffer(PROBE_BYTES);
  new DataView(probeBuffer).setUint32(0, PROBE_MAGIC, true);
  return new Promise((resolve) => {
    let settled = false;
    let timeoutHandle: unknown;
    let timeoutScheduled = false;
    const settleUnavailable = (failure: InkWorkerPresentationFailureCategory): void => {
      if (settled) return;
      settled = true;
      if (timeoutScheduled) safeCancel(scheduler, timeoutHandle);
      clearWorkerHandlers(worker);
      safeTerminate(worker);
      revoke();
      resolve(unavailable(failure));
    };
    const settleReady = (): void => {
      if (settled) return;
      settled = true;
      if (timeoutScheduled) safeCancel(scheduler, timeoutHandle);
      revoke();
      const prepared = new PreparedInkWorkerOffscreenPresentation({
        document: input.document,
        onAck: input.onAck,
        onFault: input.onFault,
        scheduler,
        session,
        timeoutMs,
        worker,
      });
      resolve(Object.freeze({ kind: 'ready', prepared }));
    };

    worker.onmessage = ({ data }) => {
      const message = asRecord(data);
      if (
        message.type !== 'ink-worker-prewarmed' ||
        message.session !== session ||
        !(message.probeBuffer instanceof ArrayBuffer) ||
        message.probeBuffer.byteLength < 4 ||
        new DataView(message.probeBuffer).getUint32(0, true) !== PROBE_MAGIC
      ) {
        settleUnavailable('protocol-failed');
        return;
      }
      settleReady();
    };
    worker.onerror = (event) => {
      preventDefault(event);
      settleUnavailable('context-unavailable');
    };
    worker.onmessageerror = (event) => {
      preventDefault(event);
      settleUnavailable('message-error');
    };
    try {
      timeoutHandle = scheduler.schedule(() => settleUnavailable('handshake-timeout'), timeoutMs);
      timeoutScheduled = true;
      worker.postMessage(
        {
          marker: INK_OFFSCREEN_WORKER_SOURCE_MARKER,
          probeBuffer,
          session,
          type: 'ink-worker-prewarm',
        },
        [probeBuffer],
      );
    } catch {
      settleUnavailable('post-message-failed');
    }
  });
}

class PreparedInkWorkerOffscreenPresentation implements InkWorkerPreparedPresentation {
  private activated = false;
  private disposed = false;
  private readonly document: Document;
  private readonly onAck: (ack: InkWorkerPresentationAck) => void;
  private readonly onFault: (failure: InkWorkerPresentationFailureCategory) => void;
  private readonly scheduler: InkWorkerProbeScheduler;
  private readonly session: number;
  private readonly timeoutMs: number;
  private readonly worker: WorkerLike;

  constructor(input: {
    readonly document: Document;
    readonly onAck: (ack: InkWorkerPresentationAck) => void;
    readonly onFault: (failure: InkWorkerPresentationFailureCategory) => void;
    readonly scheduler: InkWorkerProbeScheduler;
    readonly session: number;
    readonly timeoutMs: number;
    readonly worker: WorkerLike;
  }) {
    this.document = input.document;
    this.onAck = input.onAck;
    this.onFault = input.onFault;
    this.scheduler = input.scheduler;
    this.session = input.session;
    this.timeoutMs = input.timeoutMs;
    this.worker = input.worker;
  }

  activate(): InkWorkerPresentationActivation {
    if (this.disposed || this.activated) {
      throw new Error('Ink Worker prewarm can be activated only once.');
    }
    this.activated = true;
    const stable = createWorkerCanvas(this.document, 'stable');
    const tail = createWorkerCanvas(this.document, 'tail');
    const canvases = Object.freeze({ stable, tail });
    const stableOffscreen = transferCanvas(stable);
    const tailOffscreen = transferCanvas(tail);
    if (stableOffscreen === null || tailOffscreen === null) {
      this.disposed = true;
      clearWorkerHandlers(this.worker);
      safeTerminate(this.worker);
      return Object.freeze({
        cancel: () => undefined,
        canvases,
        result: Promise.resolve(unavailableActivation('transfer-failed')),
      });
    }

    const probeBuffer = new ArrayBuffer(PROBE_BYTES);
    new DataView(probeBuffer).setUint32(0, PROBE_MAGIC, true);
    let cancel = (): void => undefined;
    const result = new Promise<InkWorkerPresentationActivationResult>((resolve) => {
      let settled = false;
      let timeoutHandle: unknown;
      let timeoutScheduled = false;
      const settleUnavailable = (failure: InkWorkerPresentationFailureCategory): void => {
        if (settled) return;
        settled = true;
        this.disposed = true;
        if (timeoutScheduled) safeCancel(this.scheduler, timeoutHandle);
        clearWorkerHandlers(this.worker);
        safeTerminate(this.worker);
        resolve(unavailableActivation(failure));
      };
      const settleReady = (): void => {
        if (settled) return;
        settled = true;
        if (timeoutScheduled) safeCancel(this.scheduler, timeoutHandle);
        const adapter = new InkWorkerOffscreenPresentationAdapter({
          canvases,
          onAck: this.onAck,
          onFault: this.onFault,
          session: this.session,
          worker: this.worker,
        });
        resolve(Object.freeze({ adapter, kind: 'ready' }));
      };
      cancel = () => settleUnavailable('context-unavailable');
      this.worker.onmessage = ({ data }) => {
        const message = asRecord(data);
        if (
          message.type !== 'ink-worker-ready' ||
          message.session !== this.session ||
          !(message.probeBuffer instanceof ArrayBuffer) ||
          message.probeBuffer.byteLength < 4 ||
          new DataView(message.probeBuffer).getUint32(0, true) !== PROBE_MAGIC
        ) {
          settleUnavailable('protocol-failed');
          return;
        }
        settleReady();
      };
      this.worker.onerror = (event) => {
        preventDefault(event);
        settleUnavailable('context-unavailable');
      };
      this.worker.onmessageerror = (event) => {
        preventDefault(event);
        settleUnavailable('message-error');
      };
      try {
        timeoutHandle = this.scheduler.schedule(
          () => settleUnavailable('handshake-timeout'),
          this.timeoutMs,
        );
        timeoutScheduled = true;
        this.worker.postMessage(
          {
            marker: INK_OFFSCREEN_WORKER_SOURCE_MARKER,
            probeBuffer,
            session: this.session,
            stableCanvas: stableOffscreen,
            tailCanvas: tailOffscreen,
            type: 'ink-worker-init',
          },
          [stableOffscreen, tailOffscreen, probeBuffer],
        );
      } catch {
        settleUnavailable('post-message-failed');
      }
    });
    return Object.freeze({ cancel: () => cancel(), canvases, result });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearWorkerHandlers(this.worker);
    safeTerminate(this.worker);
  }
}

export class InkWorkerOffscreenPresentationAdapter {
  readonly canvases: {
    readonly stable: HTMLCanvasElement;
    readonly tail: HTMLCanvasElement;
  };
  private configuredFrame: InkWorkerPresentationFrameConfig | null = null;
  private currentContact: InkWorkerPresentationContactConfig | null = null;
  private disposed = false;
  private faulted = false;
  private readonly inFlight = new Map<string, InFlightFrame>();
  private lastAcknowledgedPacket = 0;
  private packetSequence = 0;
  private readonly pool = new InkTransferBufferPool({
    initialByteLength: INITIAL_BUFFER_BYTES,
    maximumByteLength: MAXIMUM_BUFFER_BYTES,
  });
  private readonly onAck: (ack: InkWorkerPresentationAck) => void;
  private readonly onFault: (failure: InkWorkerPresentationFailureCategory) => void;
  private readonly session: number;
  private readonly worker: WorkerLike;

  constructor(input: {
    readonly canvases: {
      readonly stable: HTMLCanvasElement;
      readonly tail: HTMLCanvasElement;
    };
    readonly onAck: (ack: InkWorkerPresentationAck) => void;
    readonly onFault: (failure: InkWorkerPresentationFailureCategory) => void;
    readonly session: number;
    readonly worker: WorkerLike;
  }) {
    this.canvases = Object.freeze(input.canvases);
    this.onAck = input.onAck;
    this.onFault = input.onFault;
    this.session = input.session;
    this.worker = input.worker;
    this.worker.onmessage = this.handleMessage;
    this.worker.onerror = this.handleError;
    this.worker.onmessageerror = this.handleMessageError;
  }

  configure(input: InkWorkerPresentationFrameConfig): void {
    if (!this.available()) return;
    assertPositiveUint32(input.frameEpoch, 'Ink Worker Stage Frame epoch');
    assertPositiveFinite(input.backingWidth, 'Ink Worker backing width');
    assertPositiveFinite(input.backingHeight, 'Ink Worker backing height');
    if (input.transform.length !== 6 || input.transform.some((value) => !Number.isFinite(value))) {
      throw new Error('Ink Worker transform must contain six finite values.');
    }
    const transform: [number, number, number, number, number, number] = [
      input.transform[0],
      input.transform[1],
      input.transform[2],
      input.transform[3],
      input.transform[4],
      input.transform[5],
    ];
    this.configuredFrame = Object.freeze({
      ...input,
      transform: Object.freeze(transform),
    });
    this.canvases.stable.style.width = '100%';
    this.canvases.stable.style.height = '100%';
    this.canvases.stable.style.top = '0px';
    this.canvases.tail.style.width = '100%';
    this.canvases.tail.style.height = '100%';
    this.canvases.tail.style.top = '0px';
    this.postOrFault({ ...this.configuredFrame, type: 'ink-worker-configure' });
  }

  beginContact(input: InkWorkerPresentationContactConfig): void {
    if (!this.available()) return;
    const frame = this.configuredFrame;
    if (frame === null) throw new Error('Ink Worker Adapter requires a configured Stage Frame.');
    assertPositiveUint32(input.contactSequence, 'Ink Worker contact sequence');
    assertPositiveFinite(input.width, 'Ink Worker stroke width');
    if (!Number.isFinite(input.opacity) || input.opacity < 0 || input.opacity > 1) {
      throw new Error('Ink Worker opacity must be between zero and one.');
    }
    if (input.color.length === 0) throw new Error('Ink Worker stroke color is required.');
    this.currentContact = Object.freeze({
      ...input,
      ...(input.startPoint === undefined
        ? {}
        : { startPoint: Object.freeze({ ...input.startPoint }) }),
    });
    this.packetSequence = 0;
    this.lastAcknowledgedPacket = 0;
    this.postOrFault({
      ...input,
      frameEpoch: frame.frameEpoch,
      session: this.session,
      type: 'ink-worker-begin-contact',
    });
  }

  submit(input: InkWorkerPresentationSubmission): InkWorkerPresentationSubmitResult {
    const contact = this.currentContact;
    const frame = this.configuredFrame;
    if (!this.available() || contact === null || frame === null) {
      return Object.freeze({ kind: 'unavailable' });
    }
    assertPositiveUint32(input.generation, 'Ink Worker presentation generation');
    assertNonNegativeUint32(input.stableStart, 'Ink Worker stable start');
    const provisionalPoints = input.provisionalPoints ?? EMPTY_XY_PATH;
    if (provisionalPoints.length > INK_WORKER_MAX_PROVISIONAL_POINTS) {
      this.fault('protocol-failed');
      return Object.freeze({ kind: 'unavailable' });
    }
    const byteLength =
      INK_WORKER_FRAME_HEADER_BYTES +
      (input.stablePoints.length + input.tailPoints.length + provisionalPoints.length) *
        2 *
        Float64Array.BYTES_PER_ELEMENT;
    const lease = this.pool.lease(byteLength);
    if (lease === null) {
      this.fault('backpressured');
      return Object.freeze({ kind: 'backpressured' });
    }

    const stableXY = new Float64Array(
      lease.buffer,
      INK_WORKER_FRAME_HEADER_BYTES,
      input.stablePoints.length * 2,
    );
    const tailXY = new Float64Array(
      lease.buffer,
      INK_WORKER_FRAME_HEADER_BYTES + stableXY.byteLength,
      input.tailPoints.length * 2,
    );
    const provisionalXY = new Float64Array(
      lease.buffer,
      INK_WORKER_FRAME_HEADER_BYTES + stableXY.byteLength + tailXY.byteLength,
      provisionalPoints.length * 2,
    );
    if (
      !writePath(input.stablePoints, stableXY) ||
      !writePath(input.tailPoints, tailXY) ||
      !writePath(provisionalPoints, provisionalXY)
    ) {
      this.pool.returnLease(lease);
      this.fault('protocol-failed');
      return Object.freeze({ kind: 'unavailable' });
    }
    this.packetSequence += 1;
    const packetSequence = this.packetSequence;
    try {
      encodeInkWorkerFrame(lease.buffer, {
        bufferId: lease.bufferId,
        contactSequence: contact.contactSequence,
        frameEpoch: frame.frameEpoch,
        generation: input.generation,
        leaseSequence: lease.leaseSequence,
        sequence: packetSequence,
        session: this.session,
        stableStart: input.stableStart,
        stableXY,
        tailXY,
        provisionalXY,
      });
      const expected: InFlightFrame = Object.freeze({
        bufferId: lease.bufferId,
        contactSequence: contact.contactSequence,
        frameEpoch: frame.frameEpoch,
        generation: input.generation,
        leaseSequence: lease.leaseSequence,
        packetSequence,
      });
      this.inFlight.set(inFlightKey(lease.bufferId, lease.leaseSequence), expected);
      this.worker.postMessage(
        { buffer: lease.buffer, session: this.session, type: 'ink-worker-frame' },
        [lease.buffer],
      );
    } catch {
      this.inFlight.delete(inFlightKey(lease.bufferId, lease.leaseSequence));
      if (lease.buffer.byteLength > 0) this.pool.returnLease(lease);
      this.fault('post-message-failed');
      return Object.freeze({ kind: 'unavailable' });
    }
    return Object.freeze({
      kind: 'submitted-async',
      packetSequence,
      submittedSegmentCount:
        input.stablePoints.length +
        Math.max(0, input.tailPoints.length - 1) +
        provisionalPoints.length,
    });
  }

  reset(): void {
    if (!this.available()) return;
    const contactSequence = this.currentContact?.contactSequence ?? null;
    this.currentContact = null;
    this.postOrFault({ contactSequence, session: this.session, type: 'ink-worker-reset' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearWorkerHandlers(this.worker);
    safeTerminate(this.worker);
    this.inFlight.clear();
    abandonPool(this.pool);
  }

  private available(): boolean {
    return !this.disposed && !this.faulted;
  }

  private fault(failure: InkWorkerPresentationFailureCategory): void {
    if (this.disposed || this.faulted) return;
    this.faulted = true;
    clearWorkerHandlers(this.worker);
    safeTerminate(this.worker);
    this.inFlight.clear();
    abandonPool(this.pool);
    this.onFault(failure);
  }

  private readonly handleError = (event: unknown): void => {
    preventDefault(event);
    this.fault('context-unavailable');
  };

  private readonly handleMessageError = (event: unknown): void => {
    preventDefault(event);
    this.fault('message-error');
  };

  private readonly handleMessage = ({ data }: { readonly data: unknown }): void => {
    if (!this.available()) return;
    const message = asRecord(data);
    if (message.type === 'ink-worker-fault') {
      this.fault('context-unavailable');
      return;
    }
    if (
      message.type !== 'ink-worker-frame-ack' ||
      message.session !== this.session ||
      !(message.buffer instanceof ArrayBuffer)
    ) {
      this.fault('protocol-failed');
      return;
    }
    const decoded = decodeInkWorkerFrame(message.buffer);
    if (!decoded.ok) {
      this.fault('protocol-failed');
      return;
    }
    const expected = this.inFlight.get(
      inFlightKey(decoded.frame.bufferId, decoded.frame.leaseSequence),
    );
    if (
      expected === undefined ||
      !validateInkWorkerFrameAck(message.buffer, {
        bufferId: expected.bufferId,
        contactSequence: expected.contactSequence,
        frameEpoch: expected.frameEpoch,
        generation: expected.generation,
        leaseSequence: expected.leaseSequence,
        sequence: expected.packetSequence,
        session: this.session,
      }).ok
    ) {
      this.fault('protocol-failed');
      return;
    }
    const acknowledgesCurrentContact =
      this.currentContact?.contactSequence === expected.contactSequence;
    if (acknowledgesCurrentContact && expected.packetSequence !== this.lastAcknowledgedPacket + 1) {
      this.fault('protocol-failed');
      return;
    }
    const returned = this.pool.returnLease({
      buffer: message.buffer,
      bufferId: decoded.frame.bufferId,
      leaseSequence: decoded.frame.leaseSequence,
    });
    if (!returned.ok) {
      this.fault('protocol-failed');
      return;
    }
    this.inFlight.delete(inFlightKey(decoded.frame.bufferId, decoded.frame.leaseSequence));
    if (acknowledgesCurrentContact) {
      this.lastAcknowledgedPacket = expected.packetSequence;
    }
    if (acknowledgesCurrentContact && this.configuredFrame?.frameEpoch === expected.frameEpoch) {
      this.onAck(
        Object.freeze({
          contactSequence: expected.contactSequence,
          frameEpoch: expected.frameEpoch,
          generation: expected.generation,
          packetSequence: expected.packetSequence,
        }),
      );
    }
  };

  private postOrFault(message: Record<string, unknown>): void {
    try {
      this.worker.postMessage(message);
    } catch {
      this.fault('post-message-failed');
    }
  }
}

function createWorkerCanvas(document: Document, layer: 'stable' | 'tail'): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 0;
  canvas.height = 0;
  canvas.className = `inkstone-ink-canvas inkstone-ink-canvas-${
    layer === 'stable' ? 'active-stable' : 'active'
  }`;
  if (layer === 'stable') canvas.dataset.inkstoneInkActiveStable = 'worker';
  else canvas.dataset.inkstoneInkActive = 'worker';
  canvas.style.pointerEvents = 'none';
  canvas.style.opacity = '1';
  return canvas;
}

function transferCanvas(canvas: HTMLCanvasElement): object | null {
  const transfer = (
    canvas as HTMLCanvasElement & {
      transferControlToOffscreen?: () => unknown;
    }
  ).transferControlToOffscreen;
  if (typeof transfer !== 'function') return null;
  try {
    const transferred: unknown = Reflect.apply(transfer, canvas, []);
    return typeof transferred === 'object' && transferred !== null ? transferred : null;
  } catch {
    return null;
  }
}

function createWorker(runtime: Record<PropertyKey, unknown>):
  | {
      readonly kind: 'ready';
      readonly revoke: () => void;
      readonly worker: WorkerLike;
    }
  | {
      readonly failure: 'construct-failed';
      readonly kind: 'failed';
    }
  | null {
  const BlobConstructor = runtime.Blob;
  const WorkerConstructor = runtime.Worker;
  const urlApi = asRecord(runtime.URL);
  const createObjectURL = urlApi.createObjectURL;
  const revokeObjectURL = urlApi.revokeObjectURL;
  if (
    typeof BlobConstructor !== 'function' ||
    typeof WorkerConstructor !== 'function' ||
    typeof createObjectURL !== 'function' ||
    typeof revokeObjectURL !== 'function'
  ) {
    return null;
  }
  let objectUrl: unknown;
  try {
    const source = createInkOffscreenWorkerSource();
    const blob: unknown = Reflect.construct(BlobConstructor, [
      [source],
      { type: 'text/javascript' },
    ]);
    objectUrl = Reflect.apply(createObjectURL, runtime.URL, [blob]);
    if (typeof objectUrl !== 'string') return { failure: 'construct-failed', kind: 'failed' };
    const worker = Reflect.construct(WorkerConstructor, [objectUrl]) as WorkerLike;
    let revoked = false;
    return {
      kind: 'ready',
      revoke: () => {
        if (revoked) return;
        revoked = true;
        try {
          Reflect.apply(revokeObjectURL, runtime.URL, [objectUrl]);
        } catch {
          // URL cleanup is best effort after Worker construction; no runtime detail is retained.
        }
      },
      worker,
    };
  } catch {
    if (typeof objectUrl === 'string') {
      try {
        Reflect.apply(revokeObjectURL, runtime.URL, [objectUrl]);
      } catch {
        // Preserve the version-free construction category.
      }
    }
    return { failure: 'construct-failed', kind: 'failed' };
  }
}

export function createInkOffscreenWorkerSource(): string {
  return `/* ${INK_OFFSCREEN_WORKER_SOURCE_MARKER} */\n(${inkOffscreenWorkerMain.toString()})();`;
}

function writePath(path: InkWorkerXYPath, target: Float64Array): boolean {
  if (!Number.isSafeInteger(path.length) || path.length < 0 || target.length !== path.length * 2) {
    return false;
  }
  for (let index = 0; index < path.length; index += 1) {
    const point = path.at(index);
    if (point === undefined || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    target[index * 2] = point.x;
    target[index * 2 + 1] = point.y;
  }
  return true;
}

function inFlightKey(bufferId: number, leaseSequence: number): string {
  return `${bufferId}:${leaseSequence}`;
}

function unavailable(
  failureCategory: InkWorkerPresentationFailureCategory,
): InkWorkerPresentationPreparation {
  return Object.freeze({ failureCategory, kind: 'unavailable' });
}

function unavailableActivation(
  failureCategory: InkWorkerPresentationFailureCategory,
): InkWorkerPresentationActivationResult {
  return Object.freeze({ failureCategory, kind: 'unavailable' });
}

function allocateSessionEpoch(): number {
  const epoch = nextSessionEpoch;
  nextSessionEpoch = nextSessionEpoch >= UINT32_MAX ? 1 : nextSessionEpoch + 1;
  return epoch;
}

function boundedTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.round(value ?? DEFAULT_TIMEOUT_MS)));
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be positive and finite.`);
}

function assertPositiveUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > UINT32_MAX) {
    throw new Error(`${name} must be a positive uint32.`);
  }
}

function assertNonNegativeUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`${name} must be a non-negative uint32.`);
  }
}

function asRecord(value: unknown): Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<PropertyKey, unknown>)
    : (Object.create(null) as Record<PropertyKey, unknown>);
}

function preventDefault(event: unknown): void {
  const candidate = asRecord(event).preventDefault;
  if (typeof candidate === 'function') {
    try {
      Reflect.apply(candidate, event, []);
    } catch {
      // Error details are deliberately ignored.
    }
  }
}

function clearWorkerHandlers(worker: WorkerLike): void {
  try {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
  } catch {
    // A faulted host object is already unusable.
  }
}

function safeTerminate(worker: WorkerLike): void {
  try {
    worker.terminate();
  } catch {
    // Termination is best effort after the Adapter has fenced its session.
  }
}

function safeCancel(scheduler: InkWorkerProbeScheduler, handle: unknown): void {
  try {
    scheduler.cancel(handle);
  } catch {
    // The readiness generation is already fenced.
  }
}

function abandonPool(pool: InkTransferBufferPool): void {
  pool.abandonAll();
}

/** DOM-free Worker entry point. Keep it self-contained because its source is embedded in main.js. */
function inkOffscreenWorkerMain(): void {
  const scope = self as unknown as {
    onmessage: ((event: { readonly data: Record<string, unknown> }) => void) | null;
    postMessage(message: Record<string, unknown>, transfer?: readonly unknown[]): void;
  };
  const HEADER_BYTES = 64;
  const MAGIC = 0x494e4b57;
  const VERSION = 1;
  const KIND = 1;
  const MAX_PROVISIONAL_POINTS = 16;
  let session = 0;
  let stableCanvas: OffscreenCanvas | null = null;
  let tailCanvas: OffscreenCanvas | null = null;
  let stableContext: OffscreenCanvasRenderingContext2D | null = null;
  let tailContext: OffscreenCanvasRenderingContext2D | null = null;
  let frameEpoch = 0;
  let contactSequence = 0;
  let lastGeneration = 0;
  let lastSequence = 0;
  let stablePointCount = 0;
  let lastStableX = 0;
  let lastStableY = 0;
  let hasLastStable = false;
  const reusableAnchor = { x: 0, y: 0 };
  let previousTailBounds: { bottom: number; left: number; right: number; top: number } | null =
    null;
  let paint = {
    color: '#000000',
    eraserColor: '#dc2626',
    opacity: 1,
    startPoint: null as { x: number; y: number } | null,
    tool: 'pen',
    width: 1,
  };
  let transform: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

  const postFault = (): void => {
    scope.postMessage({ session, type: 'ink-worker-fault' });
  };
  const applyContextState = (context: OffscreenCanvasRenderingContext2D): void => {
    context.setTransform(...transform);
    context.lineCap = 'round';
    context.lineJoin = 'round';
  };
  const clearBacking = (
    canvas: OffscreenCanvas,
    context: OffscreenCanvasRenderingContext2D,
  ): void => {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.restore();
    applyContextState(context);
  };
  const reset = (): void => {
    lastGeneration = 0;
    lastSequence = 0;
    stablePointCount = 0;
    hasLastStable = false;
    previousTailBounds = null;
    if (stableCanvas !== null && stableContext !== null) clearBacking(stableCanvas, stableContext);
    if (tailCanvas !== null && tailContext !== null) clearBacking(tailCanvas, tailContext);
  };
  const bounds = (values: Float64Array): typeof previousTailBounds => {
    if (values.length === 0) return null;
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < values.length; index += 2) {
      const x = values[index];
      const y = values[index + 1];
      if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
    const radius = paint.width / 2 + 2;
    return {
      bottom: bottom + radius,
      left: left - radius,
      right: right + radius,
      top: top - radius,
    };
  };
  const union = (
    left: typeof previousTailBounds,
    right: typeof previousTailBounds,
  ): typeof previousTailBounds => {
    if (left === null) return right;
    if (right === null) return left;
    return {
      bottom: Math.max(left.bottom, right.bottom),
      left: Math.min(left.left, right.left),
      right: Math.max(left.right, right.right),
      top: Math.min(left.top, right.top),
    };
  };
  const strokePath = (
    context: OffscreenCanvasRenderingContext2D,
    values: Float64Array,
    continuation: Float64Array | null,
    anchor: { readonly x: number; readonly y: number } | null,
    color: string,
    dashed: boolean,
  ): void => {
    if (
      values.length === 0 &&
      (continuation === null || continuation.length === 0) &&
      anchor === null
    )
      return;
    context.save();
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.strokeStyle = color;
    context.lineWidth = paint.width;
    context.setLineDash(dashed ? [6, 4] : []);
    context.beginPath();
    let count = 0;
    if (anchor !== null) {
      context.moveTo(anchor.x, anchor.y);
      count += 1;
    }
    for (let index = 0; index < values.length; index += 2) {
      const x = values[index] as number;
      const y = values[index + 1] as number;
      if (count === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
      count += 1;
    }
    if (continuation !== null) {
      for (let index = 0; index < continuation.length; index += 2) {
        const x = continuation[index] as number;
        const y = continuation[index + 1] as number;
        if (count === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
        count += 1;
      }
    }
    if (count === 1) {
      const lastValues = continuation !== null && continuation.length >= 2 ? continuation : values;
      const x =
        lastValues.length >= 2 ? (lastValues[lastValues.length - 2] as number) : (anchor?.x ?? 0);
      const y =
        lastValues.length >= 2 ? (lastValues[lastValues.length - 1] as number) : (anchor?.y ?? 0);
      context.lineTo(x + 0.01, y + 0.01);
    }
    context.stroke();
    context.restore();
  };
  const drawFrame = (buffer: ArrayBuffer): boolean => {
    if (buffer.byteLength < HEADER_BYTES || stableContext === null || tailContext === null) {
      return false;
    }
    const header = new DataView(buffer, 0, HEADER_BYTES);
    if (
      header.getUint32(0, true) !== MAGIC ||
      header.getUint16(4, true) !== VERSION ||
      header.getUint16(6, true) !== KIND ||
      header.getUint32(8, true) !== HEADER_BYTES
    ) {
      return false;
    }
    const byteLength = header.getUint32(12, true);
    const packetSession = header.getUint32(16, true);
    const packetContact = header.getUint32(20, true);
    const packetFrame = header.getUint32(24, true);
    const generation = header.getUint32(28, true);
    const sequence = header.getUint32(32, true);
    const stableStart = header.getUint32(36, true);
    const stableCount = header.getUint32(40, true);
    const tailCount = header.getUint32(44, true);
    const provisionalCount = header.getUint32(60, true);
    const expectedLength = HEADER_BYTES + (stableCount + tailCount + provisionalCount) * 16;
    if (
      byteLength !== expectedLength ||
      byteLength > buffer.byteLength ||
      packetSession !== session ||
      packetContact !== contactSequence ||
      packetFrame !== frameEpoch ||
      header.getUint32(56, true) !== 0 ||
      sequence !== lastSequence + 1 ||
      generation < lastGeneration ||
      stableStart !== stablePointCount ||
      stableCount + tailCount === 0 ||
      provisionalCount > MAX_PROVISIONAL_POINTS
    ) {
      return false;
    }
    const stableValues = new Float64Array(buffer, HEADER_BYTES, stableCount * 2);
    const tailValues = new Float64Array(
      buffer,
      HEADER_BYTES + stableValues.byteLength,
      tailCount * 2,
    );
    const provisionalValues = new Float64Array(
      buffer,
      HEADER_BYTES + stableValues.byteLength + tailValues.byteLength,
      provisionalCount * 2,
    );
    for (const value of stableValues) if (!Number.isFinite(value)) return false;
    for (const value of tailValues) if (!Number.isFinite(value)) return false;
    for (const value of provisionalValues) if (!Number.isFinite(value)) return false;

    let stableAnchor: typeof reusableAnchor | null = null;
    if (hasLastStable) {
      reusableAnchor.x = lastStableX;
      reusableAnchor.y = lastStableY;
      stableAnchor = reusableAnchor;
    }
    strokePath(stableContext, stableValues, null, stableAnchor, paint.color, false);
    if (stableValues.length >= 2) {
      lastStableX = stableValues[stableValues.length - 2] as number;
      lastStableY = stableValues[stableValues.length - 1] as number;
      hasLastStable = true;
    }
    const nextTailBounds = union(bounds(tailValues), bounds(provisionalValues));
    const dirty = union(previousTailBounds, nextTailBounds);
    if (dirty !== null) {
      tailContext.clearRect(
        dirty.left,
        dirty.top,
        dirty.right - dirty.left,
        dirty.bottom - dirty.top,
      );
    }
    let tailAnchor: typeof reusableAnchor | null = null;
    if (tailValues.length === 0 && provisionalValues.length > 0) {
      if (hasLastStable) {
        reusableAnchor.x = lastStableX;
        reusableAnchor.y = lastStableY;
        tailAnchor = reusableAnchor;
      } else {
        tailAnchor = paint.startPoint;
      }
    }
    strokePath(
      tailContext,
      tailValues,
      provisionalValues,
      tailAnchor,
      paint.tool === 'eraser' ? paint.eraserColor : paint.color,
      paint.tool === 'eraser',
    );
    if (paint.tool === 'eraser' && paint.startPoint !== null) {
      tailContext.save();
      tailContext.setLineDash([]);
      tailContext.beginPath();
      tailContext.strokeStyle = paint.eraserColor;
      tailContext.lineWidth = 2;
      tailContext.arc(paint.startPoint.x, paint.startPoint.y, 6, 0, Math.PI * 2);
      tailContext.stroke();
      tailContext.restore();
    }
    previousTailBounds = nextTailBounds;
    stablePointCount += stableCount;
    lastGeneration = generation;
    lastSequence = sequence;
    return true;
  };

  scope.onmessage = ({ data }) => {
    try {
      if (data.type === 'ink-worker-prewarm') {
        session = Number(data.session);
        scope.postMessage(
          {
            probeBuffer: data.probeBuffer,
            session,
            type: 'ink-worker-prewarmed',
          },
          [data.probeBuffer],
        );
        return;
      }
      if (data.type === 'ink-worker-init') {
        session = Number(data.session);
        stableCanvas = data.stableCanvas as OffscreenCanvas;
        tailCanvas = data.tailCanvas as OffscreenCanvas;
        stableContext = stableCanvas.getContext('2d');
        tailContext = tailCanvas.getContext('2d');
        if (stableContext === null || tailContext === null) {
          postFault();
          return;
        }
        const reportContextLoss = (): void => postFault();
        stableCanvas.addEventListener?.('contextlost', reportContextLoss);
        tailCanvas.addEventListener?.('contextlost', reportContextLoss);
        applyContextState(stableContext);
        applyContextState(tailContext);
        scope.postMessage({ probeBuffer: data.probeBuffer, session, type: 'ink-worker-ready' }, [
          data.probeBuffer,
        ]);
        return;
      }
      if (Number(data.session) !== session) {
        postFault();
        return;
      }
      if (data.type === 'ink-worker-configure') {
        frameEpoch = Number(data.frameEpoch);
        transform = data.transform as typeof transform;
        if (
          stableCanvas === null ||
          tailCanvas === null ||
          stableContext === null ||
          tailContext === null
        ) {
          postFault();
          return;
        }
        stableCanvas.width = Number(data.backingWidth);
        stableCanvas.height = Number(data.backingHeight);
        tailCanvas.width = Number(data.backingWidth);
        tailCanvas.height = Number(data.backingHeight);
        applyContextState(stableContext);
        applyContextState(tailContext);
        reset();
        return;
      }
      if (data.type === 'ink-worker-begin-contact') {
        frameEpoch = Number(data.frameEpoch);
        contactSequence = Number(data.contactSequence);
        paint = {
          color: String(data.color),
          eraserColor: typeof data.eraserColor === 'string' ? data.eraserColor : String(data.color),
          opacity: Number(data.opacity),
          startPoint:
            typeof data.startPoint === 'object' && data.startPoint !== null
              ? (data.startPoint as { x: number; y: number })
              : null,
          tool: String(data.tool),
          width: Number(data.width),
        };
        reset();
        return;
      }
      if (data.type === 'ink-worker-reset') {
        contactSequence = 0;
        reset();
        return;
      }
      if (data.type === 'ink-worker-frame') {
        const buffer = data.buffer;
        if (!(buffer instanceof ArrayBuffer) || !drawFrame(buffer)) {
          postFault();
          return;
        }
        scope.postMessage({ buffer, session, type: 'ink-worker-frame-ack' }, [buffer]);
      }
    } catch {
      postFault();
    }
  };
}
