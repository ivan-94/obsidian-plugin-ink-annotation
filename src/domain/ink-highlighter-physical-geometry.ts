import { digestInkBrushGolden } from './ink-brush-contract';
import {
  createInkBrushActiveGeometryUpdate,
  createInkBrushCompilationResult,
  createInkBrushCompiledGeometry,
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
  InkHighlighterPhysicalLogicalStrokeHeader,
  InkPhysicalBrushControlPoint,
  InkQuantizedBrushPoint,
} from './ink-brush-geometry-contract';

/**
 * Build/test metadata for the S32 candidate. S34 owns physical calibration and publication; none
 * of these candidate values may enter canonical Ink or enable production input.
 */
export const UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE = deepFreeze({
  active: {
    maximumMutableTailPoints: 12,
  },
  calibrationOwner: 'S34',
  candidateRevision: 's32-highlighter-geometry-r1',
  enabledByDefault: false,
  geometry: {
    capSegments: 6,
  },
  opticalDensity: 0.35,
  orientation: {
    defaultAngle: Math.PI / 4,
    defaultAltitude: Math.PI / 2,
    uprightEnterAltitude: Math.PI * 0.45,
    uprightExitAltitude: Math.PI * 0.4,
  },
  pressure: {
    maximumScale: 1.08,
    minimumScale: 0.9,
    referencePressure: 0.5,
  },
  publication: 'unpublished-default-off',
  quantization: {
    logicalGrid: 1 / 256,
    sensorGrid: 1 / 4096,
    traceCoordinateGrid: 1 / 1024,
    traceTimeGridMs: 1 / 1000,
  },
  tilt: {
    maximumAspectRatio: 0.52,
    minimumAspectRatio: 0.26,
  },
} as const);

type HighlighterStroke = Extract<
  InkBrushLogicalStroke,
  { readonly header: { readonly version: 'highlighter-chisel-v1' } }
>;
type HighlighterGeometry = Extract<
  InkCompiledBrushGeometry,
  { readonly version: 'highlighter-chisel-v1' }
>;

export type InkHighlighterPhysicalCompilationResult =
  | (Extract<InkBrushCompilationResult, { readonly kind: 'degraded' }> & {
      readonly requestedVersion: 'highlighter-chisel-v1';
    })
  | Extract<InkBrushCompilationResult, { readonly kind: 'unsupported' }>
  | { readonly geometry: HighlighterGeometry; readonly kind: 'unpublished' };

export interface InkHighlighterPhysicalGeometryStats {
  readonly calibrationOwner: 'S34';
  readonly candidateRevision: 's32-highlighter-geometry-r1';
  readonly emittedContourCount: number;
  readonly inspectedPointCount: number;
  readonly maximumMutableTailPointCount: number;
  readonly publication: 'unpublished-default-off';
}

export type InkHighlighterPhysicalActiveGeometryCompilerCreation =
  | { readonly compiler: InkHighlighterPhysicalActiveGeometryCompiler; readonly kind: 'ready' }
  | {
      readonly kind: 'unsupported';
      readonly reason: 'invalid-header' | 'unknown-version' | 'wrong-brush';
      readonly requestedVersion: string;
    };

interface ChiselAngleState {
  readonly angle: number;
  readonly altitude: number;
  readonly upright: boolean;
}

interface ResolvedChiselPoint {
  readonly angle: number;
  readonly halfMajor: number;
  readonly halfMinor: number;
  readonly source: InkPhysicalBrushControlPoint;
}

interface CompileRunResult {
  readonly angleState: ChiselAngleState;
  readonly contours: readonly (readonly InkQuantizedBrushPoint[])[];
  readonly last: ResolvedChiselPoint | null;
}

const BLEND = Object.freeze({
  alpha: Object.freeze({
    kind: 'fixed' as const,
    value: UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.opticalDensity,
  }),
  application: 'once-per-logical-stroke' as const,
  colorSpace: 'srgb' as const,
  composite: 'source-over' as const,
});
const HIT_SHAPE = Object.freeze({
  fillRule: 'nonzero' as const,
  kind: 'filled-contour-distance' as const,
});
const TRACE_QUANTIZATION = Object.freeze({
  coordinateGrid: UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.quantization.traceCoordinateGrid,
  sensorGrid: UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.quantization.sensorGrid,
  timeGridMs: UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.quantization.traceTimeGridMs,
});

/** Compile one already-joined canonical Highlighter Logical Stroke. */
export function compileInkHighlighterPhysicalGeometry(
  input: unknown,
): InkHighlighterPhysicalCompilationResult {
  const decoded = decodeInkBrushLogicalStroke(input);
  if (decoded.kind === 'unsupported') return unsupported('unknown-version', decoded.version);
  if (decoded.kind === 'invalid') {
    return unsupported('invalid-canonical-stroke', requestedVersionOf(input));
  }
  if (!isHighlighterStroke(decoded.stroke)) {
    return unsupported('invalid-canonical-stroke', decoded.stroke.header.version);
  }
  try {
    const run = compilePointRun(
      decoded.stroke.header.nominalWidth,
      decoded.stroke.trace.points,
      null,
      initialAngleState(),
    );
    if (run.contours.length === 0) throw new Error('empty coverage');
    const geometry = createInkBrushCompiledGeometry({
      blend: BLEND,
      bounds: boundsOfContours(run.contours),
      color: decoded.stroke.header.color,
      coverage: {
        contours: run.contours,
        kind: 'quantized-filled-contours',
      },
      hitShape: HIT_SHAPE,
      logicalStrokeId: decoded.stroke.header.logicalStrokeId,
      quantization: {
        logicalGrid: UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.quantization.logicalGrid,
      },
      tool: 'highlighter',
      traceDigest: digestInkBrushControlTrace(decoded.stroke, TRACE_QUANTIZATION),
      version: 'highlighter-chisel-v1',
    }) as HighlighterGeometry;
    createInkBrushCompilationResult({ geometry, kind: 'unpublished' });
    return Object.freeze({ geometry, kind: 'unpublished' });
  } catch {
    return degradeOrReject(decoded.stroke);
  }
}

export function createInkHighlighterPhysicalActiveGeometryCompiler(
  header: unknown,
): InkHighlighterPhysicalActiveGeometryCompilerCreation {
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
  if (decoded.stroke.header.version !== 'highlighter-chisel-v1') {
    return Object.freeze({
      kind: 'unsupported',
      reason: 'wrong-brush',
      requestedVersion: decoded.stroke.header.version,
    });
  }
  return Object.freeze({
    compiler: InkHighlighterPhysicalActiveGeometryCompiler.create(decoded.stroke.header),
    kind: 'ready',
  });
}

/**
 * Streaming candidate compiler. Only a stable anchor and reliable-orientation state survive a
 * call; mutable coverage is rebuilt from the bounded S30 replacement and never scans old prefix.
 */
export class InkHighlighterPhysicalActiveGeometryCompiler implements InkBrushActiveGeometryCompiler {
  private angleState = initialAngleState();
  private emittedContourCount = 0;
  private finished = false;
  private generation = 0;
  private inspectedPointCount = 0;
  private lastStable: ResolvedChiselPoint | null = null;
  private maximumMutableTailPointCount = 0;
  private stableBounds: InkBrushGeometryBounds | null = null;

  private constructor(private readonly header: InkHighlighterPhysicalLogicalStrokeHeader) {}

  static create(
    header: InkHighlighterPhysicalLogicalStrokeHeader,
  ): InkHighlighterPhysicalActiveGeometryCompiler {
    return new InkHighlighterPhysicalActiveGeometryCompiler(header);
  }

  extend(delta: InkBrushActiveTraceDelta): InkBrushActiveGeometryDelta {
    this.assertOpen();
    const update = this.update('active-delta', delta);
    if (update.kind !== 'active-delta') throw new Error('Highlighter active update kind mismatch.');
    return update;
  }

  finish(delta: InkBrushActiveTraceDelta): InkBrushActiveGeometryFinish {
    this.assertOpen();
    const update = this.update('active-finish', delta);
    if (update.kind !== 'active-finish')
      throw new Error('Highlighter finish update kind mismatch.');
    this.finished = true;
    return update;
  }

  stats(): InkHighlighterPhysicalGeometryStats {
    return Object.freeze({
      calibrationOwner: UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.calibrationOwner,
      candidateRevision: UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.candidateRevision,
      emittedContourCount: this.emittedContourCount,
      inspectedPointCount: this.inspectedPointCount,
      maximumMutableTailPointCount: this.maximumMutableTailPointCount,
      publication: UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.publication,
    });
  }

  private update(
    kind: 'active-delta' | 'active-finish',
    delta: InkBrushActiveTraceDelta,
  ): InkBrushActiveGeometryDelta | InkBrushActiveGeometryFinish {
    const stablePoints = physicalDeltaPoints(delta.stableAppend, this.header, 'stable append');
    const mutablePoints = physicalDeltaPoints(
      delta.mutableReplacement,
      this.header,
      'mutable replacement',
    );
    if (
      mutablePoints.length >
      UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.active.maximumMutableTailPoints
    ) {
      throw new Error('Highlighter mutable replacement exceeds the unpublished hard bound.');
    }
    if (
      kind === 'active-finish' &&
      this.lastStable === null &&
      stablePoints.length === 0 &&
      mutablePoints.length === 0
    ) {
      throw new Error('Highlighter cannot transfer blank active ownership.');
    }
    assertMonotonicAfter(this.lastStable?.source ?? null, stablePoints, 'stable append');
    const stableRun = compilePointRun(
      this.header.nominalWidth,
      stablePoints,
      this.lastStable,
      this.angleState,
    );
    assertMonotonicAfter(stableRun.last?.source ?? null, mutablePoints, 'mutable replacement');
    const mutableRun = compilePointRun(
      this.header.nominalWidth,
      mutablePoints,
      stableRun.last,
      stableRun.angleState,
    );

    const generation = this.generation + 1;
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
        coverage: coverageChunks(mutableRun.contours),
        generation,
        kind: 'replace-bounded-mutable-tail' as const,
      },
      quantization: {
        logicalGrid: UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.quantization.logicalGrid,
      },
      stable: {
        coverage: coverageChunks(stableRun.contours),
        kind: 'append-only-stable' as const,
      },
      version: 'highlighter-chisel-v1' as const,
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
    this.angleState = stableRun.angleState;
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
    if (this.finished) throw new Error('Highlighter active geometry compiler is already finished.');
  }
}

export function digestInkHighlighterPhysicalCoverage(
  contours: readonly (readonly InkQuantizedBrushPoint[])[],
): string {
  return digestInkBrushGolden({
    contours,
    kind: 'highlighter-chisel-filled-coverage-v1',
    logicalGrid: UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.quantization.logicalGrid,
  });
}

/** Optical result at one pixel after compositing distinct Logical Strokes with source-over. */
export function compositeUnpublishedInkHighlighterStrokeAlpha(
  distinctLogicalStrokeCount: number,
): number {
  if (!Number.isSafeInteger(distinctLogicalStrokeCount) || distinctLogicalStrokeCount < 0) {
    throw new Error('Distinct Highlighter Logical Stroke count must be a non-negative integer.');
  }
  return (
    1 -
    (1 - UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.opticalDensity) ** distinctLogicalStrokeCount
  );
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
  header: InkHighlighterPhysicalLogicalStrokeHeader,
  label: string,
): readonly InkPhysicalBrushControlPoint[] {
  if (trace.kind !== 'physical-control-trace') {
    throw new Error(`Highlighter ${label} must use a physical control trace.`);
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
      (header.inputProfile.pressure === 'unavailable' && point.pressure.kind !== 'unavailable') ||
      !isPhysicalOrientation(point.orientation) ||
      (header.inputProfile.tilt === 'unavailable' && point.orientation.kind !== 'unavailable')
    ) {
      throw new Error(`Highlighter ${label} is not canonical.`);
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
    throw new Error(`Highlighter ${label} precedes its stable anchor.`);
  }
}

function compilePointRun(
  nominalWidth: number,
  points: readonly InkPhysicalBrushControlPoint[],
  anchor: ResolvedChiselPoint | null,
  startAngleState: ChiselAngleState,
): CompileRunResult {
  const contours: (readonly InkQuantizedBrushPoint[])[] = [];
  let angleState = startAngleState;
  let previous = anchor;
  for (const source of points) {
    angleState = nextAngleState(angleState, source.orientation);
    const current = resolvePoint(nominalWidth, source, angleState.angle, angleState.altitude);
    const vertices = roundedChiselVertices(current);
    contours.push(
      closeContour(
        convexHull(
          previous === null ? vertices : [...roundedChiselVertices(previous), ...vertices],
        ),
      ),
    );
    previous = current;
  }
  return Object.freeze({ angleState, contours: Object.freeze(contours), last: previous });
}

function initialAngleState(): ChiselAngleState {
  return Object.freeze({
    angle: normalizeHalfTurn(UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.orientation.defaultAngle),
    altitude: UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.orientation.defaultAltitude,
    upright: false,
  });
}

function nextAngleState(
  previous: ChiselAngleState,
  orientation: InkPhysicalBrushControlPoint['orientation'],
): ChiselAngleState {
  if (orientation.kind !== 'measured' || !orientation.reliable) return previous;
  const thresholds = UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.orientation;
  if (previous.upright && orientation.altitude >= thresholds.uprightExitAltitude) {
    return Object.freeze({ ...previous, altitude: orientation.altitude });
  }
  if (!previous.upright && orientation.altitude >= thresholds.uprightEnterAltitude) {
    return Object.freeze({ ...previous, altitude: orientation.altitude, upright: true });
  }
  const angle = unwrapHalfTurn(previous.angle, orientation.azimuth);
  return Object.freeze({
    altitude: orientation.altitude,
    angle,
    upright: false,
  });
}

function resolvePoint(
  nominalWidth: number,
  source: InkPhysicalBrushControlPoint,
  angle: number,
  altitude: number,
): ResolvedChiselPoint {
  const pressure = clamp(source.pressure.value, 0, 1);
  const pressureProfile = UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.pressure;
  const pressureScale =
    pressure <= pressureProfile.referencePressure
      ? interpolate(pressureProfile.minimumScale, 1, pressure / pressureProfile.referencePressure)
      : interpolate(
          1,
          pressureProfile.maximumScale,
          (pressure - pressureProfile.referencePressure) / (1 - pressureProfile.referencePressure),
        );
  const tilt = UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.tilt;
  const aspectRatio = interpolate(
    tilt.minimumAspectRatio,
    tilt.maximumAspectRatio,
    clamp(altitude / (Math.PI / 2), 0, 1),
  );
  const major = nominalWidth * pressureScale;
  return Object.freeze({
    angle,
    halfMajor: major / 2,
    halfMinor: (major * aspectRatio) / 2,
    source,
  });
}

function roundedChiselVertices(point: ResolvedChiselPoint): readonly InkQuantizedBrushPoint[] {
  const segmentCount = UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.geometry.capSegments;
  const straightHalf = Math.max(0, point.halfMajor - point.halfMinor);
  const cosine = Math.cos(point.angle);
  const sine = Math.sin(point.angle);
  const vertices: InkQuantizedBrushPoint[] = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    const theta = -Math.PI / 2 + (Math.PI * index) / segmentCount;
    vertices.push(
      quantizedLocalPoint(
        point,
        straightHalf + Math.cos(theta) * point.halfMinor,
        Math.sin(theta) * point.halfMinor,
        cosine,
        sine,
      ),
    );
  }
  for (let index = 0; index <= segmentCount; index += 1) {
    const theta = Math.PI / 2 + (Math.PI * index) / segmentCount;
    vertices.push(
      quantizedLocalPoint(
        point,
        -straightHalf + Math.cos(theta) * point.halfMinor,
        Math.sin(theta) * point.halfMinor,
        cosine,
        sine,
      ),
    );
  }
  return Object.freeze(vertices);
}

function quantizedLocalPoint(
  point: ResolvedChiselPoint,
  localX: number,
  localY: number,
  cosine: number,
  sine: number,
): InkQuantizedBrushPoint {
  const grid = UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.quantization.logicalGrid;
  return Object.freeze({
    x: quantizeCoordinate(point.source.x + localX * cosine - localY * sine, grid),
    y: quantizeCoordinate(point.source.y + localX * sine + localY * cosine, grid),
  });
}

function convexHull(source: readonly InkQuantizedBrushPoint[]): readonly InkQuantizedBrushPoint[] {
  const unique = new Map<string, InkQuantizedBrushPoint>();
  for (const point of source) unique.set(`${point.x},${point.y}`, point);
  const points = [...unique.values()].sort((left, right) => left.x - right.x || left.y - right.y);
  if (points.length < 3) throw new Error('Highlighter contour collapsed during quantization.');
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
  if (first === undefined) throw new Error('Cannot close empty Highlighter contour.');
  return Object.freeze([...contour, first]);
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
  if (!Number.isFinite(minimumX)) throw new Error('Cannot bound empty Highlighter coverage.');
  const grid = UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.quantization.logicalGrid;
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
  if (bounds === null) throw new Error('Highlighter cannot finish empty geometry.');
  return bounds;
}

function quantizeCoordinate(value: number, grid: number): number {
  const quantized = Math.round(value / grid);
  if (!Number.isSafeInteger(quantized)) throw new Error('Highlighter quantization overflow.');
  return Object.is(quantized, -0) ? 0 : quantized;
}

function degradeOrReject(stroke: HighlighterStroke): InkHighlighterPhysicalCompilationResult {
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
      color: degradedHighlighterColor(stroke.header.color),
      coverage: {
        centerline,
        diameterUnits,
        kind: 'legacy-round-centerline',
      },
      hitShape: { kind: 'round-centerline-distance', radius },
      logicalStrokeId: stroke.header.logicalStrokeId,
      quantization: { logicalGrid: grid },
      tool: 'highlighter',
      traceDigest: digestInkBrushControlTrace(stroke, {
        ...TRACE_QUANTIZATION,
        coordinateGrid: grid,
      }),
      version: 'legacy-round-v1',
    });
    createInkBrushCompilationResult({
      diagnostic: 'known-version-geometry-failure',
      geometry,
      kind: 'degraded',
      requestedVersion: 'highlighter-chisel-v1',
    });
    return Object.freeze({
      diagnostic: 'known-version-geometry-failure',
      geometry,
      kind: 'degraded',
      requestedVersion: 'highlighter-chisel-v1',
    });
  } catch {
    return unsupported('invalid-canonical-stroke', 'highlighter-chisel-v1');
  }
}

function fallbackGrid(stroke: HighlighterStroke): number {
  let maximumCoordinate = stroke.header.nominalWidth;
  for (const { x, y } of stroke.trace.points) {
    maximumCoordinate = Math.max(maximumCoordinate, Math.abs(x), Math.abs(y));
  }
  return Math.max(
    UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.quantization.logicalGrid,
    maximumCoordinate / (Number.MAX_SAFE_INTEGER / 4),
  );
}

function degradedHighlighterColor(opaqueCanonicalColor: string): string {
  const alphaByte = Math.round(UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.opticalDensity * 255);
  return `${opaqueCanonicalColor}${alphaByte.toString(16).padStart(2, '0')}`;
}

function unsupported(
  reason: 'invalid-canonical-stroke' | 'unknown-version',
  requestedVersion: string,
): Extract<InkBrushCompilationResult, { readonly kind: 'unsupported' }> {
  createInkBrushCompilationResult({ kind: 'unsupported', reason, requestedVersion });
  return Object.freeze({ kind: 'unsupported', reason, requestedVersion });
}

function isHighlighterStroke(stroke: InkBrushLogicalStroke): stroke is HighlighterStroke {
  return stroke.header.version === 'highlighter-chisel-v1' && stroke.header.tool === 'highlighter';
}

function requestedVersionOf(input: unknown): string {
  try {
    if (typeof input !== 'object' || input === null) return 'highlighter-chisel-v1';
    const header = Reflect.get(input, 'header') as unknown;
    if (typeof header !== 'object' || header === null) return 'highlighter-chisel-v1';
    const version = Reflect.get(header, 'version') as unknown;
    return typeof version === 'string' && version.length > 0 ? version : 'highlighter-chisel-v1';
  } catch {
    return 'highlighter-chisel-v1';
  }
}

function unwrapHalfTurn(previous: number, next: number): number {
  return previous + shortestHalfTurn(next - previous);
}

function shortestHalfTurn(value: number): number {
  const normalized = normalizeHalfTurn(value + Math.PI / 2);
  return normalized - Math.PI / 2;
}

function normalizeHalfTurn(value: number): number {
  const result = value % Math.PI;
  return result < 0 ? result + Math.PI : result;
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
