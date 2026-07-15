import type { AnnotationIndexEntry } from '../../domain/vault-annotation-index';

export interface CurrentBulkSelectionEntry {
  readonly body?: string;
  readonly expectedRevision: number;
  readonly filePath: string;
  readonly id: string;
  readonly key: string;
  readonly quote: string;
  readonly type: AnnotationIndexEntry['type'];
}

export interface CurrentBulkOutcome {
  readonly failed: readonly CurrentBulkSelectionEntry[];
}

export type CurrentBulkDialog =
  | { readonly entries: readonly CurrentBulkSelectionEntry[]; readonly kind: 'delete' }
  | { readonly entries: readonly CurrentBulkSelectionEntry[]; readonly kind: 'style' }
  | { readonly entries: readonly CurrentBulkSelectionEntry[]; readonly kind: 'tags' }
  | null;
