import type { Signal } from '@preact/signals';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';

import type { StylePreset } from '../../domain/style-preset';
import { annotationTargetText, type TextAnnotationRecord } from '../../domain/text-annotation';
import { IconButton } from '../primitives/icon-button';
import { ObsidianIcon } from '../primitives/obsidian-icon';
import { observeAnchoredElement, viewportBounds } from '../runtime/anchored-layer-position';
import { registerDismissibleLayer } from '../runtime/dismissible-layer';
import type { InspectorDraft, InspectorState } from '../stores/annotation-inspector-store';
import type { AnnotationInspectorInitialFocus } from '../annotation-inspector';

export interface AnnotationInspectorAppProps {
  readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
  readonly document: Document;
  readonly initialFocus: AnnotationInspectorInitialFocus;
  readonly invoker?: HTMLElement;
  readonly onCancelReattach: () => void;
  readonly onChoose: (record: TextAnnotationRecord) => void;
  readonly onConfirmReattach: () => void;
  readonly onCopy: (kind: 'json' | 'link' | 'quote') => void;
  readonly onDelete: () => void;
  readonly onExport: (invoker: HTMLElement) => void;
  readonly onNavigate: () => void;
  readonly onRequestDismiss: () => Promise<boolean>;
  readonly onSave: () => void;
  readonly onUndo: () => void;
  readonly onUpdateDraft: (
    update: Partial<Pick<InspectorDraft, 'body' | 'markKind' | 'styleId' | 'tags'>>,
  ) => void;
  readonly presets: readonly StylePreset[];
  readonly state: Signal<InspectorState>;
}

export function AnnotationInspectorApp(props: AnnotationInspectorAppProps) {
  const inspector = useRef<HTMLDivElement>(null);
  const retrySave = useRef<HTMLButtonElement>(null);
  const state = props.state.value;
  const focusKey = state.kind === 'editing' ? `editing:${state.draft.record.id}` : state.kind;

  useLayoutEffect(() => {
    const element = inspector.current;
    if (element === null) return;
    return registerDismissibleLayer(props.document, {
      element,
      onDismiss: props.onRequestDismiss,
      ...(props.invoker === undefined ? {} : { returnFocus: props.invoker }),
    });
  }, [props.document, props.invoker, props.onRequestDismiss]);

  useLayoutEffect(() => {
    const element = inspector.current;
    if (element === null) return;
    if (state.kind === 'deleted' || viewportBounds(props.document).width <= 600) return;
    return observeAnchoredElement({
      anchorRect: props.anchorRect,
      document: props.document,
      element,
      preferredPlacement: 'below',
    });
  }, [focusKey, props.anchorRect, props.document, state.kind]);

  useLayoutEffect(() => {
    const element = inspector.current;
    if (element === null) return;
    const selector =
      state.kind === 'choosing'
        ? 'button[data-inkstone-overlap-choice]'
        : state.kind === 'editing'
          ? props.initialFocus === 'note'
            ? 'textarea[aria-label="Note"]'
            : `button[data-inkstone-mark-type="${state.draft.markKind}"]`
          : state.kind === 'previewing-reattachment'
            ? 'button[aria-label="Confirm reattachment"]'
            : 'button[aria-label="Undo delete"]';
    element.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }, [focusKey, props.initialFocus]);

  useLayoutEffect(() => {
    if (state.kind === 'editing' && state.save.kind === 'error') {
      retrySave.current?.focus({ preventScroll: true });
    }
  }, [state.kind === 'editing' ? state.save.kind : state.kind]);

  if (state.kind === 'closed') return null;

  return (
    <div
      aria-label="Annotation inspector"
      aria-modal="false"
      className="inkstone-annotation-inspector"
      data-annotation-id={state.kind === 'editing' ? state.draft.record.id : undefined}
      data-inkstone-annotation-inspector=""
      data-inkstone-deleted-state={state.kind === 'deleted' ? '' : undefined}
      data-inkstone-inspector-editor={state.kind === 'editing' ? '' : undefined}
      data-inkstone-overlap-chooser={state.kind === 'choosing' ? '' : undefined}
      data-inkstone-reattachment-preview={state.kind === 'previewing-reattachment' ? '' : undefined}
      ref={inspector}
      role="dialog"
    >
      {state.kind === 'choosing' ? (
        <OverlapChooser onChoose={props.onChoose} records={state.records} />
      ) : state.kind === 'editing' ? (
        <AnnotationEditor {...props} retrySave={retrySave} state={state} />
      ) : state.kind === 'previewing-reattachment' ? (
        <ReattachmentPreview
          onCancel={props.onCancelReattach}
          onConfirm={props.onConfirmReattach}
          state={state}
        />
      ) : (
        <DeletedAnnotationState onUndo={props.onUndo} state={state} />
      )}
    </div>
  );
}

function OverlapChooser({
  onChoose,
  records,
}: {
  readonly onChoose: (record: TextAnnotationRecord) => void;
  readonly records: readonly TextAnnotationRecord[];
}) {
  return (
    <>
      <InspectorHeader icon="layers-3" title="Choose annotation" />
      <p className="inkstone-annotation-inspector__hint">Several annotations share this passage.</p>
      {records.map((record) => (
        <button
          data-annotation-id={record.id}
          data-inkstone-overlap-choice=""
          key={record.id}
          onClick={() => onChoose(record)}
          type="button"
        >
          <span>{annotationTargetText(record.target)}</span>
          <span>{markTypeLabel(record.mark?.kind ?? 'note')}</span>
        </button>
      ))}
    </>
  );
}

function AnnotationEditor({
  onCopy,
  onDelete,
  onExport,
  onNavigate,
  onSave,
  onUpdateDraft,
  presets,
  retrySave,
  state,
}: Omit<AnnotationInspectorAppProps, 'state'> & {
  readonly retrySave: { readonly current: HTMLButtonElement | null };
  readonly state: Extract<InspectorState, { readonly kind: 'editing' }>;
}) {
  const availablePresets = useMemo(() => {
    const result = [...presets];
    const { record, styleId } = state.draft;
    if (record.mark !== undefined && !result.some((preset) => preset.id === styleId)) {
      result.push({ color: 'var(--text-muted)', id: styleId, name: 'Legacy style' });
    }
    return result;
  }, [presets, state.draft.record, state.draft.styleId]);
  const status = inspectorStatus(state);
  const failed = state.save.kind === 'error';

  return (
    <>
      <blockquote>
        <ObsidianIcon className="inkstone-annotation-inspector__quote-icon" icon="quote" />
        <span>{annotationTargetText(state.draft.record.target)}</span>
      </blockquote>
      <div className="inkstone-annotation-inspector__editor-controls">
        <div
          aria-label="Mark type"
          className="inkstone-annotation-inspector__segments"
          role="group"
        >
          {(['highlight', 'underline', 'note'] as const).map((kind) => (
            <button
              aria-label={`${markTypeLabel(kind)} mark type`}
              aria-pressed={kind === state.draft.markKind}
              data-inkstone-mark-type={kind}
              key={kind}
              onClick={() => onUpdateDraft({ markKind: kind })}
              type="button"
            >
              {kind === 'note' ? 'Note' : markTypeLabel(kind)}
            </button>
          ))}
        </div>
        <div aria-label="Style" className="inkstone-annotation-inspector__styles" role="group">
          {availablePresets.map((preset) => (
            <button
              aria-label={`Style: ${preset.name ?? preset.id}`}
              aria-pressed={preset.id === state.draft.styleId}
              className="inkstone-annotation-inspector__style"
              data-inkstone-style-id={preset.id}
              disabled={state.draft.markKind === 'note'}
              key={preset.id}
              onClick={() => onUpdateDraft({ styleId: preset.id })}
              style={{ '--inkstone-preset-color': preset.color }}
              type="button"
            >
              <span aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
      <textarea
        aria-label="Note"
        onChange={(event) => onUpdateDraft({ body: event.currentTarget.value })}
        onInput={(event) => onUpdateDraft({ body: event.currentTarget.value })}
        placeholder="Add a note…"
        rows={2}
        value={state.draft.body}
      />
      <label className="inkstone-annotation-inspector__tag-field">
        <ObsidianIcon icon="tag" />
        <input
          aria-label="Tags"
          onChange={(event) => onUpdateDraft({ tags: event.currentTarget.value })}
          onInput={(event) => onUpdateDraft({ tags: event.currentTarget.value })}
          placeholder="Tags"
          type="text"
          value={state.draft.tags}
        />
      </label>
      <span aria-live="polite" data-inkstone-inspector-status="" role="status">
        {status}
      </span>
      <div className="inkstone-annotation-inspector__footer">
        <div className="inkstone-annotation-inspector__actions">
          <InspectorAction
            action="quote"
            icon="copy"
            label="Copy quote"
            onClick={() => onCopy('quote')}
            successfulAction={state.successfulAction}
          />
          <InspectorAction
            action="link"
            icon="link"
            label="Copy annotation link"
            onClick={() => onCopy('link')}
            successfulAction={state.successfulAction}
          />
          <InspectorAction
            action="navigate"
            icon="external-link"
            label="Go to source"
            onClick={onNavigate}
            successfulAction={state.successfulAction}
          />
          <InspectorAction
            action="export"
            icon="share"
            label="Export annotation"
            onClick={(event) => onExport(event.currentTarget as HTMLElement)}
            successfulAction={state.successfulAction}
          />
          <InspectorAction
            action="json"
            icon="braces"
            label="Copy annotation JSON"
            onClick={() => onCopy('json')}
            successfulAction={state.successfulAction}
          />
          <IconButton danger icon="trash-2" label="Delete annotation" onClick={onDelete} />
        </div>
        <button
          aria-label={failed ? 'Retry save' : 'Save annotation'}
          className="inkstone-annotation-inspector__save mod-cta"
          disabled={state.save.kind === 'pending'}
          onClick={onSave}
          ref={retrySave}
          type="button"
        >
          {failed ? 'Retry' : 'Save'}
        </button>
      </div>
    </>
  );
}

function InspectorAction({
  action,
  icon,
  label,
  onClick,
  successfulAction,
}: {
  readonly action: string;
  readonly icon: string;
  readonly label: string;
  readonly onClick: (event: MouseEvent) => void;
  readonly successfulAction: string | null;
}) {
  return (
    <IconButton
      {...(successfulAction === action ? { className: 'is-success' } : {})}
      icon={icon}
      label={label}
      onClick={onClick}
    />
  );
}

function ReattachmentPreview({
  onCancel,
  onConfirm,
  state,
}: {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly state: Extract<InspectorState, { readonly kind: 'previewing-reattachment' }>;
}) {
  return (
    <>
      <InspectorHeader icon="scan-text" title="Repair annotation" />
      <p className="inkstone-annotation-inspector__repair-hint">
        Replace the missing target with your current selection?
      </p>
      <div
        aria-label="Target replacement preview"
        className="inkstone-annotation-inspector__repair-comparison"
      >
        <section className="inkstone-annotation-inspector__repair-target">
          <span>Current target</span>
          <blockquote>{annotationTargetText(state.record.target)}</blockquote>
        </section>
        <ObsidianIcon className="inkstone-annotation-inspector__repair-arrow" icon="arrow-down" />
        <section className="inkstone-annotation-inspector__repair-target inkstone-annotation-inspector__repair-target--new">
          <span>New target</span>
          <blockquote>{annotationTargetText(state.candidate.target)}</blockquote>
        </section>
      </div>
      <span role="alert">{state.action.kind === 'error' ? state.action.message : ''}</span>
      <div className="inkstone-annotation-inspector__decision-actions">
        <IconButton icon="x" label="Cancel reattachment" onClick={onCancel} text="Cancel" />
        <IconButton
          busy={state.action.kind === 'pending'}
          className="mod-cta"
          disabled={state.action.kind === 'pending'}
          icon="check"
          label="Confirm reattachment"
          onClick={onConfirm}
          text="Use selection"
        />
      </div>
    </>
  );
}

function DeletedAnnotationState({
  onUndo,
  state,
}: {
  readonly onUndo: () => void;
  readonly state: Extract<InspectorState, { readonly kind: 'deleted' }>;
}) {
  return (
    <>
      <InspectorHeader icon="trash-2" title="Annotation deleted" />
      <p>{state.action.kind === 'error' ? state.action.message : 'Saved locally'}</p>
      <IconButton
        busy={state.action.kind === 'pending'}
        className="mod-cta"
        disabled={state.action.kind === 'pending'}
        icon="undo-2"
        label="Undo delete"
        onClick={onUndo}
        text="Undo"
      />
    </>
  );
}

function InspectorHeader({ icon, title }: { readonly icon: string; readonly title: string }) {
  return (
    <header className="inkstone-annotation-inspector__header">
      <ObsidianIcon icon={icon} />
      <h3>{title}</h3>
    </header>
  );
}

function inspectorStatus(state: Extract<InspectorState, { readonly kind: 'editing' }>): string {
  if (state.save.kind === 'pending') return 'Saving…';
  if (state.save.kind === 'error') return state.save.message;
  if (state.save.kind === 'success') return 'Saved locally';
  return state.feedback;
}

function markTypeLabel(kind: 'highlight' | 'note' | 'underline'): string {
  if (kind === 'highlight') return 'Highlight';
  if (kind === 'underline') return 'Underline';
  return 'Note';
}
