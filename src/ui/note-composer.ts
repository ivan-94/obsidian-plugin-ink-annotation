import { AnnotationDraftSession } from '../application/annotation-draft-session';
import type { AnnotationService } from '../application/annotation-service';
import type { TextAnnotationRecord } from '../domain/text-annotation';
import { NoteComposerApp, type NoteComposerAppProps } from './floating/note-composer-app';
import { createPreactIsland, type UiIsland } from './runtime/mount-preact-island';
import { createNoteComposerStore, type NoteComposerStore } from './stores/note-composer-store';

export type NoteComposerLayout = 'anchored' | 'bottom-sheet';

export class NoteComposer {
  private readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
  private closing: Promise<boolean> | null = null;
  private readonly document: Document;
  private readonly draft: TextAnnotationRecord;
  private host: HTMLDivElement | null = null;
  private readonly island: UiIsland<NoteComposerAppProps> = createPreactIsland(NoteComposerApp);
  private readonly layout: NoteComposerLayout;
  private readonly onClose: () => void;
  private readonly onIssue: (error: unknown) => void;
  private readonly session: AnnotationDraftSession;
  private readonly store: NoteComposerStore;
  private readonly handlePageHide = (): void => {
    void this.flush();
  };
  private readonly handleWindowBlur = (): void => {
    void this.flush();
  };
  private readonly handleVisibilityChange = (): void => {
    if (this.document.visibilityState === 'hidden') void this.flush();
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
    this.store = createNoteComposerStore(input.draft);
    this.session = new AnnotationDraftSession({
      draft: input.draft,
      onStateChange: (state) => {
        this.store.persistence.value = state;
        if (this.host !== null) this.island.update(this.props());
      },
      service: input.service,
    });
  }

  show(): void {
    if (this.host !== null) {
      this.host.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
      return;
    }
    const host = this.document.createElement('div');
    host.dataset.inkstoneNoteComposerHost = '';
    this.document.body.append(host);
    this.host = host;
    this.island.mount(host, this.props());
    this.installLifecycleListeners();
  }

  private props(): NoteComposerAppProps {
    return {
      anchorRect: this.anchorRect,
      document: this.document,
      draft: this.draft,
      layout: this.layout,
      onFlush: () => this.flush(),
      onRequestClose: () => this.requestClose(),
      onUpdate: (input) => this.session.update(input),
      store: this.store,
    };
  }

  async flush(): Promise<void> {
    try {
      await this.session.flush();
    } catch (error) {
      this.onIssue(error);
    }
  }

  async close(): Promise<void> {
    await this.requestClose();
  }

  dispose(): void {
    this.removeLifecycleListeners();
    void this.session.close().catch(this.onIssue);
    this.unmount();
  }

  private installLifecycleListeners(): void {
    this.document.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.document.defaultView?.addEventListener('blur', this.handleWindowBlur);
    this.document.defaultView?.addEventListener('pagehide', this.handlePageHide);
  }

  private removeLifecycleListeners(): void {
    this.document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.document.defaultView?.removeEventListener('blur', this.handleWindowBlur);
    this.document.defaultView?.removeEventListener('pagehide', this.handlePageHide);
  }

  private requestClose(): Promise<boolean> {
    if (this.closing !== null) return this.closing;
    this.closing = this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<boolean> {
    try {
      await this.session.close();
      this.removeLifecycleListeners();
      this.unmount();
      this.onClose();
      return true;
    } catch (error) {
      this.onIssue(error);
      this.closing = null;
      return false;
    }
  }

  private unmount(): void {
    if (this.host === null) return;
    this.island.unmount();
    this.host.remove();
    this.host = null;
  }
}
