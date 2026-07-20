import type { InkPhysicalBrushInputProfile } from './ink-brush-contract';
import type {
  InkBrushActiveTraceDelta,
  InkPhysicalBrushControlPoint,
  InkPhysicalBrushControlTrace,
  InkPhysicalBrushOrientation,
  InkUnavailableBrushOrientation,
} from './ink-brush-geometry-contract';
import {
  INK_SAMPLE_FLAGS,
  type InkSampleCursor,
  type InkSampleSequence,
  type InkSampleView,
} from './ink-contact';
import type { InkBorrowedControlTraceDelta } from './ink-control-trace';
import type { InkPhysicalPoint } from './ink-surface';

export type InkPhysicalControlTracePhase = 'down' | 'move' | 'up';

export interface InkPhysicalTraceBuilderStats {
  readonly candidateRevision: 's30-kernel-r1';
  readonly inspectedSampleCount: number;
  readonly fixtureReferenceSampleCount: number;
  readonly maximumObservedMutableTailSampleCount: number;
  readonly mutableTailLimit: number;
  readonly mutableTailSampleCount: number;
  readonly pressureReferenceFixture: 's30-unpublished-reference-pressure';
  readonly profilePublication: 'unpublished-fixture';
  readonly rawSampleCount: number;
  readonly stableSampleCount: number;
  readonly terminationCarriedSampleCount: number;
}

export type InkPhysicalTraceBuilderCreation =
  | { readonly builder: InkPhysicalControlTraceBuilder; readonly kind: 'ready' }
  | { readonly kind: 'invalid-input-profile'; readonly reason: 'malformed-input-profile' };

type InvalidPhysicalTraceReason =
  | 'builder-failed'
  | 'input-profile-mismatch'
  | 'invalid-contact-order'
  | 'invalid-orientation'
  | 'invalid-sample'
  | 'sequence-length-mismatch'
  | 'sequence-read-failed';

export type InkPhysicalTraceUpdate =
  | {
      readonly brushDelta: InkBrushActiveTraceDelta;
      readonly kind: 'active';
      readonly presentationDelta: InkBorrowedControlTraceDelta;
    }
  | {
      readonly brushDelta: InkBrushActiveTraceDelta;
      readonly bounds: {
        readonly height: number;
        readonly width: number;
        readonly x: number;
        readonly y: number;
      };
      readonly kind: 'completed';
      readonly points: readonly InkPhysicalPoint[];
      readonly presentationDelta: InkBorrowedControlTraceDelta;
      readonly rawSampleCount: number;
      readonly trace: InkPhysicalBrushControlTrace;
    }
  | { readonly kind: 'invalid-input'; readonly reason: InvalidPhysicalTraceReason };

/*
 * S30 proves the streaming kernel only. These values are deliberately local unpublished fixture
 * inputs; S31/S32 calibration must not mistake them for a published Pen or Highlighter profile.
 */
const S30_UNPUBLISHED_FIXTURE_PROFILE = Object.freeze({
  candidateRevision: 's30-kernel-r1',
  emission: Object.freeze({
    maximumArcGap: 4,
    maximumGeometryError: 0.25,
    maximumMutableTailSamples: 12,
    maximumTimeGapMs: 24,
    orientationDelta: 0.08,
    pressureDelta: 0.08,
  }),
  filter: Object.freeze({
    fastAlpha: 1,
    fastSpeed: 0.75,
    slowAlpha: 0.22,
    slowSpeed: 0.02,
  }),
  pressureReference: 0.5,
  pressureReferenceFixture: 's30-unpublished-reference-pressure',
  publication: 'unpublished-fixture',
} as const);

const KNOWN_SAMPLE_FLAGS =
  INK_SAMPLE_FLAGS.pressureMeasured |
  INK_SAMPLE_FLAGS.altitudeMeasured |
  INK_SAMPLE_FLAGS.azimuthMeasured;
const TWO_PI = Math.PI * 2;

interface FilterState {
  readonly orientation: FilteredOrientation;
  readonly pressure: number;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

type FilteredOrientation =
  | { readonly kind: 'unavailable' }
  | {
      readonly altitude: number;
      readonly azimuthUnwrapped: number;
      readonly kind: 'measured';
    };

interface NormalizedSample {
  readonly orientation: FilteredOrientation;
  readonly pressure: ResolvedPressure;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

type PressureProvenance = 'fixture-reference' | 'measured' | 'termination-carried';

interface ResolvedPressure {
  readonly provenance: PressureProvenance;
  readonly value: number;
}

type SampleNormalization =
  | { readonly kind: 'invalid'; readonly reason: InvalidPhysicalTraceReason }
  | { readonly kind: 'valid'; readonly sample: NormalizedSample };

/**
 * Deep streaming Module for unpublished physical Brush Control Trace candidates. Its Interface is
 * phase + borrowed normalized sequence in, active delta/completed trace/typed failure out.
 */
export class InkPhysicalControlTraceBuilder {
  private active = false;
  private readonly canonicalPoints: InkPhysicalPoint[] = [];
  private completed = false;
  private failed = false;
  private filterState: FilterState | null = null;
  private fixtureReferenceSampleCount = 0;
  private inspectedSampleCount = 0;
  private lastContactPressure: number | null = null;
  private lastRawAzimuthUnwrapped: number | null = null;
  private lastRawTime = Number.NEGATIVE_INFINITY;
  private lastRawX = 0;
  private lastRawY = 0;
  private maximumObservedMutableTailSampleCount = 0;
  private maximumX = Number.NEGATIVE_INFINITY;
  private maximumY = Number.NEGATIVE_INFINITY;
  private minimumX = Number.POSITIVE_INFINITY;
  private minimumY = Number.POSITIVE_INFINITY;
  private mutationEpoch = 0;
  private rawSampleCount = 0;
  private readonly stablePoints: InkPhysicalBrushControlPoint[] = [];
  private readonly tail: InkPhysicalBrushControlPoint[] = [];
  private terminationCarriedSampleCount = 0;

  private constructor(private readonly inputProfile: InkPhysicalBrushInputProfile) {}

  static create(inputProfile: unknown): InkPhysicalTraceBuilderCreation {
    if (!isPhysicalInputProfile(inputProfile)) {
      return Object.freeze({ kind: 'invalid-input-profile', reason: 'malformed-input-profile' });
    }
    return Object.freeze({
      builder: new InkPhysicalControlTraceBuilder(
        Object.freeze({ pressure: inputProfile.pressure, tilt: inputProfile.tilt }),
      ),
      kind: 'ready',
    });
  }

  stats(): InkPhysicalTraceBuilderStats {
    return Object.freeze({
      candidateRevision: S30_UNPUBLISHED_FIXTURE_PROFILE.candidateRevision,
      fixtureReferenceSampleCount: this.fixtureReferenceSampleCount,
      inspectedSampleCount: this.inspectedSampleCount,
      maximumObservedMutableTailSampleCount: this.maximumObservedMutableTailSampleCount,
      mutableTailLimit: S30_UNPUBLISHED_FIXTURE_PROFILE.emission.maximumMutableTailSamples,
      mutableTailSampleCount: this.tail.length,
      pressureReferenceFixture: S30_UNPUBLISHED_FIXTURE_PROFILE.pressureReferenceFixture,
      profilePublication: S30_UNPUBLISHED_FIXTURE_PROFILE.publication,
      rawSampleCount: this.rawSampleCount,
      stableSampleCount: this.stablePoints.length,
      terminationCarriedSampleCount: this.terminationCarriedSampleCount,
    });
  }

  /** Ends at the last confirmed sample without synthesizing a point in a replacement Stage Frame. */
  seal(): InkPhysicalTraceUpdate {
    this.mutationEpoch += 1;
    if (this.failed) return invalidInput('builder-failed');
    if (this.completed || !this.active) return invalidInput('invalid-contact-order');
    return this.complete(this.stablePoints.length);
  }

  update(phase: InkPhysicalControlTracePhase, sequence: InkSampleSequence): InkPhysicalTraceUpdate {
    this.mutationEpoch += 1;
    if (this.failed) return invalidInput('builder-failed');
    if (this.completed || (phase === 'down' && this.active) || (phase !== 'down' && !this.active)) {
      return invalidInput('invalid-contact-order');
    }

    const previousStableLength = this.stablePoints.length;
    let declaredLength: number;
    try {
      declaredLength = sequence.length;
    } catch {
      this.failed = true;
      return invalidInput('sequence-read-failed');
    }
    if (!Number.isInteger(declaredLength) || declaredLength < 0) {
      this.failed = true;
      return invalidInput('sequence-length-mismatch');
    }
    if ((phase === 'down' || phase === 'up') && declaredLength === 0) {
      this.failed = true;
      return invalidInput('sequence-length-mismatch');
    }
    if (phase === 'down') this.active = true;

    let invalidReason: InvalidPhysicalTraceReason | null = null;
    let sampleIndex = 0;
    try {
      sequence.forEachSample((source) => {
        if (invalidReason !== null) return;
        if (sampleIndex >= declaredLength) {
          invalidReason = 'sequence-length-mismatch';
          return;
        }
        const normalized = this.normalize(
          source,
          phase === 'up' && sampleIndex === declaredLength - 1,
        );
        if (normalized.kind === 'invalid') {
          invalidReason = normalized.reason;
          return;
        }
        this.appendFiltered(
          normalized.sample,
          phase === 'up' && sampleIndex === declaredLength - 1,
        );
        this.rawSampleCount += 1;
        sampleIndex += 1;
      });
    } catch {
      this.failed = true;
      return invalidInput('sequence-read-failed');
    }
    if (invalidReason === null && sampleIndex !== declaredLength) {
      invalidReason = 'sequence-length-mismatch';
    }
    if (invalidReason !== null) {
      this.failed = true;
      return invalidInput(invalidReason);
    }

    if (phase !== 'up') {
      return Object.freeze({
        brushDelta: this.brushDeltaSince(previousStableLength),
        kind: 'active',
        presentationDelta: this.borrowedDeltaSince(previousStableLength),
      });
    }

    return this.complete(previousStableLength);
  }

  private complete(previousStableLength: number): InkPhysicalTraceUpdate {
    this.finalizeTail();
    this.completed = true;
    this.active = false;
    const trace: InkPhysicalBrushControlTrace = Object.freeze({
      kind: 'physical-control-trace',
      points: Object.freeze(this.stablePoints),
    });
    const points = Object.freeze(this.canonicalPoints);
    return Object.freeze({
      brushDelta: this.brushDeltaSince(previousStableLength),
      bounds: Object.freeze({
        height: this.maximumY - this.minimumY,
        width: this.maximumX - this.minimumX,
        x: this.minimumX,
        y: this.minimumY,
      }),
      kind: 'completed',
      points,
      presentationDelta: this.borrowedDeltaSince(previousStableLength),
      rawSampleCount: this.rawSampleCount,
      trace,
    });
  }

  private normalize(source: InkSampleCursor, isTermination: boolean): SampleNormalization {
    this.inspectedSampleCount += 1;
    if (
      !Number.isFinite(source.x) ||
      !Number.isFinite(source.y) ||
      !Number.isFinite(source.time) ||
      !Number.isInteger(source.flags) ||
      (source.flags & ~KNOWN_SAMPLE_FLAGS) !== 0
    ) {
      return invalidSample('invalid-sample');
    }
    const pressureMeasured = (source.flags & INK_SAMPLE_FLAGS.pressureMeasured) !== 0;
    if (
      (pressureMeasured &&
        (!Number.isFinite(source.pressure) || source.pressure < 0 || source.pressure > 1)) ||
      (pressureMeasured && this.inputProfile.pressure === 'unavailable')
    ) {
      return invalidSample(
        this.inputProfile.pressure === 'unavailable' ? 'input-profile-mismatch' : 'invalid-sample',
      );
    }
    const altitudeMeasured = (source.flags & INK_SAMPLE_FLAGS.altitudeMeasured) !== 0;
    const azimuthMeasured = (source.flags & INK_SAMPLE_FLAGS.azimuthMeasured) !== 0;
    if (altitudeMeasured !== azimuthMeasured) return invalidSample('invalid-orientation');
    if (
      altitudeMeasured &&
      (this.inputProfile.tilt === 'unavailable' ||
        !Number.isFinite(source.altitude) ||
        source.altitude < 0 ||
        source.altitude > Math.PI / 2 ||
        !Number.isFinite(source.azimuth) ||
        source.azimuth < 0 ||
        source.azimuth >= TWO_PI)
    ) {
      return invalidSample(
        this.inputProfile.tilt === 'unavailable' ? 'input-profile-mismatch' : 'invalid-orientation',
      );
    }

    const time = Math.max(source.time, this.lastRawTime);
    const orientation = altitudeMeasured
      ? this.normalizeOrientation(source.altitude, source.azimuth)
      : ({ kind: 'unavailable' } as const);
    let pressure: ResolvedPressure;
    if (
      isTermination &&
      pressureMeasured &&
      source.pressure === 0 &&
      this.lastContactPressure !== null
    ) {
      pressure = Object.freeze({
        provenance: 'termination-carried',
        value: this.lastContactPressure,
      });
      this.terminationCarriedSampleCount += 1;
    } else if (pressureMeasured) {
      pressure = Object.freeze({ provenance: 'measured', value: source.pressure });
    } else {
      pressure = Object.freeze({
        provenance: 'fixture-reference',
        value: S30_UNPUBLISHED_FIXTURE_PROFILE.pressureReference,
      });
      this.fixtureReferenceSampleCount += 1;
    }
    return {
      kind: 'valid',
      sample: { orientation, pressure, time, x: source.x, y: source.y },
    };
  }

  private normalizeOrientation(altitude: number, azimuth: number): FilteredOrientation {
    const previous = this.lastRawAzimuthUnwrapped;
    const unwrapped = previous === null ? azimuth : previous + shortestAngle(azimuth - previous);
    this.lastRawAzimuthUnwrapped = unwrapped;
    return { altitude, azimuthUnwrapped: unwrapped, kind: 'measured' };
  }

  private appendFiltered(source: NormalizedSample, forceEndpoint: boolean): void {
    const previous = this.filterState;
    const elapsed = previous === null ? 0 : Math.max(0.25, source.time - this.lastRawTime);
    const speed =
      previous === null
        ? Number.POSITIVE_INFINITY
        : Math.hypot(source.x - this.lastRawX, source.y - this.lastRawY) / elapsed;
    const alpha = adaptiveAlpha(speed);
    const pressureValue =
      previous === null ||
      source.pressure.provenance === 'termination-carried' ||
      source.pressure.provenance === 'fixture-reference' ||
      (source.pressure.provenance === 'measured' && source.pressure.value === 0)
        ? source.pressure.value
        : previous.pressure + alpha * (source.pressure.value - previous.pressure);
    const orientation = filterOrientation(previous?.orientation, source.orientation, alpha);
    const state: FilterState = {
      orientation,
      pressure: pressureValue,
      time: source.time,
      x:
        forceEndpoint || previous === null
          ? source.x
          : previous.x + alpha * (source.x - previous.x),
      y:
        forceEndpoint || previous === null
          ? source.y
          : previous.y + alpha * (source.y - previous.y),
    };
    const point: InkPhysicalBrushControlPoint = Object.freeze({
      orientation: materializeOrientation(orientation),
      pressure: Object.freeze({
        kind: source.pressure.provenance === 'fixture-reference' ? 'unavailable' : 'measured',
        value: pressureValue,
      }),
      time: state.time,
      x: state.x,
      y: state.y,
    });
    this.filterState = state;
    this.lastRawTime = source.time;
    this.lastRawX = source.x;
    this.lastRawY = source.y;
    if (!forceEndpoint) this.lastContactPressure = pressureValue;

    if (this.stablePoints.length === 0) {
      this.emitStable(point);
      return;
    }
    if (this.tail.length === S30_UNPUBLISHED_FIXTURE_PROFILE.emission.maximumMutableTailSamples) {
      this.emitTailAt(this.forcedEmissionIndex());
    }
    this.tail.push(point);
    this.maximumObservedMutableTailSampleCount = Math.max(
      this.maximumObservedMutableTailSampleCount,
      this.tail.length,
    );
    this.reduceTail();
  }

  private reduceTail(): void {
    while (this.tail.length > 0) {
      const emissionIndex = this.emissionIndex();
      if (emissionIndex === null) return;
      this.emitTailAt(emissionIndex);
    }
  }

  private emissionIndex(): number | null {
    const stable = this.stablePoints.at(-1);
    const endpoint = this.tail.at(-1);
    if (stable === undefined || endpoint === undefined) return null;

    if (this.tail.length >= 2) {
      const candidateIndex = this.tail.length - 2;
      const before = candidateIndex === 0 ? stable : this.tail[candidateIndex - 1];
      const candidate = this.tail[candidateIndex];
      if (
        before !== undefined &&
        candidate !== undefined &&
        (scalarExtremum(before.pressure.value, candidate.pressure.value, endpoint.pressure.value) ||
          orientationExtremum(before.orientation, candidate.orientation, endpoint.orientation))
      ) {
        this.inspectedSampleCount += 3;
        return candidateIndex;
      }
    }

    const deviation = this.maximumDeviationIndex(stable, endpoint);
    if (
      deviation.index !== null &&
      deviation.distance > S30_UNPUBLISHED_FIXTURE_PROFILE.emission.maximumGeometryError
    ) {
      return deviation.index;
    }

    let arcLength = 0;
    let previousX = stable.x;
    let previousY = stable.y;
    for (let index = 0; index < this.tail.length; index += 1) {
      const next = this.tail[index];
      if (next === undefined) continue;
      this.inspectedSampleCount += 1;
      arcLength += Math.hypot(next.x - previousX, next.y - previousY);
      if (arcLength >= S30_UNPUBLISHED_FIXTURE_PROFILE.emission.maximumArcGap) return index;
      previousX = next.x;
      previousY = next.y;
    }
    if (endpoint.time - stable.time >= S30_UNPUBLISHED_FIXTURE_PROFILE.emission.maximumTimeGapMs) {
      return this.tail.length - 1;
    }
    // Sensor changes can require an endpoint, but they must not erase an earlier spatial sample
    // needed to preserve the path envelope. Geometry/arc/time invariants therefore win first; the
    // reducer loops and emits this endpoint immediately afterwards.
    if (
      stable.pressure.kind !== endpoint.pressure.kind ||
      stable.orientation.kind !== endpoint.orientation.kind ||
      Math.abs(stable.pressure.value - endpoint.pressure.value) >=
        S30_UNPUBLISHED_FIXTURE_PROFILE.emission.pressureDelta ||
      orientationDistance(stable.orientation, endpoint.orientation) >=
        S30_UNPUBLISHED_FIXTURE_PROFILE.emission.orientationDelta
    ) {
      this.inspectedSampleCount += 2;
      return this.tail.length - 1;
    }
    return null;
  }

  private maximumDeviationIndex(
    stable: InkPhysicalBrushControlPoint,
    endpoint: InkPhysicalBrushControlPoint,
  ): { readonly distance: number; readonly index: number | null } {
    let distance = 0;
    let selected: number | null = null;
    for (let index = 0; index < this.tail.length - 1; index += 1) {
      const point = this.tail[index];
      if (point === undefined) continue;
      this.inspectedSampleCount += 1;
      const candidate = pointSegmentDistance(point, stable, endpoint);
      if (candidate > distance) {
        distance = candidate;
        selected = index;
      }
    }
    return { distance, index: selected };
  }

  private forcedEmissionIndex(): number {
    const stable = this.stablePoints.at(-1);
    const endpoint = this.tail.at(-1);
    if (stable === undefined || endpoint === undefined) return 0;
    return this.maximumDeviationIndex(stable, endpoint).index ?? 0;
  }

  private emitTailAt(index: number): void {
    const point = this.tail[index];
    if (point === undefined) return;
    this.emitStable(point);
    this.tail.splice(0, index + 1);
  }

  private emitStable(point: InkPhysicalBrushControlPoint): void {
    const previous = this.stablePoints.at(-1);
    if (previous !== undefined && samePoint(previous, point)) return;
    this.stablePoints.push(point);
    this.canonicalPoints.push(
      Object.freeze({
        orientation: point.orientation,
        pressure: point.pressure.value,
        pressureKind: point.pressure.kind,
        time: point.time,
        x: point.x,
        y: point.y,
      }),
    );
    this.minimumX = Math.min(this.minimumX, point.x);
    this.minimumY = Math.min(this.minimumY, point.y);
    this.maximumX = Math.max(this.maximumX, point.x);
    this.maximumY = Math.max(this.maximumY, point.y);
  }

  private finalizeTail(): void {
    const endpoint = this.tail.at(-1);
    if (endpoint !== undefined) this.emitStable(endpoint);
    this.tail.length = 0;
  }

  private brushDeltaSince(previousStableLength: number): InkBrushActiveTraceDelta {
    return Object.freeze({
      mutableReplacement: physicalTrace(this.tail),
      stableAppend: physicalTrace(this.stablePoints.slice(previousStableLength)),
    });
  }

  private borrowedDeltaSince(previousStableLength: number): InkBorrowedControlTraceDelta {
    const epoch = this.mutationEpoch;
    const assertCurrent = (): void => {
      if (this.mutationEpoch !== epoch) {
        throw new Error('Borrowed physical Ink presentation delta is no longer current.');
      }
    };
    return Object.freeze({
      kind: 'borrowed-numeric',
      mutableTail: new PhysicalPointView(this.tail, 0, this.tail.length, assertCurrent),
      stablePrefixDelta: new PhysicalPointView(
        this.stablePoints,
        previousStableLength,
        this.stablePoints.length - previousStableLength,
        assertCurrent,
      ),
    });
  }
}

function physicalTrace(
  points: readonly InkPhysicalBrushControlPoint[],
): InkPhysicalBrushControlTrace {
  return Object.freeze({
    kind: 'physical-control-trace',
    points: Object.freeze([...points]),
  });
}

class PhysicalPointView implements InkSampleView {
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
    private readonly points: readonly InkPhysicalBrushControlPoint[],
    private readonly start: number,
    private readonly count: number,
    private readonly assertCurrent: () => void,
  ) {}

  get length(): number {
    this.assertCurrent();
    return this.count;
  }

  forEachSample(consumer: (sample: InkSampleCursor) => void): void {
    this.assertCurrent();
    for (let index = 0; index < this.count; index += 1) {
      const point = this.points[this.start + index];
      if (point === undefined) throw new Error('Borrowed physical Ink sample is unavailable.');
      this.cursor.x = point.x;
      this.cursor.y = point.y;
      this.cursor.time = point.time;
      this.cursor.pressure = point.pressure.value;
      this.cursor.altitude = point.orientation.kind === 'measured' ? point.orientation.altitude : 0;
      this.cursor.azimuth = point.orientation.kind === 'measured' ? point.orientation.azimuth : 0;
      this.cursor.flags =
        (point.pressure.kind === 'unavailable' ? 0 : INK_SAMPLE_FLAGS.pressureMeasured) |
        (point.orientation.kind === 'measured'
          ? INK_SAMPLE_FLAGS.altitudeMeasured | INK_SAMPLE_FLAGS.azimuthMeasured
          : 0);
      consumer(this.cursor);
      this.assertCurrent();
    }
  }
}

function filterOrientation(
  previous: FilteredOrientation | undefined,
  source: FilteredOrientation,
  alpha: number,
): FilteredOrientation {
  if (source.kind === 'unavailable') return source;
  if (previous?.kind !== 'measured') return source;
  return {
    altitude: previous.altitude + alpha * (source.altitude - previous.altitude),
    azimuthUnwrapped:
      previous.azimuthUnwrapped + alpha * (source.azimuthUnwrapped - previous.azimuthUnwrapped),
    kind: 'measured',
  };
}

function materializeOrientation(
  orientation: FilteredOrientation,
): InkPhysicalBrushOrientation | InkUnavailableBrushOrientation {
  if (orientation.kind === 'unavailable') return Object.freeze({ kind: 'unavailable' });
  return Object.freeze({
    altitude: orientation.altitude,
    azimuth: moduloTwoPi(orientation.azimuthUnwrapped),
    kind: 'measured',
    reliable: true,
  });
}

function adaptiveAlpha(speed: number): number {
  const { fastAlpha, fastSpeed, slowAlpha, slowSpeed } = S30_UNPUBLISHED_FIXTURE_PROFILE.filter;
  if (speed <= slowSpeed) return slowAlpha;
  if (speed >= fastSpeed) return fastAlpha;
  const ratio = (speed - slowSpeed) / (fastSpeed - slowSpeed);
  return slowAlpha + ratio * (fastAlpha - slowAlpha);
}

function scalarExtremum(before: number, candidate: number, after: number): boolean {
  const left = candidate - before;
  const right = after - candidate;
  return (
    Math.abs(left) >= 0.01 &&
    Math.abs(right) >= 0.01 &&
    ((left > 0 && right < 0) || (left < 0 && right > 0))
  );
}

function orientationExtremum(
  before: InkPhysicalBrushControlPoint['orientation'],
  candidate: InkPhysicalBrushControlPoint['orientation'],
  after: InkPhysicalBrushControlPoint['orientation'],
): boolean {
  if (before.kind !== 'measured' || candidate.kind !== 'measured' || after.kind !== 'measured') {
    return false;
  }
  return (
    scalarExtremum(before.altitude, candidate.altitude, after.altitude) ||
    scalarExtremum(
      0,
      shortestAngle(candidate.azimuth - before.azimuth),
      shortestAngle(after.azimuth - before.azimuth),
    )
  );
}

function orientationDistance(
  left: InkPhysicalBrushControlPoint['orientation'],
  right: InkPhysicalBrushControlPoint['orientation'],
): number {
  if (left.kind !== 'measured' || right.kind !== 'measured') return 0;
  return Math.max(
    Math.abs(left.altitude - right.altitude),
    Math.abs(shortestAngle(left.azimuth - right.azimuth)),
  );
}

function pointSegmentDistance(
  point: Pick<InkPhysicalBrushControlPoint, 'x' | 'y'>,
  start: Pick<InkPhysicalBrushControlPoint, 'x' | 'y'>,
  end: Pick<InkPhysicalBrushControlPoint, 'x' | 'y'>,
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

function samePoint(
  left: InkPhysicalBrushControlPoint,
  right: InkPhysicalBrushControlPoint,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.time === right.time &&
    left.pressure.kind === right.pressure.kind &&
    left.pressure.value === right.pressure.value &&
    left.orientation.kind === right.orientation.kind &&
    (left.orientation.kind === 'unavailable' ||
      (right.orientation.kind === 'measured' &&
        left.orientation.altitude === right.orientation.altitude &&
        left.orientation.azimuth === right.orientation.azimuth))
  );
}

function shortestAngle(value: number): number {
  return moduloTwoPi(value + Math.PI) - Math.PI;
}

function moduloTwoPi(value: number): number {
  const result = value % TWO_PI;
  return result < 0 ? result + TWO_PI : result;
}

function isPhysicalInputProfile(value: unknown): value is InkPhysicalBrushInputProfile {
  try {
    if (typeof value !== 'object' || value === null) return false;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return (
      Reflect.ownKeys(record).length === 2 &&
      keys.length === 2 &&
      keys[0] === 'pressure' &&
      keys[1] === 'tilt' &&
      (record.pressure === 'measured' || record.pressure === 'unavailable') &&
      (record.tilt === 'measured' || record.tilt === 'unavailable')
    );
  } catch {
    return false;
  }
}

function invalidInput(
  reason: InvalidPhysicalTraceReason,
): Extract<InkPhysicalTraceUpdate, { kind: 'invalid-input' }> {
  return Object.freeze({ kind: 'invalid-input', reason });
}

function invalidSample(reason: InvalidPhysicalTraceReason): SampleNormalization {
  return { kind: 'invalid', reason };
}
