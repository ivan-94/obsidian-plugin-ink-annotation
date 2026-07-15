import {
  AnnotationDraftSession,
  type DraftPersistenceState,
} from '../application/annotation-draft-session';
import type { AnnotationService } from '../application/annotation-service';
import type { TextAnnotationRecord } from '../domain/text-annotation';

export type NoteComposerLayout = 'anchored' | 'bottom-sheet';

export class NoteComposer {
  private readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
  private closing: Promise<void> | null = null;
  private readonly document: Document;
  private readonly draft: TextAnnotationRecord;
  private element: HTMLDivElement | null = null;
  private readonly layout: NoteComposerLayout;
  private readonly onClose: () => void;
  private readonly onIssue: (error: unknown) => void;
  private readonly session: AnnotationDraftSession;
  private statusElement: HTMLSpanElement | null = null;
  private retryButton: HTMLButtonElement | null = null;
  private readonly handlePageHide = (): void => {
    void this.flush();
  };
  private readonly handleWindowBlur = (): void => {
    void this.flush();
  };
  private readonly handleVisibilityChange = (): void => {
    if (this.document.visibilityState === 'hidden') {
      void this.flush();
    }
  };

  constructor(input: {
    readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
    readonly document: Document;
    readonly draft: TextAnnotationRecord;
    readonly layout: NoteComposerLayout;
    readonly onClose?: () => void;
    readonly onIssue?: (error: unknown) => void;
    readonly service: AnnotationService;
  }) {
    this.anchorRect = input.anchorRect;
    this.document = input.document;
    this.draft = input.draft;
    this.layout = input.layout;
    this.onClose = input.onClose ?? (() => undefined);
    this.onIssue = input.onIssue ?? (() => undefined);
    this.session = new AnnotationDraftSession({
      draft: input.draft,
      onStateChange: (state) => this.renderState(state),
      service: input.service,
    });
  }

  show(): void {
    if (this.element !== null) {
      this.element.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
      return;
    }

    const composer = this.document.createElement('div');
    composer.className = `inkstone-note-composer inkstone-note-composer--${this.layout}`;
    composer.dataset.inkstoneNoteComposer = '';
    composer.setAttribute('aria-label', 'Annotation note');
    composer.setAttribute('role', 'dialog');
    composer.style.setProperty(
      '--inkstone-composer-x',
      `${Math.round(this.anchorRect.left + this.anchorRect.width / 2)}px`,
    );
    composer.style.setProperty('--inkstone-composer-y', `${Math.round(this.anchorRect.bottom)}px`);

    const header = this.document.createElement('div');
    header.className = 'inkstone-note-composer__header';
    const quote = this.document.createElement('blockquote');
    quote.className = 'inkstone-note-composer__quote';
    quote.textContent = this.draft.target.quote.exact;
    header.append(quote);
    const closeButton = this.document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'inkstone-note-composer__close';
    closeButton.setAttribute('aria-label', 'Close note');
    closeButton.textContent = '×';
    closeButton.addEventListener('click', () => void this.close());
    header.append(closeButton);
    composer.append(header);

    const textarea = this.document.createElement('textarea');
    textarea.className = 'inkstone-note-composer__body';
    textarea.setAttribute('aria-label', 'Note');
    textarea.placeholder = 'Add a note…';
    textarea.rows = 4;
    textarea.value = this.draft.body ?? '';
    composer.append(textarea);

    const tags = this.document.createElement('input');
    tags.className = 'inkstone-note-composer__tags';
    tags.type = 'text';
    tags.setAttribute('aria-label', 'Tags');
    tags.placeholder = 'Tags, separated by commas';
    tags.value = this.draft.tags.join(', ');
    composer.append(tags);

    const footer = this.document.createElement('div');
    footer.className = 'inkstone-note-composer__footer';
    const status = this.document.createElement('span');
    status.dataset.inkstoneSaveState = '';
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('role', 'status');
    status.textContent = '';
    footer.append(status);
    const retry = this.document.createElement('button');
    retry.type = 'button';
    retry.className = 'inkstone-note-composer__retry';
    retry.textContent = 'Retry';
    retry.hidden = true;
    retry.addEventListener('click', () => void this.flush());
    footer.append(retry);
    composer.append(footer);

    const update = (): void => {
      this.session.update({
        body: textarea.value,
        tags: parseTags(tags.value),
      });
    };
    textarea.addEventListener('input', update);
    tags.addEventListener('input', update);
    composer.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void this.close();
      }
    });

    this.element = composer;
    this.statusElement = status;
    this.retryButton = retry;
    this.document.body.append(composer);
    this.document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.document.defaultView?.addEventListener('blur', this.handleWindowBlur);
    this.document.defaultView?.addEventListener('pagehide', this.handlePageHide);
    textarea.focus({ preventScroll: true });
  }

  async flush(): Promise<void> {
    try {
      await this.session.flush();
    } catch (error) {
      this.onIssue(error);
    }
  }

  close(): Promise<void> {
    if (this.closing !== null) {
      return this.closing;
    }
    this.closing = this.closeOnce();
    return this.closing;
  }

  dispose(): void {
    this.removeLifecycleListeners();
    void this.session.close().catch(this.onIssue);
    this.element?.remove();
    this.element = null;
  }

  private async closeOnce(): Promise<void> {
    try {
      await this.session.close();
      this.removeLifecycleListeners();
      this.element?.remove();
      this.element = null;
      this.onClose();
    } catch (error) {
      this.onIssue(error);
      this.closing = null;
    }
  }

  private removeLifecycleListeners(): void {
    this.document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.document.defaultView?.removeEventListener('blur', this.handleWindowBlur);
    this.document.defaultView?.removeEventListener('pagehide', this.handlePageHide);
  }

  private renderState(state: DraftPersistenceState): void {
    if (this.statusElement === null || this.retryButton === null) {
      return;
    }
    switch (state.kind) {
      case 'idle':
        this.statusElement.textContent = '';
        this.hideRetryAndRestoreFocus();
        break;
      case 'saving':
        this.statusElement.textContent = 'Saving…';
        this.hideRetryAndRestoreFocus();
        break;
      case 'saved-locally':
        this.statusElement.textContent = 'Saved locally';
        this.hideRetryAndRestoreFocus();
        break;
      case 'error':
        this.statusElement.textContent = state.message;
        this.retryButton.hidden = false;
        break;
    }
  }

  private hideRetryAndRestoreFocus(): void {
    if (this.retryButton === null) return;
    if (this.document.activeElement === this.retryButton) {
      this.element?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
    }
    this.retryButton.hidden = true;
  }
}

function parseTags(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/[,，]/u)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}
