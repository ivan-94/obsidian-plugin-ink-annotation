import type {
  InkContactAdapter,
  InkContactBatch,
  InkContactLogicalBounds,
  InkContactPhase,
  InkContactSample,
  InkContactStyleSnapshot,
  InkSampleCursor,
  InkSampleOrientation,
  InkSampleSequence,
  InkSensorReading,
} from '../domain/ink-contact';
import { INK_SAMPLE_FLAGS } from '../domain/ink-contact';
import {
  CausalLegacyInkReducer,
  type InkBorrowedControlTraceDelta,
  type InkLegacyControlTrace,
  type InkLegacyTraceDelta,
} from '../domain/ink-control-trace';
import type { InkStroke } from '../domain/ink-surface';
import type { InkStageFrame } from './ink-stage-frame';

export interface InkCaptureBatchContext {
  readonly frame: InkStageFrame;
  readonly frameEpoch: number;
  readonly logicalBounds: InkContactLogicalBounds;
  readonly style: InkContactStyleSnapshot;
}

export interface PointerInkEventLike {
  readonly altitudeAngle: number | undefined;
  readonly azimuthAngle: number | undefined;
  readonly clientX: number;
  readonly clientY: number;
  getCoalescedEvents?(): readonly PointerInkEventLike[];
  getPredictedEvents?(): readonly PointerInkEventLike[];
  readonly pointerId: number;
  readonly pointerType: string;
  readonly pressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
  readonly timeStamp: number;
}

export interface InkBorrowedProvisionalTail {
  readonly frameEpoch: number;
  readonly kind: 'borrowed-provisional-prediction-tail';
  readonly length: number;
  forEachPoint(consumer: (x: number, y: number) => void): void;
}

export interface WebKitStylusTouchLike {
  readonly altitudeAngle?: number;
  readonly azimuthAngle?: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly force: number;
  readonly identifier: number;
  readonly touchType?: string;
}

export interface WebKitStylusTouchEventLike {
  readonly changedTouches: ArrayLike<WebKitStylusTouchLike>;
  readonly timeStamp: number;
}

const MAXIMUM_PREDICTED_POINT_COUNT = 16;
const POINTER_CAUSAL_TAIL_CAPACITY = 8;
const POINTER_CAUSAL_SAMPLE_STRIDE = 8;

export type PointerInkAdmissionKind = 'accepted' | 'ignored' | 'invalid';

interface PointerContactWatermark {
  length: number;
  readonly values: Float64Array;
}

class BorrowedProvisionalTail implements InkBorrowedProvisionalTail {
  readonly kind = 'borrowed-provisional-prediction-tail' as const;

  constructor(
    readonly frameEpoch: number,
    private readonly read: () => { readonly length: number; readonly xy: Float64Array },
  ) {}

  get length(): number {
    return this.read().length;
  }

  forEachPoint(consumer: (x: number, y: number) => void): void {
    const { length, xy } = this.read();
    for (let index = 0; index < length; index += 1) {
      consumer(xy[index * 2] as number, xy[index * 2 + 1] as number);
    }
  }
}

export class PointerEventInkAdapter {
  private readonly contactWatermarks = new Map<string, PointerContactWatermark>();
  private lastAdmission: PointerInkAdmissionKind = 'ignored';
  private lastCausalRepair: 'front-loaded-parent' | null = null;
  private lastOverlapDropped = 0;
  private predictionEpoch = 0;
  private predictionLength = 0;
  private readonly predictionPoint = { x: 0, y: 0 };
  private readonly predictionXY = new Float64Array(MAXIMUM_PREDICTED_POINT_COUNT * 2);

  createBatch(
    event: PointerInkEventLike,
    phase: InkContactPhase,
    context: InkCaptureBatchContext,
  ): InkContactBatch | null {
    this.predictionEpoch += 1;
    this.predictionLength = 0;
    this.lastAdmission = 'ignored';
    this.lastCausalRepair = null;
    this.lastOverlapDropped = 0;
    if (event.pointerType === 'touch') return null;
    const source = event.getCoalescedEvents?.() ?? [];
    // A trusted pointermove parent summarizes the confirmed coalesced samples and may be
    // display-aligned by the browser. Consuming both introduces an artificial excursion from the
    // last raw sample to the processed parent, then back to the next raw batch (visible as a long
    // connector after a stalled frame). Non-move events have no trusted coalesced list, so their
    // down/up endpoint remains the parent event.
    const hasCoalescedMove = phase === 'move' && source.length > 0;
    let validCoalescedMove = hasCoalescedMove;
    for (let index = 0; validCoalescedMove && index < source.length; index += 1) {
      validCoalescedMove = validCoalescedSample(source[index], event);
    }
    if (
      (hasCoalescedMove && !validCoalescedMove) ||
      (!hasCoalescedMove && !validCoalescedSample(event, event))
    ) {
      this.lastAdmission = 'invalid';
      this.contactWatermarks.delete(pointerContactKey(event));
      return null;
    }
    const sourceRotation = validCoalescedMove && hasFrontLoadedDisplayParent(event, source) ? 1 : 0;
    if (sourceRotation === 1) this.lastCausalRepair = 'front-loaded-parent';
    const sourceStart = validCoalescedMove
      ? this.coalescedSourceStart(event, source, sourceRotation)
      : 0;
    this.lastOverlapDropped = sourceStart;
    const useParent = !hasCoalescedMove;
    const sequenceLength = validCoalescedMove ? source.length - sourceStart : useParent ? 1 : 0;
    if (phase === 'move' && validCoalescedMove && sequenceLength === 0) return null;
    const clientPoint = { x: 0, y: 0 };
    const sequence = new BorrowedInkSampleSequence(sequenceLength, (index, target) => {
      const sample = validCoalescedMove
        ? orderedCoalescedSample(source, sourceStart + index, sourceRotation)
        : event;
      if (sample === undefined) throw new Error('Ink Pointer sample sequence is inconsistent.');
      normalizePointerSampleInto(sample, event.pointerType, context, clientPoint, target);
    });
    if (phase === 'down') {
      this.contactWatermarks.set(pointerContactKey(event), createWatermark(event));
    } else if (phase === 'move') {
      const watermark = this.contactWatermarks.get(pointerContactKey(event));
      if (watermark !== undefined) {
        if (validCoalescedMove) updateWatermarkTail(watermark, source, sourceStart, sourceRotation);
        else if (useParent) updateWatermarkTailWithParent(watermark, event);
      }
    } else if (phase === 'up' || phase === 'cancel') {
      this.contactWatermarks.delete(pointerContactKey(event));
    }
    this.lastAdmission = 'accepted';
    const pressureMeasured = event.pointerType === 'pen' && Number.isFinite(event.pressure);
    const orientationMeasured = event.pointerType === 'pen' && hasPointerOrientation(event);
    return freezeBatch({
      adapter: 'pointer',
      capabilities: {
        orientation: orientationMeasured ? 'measured' : 'unavailable',
        pressure: pressureMeasured ? 'measured' : 'unavailable',
      },
      contactId: `pointer:${event.pointerId}`,
      context,
      phase,
      sampleSequence: sequence,
    });
  }

  private coalescedSourceStart(
    event: PointerInkEventLike,
    source: readonly PointerInkEventLike[],
    sourceRotation: number,
  ): number {
    const watermark = this.contactWatermarks.get(pointerContactKey(event));
    if (watermark === undefined) return 0;
    const maximumOverlap = Math.min(watermark.length, source.length);
    for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
      const watermarkStart = watermark.length - overlap;
      let matches = true;
      for (let index = 0; index < overlap; index += 1) {
        if (
          !sameWatermarkedPointerSample(
            orderedCoalescedSample(source, index, sourceRotation),
            watermark,
            watermarkStart + index,
          )
        ) {
          matches = false;
          break;
        }
      }
      if (matches) return overlap;
    }
    // Native timestamps are not a causal watermark: WebKit may reset or move them backward while
    // the contact remains valid. Only an exact old-tail/new-prefix sequence proves overlap.
    return 0;
  }

  get lastAdmissionKind(): PointerInkAdmissionKind {
    return this.lastAdmission;
  }

  get lastCausalRepairKind(): 'front-loaded-parent' | null {
    return this.lastCausalRepair;
  }

  get lastOverlapDroppedSampleCount(): number {
    return this.lastOverlapDropped;
  }

  createProvisionalTail(
    event: PointerInkEventLike,
    context: InkCaptureBatchContext,
  ): InkBorrowedProvisionalTail | null {
    const epoch = ++this.predictionEpoch;
    this.predictionLength = 0;
    try {
      if (event.pointerType !== 'pen' || typeof event.getPredictedEvents !== 'function')
        return null;
      const source: unknown = event.getPredictedEvents();
      if (!isPointerInkEventSequence(source) || source.length === 0) return null;
      const length = Math.min(source.length, MAXIMUM_PREDICTED_POINT_COUNT);
      let previousTime = event.timeStamp;
      for (let index = 0; index < length; index += 1) {
        const sample = source[index];
        if (
          sample === undefined ||
          sample.pointerId !== event.pointerId ||
          sample.pointerType !== event.pointerType ||
          !Number.isFinite(sample.clientX) ||
          !Number.isFinite(sample.clientY) ||
          !Number.isFinite(sample.timeStamp) ||
          sample.timeStamp < previousTime
        ) {
          return null;
        }
        this.predictionPoint.x = sample.clientX;
        this.predictionPoint.y = sample.clientY;
        context.frame.clientToLogicalInto(this.predictionPoint, this.predictionPoint);
        const x = this.predictionPoint.x;
        const y = clamp(
          this.predictionPoint.y,
          context.logicalBounds.y,
          context.logicalBounds.y + context.logicalBounds.height,
        );
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        this.predictionXY[index * 2] = x;
        this.predictionXY[index * 2 + 1] = y;
        previousTime = sample.timeStamp;
      }
      this.predictionLength = length;
    } catch {
      this.predictionLength = 0;
      return null;
    }
    return new BorrowedProvisionalTail(context.frameEpoch, () => {
      if (epoch !== this.predictionEpoch) {
        throw new Error('Borrowed Ink prediction tail is no longer current.');
      }
      return { length: this.predictionLength, xy: this.predictionXY };
    });
  }
}

export class WebKitStylusTouchAdapter {
  createBatch(
    event: WebKitStylusTouchEventLike,
    phase: InkContactPhase,
    context: InkCaptureBatchContext,
  ): InkContactBatch | null {
    const touch = findStylusTouch(event.changedTouches);
    if (touch === null) return null;
    const orientationMeasured = hasTouchOrientation(touch);
    const pressureMeasured = Number.isFinite(touch.force);
    const clientPoint = { x: 0, y: 0 };
    const sequence = new BorrowedInkSampleSequence(1, (_index, target) => {
      normalizeTouchSampleInto(touch, event.timeStamp, context, clientPoint, target);
    });
    return freezeBatch({
      adapter: 'stylus-touch',
      capabilities: {
        orientation: orientationMeasured ? 'measured' : 'unavailable',
        pressure: pressureMeasured ? 'measured' : 'unavailable',
      },
      contactId: `stylus-touch:${touch.identifier}`,
      context,
      phase,
      sampleSequence: sequence,
    });
  }
}

export type InkContactArbitration = 'accepted' | 'duplicate-adapter' | 'inactive-contact';

export class InkContactArbiter {
  private owner: { readonly adapter: InkContactAdapter; readonly contactId: string } | null = null;

  accept(batch: InkContactBatch): InkContactArbitration {
    if (batch.phase === 'down') {
      if (this.owner === null) {
        this.owner = { adapter: batch.adapter, contactId: batch.contactId };
        return 'accepted';
      }
      return this.owner.adapter === batch.adapter && this.owner.contactId === batch.contactId
        ? 'inactive-contact'
        : 'duplicate-adapter';
    }
    if (
      this.owner === null ||
      this.owner.adapter !== batch.adapter ||
      this.owner.contactId !== batch.contactId
    ) {
      return this.owner?.adapter !== batch.adapter ? 'duplicate-adapter' : 'inactive-contact';
    }
    if (batch.phase === 'up' || batch.phase === 'cancel') this.owner = null;
    return 'accepted';
  }

  reset(): void {
    this.owner = null;
  }
}

export type InkCaptureResult =
  | {
      readonly frameEpoch: number;
      readonly kind: 'active';
      readonly presentationDelta: InkBorrowedControlTraceDelta;
      readonly strokeId: string;
      readonly style: InkContactStyleSnapshot;
    }
  | { readonly kind: 'cancelled'; readonly strokeId: string }
  | {
      readonly bounds: {
        readonly height: number;
        readonly width: number;
        readonly x: number;
        readonly y: number;
      };
      readonly delta: InkLegacyTraceDelta;
      readonly kind: 'completed';
      readonly presentationDelta: InkBorrowedControlTraceDelta;
      readonly stroke: InkStroke;
      readonly trace: InkLegacyControlTrace;
    }
  | {
      readonly kind: 'ignored';
      readonly reason: InkContactArbitration;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'trace-too-large';
      readonly strokeId: string;
    };

interface ActiveCapture {
  readonly id: string;
  readonly reducer: CausalLegacyInkReducer;
  readonly style: InkContactStyleSnapshot;
}

export class InkCapturePipeline {
  private active: ActiveCapture | null = null;
  private readonly arbiter = new InkContactArbiter();
  private readonly createId: () => string;
  private readonly maximumTracePoints: number;

  constructor(
    input: { readonly createId?: () => string; readonly maximumTracePoints?: number } = {},
  ) {
    this.createId = input.createId ?? (() => globalThis.crypto.randomUUID());
    this.maximumTracePoints = input.maximumTracePoints ?? 200_000;
    if (!Number.isInteger(this.maximumTracePoints) || this.maximumTracePoints <= 0) {
      throw new Error('Ink maximum trace point count must be a positive integer.');
    }
  }

  accept(batch: InkContactBatch): InkCaptureResult {
    const arbitration = this.arbiter.accept(batch);
    if (arbitration !== 'accepted') return { kind: 'ignored', reason: arbitration };
    if (batch.phase === 'down') {
      const active: ActiveCapture = {
        id: this.createId(),
        reducer: new CausalLegacyInkReducer(),
        style: Object.freeze({ ...batch.style }),
      };
      this.active = active;
      return Object.freeze({
        frameEpoch: batch.frameEpoch,
        kind: 'active',
        presentationDelta: active.reducer.extendSequence(batch.sampleSequence),
        strokeId: active.id,
        style: active.style,
      });
    }
    const active = this.active;
    if (active === null) return { kind: 'ignored', reason: 'inactive-contact' };
    if (batch.phase === 'cancel') {
      this.active = null;
      return Object.freeze({ kind: 'cancelled', strokeId: active.id });
    }
    const presentationDelta = active.reducer.extendSequence(batch.sampleSequence);
    if (batch.phase === 'move') {
      return Object.freeze({
        frameEpoch: batch.frameEpoch,
        kind: 'active',
        presentationDelta,
        strokeId: active.id,
        style: active.style,
      });
    }
    return this.completeActive(active);
  }

  /** Seals the confirmed prefix before a forced Stage Frame replacement. */
  sealActive(): InkCaptureResult {
    const active = this.active;
    if (active === null) return { kind: 'ignored', reason: 'inactive-contact' };
    this.arbiter.reset();
    return this.completeActive(active);
  }

  private completeActive(active: ActiveCapture): InkCaptureResult {
    const completed = active.reducer.finalizeSequence();
    const {
      delta: completionDelta,
      presentationDelta: completionPresentationDelta,
      trace,
    } = completed;
    this.active = null;
    const stroke: InkStroke = Object.freeze({
      color: active.style.color,
      id: active.id,
      points: trace.points,
      tool: active.style.tool,
      width: active.style.width,
    });
    if (trace.points.length > this.maximumTracePoints) {
      return Object.freeze({
        kind: 'rejected',
        reason: 'trace-too-large',
        strokeId: active.id,
      });
    }
    return Object.freeze({
      bounds: active.reducer.bounds(active.style.width),
      delta: completionDelta,
      kind: 'completed',
      presentationDelta: completionPresentationDelta,
      stroke,
      trace,
    });
  }

  cancelActive(): void {
    this.active = null;
    this.arbiter.reset();
  }

  reset(): void {
    this.cancelActive();
  }
}

class BorrowedInkSampleSequence implements InkSampleSequence {
  readonly copiedNativeSampleCount = 0;
  private materialized: readonly InkContactSample[] | null = null;
  private readonly cursor: InkSampleCursor = {
    altitude: 0,
    azimuth: 0,
    flags: 0,
    pressure: 0,
    time: 0,
    x: 0,
    y: 0,
  };

  constructor(
    readonly length: number,
    private readonly readInto: (index: number, target: InkSampleCursor) => void,
  ) {}

  get materializedSampleCount(): number {
    return this.materialized?.length ?? 0;
  }

  forEachSample(consumer: (sample: InkSampleCursor) => void): void {
    for (let index = 0; index < this.length; index += 1) {
      this.readInto(index, this.cursor);
      consumer(this.cursor);
    }
  }

  materialize(): readonly InkContactSample[] {
    if (this.materialized !== null) return this.materialized;
    const samples: InkContactSample[] = [];
    this.forEachSample((sample) => samples.push(materializeSample(sample)));
    this.materialized = Object.freeze(samples);
    return this.materialized;
  }
}

interface BatchInput {
  readonly adapter: InkContactAdapter;
  readonly capabilities: InkContactBatch['capabilities'];
  readonly contactId: string;
  readonly context: InkCaptureBatchContext;
  readonly phase: InkContactPhase;
  readonly sampleSequence: InkSampleSequence;
}

function freezeBatch(input: BatchInput): InkContactBatch {
  const sequence = input.sampleSequence;
  const logicalBounds = Object.isFrozen(input.context.logicalBounds)
    ? input.context.logicalBounds
    : Object.freeze({ ...input.context.logicalBounds });
  const style = Object.isFrozen(input.context.style)
    ? input.context.style
    : Object.freeze({ ...input.context.style });
  return Object.freeze({
    adapter: input.adapter,
    capabilities: Object.freeze({ ...input.capabilities }),
    contactId: input.contactId,
    frameEpoch: input.context.frameEpoch,
    logicalBounds,
    phase: input.phase,
    sampleCount: sequence.length,
    sampleSequence: sequence,
    get samples(): readonly InkContactSample[] {
      return sequence.materialize();
    },
    style,
  });
}

function normalizePointerSampleInto(
  sample: PointerInkEventLike,
  pointerType: string,
  context: InkCaptureBatchContext,
  clientPoint: { x: number; y: number },
  target: InkSampleCursor,
): void {
  target.flags = 0;
  target.pressure = 0;
  target.altitude = 0;
  target.azimuth = 0;
  if (pointerType === 'pen' && Number.isFinite(sample.pressure)) {
    target.pressure = clamp(sample.pressure, 0, 1);
    target.flags |= INK_SAMPLE_FLAGS.pressureMeasured;
  }
  if (pointerType === 'pen') writePointerOrientation(sample, target);
  writeLogicalPosition(
    sample.clientX,
    sample.clientY,
    sample.timeStamp,
    context,
    clientPoint,
    target,
  );
}

function normalizeTouchSampleInto(
  touch: WebKitStylusTouchLike,
  timeStamp: number,
  context: InkCaptureBatchContext,
  clientPoint: { x: number; y: number },
  target: InkSampleCursor,
): void {
  target.flags = 0;
  target.pressure = 0;
  target.altitude = 0;
  target.azimuth = 0;
  if (Number.isFinite(touch.force)) {
    target.pressure = clamp(touch.force, 0, 1);
    target.flags |= INK_SAMPLE_FLAGS.pressureMeasured;
  }
  if (hasTouchOrientation(touch)) {
    target.altitude = clamp(touch.altitudeAngle as number, 0, Math.PI / 2);
    target.azimuth = normalizeAzimuth(touch.azimuthAngle as number);
    target.flags |= INK_SAMPLE_FLAGS.altitudeMeasured | INK_SAMPLE_FLAGS.azimuthMeasured;
  }
  writeLogicalPosition(touch.clientX, touch.clientY, timeStamp, context, clientPoint, target);
}

function writeLogicalPosition(
  clientX: number,
  clientY: number,
  timeStamp: number,
  context: InkCaptureBatchContext,
  clientPoint: { x: number; y: number },
  target: InkSampleCursor,
): void {
  clientPoint.x = clientX;
  clientPoint.y = clientY;
  context.frame.clientToLogicalInto(clientPoint, target);
  target.y = clamp(
    target.y,
    context.logicalBounds.y,
    context.logicalBounds.y + context.logicalBounds.height,
  );
  target.time = timeStamp;
}

function materializeSample(sample: InkSampleCursor): InkContactSample {
  const reading = (value: number, flag: number): InkSensorReading =>
    (sample.flags & flag) === 0 ? unavailable() : measured(value);
  return Object.freeze({
    orientation: Object.freeze({
      altitude: reading(sample.altitude, INK_SAMPLE_FLAGS.altitudeMeasured),
      azimuth: reading(sample.azimuth, INK_SAMPLE_FLAGS.azimuthMeasured),
    }),
    pressure: reading(sample.pressure, INK_SAMPLE_FLAGS.pressureMeasured),
    time: sample.time,
    x: sample.x,
    y: sample.y,
  });
}

function isPointerInkEventSequence(value: unknown): value is readonly PointerInkEventLike[] {
  return Array.isArray(value);
}

function validCoalescedSample(
  sample: PointerInkEventLike | undefined,
  parent: PointerInkEventLike,
): boolean {
  return (
    sample !== undefined &&
    sample.pointerId === parent.pointerId &&
    sample.pointerType === parent.pointerType &&
    Number.isFinite(sample.clientX) &&
    Number.isFinite(sample.clientY) &&
    Number.isFinite(sample.timeStamp)
  );
}

function hasFrontLoadedDisplayParent(
  parent: PointerInkEventLike,
  source: readonly PointerInkEventLike[],
): boolean {
  const first = source[0];
  const firstRaw = source[1];
  if (
    first === undefined ||
    firstRaw === undefined ||
    !samePointerInkSample(first, parent) ||
    firstRaw.timeStamp > first.timeStamp
  ) {
    return false;
  }
  let previousTime = firstRaw.timeStamp;
  for (let index = 2; index < source.length; index += 1) {
    const sample = source[index];
    if (
      sample === undefined ||
      sample.timeStamp < previousTime ||
      sample.timeStamp > first.timeStamp
    )
      return false;
    previousTime = sample.timeStamp;
  }
  return true;
}

function orderedCoalescedSample(
  source: readonly PointerInkEventLike[],
  index: number,
  rotation: number,
): PointerInkEventLike | undefined {
  if (source.length === 0) return undefined;
  return source[(index + rotation) % source.length];
}

function samePointerInkSample(left: PointerInkEventLike, right: PointerInkEventLike): boolean {
  return (
    left.pointerId === right.pointerId &&
    left.pointerType === right.pointerType &&
    left.clientX === right.clientX &&
    left.clientY === right.clientY &&
    left.timeStamp === right.timeStamp &&
    Object.is(left.pressure, right.pressure) &&
    Object.is(left.tiltX, right.tiltX) &&
    Object.is(left.tiltY, right.tiltY) &&
    Object.is(left.altitudeAngle ?? Number.NaN, right.altitudeAngle ?? Number.NaN) &&
    Object.is(left.azimuthAngle ?? Number.NaN, right.azimuthAngle ?? Number.NaN)
  );
}

function createWatermark(event: PointerInkEventLike): PointerContactWatermark {
  const watermark = {
    length: 1,
    values: new Float64Array(POINTER_CAUSAL_TAIL_CAPACITY * POINTER_CAUSAL_SAMPLE_STRIDE),
  };
  writeWatermarkedPointerSample(watermark, 0, event);
  return watermark;
}

function pointerContactKey(event: PointerInkEventLike): string {
  return `${event.pointerType}\u0000${event.pointerId}`;
}

function updateWatermarkTail(
  target: PointerContactWatermark,
  source: readonly PointerInkEventLike[],
  sourceStart: number,
  sourceRotation: number,
): void {
  const admittedCount = source.length - sourceStart;
  if (admittedCount <= 0) return;
  if (admittedCount >= POINTER_CAUSAL_TAIL_CAPACITY) {
    const retainedStart = source.length - POINTER_CAUSAL_TAIL_CAPACITY;
    for (let index = 0; index < POINTER_CAUSAL_TAIL_CAPACITY; index += 1) {
      const sample = orderedCoalescedSample(source, retainedStart + index, sourceRotation);
      if (sample !== undefined) writeWatermarkedPointerSample(target, index, sample);
    }
    target.length = POINTER_CAUSAL_TAIL_CAPACITY;
    return;
  }
  const retainedOldCount = Math.min(target.length, POINTER_CAUSAL_TAIL_CAPACITY - admittedCount);
  const retainedOldStart = target.length - retainedOldCount;
  if (retainedOldStart > 0) {
    target.values.copyWithin(
      0,
      retainedOldStart * POINTER_CAUSAL_SAMPLE_STRIDE,
      target.length * POINTER_CAUSAL_SAMPLE_STRIDE,
    );
  }
  for (let index = 0; index < admittedCount; index += 1) {
    const sample = orderedCoalescedSample(source, sourceStart + index, sourceRotation);
    if (sample !== undefined) {
      writeWatermarkedPointerSample(target, retainedOldCount + index, sample);
    }
  }
  target.length = retainedOldCount + admittedCount;
}

function updateWatermarkTailWithParent(
  target: PointerContactWatermark,
  event: PointerInkEventLike,
): void {
  if (target.length < POINTER_CAUSAL_TAIL_CAPACITY) {
    writeWatermarkedPointerSample(target, target.length, event);
    target.length += 1;
    return;
  }
  target.values.copyWithin(
    0,
    POINTER_CAUSAL_SAMPLE_STRIDE,
    POINTER_CAUSAL_TAIL_CAPACITY * POINTER_CAUSAL_SAMPLE_STRIDE,
  );
  writeWatermarkedPointerSample(target, POINTER_CAUSAL_TAIL_CAPACITY - 1, event);
}

function writeWatermarkedPointerSample(
  target: PointerContactWatermark,
  index: number,
  sample: PointerInkEventLike,
): void {
  const offset = index * POINTER_CAUSAL_SAMPLE_STRIDE;
  target.values[offset] = sample.clientX;
  target.values[offset + 1] = sample.clientY;
  target.values[offset + 2] = sample.timeStamp;
  target.values[offset + 3] = sample.pressure;
  target.values[offset + 4] = sample.tiltX;
  target.values[offset + 5] = sample.tiltY;
  target.values[offset + 6] = sample.altitudeAngle ?? Number.NaN;
  target.values[offset + 7] = sample.azimuthAngle ?? Number.NaN;
}

function sameWatermarkedPointerSample(
  sample: PointerInkEventLike | undefined,
  expected: PointerContactWatermark,
  expectedIndex: number,
): boolean {
  const offset = expectedIndex * POINTER_CAUSAL_SAMPLE_STRIDE;
  return (
    sample !== undefined &&
    sample.clientX === expected.values[offset] &&
    sample.clientY === expected.values[offset + 1] &&
    sample.timeStamp === expected.values[offset + 2] &&
    Object.is(sample.pressure, expected.values[offset + 3]) &&
    Object.is(sample.tiltX, expected.values[offset + 4]) &&
    Object.is(sample.tiltY, expected.values[offset + 5]) &&
    Object.is(sample.altitudeAngle ?? Number.NaN, expected.values[offset + 6]) &&
    Object.is(sample.azimuthAngle ?? Number.NaN, expected.values[offset + 7])
  );
}

function hasPointerOrientation(sample: PointerInkEventLike): boolean {
  return (
    (Number.isFinite(sample.altitudeAngle) && Number.isFinite(sample.azimuthAngle)) ||
    (Number.isFinite(sample.tiltX) && Number.isFinite(sample.tiltY))
  );
}

function writePointerOrientation(sample: PointerInkEventLike, target: InkSampleCursor): void {
  if (Number.isFinite(sample.altitudeAngle) && Number.isFinite(sample.azimuthAngle)) {
    target.altitude = clamp(sample.altitudeAngle as number, 0, Math.PI / 2);
    target.azimuth = normalizeAzimuth(sample.azimuthAngle as number);
    target.flags |= INK_SAMPLE_FLAGS.altitudeMeasured | INK_SAMPLE_FLAGS.azimuthMeasured;
    return;
  }
  if (!Number.isFinite(sample.tiltX) || !Number.isFinite(sample.tiltY)) return;
  writeTiltOrientation(sample.tiltX, sample.tiltY, target);
}

function hasTouchOrientation(touch: WebKitStylusTouchLike): boolean {
  return Number.isFinite(touch.altitudeAngle) && Number.isFinite(touch.azimuthAngle);
}

/** W3C Pointer Events tilt-to-spherical conversion in note-logical screen orientation. */
export function tiltToOrientation(tiltX: number, tiltY: number): InkSampleOrientation {
  const target = { altitude: 0, azimuth: 0, flags: 0 };
  writeTiltOrientation(tiltX, tiltY, target);
  return measuredOrientation(target.altitude, target.azimuth);
}

function writeTiltOrientation(
  tiltX: number,
  tiltY: number,
  target: Pick<InkSampleCursor, 'altitude' | 'azimuth' | 'flags'>,
): void {
  const boundedX = clamp(tiltX, -90, 90);
  const boundedY = clamp(tiltY, -90, 90);
  const x = (boundedX * Math.PI) / 180;
  const y = (boundedY * Math.PI) / 180;
  let azimuth = 0;
  if (boundedX === 0) {
    if (boundedY > 0) azimuth = Math.PI / 2;
    else if (boundedY < 0) azimuth = (3 * Math.PI) / 2;
  } else if (boundedY === 0) {
    if (boundedX < 0) azimuth = Math.PI;
  } else if (Math.abs(boundedX) !== 90 && Math.abs(boundedY) !== 90) {
    azimuth = normalizeAzimuth(Math.atan2(Math.tan(y), Math.tan(x)));
  }
  let altitude: number;
  if (Math.abs(boundedX) === 90 || Math.abs(boundedY) === 90) altitude = 0;
  else if (boundedX === 0) altitude = Math.PI / 2 - Math.abs(y);
  else if (boundedY === 0) altitude = Math.PI / 2 - Math.abs(x);
  else {
    altitude = Math.atan(1 / Math.sqrt(Math.tan(x) ** 2 + Math.tan(y) ** 2));
  }
  target.altitude = altitude;
  target.azimuth = azimuth;
  target.flags |= INK_SAMPLE_FLAGS.altitudeMeasured | INK_SAMPLE_FLAGS.azimuthMeasured;
}

function measuredOrientation(altitude: number, azimuth: number): InkSampleOrientation {
  return Object.freeze({
    altitude: measured(clamp(altitude, 0, Math.PI / 2)),
    azimuth: measured(normalizeAzimuth(azimuth)),
  });
}

function measured(value: number): InkSensorReading {
  return Object.freeze({ kind: 'measured', value });
}

function unavailable(): InkSensorReading {
  return Object.freeze({ kind: 'unavailable' });
}

function normalizeAzimuth(value: number): number {
  const full = Math.PI * 2;
  const normalized = value % full;
  return normalized < 0 ? normalized + full : normalized;
}

function findStylusTouch(touches: ArrayLike<WebKitStylusTouchLike>): WebKitStylusTouchLike | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (touch?.touchType === 'stylus') return touch;
  }
  return null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
