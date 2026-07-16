import { annotationTargetText, type TextAnnotationRecord } from './text-annotation';

export interface CompactAnnotationRow {
  readonly deletedAt?: string;
  readonly id: string;
  readonly marker:
    | { readonly kind: 'highlight' | 'underline'; readonly styleId: string }
    | { readonly kind: 'note' };
  readonly notePreview: string | null;
  readonly position: number;
  readonly quote: string;
  readonly revision: number;
  readonly status: TextAnnotationRecord['status'];
  readonly tags: readonly string[];
  readonly updatedAt: string;
}

export interface AnnotationRowGroup {
  readonly kind: 'heading' | 'problems';
  readonly rows: readonly CompactAnnotationRow[];
  readonly title: string;
}

export interface CurrentFileAnnotationList {
  readonly groups: readonly AnnotationRowGroup[];
  readonly total: number;
}

export function buildCurrentFileAnnotationList(
  records: readonly TextAnnotationRecord[],
  options: {
    readonly deletedRestoreWindowMs?: number;
    readonly now?: string;
  } = {},
): CurrentFileAnnotationList {
  const now = options.now === undefined ? Number.NaN : Date.parse(options.now);
  const visible = records
    .filter((record) => {
      if (record.deletedAt === undefined) return true;
      if (options.deletedRestoreWindowMs === undefined || !Number.isFinite(now)) return false;
      const deletedAt = Date.parse(record.deletedAt);
      return Number.isFinite(deletedAt) && now < deletedAt + options.deletedRestoreWindowMs;
    })
    .sort(compareDocumentPosition);
  const problems: CompactAnnotationRow[] = [];
  const headingGroups = new Map<string, CompactAnnotationRow[]>();

  for (const record of visible) {
    const row = toCompactRow(record);
    if (record.status === 'unanchored') {
      problems.push(row);
      continue;
    }
    const headingPath = record.target.scope.headingPath;
    const heading = headingPath?.at(-1)?.trim() || 'Document';
    const group = headingGroups.get(heading) ?? [];
    group.push(row);
    headingGroups.set(heading, group);
  }

  const groups: AnnotationRowGroup[] = [];
  if (problems.length > 0) {
    groups.push({ kind: 'problems', rows: problems, title: 'Problems' });
  }
  for (const [title, rows] of headingGroups) {
    groups.push({ kind: 'heading', rows, title });
  }
  return { groups, total: visible.length };
}

function compareDocumentPosition(left: TextAnnotationRecord, right: TextAnnotationRecord): number {
  return (
    left.target.position.start - right.target.position.start ||
    left.target.position.end - right.target.position.end ||
    left.id.localeCompare(right.id)
  );
}

function toCompactRow(record: TextAnnotationRecord): CompactAnnotationRow {
  return {
    ...(record.deletedAt === undefined ? {} : { deletedAt: record.deletedAt }),
    id: record.id,
    marker:
      record.mark === undefined
        ? { kind: 'note' }
        : { kind: record.mark.kind, styleId: record.mark.styleId },
    notePreview:
      typeof record.body === 'string' && record.body.trim().length > 0 ? record.body.trim() : null,
    position: record.target.position.start,
    quote: annotationTargetText(record.target),
    revision: record.revision,
    status: record.status,
    tags: [...record.tags],
    updatedAt: record.updatedAt,
  };
}
