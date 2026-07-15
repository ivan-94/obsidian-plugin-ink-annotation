import type { TextAnnotationRecord } from './text-annotation';
import type { InkSurfaceSummary } from './ink-surface-summary';

export type AnnotationIndexStatus = TextAnnotationRecord['status'] | 'needs-rebase';

export interface AnnotationIndexEntry {
  readonly body?: string;
  readonly conflict: boolean;
  readonly filePath: string;
  readonly id: string;
  readonly ink?: {
    readonly headingPath: readonly string[];
    readonly strokeCount: number;
  };
  readonly noteId: string;
  readonly position: number;
  readonly quote: string;
  readonly revision: number;
  readonly status: AnnotationIndexStatus;
  readonly styleId?: string;
  readonly styleName?: string;
  readonly tags: readonly string[];
  readonly type: 'highlight' | 'ink' | 'note' | 'underline';
  readonly updatedAt: string;
}

export interface VaultAnnotationQueryResult {
  readonly groups: readonly {
    readonly filePath: string;
    readonly rows: readonly AnnotationIndexEntry[];
  }[];
  readonly state: 'no-annotations' | 'no-matches' | 'ready';
  readonly total: number;
}

export interface VaultAnnotationFilters {
  readonly conflict?: boolean;
  readonly folders?: readonly string[];
  readonly noteIds?: readonly string[];
  readonly statuses?: readonly AnnotationIndexStatus[];
  readonly styleIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly types?: readonly AnnotationIndexEntry['type'][];
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
}

export class VaultAnnotationIndex {
  private readonly entries = new Map<string, AnnotationIndexEntry>();
  private initialized = false;

  rebuild(entries: readonly AnnotationIndexEntry[]): void {
    this.entries.clear();
    for (const entry of entries) {
      this.entries.set(entryKey(entry), freezeEntry(entry));
    }
    this.initialized = true;
  }

  isReady(): boolean {
    return this.initialized;
  }

  upsert(entry: AnnotationIndexEntry): 'applied' | 'stale' | 'unchanged' {
    const key = entryKey(entry);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (entry.revision < existing.revision) {
        return 'stale';
      }
      if (entry.revision === existing.revision) {
        if (sameEntry(existing, entry)) {
          return 'unchanged';
        }
        if (!entry.conflict || existing.conflict) {
          return 'stale';
        }
      }
    }
    this.entries.set(key, freezeEntry(entry));
    return 'applied';
  }

  remove(input: {
    readonly expectedRevision: number;
    readonly id: string;
    readonly noteId: string;
  }): 'missing' | 'removed' | 'stale' {
    const key = entryKey(input);
    const existing = this.entries.get(key);
    if (existing === undefined) {
      return 'missing';
    }
    if (existing.revision !== input.expectedRevision) {
      return 'stale';
    }
    this.entries.delete(key);
    return 'removed';
  }

  query(
    input: { readonly filters?: VaultAnnotationFilters; readonly text?: string } = {},
  ): VaultAnnotationQueryResult {
    const all = this.snapshot();
    if (all.length === 0) {
      return { groups: [], state: 'no-annotations', total: 0 };
    }
    const needle = normalizeSearch(input.text ?? '');
    const textMatches =
      needle.length === 0 ? all : all.filter((entry) => searchableText(entry).includes(needle));
    const rows = textMatches.filter((entry) => matchesFilters(entry, input.filters));
    if (rows.length === 0) {
      return { groups: [], state: 'no-matches', total: 0 };
    }
    const groups = new Map<string, AnnotationIndexEntry[]>();
    for (const row of rows) {
      const group = groups.get(row.filePath) ?? [];
      group.push(row);
      groups.set(row.filePath, group);
    }
    return {
      groups: [...groups.entries()].map(([filePath, groupedRows]) => ({
        filePath,
        rows: groupedRows,
      })),
      state: 'ready',
      total: rows.length,
    };
  }

  snapshot(): readonly AnnotationIndexEntry[] {
    return [...this.entries.values()].sort(compareEntries);
  }
}

export function textRecordToIndexEntry(
  record: TextAnnotationRecord,
  options: { readonly conflict?: boolean; readonly styleName?: string } = {},
): AnnotationIndexEntry {
  return freezeEntry({
    ...(record.body === undefined ? {} : { body: record.body }),
    conflict: options.conflict ?? false,
    filePath: record.filePath,
    id: record.id,
    noteId: record.noteId,
    position: record.target.position.start,
    quote: record.target.quote.exact,
    revision: record.revision,
    status: record.status,
    ...(record.mark === undefined ? {} : { styleId: record.mark.styleId }),
    ...(options.styleName === undefined ? {} : { styleName: options.styleName }),
    tags: record.tags,
    type: record.mark?.kind ?? 'note',
    updatedAt: record.updatedAt,
  });
}

export function inkSummaryToIndexEntry(
  summary: InkSurfaceSummary,
  noteId: string,
): AnnotationIndexEntry {
  const heading = summary.headingPath.length === 0 ? 'Document' : summary.headingPath.join(' › ');
  return freezeEntry({
    body: `${summary.strokeCount} ${summary.strokeCount === 1 ? 'stroke' : 'strokes'}`,
    conflict: summary.conflict ?? false,
    filePath: summary.filePath,
    id: summary.id,
    ink: { headingPath: [...summary.headingPath], strokeCount: summary.strokeCount },
    noteId,
    position: summary.position,
    quote: `Ink · ${heading}`,
    revision: summary.revision,
    status: summary.status,
    tags: [],
    type: 'ink',
    updatedAt: summary.updatedAt,
  });
}

function entryKey(entry: Pick<AnnotationIndexEntry, 'id' | 'noteId'>): string {
  return `${entry.noteId}\u0000${entry.id}`;
}

function sameEntry(left: AnnotationIndexEntry, right: AnnotationIndexEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function freezeEntry(entry: AnnotationIndexEntry): AnnotationIndexEntry {
  return Object.freeze({
    ...entry,
    ...(entry.ink === undefined
      ? {}
      : {
          ink: Object.freeze({
            headingPath: Object.freeze([...entry.ink.headingPath]),
            strokeCount: entry.ink.strokeCount,
          }),
        }),
    tags: Object.freeze([...entry.tags]),
  });
}

function compareEntries(left: AnnotationIndexEntry, right: AnnotationIndexEntry): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.position - right.position ||
    left.id.localeCompare(right.id)
  );
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function searchableText(entry: AnnotationIndexEntry): string {
  return normalizeSearch(
    [
      entry.quote,
      entry.body ?? '',
      entry.filePath,
      entry.tags.join(' '),
      entry.styleName ?? '',
      entry.styleId ?? '',
      entry.ink?.headingPath.join(' ') ?? '',
      entry.ink === undefined ? '' : `${entry.ink.strokeCount} strokes ink drawing`,
      entry.type,
      entry.status,
      entry.updatedAt,
      entry.conflict ? 'conflict' : '',
    ].join('\n'),
  );
}

function matchesFilters(
  entry: AnnotationIndexEntry,
  filters: VaultAnnotationFilters | undefined,
): boolean {
  if (filters === undefined) {
    return true;
  }
  const entryTags = new Set(entry.tags.map(normalizeSearch));
  return (
    (filters.conflict === undefined || entry.conflict === filters.conflict) &&
    (filters.folders === undefined ||
      filters.folders.some(
        (folder) => entry.filePath === folder || entry.filePath.startsWith(`${folder}/`),
      )) &&
    (filters.noteIds === undefined || filters.noteIds.includes(entry.noteId)) &&
    (filters.statuses === undefined || filters.statuses.includes(entry.status)) &&
    (filters.styleIds === undefined ||
      (entry.styleId !== undefined && filters.styleIds.includes(entry.styleId))) &&
    (filters.tags === undefined ||
      filters.tags.every((tag) => entryTags.has(normalizeSearch(tag)))) &&
    (filters.types === undefined || filters.types.includes(entry.type)) &&
    (filters.updatedAfter === undefined || entry.updatedAt >= filters.updatedAfter) &&
    (filters.updatedBefore === undefined || entry.updatedAt <= filters.updatedBefore)
  );
}
