import Dexie, { type Table } from 'dexie';

import {
  VAULT_CATALOG_LIMITS,
  type CatalogCursor,
  type CatalogEntry,
  type CatalogEntryPage,
  type CatalogFreshness,
  type FacetSuggestion,
  type CatalogNoteSummary,
  type CatalogResultMeta,
  type CatalogSnapshotBinding,
  type RecentNotesResult,
  type VaultCatalogFilters,
  type VaultCatalogSearchPage,
} from '../application/vault-catalog';

interface CatalogMetaRow {
  readonly key: string;
  readonly value: unknown;
}

interface CatalogNoteRow extends CatalogNoteSummary {
  readonly titleNormalized: string;
}

interface CatalogEntryRow extends CatalogEntry {
  readonly rowId?: number;
}

interface CatalogSourceRow {
  readonly authority: 'canonical' | 'derived-hint' | 'projection-dependency';
  readonly contentDigest?: string;
  readonly kind:
    | 'legacy-ink-document'
    | 'legacy-ink-summary'
    | 'legacy-ink-surface'
    | 'markdown-source'
    | 'meta'
    | 'snapshot-record'
    | 'snapshot-summary'
    | 'text-record';
  readonly logicalId: string;
  readonly mtime: number;
  readonly noteId: string;
  readonly projectedRevision?: number;
  readonly sourcePath: string;
  readonly sourceRevision?: string;
  readonly size: number;
}

interface IndexedDbVaultCatalogOptions {
  readonly IDBKeyRange: typeof globalThis.IDBKeyRange;
  readonly databaseName: string;
  readonly indexedDB: IDBFactory;
  readonly vaultFingerprint: string;
  readonly yieldControl?: () => Promise<void>;
}

export class VaultCatalogIdentityMismatchError extends Error {
  constructor() {
    super('Vault Catalog belongs to another Vault.');
    this.name = 'VaultCatalogIdentityMismatchError';
  }
}

export class IndexedDbVaultCatalog {
  private readonly database: Dexie;
  private readonly entries: Table<CatalogEntryRow, number>;
  private readonly meta: Table<CatalogMetaRow, string>;
  private readonly notes: Table<CatalogNoteRow, string>;
  private readonly snapshotBindings: Table<CatalogSnapshotBinding, [string, string]>;
  private readonly vaultFingerprint: string;
  private readonly yieldControl: () => Promise<void>;

  constructor(options: IndexedDbVaultCatalogOptions) {
    this.vaultFingerprint = options.vaultFingerprint;
    this.yieldControl = options.yieldControl ?? (() => Promise.resolve());
    this.database = new Dexie(options.databaseName, {
      IDBKeyRange: options.IDBKeyRange,
      indexedDB: options.indexedDB,
    });
    this.database.version(1).stores({
      entries:
        '++rowId, &[noteId+annotationId], [noteId+position+rowId], [noteId+updatedAt+rowId], [updatedAt+rowId], filePath, folder, type, status, styleId, conflict, *tagsNormalized',
      meta: '&key',
      notes:
        '&noteId, &filePath, [activityAt+noteId], [lastAnnotatedAt+noteId], folder, titleNormalized',
      snapshotBindings: '&[noteId+annotationId], noteId, filePath, sourceRevision',
      sources: '&sourcePath, [noteId+kind+logicalId], noteId, authority, kind, projectedRevision',
    });
    this.entries = this.database.table<CatalogEntryRow, number>('entries');
    this.meta = this.database.table<CatalogMetaRow, string>('meta');
    this.notes = this.database.table<CatalogNoteRow, string>('notes');
    this.snapshotBindings = this.database.table<CatalogSnapshotBinding, [string, string]>(
      'snapshotBindings',
    );
  }

  async upsertEntry(entry: CatalogEntry): Promise<'applied' | 'stale' | 'unchanged'> {
    await this.ensureIdentity();
    return this.database.transaction('rw', this.entries, this.meta, this.notes, async () => {
      const existing = await this.entries
        .where('[noteId+annotationId]')
        .equals([entry.noteId, entry.annotationId])
        .first();
      if (existing !== undefined) {
        if (entry.revision < existing.revision) return 'stale';
        if (entry.revision === existing.revision) {
          if (sameCatalogEntry(existing, entry)) return 'unchanged';
          if (entry.conflict === 0 || existing.conflict === 1) return 'stale';
        }
      }
      const stored: CatalogEntryRow = {
        ...entry,
        ...(existing?.rowId === undefined ? {} : { rowId: existing.rowId }),
        ...(entry.headingPath === undefined
          ? {}
          : { headingPath: Object.freeze([...entry.headingPath]) }),
        tags: Object.freeze([...entry.tags]),
        tagsNormalized: Object.freeze([...entry.tagsNormalized]),
      };
      await this.entries.put(stored);
      const current = await this.notes.get(entry.noteId);
      await this.notes.put(updateNote(current, existing, stored));
      await this.bumpProjectionEpoch();
      return 'applied';
    });
  }

  async recentNotes(
    input: {
      readonly limit?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<RecentNotesResult> {
    const limit = validatedLimit(
      input.limit ?? VAULT_CATALOG_LIMITS.recentNotes,
      VAULT_CATALOG_LIMITS.recentNotes,
      'recent note',
    );
    throwIfAborted(input.signal);
    await this.ensureIdentity();
    const [rows, meta] = await Promise.all([
      this.notes.orderBy('[activityAt+noteId]').reverse().limit(limit).toArray(),
      this.resultMeta(),
    ]);
    throwIfAborted(input.signal);
    return Object.freeze({
      meta,
      notes: Object.freeze(rows.map(toNoteSummary)),
    });
  }

  async recordNoteOpened(noteId: string, openedAt: string): Promise<void> {
    if (noteId.length === 0) throw new Error('Vault Catalog noteId must not be empty.');
    if (!Number.isFinite(Date.parse(openedAt))) {
      throw new Error('Vault Catalog openedAt must be an ISO timestamp.');
    }
    await this.ensureIdentity();
    await this.database.transaction('rw', this.meta, this.notes, async () => {
      const note = await this.notes.get(noteId);
      if (
        note === undefined ||
        (note.lastOpenedAt !== undefined && note.lastOpenedAt >= openedAt)
      ) {
        return;
      }
      await this.notes.put({
        ...note,
        activityAt: openedAt > note.lastAnnotatedAt ? openedAt : note.lastAnnotatedAt,
        lastOpenedAt: openedAt,
      });
      await this.bumpProjectionEpoch();
    });
  }

  async putSnapshotBinding(binding: CatalogSnapshotBinding): Promise<void> {
    await this.ensureIdentity();
    await this.snapshotBindings.put({
      ...binding,
      source: structuredClone(binding.source),
    });
  }

  async removeSnapshotBinding(noteId: string, annotationId: string): Promise<void> {
    await this.ensureIdentity();
    await this.snapshotBindings.delete([noteId, annotationId]);
  }

  async snapshotBindingsForNote(input: {
    readonly afterAnnotationId?: string;
    readonly limit?: number;
    readonly noteId: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly bindings: readonly CatalogSnapshotBinding[];
    readonly hasMore: boolean;
    readonly nextAnnotationId?: string;
  }> {
    const limit = validatedLimit(
      input.limit ?? VAULT_CATALOG_LIMITS.bindingBatch,
      VAULT_CATALOG_LIMITS.bindingBatch,
      'Snapshot binding',
    );
    throwIfAborted(input.signal);
    await this.ensureIdentity();
    const lower = [input.noteId, input.afterAnnotationId ?? Dexie.minKey];
    const rows = await this.snapshotBindings
      .where('[noteId+annotationId]')
      .between(lower, [input.noteId, Dexie.maxKey], input.afterAnnotationId === undefined, true)
      .limit(limit + 1)
      .toArray();
    throwIfAborted(input.signal);
    const bindings = rows
      .slice(0, limit)
      .map((binding) => Object.freeze({ ...binding, source: structuredClone(binding.source) }));
    const hasMore = rows.length > limit;
    const nextAnnotationId = hasMore ? bindings.at(-1)?.annotationId : undefined;
    return Object.freeze({
      bindings: Object.freeze(bindings),
      hasMore,
      ...(nextAnnotationId === undefined ? {} : { nextAnnotationId }),
    });
  }

  async readEntry(noteId: string, annotationId: string): Promise<CatalogEntry | null> {
    await this.ensureIdentity();
    const row = await this.entries
      .where('[noteId+annotationId]')
      .equals([noteId, annotationId])
      .first();
    return row === undefined ? null : toCatalogEntry(row);
  }

  async updateDerivedSnapshotEntries(entries: readonly CatalogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    if (entries.length > VAULT_CATALOG_LIMITS.bindingBatch) {
      throw new Error('Vault Catalog Snapshot link update exceeds the 100-row batch limit.');
    }
    const noteId = entries[0]?.noteId;
    if (noteId === undefined || entries.some((entry) => entry.noteId !== noteId)) {
      throw new Error('Vault Catalog Snapshot link update crosses note boundaries.');
    }
    await this.ensureIdentity();
    await this.database.transaction('rw', this.entries, this.meta, this.notes, async () => {
      const note = await this.notes.get(noteId);
      let problemDelta = 0;
      let changed = false;
      for (const entry of entries) {
        const existing = await this.entries
          .where('[noteId+annotationId]')
          .equals([entry.noteId, entry.annotationId])
          .first();
        if (
          existing === undefined ||
          existing.rowId === undefined ||
          existing.type !== 'snapshot' ||
          existing.revision !== entry.revision ||
          sameCatalogEntry(existing, entry)
        ) {
          continue;
        }
        problemDelta += problemValue(entry) - problemValue(existing);
        await this.entries.put({ ...copyEntryForStorage(entry), rowId: existing.rowId });
        changed = true;
      }
      if (!changed) return;
      if (note !== undefined && problemDelta !== 0) {
        await this.notes.put({ ...note, problemCount: note.problemCount + problemDelta });
      }
      await this.bumpProjectionEpoch();
    });
  }

  async removeEntry(input: {
    readonly annotationId: string;
    readonly maximumRevision: number;
    readonly noteId: string;
  }): Promise<'missing' | 'removed' | 'stale'> {
    await this.ensureIdentity();
    return this.database.transaction('rw', this.entries, this.meta, this.notes, async () => {
      const existing = await this.entries
        .where('[noteId+annotationId]')
        .equals([input.noteId, input.annotationId])
        .first();
      if (existing === undefined || existing.rowId === undefined) return 'missing';
      if (existing.revision > input.maximumRevision) return 'stale';
      await this.entries.delete(existing.rowId);
      const note = await this.notes.get(input.noteId);
      if (note !== undefined) {
        if (note.annotationCount <= 1) {
          await this.notes.delete(input.noteId);
        } else {
          const latest = await this.entries
            .where('[noteId+updatedAt+rowId]')
            .between(
              [input.noteId, Dexie.minKey, Dexie.minKey],
              [input.noteId, Dexie.maxKey, Dexie.maxKey],
            )
            .reverse()
            .first();
          const subtract = typeCounts(existing);
          const lastAnnotatedAt = latest?.updatedAt ?? note.lastAnnotatedAt;
          await this.notes.put({
            ...note,
            activityAt:
              note.lastOpenedAt !== undefined && note.lastOpenedAt > lastAnnotatedAt
                ? note.lastOpenedAt
                : lastAnnotatedAt,
            annotationCount: note.annotationCount - 1,
            conflictCount: note.conflictCount - existing.conflict,
            lastAnnotatedAt,
            legacyInkCount: note.legacyInkCount - subtract.legacyInk,
            problemCount: note.problemCount - problemValue(existing),
            snapshotCount: note.snapshotCount - subtract.snapshot,
            textCount: note.textCount - subtract.text,
          });
        }
      }
      await this.bumpProjectionEpoch();
      return 'removed';
    });
  }

  async replaceNoteProjection(input: {
    readonly bindings?: readonly CatalogSnapshotBinding[];
    readonly entries: readonly CatalogEntry[];
    readonly noteId: string;
  }): Promise<void> {
    if (input.entries.some((entry) => entry.noteId !== input.noteId)) {
      throw new Error('Vault Catalog note projection contains a row from another note.');
    }
    if (input.bindings?.some((binding) => binding.noteId !== input.noteId) === true) {
      throw new Error('Vault Catalog note projection contains a binding from another note.');
    }
    await this.ensureIdentity();
    await this.database.transaction(
      'rw',
      this.entries,
      this.meta,
      this.notes,
      this.snapshotBindings,
      async () => {
        const previousNote = await this.notes.get(input.noteId);
        await this.entries.where('noteId').equals(input.noteId).delete();
        await this.snapshotBindings.where('noteId').equals(input.noteId).delete();
        if (input.entries.length === 0) {
          await this.notes.delete(input.noteId);
        } else {
          await this.entries.bulkAdd(input.entries.map(copyEntryForStorage));
          await this.notes.put(aggregateNote(input.entries, previousNote?.lastOpenedAt));
        }
        if (input.bindings !== undefined && input.bindings.length > 0) {
          await this.snapshotBindings.bulkPut(
            input.bindings.map((binding) => ({
              ...binding,
              source: structuredClone(binding.source),
            })),
          );
        }
        await this.bumpProjectionEpoch();
      },
    );
  }

  async isInitialized(): Promise<boolean> {
    await this.ensureIdentity();
    return (await this.meta.get('initialized'))?.value === true;
  }

  async setInitialized(initialized: boolean): Promise<void> {
    await this.ensureIdentity();
    await this.meta.put({ key: 'initialized', value: initialized });
  }

  async setFreshness(freshness: CatalogFreshness): Promise<void> {
    await this.ensureIdentity();
    await this.meta.put({ key: 'freshness', value: freshness });
  }

  async removeNote(noteId: string): Promise<void> {
    await this.ensureIdentity();
    await this.database.transaction(
      'rw',
      this.entries,
      this.meta,
      this.notes,
      this.snapshotBindings,
      async () => {
        const existing = await this.notes.get(noteId);
        if (existing === undefined) return;
        await Promise.all([
          this.entries.where('noteId').equals(noteId).delete(),
          this.snapshotBindings.where('noteId').equals(noteId).delete(),
          this.notes.delete(noteId),
        ]);
        await this.bumpProjectionEpoch();
      },
    );
  }

  async removeFile(filePath: string): Promise<void> {
    await this.ensureIdentity();
    const note = await this.notes.where('filePath').equals(filePath).first();
    if (note !== undefined) await this.removeNote(note.noteId);
  }

  async removeNotesNotIn(noteIds: ReadonlySet<string>): Promise<void> {
    await this.ensureIdentity();
    let afterNoteId: string | undefined;
    while (true) {
      const rows = await (afterNoteId === undefined
        ? this.notes.orderBy('noteId').limit(VAULT_CATALOG_LIMITS.scanBatch).toArray()
        : this.notes
            .where('noteId')
            .above(afterNoteId)
            .limit(VAULT_CATALOG_LIMITS.scanBatch)
            .toArray());
      if (rows.length === 0) return;
      for (const row of rows) {
        if (!noteIds.has(row.noteId)) await this.removeNote(row.noteId);
      }
      afterNoteId = rows.at(-1)?.noteId;
      if (rows.length < VAULT_CATALOG_LIMITS.scanBatch || afterNoteId === undefined) return;
    }
  }

  async entriesForNote(input: {
    readonly cursor?: CatalogCursor;
    readonly limit?: number;
    readonly noteId: string;
    readonly signal?: AbortSignal;
  }): Promise<CatalogEntryPage> {
    const limit = validatedLimit(input.limit ?? 30, VAULT_CATALOG_LIMITS.entryPage, 'entry page');
    if (input.noteId.length === 0) throw new Error('Vault Catalog noteId must not be empty.');
    throwIfAborted(input.signal);
    await this.ensureIdentity();
    const meta = await this.resultMeta();
    const decoded =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor, 'note', input.noteId);
    if (decoded !== undefined && decoded.projectionEpoch !== meta.projectionEpoch) {
      return Object.freeze({
        entries: Object.freeze([]),
        hasMore: false,
        meta,
        state: 'superseded',
      });
    }
    const lower: [string, number, number] =
      decoded === undefined
        ? [input.noteId, Dexie.minKey, Dexie.minKey]
        : asNoteCursorKey(decoded.lastKey);
    const rows = await this.entries
      .where('[noteId+position+rowId]')
      .between(lower, [input.noteId, Dexie.maxKey, Dexie.maxKey], decoded === undefined, true)
      .limit(limit + 1)
      .toArray();
    throwIfAborted(input.signal);
    const currentMeta = await this.resultMeta();
    if (currentMeta.projectionEpoch !== meta.projectionEpoch) {
      return Object.freeze({
        entries: Object.freeze([]),
        hasMore: false,
        meta: currentMeta,
        state: 'superseded',
      });
    }
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    const hasMore = rows.length > limit;
    const nextCursor =
      hasMore && last?.rowId !== undefined
        ? encodeCursor({
            kind: 'note',
            lastKey: [last.noteId, last.position, last.rowId],
            projectionEpoch: meta.projectionEpoch,
            queryDigest: input.noteId,
            schemaVersion: 1,
          })
        : undefined;
    return Object.freeze({
      entries: Object.freeze(pageRows.map(toCatalogEntry)),
      hasMore,
      meta,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      state: 'ready',
    });
  }

  async search(input: {
    readonly cursor?: CatalogCursor;
    readonly filters?: VaultCatalogFilters;
    readonly limit?: number;
    readonly signal?: AbortSignal;
    readonly text: string;
  }): Promise<VaultCatalogSearchPage> {
    const limit = validatedLimit(input.limit ?? 30, VAULT_CATALOG_LIMITS.searchPage, 'search page');
    throwIfAborted(input.signal);
    await this.ensureIdentity();
    const needle = normalizeSearch(input.text);
    const queryDigest = JSON.stringify({ filters: input.filters ?? null, text: needle });
    const initialMeta = await this.resultMeta();
    const decoded =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor, 'search', queryDigest);
    if (decoded !== undefined && decoded.projectionEpoch !== initialMeta.projectionEpoch) {
      return supersededSearchPage(initialMeta, 0);
    }

    const matches: CatalogEntryRow[] = [];
    let lastScannedKey = decoded === undefined ? undefined : asSearchCursorKey(decoded.lastKey);
    let scanned = 0;
    let hasMore = false;
    while (matches.length < limit) {
      throwIfAborted(input.signal);
      const batch = await (lastScannedKey === undefined
        ? this.entries
            .orderBy('[updatedAt+rowId]')
            .reverse()
            .limit(VAULT_CATALOG_LIMITS.scanBatch)
            .toArray()
        : this.entries
            .where('[updatedAt+rowId]')
            .below(lastScannedKey)
            .reverse()
            .limit(VAULT_CATALOG_LIMITS.scanBatch)
            .toArray());
      if (batch.length === 0) {
        hasMore = false;
        break;
      }
      for (const row of batch) {
        if (row.rowId === undefined) throw new Error('Vault Catalog entry row is missing rowId.');
        lastScannedKey = [row.updatedAt, row.rowId];
        scanned += 1;
        if (
          (needle.length === 0 || row.searchTextNormalized.includes(needle)) &&
          matchesFilters(row, input.filters)
        ) {
          matches.push(row);
          if (matches.length === limit) {
            const hasUnconsumedRows = row !== batch.at(-1);
            hasMore = hasUnconsumedRows || batch.length === VAULT_CATALOG_LIMITS.scanBatch;
            break;
          }
        }
      }
      if (matches.length === limit) break;
      hasMore = batch.length === VAULT_CATALOG_LIMITS.scanBatch;
      if (!hasMore) break;
      const currentMeta = await this.resultMeta();
      if (currentMeta.projectionEpoch !== initialMeta.projectionEpoch) {
        return supersededSearchPage(currentMeta, scanned);
      }
      await this.yieldControl();
    }
    throwIfAborted(input.signal);
    const currentMeta = await this.resultMeta();
    if (currentMeta.projectionEpoch !== initialMeta.projectionEpoch) {
      return supersededSearchPage(currentMeta, scanned);
    }
    const nextCursor =
      hasMore && lastScannedKey !== undefined
        ? encodeCursor({
            kind: 'search',
            lastKey: lastScannedKey,
            projectionEpoch: initialMeta.projectionEpoch,
            queryDigest,
            schemaVersion: 1,
          })
        : undefined;
    return Object.freeze({
      entries: Object.freeze(matches.map(toCatalogEntry)),
      hasMore,
      meta: currentMeta,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      progress: Object.freeze({ exhaustive: !hasMore, scanned }),
      state: 'ready',
    });
  }

  async suggestFacet(input: {
    readonly facet: 'folder' | 'note' | 'tag';
    readonly limit?: number;
    readonly prefix: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly FacetSuggestion[]> {
    const limit = validatedLimit(
      input.limit ?? VAULT_CATALOG_LIMITS.suggestionPage,
      VAULT_CATALOG_LIMITS.suggestionPage,
      'facet suggestion',
    );
    throwIfAborted(input.signal);
    await this.ensureIdentity();
    const normalizedPrefix = normalizeSearch(input.prefix);
    if (normalizedPrefix.length === 0) return Object.freeze([]);
    if (input.facet === 'note') {
      const rows = await this.notes
        .where('titleNormalized')
        .startsWith(normalizedPrefix)
        .limit(limit)
        .toArray();
      return Object.freeze(
        rows.map((row) => Object.freeze({ label: row.filePath, value: row.noteId })),
      );
    }
    const rows = await this.entries
      .where(input.facet === 'folder' ? 'folder' : 'tagsNormalized')
      .startsWith(input.facet === 'folder' ? input.prefix : normalizedPrefix)
      .limit(VAULT_CATALOG_LIMITS.scanBatch)
      .toArray();
    throwIfAborted(input.signal);
    const values = new Set<string>();
    for (const row of rows) {
      if (input.facet === 'folder') {
        if (row.folder.startsWith(input.prefix)) values.add(row.folder);
      } else {
        row.tags.forEach((tag, index) => {
          if (row.tagsNormalized[index]?.startsWith(normalizedPrefix) === true) values.add(tag);
        });
      }
      if (values.size >= limit) break;
    }
    return Object.freeze(
      [...values].slice(0, limit).map((value) => Object.freeze({ label: value, value })),
    );
  }

  close(): void {
    this.database.close();
  }

  private async bumpProjectionEpoch(): Promise<void> {
    const row = await this.meta.get('projectionEpoch');
    const current = typeof row?.value === 'number' ? row.value : 0;
    await this.meta.put({ key: 'projectionEpoch', value: current + 1 });
  }

  private async ensureIdentity(): Promise<void> {
    await this.database.open();
    const fingerprint = await this.meta.get('vaultFingerprint');
    if (fingerprint !== undefined && fingerprint.value !== this.vaultFingerprint) {
      this.database.close();
      throw new VaultCatalogIdentityMismatchError();
    }
    if (fingerprint === undefined) {
      await this.database.transaction('rw', this.meta, async () => {
        const concurrent = await this.meta.get('vaultFingerprint');
        if (concurrent !== undefined && concurrent.value !== this.vaultFingerprint) {
          throw new VaultCatalogIdentityMismatchError();
        }
        if (concurrent === undefined) {
          await this.meta.bulkPut([
            { key: 'cleanShutdown', value: false },
            { key: 'databaseGeneration', value: 1 },
            { key: 'freshness', value: 'current' satisfies CatalogFreshness },
            { key: 'initialized', value: false },
            { key: 'lastCompletedReconcileAt', value: '' },
            { key: 'lastCompletedReconcileEpoch', value: 0 },
            { key: 'projectionEpoch', value: 0 },
            { key: 'reconcileState', value: 'idle' },
            { key: 'schemaVersion', value: 1 },
            { key: 'vaultFingerprint', value: this.vaultFingerprint },
          ]);
        }
      });
    }
  }

  private async resultMeta(): Promise<CatalogResultMeta> {
    const [freshness, projectionEpoch] = await Promise.all([
      this.meta.get('freshness'),
      this.meta.get('projectionEpoch'),
    ]);
    return Object.freeze({
      freshness: isFreshness(freshness?.value) ? freshness.value : 'stale',
      projectionEpoch: typeof projectionEpoch?.value === 'number' ? projectionEpoch.value : 0,
    });
  }
}

function updateNote(
  current: CatalogNoteRow | undefined,
  existing: CatalogEntryRow | undefined,
  entry: CatalogEntryRow,
): CatalogNoteRow {
  const counts = current ?? emptyNote(entry);
  const adding = existing === undefined;
  const subtractExisting = adding ? emptyTypeCounts() : typeCounts(existing);
  const addEntry = adding ? typeCounts(entry) : typeCounts(entry);
  const conflictCount = counts.conflictCount - (existing?.conflict ?? 0) + entry.conflict;
  const problemCount =
    counts.problemCount -
    (existing === undefined ? 0 : problemValue(existing)) +
    problemValue(entry);
  const lastAnnotatedAt =
    entry.updatedAt > counts.lastAnnotatedAt ? entry.updatedAt : counts.lastAnnotatedAt;
  return {
    ...counts,
    activityAt:
      counts.lastOpenedAt !== undefined && counts.lastOpenedAt > lastAnnotatedAt
        ? counts.lastOpenedAt
        : lastAnnotatedAt,
    annotationCount: counts.annotationCount + (adding ? 1 : 0),
    conflictCount,
    filePath: entry.filePath,
    folder: entry.folder,
    lastAnnotatedAt,
    legacyInkCount: counts.legacyInkCount - subtractExisting.legacyInk + addEntry.legacyInk,
    noteId: entry.noteId,
    problemCount,
    snapshotCount: counts.snapshotCount - subtractExisting.snapshot + addEntry.snapshot,
    textCount: counts.textCount - subtractExisting.text + addEntry.text,
    title: noteTitle(entry.filePath),
    titleNormalized: normalizeSearch(noteTitle(entry.filePath)),
  };
}

function copyEntryForStorage(entry: CatalogEntry): CatalogEntryRow {
  return {
    ...entry,
    ...(entry.headingPath === undefined ? {} : { headingPath: [...entry.headingPath] }),
    tags: [...entry.tags],
    tagsNormalized: [...entry.tagsNormalized],
  };
}

function aggregateNote(
  entries: readonly CatalogEntry[],
  lastOpenedAt: string | undefined,
): CatalogNoteRow {
  const first = entries[0];
  if (first === undefined) throw new Error('Cannot aggregate an empty Vault Catalog note.');
  let conflictCount = 0;
  let legacyInkCount = 0;
  let problemCount = 0;
  let snapshotCount = 0;
  let textCount = 0;
  let lastAnnotatedAt = first.updatedAt;
  for (const entry of entries) {
    if (entry.filePath !== first.filePath) {
      throw new Error('Vault Catalog note projection contains multiple file paths.');
    }
    conflictCount += entry.conflict;
    legacyInkCount += entry.type === 'ink' ? 1 : 0;
    snapshotCount += entry.type === 'snapshot' ? 1 : 0;
    textCount += entry.type === 'ink' || entry.type === 'snapshot' ? 0 : 1;
    problemCount += problemValue(entry);
    if (entry.updatedAt > lastAnnotatedAt) lastAnnotatedAt = entry.updatedAt;
  }
  const title = noteTitle(first.filePath);
  return {
    activityAt:
      lastOpenedAt !== undefined && lastOpenedAt > lastAnnotatedAt ? lastOpenedAt : lastAnnotatedAt,
    annotationCount: entries.length,
    conflictCount,
    filePath: first.filePath,
    folder: first.folder,
    lastAnnotatedAt,
    ...(lastOpenedAt === undefined ? {} : { lastOpenedAt }),
    legacyInkCount,
    noteId: first.noteId,
    problemCount,
    snapshotCount,
    textCount,
    title,
    titleNormalized: normalizeSearch(title),
  };
}

function emptyNote(entry: CatalogEntryRow): CatalogNoteRow {
  const title = noteTitle(entry.filePath);
  return {
    activityAt: entry.updatedAt,
    annotationCount: 0,
    conflictCount: 0,
    filePath: entry.filePath,
    folder: entry.folder,
    lastAnnotatedAt: entry.updatedAt,
    legacyInkCount: 0,
    noteId: entry.noteId,
    problemCount: 0,
    snapshotCount: 0,
    textCount: 0,
    title,
    titleNormalized: normalizeSearch(title),
  };
}

function emptyTypeCounts(): {
  readonly legacyInk: number;
  readonly snapshot: number;
  readonly text: number;
} {
  return { legacyInk: 0, snapshot: 0, text: 0 };
}

function typeCounts(entry: CatalogEntryRow): {
  readonly legacyInk: number;
  readonly snapshot: number;
  readonly text: number;
} {
  return {
    legacyInk: entry.type === 'ink' ? 1 : 0,
    snapshot: entry.type === 'snapshot' ? 1 : 0,
    text: entry.type === 'ink' || entry.type === 'snapshot' ? 0 : 1,
  };
}

function problemValue(entry: CatalogEntryRow): number {
  return entry.status === 'unanchored' ||
    entry.status === 'needs-rebase' ||
    entry.linkState === 'source-changed' ||
    entry.linkState === 'unanchored'
    ? 1
    : 0;
}

function toNoteSummary(row: CatalogNoteRow): CatalogNoteSummary {
  const { titleNormalized, ...summary } = row;
  void titleNormalized;
  return Object.freeze(summary);
}

function toCatalogEntry(row: CatalogEntryRow): CatalogEntry {
  const { rowId, ...entry } = row;
  void rowId;
  return Object.freeze({
    ...entry,
    ...(entry.headingPath === undefined
      ? {}
      : { headingPath: Object.freeze([...entry.headingPath]) }),
    tags: Object.freeze([...entry.tags]),
    tagsNormalized: Object.freeze([...entry.tagsNormalized]),
  });
}

function sameCatalogEntry(left: CatalogEntryRow, right: CatalogEntry): boolean {
  return JSON.stringify(toCatalogEntry(left)) === JSON.stringify(right);
}

interface DecodedCatalogCursor {
  readonly kind: 'note' | 'search';
  readonly lastKey: readonly [string, number] | readonly [string, number, number];
  readonly projectionEpoch: number;
  readonly queryDigest: string;
  readonly schemaVersion: 1;
}

function encodeCursor(cursor: DecodedCatalogCursor): CatalogCursor {
  return JSON.stringify(cursor) as CatalogCursor;
}

function decodeCursor(
  cursor: CatalogCursor,
  kind: DecodedCatalogCursor['kind'],
  queryDigest: string,
): DecodedCatalogCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    throw new Error('Vault Catalog cursor is invalid.');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('kind' in parsed) ||
    parsed.kind !== kind ||
    !('lastKey' in parsed) ||
    !Array.isArray(parsed.lastKey) ||
    (parsed.lastKey.length !== 2 && parsed.lastKey.length !== 3) ||
    typeof parsed.lastKey[0] !== 'string' ||
    typeof parsed.lastKey[1] !== 'number' ||
    (parsed.lastKey.length === 3 && typeof parsed.lastKey[2] !== 'number') ||
    !('projectionEpoch' in parsed) ||
    typeof parsed.projectionEpoch !== 'number' ||
    !('queryDigest' in parsed) ||
    parsed.queryDigest !== queryDigest ||
    !('schemaVersion' in parsed) ||
    parsed.schemaVersion !== 1
  ) {
    throw new Error('Vault Catalog cursor does not match this query.');
  }
  return parsed as unknown as DecodedCatalogCursor;
}

function asNoteCursorKey(key: DecodedCatalogCursor['lastKey']): [string, number, number] {
  if (key.length !== 3) throw new Error('Vault Catalog note cursor key is invalid.');
  return [key[0], key[1], key[2]];
}

function asSearchCursorKey(key: DecodedCatalogCursor['lastKey']): [string, number] {
  if (key.length !== 2) throw new Error('Vault Catalog search cursor key is invalid.');
  return [key[0], key[1]];
}

function supersededSearchPage(meta: CatalogResultMeta, scanned: number): VaultCatalogSearchPage {
  return Object.freeze({
    entries: Object.freeze([]),
    hasMore: false,
    meta,
    progress: Object.freeze({ exhaustive: false, scanned }),
    state: 'superseded',
  });
}

function matchesFilters(entry: CatalogEntryRow, filters: VaultCatalogFilters | undefined): boolean {
  if (filters === undefined) return true;
  const tags = new Set(entry.tagsNormalized);
  return (
    (filters.conflict === undefined || entry.conflict === (filters.conflict ? 1 : 0)) &&
    (filters.folders === undefined ||
      filters.folders.some(
        (folder) => entry.filePath === folder || entry.filePath.startsWith(`${folder}/`),
      )) &&
    (filters.noteIds === undefined || filters.noteIds.includes(entry.noteId)) &&
    (filters.statuses === undefined || filters.statuses.includes(entry.status)) &&
    (filters.styleIds === undefined ||
      (entry.styleId !== undefined && filters.styleIds.includes(entry.styleId))) &&
    (filters.tags === undefined || filters.tags.every((tag) => tags.has(normalizeSearch(tag)))) &&
    (filters.types === undefined || filters.types.includes(entry.type)) &&
    (filters.updatedAfter === undefined || entry.updatedAt >= filters.updatedAfter) &&
    (filters.updatedBefore === undefined || entry.updatedAt <= filters.updatedBefore)
  );
}

function noteTitle(filePath: string): string {
  const basename = filePath.slice(filePath.lastIndexOf('/') + 1);
  return basename.toLocaleLowerCase().endsWith('.md') ? basename.slice(0, -3) : basename;
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function validatedLimit(value: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Vault Catalog ${label} limit must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function isFreshness(value: unknown): value is CatalogFreshness {
  return value === 'current' || value === 'reconciling' || value === 'stale';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('Vault Catalog query was cancelled.', 'AbortError');
  }
}

export type { CatalogSourceRow, CatalogSnapshotBinding };
