import type {
  AnnotationIndexEntry,
  VaultAnnotationFacets,
  VaultAnnotationQueryPort,
  VaultAnnotationQueryResult,
} from '../domain/vault-annotation-index';
import {
  indexEntryFromCatalogEntry,
  type CatalogEntry,
  type CatalogNoteSummary,
} from '../application/vault-catalog';

export class VaultCatalogPageModel implements VaultAnnotationQueryPort {
  private currentVersion = 0;
  private readonly listeners = new Set<() => void>();
  private readonly notePages = new Map<string, readonly AnnotationIndexEntry[]>();
  private recent: readonly CatalogNoteSummary[] = [];
  private searchEntries: readonly AnnotationIndexEntry[] | null = null;

  get version(): number {
    return this.currentVersion;
  }

  facets(): VaultAnnotationFacets {
    const entries = this.snapshot();
    const folders = new Set<string>();
    const noteIds = new Set<string>();
    const notes = new Map<string, string>();
    const statuses = new Set<AnnotationIndexEntry['status']>();
    const styleIds = new Set<string>();
    const styles = new Map<string, string>();
    const tags = new Set<string>();
    const types = new Set<AnnotationIndexEntry['type']>();
    for (const entry of entries) {
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
    return Object.freeze({
      folders: sorted(folders),
      noteIds: sorted(noteIds),
      notes: Object.freeze(
        [...notes].map(([noteId, filePath]) => Object.freeze({ filePath, noteId })),
      ),
      statuses: sorted(statuses),
      styleIds: sorted(styleIds),
      styles: Object.freeze([...styles].map(([id, name]) => Object.freeze({ id, name }))),
      tags: sorted(tags),
      types: sorted(types),
    });
  }

  isReady(): boolean {
    return true;
  }

  query(): VaultAnnotationQueryResult {
    if (this.searchEntries !== null) return groupEntries(this.searchEntries);
    if (this.recent.length === 0) {
      return Object.freeze({ groups: Object.freeze([]), state: 'no-annotations', total: 0 });
    }
    const groups = this.recent.map((note) =>
      Object.freeze({
        filePath: note.filePath,
        rows: this.notePages.get(note.noteId) ?? Object.freeze([]),
      }),
    );
    return Object.freeze({
      groups: Object.freeze(groups),
      state: 'ready',
      total: this.snapshot().length,
    });
  }

  snapshot(): readonly AnnotationIndexEntry[] {
    if (this.searchEntries !== null) return this.searchEntries;
    return Object.freeze([...this.notePages.values()].flat());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  showRecent(notes: readonly CatalogNoteSummary[]): void {
    this.recent = Object.freeze([...notes]);
    this.searchEntries = null;
    const visibleIds = new Set(notes.map(({ noteId }) => noteId));
    for (const noteId of this.notePages.keys()) {
      if (!visibleIds.has(noteId)) this.notePages.delete(noteId);
    }
    this.publish();
  }

  showNotePage(noteId: string, entries: readonly CatalogEntry[]): void {
    this.notePages.delete(noteId);
    this.notePages.set(noteId, Object.freeze(entries.map(indexEntryFromCatalogEntry)));
    while (this.notePages.size > 3) {
      const oldest = this.notePages.keys().next().value;
      if (oldest === undefined) break;
      this.notePages.delete(oldest);
    }
    this.publish();
  }

  showSearch(entries: readonly CatalogEntry[]): void {
    this.searchEntries = Object.freeze(entries.map(indexEntryFromCatalogEntry));
    this.notePages.clear();
    this.publish();
  }

  noteForPath(filePath: string): CatalogNoteSummary | undefined {
    return this.recent.find((note) => note.filePath === filePath);
  }

  groupTotals(): ReadonlyMap<string, number> {
    return new Map(this.recent.map((note) => [note.filePath, note.annotationCount]));
  }

  loadedNoteIds(): readonly string[] {
    return Object.freeze([...this.notePages.keys()]);
  }

  clear(): void {
    this.notePages.clear();
    this.recent = [];
    this.searchEntries = null;
    this.publish();
  }

  private publish(): void {
    this.currentVersion += 1;
    this.listeners.forEach((listener) => listener());
  }
}

function groupEntries(entries: readonly AnnotationIndexEntry[]): VaultAnnotationQueryResult {
  if (entries.length === 0) {
    return Object.freeze({ groups: Object.freeze([]), state: 'no-matches', total: 0 });
  }
  const groups = new Map<string, AnnotationIndexEntry[]>();
  for (const entry of entries) {
    const rows = groups.get(entry.filePath) ?? [];
    rows.push(entry);
    groups.set(entry.filePath, rows);
  }
  return Object.freeze({
    groups: Object.freeze(
      [...groups].map(([filePath, rows]) => Object.freeze({ filePath, rows: Object.freeze(rows) })),
    ),
    state: 'ready',
    total: entries.length,
  });
}

function sorted<T extends string>(values: ReadonlySet<T>): readonly T[] {
  return Object.freeze([...values].sort((left, right) => left.localeCompare(right)));
}
