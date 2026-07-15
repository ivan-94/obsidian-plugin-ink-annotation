export interface TextPositionSelector {
  readonly end: number;
  readonly start: number;
  readonly unit: 'utf16-code-unit';
}

export interface TextQuoteSelector {
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
}

export interface TextStructuralScope {
  readonly blockFingerprint?: string;
  readonly headingPath?: readonly string[];
  readonly sectionEndLine?: number;
  readonly sectionStartLine?: number;
}

export interface TextAnnotationTarget {
  readonly position: TextPositionSelector;
  readonly quote: TextQuoteSelector;
  readonly scope: TextStructuralScope;
  readonly sourceRevision?: string;
}

export interface TextAnnotationRecord {
  readonly anchorFailure?: {
    readonly candidateCount: number;
    readonly reason: 'ambiguous' | 'not-found';
  };
  readonly body?: string;
  readonly createdAt: string;
  readonly deletedAt?: string;
  readonly deviceId?: string;
  readonly filePath: string;
  readonly id: string;
  readonly mark?: {
    readonly kind: 'highlight' | 'underline';
    readonly styleId: string;
  };
  readonly noteId: string;
  readonly revision: number;
  readonly schemaVersion: 1;
  readonly status: 'active' | 'draft' | 'resolved' | 'unanchored';
  readonly tags: readonly string[];
  readonly target: TextAnnotationTarget;
  readonly updatedAt: string;
}

export function encodeTextAnnotationRecord(record: TextAnnotationRecord): string {
  assertTextAnnotationInvariant(record);
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function decodeTextAnnotationRecord(value: string): TextAnnotationRecord {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Annotation record is not valid JSON.', { cause: error });
  }

  if (!isTextAnnotationRecord(parsed)) {
    throw new Error('Annotation record does not match schema version 1.');
  }

  assertTextAnnotationInvariant(parsed);
  return parsed;
}

export function assertTextAnnotationInvariant(record: TextAnnotationRecord): void {
  if (record.status === 'active') {
    const hasBody = typeof record.body === 'string' && record.body.trim().length > 0;
    if (!record.mark && !hasBody && record.tags.length === 0) {
      throw new Error('An active annotation must contain a mark, body or tag.');
    }
  }

  if (record.target.position.end <= record.target.position.start) {
    throw new Error('Annotation position must be a non-empty forward range.');
  }

  if (record.target.quote.exact.length === 0) {
    throw new Error('Annotation quote must not be empty.');
  }
}

function isTextAnnotationRecord(value: unknown): value is TextAnnotationRecord {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return false;
  }

  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.noteId) ||
    !isNonEmptyString(value.filePath) ||
    !isTextAnnotationTarget(value.target) ||
    !isMark(value.mark) ||
    !isStringArray(value.tags) ||
    !isStatus(value.status) ||
    !Number.isInteger(value.revision) ||
    typeof value.revision !== 'number' ||
    value.revision < 1 ||
    !isNonEmptyString(value.createdAt) ||
    !isNonEmptyString(value.updatedAt)
  ) {
    return false;
  }

  return (
    (value.body === undefined || typeof value.body === 'string') &&
    (value.anchorFailure === undefined || isAnchorFailure(value.anchorFailure)) &&
    (value.deviceId === undefined || typeof value.deviceId === 'string') &&
    (value.deletedAt === undefined || typeof value.deletedAt === 'string')
  );
}

function isAnchorFailure(
  value: unknown,
): value is NonNullable<TextAnnotationRecord['anchorFailure']> {
  return (
    isRecord(value) &&
    (value.reason === 'ambiguous' || value.reason === 'not-found') &&
    typeof value.candidateCount === 'number' &&
    Number.isInteger(value.candidateCount) &&
    value.candidateCount >= 0
  );
}

function isTextAnnotationTarget(value: unknown): value is TextAnnotationTarget {
  if (!isRecord(value) || !isRecord(value.position) || !isRecord(value.quote)) {
    return false;
  }

  return (
    typeof value.position.start === 'number' &&
    typeof value.position.end === 'number' &&
    value.position.unit === 'utf16-code-unit' &&
    typeof value.quote.exact === 'string' &&
    typeof value.quote.prefix === 'string' &&
    typeof value.quote.suffix === 'string' &&
    isTextStructuralScope(value.scope) &&
    (value.sourceRevision === undefined || typeof value.sourceRevision === 'string')
  );
}

function isTextStructuralScope(value: unknown): value is TextStructuralScope {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.blockFingerprint === undefined || typeof value.blockFingerprint === 'string') &&
    (value.headingPath === undefined || isStringArray(value.headingPath)) &&
    (value.sectionStartLine === undefined || typeof value.sectionStartLine === 'number') &&
    (value.sectionEndLine === undefined || typeof value.sectionEndLine === 'number')
  );
}

function isMark(value: unknown): value is TextAnnotationRecord['mark'] {
  return (
    value === undefined ||
    (isRecord(value) &&
      (value.kind === 'highlight' || value.kind === 'underline') &&
      isNonEmptyString(value.styleId))
  );
}

function isStatus(value: unknown): value is TextAnnotationRecord['status'] {
  return value === 'active' || value === 'draft' || value === 'resolved' || value === 'unanchored';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
