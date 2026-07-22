import type { SnapshotAnnotationRecord, SnapshotSourceBinding } from './snapshot-annotation';
import { assertSnapshotSourceBinding } from './snapshot-annotation';
import type { SnapshotSourceLinkProjection } from './snapshot-source-binding';
import { projectSnapshotSourceLink } from './snapshot-source-binding';

export interface SnapshotAnnotationSummary {
  readonly capturedAt: string;
  readonly deletedAt?: string;
  readonly filePath: string;
  readonly headingPath: readonly string[];
  readonly id: string;
  readonly linkState: SnapshotSourceLinkProjection['state'];
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly revision: number;
  readonly sourceOrder: number;
  readonly status: SnapshotAnnotationRecord['status'];
  readonly strokeCount: number;
  readonly thumbnailKey: string;
  readonly updatedAt: string;
}

export interface SnapshotAnnotationIndexEntry {
  readonly anchorFailure?: SnapshotAnnotationRecord['anchorFailure'];
  readonly assetSha256: string;
  readonly capturedAt: string;
  readonly deletedAt?: string;
  readonly filePath: string;
  readonly id: string;
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly revision: number;
  readonly schemaVersion: 1;
  readonly source: SnapshotSourceBinding;
  readonly status: SnapshotAnnotationRecord['status'];
  readonly strokeCount: number;
  readonly updatedAt: string;
}

export function createSnapshotAnnotationIndexEntry(
  record: SnapshotAnnotationRecord,
): SnapshotAnnotationIndexEntry {
  return Object.freeze({
    ...(record.anchorFailure === undefined ? {} : { anchorFailure: { ...record.anchorFailure } }),
    assetSha256: record.asset.sha256,
    capturedAt: record.capturedAt,
    ...(record.deletedAt === undefined ? {} : { deletedAt: record.deletedAt }),
    filePath: record.filePath,
    id: record.id,
    logicalHeight: record.asset.logicalHeight,
    logicalWidth: record.asset.logicalWidth,
    revision: record.revision,
    schemaVersion: 1,
    source: structuredClone(record.source),
    status: record.status,
    strokeCount: record.ink.strokes.length,
    updatedAt: record.updatedAt,
  });
}

export function encodeSnapshotAnnotationIndexEntry(entry: SnapshotAnnotationIndexEntry): string {
  assertSnapshotAnnotationIndexEntry(entry);
  return `${JSON.stringify(entry, null, 2)}\n`;
}

export function decodeSnapshotAnnotationIndexEntry(contents: string): SnapshotAnnotationIndexEntry {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (cause) {
    throw new Error('Snapshot Annotation index entry is not valid JSON.', { cause });
  }
  assertSnapshotAnnotationIndexEntry(value);
  return value;
}

export function assertSnapshotAnnotationIndexEntry(
  value: unknown,
): asserts value is SnapshotAnnotationIndexEntry {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isNonEmptyString(value.assetSha256) ||
    !/^[a-f0-9]{64}$/u.test(value.assetSha256) ||
    !isNonEmptyString(value.capturedAt) ||
    !isNonEmptyString(value.filePath) ||
    !isNonEmptyString(value.id) ||
    !isPositiveNumber(value.logicalHeight) ||
    !isPositiveNumber(value.logicalWidth) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    (value.status !== 'active' && value.status !== 'unanchored') ||
    typeof value.strokeCount !== 'number' ||
    !Number.isSafeInteger(value.strokeCount) ||
    value.strokeCount < 0 ||
    !isNonEmptyString(value.updatedAt) ||
    (value.deletedAt !== undefined && !isNonEmptyString(value.deletedAt))
  ) {
    throw new Error('Snapshot Annotation index entry is invalid.');
  }
  assertSnapshotSourceBinding(value.source);
}

export function createSnapshotAnnotationSummary(
  record: SnapshotAnnotationRecord,
  link: SnapshotSourceLinkProjection,
): SnapshotAnnotationSummary {
  const focus = link.anchors.find(({ focus }) => focus);
  return Object.freeze({
    capturedAt: record.capturedAt,
    ...(record.deletedAt === undefined ? {} : { deletedAt: record.deletedAt }),
    filePath: record.filePath,
    headingPath: Object.freeze([...record.source.headingPath]),
    id: record.id,
    linkState: link.state,
    logicalHeight: record.asset.logicalHeight,
    logicalWidth: record.asset.logicalWidth,
    revision: record.revision,
    sourceOrder: focus?.start ?? record.source.focus.position.start,
    status: record.status,
    strokeCount: record.ink.strokes.length,
    thumbnailKey: `snapshot:${record.asset.sha256}:${record.revision}`,
    updatedAt: record.updatedAt,
  });
}

export function createSnapshotAnnotationSummaryFromIndexEntry(
  entry: SnapshotAnnotationIndexEntry,
  source: string,
): SnapshotAnnotationSummary {
  const link = projectSnapshotSourceLink(source, entry.source);
  const focus = link.anchors.find(({ focus }) => focus);
  return Object.freeze({
    capturedAt: entry.capturedAt,
    ...(entry.deletedAt === undefined ? {} : { deletedAt: entry.deletedAt }),
    filePath: entry.filePath,
    headingPath: Object.freeze([...entry.source.headingPath]),
    id: entry.id,
    linkState: link.state,
    logicalHeight: entry.logicalHeight,
    logicalWidth: entry.logicalWidth,
    revision: entry.revision,
    sourceOrder: focus?.start ?? entry.source.focus.position.start,
    status: entry.status,
    strokeCount: entry.strokeCount,
    thumbnailKey: `snapshot:${entry.assetSha256}:${entry.revision}`,
    updatedAt: entry.updatedAt,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
