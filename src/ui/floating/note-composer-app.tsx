import { useLayoutEffect, useRef } from 'preact/hooks';

import type { TextAnnotationRecord } from '../../domain/text-annotation';
import type { NoteComposerLayout } from '../note-composer';
import { registerDismissibleLayer } from '../runtime/dismissible-layer';
import { parseNoteTags, type NoteComposerStore } from '../stores/note-composer-store';

export interface NoteComposerAppProps {
  readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
  readonly document: Document;
  readonly draft: TextAnnotationRecord;
  readonly layout: NoteComposerLayout;
  readonly onFlush: () => Promise<void>;
  readonly onRequestClose: () => Promise<boolean>;
  readonly onUpdate: (input: { readonly body: string; readonly tags: readonly string[] }) => void;
  readonly store: NoteComposerStore;
}

export function NoteComposerApp({
  anchorRect,
  document,
  draft,
  layout,
  onFlush,
  onRequestClose,
  onUpdate,
  store,
}: NoteComposerAppProps) {
  const composer = useRef<HTMLDivElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const state = store.persistence.value;

  useLayoutEffect(() => {
    const element = composer.current;
    if (element === null) return;
    return registerDismissibleLayer(document, {
      element,
      onDismiss: onRequestClose,
    });
  }, [document, onRequestClose]);

  useLayoutEffect(() => {
    textarea.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (state.kind === 'error') {
      retry.current?.focus({ preventScroll: true });
      return;
    }
    if (document.activeElement === retry.current) {
      textarea.current?.focus({ preventScroll: true });
    }
  }, [document, state.kind]);

  const update = (): void => {
    store.body.value = textarea.current?.value ?? '';
    store.tags.value = parseNoteTags(
      composer.current?.querySelector<HTMLInputElement>('[aria-label="Tags"]')?.value ?? '',
    );
    onUpdate({ body: store.body.value, tags: store.tags.value });
  };

  return (
    <div
      aria-label="Annotation note"
      className={`inkstone-note-composer inkstone-note-composer--${layout}`}
      data-inkstone-note-composer=""
      ref={composer}
      role="dialog"
      style={{
        '--inkstone-composer-x': `${Math.round(anchorRect.left + anchorRect.width / 2)}px`,
        '--inkstone-composer-y': `${Math.round(anchorRect.bottom)}px`,
      }}
    >
      <div className="inkstone-note-composer__header">
        <blockquote className="inkstone-note-composer__quote">
          {draft.target.quote.exact}
        </blockquote>
        <button
          aria-label="Close note"
          className="inkstone-note-composer__close"
          onClick={() => void onRequestClose()}
          type="button"
        >
          ×
        </button>
      </div>
      <textarea
        aria-label="Note"
        className="inkstone-note-composer__body"
        value={store.body.value}
        onInput={update}
        placeholder="Add a note…"
        ref={textarea}
        rows={4}
      />
      <input
        aria-label="Tags"
        className="inkstone-note-composer__tags"
        value={store.tags.value.join(', ')}
        onInput={update}
        placeholder="Tags, separated by commas"
        type="text"
      />
      <div className="inkstone-note-composer__footer">
        <span aria-live="polite" data-inkstone-save-state="" role="status">
          {persistenceMessage(state)}
        </span>
        <button
          className="inkstone-note-composer__retry"
          hidden={state.kind !== 'error'}
          onClick={() => void onFlush()}
          ref={retry}
          type="button"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function persistenceMessage(state: NoteComposerStore['persistence']['value']): string {
  switch (state.kind) {
    case 'idle':
      return '';
    case 'saving':
      return 'Saving…';
    case 'saved-locally':
      return 'Saved locally';
    case 'error':
      return state.message;
  }
}
