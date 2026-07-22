import type { SnapshotAnnotationRecord } from '../domain/snapshot-annotation';

export interface SnapshotAnnotationDraft {
  readonly draftKey: string;
  readonly isNew: boolean;
  readonly pngBytes: Uint8Array;
  readonly record: SnapshotAnnotationRecord;
  readonly savedAt: string;
}

/** One replaceable best-effort device-local draft per Snapshot; never a Vault commit. */
export interface SnapshotAnnotationDraftStore {
  discard(draftKey: string): Promise<void>;
  load(draftKey: string): Promise<SnapshotAnnotationDraft | null>;
  loadLatest(filePath: string): Promise<SnapshotAnnotationDraft | null>;
  replace(draft: SnapshotAnnotationDraft): Promise<void>;
}
