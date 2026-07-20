import type { InkCompiledBrushGeometry } from './ink-brush-geometry-contract';
import { SharedInkStrokeGeometry } from './ink-shared-stroke-geometry';
import { joinInkStrokeSurfaceFragments } from './ink-surface-layout';
import { assertInkSurfaceRecord, type InkSurfaceRecord } from './ink-surface';

const SHARED_GEOMETRY = new SharedInkStrokeGeometry();
const MAX_THUMBNAIL_STROKES = 64;

export interface InkSurfaceSummary {
  readonly conflict?: boolean;
  readonly deletedAt?: string;
  readonly filePath: string;
  readonly headingPath: readonly string[];
  readonly id: string;
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly position: number;
  readonly revision: number;
  readonly status: InkSurfaceRecord['status'];
  readonly strokeCount: number;
  readonly thumbnailSvg: string;
  readonly updatedAt: string;
}

export interface InkSurfaceSummaryIndex {
  readonly filePath: string;
  readonly schemaVersion: 1;
  readonly summaries: readonly InkSurfaceSummary[];
}

export function summarizeInkSurface(
  record: InkSurfaceRecord,
  options: {
    readonly conflict?: boolean;
    /** Cold caller-supplied note range used to join cross-surface Logical Strokes for preview. */
    readonly relatedRecords?: readonly InkSurfaceRecord[];
  } = {},
): InkSurfaceSummary {
  return {
    conflict: options.conflict ?? false,
    ...(record.deletedAt === undefined ? {} : { deletedAt: record.deletedAt }),
    filePath: record.filePath,
    headingPath: record.binding?.headingPath ?? [],
    id: record.id,
    logicalHeight: record.layout.logicalHeight,
    logicalWidth: record.layout.logicalWidth,
    position: record.binding?.sourceStart ?? Number.MAX_SAFE_INTEGER,
    revision: record.revision,
    status: record.status,
    strokeCount: record.strokes.filter((stroke) => stroke.tool !== 'eraser').length,
    thumbnailSvg: renderInkThumbnail(record, options.relatedRecords),
    updatedAt: record.updatedAt,
  };
}

export function encodeInkSurfaceSummaryIndex(index: InkSurfaceSummaryIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

export function decodeInkSurfaceSummaryIndex(contents: string): InkSurfaceSummaryIndex {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error('Ink summary index is not valid JSON.', { cause: error });
  }
  if (!isSummaryIndex(value)) {
    throw new Error('Ink summary index does not match schema version 1.');
  }
  return value;
}

function renderInkThumbnail(
  record: InkSurfaceRecord,
  relatedRecords: readonly InkSurfaceRecord[] | undefined,
): string {
  assertInkSurfaceRecord(record);
  const width = 160;
  const height = 90;
  const scene = compileThumbnailScene(record, relatedRecords);
  const geometries = scene.geometries;
  const bounds = scene.bounds;
  const scale = Math.min(width / bounds.width, height / bounds.height);
  const paths = geometries
    .map((geometry) => renderThumbnailGeometry(geometry, bounds.minX, bounds.minY, scale))
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ink thumbnail">${paths}</svg>`;
}

interface InkThumbnailScene {
  readonly bounds: {
    readonly height: number;
    readonly minX: number;
    readonly minY: number;
    readonly width: number;
  };
  readonly geometries: readonly InkCompiledBrushGeometry[];
}

function compileThumbnailScene(
  record: InkSurfaceRecord,
  relatedRecords: readonly InkSurfaceRecord[] | undefined,
): InkThumbnailScene {
  const recordsById = new Map((relatedRecords ?? []).map((candidate) => [candidate.id, candidate]));
  recordsById.set(record.id, record);
  const records = [...recordsById.values()];
  for (const candidate of records) {
    assertInkSurfaceRecord(candidate);
    if (candidate.filePath !== record.filePath || candidate.noteId !== record.noteId) {
      throw new Error('Ink thumbnail can join related surfaces only from the same note.');
    }
    if (candidate.schemaVersion !== record.schemaVersion) {
      throw new Error('Ink thumbnail refuses mixed canonical schema versions.');
    }
  }
  const ordered = records.sort((left, right) =>
    left.schemaVersion === 1
      ? (left.binding?.sourceStart ?? Number.MAX_SAFE_INTEGER) -
          (right.binding?.sourceStart ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id)
      : (left.layout.originY as number) - (right.layout.originY as number) ||
        left.id.localeCompare(right.id),
  );
  let cumulativeOrigin = 0;
  let currentOrigin: number | null = null;
  const fragments = ordered.flatMap((candidate) => {
    const origin =
      candidate.schemaVersion === 1 ? cumulativeOrigin : (candidate.layout.originY as number);
    cumulativeOrigin = origin + candidate.layout.logicalHeight;
    if (candidate.id === record.id) currentOrigin = origin;
    return candidate.strokes
      .filter((stroke) => stroke.tool !== 'eraser')
      .map((stroke) => ({
        endY: origin + candidate.layout.logicalHeight,
        logicalHeight: candidate.layout.logicalHeight,
        schemaVersion: candidate.schemaVersion,
        startY: origin,
        stroke,
        surfaceId: candidate.id,
      }));
  });
  if (currentOrigin === null) throw new Error('Ink thumbnail surface lost its note-global origin.');
  // TypeScript does not observe the assignment performed inside flatMap above.
  const surfaceOrigin = currentOrigin as unknown as number;
  const maximumY = surfaceOrigin + record.layout.logicalHeight;
  const visibleStrokes = joinInkStrokeSurfaceFragments(fragments).filter((stroke) =>
    strokeIntersectsVerticalRange(stroke, surfaceOrigin, maximumY),
  );
  return {
    bounds: {
      height: record.layout.logicalHeight,
      minX: 0,
      minY: surfaceOrigin,
      width: record.layout.logicalWidth,
    },
    geometries: compileThumbnailStrokes(visibleStrokes),
  };
}

function strokeIntersectsVerticalRange(
  stroke: InkSurfaceRecord['strokes'][number],
  minimumY: number,
  maximumY: number,
): boolean {
  if (stroke.points.length === 0) return false;
  let strokeMinimumY = Number.POSITIVE_INFINITY;
  let strokeMaximumY = Number.NEGATIVE_INFINITY;
  for (const point of stroke.points) {
    strokeMinimumY = Math.min(strokeMinimumY, point.y);
    strokeMaximumY = Math.max(strokeMaximumY, point.y);
  }
  const margin = Math.max(2, stroke.width * 2);
  return strokeMaximumY + margin >= minimumY && strokeMinimumY - margin <= maximumY;
}

function compileThumbnailStrokes(
  strokes: InkSurfaceRecord['strokes'],
): readonly InkCompiledBrushGeometry[] {
  return sampleThumbnailStrokes(strokes.filter((stroke) => stroke.tool !== 'eraser')).map(
    (stroke) => requireThumbnailGeometry(SHARED_GEOMETRY.compile(stroke)),
  );
}

function sampleThumbnailStrokes(strokes: InkSurfaceRecord['strokes']): InkSurfaceRecord['strokes'] {
  if (strokes.length <= MAX_THUMBNAIL_STROKES) return strokes;
  return Object.freeze(
    Array.from({ length: MAX_THUMBNAIL_STROKES }, (_, index) => {
      const sourceIndex = Math.floor((index * (strokes.length - 1)) / (MAX_THUMBNAIL_STROKES - 1));
      return strokes[sourceIndex] as (typeof strokes)[number];
    }),
  );
}

function requireThumbnailGeometry(
  result: ReturnType<SharedInkStrokeGeometry['compile']>,
): InkCompiledBrushGeometry {
  if (result.kind === 'exact' || result.kind === 'unpublished') return result.geometry;
  if (result.kind === 'degraded') {
    throw new Error(
      `Ink thumbnail refuses degraded ${result.requestedVersion} geometry: ${result.diagnostic}.`,
    );
  }
  throw new Error(`Unsupported Ink Brush Geometry ${result.requestedVersion}: ${result.reason}.`);
}

function renderThumbnailGeometry(
  geometry: InkCompiledBrushGeometry,
  minimumX: number,
  minimumY: number,
  scale: number,
): string {
  const metadata = `data-ink-stroke-id="${escapeAttribute(geometry.logicalStrokeId)}" data-ink-brush-version="${geometry.version}" data-ink-geometry-digest="${geometry.geometryDigest}"`;
  const grid = geometry.quantization.logicalGrid;
  if (geometry.version === 'legacy-round-v1') {
    const paint = legacyThumbnailPaint(geometry.tool, geometry.color);
    const opacity = paint.opacity === 1 ? '' : ` opacity="${round(paint.opacity)}"`;
    const centerline = geometry.coverage.centerline;
    const first = centerline[0];
    if (first === undefined) throw new Error('Ink thumbnail geometry has no centerline.');
    if (centerline.length === 1) {
      return `<circle ${metadata} cx="${round((first.x * grid - minimumX) * scale)}" cy="${round((first.y * grid - minimumY) * scale)}" r="${round(geometry.hitShape.radius * scale)}" fill="${escapeAttribute(paint.color)}"${opacity}/>`;
    }
    const path = centerline
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'}${round((point.x * grid - minimumX) * scale)} ${round((point.y * grid - minimumY) * scale)}`,
      )
      .join(' ');
    return `<path ${metadata} d="${path}" fill="none" stroke="${escapeAttribute(paint.color)}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${round(geometry.coverage.diameterUnits * grid * scale)}"${opacity}/>`;
  }
  const path = geometry.coverage.contours
    .map((contour) =>
      contour
        .map(
          (point, index) =>
            `${index === 0 ? 'M' : 'L'}${round((point.x * grid - minimumX) * scale)} ${round((point.y * grid - minimumY) * scale)}`,
        )
        .join(' ')
        .concat(' Z'),
    )
    .join(' ');
  const opacity =
    geometry.blend.alpha.value === 1 ? '' : ` opacity="${round(geometry.blend.alpha.value)}"`;
  return `<path ${metadata} d="${path}" fill="${escapeAttribute(geometry.color)}" fill-rule="${geometry.hitShape.fillRule}"${opacity}/>`;
}

function legacyThumbnailPaint(
  tool: Extract<InkCompiledBrushGeometry, { readonly version: 'legacy-round-v1' }>['tool'],
  sourceColor: string,
): { readonly color: string; readonly opacity: number } {
  const alphaColor = /^#(?<rgb>[0-9a-f]{6})(?<alpha>[0-9a-f]{2})$/iu.exec(sourceColor);
  const alpha = alphaColor?.groups?.alpha;
  const rgb = alphaColor?.groups?.rgb;
  return {
    color: rgb === undefined ? sourceColor : `#${rgb}`,
    opacity:
      alpha === undefined ? (tool === 'highlighter' ? 0.45 : 1) : Number.parseInt(alpha, 16) / 255,
  };
}

function round(value: number): string {
  return value.toFixed(2).replace(/\.00$/u, '');
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function isSummaryIndex(value: unknown): value is InkSurfaceSummaryIndex {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.filePath === 'string' &&
    Array.isArray(value.summaries) &&
    value.summaries.every(isSummary)
  );
}

function isSummary(value: unknown): value is InkSurfaceSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.filePath === 'string' &&
    typeof value.revision === 'number' &&
    typeof value.position === 'number' &&
    typeof value.logicalWidth === 'number' &&
    typeof value.logicalHeight === 'number' &&
    typeof value.strokeCount === 'number' &&
    typeof value.thumbnailSvg === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.conflict === undefined || typeof value.conflict === 'boolean') &&
    (value.deletedAt === undefined || typeof value.deletedAt === 'string') &&
    (value.status === 'active' ||
      value.status === 'needs-rebase' ||
      value.status === 'unanchored') &&
    Array.isArray(value.headingPath) &&
    value.headingPath.every((part) => typeof part === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
