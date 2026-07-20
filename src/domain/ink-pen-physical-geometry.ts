import { digestInkBrushGolden } from './ink-brush-contract';
import {
  createInkBrushActiveGeometryUpdate,
  createInkBrushCompiledGeometry,
  createInkBrushCompilationResult,
  decodeInkBrushLogicalStroke,
  digestInkBrushControlTrace,
} from './ink-brush-geometry-contract';
import type {
  InkBrushActiveGeometryCompiler,
  InkBrushActiveGeometryDelta,
  InkBrushActiveGeometryFinish,
  InkBrushActiveTraceDelta,
  InkBrushCompilationResult,
  InkBrushGeometryBounds,
  InkBrushLogicalStroke,
  InkCompiledBrushGeometry,
  InkFilledContourCoverage,
  InkPenPhysicalLogicalStrokeHeader,
  InkPhysicalBrushControlPoint,
  InkQuantizedBrushPoint,
} from './ink-brush-geometry-contract';

/**
 * Build/test metadata for S31. Nothing in this object is a published Brush Render Version value;
 * S34 owns physical calibration and may replace every number before publication.
 */
export const UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE = deepFreeze({
  active: {
    maximumMutableTailPoints: 12,
  },
  calibrationOwner: 'S34',
  candidateRevision: 's31-pen-geometry-r1',
  enabledByDefault: false,
  geometry: {
    maximumCircleSegments: 32,
    maximumContourError: 0.125,
    minimumCircleSegments: 8,
  },
  nominalWidthSemantics: 'diameter-at-reference-pressure-and-reference-speed',
  pressure: {
    maximumScale: 1.35,
    minimumScale: 0.28,
    referencePressure: 0.5,
  },
  publication: 'unpublished-default-off',
  quantization: {
    logicalGrid: 1 / 256,
    sensorGrid: 1 / 4096,
    traceCoordinateGrid: 1 / 1024,
    traceTimeGridMs: 1 / 1000,
  },
  velocity: {
    fullThinningSpeed: 1.8,
    maximumScale: 1,
    minimumScale: 0.86,
    referenceSpeed: 0.18,
  },
} as const);

export interface InkPenPhysicalDiameterInput {
  readonly nominalWidth: number;
  readonly pressure: number;
  readonly speed: number;
}

export interface InkPenPhysicalGeometryStats {
  readonly calibrationOwner: 'S34';
  readonly candidateRevision: 's31-pen-geometry-r1';
  readonly emittedContourCount: number;
  readonly inspectedPointCount: number;
  readonly maximumMutableTailPointCount: number;
  readonly publication: 'unpublished-default-off';
}

export type InkPenPhysicalActiveGeometryCompilerCreation =
  | {
      readonly compiler: InkPenPhysicalActiveGeometryCompiler;
      readonly kind: 'ready';
    }
  | {
      readonly kind: 'unsupported';
      readonly reason: 'invalid-header' | 'unknown-version' | 'wrong-brush';
      readonly requestedVersion: string;
    };

type PenStroke = Extract<
  InkBrushLogicalStroke,
  { readonly header: { readonly version: 'pen-physical-v1' } }
>;
type PenGeometry = Extract<InkCompiledBrushGeometry, { readonly version: 'pen-physical-v1' }>;

export type InkPenPhysicalCompilationResult =
  | (Extract<InkBrushCompilationResult, { readonly kind: 'degraded' }> & {
      readonly requestedVersion: 'pen-physical-v1';
    })
  | Extract<InkBrushCompilationResult, { readonly kind: 'unsupported' }>
  | { readonly geometry: PenGeometry; readonly kind: 'unpublished' };

interface ResolvedPenPoint {
  readonly radius: number;
  readonly source: InkPhysicalBrushControlPoint;
}

interface CompileRunResult {
  readonly contours: readonly (readonly InkQuantizedBrushPoint[])[];
  readonly last: ResolvedPenPoint | null;
}

const BLEND = Object.freeze({
  alpha: Object.freeze({ kind: 'fixed' as const, value: 1 as const }),
  application: 'once-per-logical-stroke' as const,
  colorSpace: 'srgb' as const,
  composite: 'source-over' as const,
});
const HIT_SHAPE = Object.freeze({
  fillRule: 'nonzero' as const,
  kind: 'filled-contour-distance' as const,
});
const TRACE_QUANTIZATION = Object.freeze({
  coordinateGrid: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.quantization.traceCoordinateGrid,
  sensorGrid: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.quantization.sensorGrid,
  timeGridMs: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.quantization.traceTimeGridMs,
});

/**
 * Candidate Pen diameter resolver. Pressure is primary and monotonic; velocity can only apply the
 * small, bounded, non-zero thinning range declared above.
 */
export function resolveUnpublishedInkPenPhysicalDiameter(
  input: InkPenPhysicalDiameterInput,
): number {
  if (
    !Number.isFinite(input.nominalWidth) ||
    input.nominalWidth <= 0 ||
    !Number.isFinite(input.pressure) ||
    Number.isNaN(input.speed) ||
    input.speed < 0
  ) {
    throw new Error('Invalid unpublished physical Pen diameter input.');
  }
  const pressure = clamp(input.pressure, 0, 1);
  const pressureProfile = UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.pressure;
  const pressureScale =
    pressure <= pressureProfile.referencePressure
      ? interpolate(pressureProfile.minimumScale, 1, pressure / pressureProfile.referencePressure)
      : interpolate(
          1,
          pressureProfile.maximumScale,
          (pressure - pressureProfile.referencePressure) / (1 - pressureProfile.referencePressure),
        );
  const velocityProfile = UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.velocity;
  const velocityScale =
    input.speed <= velocityProfile.referenceSpeed
      ? velocityProfile.maximumScale
      : interpolate(
          velocityProfile.maximumScale,
          velocityProfile.minimumScale,
          clamp(
            (input.speed - velocityProfile.referenceSpeed) /
              (velocityProfile.fullThinningSpeed - velocityProfile.referenceSpeed),
            0,
            1,
          ),
        );
  return input.nominalWidth * pressureScale * velocityScale;
}

/**
 * Compile one canonical Pen Logical Stroke. Candidate geometry is always reported as unpublished;
 * invalid/future inputs and known-version geometry failures are typed results, never thrown.
 */
export function compileInkPenPhysicalGeometry(input: unknown): InkPenPhysicalCompilationResult {
  const decoded = decodeInkBrushLogicalStroke(input);
  if (decoded.kind === 'unsupported') {
    return unsupported('unknown-version', decoded.version);
  }
  if (decoded.kind === 'invalid') {
    return unsupported('invalid-canonical-stroke', requestedVersionOf(input));
  }
  if (!isPenStroke(decoded.stroke)) {
    return unsupported('invalid-canonical-stroke', decoded.stroke.header.version);
  }
  try {
    const geometry = compileCanonicalPenStroke(decoded.stroke);
    createInkBrushCompilationResult({ geometry, kind: 'unpublished' });
    return Object.freeze({ geometry, kind: 'unpublished' });
  } catch {
    return degradeOrReject(decoded.stroke);
  }
}

/**
 * Digest normalized filled coverage only. Flattening coverage chunks makes the active stable/tail
 * ownership split irrelevant, so the final active union can be compared with committed coverage.
 */
export function digestInkPenPhysicalCoverage(
  coverage: readonly InkFilledContourCoverage[],
): string {
  return digestInkBrushGolden({
    contours: coverage.flatMap(({ contours }) => contours),
    kind: 'pen-physical-filled-coverage-v1',
    logicalGrid: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.quantization.logicalGrid,
  });
}

export function createInkPenPhysicalActiveGeometryCompiler(
  header: unknown,
): InkPenPhysicalActiveGeometryCompilerCreation {
  const decoded = decodeInkBrushLogicalStroke({
    header,
    trace: {
      kind: 'physical-control-trace',
      points: [
        {
          orientation: { kind: 'unavailable' },
          pressure: { kind: 'unavailable', value: 0.5 },
          time: 0,
          x: 0,
          y: 0,
        },
      ],
    },
  });
  if (decoded.kind === 'unsupported') {
    return Object.freeze({
      kind: 'unsupported',
      reason: 'unknown-version',
      requestedVersion: decoded.version,
    });
  }
  if (decoded.kind === 'invalid') {
    return Object.freeze({
      kind: 'unsupported',
      reason: 'invalid-header',
      requestedVersion: requestedVersionOf({ header }),
    });
  }
  if (decoded.stroke.header.version !== 'pen-physical-v1') {
    return Object.freeze({
      kind: 'unsupported',
      reason: 'wrong-brush',
      requestedVersion: decoded.stroke.header.version,
    });
  }
  return Object.freeze({
    compiler: InkPenPhysicalActiveGeometryCompiler.create(decoded.stroke.header),
    kind: 'ready',
  });
}

/**
 * Streaming active compiler. It retains one stable anchor, never stable geometry: each call reads
 * only the new stable append and the complete bounded mutable replacement supplied by S30.
 */
export class InkPenPhysicalActiveGeometryCompiler implements InkBrushActiveGeometryCompiler {
  private emittedContourCount = 0;
  private finished = false;
  private generation = 0;
  private inspectedPointCount = 0;
  private lastStable: ResolvedPenPoint | null = null;
  private maximumMutableTailPointCount = 0;
  private stableBounds: InkBrushGeometryBounds | null = null;

  private constructor(private readonly header: InkPenPhysicalLogicalStrokeHeader) {}

  static create(header: InkPenPhysicalLogicalStrokeHeader): InkPenPhysicalActiveGeometryCompiler {
    return new InkPenPhysicalActiveGeometryCompiler(header);
  }

  extend(delta: InkBrushActiveTraceDelta): InkBrushActiveGeometryDelta {
    this.assertOpen();
    const update = this.update('active-delta', delta);
    if (update.kind !== 'active-delta')
      throw new Error('Physical Pen active update kind mismatch.');
    return update;
  }

  finish(delta: InkBrushActiveTraceDelta): InkBrushActiveGeometryFinish {
    this.assertOpen();
    const update = this.update('active-finish', delta);
    if (update.kind !== 'active-finish')
      throw new Error('Physical Pen finish update kind mismatch.');
    this.finished = true;
    return update;
  }

  stats(): InkPenPhysicalGeometryStats {
    return Object.freeze({
      calibrationOwner: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.calibrationOwner,
      candidateRevision: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.candidateRevision,
      emittedContourCount: this.emittedContourCount,
      inspectedPointCount: this.inspectedPointCount,
      maximumMutableTailPointCount: this.maximumMutableTailPointCount,
      publication: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.publication,
    });
  }

  private update(
    kind: 'active-delta' | 'active-finish',
    delta: InkBrushActiveTraceDelta,
  ): InkBrushActiveGeometryDelta | InkBrushActiveGeometryFinish {
    const stablePoints = physicalDeltaPoints(delta.stableAppend, 'stable append');
    const mutablePoints = physicalDeltaPoints(delta.mutableReplacement, 'mutable replacement');
    if (
      mutablePoints.length > UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.active.maximumMutableTailPoints
    ) {
      throw new Error('Physical Pen mutable replacement exceeds the unpublished hard bound.');
    }
    if (
      kind === 'active-finish' &&
      this.lastStable === null &&
      stablePoints.length === 0 &&
      mutablePoints.length === 0
    ) {
      throw new Error('Physical Pen cannot transfer blank active ownership.');
    }
    assertMonotonicAfter(this.lastStable?.source ?? null, stablePoints, 'stable append');
    const stableRun = compilePointRun(this.header.nominalWidth, stablePoints, this.lastStable);
    assertMonotonicAfter(stableRun.last?.source ?? null, mutablePoints, 'mutable replacement');
    const mutableRun = compilePointRun(this.header.nominalWidth, mutablePoints, stableRun.last);

    const generation = this.generation + 1;
    const stableCoverage = coverageChunks(stableRun.contours);
    const mutableCoverage = coverageChunks(mutableRun.contours);
    this.stableBounds = unionGeometryBounds(
      this.stableBounds,
      boundsOfContoursOrNull(stableRun.contours),
    );
    const completedBounds = unionGeometryBounds(
      this.stableBounds,
      boundsOfContoursOrNull(mutableRun.contours),
    );
    const common = {
      logicalStrokeId: this.header.logicalStrokeId,
      mutable: {
        coverage: mutableCoverage,
        generation,
        kind: 'replace-bounded-mutable-tail' as const,
      },
      quantization: {
        logicalGrid: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.quantization.logicalGrid,
      },
      stable: {
        coverage: stableCoverage,
        kind: 'append-only-stable' as const,
      },
      version: 'pen-physical-v1' as const,
      workScope: 'new-stable-plus-bounded-mutable-tail' as const,
    };
    const update = createInkBrushActiveGeometryUpdate(
      kind === 'active-finish'
        ? {
            ...common,
            bounds: requireGeometryBounds(completedBounds),
            kind,
            ownershipTransfer: 'active-to-committed-without-blank-frame',
          }
        : { ...common, kind },
    );
    this.lastStable = stableRun.last;
    this.generation = generation;
    this.inspectedPointCount += stablePoints.length + mutablePoints.length;
    this.maximumMutableTailPointCount = Math.max(
      this.maximumMutableTailPointCount,
      mutablePoints.length,
    );
    this.emittedContourCount += stableRun.contours.length + mutableRun.contours.length;
    return update;
  }

  private assertOpen(): void {
    if (this.finished) throw new Error('Ink Pen active geometry compiler is already finished.');
  }
}

function compileCanonicalPenStroke(stroke: PenStroke): PenGeometry {
  const run = compilePointRun(stroke.header.nominalWidth, stroke.trace.points, null);
  if (run.contours.length === 0) throw new Error('Physical Pen produced empty coverage.');
  const coverage = Object.freeze({
    contours: Object.freeze(run.contours),
    kind: 'quantized-filled-contours' as const,
  });
  return createInkBrushCompiledGeometry({
    blend: BLEND,
    bounds: boundsOfContours(run.contours),
    color: stroke.header.color,
    coverage,
    hitShape: HIT_SHAPE,
    logicalStrokeId: stroke.header.logicalStrokeId,
    quantization: {
      logicalGrid: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.quantization.logicalGrid,
    },
    tool: 'pen',
    traceDigest: digestInkBrushControlTrace(stroke, TRACE_QUANTIZATION),
    version: 'pen-physical-v1',
  }) as PenGeometry;
}

function compilePointRun(
  nominalWidth: number,
  sourcePoints: readonly InkPhysicalBrushControlPoint[],
  anchor: ResolvedPenPoint | null,
): CompileRunResult {
  if (sourcePoints.length === 0) return { contours: Object.freeze([]), last: anchor };
  const contours: (readonly InkQuantizedBrushPoint[])[] = [];
  let previous = anchor;
  for (const source of sourcePoints) {
    const current = resolvePoint(nominalWidth, source, previous?.source ?? null);
    if (previous === null) contours.push(diskContour(current));
    else contours.push(capsuleContour(previous, current));
    previous = current;
  }
  return { contours: Object.freeze(contours), last: previous };
}

function resolvePoint(
  nominalWidth: number,
  source: InkPhysicalBrushControlPoint,
  previous: InkPhysicalBrushControlPoint | null,
): ResolvedPenPoint {
  const elapsed = previous === null ? 0 : source.time - previous.time;
  const distance = previous === null ? 0 : Math.hypot(source.x - previous.x, source.y - previous.y);
  const speed =
    previous === null
      ? UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.velocity.referenceSpeed
      : elapsed > 0
        ? distance / elapsed
        : distance === 0
          ? 0
          : Number.POSITIVE_INFINITY;
  return Object.freeze({
    radius:
      resolveUnpublishedInkPenPhysicalDiameter({
        nominalWidth,
        pressure: source.pressure.value,
        speed,
      }) / 2,
    source,
  });
}

function diskContour(point: ResolvedPenPoint): readonly InkQuantizedBrushPoint[] {
  return closeContour(convexHull(circleVertices(point)));
}

function capsuleContour(
  previous: ResolvedPenPoint,
  current: ResolvedPenPoint,
): readonly InkQuantizedBrushPoint[] {
  return closeContour(convexHull([...circleVertices(previous), ...circleVertices(current)]));
}

function circleVertices(point: ResolvedPenPoint): readonly InkQuantizedBrushPoint[] {
  const grid = UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.quantization.logicalGrid;
  const segmentCount = circleSegmentCount(point.radius);
  const vertices: InkQuantizedBrushPoint[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const angle = (Math.PI * 2 * index) / segmentCount;
    const x = quantizeCoordinate(point.source.x + Math.cos(angle) * point.radius, grid);
    const y = quantizeCoordinate(point.source.y + Math.sin(angle) * point.radius, grid);
    vertices.push(Object.freeze({ x, y }));
  }
  return vertices;
}

function circleSegmentCount(radius: number): number {
  const geometry = UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.geometry;
  if (radius <= geometry.maximumContourError) return geometry.minimumCircleSegments;
  const cosine = clamp(1 - geometry.maximumContourError / radius, -1, 1);
  const required = Math.ceil(Math.PI / Math.acos(cosine));
  if (required > geometry.maximumCircleSegments) {
    throw new Error('Physical Pen radius exceeds the unpublished contour-error envelope.');
  }
  const bounded = Math.max(geometry.minimumCircleSegments, required);
  return bounded % 2 === 0 ? bounded : bounded + 1;
}

function convexHull(source: readonly InkQuantizedBrushPoint[]): readonly InkQuantizedBrushPoint[] {
  const unique = new Map<string, InkQuantizedBrushPoint>();
  for (const point of source) unique.set(`${point.x},${point.y}`, point);
  const points = [...unique.values()].sort((left, right) => left.x - right.x || left.y - right.y);
  if (points.length < 3) throw new Error('Physical Pen contour collapsed during quantization.');
  const lower: InkQuantizedBrushPoint[] = [];
  for (const point of points) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: InkQuantizedBrushPoint[] = [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (point === undefined) continue;
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return Object.freeze([...lower, ...upper]);
}

function cross(
  origin: InkQuantizedBrushPoint | undefined,
  left: InkQuantizedBrushPoint | undefined,
  right: InkQuantizedBrushPoint,
): number {
  if (origin === undefined || left === undefined) return 0;
  return (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);
}

function closeContour(
  contour: readonly InkQuantizedBrushPoint[],
): readonly InkQuantizedBrushPoint[] {
  const first = contour[0];
  if (first === undefined || contour.length < 3) throw new Error('Physical Pen contour is empty.');
  return Object.freeze([...contour, first]);
}

function quantizeCoordinate(value: number, grid: number): number {
  const quantized = Math.round(value / grid);
  if (!Number.isSafeInteger(quantized)) {
    throw new Error('Physical Pen contour exceeds the deterministic quantization range.');
  }
  return Object.is(quantized, -0) ? 0 : quantized;
}

function boundsOfContours(contours: readonly (readonly InkQuantizedBrushPoint[])[]): {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
} {
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const contour of contours) {
    for (const point of contour) {
      minimumX = Math.min(minimumX, point.x);
      minimumY = Math.min(minimumY, point.y);
      maximumX = Math.max(maximumX, point.x);
      maximumY = Math.max(maximumY, point.y);
    }
  }
  if (!Number.isFinite(minimumX)) throw new Error('Cannot bound empty physical Pen coverage.');
  const grid = UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.quantization.logicalGrid;
  return Object.freeze({
    height: (maximumY - minimumY) * grid,
    width: (maximumX - minimumX) * grid,
    x: minimumX * grid,
    y: minimumY * grid,
  });
}

function boundsOfContoursOrNull(
  contours: readonly (readonly InkQuantizedBrushPoint[])[],
): InkBrushGeometryBounds | null {
  return contours.length === 0 ? null : boundsOfContours(contours);
}

function unionGeometryBounds(
  left: InkBrushGeometryBounds | null,
  right: InkBrushGeometryBounds | null,
): InkBrushGeometryBounds | null {
  if (left === null) return right;
  if (right === null) return left;
  const maximumX = Math.max(left.x + left.width, right.x + right.width);
  const maximumY = Math.max(left.y + left.height, right.y + right.height);
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return Object.freeze({ height: maximumY - y, width: maximumX - x, x, y });
}

function requireGeometryBounds(bounds: InkBrushGeometryBounds | null): InkBrushGeometryBounds {
  if (bounds === null) throw new Error('Physical Pen cannot finish empty geometry.');
  return bounds;
}

function coverageChunks(
  contours: readonly (readonly InkQuantizedBrushPoint[])[],
): readonly InkFilledContourCoverage[] {
  return contours.length === 0
    ? Object.freeze([])
    : Object.freeze([Object.freeze({ contours, kind: 'quantized-filled-contours' as const })]);
}

function physicalDeltaPoints(
  trace: InkBrushActiveTraceDelta['stableAppend'],
  label: string,
): readonly InkPhysicalBrushControlPoint[] {
  if (trace.kind !== 'physical-control-trace') {
    throw new Error(`Physical Pen ${label} must use a physical control trace.`);
  }
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const point of trace.points) {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      !Number.isFinite(point.time) ||
      point.time < previousTime ||
      !Number.isFinite(point.pressure.value) ||
      point.pressure.value < 0 ||
      point.pressure.value > 1 ||
      (point.pressure.kind !== 'measured' && point.pressure.kind !== 'unavailable') ||
      !isPhysicalOrientation(point.orientation)
    ) {
      throw new Error(`Physical Pen ${label} is not canonical.`);
    }
    previousTime = point.time;
  }
  return trace.points;
}

function isPhysicalOrientation(orientation: InkPhysicalBrushControlPoint['orientation']): boolean {
  return (
    orientation.kind === 'unavailable' ||
    (orientation.kind === 'measured' &&
      Number.isFinite(orientation.altitude) &&
      orientation.altitude >= 0 &&
      orientation.altitude <= Math.PI / 2 &&
      Number.isFinite(orientation.azimuth) &&
      orientation.azimuth >= 0 &&
      orientation.azimuth < Math.PI * 2 &&
      typeof orientation.reliable === 'boolean')
  );
}

function assertMonotonicAfter(
  anchor: InkPhysicalBrushControlPoint | null,
  points: readonly InkPhysicalBrushControlPoint[],
  label: string,
): void {
  const first = points[0];
  if (anchor !== null && first !== undefined && first.time < anchor.time) {
    throw new Error(`Physical Pen ${label} precedes its stable anchor.`);
  }
}

function degradeOrReject(stroke: PenStroke): InkPenPhysicalCompilationResult {
  try {
    const grid = fallbackGrid(stroke);
    const centerline = stroke.trace.points.map(({ x, y }) =>
      Object.freeze({ x: quantizeCoordinate(x, grid), y: quantizeCoordinate(y, grid) }),
    );
    const diameterUnits = Math.max(1, Math.round(stroke.header.nominalWidth / grid));
    if (!Number.isSafeInteger(diameterUnits)) throw new Error('fallback diameter overflow');
    const radius = (diameterUnits * grid) / 2;
    let minimumXUnits = Number.POSITIVE_INFINITY;
    let minimumYUnits = Number.POSITIVE_INFINITY;
    let maximumXUnits = Number.NEGATIVE_INFINITY;
    let maximumYUnits = Number.NEGATIVE_INFINITY;
    for (const point of centerline) {
      minimumXUnits = Math.min(minimumXUnits, point.x);
      minimumYUnits = Math.min(minimumYUnits, point.y);
      maximumXUnits = Math.max(maximumXUnits, point.x);
      maximumYUnits = Math.max(maximumYUnits, point.y);
    }
    const minimumX = minimumXUnits * grid - radius;
    const minimumY = minimumYUnits * grid - radius;
    const maximumX = maximumXUnits * grid + radius;
    const maximumY = maximumYUnits * grid + radius;
    const geometry = createInkBrushCompiledGeometry({
      blend: {
        alpha: { kind: 'from-canonical-color' },
        application: 'once-per-logical-stroke',
        colorSpace: 'srgb',
        composite: 'source-over',
      },
      bounds: {
        height: maximumY - minimumY,
        width: maximumX - minimumX,
        x: minimumX,
        y: minimumY,
      },
      color: stroke.header.color,
      coverage: {
        centerline,
        diameterUnits,
        kind: 'legacy-round-centerline',
      },
      hitShape: { kind: 'round-centerline-distance', radius },
      logicalStrokeId: stroke.header.logicalStrokeId,
      quantization: { logicalGrid: grid },
      tool: 'pen',
      traceDigest: digestInkBrushControlTrace(stroke, TRACE_QUANTIZATION),
      version: 'legacy-round-v1',
    });
    createInkBrushCompilationResult({
      diagnostic: 'known-version-geometry-failure',
      geometry,
      kind: 'degraded',
      requestedVersion: 'pen-physical-v1',
    });
    return Object.freeze({
      diagnostic: 'known-version-geometry-failure',
      geometry,
      kind: 'degraded',
      requestedVersion: 'pen-physical-v1',
    });
  } catch {
    return unsupported('invalid-canonical-stroke', 'pen-physical-v1');
  }
}

function fallbackGrid(stroke: PenStroke): number {
  let maximumCoordinate = stroke.header.nominalWidth;
  for (const { x, y } of stroke.trace.points) {
    maximumCoordinate = Math.max(maximumCoordinate, Math.abs(x), Math.abs(y));
  }
  return Math.max(
    UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.quantization.logicalGrid,
    maximumCoordinate / (Number.MAX_SAFE_INTEGER / 4),
  );
}

function unsupported(
  reason: 'invalid-canonical-stroke' | 'unknown-version',
  requestedVersion: string,
): Extract<InkBrushCompilationResult, { readonly kind: 'unsupported' }> {
  createInkBrushCompilationResult({ kind: 'unsupported', reason, requestedVersion });
  return Object.freeze({ kind: 'unsupported', reason, requestedVersion });
}

function isPenStroke(stroke: InkBrushLogicalStroke): stroke is PenStroke {
  return stroke.header.version === 'pen-physical-v1' && stroke.header.tool === 'pen';
}

function requestedVersionOf(input: unknown): string {
  try {
    if (typeof input !== 'object' || input === null) return 'pen-physical-v1';
    const header = Reflect.get(input, 'header') as unknown;
    if (typeof header !== 'object' || header === null) return 'pen-physical-v1';
    const version = Reflect.get(header, 'version') as unknown;
    return typeof version === 'string' && version.length > 0 ? version : 'pen-physical-v1';
  } catch {
    return 'pen-physical-v1';
  }
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key), seen);
  return Object.freeze(value);
}
