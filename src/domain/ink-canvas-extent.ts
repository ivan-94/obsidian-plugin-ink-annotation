import type { InkSurfaceRecord } from './ink-surface';
import { SharedInkStrokeGeometry } from './ink-shared-stroke-geometry';

export const INK_SAFE_EDITING_MARGIN = 512;
const SHARED_INK_GEOMETRY = new SharedInkStrokeGeometry();

export function measureInkCanvasExtent(records: readonly InkSurfaceRecord[]): number {
  return inspectInkCanvasExtent(records).currentExtent;
}

/**
 * Builds the transient continuous-canvas extent without revising canonical records.
 * The returned final chunk is persisted only if an explicit Ink edit later dirties it.
 */
export function ensureInkCanvasExtent(
  records: readonly InkSurfaceRecord[],
  renderedDocumentHeight: number,
  safeEditingMargin = INK_SAFE_EDITING_MARGIN,
): readonly InkSurfaceRecord[] {
  if (!Number.isFinite(renderedDocumentHeight) || renderedDocumentHeight < 0) {
    throw new Error('Rendered Ink document height must be finite and non-negative.');
  }
  if (!Number.isFinite(safeEditingMargin) || safeEditingMargin < 0) {
    throw new Error('Ink safe editing margin must be finite and non-negative.');
  }

  const { currentExtent, farthestInkBound, finalChunkIndex } = inspectInkCanvasExtent(records);
  const requiredExtent = Math.max(
    1,
    Math.ceil(renderedDocumentHeight),
    Math.ceil(farthestInkBound + safeEditingMargin),
  );
  if (requiredExtent <= currentExtent) return records;

  return records.map((record, index) =>
    index === finalChunkIndex
      ? {
          ...record,
          layout: {
            ...record.layout,
            logicalHeight: record.layout.logicalHeight + requiredExtent - currentExtent,
          },
        }
      : record,
  );
}

function inspectInkCanvasExtent(records: readonly InkSurfaceRecord[]): {
  readonly currentExtent: number;
  readonly farthestInkBound: number;
  readonly finalChunkIndex: number;
} {
  if (records.length === 0) throw new Error('Ink canvas extent requires at least one chunk.');
  let cumulativeOrigin = 0;
  let finalChunkIndex = 0;
  let currentExtent = 0;
  let farthestInkBound = 0;
  records.forEach((record, index) => {
    const originY =
      record.schemaVersion >= 2 ? (record.layout.originY as number) : cumulativeOrigin;
    const endY = originY + record.layout.logicalHeight;
    if (endY > currentExtent) {
      currentExtent = endY;
      finalChunkIndex = index;
    }
    for (const stroke of record.strokes) {
      if (stroke.tool === 'eraser') continue;
      const bounds = SHARED_INK_GEOMETRY.bounds(stroke);
      farthestInkBound = Math.max(farthestInkBound, originY + bounds.y + bounds.height);
    }
    cumulativeOrigin = endY;
  });
  return { currentExtent, farthestInkBound, finalChunkIndex };
}
