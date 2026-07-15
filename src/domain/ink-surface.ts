export interface InkPoint {
  readonly pressure: number;
  readonly tiltX?: number;
  readonly tiltY?: number;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export interface InkStroke {
  readonly color: string;
  readonly id: string;
  readonly linkedStrokeId?: string;
  readonly points: readonly InkPoint[];
  readonly tool: 'eraser' | 'highlighter' | 'pen';
  readonly width: number;
}

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
  readonly layout: {
    readonly blockFingerprints: readonly string[];
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly logicalHeight: number;
    readonly logicalWidth: number;
    readonly sourceRevision: string;
    readonly themeMode: 'dark' | 'light';
  };
  readonly noteId: string;
  readonly revision: number;
  readonly schemaVersion: 1;
  readonly status: 'active' | 'needs-rebase' | 'unanchored';
  readonly strokes: readonly InkStroke[];
  readonly updatedAt: string;
}

export function encodeInkSurfaceRecord(record: InkSurfaceRecord): string {
  assertInkSurfaceRecord(record);
  return `${JSON.stringify(toStoredRecord(record), null, 2)}\n`;
}

export function decodeInkSurfaceRecord(value: string): InkSurfaceRecord {
  let parsed: unknown;
  try {
    parsed = inflateStoredRecord(JSON.parse(value));
  } catch (error) {
    throw new Error('Ink surface record is not valid JSON.', { cause: error });
  }
  if (!isInkSurfaceRecord(parsed)) {
    throw new Error('Ink surface record does not match schema version 1.');
  }
  assertInkSurfaceRecord(parsed);
  return parsed;
}

function toStoredRecord(record: InkSurfaceRecord): Record<string, unknown> {
  return {
    ...record,
    strokes: record.strokes.map(({ points, ...stroke }) => {
      const origin = points[0] as InkPoint;
      return {
        ...stroke,
        deltas: points.slice(1).map((point, index) => {
          const previous = points[index] as InkPoint;
          return {
            dp: point.pressure - previous.pressure,
            dt: point.time - previous.time,
            dx: point.x - previous.x,
            dy: point.y - previous.y,
            tiltX: point.tiltX ?? null,
            tiltY: point.tiltY ?? null,
          };
        }),
        origin,
        pointEncoding: 'delta-v1',
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

function isStoredDelta(value: unknown): value is StoredPointDelta {
  return (
    isRecord(value) &&
    typeof value.dp === 'number' &&
    typeof value.dt === 'number' &&
    typeof value.dx === 'number' &&
    typeof value.dy === 'number' &&
    (value.tiltX === null || typeof value.tiltX === 'number') &&
    (value.tiltY === null || typeof value.tiltY === 'number')
  );
}

export function assertInkSurfaceRecord(record: InkSurfaceRecord): void {
  const { layout } = record;
  if (
    !Number.isInteger(record.revision) ||
    record.revision < 1 ||
    !positive(layout.logicalWidth) ||
    !positive(layout.logicalHeight) ||
    !positive(layout.fontSize) ||
    !positive(layout.lineHeight)
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
    if (
      !positive(stroke.width) ||
      stroke.color.length === 0 ||
      stroke.points.length === 0 ||
      (stroke.linkedStrokeId !== undefined && stroke.linkedStrokeId.length === 0)
    ) {
      throw new Error(`Ink stroke ${stroke.id} has invalid style or no points.`);
    }
    let previousTime = Number.NEGATIVE_INFINITY;
    for (const point of stroke.points) {
      if (
        !finite(point.x) ||
        !finite(point.y) ||
        point.x < 0 ||
        point.x > layout.logicalWidth ||
        point.y < 0 ||
        point.y > layout.logicalHeight ||
        !finite(point.pressure) ||
        point.pressure < 0 ||
        point.pressure > 1 ||
        !finite(point.time) ||
        point.time < previousTime ||
        (point.tiltX !== undefined && !finite(point.tiltX)) ||
        (point.tiltY !== undefined && !finite(point.tiltY))
      ) {
        throw new Error(`Ink stroke ${stroke.id} contains an invalid point.`);
      }
      previousTime = point.time;
    }
  }
}

function isInkSurfaceRecord(value: unknown): value is InkSurfaceRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.layout)) {
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
    isLayout(value.layout) &&
    Array.isArray(value.strokes) &&
    value.strokes.every(isStroke)
  );
}

function isBinding(value: unknown): value is NonNullable<InkSurfaceRecord['binding']> {
  return (
    isRecord(value) &&
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

function isLayout(value: Record<string, unknown>): value is InkSurfaceRecord['layout'] {
  return (
    typeof value.logicalWidth === 'number' &&
    typeof value.logicalHeight === 'number' &&
    nonEmpty(value.fontFamily) &&
    typeof value.fontSize === 'number' &&
    typeof value.lineHeight === 'number' &&
    (value.themeMode === 'light' || value.themeMode === 'dark') &&
    nonEmpty(value.sourceRevision) &&
    Array.isArray(value.blockFingerprints) &&
    value.blockFingerprints.every(nonEmpty)
  );
}

function isStroke(value: unknown): value is InkStroke {
  return (
    isRecord(value) &&
    nonEmpty(value.id) &&
    (value.tool === 'pen' || value.tool === 'highlighter' || value.tool === 'eraser') &&
    (value.linkedStrokeId === undefined || nonEmpty(value.linkedStrokeId)) &&
    nonEmpty(value.color) &&
    typeof value.width === 'number' &&
    Array.isArray(value.points) &&
    value.points.every(isPoint)
  );
}

function isPoint(value: unknown): value is InkPoint {
  return (
    isRecord(value) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.pressure === 'number' &&
    typeof value.time === 'number' &&
    (value.tiltX === undefined || typeof value.tiltX === 'number') &&
    (value.tiltY === undefined || typeof value.tiltY === 'number')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
