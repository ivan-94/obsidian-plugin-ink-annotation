import type { InkSurfaceRecord } from './ink-surface';

export const INK_SAFE_EDITING_MARGIN = 512;

/**
 * Builds the transient continuous-canvas extent without revising canonical records.
 * The returned final chunk is persisted only if an explicit Ink edit later dirties it.
 */
export function ensureInkCanvasExtent(
  records: readonly InkSurfaceRecord[],
  renderedDocumentHeight: number,
  safeEditingMargin = INK_SAFE_EDITING_MARGIN,
): readonly InkSurfaceRecord[] {
  if (records.length === 0) throw new Error('Ink canvas extent requires at least one chunk.');
  if (!Number.isFinite(renderedDocumentHeight) || renderedDocumentHeight < 0) {
    throw new Error('Rendered Ink document height must be finite and non-negative.');
  }
  if (!Number.isFinite(safeEditingMargin) || safeEditingMargin < 0) {
    throw new Error('Ink safe editing margin must be finite and non-negative.');
  }

  let cumulativeOrigin = 0;
  let finalChunkIndex = 0;
  let currentExtent = 0;
  let farthestInkBound = 0;
  records.forEach((record, index) => {
    const originY =
      record.schemaVersion === 2 ? (record.layout.originY as number) : cumulativeOrigin;
    const endY = originY + record.layout.logicalHeight;
    if (endY > currentExtent) {
      currentExtent = endY;
      finalChunkIndex = index;
    }
    for (const stroke of record.strokes) {
      const radius = stroke.width / 2;
      for (const point of stroke.points) {
        farthestInkBound = Math.max(farthestInkBound, originY + point.y + radius);
      }
    }
    cumulativeOrigin = endY;
  });

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
