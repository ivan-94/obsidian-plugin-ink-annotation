import { projectSnapshotSourceLink } from '../domain/snapshot-source-binding';
import {
  catalogEntryFromIndexEntry,
  indexEntryFromCatalogEntry,
  type CatalogEntry,
  type CatalogSnapshotBinding,
} from './vault-catalog';

export interface VaultCatalogMarkdownProjectionStore {
  readEntry(noteId: string, annotationId: string): Promise<CatalogEntry | null>;
  snapshotBindingsForNote(input: {
    readonly afterAnnotationId?: string;
    readonly limit?: number;
    readonly noteId: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly bindings: readonly CatalogSnapshotBinding[];
    readonly hasMore: boolean;
    readonly nextAnnotationId?: string;
  }>;
  updateDerivedSnapshotEntries(entries: readonly CatalogEntry[]): Promise<void>;
}

export class VaultCatalogMarkdownProjector {
  private readonly yieldControl: () => Promise<void>;

  constructor(
    private readonly store: VaultCatalogMarkdownProjectionStore,
    options: { readonly yieldControl?: () => Promise<void> } = {},
  ) {
    this.yieldControl = options.yieldControl ?? (() => Promise.resolve());
  }

  async apply(input: {
    readonly noteId: string;
    readonly source: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    let afterAnnotationId: string | undefined;
    do {
      throwIfAborted(input.signal);
      const page = await this.store.snapshotBindingsForNote({
        ...(afterAnnotationId === undefined ? {} : { afterAnnotationId }),
        limit: 100,
        noteId: input.noteId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const updates: CatalogEntry[] = [];
      for (const binding of page.bindings) {
        const entry = await this.store.readEntry(binding.noteId, binding.annotationId);
        if (entry === null || entry.type !== 'snapshot') continue;
        const link = projectSnapshotSourceLink(input.source, binding.source);
        const focus = link.anchors.find(({ focus }) => focus);
        updates.push(
          catalogEntryFromIndexEntry(
            indexEntryFromCatalogEntry({
              ...entry,
              linkState: link.state,
              position: focus?.start ?? binding.source.focus.position.start,
            }),
          ),
        );
      }
      await this.store.updateDerivedSnapshotEntries(updates);
      afterAnnotationId = page.nextAnnotationId;
      if (page.hasMore) await this.yieldControl();
    } while (afterAnnotationId !== undefined);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('Vault Catalog Markdown projection was cancelled.', 'AbortError');
  }
}
