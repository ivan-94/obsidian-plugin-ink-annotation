import type { InkDocumentCommand } from './ink-document-session';

export type InkDraftAddCommand = Extract<InkDocumentCommand, { readonly kind: 'add' }>;

export interface InkDraftOperation {
  /**
   * Draft v1 intentionally protects completed drawing Adds only. Relative editing commands cannot
   * be reconciled idempotently after a crash that lands the sidecar but not the Draft deletion.
   */
  readonly command: InkDraftAddCommand;
  readonly noteKey: string;
  readonly revision: number;
}

/** Best-effort device-local protection; never a Live Document commit prerequisite. */
export interface InkDraftStore {
  enqueue(operation: InkDraftOperation): Promise<void>;
  load(noteKey: string): Promise<readonly InkDraftOperation[]>;
  discardThrough(noteKey: string, revision: number): Promise<void>;
}
