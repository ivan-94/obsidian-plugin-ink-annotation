import type { TextAnnotationRecord } from '../domain/text-annotation';
import type { AnnotationService } from './annotation-service';

export type DraftPersistenceState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved-locally' }
  | { readonly error: unknown; readonly kind: 'error'; readonly message: string };

interface DraftContents {
  readonly body: string;
  readonly mark?: TextAnnotationRecord['mark'];
  readonly tags: readonly string[];
}

export class AnnotationDraftSession {
  private contents: DraftContents;
  private dirty = false;
  private draft: TextAnnotationRecord;
  private flushPromise: Promise<void> | null = null;
  private readonly onStateChange: (state: DraftPersistenceState) => void;
  private readonly service: AnnotationService;
  private state: DraftPersistenceState = { kind: 'idle' };

  constructor(input: {
    readonly draft: TextAnnotationRecord;
    readonly onStateChange?: (state: DraftPersistenceState) => void;
    readonly service: AnnotationService;
  }) {
    this.draft = input.draft;
    this.onStateChange = input.onStateChange ?? (() => undefined);
    this.service = input.service;
    this.contents = {
      body: input.draft.body ?? '',
      ...(input.draft.mark === undefined ? {} : { mark: input.draft.mark }),
      tags: [...input.draft.tags],
    };
  }

  snapshot(): DraftPersistenceState {
    return this.state;
  }

  update(patch: Partial<DraftContents>): void {
    this.contents = {
      body: patch.body ?? this.contents.body,
      ...((patch.mark ?? this.contents.mark) === undefined
        ? {}
        : { mark: patch.mark ?? this.contents.mark }),
      tags: patch.tags === undefined ? this.contents.tags : [...patch.tags],
    };
    this.dirty = true;
    this.setState({ kind: 'idle' });
  }

  async flush(): Promise<void> {
    if (this.flushPromise !== null) {
      await this.flushPromise;
      if (this.dirty) {
        await this.flush();
      }
      return;
    }
    if (!this.dirty) {
      return;
    }

    this.flushPromise = this.persistCurrentContents();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
    if (this.dirty) {
      await this.flush();
    }
  }

  async close(): Promise<void> {
    await this.flush();
    if (isEmptyDraft(this.draft)) {
      await this.service.discardEmptyDraft(this.draft);
    }
  }

  private async persistCurrentContents(): Promise<void> {
    const contents = this.contents;
    this.dirty = false;
    this.setState({ kind: 'saving' });
    try {
      this.draft = await this.service.saveDraft(this.draft, contents);
      this.setState(this.dirty ? { kind: 'idle' } : { kind: 'saved-locally' });
    } catch (error) {
      this.dirty = true;
      this.setState({
        error,
        kind: 'error',
        message: "Couldn't save locally.",
      });
      throw error;
    }
  }

  private setState(state: DraftPersistenceState): void {
    this.state = state;
    this.onStateChange(state);
  }
}

function isEmptyDraft(record: TextAnnotationRecord): boolean {
  return (
    record.status === 'draft' &&
    record.mark === undefined &&
    (record.body === undefined || record.body.trim().length === 0) &&
    record.tags.length === 0
  );
}
