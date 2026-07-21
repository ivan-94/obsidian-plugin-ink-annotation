import { SharedInkStrokeGeometry } from '../domain/ink-shared-stroke-geometry';
import type { InkStroke } from '../domain/ink-surface';
import { drawInkBrushGeometryToCanvas } from '../ui/ink-brush-canvas-adapter';
import {
  digestInkTileProjectionSlice,
  INK_TILE_WORKER_PROTOCOL_VERSION,
} from './ink-tile-worker-protocol';

const MAXIMUM_RASTER_STROKES = 512;
// One Logical Stroke is the smallest currently safe compilation quantum. Promotion remains gated
// on target-device evidence that this indivisible unit stays below the Worker quantum budget.
const RASTER_STROKE_BATCH_SIZE = 1;
const geometry = new SharedInkStrokeGeometry();

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  setTimeout(callback: () => void, delayMs?: number): number;
  close(): void;
}

interface RasterJob {
  readonly backingHeight: number;
  readonly backingWidth: number;
  readonly density: number;
  readonly generation: number;
  readonly jobId: string;
  readonly originX: number;
  readonly originY: number;
  readonly projectionDigest: string;
  readonly projectionIdentity: string;
  readonly projectionMirrorSequence: number;
  readonly sessionId: string;
  readonly strokes: readonly InkStroke[];
  readonly token: string;
}

interface ProjectionMirror {
  readonly digest: string;
  readonly mirrorSequence: number;
  readonly projectionIdentity: string;
  readonly sessionId: string;
  readonly strokes: readonly InkStroke[];
}

interface StagingProjectionMirror {
  readonly digest: string;
  readonly mirrorSequence: number;
  readonly projectionIdentity: string;
  readonly sessionId: string;
  readonly strokeCount: number;
  readonly strokes: InkStroke[];
  readonly syncId: string;
}

interface RunningRasterJob {
  readonly canvas: OffscreenCanvas;
  readonly context: OffscreenCanvasRenderingContext2D;
  index: number;
  readonly input: RasterJob;
}

const scope = self as unknown as WorkerScope;
const cancelledJobs = new Set<string>();
let pausedLeaseCount = 0;
const readyMirrors = new Map<string, ProjectionMirror>();
let running: RunningRasterJob | null = null;
const stagingMirrors = new Map<string, StagingProjectionMirror>();

scope.onmessage = ({ data }): void => {
  const message = asRecord(data);
  switch (message.type) {
    case 'probe':
      runProbe(message);
      return;
    case 'raster':
      startRaster(message);
      return;
    case 'mirror-begin':
      beginMirror(message);
      return;
    case 'mirror-chunk':
      appendMirrorChunk(message);
      return;
    case 'mirror-commit':
      commitMirror(message);
      return;
    case 'mirror-release':
      releaseMirror(message);
      return;
    case 'cancel': {
      const jobId = message.jobId;
      if (typeof jobId === 'string') cancelledJobs.add(jobId);
      return;
    }
    case 'pause':
      pausedLeaseCount += 1;
      scope.postMessage({ leaseId: message.leaseId, type: 'paused' });
      return;
    case 'resume':
      pausedLeaseCount = Math.max(0, pausedLeaseCount - 1);
      if (pausedLeaseCount === 0 && running !== null) scheduleRasterStep();
      return;
    case 'dispose':
      running = null;
      cancelledJobs.clear();
      readyMirrors.clear();
      stagingMirrors.clear();
      scope.close();
      return;
  }
};

function runProbe(message: Readonly<Record<PropertyKey, unknown>>): void {
  const requestId = message.requestId;
  if (typeof requestId !== 'string') return;
  try {
    const width = 64;
    const height = 32;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) {
      postFailure(requestId, 'context-unavailable');
      return;
    }
    drawStroke(context, physicalProbeStroke('pen'));
    drawStroke(context, physicalProbeStroke('highlighter'));
    const bitmap = canvas.transferToImageBitmap();
    scope.postMessage(
      {
        bitmap,
        height,
        protocolVersion: INK_TILE_WORKER_PROTOCOL_VERSION,
        requestId,
        type: 'probe-result',
        width,
      },
      [bitmap],
    );
  } catch {
    postFailure(requestId, 'raster-failed');
  }
}

function beginMirror(message: Readonly<Record<PropertyKey, unknown>>): void {
  if (
    typeof message.syncId !== 'string' ||
    typeof message.sessionId !== 'string' ||
    typeof message.projectionIdentity !== 'string' ||
    typeof message.digest !== 'string' ||
    !Number.isSafeInteger(message.mirrorSequence) ||
    !Number.isSafeInteger(message.strokeCount) ||
    (message.strokeCount as number) < 0 ||
    (message.strokeCount as number) > MAXIMUM_RASTER_STROKES
  ) {
    postMirrorFailure(message.syncId, 'invalid-mirror');
    return;
  }
  stagingMirrors.set(message.syncId, {
    digest: message.digest,
    mirrorSequence: message.mirrorSequence as number,
    projectionIdentity: message.projectionIdentity,
    sessionId: message.sessionId,
    strokeCount: message.strokeCount as number,
    strokes: [],
    syncId: message.syncId,
  });
}

function appendMirrorChunk(message: Readonly<Record<PropertyKey, unknown>>): void {
  const syncId = message.syncId;
  const strokes = message.strokes;
  if (typeof syncId !== 'string' || !Array.isArray(strokes)) {
    postMirrorFailure(syncId, 'invalid-mirror');
    return;
  }
  const staging = stagingMirrors.get(syncId);
  if (staging === undefined || staging.strokes.length + strokes.length > staging.strokeCount) {
    postMirrorFailure(syncId, 'invalid-mirror');
    return;
  }
  staging.strokes.push(...(strokes as InkStroke[]));
}

function commitMirror(message: Readonly<Record<PropertyKey, unknown>>): void {
  const syncId = message.syncId;
  if (typeof syncId !== 'string') return;
  const staging = stagingMirrors.get(syncId);
  if (
    staging === undefined ||
    message.sessionId !== staging.sessionId ||
    message.projectionIdentity !== staging.projectionIdentity ||
    message.mirrorSequence !== staging.mirrorSequence ||
    message.digest !== staging.digest ||
    staging.strokes.length !== staging.strokeCount ||
    digestInkTileProjectionSlice(staging.strokes) !== staging.digest
  ) {
    stagingMirrors.delete(syncId);
    postMirrorFailure(syncId, 'digest-mismatch');
    return;
  }
  const mirror = Object.freeze({
    digest: staging.digest,
    mirrorSequence: staging.mirrorSequence,
    projectionIdentity: staging.projectionIdentity,
    sessionId: staging.sessionId,
    strokes: Object.freeze([...staging.strokes]),
  });
  readyMirrors.set(staging.projectionIdentity, mirror);
  stagingMirrors.delete(syncId);
  scope.postMessage({
    digest: mirror.digest,
    mirrorSequence: mirror.mirrorSequence,
    projectionIdentity: mirror.projectionIdentity,
    sessionId: mirror.sessionId,
    syncId,
    type: 'mirror-ack',
  });
}

function releaseMirror(message: Readonly<Record<PropertyKey, unknown>>): void {
  if (typeof message.projectionIdentity !== 'string') return;
  const mirror = readyMirrors.get(message.projectionIdentity);
  if (
    mirror !== undefined &&
    mirror.sessionId === message.sessionId &&
    mirror.mirrorSequence === message.mirrorSequence &&
    mirror.digest === message.digest
  ) {
    readyMirrors.delete(message.projectionIdentity);
  }
}

function startRaster(message: Readonly<Record<PropertyKey, unknown>>): void {
  if (running !== null) {
    postJobFailure(message.jobId, 'busy');
    return;
  }
  const decoded = decodeRasterJob(message);
  if (decoded === null) {
    postJobFailure(message.jobId, 'invalid-job');
    return;
  }
  try {
    const canvas = new OffscreenCanvas(decoded.backingWidth, decoded.backingHeight);
    const context = canvas.getContext('2d');
    if (context === null) {
      postJobFailure(decoded.jobId, 'context-unavailable');
      return;
    }
    context.setTransform(
      decoded.density,
      0,
      0,
      decoded.density,
      -decoded.originX * decoded.density,
      -decoded.originY * decoded.density,
    );
    running = { canvas, context, index: 0, input: decoded };
    scheduleRasterStep();
  } catch {
    postJobFailure(decoded.jobId, 'raster-failed');
  }
}

function scheduleRasterStep(): void {
  scope.setTimeout(runRasterStep, 0);
}

function runRasterStep(): void {
  const job = running;
  if (job === null || pausedLeaseCount > 0) return;
  if (cancelledJobs.delete(job.input.jobId)) {
    running = null;
    scope.postMessage({ jobId: job.input.jobId, type: 'cancelled' });
    return;
  }
  try {
    const stop = Math.min(job.input.strokes.length, job.index + RASTER_STROKE_BATCH_SIZE);
    while (job.index < stop) {
      const stroke = job.input.strokes[job.index];
      job.index += 1;
      if (stroke !== undefined && stroke.tool !== 'eraser') drawStroke(job.context, stroke);
    }
    if (job.index < job.input.strokes.length) {
      scheduleRasterStep();
      return;
    }
    const bitmap = job.canvas.transferToImageBitmap();
    running = null;
    scope.postMessage(
      {
        bitmap,
        generation: job.input.generation,
        jobId: job.input.jobId,
        token: job.input.token,
        type: 'raster-result',
      },
      [bitmap],
    );
  } catch {
    running = null;
    postJobFailure(job.input.jobId, 'raster-failed');
  }
}

function drawStroke(context: OffscreenCanvasRenderingContext2D, stroke: InkStroke): void {
  const compiled = geometry.compile(stroke);
  if (compiled.kind === 'unsupported') throw new Error('Unsupported Worker Brush Geometry.');
  drawInkBrushGeometryToCanvas(context as unknown as CanvasRenderingContext2D, compiled.geometry);
}

function physicalProbeStroke(tool: 'highlighter' | 'pen'): InkStroke {
  const highlighter = tool === 'highlighter';
  const y = highlighter ? 22 : 9;
  return {
    brushRenderVersion: highlighter ? 'highlighter-chisel-v1' : 'pen-physical-v1',
    color: highlighter ? '#20c060' : '#e03030',
    id: `probe-${tool}`,
    inputProfile: { pressure: 'measured', tilt: 'unavailable' },
    points: [
      {
        orientation: { kind: 'unavailable' },
        pressure: highlighter ? 0.7 : 0.4,
        pressureKind: 'measured',
        time: 0,
        x: highlighter ? 36 : 4,
        y,
      },
      {
        orientation: { kind: 'unavailable' },
        pressure: highlighter ? 0.7 : 0.85,
        pressureKind: 'measured',
        time: 12,
        x: highlighter ? 60 : 28,
        y,
      },
    ],
    tool,
    width: highlighter ? 10 : 7,
  };
}

function decodeRasterJob(message: Readonly<Record<PropertyKey, unknown>>): RasterJob | null {
  const projectionIdentity = message.projectionIdentity;
  const mirror =
    typeof projectionIdentity === 'string' ? readyMirrors.get(projectionIdentity) : undefined;
  if (
    typeof message.jobId !== 'string' ||
    message.jobId.length === 0 ||
    typeof message.token !== 'string' ||
    message.token.length === 0 ||
    !isPositiveSafeInteger(message.backingWidth) ||
    !isPositiveSafeInteger(message.backingHeight) ||
    !isPositiveFinite(message.density) ||
    !Number.isFinite(message.originX) ||
    !Number.isFinite(message.originY) ||
    !Number.isSafeInteger(message.generation) ||
    mirror === undefined ||
    message.sessionId !== mirror.sessionId ||
    message.projectionMirrorSequence !== mirror.mirrorSequence ||
    message.projectionDigest !== mirror.digest
  ) {
    return null;
  }
  return {
    backingHeight: message.backingHeight,
    backingWidth: message.backingWidth,
    density: message.density,
    generation: message.generation as number,
    jobId: message.jobId,
    originX: message.originX as number,
    originY: message.originY as number,
    projectionDigest: mirror.digest,
    projectionIdentity: mirror.projectionIdentity,
    projectionMirrorSequence: mirror.mirrorSequence,
    sessionId: mirror.sessionId,
    strokes: mirror.strokes,
    token: message.token,
  };
}

function postMirrorFailure(syncId: unknown, reason: string): void {
  if (typeof syncId === 'string') scope.postMessage({ reason, syncId, type: 'mirror-failed' });
}

function postFailure(requestId: string, reason: string): void {
  scope.postMessage({ reason, requestId, type: 'probe-failed' });
}

function postJobFailure(jobId: unknown, reason: string): void {
  if (typeof jobId === 'string') scope.postMessage({ jobId, reason, type: 'raster-failed' });
}

function asRecord(value: unknown): Readonly<Record<PropertyKey, unknown>> {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<PropertyKey, unknown>>)
    : Object.freeze({});
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
