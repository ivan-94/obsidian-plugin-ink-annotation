import type { InkSurfaceRecord } from '../domain/ink-surface';

export interface InkDocumentDraft {
  readonly noteKey: string;
  readonly revision: number;
  readonly snapshot: InkSurfaceRecord;
}

/** One replaceable best-effort document snapshot per note; never a canonical commit log. */
export interface InkDocumentDraftStore {
  discard(noteKey: string): Promise<void>;
  load(noteKey: string): Promise<InkDocumentDraft | null>;
  replace(draft: InkDocumentDraft): Promise<void>;
}
