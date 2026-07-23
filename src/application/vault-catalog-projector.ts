import {
  createSnapshotAnnotationIndexEntry,
  createSnapshotAnnotationSummaryFromIndexEntry,
} from '../domain/snapshot-annotation-summary';
import type { SnapshotAnnotationRecord } from '../domain/snapshot-annotation';
import { snapshotSummaryToIndexEntry } from '../domain/vault-annotation-index';
import {
  catalogEntryFromIndexEntry,
  type CatalogEntry,
  type CatalogSnapshotBinding,
} from './vault-catalog';

export interface VaultCatalogProjectionStore {
  putSnapshotBinding(binding: CatalogSnapshotBinding): Promise<void>;
  removeEntry(input: {
    readonly annotationId: string;
    readonly maximumRevision: number;
    readonly noteId: string;
  }): Promise<'missing' | 'removed' | 'stale'>;
  removeSnapshotBinding(noteId: string, annotationId: string): Promise<void>;
  upsertEntry(entry: CatalogEntry): Promise<'applied' | 'stale' | 'unchanged'>;
}

export class VaultCatalogProjector {
  constructor(
    private readonly input: {
      readonly catalog: VaultCatalogProjectionStore;
      readonly readMarkdown: (filePath: string) => Promise<string>;
    },
  ) {}

  async applySnapshotRecord(record: SnapshotAnnotationRecord): Promise<void> {
    if (record.deletedAt !== undefined) {
      await this.input.catalog.removeEntry({
        annotationId: record.id,
        maximumRevision: record.revision - 1,
        noteId: record.noteId,
      });
      await this.input.catalog.removeSnapshotBinding(record.noteId, record.id);
      return;
    }
    const source = await this.input.readMarkdown(record.filePath);
    const summary = createSnapshotAnnotationSummaryFromIndexEntry(
      createSnapshotAnnotationIndexEntry(record),
      source,
    );
    await this.input.catalog.upsertEntry(
      catalogEntryFromIndexEntry(snapshotSummaryToIndexEntry(summary, record.noteId)),
    );
    await this.input.catalog.putSnapshotBinding({
      annotationId: record.id,
      filePath: record.filePath,
      noteId: record.noteId,
      source: structuredClone(record.source),
      sourceRevision: record.source.sourceRevision,
    });
  }
}
