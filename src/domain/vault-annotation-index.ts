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

export interface VaultAnnotationFacets {
  readonly folders: readonly string[];
  readonly noteIds: readonly string[];
  readonly notes: readonly { readonly filePath: string; readonly noteId: string }[];
  readonly statuses: readonly AnnotationIndexStatus[];
  readonly styleIds: readonly string[];
  readonly styles: readonly { readonly id: string; readonly name: string }[];
  readonly tags: readonly string[];
  readonly types: readonly AnnotationIndexEntry['type'][];
}

export interface VaultAnnotationQueryPort {
  readonly version: number;
  facets(): VaultAnnotationFacets;
  isReady(): boolean;
  query(input?: {
    readonly filters?: VaultAnnotationFilters;
    readonly text?: string;
  }): VaultAnnotationQueryResult;
  snapshot(): readonly AnnotationIndexEntry[];
  subscribe(listener: () => void): () => void;
}

export class VaultAnnotationIndex implements VaultAnnotationQueryPort {
  private readonly entries = new Map<string, AnnotationIndexEntry>();
  private initialized = false;
  private readonly listeners = new Set<() => void>();
  private cachedFacets: VaultAnnotationFacets | null = null;
  private cachedQuery: {
    readonly key: string;
    readonly result: VaultAnnotationQueryResult;
  } | null = null;
  private cachedSearchableSnapshot:
    | readonly {
        readonly entry: AnnotationIndexEntry;
        readonly text: string;
      }[]
    | null = null;
  private cachedSnapshot: readonly AnnotationIndexEntry[] | null = null;
  private cachedSearchText = new Map<string, string>();
  private currentVersion = 0;

  get version(): number {
    return this.currentVersion;
  }

  rebuild(entries: readonly AnnotationIndexEntry[]): void {
    this.entries.clear();
    this.cachedSearchText.clear();
    for (const entry of entries) {
      const frozen = freezeEntry(entry);
      const key = entryKey(frozen);
      this.entries.set(key, frozen);
      this.cachedSearchText.set(key, searchableText(frozen));
    }
    this.initialized = true;
    this.invalidate();
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
    const frozen = freezeEntry(entry);
    this.entries.set(key, frozen);
    this.cachedSearchText.set(key, searchableText(frozen));
    this.invalidate();
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
    this.cachedSearchText.delete(key);
    this.invalidate();
    return 'removed';
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  query(
    input: { readonly filters?: VaultAnnotationFilters; readonly text?: string } = {},
  ): VaultAnnotationQueryResult {
    const key = queryKey(input);
    if (this.cachedQuery?.key === key) {
      return this.cachedQuery.result;
    }
    const all = this.searchableSnapshot();
    if (all.length === 0) {
      return this.cacheQuery(key, { groups: [], state: 'no-annotations', total: 0 });
    }
    const needle = normalizeSearch(input.text ?? '');
    const groups = new Map<string, AnnotationIndexEntry[]>();
    let total = 0;
    for (const { entry, text } of all) {
      if (needle.length > 0 && !text.includes(needle)) continue;
      if (!matchesFilters(entry, input.filters)) continue;
      const group = groups.get(entry.filePath) ?? [];
      group.push(entry);
      groups.set(entry.filePath, group);
      total += 1;
    }
    if (total === 0) {
      return this.cacheQuery(key, { groups: [], state: 'no-matches', total: 0 });
    }
    return this.cacheQuery(key, {
      groups: [...groups.entries()].map(([filePath, groupedRows]) => ({
        filePath,
        rows: groupedRows,
      })),
      state: 'ready',
      total,
    });
  }

  snapshot(): readonly AnnotationIndexEntry[] {
    this.cachedSnapshot ??= Object.freeze([...this.entries.values()].sort(compareEntries));
    return this.cachedSnapshot;
  }

  facets(): VaultAnnotationFacets {
    if (this.cachedFacets !== null) {
      return this.cachedFacets;
    }
    const folders = new Set<string>();
    const noteIds = new Set<string>();
    const notes = new Map<string, string>();
    const statuses = new Set<AnnotationIndexStatus>();
    const styleIds = new Set<string>();
    const styles = new Map<string, string>();
    const tags = new Set<string>();
    const types = new Set<AnnotationIndexEntry['type']>();
    for (const entry of this.snapshot()) {
      const folder = entry.filePath.slice(0, Math.max(0, entry.filePath.lastIndexOf('/')));
      if (folder.length > 0) folders.add(folder);
      noteIds.add(entry.noteId);
      notes.set(entry.noteId, entry.filePath);
      statuses.add(entry.status);
      if (entry.styleId !== undefined) {
        styleIds.add(entry.styleId);
        styles.set(entry.styleId, entry.styleName ?? entry.styleId);
      }
      entry.tags.forEach((tag) => tags.add(tag));
      types.add(entry.type);
    }
    this.cachedFacets = Object.freeze({
      folders: sorted(folders),
      noteIds: sorted(noteIds),
      notes: Object.freeze(
        [...notes]
          .map(([noteId, filePath]) => Object.freeze({ filePath, noteId }))
          .sort((left, right) => left.filePath.localeCompare(right.filePath)),
      ),
      statuses: sorted(statuses),
      styleIds: sorted(styleIds),
      styles: Object.freeze(
        [...styles]
          .map(([id, name]) => Object.freeze({ id, name }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      ),
      tags: sorted(tags),
      types: sorted(types),
    });
    return this.cachedFacets;
  }

  private cacheQuery(key: string, result: VaultAnnotationQueryResult): VaultAnnotationQueryResult {
    const cached = freezeQueryResult(result);
    this.cachedQuery = { key, result: cached };
    return cached;
  }

  private invalidate(): void {
    this.cachedFacets = null;
    this.cachedQuery = null;
    this.cachedSearchableSnapshot = null;
    this.cachedSnapshot = null;
    this.currentVersion += 1;
    this.listeners.forEach((listener) => listener());
  }

  private searchText(entry: AnnotationIndexEntry): string {
    const key = entryKey(entry);
    const cached = this.cachedSearchText.get(key);
    if (cached !== undefined) return cached;
    const value = searchableText(entry);
    this.cachedSearchText.set(key, value);
    return value;
  }

  private searchableSnapshot(): readonly {
    readonly entry: AnnotationIndexEntry;
    readonly text: string;
  }[] {
    this.cachedSearchableSnapshot ??= this.snapshot().map((entry) => ({
      entry,
      text: this.searchText(entry),
    }));
    return this.cachedSearchableSnapshot;
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

function queryKey(input: {
  readonly filters?: VaultAnnotationFilters;
  readonly text?: string;
}): string {
  return JSON.stringify({
    filters: input.filters ?? null,
    text: normalizeSearch(input.text ?? ''),
  });
}

function sorted<T extends string>(values: ReadonlySet<T>): readonly T[] {
  return Object.freeze([...values].sort((left, right) => left.localeCompare(right)));
}

function freezeQueryResult(result: VaultAnnotationQueryResult): VaultAnnotationQueryResult {
  return Object.freeze({
    groups: Object.freeze(
      result.groups.map((group) =>
        Object.freeze({ filePath: group.filePath, rows: Object.freeze([...group.rows]) }),
      ),
    ),
    state: result.state,
    total: result.total,
  });
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
