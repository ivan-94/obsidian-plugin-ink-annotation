import type { InkSurfaceRecord } from './ink-surface';

export type InkSurfaceMigrationResult =
  | {
      readonly kind: 'manual-placement-required';
      readonly reason: string;
      readonly records: readonly InkSurfaceRecord[];
    }
  | { readonly kind: 'migrated'; readonly records: readonly InkSurfaceRecord[] };

export function migrateInkSurfaceRecordsToV2(
  records: readonly InkSurfaceRecord[],
  now: string,
): InkSurfaceMigrationResult {
  if (records.every((record) => record.schemaVersion === 2)) {
    return { kind: 'migrated', records };
  }
  const first = records[0];
  const sourceStarts = records.map((record) => record.binding?.sourceStart);
  if (
    records.some((record) => record.schemaVersion !== 1) ||
    first === undefined ||
    records.some(
      (record) =>
        record.filePath !== first.filePath ||
        record.noteId !== first.noteId ||
        record.layout.logicalWidth !== first.layout.logicalWidth,
    ) ||
    sourceStarts.some((sourceStart) => sourceStart === undefined) ||
    new Set(sourceStarts).size !== sourceStarts.length
  ) {
    return {
      kind: 'manual-placement-required',
      reason: 'Ink v1 surfaces do not have a unique canonical order.',
      records,
    };
  }
  const ordered = [...records].sort(
    (left, right) =>
      (left.binding?.sourceStart ?? Number.POSITIVE_INFINITY) -
      (right.binding?.sourceStart ?? Number.POSITIVE_INFINITY),
  );
  if (
    ordered.some((record, index) => {
      const previous = ordered[index - 1];
      return (
        record.binding === undefined ||
        record.binding.sourceEnd < record.binding.sourceStart ||
        (previous?.binding !== undefined && previous.binding.sourceEnd > record.binding.sourceStart)
      );
    })
  ) {
    return {
      kind: 'manual-placement-required',
      reason: 'Ink v1 surfaces do not have a unique canonical order.',
      records,
    };
  }
  let originY = 0;
  const migrated = ordered.map((record): InkSurfaceRecord => {
    const next = {
      ...record,
      layout: { ...record.layout, originY },
      revision: record.revision + 1,
      schemaVersion: 2 as const,
      updatedAt: now,
    };
    originY += record.layout.logicalHeight;
    return next;
  });
  return { kind: 'migrated', records: migrated };
}
