import type { AnnotationIndexStatus } from '../domain/vault-annotation-index';
import type { AnnotationIndexEntry } from '../domain/vault-annotation-index';
import type { SnapshotSourceBinding } from '../domain/snapshot-annotation';

export const VAULT_CATALOG_LIMITS = Object.freeze({
  bindingBatch: 100,
  dirtyPaths: 256,
  entryPage: 50,
  recentNotes: 20,
  scanBatch: 128,
  searchPage: 50,
  suggestionPage: 20,
});

export type CatalogFreshness = 'current' | 'reconciling' | 'stale';

export interface CatalogResultMeta {
  readonly freshness: CatalogFreshness;
  readonly projectionEpoch: number;
}

export interface CatalogNoteSummary {
  readonly activityAt: string;
  readonly annotationCount: number;
  readonly conflictCount: number;
  readonly filePath: string;
  readonly folder: string;
  readonly legacyInkCount: number;
  readonly lastAnnotatedAt: string;
  readonly lastOpenedAt?: string;
  readonly noteId: string;
  readonly problemCount: number;
  readonly snapshotCount: number;
  readonly textCount: number;
  readonly title: string;
}

export interface CatalogEntry {
  readonly annotationId: string;
  readonly body?: string;
  readonly capturedAt?: string;
  readonly conflict: 0 | 1;
  readonly filePath: string;
  readonly folder: string;
  readonly headingPath?: readonly string[];
  readonly linkState?: 'linked' | 'source-changed' | 'unanchored';
  readonly logicalHeight?: number;
  readonly logicalWidth?: number;
  readonly noteId: string;
  readonly position: number;
  readonly quote: string;
  readonly revision: number;
  readonly searchTextNormalized: string;
  readonly status: AnnotationIndexStatus;
  readonly strokeCount?: number;
  readonly styleId?: string;
  readonly styleName?: string;
  readonly tags: readonly string[];
  readonly tagsNormalized: readonly string[];
  readonly thumbnailKey?: string;
  readonly type: 'highlight' | 'ink' | 'note' | 'snapshot' | 'underline';
  readonly updatedAt: string;
}

export interface CatalogSnapshotBinding {
  readonly annotationId: string;
  readonly filePath: string;
  readonly noteId: string;
  readonly source: SnapshotSourceBinding;
  readonly sourceRevision: string;
}

export type CatalogCursor = string & { readonly __catalogCursor: unique symbol };

export interface CatalogEntryPageReady {
  readonly entries: readonly CatalogEntry[];
  readonly hasMore: boolean;
  readonly meta: CatalogResultMeta;
  readonly nextCursor?: CatalogCursor;
  readonly state: 'ready';
}

export interface CatalogEntryPageSuperseded {
  readonly entries: readonly CatalogEntry[];
  readonly hasMore: false;
  readonly meta: CatalogResultMeta;
  readonly state: 'superseded';
}

export type CatalogEntryPage = CatalogEntryPageReady | CatalogEntryPageSuperseded;

export interface VaultCatalogFilters {
  readonly conflict?: boolean;
  readonly folders?: readonly string[];
  readonly noteIds?: readonly string[];
  readonly statuses?: readonly AnnotationIndexStatus[];
  readonly styleIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly types?: readonly CatalogEntry['type'][];
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
}

export interface VaultCatalogSearchPageReady {
  readonly entries: readonly CatalogEntry[];
  readonly hasMore: boolean;
  readonly meta: CatalogResultMeta;
  readonly nextCursor?: CatalogCursor;
  readonly progress: { readonly exhaustive: boolean; readonly scanned: number };
  readonly state: 'ready';
}

export interface VaultCatalogSearchPageSuperseded {
  readonly entries: readonly CatalogEntry[];
  readonly hasMore: false;
  readonly meta: CatalogResultMeta;
  readonly progress: { readonly exhaustive: false; readonly scanned: number };
  readonly state: 'superseded';
}

export type VaultCatalogSearchPage = VaultCatalogSearchPageReady | VaultCatalogSearchPageSuperseded;

export interface RecentNotesResult {
  readonly meta: CatalogResultMeta;
  readonly notes: readonly CatalogNoteSummary[];
}

export interface FacetSuggestion {
  readonly label: string;
  readonly value: string;
}

export interface VaultCatalogQueryPort {
  entriesForNote(input: {
    readonly cursor?: CatalogCursor;
    readonly limit?: number;
    readonly noteId: string;
    readonly signal?: AbortSignal;
  }): Promise<CatalogEntryPage>;
  recentNotes(input?: {
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<RecentNotesResult>;
  search(input: {
    readonly cursor?: CatalogCursor;
    readonly filters?: VaultCatalogFilters;
    readonly limit?: number;
    readonly signal?: AbortSignal;
    readonly text: string;
  }): Promise<VaultCatalogSearchPage>;
  suggestFacet(input: {
    readonly facet: 'folder' | 'note' | 'tag';
    readonly limit?: number;
    readonly prefix: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly FacetSuggestion[]>;
}

export async function* streamVaultCatalogSearch(
  catalog: Pick<VaultCatalogQueryPort, 'search'>,
  input: {
    readonly filters?: VaultCatalogFilters;
    readonly signal?: AbortSignal;
    readonly text: string;
  },
): AsyncIterable<CatalogEntry> {
  let cursor: CatalogCursor | undefined;
  do {
    const page = await catalog.search({
      ...(cursor === undefined ? {} : { cursor }),
      ...(input.filters === undefined ? {} : { filters: input.filters }),
      limit: VAULT_CATALOG_LIMITS.searchPage,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      text: input.text,
    });
    if (page.state === 'superseded') {
      throw new Error('Vault Catalog export was superseded by a projection change.');
    }
    for (const entry of page.entries) yield entry;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

export function catalogEntryFromIndexEntry(entry: AnnotationIndexEntry): CatalogEntry {
  const folder = entry.filePath.slice(0, Math.max(0, entry.filePath.lastIndexOf('/')));
  const headingPath = entry.ink?.headingPath ?? entry.snapshot?.headingPath;
  const strokeCount = entry.ink?.strokeCount ?? entry.snapshot?.strokeCount;
  const catalogEntry: CatalogEntry = {
    annotationId: entry.id,
    ...(entry.body === undefined ? {} : { body: entry.body }),
    ...(entry.snapshot === undefined ? {} : { capturedAt: entry.snapshot.capturedAt }),
    conflict: entry.conflict ? 1 : 0,
    filePath: entry.filePath,
    folder,
    ...(headingPath === undefined ? {} : { headingPath: Object.freeze([...headingPath]) }),
    ...(entry.snapshot === undefined ? {} : { linkState: entry.snapshot.linkState }),
    ...(entry.snapshot === undefined ? {} : { logicalHeight: entry.snapshot.logicalHeight }),
    ...(entry.snapshot === undefined ? {} : { logicalWidth: entry.snapshot.logicalWidth }),
    noteId: entry.noteId,
    position: entry.position,
    quote: entry.quote,
    revision: entry.revision,
    searchTextNormalized: catalogSearchText(entry),
    status: entry.status,
    ...(strokeCount === undefined ? {} : { strokeCount }),
    ...(entry.styleId === undefined ? {} : { styleId: entry.styleId }),
    ...(entry.styleName === undefined ? {} : { styleName: entry.styleName }),
    tags: Object.freeze([...entry.tags]),
    tagsNormalized: Object.freeze(entry.tags.map(normalizeCatalogSearch)),
    ...(entry.snapshot === undefined ? {} : { thumbnailKey: entry.snapshot.thumbnailKey }),
    type: entry.type,
    updatedAt: entry.updatedAt,
  };
  return Object.freeze(catalogEntry);
}

export function indexEntryFromCatalogEntry(entry: CatalogEntry): AnnotationIndexEntry {
  return Object.freeze({
    ...(entry.body === undefined ? {} : { body: entry.body }),
    conflict: entry.conflict === 1,
    filePath: entry.filePath,
    id: entry.annotationId,
    ...(entry.type !== 'ink'
      ? {}
      : {
          ink: Object.freeze({
            headingPath: Object.freeze([...(entry.headingPath ?? [])]),
            strokeCount: entry.strokeCount ?? 0,
          }),
        }),
    ...(entry.type !== 'snapshot' ||
    entry.capturedAt === undefined ||
    entry.linkState === undefined ||
    entry.logicalHeight === undefined ||
    entry.logicalWidth === undefined ||
    entry.thumbnailKey === undefined
      ? {}
      : {
          snapshot: Object.freeze({
            capturedAt: entry.capturedAt,
            headingPath: Object.freeze([...(entry.headingPath ?? [])]),
            linkState: entry.linkState,
            logicalHeight: entry.logicalHeight,
            logicalWidth: entry.logicalWidth,
            strokeCount: entry.strokeCount ?? 0,
            thumbnailKey: entry.thumbnailKey,
          }),
        }),
    noteId: entry.noteId,
    position: entry.position,
    quote: entry.quote,
    revision: entry.revision,
    status: entry.status,
    ...(entry.styleId === undefined ? {} : { styleId: entry.styleId }),
    ...(entry.styleName === undefined ? {} : { styleName: entry.styleName }),
    tags: Object.freeze([...entry.tags]),
    type: entry.type,
    updatedAt: entry.updatedAt,
  });
}

export function normalizeCatalogSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function catalogSearchText(entry: AnnotationIndexEntry): string {
  return normalizeCatalogSearch(
    [
      entry.quote,
      entry.body ?? '',
      entry.filePath,
      entry.tags.join(' '),
      entry.styleName ?? '',
      entry.styleId ?? '',
      entry.ink?.headingPath.join(' ') ?? '',
      entry.ink === undefined ? '' : `${entry.ink.strokeCount} strokes ink drawing`,
      entry.snapshot?.headingPath.join(' ') ?? '',
      entry.snapshot === undefined
        ? ''
        : `${entry.snapshot.strokeCount} strokes snapshot ${entry.snapshot.linkState}`,
      entry.type,
      entry.status,
      entry.conflict ? 'conflict' : '',
    ].join('\n'),
  );
}
