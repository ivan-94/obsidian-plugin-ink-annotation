import {
  INK_SAMPLE_FLAGS,
  type InkContactSample,
  type InkSampleCursor,
  type InkSampleSequence,
  type InkSampleView,
  type InkSensorReading,
} from './ink-contact';
import type { InkPoint } from './ink-surface';

export const FOUNDATION_LEGACY_TRACE_LIMITS = Object.freeze({
  maximumArcGap: 6,
  maximumMutableTailSamples: 8,
  maximumTimeGapMs: 32,
  orientationExtremumEpsilon: 0.01,
  pressureExtremumEpsilon: 0.02,
  xyError: 0.8,
});

export interface InkLegacyTraceDelta {
  readonly mutableTail: readonly InkPoint[];
  readonly stablePrefixDelta: readonly InkPoint[];
}

/**
 * Numeric presentation delta borrowed from one reducer epoch. It is valid only until that reducer's
 * next mutation; consumers must synchronously copy every cursor they retain.
 */
export interface InkBorrowedControlTraceDelta {
  readonly kind: 'borrowed-numeric';
  readonly mutableTail: InkSampleView;
  readonly stablePrefixDelta: InkSampleView;
}

export interface InkFinalizedControlTraceUpdate {
  readonly delta: InkLegacyTraceDelta;
  readonly presentationDelta: InkBorrowedControlTraceDelta;
  readonly trace: InkLegacyControlTrace;
}

export interface InkLegacyControlTrace {
  readonly points: readonly InkPoint[];
  readonly rawSampleCount: number;
  readonly samples: readonly InkContactSample[];
}

export class ChunkedInkSampleBuffer {
  private readonly chunks: InkContactSample[][] = [];
  readonly copiedSampleCount = 0;
  private itemCount = 0;

  constructor(private readonly chunkSize = 256) {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new Error('Ink sample chunk size must be a positive integer.');
    }
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  get length(): number {
    return this.itemCount;
  }

  append(sample: InkContactSample): void {
    let chunk = this.chunks.at(-1);
    if (chunk === undefined || chunk.length === this.chunkSize) {
      chunk = [];
      this.chunks.push(chunk);
    }
    chunk.push(sample);
    this.itemCount += 1;
  }

  at(index: number): InkContactSample | undefined {
    const normalized = index < 0 ? this.itemCount + index : index;
    if (normalized < 0 || normalized >= this.itemCount) return undefined;
    return this.chunks[Math.floor(normalized / this.chunkSize)]?.[normalized % this.chunkSize];
  }

  toArray(): InkContactSample[] {
    const result: InkContactSample[] = [];
    for (const chunk of this.chunks) result.push(...chunk);
    return result;
  }
}

const NUMERIC_SAMPLE_WIDTH = 6;
const KNOWN_SAMPLE_FLAGS =
  INK_SAMPLE_FLAGS.pressureMeasured |
  INK_SAMPLE_FLAGS.altitudeMeasured |
  INK_SAMPLE_FLAGS.azimuthMeasured;
const ORIENTATION_SENSOR_FIELDS = [
  ['altitude', INK_SAMPLE_FLAGS.altitudeMeasured],
  ['azimuth', INK_SAMPLE_FLAGS.azimuthMeasured],
] as const;
const COMPACTION_SENSOR_FIELDS = [
  ['pressure', INK_SAMPLE_FLAGS.pressureMeasured],
  ...ORIENTATION_SENSOR_FIELDS,
] as const;

const MUTABLE_TAIL_BUFFER_CAPACITY = FOUNDATION_LEGACY_TRACE_LIMITS.maximumMutableTailSamples + 1;

type NumericInkSampleCursor = InkSampleCursor;

/** Retains causal samples in fixed numeric chunks; nested sensor objects exist only at a cold seam. */
class ChunkedNumericInkSampleBuffer {
  private readonly chunks: Float64Array[] = [];
  private readonly flags: Uint8Array[] = [];
  private itemCount = 0;

  constructor(private readonly chunkSize = 256) {}

  get chunkCount(): number {
    return this.chunks.length;
  }

  get length(): number {
    return this.itemCount;
  }

  append(sample: InkSampleCursor): void {
    const chunkIndex = Math.floor(this.itemCount / this.chunkSize);
    const itemIndex = this.itemCount % this.chunkSize;
    let chunk = this.chunks[chunkIndex];
    let flagChunk = this.flags[chunkIndex];
    if (chunk === undefined || flagChunk === undefined) {
      chunk = new Float64Array(this.chunkSize * NUMERIC_SAMPLE_WIDTH);
      flagChunk = new Uint8Array(this.chunkSize);
      this.chunks.push(chunk);
      this.flags.push(flagChunk);
    }
    const offset = itemIndex * NUMERIC_SAMPLE_WIDTH;
    chunk[offset] = sample.x;
    chunk[offset + 1] = sample.y;
    chunk[offset + 2] = sample.time;
    chunk[offset + 3] = sample.pressure;
    chunk[offset + 4] = sample.altitude;
    chunk[offset + 5] = sample.azimuth;
    flagChunk[itemIndex] = sample.flags & KNOWN_SAMPLE_FLAGS;
    this.itemCount += 1;
  }

  readInto(index: number, target: NumericInkSampleCursor): NumericInkSampleCursor | undefined {
    const normalized = index < 0 ? this.itemCount + index : index;
    if (normalized < 0 || normalized >= this.itemCount) return undefined;
    const chunkIndex = Math.floor(normalized / this.chunkSize);
    const itemIndex = normalized % this.chunkSize;
    const chunk = this.chunks[chunkIndex];
    const flags = this.flags[chunkIndex]?.[itemIndex];
    if (chunk === undefined || flags === undefined) return undefined;
    const offset = itemIndex * NUMERIC_SAMPLE_WIDTH;
    target.x = chunk[offset] as number;
    target.y = chunk[offset + 1] as number;
    target.time = chunk[offset + 2] as number;
    target.pressure = chunk[offset + 3] as number;
    target.altitude = chunk[offset + 4] as number;
    target.azimuth = chunk[offset + 5] as number;
    target.flags = flags;
    return target;
  }

  toArray(): InkContactSample[] {
    const cursor = createNumericSampleCursor();
    return Array.from({ length: this.itemCount }, (_value, index) => {
      const sample = this.readInto(index, cursor);
      if (sample === undefined) throw new Error('Ink numeric sample storage is inconsistent.');
      return materializeFlatSample(sample);
    });
  }
}

/** Fixed numeric admission buffer. One extra slot permits reduce-after-append without growth. */
class FixedNumericInkSampleBuffer {
  private readonly flags = new Uint8Array(MUTABLE_TAIL_BUFFER_CAPACITY);
  private itemCount = 0;
  private readonly values = new Float64Array(MUTABLE_TAIL_BUFFER_CAPACITY * NUMERIC_SAMPLE_WIDTH);

  get length(): number {
    return this.itemCount;
  }

  append(sample: InkSampleCursor, time: number): void {
    if (this.itemCount >= MUTABLE_TAIL_BUFFER_CAPACITY) {
      throw new Error('Ink mutable tail exceeded its fixed numeric admission capacity.');
    }
    writeNumericSample(this.values, this.flags, this.itemCount, sample, time);
    this.itemCount += 1;
  }

  clear(): void {
    this.itemCount = 0;
  }

  discardPrefix(count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > this.itemCount) {
      throw new Error('Ink mutable tail prefix count is out of range.');
    }
    if (count === 0) return;
    if (count === this.itemCount) {
      this.clear();
      return;
    }
    this.values.copyWithin(0, count * NUMERIC_SAMPLE_WIDTH, this.itemCount * NUMERIC_SAMPLE_WIDTH);
    this.flags.copyWithin(0, count, this.itemCount);
    this.itemCount -= count;
  }

  readInto(index: number, target: NumericInkSampleCursor): NumericInkSampleCursor | undefined {
    const normalized = index < 0 ? this.itemCount + index : index;
    if (normalized < 0 || normalized >= this.itemCount) return undefined;
    return readNumericSample(this.values, this.flags, normalized, target);
  }

  retainSelected(selection: Uint8Array): void {
    let writeIndex = 0;
    for (let readIndex = 0; readIndex < this.itemCount; readIndex += 1) {
      if (selection[readIndex] !== 1) continue;
      if (writeIndex !== readIndex) {
        const readOffset = readIndex * NUMERIC_SAMPLE_WIDTH;
        const writeOffset = writeIndex * NUMERIC_SAMPLE_WIDTH;
        for (let slot = 0; slot < NUMERIC_SAMPLE_WIDTH; slot += 1) {
          this.values[writeOffset + slot] = this.values[readOffset + slot] as number;
        }
        this.flags[writeIndex] = this.flags[readIndex] as number;
      }
      writeIndex += 1;
    }
    this.itemCount = writeIndex;
  }
}

class EpochGuardedInkSampleView implements InkSampleView {
  private readonly cursor = createNumericSampleCursor();

  constructor(
    private readonly count: number,
    private readonly assertCurrent: () => void,
    private readonly readInto: (index: number, target: NumericInkSampleCursor) => void,
  ) {}

  get length(): number {
    this.assertCurrent();
    return this.count;
  }

  forEachSample(consumer: (sample: InkSampleCursor) => void): void {
    this.assertCurrent();
    for (let index = 0; index < this.count; index += 1) {
      this.assertCurrent();
      this.readInto(index, this.cursor);
      consumer(this.cursor);
    }
    this.assertCurrent();
  }
}

const EMPTY_SAMPLE_VIEW: InkSampleView = Object.freeze({
  forEachSample: () => undefined,
  length: 0,
});

export const EMPTY_INK_BORROWED_CONTROL_TRACE_DELTA: InkBorrowedControlTraceDelta = Object.freeze({
  kind: 'borrowed-numeric',
  mutableTail: EMPTY_SAMPLE_VIEW,
  stablePrefixDelta: EMPTY_SAMPLE_VIEW,
});

/**
 * Streaming Foundation reducer. Stable output is append-only; only a small authored tail can be
 * replaced while the contact remains active.
 */
export class CausalLegacyInkReducer {
  private readonly compactionSelection = new Uint8Array(MUTABLE_TAIL_BUFFER_CAPACITY);
  private readonly contactInputCursor = createNumericSampleCursor();
  private readonly endpointCursor = createNumericSampleCursor();
  private readonly extremumAfterCursor = createNumericSampleCursor();
  private readonly extremumBeforeCursor = createNumericSampleCursor();
  private readonly extremumCandidateCursor = createNumericSampleCursor();
  private lastTime = Number.NEGATIVE_INFINITY;
  private lastSequenceStableStart: number | null = null;
  private materializedLegacyPointCount = 0;
  private maximumX = Number.NEGATIVE_INFINITY;
  private maximumY = Number.NEGATIVE_INFINITY;
  private minimumX = Number.POSITIVE_INFINITY;
  private minimumY = Number.POSITIVE_INFINITY;
  private mutationEpoch = 0;
  private rawSampleCount = 0;
  private readonly scanCursor = createNumericSampleCursor();
  private readonly stableReadCursor = createNumericSampleCursor();
  private readonly stableSamples = new ChunkedNumericInkSampleBuffer();
  private readonly tail = new FixedNumericInkSampleBuffer();

  extend(samples: readonly InkContactSample[]): InkLegacyTraceDelta {
    this.beginMutation();
    const previousStableLength = this.stableSamples.length;
    for (const source of samples) {
      writeContactSampleInto(source, this.contactInputCursor);
      this.appendCursor(this.contactInputCursor);
    }
    return this.materializeDeltaSince(previousStableLength);
  }

  extendSequence(samples: InkSampleSequence): InkBorrowedControlTraceDelta {
    this.beginMutation();
    const previousStableLength = this.stableSamples.length;
    this.lastSequenceStableStart = previousStableLength;
    samples.forEachSample((sample) => this.appendCursor(sample));
    return this.borrowedDeltaSince(previousStableLength);
  }

  view(): {
    readonly mutableTail: readonly InkPoint[];
    readonly stablePrefix: readonly InkPoint[];
  } {
    return Object.freeze({
      mutableTail: Object.freeze(this.materializeTail()),
      stablePrefix: Object.freeze(this.materializeStableRange(0)),
    });
  }

  stats(): {
    readonly allocatedMutableSampleObjectCount: 0;
    readonly materializedLegacyPointCount: number;
    readonly mutableTailSampleCount: number;
    readonly mutableTailStorageKind: 'float64-fixed-buffer';
    readonly rawSampleCount: number;
    readonly retainedMutableSampleObjectCount: 0;
    readonly retainedRawSampleCount: 0;
    readonly retainedStableSampleObjectCount: 0;
    readonly stableChunkCount: number;
    readonly stableSampleCount: number;
    readonly stableStorageKind: 'float64-chunks';
  } {
    return Object.freeze({
      allocatedMutableSampleObjectCount: 0,
      materializedLegacyPointCount: this.materializedLegacyPointCount,
      mutableTailSampleCount: this.tail.length,
      mutableTailStorageKind: 'float64-fixed-buffer',
      rawSampleCount: this.rawSampleCount,
      retainedMutableSampleObjectCount: 0,
      retainedRawSampleCount: 0,
      retainedStableSampleObjectCount: 0,
      stableChunkCount: this.stableSamples.chunkCount,
      stableSampleCount: this.stableSamples.length,
      stableStorageKind: 'float64-chunks',
    });
  }

  bounds(width: number): {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  } {
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(this.minimumX)) {
      throw new Error('Ink trace bounds require samples and a positive width.');
    }
    const radius = width / 2;
    return Object.freeze({
      height: this.maximumY - this.minimumY + width,
      width: this.maximumX - this.minimumX + width,
      x: this.minimumX - radius,
      y: this.minimumY - radius,
    });
  }

  finalize(): InkLegacyControlTrace {
    this.beginMutation();
    this.finalizeTail();
    return this.materializeTrace();
  }

  finalizeSequence(): InkFinalizedControlTraceUpdate {
    const previousStableLength = this.lastSequenceStableStart;
    if (previousStableLength === null) {
      throw new Error('Ink sequence finalization requires a preceding borrowed sequence update.');
    }
    this.beginMutation();
    this.finalizeTail();
    const presentationDelta = this.borrowedDeltaSince(previousStableLength);
    const trace = this.materializeTrace();
    return Object.freeze({
      delta: Object.freeze({
        mutableTail: Object.freeze([]),
        stablePrefixDelta: Object.freeze(trace.points.slice(previousStableLength)),
      }),
      presentationDelta,
      trace,
    });
  }

  private finalizeTail(): void {
    if (this.tail.length > 0) this.emitAt(this.tail.length - 1);
    this.tail.clear();
  }

  private materializeTrace(): InkLegacyControlTrace {
    return Object.freeze({
      points: Object.freeze(this.materializeStableRange(0)),
      rawSampleCount: this.rawSampleCount,
      samples: Object.freeze(this.stableSamples.toArray()),
    });
  }

  private appendCursor(source: InkSampleCursor): void {
    const time = Math.max(source.time, this.lastTime);
    this.minimumX = Math.min(this.minimumX, source.x);
    this.minimumY = Math.min(this.minimumY, source.y);
    this.maximumX = Math.max(this.maximumX, source.x);
    this.maximumY = Math.max(this.maximumY, source.y);
    this.lastTime = time;
    this.rawSampleCount += 1;
    if (this.stableSamples.length === 0) {
      this.tail.append(source, time);
      const first = this.tail.readInto(0, this.scanCursor);
      if (first === undefined) throw new Error('Ink mutable tail admission is inconsistent.');
      this.stableSamples.append(first);
      this.tail.clear();
      return;
    }
    const previous = this.tail.readInto(-1, this.scanCursor) ?? this.readStableSample();
    if (sameCursor(previous, source, time)) return;
    this.tail.append(source, time);
    this.reduceTail();
  }

  private reduceTail(): void {
    while (this.tail.length > 0) {
      const emissionIndex = this.emissionIndex();
      if (emissionIndex === null) break;
      this.emitAt(emissionIndex);
    }
    if (this.tail.length > FOUNDATION_LEGACY_TRACE_LIMITS.maximumMutableTailSamples) {
      const stable = this.readStableSample();
      if (stable === undefined) throw new Error('Ink stable sample storage is inconsistent.');
      this.compactMutableTail(stable);
    }
  }

  private emissionIndex(): number | null {
    const stable = this.readStableSample();
    const endpoint = this.tail.readInto(-1, this.endpointCursor);
    if (stable === undefined || endpoint === undefined) return null;
    const extremum = this.localExtremumIndex(stable);
    if (extremum !== null) return extremum;
    const deviation = this.maximumDeviationIndex(stable);
    if (
      deviation !== null &&
      this.tail.readInto(deviation, this.scanCursor) !== undefined &&
      pointSegmentDistance(this.scanCursor, stable, endpoint) >
        FOUNDATION_LEGACY_TRACE_LIMITS.xyError
    ) {
      return deviation;
    }
    let arcLength = 0;
    let previousX = stable.x;
    let previousY = stable.y;
    for (let index = 0; index < this.tail.length; index += 1) {
      const sample = this.tail.readInto(index, this.scanCursor);
      if (sample === undefined) throw new Error('Ink mutable tail scan is inconsistent.');
      arcLength += Math.hypot(sample.x - previousX, sample.y - previousY);
      if (arcLength >= FOUNDATION_LEGACY_TRACE_LIMITS.maximumArcGap) return index;
      previousX = sample.x;
      previousY = sample.y;
    }
    if (endpoint.time - stable.time >= FOUNDATION_LEGACY_TRACE_LIMITS.maximumTimeGapMs) {
      return this.tail.length - 1;
    }
    return null;
  }

  private emitAt(tailIndex: number): void {
    const sample = this.tail.readInto(tailIndex, this.scanCursor);
    if (sample === undefined) throw new Error('Ink mutable tail emission is inconsistent.');
    const previous = this.readStableSample();
    if (previous === undefined || !sameCursor(previous, sample, sample.time)) {
      this.stableSamples.append(sample);
    }
    this.tail.discardPrefix(tailIndex + 1);
  }

  private localExtremumIndex(stable: NumericInkSampleCursor): number | null {
    if (this.tail.length < 2) return null;
    const index = this.tail.length - 2;
    const before =
      index === 0
        ? copyCursor(stable, this.extremumBeforeCursor)
        : this.tail.readInto(index - 1, this.extremumBeforeCursor);
    const candidate = this.tail.readInto(index, this.extremumCandidateCursor);
    const after = this.tail.readInto(index + 1, this.extremumAfterCursor);
    if (before === undefined || candidate === undefined || after === undefined) {
      throw new Error('Ink mutable tail extremum scan is inconsistent.');
    }
    if (
      readingExtremum(
        before,
        candidate,
        after,
        'pressure',
        INK_SAMPLE_FLAGS.pressureMeasured,
        FOUNDATION_LEGACY_TRACE_LIMITS.pressureExtremumEpsilon,
      )
    ) {
      return index;
    }
    for (const [key, flag] of ORIENTATION_SENSOR_FIELDS) {
      if (
        readingExtremum(
          before,
          candidate,
          after,
          key,
          flag,
          FOUNDATION_LEGACY_TRACE_LIMITS.orientationExtremumEpsilon,
        )
      ) {
        return index;
      }
    }
    return null;
  }

  private maximumDeviationIndex(stable: NumericInkSampleCursor): number | null {
    const endpoint = this.tail.readInto(-1, this.endpointCursor);
    if (endpoint === undefined || this.tail.length < 2) return null;
    let maximum = 0;
    let maximumIndex: number | null = null;
    for (let index = 0; index < this.tail.length - 1; index += 1) {
      const sample = this.tail.readInto(index, this.scanCursor);
      if (sample === undefined) throw new Error('Ink mutable tail deviation scan is inconsistent.');
      const distance = pointSegmentDistance(sample, stable, endpoint);
      if (distance > maximum) {
        maximum = distance;
        maximumIndex = index;
      }
    }
    return maximumIndex;
  }

  private compactMutableTail(stable: NumericInkSampleCursor): void {
    const selection = this.compactionSelection;
    selection.fill(0);
    selection[this.tail.length - 1] = 1;
    const deviation = this.maximumDeviationIndex(stable);
    if (deviation !== null) selection[deviation] = 1;
    for (const [key, flag] of COMPACTION_SENSOR_FIELDS) {
      let minimum = Number.POSITIVE_INFINITY;
      let maximum = Number.NEGATIVE_INFINITY;
      let minimumIndex = -1;
      let maximumIndex = -1;
      for (let index = 0; index < this.tail.length; index += 1) {
        const sample = this.tail.readInto(index, this.scanCursor);
        if (sample === undefined) throw new Error('Ink mutable tail compaction is inconsistent.');
        if ((sample.flags & flag) === 0) continue;
        const value = sample[key];
        if (value < minimum) {
          minimum = value;
          minimumIndex = index;
        }
        if (value > maximum) {
          maximum = value;
          maximumIndex = index;
        }
      }
      if (minimumIndex >= 0) selection[minimumIndex] = 1;
      if (maximumIndex >= 0) selection[maximumIndex] = 1;
    }
    this.tail.retainSelected(selection);
  }

  private materializeDeltaSince(previousStableLength: number): InkLegacyTraceDelta {
    return Object.freeze({
      mutableTail: Object.freeze(this.materializeTail()),
      stablePrefixDelta: Object.freeze(this.materializeStableRange(previousStableLength)),
    });
  }

  private materializeStableRange(start: number): InkPoint[] {
    const points: InkPoint[] = [];
    const cursor = createNumericSampleCursor();
    for (let index = start; index < this.stableSamples.length; index += 1) {
      const sample = this.stableSamples.readInto(index, cursor);
      if (sample === undefined) throw new Error('Ink stable sample storage is inconsistent.');
      points.push(this.materializeLegacyPoint(sample));
    }
    return points;
  }

  private materializeTail(): InkPoint[] {
    const points: InkPoint[] = [];
    const cursor = createNumericSampleCursor();
    for (let index = 0; index < this.tail.length; index += 1) {
      const sample = this.tail.readInto(index, cursor);
      if (sample === undefined)
        throw new Error('Ink mutable tail materialization is inconsistent.');
      points.push(this.materializeLegacyPoint(sample));
    }
    return points;
  }

  private materializeLegacyPoint(sample: NumericInkSampleCursor): InkPoint {
    this.materializedLegacyPointCount += 1;
    return toLegacyPoint(sample);
  }

  private borrowedDeltaSince(previousStableLength: number): InkBorrowedControlTraceDelta {
    const expectedEpoch = this.mutationEpoch;
    const assertCurrent = (): void => {
      if (this.mutationEpoch !== expectedEpoch) {
        throw new Error('Borrowed Ink presentation delta is no longer current.');
      }
    };
    const stableLength = this.stableSamples.length - previousStableLength;
    const tailLength = this.tail.length;
    return Object.freeze({
      kind: 'borrowed-numeric',
      mutableTail: new EpochGuardedInkSampleView(tailLength, assertCurrent, (index, target) => {
        if (this.tail.readInto(index, target) === undefined) {
          throw new Error('Ink mutable tail view is inconsistent.');
        }
      }),
      stablePrefixDelta: new EpochGuardedInkSampleView(
        stableLength,
        assertCurrent,
        (index, target) => {
          if (this.stableSamples.readInto(previousStableLength + index, target) === undefined) {
            throw new Error('Ink stable sample view is inconsistent.');
          }
        },
      ),
    });
  }

  private beginMutation(): void {
    this.mutationEpoch += 1;
    this.lastSequenceStableStart = null;
  }

  private readStableSample(): NumericInkSampleCursor | undefined {
    return this.stableSamples.readInto(-1, this.stableReadCursor);
  }
}

function readingExtremum(
  before: NumericInkSampleCursor,
  candidate: NumericInkSampleCursor,
  after: NumericInkSampleCursor,
  key: 'altitude' | 'azimuth' | 'pressure',
  flag: number,
  epsilon: number,
): boolean {
  if ((before.flags & flag) === 0 || (candidate.flags & flag) === 0 || (after.flags & flag) === 0) {
    return false;
  }
  const left = candidate[key] - before[key];
  const right = after[key] - candidate[key];
  return (
    Math.abs(left) >= epsilon &&
    Math.abs(right) >= epsilon &&
    ((left > 0 && right < 0) || (left < 0 && right > 0))
  );
}

function createNumericSampleCursor(): NumericInkSampleCursor {
  return { altitude: 0, azimuth: 0, flags: 0, pressure: 0, time: 0, x: 0, y: 0 };
}

function readNumericSample(
  values: Float64Array,
  flags: Uint8Array,
  index: number,
  target: NumericInkSampleCursor,
): NumericInkSampleCursor {
  const offset = index * NUMERIC_SAMPLE_WIDTH;
  target.x = values[offset] as number;
  target.y = values[offset + 1] as number;
  target.time = values[offset + 2] as number;
  target.pressure = values[offset + 3] as number;
  target.altitude = values[offset + 4] as number;
  target.azimuth = values[offset + 5] as number;
  target.flags = flags[index] as number;
  return target;
}

function writeNumericSample(
  values: Float64Array,
  flags: Uint8Array,
  index: number,
  sample: InkSampleCursor,
  time: number,
): void {
  const offset = index * NUMERIC_SAMPLE_WIDTH;
  const knownFlags = sample.flags & KNOWN_SAMPLE_FLAGS;
  values[offset] = sample.x;
  values[offset + 1] = sample.y;
  values[offset + 2] = time;
  values[offset + 3] = (knownFlags & INK_SAMPLE_FLAGS.pressureMeasured) === 0 ? 0 : sample.pressure;
  values[offset + 4] = (knownFlags & INK_SAMPLE_FLAGS.altitudeMeasured) === 0 ? 0 : sample.altitude;
  values[offset + 5] = (knownFlags & INK_SAMPLE_FLAGS.azimuthMeasured) === 0 ? 0 : sample.azimuth;
  flags[index] = knownFlags;
}

function copyCursor(
  source: InkSampleCursor,
  target: NumericInkSampleCursor,
): NumericInkSampleCursor {
  target.altitude = source.altitude;
  target.azimuth = source.azimuth;
  target.flags = source.flags;
  target.pressure = source.pressure;
  target.time = source.time;
  target.x = source.x;
  target.y = source.y;
  return target;
}

function writeContactSampleInto(source: InkContactSample, target: NumericInkSampleCursor): void {
  target.x = source.x;
  target.y = source.y;
  target.time = source.time;
  target.flags = 0;
  target.pressure = 0;
  target.altitude = 0;
  target.azimuth = 0;
  if (source.pressure.kind === 'measured') {
    target.pressure = source.pressure.value;
    target.flags |= INK_SAMPLE_FLAGS.pressureMeasured;
  }
  if (source.orientation.altitude.kind === 'measured') {
    target.altitude = source.orientation.altitude.value;
    target.flags |= INK_SAMPLE_FLAGS.altitudeMeasured;
  }
  if (source.orientation.azimuth.kind === 'measured') {
    target.azimuth = source.orientation.azimuth.value;
    target.flags |= INK_SAMPLE_FLAGS.azimuthMeasured;
  }
}

function materializeFlatSample(sample: NumericInkSampleCursor): InkContactSample {
  const reading = (value: number, flag: number): InkSensorReading =>
    (sample.flags & flag) === 0
      ? Object.freeze({ kind: 'unavailable' })
      : Object.freeze({ kind: 'measured', value });
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

function pointSegmentDistance(
  point: Pick<NumericInkSampleCursor, 'x' | 'y'>,
  start: Pick<NumericInkSampleCursor, 'x' | 'y'>,
  end: Pick<NumericInkSampleCursor, 'x' | 'y'>,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const parameter = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point.x - (start.x + parameter * dx), point.y - (start.y + parameter * dy));
}

function toLegacyPoint(sample: NumericInkSampleCursor): InkPoint {
  const tilt = sphericalToTilt(sample);
  return Object.freeze({
    pressure: (sample.flags & INK_SAMPLE_FLAGS.pressureMeasured) === 0 ? 0.5 : sample.pressure,
    time: sample.time,
    x: sample.x,
    y: sample.y,
    ...(tilt === null ? {} : tilt),
  });
}

function sphericalToTilt(
  sample: NumericInkSampleCursor,
): { readonly tiltX: number; readonly tiltY: number } | null {
  if (
    (sample.flags & INK_SAMPLE_FLAGS.altitudeMeasured) === 0 ||
    (sample.flags & INK_SAMPLE_FLAGS.azimuthMeasured) === 0
  ) {
    return null;
  }
  const { altitude, azimuth } = sample;
  const radiansToDegrees = 180 / Math.PI;
  if (altitude <= Number.EPSILON) {
    const x = Math.cos(azimuth);
    const y = Math.sin(azimuth);
    return {
      tiltX: Math.abs(x) <= Number.EPSILON ? 0 : Math.sign(x) * 90,
      tiltY: Math.abs(y) <= Number.EPSILON ? 0 : Math.sign(y) * 90,
    };
  }
  const tangent = Math.tan(altitude);
  return {
    tiltX: clampOrientationEpsilon(Math.atan(Math.cos(azimuth) / tangent) * radiansToDegrees),
    tiltY: clampOrientationEpsilon(Math.atan(Math.sin(azimuth) / tangent) * radiansToDegrees),
  };
}

function clampOrientationEpsilon(value: number): number {
  return Math.abs(value) <= 1e-7 ? 0 : value;
}

function sameCursor(
  left: NumericInkSampleCursor | undefined,
  right: InkSampleCursor,
  rightTime: number,
): boolean {
  const rightFlags = right.flags & KNOWN_SAMPLE_FLAGS;
  return (
    left !== undefined &&
    left.x === right.x &&
    left.y === right.y &&
    left.time === rightTime &&
    left.flags === rightFlags &&
    ((rightFlags & INK_SAMPLE_FLAGS.pressureMeasured) === 0 || left.pressure === right.pressure) &&
    ((rightFlags & INK_SAMPLE_FLAGS.altitudeMeasured) === 0 || left.altitude === right.altitude) &&
    ((rightFlags & INK_SAMPLE_FLAGS.azimuthMeasured) === 0 || left.azimuth === right.azimuth)
  );
}
