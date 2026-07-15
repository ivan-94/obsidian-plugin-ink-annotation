import type { AnnotationIndexEntry } from '../../domain/vault-annotation-index';

export interface BulkSelectionSnapshot {
  readonly expectedRevision: number;
  readonly filePath: string;
  readonly id: string;
  readonly noteId: string;
  readonly type: AnnotationIndexEntry['type'];
}

export interface BulkOutcome {
  readonly failed: readonly BulkSelectionSnapshot[];
}

export type SelectOption = readonly [value: string, label: string];

export type VaultBulkDialog =
  | { readonly kind: 'delete'; readonly selection: readonly BulkSelectionSnapshot[] }
  | { readonly kind: 'style'; readonly selection: readonly BulkSelectionSnapshot[] }
  | { readonly kind: 'tags'; readonly selection: readonly BulkSelectionSnapshot[] }
  | null;

export function toBulkSnapshot(entry: AnnotationIndexEntry): BulkSelectionSnapshot {
  return {
    expectedRevision: entry.revision,
    filePath: entry.filePath,
    id: entry.id,
    noteId: entry.noteId,
    type: entry.type,
  };
}

export function vaultEntryKey(entry: Pick<AnnotationIndexEntry, 'id' | 'noteId'>): string {
  return `${entry.noteId}\u0000${entry.id}`;
}
