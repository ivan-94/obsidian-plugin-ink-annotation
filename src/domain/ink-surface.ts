import { SharedInkStrokeGeometry } from './ink-shared-stroke-geometry';
import { resolveInkBrushContract } from './ink-brush-contract';
import type {
  InkPhysicalBrushControlPoint,
  InkPhysicalBrushControlTrace,
} from './ink-brush-geometry-contract';
import type {
  InkBrushInputProfile,
  InkBrushRenderVersion,
  InkLegacyBrushInputProfile,
  InkPhysicalBrushInputProfile,
} from './ink-brush-contract';

const SHARED_INK_GEOMETRY = new SharedInkStrokeGeometry();
const INK_BINDING_KEYS = canonicalKeySet([
  'blockFingerprints',
  'headingPath',
  'sectionFingerprint',
  'sourceEnd',
  'sourceStart',
]);
const INK_LAYOUT_KEYS = canonicalKeySet([
  'blockFingerprints',
  'fontFamily',
  'fontSize',
  'lineHeight',
  'logicalHeight',
  'logicalWidth',
  'originY',
  'sourceRevision',
  'themeMode',
]);
const INK_POINT_KEYS = canonicalKeySet(['pressure', 'tiltX', 'tiltY', 'time', 'x', 'y']);
const INK_PHYSICAL_POINT_KEYS = canonicalKeySet([
  'fragmentBoundary',
  'fragmentBoundaryEdge',
  'fragmentBoundaryId',
  'fragmentGlobalY',
  'fragmentTraceOrder',
  'orientation',
  'pressure',
  'pressureKind',
  'time',
  'x',
  'y',
]);
const INK_PHYSICAL_PRESSURE_KEYS = canonicalKeySet(['kind', 'value']);
const STORED_PHYSICAL_POINT_KEYS = canonicalKeySet([
  'fragmentBoundary',
  'fragmentBoundaryEdge',
  'fragmentBoundaryId',
  'fragmentGlobalY',
  'fragmentTraceOrder',
  'orientation',
  'pressure',
  'time',
  'x',
  'y',
]);
const INK_PHYSICAL_ORIENTATION_UNAVAILABLE_KEYS = canonicalKeySet(['kind']);
const INK_PHYSICAL_ORIENTATION_MEASURED_KEYS = canonicalKeySet([
  'altitude',
  'azimuth',
  'kind',
  'reliable',
]);
const INK_STROKE_KEYS = canonicalKeySet([
  'brushRenderVersion',
  'color',
  'id',
  'inputProfile',
  'linkedStrokeId',
  'points',
  'tool',
  'width',
]);
const STORED_INK_STROKE_KEYS = canonicalKeySet([
  'brushRenderVersion',
  'color',
  'deltas',
  'id',
  'inputProfile',
  'linkedStrokeId',
  'origin',
  'pointEncoding',
  'tool',
  'width',
]);
const STORED_POINT_DELTA_KEYS = canonicalKeySet(['dp', 'dt', 'dx', 'dy', 'tiltX', 'tiltY']);
const STORED_PHYSICAL_POINT_DELTA_KEYS = canonicalKeySet([
  'dt',
  'dx',
  'dy',
  'fragmentBoundary',
  'fragmentBoundaryEdge',
  'fragmentBoundaryId',
  'fragmentGlobalY',
  'fragmentTraceOrder',
  'orientation',
  'pressure',
]);
const INK_SURFACE_RECORD_KEYS = canonicalKeySet([
  'binding',
  'createdAt',
  'deletedAt',
  'deviceId',
  'filePath',
  'id',
  'layout',
  'noteId',
  'revision',
  'schemaVersion',
  'status',
  'strokes',
  'updatedAt',
]);

export interface InkPoint {
  readonly orientation?: InkPhysicalBrushControlPoint['orientation'];
  readonly pressure: number;
  readonly pressureKind?: InkPhysicalBrushControlPoint['pressure']['kind'];
  readonly tiltX?: number;
  readonly tiltY?: number;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export interface InkPhysicalPoint extends InkPoint {
  /** Fragment-only duplicated boundary sample; joined canonical traces merge or remove it. */
  readonly fragmentBoundary?: 'authored-copy' | 'synthetic-clip';
  /** Exact surface edge occupied by this duplicated boundary sample. */
  readonly fragmentBoundaryEdge?: 'end' | 'start';
  /** Stable identity shared by the two surface-local copies of one boundary event. */
  readonly fragmentBoundaryId?: string;
  /** Exact note-global Y retained only while a physical point is surface-local. */
  readonly fragmentGlobalY?: number;
  /** Fragment-only total order; joined canonical traces remove it. */
  readonly fragmentTraceOrder?: number;
  readonly orientation: InkPhysicalBrushControlPoint['orientation'];
  readonly pressureKind: InkPhysicalBrushControlPoint['pressure']['kind'];
  readonly tiltX?: never;
  readonly tiltY?: never;
}

/** Lossless schema-v3 storage projection for the S28 physical Brush Control Trace contract. */
export function physicalTraceToInkPoints(
  trace: InkPhysicalBrushControlTrace,
): readonly InkPhysicalPoint[] {
  return Object.freeze(
    trace.points.map((point) =>
      Object.freeze({
        orientation: Object.freeze(clonePhysicalOrientation(point.orientation)),
        pressure: point.pressure.value,
        pressureKind: point.pressure.kind,
        time: point.time,
        x: point.x,
        y: point.y,
      }),
    ),
  );
}

/** Rehydrates the exact S28 trace shape without inventing sensor availability or orientation. */
export function inkPointsToPhysicalTrace(
  points: readonly InkPhysicalPoint[],
): InkPhysicalBrushControlTrace {
  return Object.freeze({
    kind: 'physical-control-trace',
    points: Object.freeze(
      points.map((point) =>
        Object.freeze({
          orientation: Object.freeze(clonePhysicalOrientation(point.orientation)),
          pressure: Object.freeze({ kind: point.pressureKind, value: point.pressure }),
          time: point.time,
          x: point.x,
          y: point.y,
        }),
      ),
    ),
  });
}

/**
 * Unchecked compatibility envelope used at application and persistence boundaries before runtime
 * validation. Consumers that require canonical brush metadata must use `InkNormalizedStroke` (or
 * call `assertInkSurfaceRecord`) instead of treating this broad transport shape as a closed union.
 */
export interface InkStroke {
  readonly brushRenderVersion?: InkBrushRenderVersion;
  readonly color: string;
  readonly id: string;
  readonly inputProfile?: InkBrushInputProfile;
  readonly linkedStrokeId?: string;
  readonly points: readonly InkPoint[];
  readonly tool: 'eraser' | 'highlighter' | 'pen';
  readonly width: number;
}

export interface InkHistoricalVisibleStroke extends InkStroke {
  readonly brushRenderVersion?: never;
  readonly inputProfile?: never;
  readonly tool: 'highlighter' | 'pen';
}

export interface InkLegacyVisibleStroke extends InkStroke {
  readonly brushRenderVersion: 'legacy-round-v1';
  readonly inputProfile: InkLegacyBrushInputProfile;
  readonly tool: 'highlighter' | 'pen';
}

export interface InkPhysicalPenStroke extends InkStroke {
  readonly brushRenderVersion: 'pen-physical-v1';
  readonly inputProfile: InkPhysicalBrushInputProfile;
  readonly points: readonly InkPhysicalPoint[];
  readonly tool: 'pen';
}

export interface InkPhysicalHighlighterStroke extends InkStroke {
  readonly brushRenderVersion: 'highlighter-chisel-v1';
  readonly inputProfile: InkPhysicalBrushInputProfile;
  readonly points: readonly InkPhysicalPoint[];
  readonly tool: 'highlighter';
}

export interface InkHistoricalEraserStroke extends InkStroke {
  readonly brushRenderVersion?: never;
  readonly inputProfile?: never;
  readonly tool: 'eraser';
}

export type InkNormalizedStroke =
  | InkHistoricalEraserStroke
  | InkLegacyVisibleStroke
  | InkPhysicalHighlighterStroke
  | InkPhysicalPenStroke;

export interface InkSurfaceRecord {
  readonly binding?: {
    readonly blockFingerprints: readonly string[];
    readonly headingPath: readonly string[];
    readonly sectionFingerprint: string;
    readonly sourceEnd: number;
    readonly sourceStart: number;
  };
  readonly createdAt: string;
  readonly deletedAt?: string;
  readonly deviceId?: string;
  readonly filePath: string;
  readonly id: string;
  readonly layout: InkSurfaceLayout;
  readonly noteId: string;
  readonly revision: number;
  readonly schemaVersion: 1 | 2 | 3;
  readonly status: 'active' | 'needs-rebase' | 'unanchored';
  readonly strokes: readonly InkStroke[];
  readonly updatedAt: string;
}

export interface InkNormalizedSurfaceRecord extends Omit<InkSurfaceRecord, 'strokes'> {
  readonly strokes: readonly InkNormalizedStroke[];
}

export type InkSurfaceDecodeResult =
  | {
      readonly kind: 'corrupt';
      readonly rawBytes: string;
      readonly reason: 'invalid-json' | 'invalid-record';
    }
  | {
      readonly kind: 'decoded';
      readonly record: InkNormalizedSurfaceRecord;
    }
  | {
      readonly kind: 'unsupported';
      readonly rawBytes: string;
      readonly reason:
        'unsupported-brush-metadata' | 'unsupported-brush-version' | 'unsupported-schema-version';
    };

export interface InkSurfaceLayout {
  readonly blockFingerprints: readonly string[];
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly originY?: number;
  readonly sourceRevision: string;
  readonly themeMode: 'dark' | 'light';
}

export interface InkSurfaceVisibleBounds {
  readonly height: number;
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
}

/**
 * Temporary S29 fence for consumers that still only understand legacy centerline geometry.
 * S33 replaces this fence with the shared Brush Geometry registry; until then a physical stroke
 * must never be silently projected as `legacy-round-v1`.
 */
export function assertInkLegacyGeometryConsumerSupported(record: InkSurfaceRecord): void {
  assertInkSurfaceRecord(record);
  const physical = record.strokes.find(
    (stroke) =>
      stroke.tool !== 'eraser' &&
      stroke.brushRenderVersion !== undefined &&
      stroke.brushRenderVersion !== 'legacy-round-v1',
  );
  if (physical !== undefined) {
    throw new Error(
      `Ink legacy geometry consumer cannot use ${physical.brushRenderVersion} before the shared physical geometry consumers are available.`,
    );
  }
}

export function inkSurfaceVisibleBounds(record: InkSurfaceRecord): InkSurfaceVisibleBounds {
  assertInkSurfaceRecord(record);
  let minimumX = 0;
  let minimumY = 0;
  let maximumX = record.layout.logicalWidth;
  let maximumY = record.layout.logicalHeight;
  for (const stroke of record.strokes) {
    if (stroke.tool === 'eraser') continue;
    const bounds = SHARED_INK_GEOMETRY.bounds(stroke);
    minimumX = Math.min(minimumX, bounds.x);
    minimumY = Math.min(minimumY, bounds.y);
    maximumX = Math.max(maximumX, bounds.x + bounds.width);
    maximumY = Math.max(maximumY, bounds.y + bounds.height);
  }
  return {
    height: maximumY - minimumY,
    minX: minimumX,
    minY: minimumY,
    width: maximumX - minimumX,
  };
}

export function encodeInkSurfaceRecord(record: InkSurfaceRecord): string {
  assertInkSurfaceRecord(record);
  return `${JSON.stringify(toStoredRecord(record), null, 2)}\n`;
}

export function decodeInkSurfaceRecord(value: string): InkNormalizedSurfaceRecord {
  const result = safeDecodeInkSurfaceRecord(value);
  if (result.kind === 'decoded') return result.record;
  if (result.kind === 'corrupt' && result.reason === 'invalid-json') {
    throw new Error('Ink surface record is not valid JSON.');
  }
  if (result.kind === 'unsupported' && result.reason !== 'unsupported-schema-version') {
    throw new Error('Ink surface record contains unsupported brush metadata.');
  }
  throw new Error('Ink surface record does not match a supported schema version.');
}

export function safeDecodeInkSurfaceRecord(rawBytes: string): InkSurfaceDecodeResult {
  let stored: unknown;
  try {
    stored = JSON.parse(rawBytes);
  } catch {
    return { kind: 'corrupt', rawBytes, reason: 'invalid-json' };
  }
  if (
    isRecord(stored) &&
    'schemaVersion' in stored &&
    !isSupportedSchemaVersion(stored.schemaVersion)
  ) {
    return { kind: 'unsupported', rawBytes, reason: 'unsupported-schema-version' };
  }
  if (isRecord(stored) && isSupportedSchemaVersion(stored.schemaVersion)) {
    if (hasOwn(stored, 'candidateRevision')) {
      return { kind: 'unsupported', rawBytes, reason: 'unsupported-brush-metadata' };
    }
    const unsupportedBrush = classifyUnsupportedStoredBrush(stored, stored.schemaVersion);
    if (unsupportedBrush !== null) {
      return { kind: 'unsupported', rawBytes, reason: unsupportedBrush };
    }
  }
  const parsed = normalizeLegacyBrushMetadata(inflateStoredRecord(stored));
  if (!isInkSurfaceRecord(parsed)) {
    return { kind: 'corrupt', rawBytes, reason: 'invalid-record' };
  }
  try {
    assertInkSurfaceRecord(parsed);
  } catch {
    return { kind: 'corrupt', rawBytes, reason: 'invalid-record' };
  }
  return { kind: 'decoded', record: parsed as InkNormalizedSurfaceRecord };
}

function toStoredRecord(record: InkSurfaceRecord): Record<string, unknown> {
  return {
    binding:
      record.binding === undefined
        ? undefined
        : {
            blockFingerprints: record.binding.blockFingerprints,
            headingPath: record.binding.headingPath,
            sectionFingerprint: record.binding.sectionFingerprint,
            sourceEnd: record.binding.sourceEnd,
            sourceStart: record.binding.sourceStart,
          },
    createdAt: record.createdAt,
    deletedAt: record.deletedAt,
    deviceId: record.deviceId,
    filePath: record.filePath,
    id: record.id,
    layout: {
      blockFingerprints: record.layout.blockFingerprints,
      fontFamily: record.layout.fontFamily,
      fontSize: record.layout.fontSize,
      lineHeight: record.layout.lineHeight,
      logicalHeight: record.layout.logicalHeight,
      logicalWidth: record.layout.logicalWidth,
      sourceRevision: record.layout.sourceRevision,
      themeMode: record.layout.themeMode,
      originY: record.layout.originY,
    },
    noteId: record.noteId,
    revision: record.revision,
    schemaVersion: record.schemaVersion,
    status: record.status,
    strokes: record.strokes.map((stroke) => toStoredStroke(stroke, record.schemaVersion)),
    updatedAt: record.updatedAt,
  };
}

function toStoredStroke(stroke: InkStroke, schemaVersion: 1 | 2 | 3): Record<string, unknown> {
  const common = {
    color: stroke.color,
    id: stroke.id,
    linkedStrokeId: stroke.linkedStrokeId,
    tool: stroke.tool,
    width: stroke.width,
    ...(schemaVersion === 3 &&
    stroke.brushRenderVersion !== undefined &&
    stroke.inputProfile !== undefined
      ? {
          brushRenderVersion: stroke.brushRenderVersion,
          inputProfile: {
            pressure: stroke.inputProfile.pressure,
            tilt: stroke.inputProfile.tilt,
          },
        }
      : {}),
  };
  if (isPhysicalVisibleStroke(stroke)) {
    return {
      ...common,
      points: stroke.points.map(toCanonicalPhysicalPoint),
    };
  }
  const origin = stroke.points[0] as InkPoint;
  return {
    ...common,
    deltas: stroke.points.slice(1).map((point, index) => {
      const previous = stroke.points[index] as InkPoint;
      return {
        dp: point.pressure - previous.pressure,
        dt: point.time - previous.time,
        dx: point.x - previous.x,
        dy: point.y - previous.y,
        tiltX: point.tiltX ?? null,
        tiltY: point.tiltY ?? null,
      };
    }),
    origin: toStoredPoint(origin),
    pointEncoding: 'delta-v1',
  };
}

function toCanonicalPhysicalPoint(point: InkPhysicalPoint): InkPhysicalPoint {
  return {
    ...(point.fragmentBoundary === undefined ? {} : { fragmentBoundary: point.fragmentBoundary }),
    ...(point.fragmentBoundaryEdge === undefined
      ? {}
      : { fragmentBoundaryEdge: point.fragmentBoundaryEdge }),
    ...(point.fragmentBoundaryId === undefined
      ? {}
      : { fragmentBoundaryId: point.fragmentBoundaryId }),
    ...(point.fragmentGlobalY === undefined ? {} : { fragmentGlobalY: point.fragmentGlobalY }),
    ...(point.fragmentTraceOrder === undefined
      ? {}
      : { fragmentTraceOrder: point.fragmentTraceOrder }),
    orientation: clonePhysicalOrientation(point.orientation),
    pressure: point.pressure,
    pressureKind: point.pressureKind,
    time: point.time,
    x: point.x,
    y: point.y,
  };
}

function clonePhysicalOrientation(
  orientation: InkPhysicalPoint['orientation'],
): InkPhysicalPoint['orientation'] {
  return orientation.kind === 'unavailable'
    ? { kind: 'unavailable' }
    : {
        altitude: orientation.altitude,
        azimuth: orientation.azimuth,
        kind: 'measured',
        reliable: orientation.reliable,
      };
}

function toStoredPoint(point: InkPoint): Record<string, unknown> {
  return {
    pressure: point.pressure,
    time: point.time,
    x: point.x,
    y: point.y,
    tiltX: point.tiltX,
    tiltY: point.tiltY,
  };
}

function normalizeLegacyBrushMetadata(value: unknown): unknown {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !Array.isArray(value.strokes)
  ) {
    return value;
  }
  const strokes = value.strokes as unknown[];
  return {
    ...value,
    strokes: strokes.map((stroke) => {
      if (
        !isRecord(stroke) ||
        (stroke.tool !== 'pen' && stroke.tool !== 'highlighter') ||
        'brushRenderVersion' in stroke ||
        'inputProfile' in stroke
      ) {
        return stroke;
      }
      return {
        ...stroke,
        brushRenderVersion: 'legacy-round-v1',
        inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
      };
    }),
  };
}

function inflateStoredRecord(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.strokes)) {
    return value;
  }
  return {
    ...value,
    strokes: value.strokes.map((stroke) => inflateStoredStroke(stroke)),
  };
}

function inflateStoredStroke(value: unknown): unknown {
  if (!isRecord(value) || 'points' in value) {
    return value;
  }
  if (
    value.pointEncoding === 'physical-delta-v1' &&
    value.linkedStrokeId === undefined &&
    isStoredPhysicalPoint(value.origin) &&
    Array.isArray(value.deltas) &&
    value.deltas.every(isStoredPhysicalDelta)
  ) {
    const points: InkPhysicalPoint[] = [clonePhysicalPoint(value.origin)];
    for (const delta of value.deltas) {
      const previous = points.at(-1) as InkPhysicalPoint;
      points.push({
        ...(delta.fragmentBoundary === undefined
          ? {}
          : { fragmentBoundary: delta.fragmentBoundary }),
        ...(delta.fragmentBoundaryEdge === undefined
          ? {}
          : { fragmentBoundaryEdge: delta.fragmentBoundaryEdge }),
        ...(delta.fragmentBoundaryId === undefined
          ? {}
          : { fragmentBoundaryId: delta.fragmentBoundaryId }),
        ...(delta.fragmentGlobalY === undefined ? {} : { fragmentGlobalY: delta.fragmentGlobalY }),
        ...(delta.fragmentTraceOrder === undefined
          ? {}
          : { fragmentTraceOrder: delta.fragmentTraceOrder }),
        orientation: clonePhysicalOrientation(delta.orientation),
        pressure: delta.pressure.value,
        pressureKind: delta.pressure.kind,
        time: previous.time + delta.dt,
        x: previous.x + delta.dx,
        y: previous.y + delta.dy,
      });
    }
    const { deltas: _deltas, origin: _origin, pointEncoding: _encoding, ...stroke } = value;
    void _deltas;
    void _origin;
    void _encoding;
    return { ...stroke, points };
  }
  if (
    value.pointEncoding !== 'delta-v1' ||
    !isPoint(value.origin) ||
    !Array.isArray(value.deltas) ||
    !value.deltas.every(isStoredDelta)
  ) {
    return value;
  }
  const points: InkPoint[] = [{ ...value.origin }];
  for (const delta of value.deltas) {
    const previous = points.at(-1) as InkPoint;
    points.push({
      pressure: previous.pressure + delta.dp,
      time: previous.time + delta.dt,
      x: previous.x + delta.dx,
      y: previous.y + delta.dy,
      ...(delta.tiltX === null ? {} : { tiltX: delta.tiltX }),
      ...(delta.tiltY === null ? {} : { tiltY: delta.tiltY }),
    });
  }
  const { deltas: _deltas, origin: _origin, pointEncoding: _encoding, ...stroke } = value;
  void _deltas;
  void _origin;
  void _encoding;
  return { ...stroke, points };
}

interface StoredPointDelta {
  readonly dp: number;
  readonly dt: number;
  readonly dx: number;
  readonly dy: number;
  readonly tiltX: number | null;
  readonly tiltY: number | null;
}

interface StoredPhysicalPointDelta {
  readonly dt: number;
  readonly dx: number;
  readonly dy: number;
  readonly fragmentBoundary?: 'authored-copy' | 'synthetic-clip';
  readonly fragmentBoundaryEdge?: 'end' | 'start';
  readonly fragmentBoundaryId?: string;
  readonly fragmentGlobalY?: number;
  readonly fragmentTraceOrder?: number;
  readonly orientation: InkPhysicalPoint['orientation'];
  readonly pressure: InkPhysicalBrushControlPoint['pressure'];
}

interface StoredPhysicalPoint extends InkPhysicalBrushControlPoint {
  readonly fragmentBoundary?: 'authored-copy' | 'synthetic-clip';
  readonly fragmentBoundaryEdge?: 'end' | 'start';
  readonly fragmentBoundaryId?: string;
  readonly fragmentGlobalY?: number;
  readonly fragmentTraceOrder?: number;
}

function isStoredDelta(value: unknown): value is StoredPointDelta {
  return (
    isRecord(value) &&
    hasOnlyCanonicalKeys(value, STORED_POINT_DELTA_KEYS) &&
    typeof value.dp === 'number' &&
    typeof value.dt === 'number' &&
    typeof value.dx === 'number' &&
    typeof value.dy === 'number' &&
    (value.tiltX === null || typeof value.tiltX === 'number') &&
    (value.tiltY === null || typeof value.tiltY === 'number')
  );
}

function isStoredPhysicalDelta(value: unknown): value is StoredPhysicalPointDelta {
  return (
    isRecord(value) &&
    hasOnlyCanonicalKeys(value, STORED_PHYSICAL_POINT_DELTA_KEYS) &&
    typeof value.dt === 'number' &&
    typeof value.dx === 'number' &&
    typeof value.dy === 'number' &&
    isPhysicalFragmentProvenance(value) &&
    isPhysicalPressure(value.pressure) &&
    isPhysicalOrientation(value.orientation)
  );
}

export function assertInkSurfaceRecord(record: InkSurfaceRecord): void {
  if (!isSupportedSchemaVersion(record.schemaVersion)) {
    throw new Error('Ink surface record has an unsupported schema version.');
  }
  if (hasOwn(record, 'candidateRevision')) {
    throw new Error('Ink surface record contains unsupported brush metadata.');
  }
  if (!hasOnlyCanonicalKeys(record, INK_SURFACE_RECORD_KEYS)) {
    throw new Error('Ink surface record contains non-canonical fields.');
  }
  const { layout } = record;
  if (
    !hasOnlyCanonicalKeys(layout, INK_LAYOUT_KEYS) ||
    !Number.isInteger(record.revision) ||
    record.revision < 1 ||
    !positive(layout.logicalWidth) ||
    !positive(layout.logicalHeight) ||
    !positive(layout.fontSize) ||
    !positive(layout.lineHeight) ||
    (record.schemaVersion !== 1 &&
      (typeof record.layout.originY !== 'number' ||
        !finite(record.layout.originY) ||
        record.layout.originY < 0))
  ) {
    throw new Error('Ink surface revision and layout dimensions must be positive.');
  }
  if (record.binding !== undefined && !isBinding(record.binding)) {
    throw new Error('Ink surface section binding is invalid.');
  }
  const strokeIds = new Set<string>();
  for (const stroke of record.strokes) {
    if (strokeIds.has(stroke.id)) {
      throw new Error(`Ink stroke ID ${stroke.id} is duplicated.`);
    }
    strokeIds.add(stroke.id);
    assertInkStrokeBrushMetadata(stroke, record.schemaVersion);
    if (
      !positive(stroke.width) ||
      stroke.color.length === 0 ||
      stroke.points.length === 0 ||
      (stroke.linkedStrokeId !== undefined && stroke.linkedStrokeId.length === 0)
    ) {
      throw new Error(`Ink stroke ${stroke.id} has invalid style or no points.`);
    }
    let previousTime = Number.NEGATIVE_INFINITY;
    let previousFragmentTraceOrder = Number.NEGATIVE_INFINITY;
    const physicalFragment = isPhysicalVisibleStroke(stroke) && stroke.linkedStrokeId !== undefined;
    for (const point of stroke.points) {
      if (!validTracePoint(point, isPhysicalVisibleStroke(stroke), layout, previousTime)) {
        throw new Error(`Ink stroke ${stroke.id} contains an invalid point.`);
      }
      if (physicalFragment) {
        const physicalPoint = point as InkPhysicalPoint;
        const order = physicalPoint.fragmentTraceOrder;
        if (order === undefined || order <= previousFragmentTraceOrder) {
          throw new Error(`Ink stroke ${stroke.id} contains invalid physical fragment order.`);
        }
        if (!validPhysicalFragmentProjection(physicalPoint, layout)) {
          throw new Error(`Ink stroke ${stroke.id} contains invalid physical global provenance.`);
        }
        previousFragmentTraceOrder = order;
      }
      previousTime = point.time;
    }
  }
}

function isInkSurfaceRecord(value: unknown): value is InkSurfaceRecord {
  if (
    !isRecord(value) ||
    !hasOnlyCanonicalKeys(value, INK_SURFACE_RECORD_KEYS) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) ||
    !isRecord(value.layout)
  ) {
    return false;
  }
  return (
    nonEmpty(value.id) &&
    nonEmpty(value.noteId) &&
    nonEmpty(value.filePath) &&
    nonEmpty(value.createdAt) &&
    nonEmpty(value.updatedAt) &&
    (value.deviceId === undefined || typeof value.deviceId === 'string') &&
    (value.deletedAt === undefined || typeof value.deletedAt === 'string') &&
    (value.binding === undefined || isBinding(value.binding)) &&
    typeof value.revision === 'number' &&
    (value.status === 'active' ||
      value.status === 'needs-rebase' ||
      value.status === 'unanchored') &&
    isLayout(value.layout, value.schemaVersion) &&
    Array.isArray(value.strokes) &&
    value.strokes.every(isStroke)
  );
}

function isBinding(value: unknown): value is NonNullable<InkSurfaceRecord['binding']> {
  return (
    isRecord(value) &&
    hasOnlyCanonicalKeys(value, INK_BINDING_KEYS) &&
    nonEmpty(value.sectionFingerprint) &&
    Array.isArray(value.headingPath) &&
    value.headingPath.every((part) => typeof part === 'string') &&
    Array.isArray(value.blockFingerprints) &&
    value.blockFingerprints.length > 0 &&
    value.blockFingerprints.every(nonEmpty) &&
    nonNegativeInteger(value.sourceStart) &&
    nonNegativeInteger(value.sourceEnd) &&
    value.sourceEnd >= value.sourceStart
  );
}

function isLayout(value: Record<string, unknown>, schemaVersion: 1 | 2 | 3): boolean {
  return (
    hasOnlyCanonicalKeys(value, INK_LAYOUT_KEYS) &&
    typeof value.logicalWidth === 'number' &&
    typeof value.logicalHeight === 'number' &&
    nonEmpty(value.fontFamily) &&
    typeof value.fontSize === 'number' &&
    typeof value.lineHeight === 'number' &&
    (value.themeMode === 'light' || value.themeMode === 'dark') &&
    nonEmpty(value.sourceRevision) &&
    Array.isArray(value.blockFingerprints) &&
    value.blockFingerprints.every(nonEmpty) &&
    (schemaVersion === 1 || typeof value.originY === 'number')
  );
}

export function assertInkStrokeBrushMetadata(
  stroke: InkStroke,
  schemaVersion: InkSurfaceRecord['schemaVersion'],
): void {
  if (!hasOnlyCanonicalKeys(stroke, INK_STROKE_KEYS)) {
    throw new Error(`Visible Ink stroke ${stroke.id} has unsupported brush metadata.`);
  }
  const hasVersion = stroke.brushRenderVersion !== undefined;
  const hasProfile = stroke.inputProfile !== undefined;
  if (stroke.tool === 'eraser') {
    if (hasVersion || hasProfile) {
      throw new Error(`Historical Ink eraser ${stroke.id} must not have brush metadata.`);
    }
    if (!stroke.points.every(isPoint)) {
      throw new Error(`Historical Ink eraser ${stroke.id} has unsupported control points.`);
    }
    return;
  }
  if (schemaVersion !== 3 && !hasVersion && !hasProfile) return;
  if (!hasVersion || !hasProfile) {
    throw new Error(`Visible Ink stroke ${stroke.id} is missing required brush metadata.`);
  }
  const resolution = resolveInkBrushContract({
    color: stroke.color,
    inputProfile: stroke.inputProfile,
    tool: stroke.tool,
    version: stroke.brushRenderVersion,
  });
  if (
    resolution.kind === 'unsupported' ||
    (schemaVersion !== 3 && stroke.brushRenderVersion !== 'legacy-round-v1')
  ) {
    throw new Error(`Visible Ink stroke ${stroke.id} has unsupported brush metadata.`);
  }
  const physicalVersion = stroke.brushRenderVersion !== 'legacy-round-v1';
  if (
    (physicalVersion && !stroke.points.every(isPhysicalPoint)) ||
    (!physicalVersion && !stroke.points.every(isPoint))
  ) {
    throw new Error(`Visible Ink stroke ${stroke.id} has unsupported Brush Control Trace points.`);
  }
  if (physicalVersion) {
    const physicalPoints = stroke.points as readonly InkPhysicalPoint[];
    const hasFragmentProvenance = physicalPoints.some(
      (point) =>
        point.fragmentTraceOrder !== undefined ||
        point.fragmentBoundary !== undefined ||
        point.fragmentGlobalY !== undefined,
    );
    if (stroke.linkedStrokeId === undefined && hasFragmentProvenance) {
      throw new Error(`Visible Ink stroke ${stroke.id} has unlinked fragment provenance.`);
    }
    if (
      stroke.linkedStrokeId !== undefined &&
      !physicalPoints.every(
        (point) => point.fragmentTraceOrder !== undefined && point.fragmentGlobalY !== undefined,
      )
    ) {
      throw new Error(`Visible Ink fragment ${stroke.id} is missing physical point provenance.`);
    }
    if (
      stroke.linkedStrokeId !== undefined &&
      !physicalPoints.every(
        (point) =>
          point.fragmentBoundary === undefined ||
          point.fragmentBoundaryId ===
            `${stroke.linkedStrokeId}:boundary:${point.fragmentTraceOrder?.toString()}`,
      )
    ) {
      throw new Error(`Visible Ink fragment ${stroke.id} has invalid physical boundary identity.`);
    }
  }
}

function classifyUnsupportedStoredBrush(
  record: Record<string, unknown>,
  schemaVersion: 1 | 2 | 3,
): 'unsupported-brush-metadata' | 'unsupported-brush-version' | null {
  if (!Array.isArray(record.strokes)) return null;
  for (const stroke of record.strokes) {
    if (!isRecord(stroke)) continue;
    const allowedKeys = hasOwn(stroke, 'points') ? INK_STROKE_KEYS : STORED_INK_STROKE_KEYS;
    if (!hasOnlyCanonicalKeys(stroke, allowedKeys)) return 'unsupported-brush-metadata';
    if (stroke.tool !== 'eraser' && stroke.tool !== 'highlighter' && stroke.tool !== 'pen')
      continue;
    const hasVersion = 'brushRenderVersion' in stroke;
    const hasProfile = 'inputProfile' in stroke;
    if (schemaVersion !== 3) {
      if (hasVersion || hasProfile) return 'unsupported-brush-metadata';
      continue;
    }
    if (stroke.tool === 'eraser') {
      if (hasVersion || hasProfile) return 'unsupported-brush-metadata';
      continue;
    }
    if (!hasVersion || !hasProfile) return 'unsupported-brush-metadata';
    const resolution = resolveInkBrushContract({
      color: stroke.color,
      inputProfile: stroke.inputProfile,
      tool: stroke.tool,
      version: stroke.brushRenderVersion,
    });
    if (resolution.kind === 'unsupported') {
      return resolution.reason === 'unknown-version'
        ? 'unsupported-brush-version'
        : 'unsupported-brush-metadata';
    }
  }
  return null;
}

function isStroke(value: unknown): value is InkStroke {
  if (
    isRecord(value) &&
    hasOnlyCanonicalKeys(value, INK_STROKE_KEYS) &&
    nonEmpty(value.id) &&
    (value.tool === 'pen' || value.tool === 'highlighter' || value.tool === 'eraser') &&
    (value.linkedStrokeId === undefined || nonEmpty(value.linkedStrokeId)) &&
    nonEmpty(value.color) &&
    typeof value.width === 'number' &&
    Array.isArray(value.points)
  ) {
    const physical =
      value.brushRenderVersion === 'pen-physical-v1' ||
      value.brushRenderVersion === 'highlighter-chisel-v1';
    return physical ? value.points.every(isPhysicalPoint) : value.points.every(isPoint);
  }
  return false;
}

function isPoint(value: unknown): value is InkPoint {
  return (
    isRecord(value) &&
    hasOnlyCanonicalKeys(value, INK_POINT_KEYS) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.pressure === 'number' &&
    typeof value.time === 'number' &&
    (value.tiltX === undefined || typeof value.tiltX === 'number') &&
    (value.tiltY === undefined || typeof value.tiltY === 'number')
  );
}

function isPhysicalPoint(value: unknown): value is InkPhysicalPoint {
  return (
    isRecord(value) &&
    hasOnlyCanonicalKeys(value, INK_PHYSICAL_POINT_KEYS) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.time === 'number' &&
    typeof value.pressure === 'number' &&
    isPhysicalFragmentProvenance(value) &&
    (value.pressureKind === 'measured' || value.pressureKind === 'unavailable') &&
    isPhysicalOrientation(value.orientation)
  );
}

function isStoredPhysicalPoint(value: unknown): value is StoredPhysicalPoint {
  return (
    isRecord(value) &&
    hasOnlyCanonicalKeys(value, STORED_PHYSICAL_POINT_KEYS) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.time === 'number' &&
    isPhysicalFragmentProvenance(value) &&
    isPhysicalPressure(value.pressure) &&
    isPhysicalOrientation(value.orientation)
  );
}

function isPhysicalFragmentProvenance(value: Record<string, unknown>): boolean {
  const boundary = value.fragmentBoundary;
  const boundaryEdge = value.fragmentBoundaryEdge;
  const boundaryId = value.fragmentBoundaryId;
  const globalY = value.fragmentGlobalY;
  const order = value.fragmentTraceOrder;
  if (globalY !== undefined && (typeof globalY !== 'number' || !finite(globalY))) {
    return false;
  }
  if (order !== undefined && (typeof order !== 'number' || !finite(order) || order < 0)) {
    return false;
  }
  if (boundary === undefined) return boundaryId === undefined && boundaryEdge === undefined;
  return (
    (boundary === 'authored-copy' || boundary === 'synthetic-clip') &&
    (boundaryEdge === 'end' || boundaryEdge === 'start') &&
    nonEmpty(boundaryId) &&
    order !== undefined
  );
}

function isPhysicalPressure(value: unknown): value is InkPhysicalPoint['pressure'] {
  return (
    isRecord(value) &&
    hasOnlyCanonicalKeys(value, INK_PHYSICAL_PRESSURE_KEYS) &&
    (value.kind === 'measured' || value.kind === 'unavailable') &&
    typeof value.value === 'number'
  );
}

function isPhysicalOrientation(value: unknown): value is InkPhysicalPoint['orientation'] {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'unavailable') {
    return hasOnlyCanonicalKeys(value, INK_PHYSICAL_ORIENTATION_UNAVAILABLE_KEYS);
  }
  return (
    value.kind === 'measured' &&
    hasOnlyCanonicalKeys(value, INK_PHYSICAL_ORIENTATION_MEASURED_KEYS) &&
    typeof value.altitude === 'number' &&
    typeof value.azimuth === 'number' &&
    typeof value.reliable === 'boolean'
  );
}

function validTracePoint(
  point: InkPoint,
  physical: boolean,
  layout: InkSurfaceLayout,
  previousTime: number,
): boolean {
  if (
    !finite(point.x) ||
    !finite(point.y) ||
    point.y < 0 ||
    point.y > layout.logicalHeight ||
    !finite(point.time) ||
    point.time < previousTime
  ) {
    return false;
  }
  if (physical) {
    if (!isPhysicalPoint(point)) return false;
    if (
      (point.fragmentBoundaryEdge === 'start' && point.y !== 0) ||
      (point.fragmentBoundaryEdge === 'end' && point.y !== layout.logicalHeight)
    ) {
      return false;
    }
    return (
      finite(point.pressure) &&
      point.pressure >= 0 &&
      point.pressure <= 1 &&
      (point.orientation.kind === 'unavailable' ||
        (finite(point.orientation.altitude) &&
          point.orientation.altitude >= 0 &&
          point.orientation.altitude <= Math.PI / 2 &&
          finite(point.orientation.azimuth) &&
          point.orientation.azimuth >= 0 &&
          point.orientation.azimuth < Math.PI * 2))
    );
  }
  if (!isPoint(point)) return false;
  return (
    finite(point.pressure) &&
    point.pressure >= 0 &&
    point.pressure <= 1 &&
    (point.tiltX === undefined || finite(point.tiltX)) &&
    (point.tiltY === undefined || finite(point.tiltY))
  );
}

function validPhysicalFragmentProjection(
  point: InkPhysicalPoint,
  layout: InkSurfaceLayout,
): boolean {
  const originY = layout.originY;
  const globalY = point.fragmentGlobalY;
  if (originY === undefined || globalY === undefined || !finite(globalY)) return false;
  const endY = originY + layout.logicalHeight;
  if (globalY < originY || globalY > endY) return false;
  if (point.fragmentBoundaryEdge === 'start') return globalY === originY && point.y === 0;
  if (point.fragmentBoundaryEdge === 'end') {
    return globalY === endY && point.y === layout.logicalHeight;
  }
  if (globalY === originY) return point.y === 0;
  if (globalY === endY) return point.y === layout.logicalHeight;
  return point.y === globalY - originY || originY + point.y === globalY;
}

function isPhysicalVisibleStroke(
  stroke: InkStroke,
): stroke is InkPhysicalHighlighterStroke | InkPhysicalPenStroke {
  return (
    stroke.brushRenderVersion === 'pen-physical-v1' ||
    stroke.brushRenderVersion === 'highlighter-chisel-v1'
  );
}

function clonePhysicalPoint(point: StoredPhysicalPoint): InkPhysicalPoint {
  return {
    ...(point.fragmentBoundary === undefined ? {} : { fragmentBoundary: point.fragmentBoundary }),
    ...(point.fragmentBoundaryEdge === undefined
      ? {}
      : { fragmentBoundaryEdge: point.fragmentBoundaryEdge }),
    ...(point.fragmentBoundaryId === undefined
      ? {}
      : { fragmentBoundaryId: point.fragmentBoundaryId }),
    ...(point.fragmentGlobalY === undefined ? {} : { fragmentGlobalY: point.fragmentGlobalY }),
    ...(point.fragmentTraceOrder === undefined
      ? {}
      : { fragmentTraceOrder: point.fragmentTraceOrder }),
    orientation: clonePhysicalOrientation(point.orientation),
    pressure: point.pressure.value,
    pressureKind: point.pressure.kind,
    time: point.time,
    x: point.x,
    y: point.y,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function canonicalKeySet(keys: readonly string[]): ReadonlySet<string> {
  return new Set(keys);
}

function hasOnlyCanonicalKeys(value: object, allowedKeys: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowedKeys.has(key));
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isSupportedSchemaVersion(value: unknown): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function positive(value: number): boolean {
  return finite(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}
