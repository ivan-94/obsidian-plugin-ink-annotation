import { inkSurfaceVisibleBounds, type InkPoint, type InkSurfaceRecord } from './ink-surface';

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
  options: { readonly conflict?: boolean } = {},
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
    thumbnailSvg: renderInkThumbnail(record),
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

function renderInkThumbnail(record: InkSurfaceRecord): string {
  const width = 160;
  const height = 90;
  const bounds = inkSurfaceVisibleBounds(record);
  const scale = Math.min(width / bounds.width, height / bounds.height);
  const paths = record.strokes
    .filter((stroke) => stroke.tool !== 'eraser')
    .map((stroke) => {
      const sampled = samplePoints(stroke.points, 24);
      const path = sampled
        .map(
          (point, index) =>
            `${index === 0 ? 'M' : 'L'}${round((point.x - bounds.minX) * scale)} ${round((point.y - bounds.minY) * scale)}`,
        )
        .join(' ');
      return `<path d="${path}" fill="none" stroke="${escapeAttribute(stroke.color)}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${round(Math.max(0.5, stroke.width * scale))}"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ink thumbnail">${paths}</svg>`;
}

function samplePoints(points: readonly InkPoint[], maximum: number): readonly InkPoint[] {
  if (points.length <= maximum) return points;
  const step = Math.ceil((points.length - 1) / (maximum - 1));
  const sampled = points.filter((_point, index) => index % step === 0);
  const last = points.at(-1);
  if (last !== undefined && sampled.at(-1) !== last) sampled.push(last);
  return sampled;
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
