import { resolveInkBrushContract } from './ink-brush-contract';
import type { InkStroke } from './ink-surface';
import type { TextAnnotationTarget } from './text-annotation';

export interface SnapshotCaptureProvenance {
  readonly id: string;
  readonly version: string;
}

export interface SnapshotCaptureAsset {
  readonly backend: SnapshotCaptureProvenance;
  readonly byteLength: number;
  readonly fileName: `capture-${string}.png`;
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly mimeType: 'image/png';
  readonly pixelHeight: number;
  readonly pixelRatio: number;
  readonly pixelWidth: number;
  readonly sha256: string;
}

export interface SnapshotSourceBinding {
  readonly coverage: readonly TextAnnotationTarget[];
  readonly focus: TextAnnotationTarget;
  readonly headingPath: readonly string[];
  readonly sourceRevision: string;
}

export interface SnapshotInkDocument {
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly strokes: readonly InkStroke[];
}

export interface SnapshotAnnotationRecord {
  readonly anchorFailure?: {
    readonly candidateCount: number;
    readonly reason: 'ambiguous' | 'not-found';
  };
  readonly asset: SnapshotCaptureAsset;
  readonly capturedAt: string;
  readonly createdAt: string;
  readonly deletedAt?: string;
  readonly deviceId?: string;
  readonly filePath: string;
  readonly id: string;
  readonly ink: SnapshotInkDocument;
  readonly noteId: string;
  readonly revision: number;
  readonly schemaVersion: 1;
  readonly source: SnapshotSourceBinding;
  readonly status: 'active' | 'unanchored';
  readonly updatedAt: string;
}

export function encodeSnapshotAnnotationRecord(record: SnapshotAnnotationRecord): string {
  assertSnapshotAnnotationRecord(record);
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function decodeSnapshotAnnotationRecord(contents: string): SnapshotAnnotationRecord {
  let decoded: unknown;
  try {
    decoded = JSON.parse(contents);
  } catch (error) {
    throw new Error('Snapshot Annotation record is not valid JSON.', { cause: error });
  }
  assertSnapshotAnnotationRecord(decoded);
  return decoded;
}

export function assertSnapshotAnnotationRecord(
  value: unknown,
): asserts value is SnapshotAnnotationRecord {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Snapshot Annotation record does not match schema version 1.');
  }
  const record = value;
  for (const [name, candidate] of [
    ['id', record.id],
    ['noteId', record.noteId],
    ['filePath', record.filePath],
    ['capturedAt', record.capturedAt],
    ['createdAt', record.createdAt],
    ['updatedAt', record.updatedAt],
  ] as const) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new Error(`Snapshot Annotation ${name} must be non-empty.`);
    }
  }
  if (!hasValidOptionalMetadata(record)) {
    throw new Error('Snapshot Annotation optional metadata is invalid.');
  }
  if (
    typeof record.revision !== 'number' ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    (record.status !== 'active' && record.status !== 'unanchored')
  ) {
    throw new Error('Snapshot Annotation revision or status is invalid.');
  }
  assertCaptureAsset(record.asset);
  assertSnapshotSourceBinding(record.source);
  if (!isRecord(record.ink)) throw new Error('Snapshot Annotation Ink document is invalid.');
  const ink = record.ink;
  if (
    ink.logicalWidth !== record.asset.logicalWidth ||
    ink.logicalHeight !== record.asset.logicalHeight ||
    !Array.isArray(ink.strokes)
  ) {
    throw new Error('Snapshot Annotation image and Ink bounds must match.');
  }
  const strokes: readonly unknown[] = ink.strokes;
  const strokeIds = new Set<string>();
  for (const stroke of strokes) {
    assertSnapshotStroke(stroke, record.asset.logicalWidth, record.asset.logicalHeight);
    if (strokeIds.has(stroke.id)) throw new Error('Snapshot Annotation stroke IDs must be unique.');
    strokeIds.add(stroke.id);
  }
}

function hasValidOptionalMetadata(record: Record<string, unknown>): boolean {
  const anchorFailure = record.anchorFailure;
  return (
    (record.deletedAt === undefined || isNonEmptyString(record.deletedAt)) &&
    (record.deviceId === undefined || isNonEmptyString(record.deviceId)) &&
    (anchorFailure === undefined ||
      (isRecord(anchorFailure) &&
        (anchorFailure.reason === 'ambiguous' || anchorFailure.reason === 'not-found') &&
        typeof anchorFailure.candidateCount === 'number' &&
        Number.isSafeInteger(anchorFailure.candidateCount) &&
        anchorFailure.candidateCount >= 0))
  );
}

function assertCaptureAsset(asset: unknown): asserts asset is SnapshotCaptureAsset {
  if (!isRecord(asset) || !isRecord(asset.backend)) {
    throw new Error('Snapshot Annotation Capture Asset is invalid.');
  }
  if (
    !isNonEmptyString(asset.backend.id) ||
    !isNonEmptyString(asset.backend.version) ||
    asset.mimeType !== 'image/png' ||
    !isNonEmptyString(asset.sha256) ||
    !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
    asset.fileName !== `capture-${asset.sha256}.png` ||
    !isPositiveInteger(asset.byteLength) ||
    !isPositiveNumber(asset.logicalWidth) ||
    !isPositiveNumber(asset.logicalHeight) ||
    !isPositiveInteger(asset.pixelWidth) ||
    !isPositiveInteger(asset.pixelHeight) ||
    !isPositiveNumber(asset.pixelRatio)
  ) {
    throw new Error('Snapshot Annotation Capture Asset metadata is invalid.');
  }
  const widthRatio = asset.pixelWidth / asset.logicalWidth;
  const heightRatio = asset.pixelHeight / asset.logicalHeight;
  if (Math.abs(widthRatio - heightRatio) > 0.02 || Math.abs(widthRatio - asset.pixelRatio) > 0.02) {
    throw new Error('Snapshot Annotation Capture Asset pixel ratio is inconsistent.');
  }
}

export function assertSnapshotSourceBinding(
  source: unknown,
): asserts source is SnapshotSourceBinding {
  if (
    !isRecord(source) ||
    !isNonEmptyString(source.sourceRevision) ||
    !Array.isArray(source.headingPath) ||
    !source.headingPath.every((part) => typeof part === 'string') ||
    !Array.isArray(source.coverage) ||
    source.coverage.length < 1 ||
    source.coverage.length > 5
  ) {
    throw new Error('Snapshot Annotation Source Binding is invalid.');
  }
  assertTarget(source.focus);
  const coverage: readonly unknown[] = source.coverage;
  const identities = new Set<string>();
  let includesFocus = false;
  for (const target of coverage) {
    assertTarget(target);
    const identity = `${target.position.start}:${target.position.end}:${target.quote.exact}`;
    if (identities.has(identity)) {
      throw new Error('Snapshot Annotation Coverage Anchors must be unique.');
    }
    identities.add(identity);
    if (sameTargetIdentity(target, source.focus)) includesFocus = true;
  }
  if (!includesFocus) {
    throw new Error('Snapshot Annotation Coverage must include its Focus Anchor.');
  }
}

function assertTarget(target: unknown): asserts target is TextAnnotationTarget {
  if (
    !isRecord(target) ||
    !isRecord(target.position) ||
    !isRecord(target.quote) ||
    !isRecord(target.scope) ||
    target.position.unit !== 'utf16-code-unit' ||
    typeof target.position.start !== 'number' ||
    typeof target.position.end !== 'number' ||
    !Number.isInteger(target.position.start) ||
    !Number.isInteger(target.position.end) ||
    target.position.start < 0 ||
    target.position.end <= target.position.start ||
    !isNonEmptyString(target.quote.exact) ||
    typeof target.quote.prefix !== 'string' ||
    typeof target.quote.suffix !== 'string'
  ) {
    throw new Error('Snapshot Annotation anchor is invalid.');
  }
}

function assertSnapshotStroke(
  stroke: unknown,
  width: number,
  height: number,
): asserts stroke is InkStroke {
  if (!isRecord(stroke) || !isNonEmptyString(stroke.id)) {
    throw new Error('Snapshot Annotation stroke identity is invalid.');
  }
  if (stroke.tool !== 'pen' && stroke.tool !== 'highlighter') {
    throw new Error('Snapshot Annotation stores only visible Pen and Highlighter strokes.');
  }
  const contract = resolveInkBrushContract({
    color: stroke.color,
    inputProfile: stroke.inputProfile,
    tool: stroke.tool,
    version: stroke.brushRenderVersion,
  });
  if (contract.kind !== 'supported') {
    throw new Error(`Snapshot Annotation stroke brush is unsupported: ${contract.reason}`);
  }
  if (
    !isPositiveNumber(stroke.width) ||
    !Array.isArray(stroke.points) ||
    stroke.points.length < 1
  ) {
    throw new Error('Snapshot Annotation stroke geometry is invalid.');
  }
  const points: readonly unknown[] = stroke.points;
  for (const point of points) {
    if (
      !isRecord(point) ||
      typeof point.x !== 'number' ||
      typeof point.y !== 'number' ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      typeof point.time !== 'number' ||
      typeof point.pressure !== 'number' ||
      !Number.isFinite(point.time) ||
      !Number.isFinite(point.pressure) ||
      point.x < 0 ||
      point.x > width ||
      point.y < 0 ||
      point.y > height
    ) {
      throw new Error('Snapshot Annotation stroke points must stay inside image-local bounds.');
    }
  }
}

function sameTargetIdentity(left: TextAnnotationTarget, right: TextAnnotationTarget): boolean {
  return (
    left.position.start === right.position.start &&
    left.position.end === right.position.end &&
    left.quote.exact === right.quote.exact
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
