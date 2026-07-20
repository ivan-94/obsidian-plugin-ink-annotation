import { assertInkSurfaceRecord, type InkStroke, type InkSurfaceRecord } from './ink-surface';

export type InkSurfaceMigrationResult =
  | {
      readonly kind: 'manual-placement-required';
      readonly reason: string;
      readonly records: readonly InkSurfaceRecord[];
    }
  | { readonly kind: 'migrated'; readonly records: readonly InkSurfaceRecord[] };

export type InkSurfaceLegacyReadOrder =
  | {
      readonly kind: 'manual-placement-required';
      readonly reason: string;
      readonly records: readonly InkSurfaceRecord[];
    }
  | { readonly kind: 'ordered'; readonly records: readonly InkSurfaceRecord[] };

/** Gives positioned v2/v3 records one canonical document order independent of storage filenames. */
export function orderPositionedInkSurfaceRecords(
  records: readonly InkSurfaceRecord[],
): readonly InkSurfaceRecord[] {
  if (records.some((record) => record.schemaVersion < 2)) return records;
  return [...records].sort(
    (left, right) =>
      (left.layout.originY as number) - (right.layout.originY as number) ||
      left.id.localeCompare(right.id),
  );
}

/** Orders readable v1 chunks without changing any canonical field or authorizing a write. */
export function orderInkSurfaceRecordsForLegacyRead(
  records: readonly InkSurfaceRecord[],
): InkSurfaceLegacyReadOrder {
  const first = records[0];
  if (first === undefined) return manualPlacement(records);
  if (records.length === 1 && first.schemaVersion === 1) {
    return { kind: 'ordered', records };
  }
  const sourceStarts = records.map((record) => record.binding?.sourceStart);
  if (
    records.some((record) => record.schemaVersion !== 1) ||
    records.some(
      (record) =>
        record.filePath !== first.filePath ||
        record.noteId !== first.noteId ||
        record.layout.logicalWidth !== first.layout.logicalWidth,
    ) ||
    sourceStarts.some((sourceStart) => sourceStart === undefined) ||
    new Set(sourceStarts).size !== sourceStarts.length
  ) {
    return manualPlacement(records);
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
    return manualPlacement(records);
  }
  return { kind: 'ordered', records: ordered };
}

export function migrateInkSurfaceRecordsToV2(
  records: readonly InkSurfaceRecord[],
  now: string,
): InkSurfaceMigrationResult {
  if (records.every((record) => record.schemaVersion === 2)) {
    return { kind: 'migrated', records };
  }
  const readOrder = orderInkSurfaceRecordsForLegacyRead(records);
  if (readOrder.kind === 'manual-placement-required') return readOrder;
  let originY = 0;
  const migrated = readOrder.records.map((record): InkSurfaceRecord => {
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

/** Cold-path normalization required before physical brush traces can enter canonical sidecars. */
export function upgradeInkSurfaceRecordsToV3(
  records: readonly InkSurfaceRecord[],
  now: string,
): readonly InkSurfaceRecord[] {
  const first = records[0];
  if (first === undefined) return records;
  let cumulativeOrigin = 0;
  return records.map((record): InkSurfaceRecord => {
    if (
      record.filePath !== first.filePath ||
      record.noteId !== first.noteId ||
      record.layout.logicalWidth !== first.layout.logicalWidth
    ) {
      throw new Error('Ink schema-v3 upgrade requires one continuous document.');
    }
    const originY = record.schemaVersion === 1 ? cumulativeOrigin : record.layout.originY;
    if (originY === undefined || !Number.isFinite(originY) || originY < cumulativeOrigin) {
      throw new Error('Ink schema-v3 upgrade received overlapping surface origins.');
    }
    cumulativeOrigin = originY + record.layout.logicalHeight;
    const upgraded: InkSurfaceRecord = {
      ...record,
      layout: { ...record.layout, originY },
      revision: record.revision + 1,
      schemaVersion: 3,
      strokes:
        record.schemaVersion === 3 ? record.strokes : record.strokes.map(upgradeLegacyStrokeToV3),
      updatedAt: now,
    };
    assertInkSurfaceRecord(upgraded);
    return upgraded;
  });
}

function upgradeLegacyStrokeToV3(stroke: InkStroke): InkStroke {
  if (stroke.tool === 'eraser') return stroke;
  return {
    ...stroke,
    brushRenderVersion: 'legacy-round-v1',
    inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
  };
}

function manualPlacement(
  records: readonly InkSurfaceRecord[],
): Extract<InkSurfaceLegacyReadOrder, { readonly kind: 'manual-placement-required' }> {
  return {
    kind: 'manual-placement-required',
    reason: 'Ink v1 surfaces do not have a unique canonical order.',
    records,
  };
}
