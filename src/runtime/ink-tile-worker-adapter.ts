import type { InkStroke } from '../domain/ink-surface';
import { INK_TILE_WORKER_DIGEST, INK_TILE_WORKER_SOURCE } from './ink-tile-worker-artifact';
import {
  InkTileWorkerCoordinator,
  type InkTileWorkerPriority,
  type InkTileWorkerResultResource,
} from './ink-tile-worker-coordinator';
import type { InkTileWorkerProbeResult } from './ink-tile-worker-probe';
import { digestInkTileProjectionSlice } from './ink-tile-worker-protocol';

export interface InkTileWorkerBitmap {
  close(): void;
}

export interface InkTileWorkerBuildRequest {
  readonly backingHeight: number;
  readonly backingWidth: number;
  readonly byteSize: number;
  readonly density: number;
  readonly generation: number;
  readonly isCurrent: () => boolean;
  readonly jobId: string;
  readonly key: string;
  readonly mountId: string;
  readonly originX: number;
  readonly originY: number;
  readonly priority: InkTileWorkerPriority;
  readonly projectionDigest: string;
  readonly projectionIdentity: string;
  readonly projectionMirrorSequence: number;
  readonly sessionId: string;
  readonly token: string;
}

export interface InkTileWorkerProjectionSyncInput {
  readonly byteSize: number;
  readonly mirrorSequence: number;
  readonly mountId: string;
  readonly projectionIdentity: string;
  readonly sessionId: string;
  readonly strokes: readonly InkStroke[];
}

export interface InkTileWorkerProjectionAcknowledgement {
  readonly digest: string;
  readonly mirrorSequence: number;
  readonly projectionIdentity: string;
  readonly sessionId: string;
}

export type InkTileWorkerBuildResult =
  | {
      readonly bitmap: InkTileWorkerBitmap;
      readonly generation: number;
      readonly jobId: string;
      readonly kind: 'built';
      readonly token: string;
    }
  | { readonly jobId: string; readonly kind: 'coalesced' }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'fallback';
      readonly reason:
        | 'admission-rejected'
        | 'disposed'
        | 'mirror-unacknowledged'
        | 'stale-result'
        | 'worker-fault'
        | 'worker-job-failed';
    };

export interface InkTileWorkerAdapterPauseLease {
  readonly acknowledged: Promise<void>;
  release(): void;
}

export interface InkTileWorkerAdapterScheduler {
  cancel(handle: unknown): void;
  schedule(callback: () => void, delayMs: number): unknown;
}

type ReadyProbe = Extract<InkTileWorkerProbeResult, { readonly kind: 'ready' }>;

export type InkTileWorkerAdapterCreation =
  | { readonly adapter: InkTileWorkerAdapter; readonly kind: 'ready' }
  | { readonly kind: 'unavailable'; readonly reason: 'construct-failed' | 'not-authorized' };

interface WorkerLike {
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

interface PendingBuild {
  readonly request: InkTileWorkerBuildRequest;
  readonly resolve: (result: InkTileWorkerBuildResult) => void;
  timeoutHandle?: unknown;
  timeoutScheduled: boolean;
}

interface PendingPause {
  resolve(): void;
}

interface PendingMirror {
  readonly acknowledgement: InkTileWorkerProjectionAcknowledgement;
  readonly mirrorIdentity: string;
  readonly resolve: (result: InkTileWorkerProjectionAcknowledgement | null) => void;
  timeoutHandle?: unknown;
  timeoutScheduled: boolean;
}

const DEFAULT_JOB_TIMEOUT_MS = 5_000;
const MIRROR_CHUNK_STROKES = 64;
const DEFAULT_SCHEDULER: InkTileWorkerAdapterScheduler = Object.freeze({
  cancel: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
});

export function createInkTileWorkerAdapter(input: {
  readonly artifact?: { readonly digest: string; readonly source: string };
  readonly coordinator?: InkTileWorkerCoordinator;
  readonly host?: unknown;
  readonly probe: ReadyProbe;
  readonly scheduler?: InkTileWorkerAdapterScheduler;
}): InkTileWorkerAdapterCreation {
  const artifact = input.artifact ?? {
    digest: INK_TILE_WORKER_DIGEST,
    source: INK_TILE_WORKER_SOURCE,
  };
  if (
    input.probe.artifactDigest !== artifact.digest ||
    artifact.source.length === 0 ||
    !/^[a-f0-9]{64}$/u.test(artifact.digest)
  ) {
    return Object.freeze({ kind: 'unavailable', reason: 'not-authorized' });
  }
  const worker = constructWorker(asRecord(input.host ?? globalThis), artifact.source);
  if (worker === null) {
    return Object.freeze({ kind: 'unavailable', reason: 'construct-failed' });
  }
  return Object.freeze({
    adapter: new InkTileWorkerAdapter({
      coordinator: input.coordinator ?? new InkTileWorkerCoordinator(),
      scheduler: input.scheduler ?? DEFAULT_SCHEDULER,
      worker,
    }),
    kind: 'ready',
  });
}

/** One authorized, long-lived, epoch-fenced Tile Worker for a plugin runtime. */
export class InkTileWorkerAdapter {
  private disposed = false;
  private faulted = false;
  private nextPauseId = 0;
  private nextSyncId = 0;
  private readonly acknowledgedMirrors = new Map<
    string,
    InkTileWorkerProjectionAcknowledgement & { readonly mirrorIdentity: string }
  >();
  private readonly coordinator: InkTileWorkerCoordinator;
  private readonly pendingBuilds = new Map<string, PendingBuild>();
  private readonly pendingMirrors = new Map<string, PendingMirror>();
  private readonly pendingPauses = new Map<string, PendingPause>();
  private readonly scheduler: InkTileWorkerAdapterScheduler;
  private worker: WorkerLike | null;

  constructor(input: {
    readonly coordinator: InkTileWorkerCoordinator;
    readonly scheduler: InkTileWorkerAdapterScheduler;
    readonly worker: WorkerLike;
  }) {
    this.coordinator = input.coordinator;
    this.scheduler = input.scheduler;
    this.worker = input.worker;
    this.worker.onmessage = ({ data }) => this.acceptMessage(data);
    this.worker.onerror = (event) => {
      preventDefault(event);
      this.fault();
    };
    this.worker.onmessageerror = () => this.fault();
  }

  build(request: InkTileWorkerBuildRequest): Promise<InkTileWorkerBuildResult> {
    if (this.disposed) return Promise.resolve(fallback('disposed'));
    if (this.faulted || this.worker === null) return Promise.resolve(fallback('worker-fault'));
    assertBuildRequest(request);
    if (!request.isCurrent()) return Promise.resolve(fallback('stale-result'));
    const mirror = this.acknowledgedMirrors.get(request.projectionIdentity);
    if (
      mirror === undefined ||
      mirror.sessionId !== request.sessionId ||
      mirror.mirrorSequence !== request.projectionMirrorSequence ||
      mirror.digest !== request.projectionDigest
    ) {
      return Promise.resolve(fallback('mirror-unacknowledged'));
    }
    const admission = this.coordinator.submit({
      byteSize: request.byteSize,
      id: request.jobId,
      key: request.key,
      mountId: request.mountId,
      priority: request.priority,
    });
    if (admission.kind === 'coalesced') {
      return Promise.resolve(Object.freeze({ jobId: admission.jobId, kind: 'coalesced' }));
    }
    if (admission.kind !== 'accepted') return Promise.resolve(fallback('admission-rejected'));
    return new Promise((resolve) => {
      this.pendingBuilds.set(request.jobId, {
        request,
        resolve,
        timeoutScheduled: false,
      });
      this.pump();
    });
  }

  synchronize(
    input: InkTileWorkerProjectionSyncInput,
  ): Promise<InkTileWorkerProjectionAcknowledgement | null> {
    if (this.disposed || this.faulted || this.worker === null) return Promise.resolve(null);
    assertProjectionSync(input);
    const digest = digestInkTileProjectionSlice(input.strokes);
    const acknowledgement = Object.freeze({
      digest,
      mirrorSequence: input.mirrorSequence,
      projectionIdentity: input.projectionIdentity,
      sessionId: input.sessionId,
    });
    const existing = this.acknowledgedMirrors.get(input.projectionIdentity);
    if (
      existing !== undefined &&
      existing.digest === digest &&
      existing.mirrorSequence === input.mirrorSequence &&
      existing.sessionId === input.sessionId
    ) {
      return Promise.resolve(acknowledgement);
    }
    const mirrorIdentity = projectionMirrorIdentity(acknowledgement);
    if (!this.coordinator.reserveMirror(mirrorIdentity, input.byteSize))
      return Promise.resolve(null);
    this.nextSyncId += 1;
    const syncId = `tile-sync-${this.nextSyncId}`;
    return new Promise((resolve) => {
      const pending: PendingMirror = {
        acknowledgement,
        mirrorIdentity,
        resolve,
        timeoutScheduled: false,
      };
      this.pendingMirrors.set(syncId, pending);
      try {
        this.worker?.postMessage({
          digest,
          mirrorSequence: input.mirrorSequence,
          mountId: input.mountId,
          projectionIdentity: input.projectionIdentity,
          sessionId: input.sessionId,
          strokeCount: input.strokes.length,
          syncId,
          type: 'mirror-begin',
        });
        for (let index = 0; index < input.strokes.length; index += MIRROR_CHUNK_STROKES) {
          this.worker?.postMessage({
            strokes: input.strokes.slice(index, index + MIRROR_CHUNK_STROKES),
            syncId,
            type: 'mirror-chunk',
          });
        }
        this.worker?.postMessage({
          ...acknowledgement,
          syncId,
          type: 'mirror-commit',
        });
        pending.timeoutHandle = this.scheduler.schedule(() => this.fault(), DEFAULT_JOB_TIMEOUT_MS);
        pending.timeoutScheduled = true;
      } catch {
        this.coordinator.releaseMirror(mirrorIdentity);
        this.pendingMirrors.delete(syncId);
        resolve(null);
        this.fault();
      }
    });
  }

  cancel(jobId: string): boolean {
    if (this.disposed || this.faulted) return false;
    const status = this.coordinator.cancel(jobId);
    if (status === 'missing') return false;
    if (status === 'queued') {
      this.settleBuild(jobId, Object.freeze({ kind: 'cancelled' }));
      this.pump();
      return true;
    }
    try {
      this.worker?.postMessage({ jobId, type: 'cancel' });
      return true;
    } catch {
      this.fault();
      return false;
    }
  }

  acquirePause(scope: string): InkTileWorkerAdapterPauseLease {
    if (this.disposed || this.faulted || this.worker === null) {
      return Object.freeze({ acknowledged: Promise.resolve(), release: () => undefined });
    }
    const coordinatorLease = this.coordinator.acquirePause(scope);
    this.nextPauseId += 1;
    const leaseId = `tile-pause-${this.nextPauseId}`;
    let released = false;
    let resolveAcknowledgement: () => void = () => undefined;
    const acknowledged = new Promise<void>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    this.pendingPauses.set(leaseId, { resolve: resolveAcknowledgement });
    try {
      this.worker.postMessage({ leaseId, scope, type: 'pause' });
    } catch {
      this.pendingPauses.delete(leaseId);
      resolveAcknowledgement();
      coordinatorLease.release();
      this.fault();
    }
    return Object.freeze({
      acknowledged,
      release: () => {
        if (released) return;
        released = true;
        coordinatorLease.release();
        try {
          this.worker?.postMessage({ leaseId, scope, type: 'resume' });
        } catch {
          this.fault();
          return;
        }
        this.pump();
      },
    });
  }

  stats(): ReturnType<InkTileWorkerCoordinator['stats']> {
    return this.coordinator.stats();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    if (!this.faulted) {
      try {
        worker?.postMessage({ type: 'dispose' });
      } catch {
        // The epoch is terminal regardless of delivery.
      }
    }
    clearWorkerHandlers(worker);
    safeTerminate(worker);
    this.coordinator.dispose();
    for (const jobId of [...this.pendingBuilds.keys()]) {
      this.settleBuild(jobId, Object.freeze({ kind: 'cancelled' }));
    }
    this.resolveAllPauses();
    this.resolveAllMirrors();
  }

  private acceptMessage(data: unknown): void {
    const message = asRecord(data);
    if (message.type === 'paused' && typeof message.leaseId === 'string') {
      const pause = this.pendingPauses.get(message.leaseId);
      if (pause !== undefined) {
        this.pendingPauses.delete(message.leaseId);
        pause.resolve();
      }
      return;
    }
    if (
      (message.type === 'mirror-ack' || message.type === 'mirror-failed') &&
      typeof message.syncId === 'string'
    ) {
      this.acceptMirrorMessage(message.syncId, message);
      return;
    }
    if (typeof message.jobId !== 'string') {
      safeClose(bitmapLike(message.bitmap));
      return;
    }
    const jobId = message.jobId;
    const pending = this.pendingBuilds.get(jobId);
    if (message.type === 'cancelled') {
      this.coordinator.abandonRunning(jobId);
      this.settleBuild(jobId, Object.freeze({ kind: 'cancelled' }));
      this.pump();
      return;
    }
    if (message.type === 'raster-failed') {
      this.coordinator.abandonRunning(jobId);
      this.settleBuild(jobId, fallback('worker-job-failed'));
      this.pump();
      return;
    }
    const bitmap = bitmapLike(message.bitmap);
    if (message.type !== 'raster-result' || pending === undefined || bitmap === null) {
      safeClose(bitmap);
      return;
    }
    const { request } = pending;
    if (
      message.generation !== request.generation ||
      message.token !== request.token ||
      !request.isCurrent()
    ) {
      safeClose(bitmap);
      this.coordinator.abandonRunning(jobId);
      this.settleBuild(jobId, fallback('stale-result'));
      this.pump();
      return;
    }
    const resource = new WorkerBitmapResource(
      bitmap,
      request.backingWidth * request.backingHeight * 4,
    );
    const completion = this.coordinator.complete(jobId, resource);
    if (completion.kind !== 'accepted') {
      this.settleBuild(jobId, fallback('admission-rejected'));
      this.pump();
      return;
    }
    const adopted = this.coordinator.adoptResult(jobId);
    if (!(adopted instanceof WorkerBitmapResource)) {
      resource.close();
      this.settleBuild(jobId, fallback('worker-fault'));
      this.fault();
      return;
    }
    this.settleBuild(
      jobId,
      Object.freeze({
        bitmap: adopted.take(),
        generation: request.generation,
        jobId,
        kind: 'built',
        token: request.token,
      }),
    );
    this.pump();
  }

  private pump(): void {
    if (this.disposed || this.faulted || this.worker === null) return;
    const next = this.coordinator.takeNext();
    if (next === null) return;
    const pending = this.pendingBuilds.get(next.id);
    if (pending === undefined) {
      this.coordinator.abandonRunning(next.id);
      this.pump();
      return;
    }
    const { request } = pending;
    if (!request.isCurrent()) {
      this.coordinator.abandonRunning(next.id);
      this.settleBuild(next.id, fallback('stale-result'));
      this.pump();
      return;
    }
    try {
      this.worker.postMessage({
        backingHeight: request.backingHeight,
        backingWidth: request.backingWidth,
        density: request.density,
        generation: request.generation,
        jobId: request.jobId,
        originX: request.originX,
        originY: request.originY,
        projectionDigest: request.projectionDigest,
        projectionIdentity: request.projectionIdentity,
        projectionMirrorSequence: request.projectionMirrorSequence,
        sessionId: request.sessionId,
        token: request.token,
        type: 'raster',
      });
      pending.timeoutHandle = this.scheduler.schedule(() => this.fault(), DEFAULT_JOB_TIMEOUT_MS);
      pending.timeoutScheduled = true;
    } catch {
      this.fault();
    }
  }

  private settleBuild(jobId: string, result: InkTileWorkerBuildResult): void {
    const pending = this.pendingBuilds.get(jobId);
    if (pending === undefined) return;
    this.pendingBuilds.delete(jobId);
    if (pending.timeoutScheduled) {
      try {
        this.scheduler.cancel(pending.timeoutHandle);
      } catch {
        // The Worker job is already fenced from publication.
      }
    }
    pending.resolve(result);
  }

  private fault(): void {
    if (this.disposed || this.faulted) return;
    this.faulted = true;
    const worker = this.worker;
    this.worker = null;
    clearWorkerHandlers(worker);
    safeTerminate(worker);
    this.coordinator.dispose();
    for (const jobId of [...this.pendingBuilds.keys()]) {
      this.settleBuild(jobId, fallback('worker-fault'));
    }
    this.resolveAllPauses();
    this.resolveAllMirrors();
  }

  private acceptMirrorMessage(
    syncId: string,
    message: Readonly<Record<PropertyKey, unknown>>,
  ): void {
    const pending = this.pendingMirrors.get(syncId);
    if (pending === undefined) return;
    const expected = pending.acknowledgement;
    if (
      message.type !== 'mirror-ack' ||
      message.sessionId !== expected.sessionId ||
      message.projectionIdentity !== expected.projectionIdentity ||
      message.mirrorSequence !== expected.mirrorSequence ||
      message.digest !== expected.digest
    ) {
      this.settleMirror(syncId, null, true);
      this.fault();
      return;
    }
    const previous = this.acknowledgedMirrors.get(expected.projectionIdentity);
    this.acknowledgedMirrors.set(expected.projectionIdentity, {
      ...expected,
      mirrorIdentity: pending.mirrorIdentity,
    });
    if (previous !== undefined && previous.mirrorIdentity !== pending.mirrorIdentity) {
      this.coordinator.releaseMirror(previous.mirrorIdentity);
      try {
        this.worker?.postMessage({
          digest: previous.digest,
          mirrorSequence: previous.mirrorSequence,
          projectionIdentity: previous.projectionIdentity,
          sessionId: previous.sessionId,
          type: 'mirror-release',
        });
      } catch {
        this.settleMirror(syncId, null, false);
        this.fault();
        return;
      }
    }
    this.settleMirror(syncId, expected, false);
  }

  private settleMirror(
    syncId: string,
    result: InkTileWorkerProjectionAcknowledgement | null,
    releaseReservation: boolean,
  ): void {
    const pending = this.pendingMirrors.get(syncId);
    if (pending === undefined) return;
    this.pendingMirrors.delete(syncId);
    if (pending.timeoutScheduled) {
      try {
        this.scheduler.cancel(pending.timeoutHandle);
      } catch {
        // The mirror cannot become buildable after this acknowledgement fence.
      }
    }
    if (releaseReservation) this.coordinator.releaseMirror(pending.mirrorIdentity);
    pending.resolve(result);
  }

  private resolveAllPauses(): void {
    for (const pause of this.pendingPauses.values()) pause.resolve();
    this.pendingPauses.clear();
  }

  private resolveAllMirrors(): void {
    for (const pending of this.pendingMirrors.values()) {
      if (pending.timeoutScheduled) {
        try {
          this.scheduler.cancel(pending.timeoutHandle);
        } catch {
          // The Worker is already terminal.
        }
      }
      pending.resolve(null);
    }
    this.pendingMirrors.clear();
    this.acknowledgedMirrors.clear();
  }
}

class WorkerBitmapResource implements InkTileWorkerResultResource {
  private bitmap: InkTileWorkerBitmap | null;
  readonly byteSize: number;

  constructor(bitmap: InkTileWorkerBitmap, byteSize: number) {
    this.bitmap = bitmap;
    this.byteSize = byteSize;
  }

  close(): void {
    const bitmap = this.bitmap;
    this.bitmap = null;
    safeClose(bitmap);
  }

  take(): InkTileWorkerBitmap {
    const bitmap = this.bitmap;
    if (bitmap === null) throw new Error('Ink Tile Worker bitmap ownership was already released.');
    this.bitmap = null;
    return bitmap;
  }
}

function constructWorker(
  runtime: Readonly<Record<PropertyKey, unknown>>,
  source: string,
): WorkerLike | null {
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
    objectUrl = Reflect.apply(createObjectURL, runtime.URL, [blob]) as unknown;
    if (typeof objectUrl !== 'string') return null;
    const worker = Reflect.construct(WorkerConstructor, [objectUrl]) as WorkerLike;
    Reflect.apply(revokeObjectURL, runtime.URL, [objectUrl]);
    return worker;
  } catch {
    if (typeof objectUrl === 'string') {
      try {
        Reflect.apply(revokeObjectURL, runtime.URL, [objectUrl]);
      } catch {
        // Construction is already failed closed.
      }
    }
    return null;
  }
}

function assertBuildRequest(request: InkTileWorkerBuildRequest): void {
  if (
    request.jobId.length === 0 ||
    request.key.length === 0 ||
    request.mountId.length === 0 ||
    request.token.length === 0
  ) {
    throw new Error('Ink Tile Worker build identities must not be empty.');
  }
  if (
    !Number.isSafeInteger(request.backingWidth) ||
    request.backingWidth <= 0 ||
    !Number.isSafeInteger(request.backingHeight) ||
    request.backingHeight <= 0 ||
    !Number.isSafeInteger(request.byteSize) ||
    request.byteSize < 0 ||
    !Number.isSafeInteger(request.generation) ||
    !Number.isSafeInteger(request.projectionMirrorSequence) ||
    !Number.isFinite(request.density) ||
    request.density <= 0 ||
    !Number.isFinite(request.originX) ||
    !Number.isFinite(request.originY)
  ) {
    throw new Error('Ink Tile Worker build dimensions and epochs must be finite and bounded.');
  }
}

function assertProjectionSync(input: InkTileWorkerProjectionSyncInput): void {
  if (
    input.mountId.length === 0 ||
    input.projectionIdentity.length === 0 ||
    input.sessionId.length === 0 ||
    !Number.isSafeInteger(input.byteSize) ||
    input.byteSize < 0 ||
    !Number.isSafeInteger(input.mirrorSequence) ||
    input.mirrorSequence < 0 ||
    input.strokes.length > 512
  ) {
    throw new Error('Ink Tile Worker projection slice is invalid or exceeds its hard ceiling.');
  }
}

function projectionMirrorIdentity(acknowledgement: InkTileWorkerProjectionAcknowledgement): string {
  return `${acknowledgement.sessionId}:${acknowledgement.projectionIdentity}:${acknowledgement.mirrorSequence}:${acknowledgement.digest}`;
}

function fallback(
  reason: Extract<InkTileWorkerBuildResult, { kind: 'fallback' }>['reason'],
): InkTileWorkerBuildResult {
  return Object.freeze({ kind: 'fallback', reason });
}

function bitmapLike(value: unknown): InkTileWorkerBitmap | null {
  return typeof asRecord(value).close === 'function' ? (value as InkTileWorkerBitmap) : null;
}

function safeClose(bitmap: InkTileWorkerBitmap | null): void {
  if (bitmap === null) return;
  try {
    bitmap.close();
  } catch {
    // The ownership state is terminal even if a platform closer throws.
  }
}

function asRecord(value: unknown): Readonly<Record<PropertyKey, unknown>> {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<PropertyKey, unknown>>)
    : Object.freeze({});
}

function clearWorkerHandlers(worker: WorkerLike | null): void {
  if (worker === null) return;
  try {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
  } catch {
    // Termination remains authoritative.
  }
}

function safeTerminate(worker: WorkerLike | null): void {
  if (worker === null) return;
  try {
    worker.terminate();
  } catch {
    // The Worker epoch is fenced through cleared handlers.
  }
}

function preventDefault(event: unknown): void {
  const prevent = asRecord(event).preventDefault;
  if (typeof prevent !== 'function') return;
  try {
    Reflect.apply(prevent, event, []);
  } catch {
    // Runtime error details never escape into diagnostics.
  }
}
