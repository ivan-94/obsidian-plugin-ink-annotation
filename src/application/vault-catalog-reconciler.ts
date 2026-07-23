import type { InkSurfaceSummary } from '../domain/ink-surface-summary';
import {
  createSnapshotAnnotationIndexEntry,
  createSnapshotAnnotationSummaryFromIndexEntry,
} from '../domain/snapshot-annotation-summary';
import type { SnapshotAnnotationRecord } from '../domain/snapshot-annotation';
import type { TextAnnotationRecord } from '../domain/text-annotation';
import {
  inkSummaryToIndexEntry,
  snapshotSummaryToIndexEntry,
  textRecordToIndexEntry,
} from '../domain/vault-annotation-index';
import type { NoteMeta, RepositoryConflict, RepositoryIssue } from '../storage/sidecar-repository';
import {
  catalogEntryFromIndexEntry,
  type CatalogEntry,
  type CatalogFreshness,
  type CatalogSnapshotBinding,
} from './vault-catalog';

export interface VaultCatalogCanonicalSource {
  isSourceAvailable?(filePath: string): boolean;
  listAnnotations(filePath: string): Promise<{
    readonly conflicts: readonly RepositoryConflict[];
    readonly issues: readonly RepositoryIssue[];
    readonly records: readonly TextAnnotationRecord[];
  }>;
  listNotes(): Promise<{
    readonly issues: readonly RepositoryIssue[];
    readonly notes: readonly NoteMeta[];
  }>;
  readNoteMeta(filePath: string): Promise<NoteMeta | null>;
  listSnapshotRecords(filePath: string): Promise<readonly SnapshotAnnotationRecord[]>;
  listSurfaceSummaries(filePath: string): Promise<readonly InkSurfaceSummary[]>;
  readMarkdown(filePath: string): Promise<string>;
}

export interface VaultCatalogReconcileStore {
  isInitialized(): Promise<boolean>;
  removeNote(noteId: string): Promise<void>;
  removeFile(filePath: string): Promise<void>;
  removeNotesNotIn(noteIds: ReadonlySet<string>): Promise<void>;
  replaceNoteProjection(input: {
    readonly bindings?: readonly CatalogSnapshotBinding[];
    readonly entries: readonly CatalogEntry[];
    readonly noteId: string;
  }): Promise<void>;
  setFreshness(freshness: CatalogFreshness): Promise<void>;
  setInitialized(initialized: boolean): Promise<void>;
}

export class VaultCatalogReconciler {
  private readonly onIssue: (error: unknown) => void;
  private readonly styleName: (styleId: string) => string | undefined;
  private readonly yieldControl: () => Promise<void>;

  constructor(
    private readonly input: {
      readonly onIssue?: (error: unknown) => void;
      readonly source: VaultCatalogCanonicalSource;
      readonly styleName?: (styleId: string) => string | undefined;
      readonly yieldControl?: () => Promise<void>;
    },
  ) {
    this.onIssue = input.onIssue ?? (() => undefined);
    this.styleName = input.styleName ?? (() => undefined);
    this.yieldControl = input.yieldControl ?? (() => Promise.resolve());
  }

  async ensureInitialized(store: VaultCatalogReconcileStore, signal?: AbortSignal): Promise<void> {
    if (await store.isInitialized()) return;
    await this.reconcile(store, signal);
  }

  async reconcile(store: VaultCatalogReconcileStore, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await store.setFreshness('reconciling');
    try {
      const discovered = await this.input.source.listNotes();
      discovered.issues.forEach(this.onIssue);
      const discoveredNoteIds = new Set(discovered.notes.map(({ noteId }) => noteId));
      for (const note of discovered.notes) {
        throwIfAborted(signal);
        if (
          note.sourceMissingAt !== undefined ||
          !(this.input.source.isSourceAvailable?.(note.filePath) ?? true)
        ) {
          await store.removeNote(note.noteId);
        } else {
          await store.replaceNoteProjection(await this.projectNote(note));
        }
        await this.yieldControl();
      }
      await store.removeNotesNotIn(discoveredNoteIds);
      await store.setInitialized(true);
      await store.setFreshness('current');
    } catch (error) {
      await store.setFreshness('stale').catch(this.onIssue);
      throw error;
    }
  }

  async reconcileFiles(
    store: VaultCatalogReconcileStore,
    filePaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!(await store.isInitialized())) {
      await this.reconcile(store, signal);
      return;
    }
    await store.setFreshness('reconciling');
    try {
      for (const filePath of new Set(filePaths)) {
        throwIfAborted(signal);
        const note = await this.input.source.readNoteMeta(filePath);
        if (note === null) {
          await store.removeFile(filePath);
          continue;
        }
        if (
          note.sourceMissingAt !== undefined ||
          !(this.input.source.isSourceAvailable?.(note.filePath) ?? true)
        ) {
          await store.removeNote(note.noteId);
        } else {
          await store.replaceNoteProjection(await this.projectNote(note));
        }
        await this.yieldControl();
      }
      await store.setFreshness('current');
    } catch (error) {
      await store.setFreshness('stale').catch(this.onIssue);
      throw error;
    }
  }

  private async projectNote(note: NoteMeta): Promise<{
    readonly bindings: readonly CatalogSnapshotBinding[];
    readonly entries: readonly CatalogEntry[];
    readonly noteId: string;
  }> {
    const [text, ink, snapshots] = await Promise.all([
      this.input.source.listAnnotations(note.filePath),
      this.input.source.listSurfaceSummaries(note.filePath),
      this.input.source.listSnapshotRecords(note.filePath),
    ]);
    text.issues.forEach(this.onIssue);
    const divergentIds = new Set(
      text.conflicts
        .filter(({ kind }) => kind === 'same-revision-divergence')
        .map(({ annotationId }) => annotationId),
    );
    const entries: CatalogEntry[] = [];
    for (const record of text.records) {
      if (record.deletedAt !== undefined) continue;
      const styleName = record.mark === undefined ? undefined : this.styleName(record.mark.styleId);
      entries.push(
        catalogEntryFromIndexEntry(
          textRecordToIndexEntry(record, {
            conflict: divergentIds.has(record.id),
            ...(styleName === undefined ? {} : { styleName }),
          }),
        ),
      );
    }
    for (const summary of ink) {
      if (summary.deletedAt !== undefined || summary.strokeCount === 0) continue;
      entries.push(catalogEntryFromIndexEntry(inkSummaryToIndexEntry(summary, note.noteId)));
    }
    const activeSnapshots = snapshots.filter(({ deletedAt }) => deletedAt === undefined);
    const source =
      activeSnapshots.length === 0 ? null : await this.input.source.readMarkdown(note.filePath);
    const bindings: CatalogSnapshotBinding[] = [];
    if (source !== null) {
      for (const record of activeSnapshots) {
        const summary = createSnapshotAnnotationSummaryFromIndexEntry(
          createSnapshotAnnotationIndexEntry(record),
          source,
        );
        entries.push(
          catalogEntryFromIndexEntry(snapshotSummaryToIndexEntry(summary, record.noteId)),
        );
        bindings.push({
          annotationId: record.id,
          filePath: record.filePath,
          noteId: record.noteId,
          source: structuredClone(record.source),
          sourceRevision: record.source.sourceRevision,
        });
      }
    }
    return { bindings, entries, noteId: note.noteId };
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('Vault Catalog reconciliation was cancelled.', 'AbortError');
  }
}
