import type { Signal } from '@preact/signals';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';

import type { StylePreset } from '../../domain/style-preset';
import { annotationTargetText, type TextAnnotationRecord } from '../../domain/text-annotation';
import type { I18n } from '../i18n/contract';
import { useI18n } from '../i18n/locale-context';
import { IconButton } from '../primitives/icon-button';
import { ObsidianIcon } from '../primitives/obsidian-icon';
import {
  observeAnchoredElement,
  observeViewportBottomSheet,
  viewportBounds,
} from '../runtime/anchored-layer-position';
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
  const i18n = useI18n();
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
    if (state.kind === 'deleted') return;
    if (viewportBounds(props.document).width <= 600) {
      return observeViewportBottomSheet({
        document: props.document,
        element,
      });
    }
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
            ? 'textarea[data-inkstone-note-field]'
            : `button[data-inkstone-mark-type="${state.draft.markKind}"]`
          : 'button.mod-cta';
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
      aria-label={i18n.t('inspector.label')}
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
  const i18n = useI18n();
  return (
    <>
      <InspectorHeader icon="layers-3" title={i18n.t('inspector.chooseTitle')} />
      <p className="inkstone-annotation-inspector__hint">{i18n.t('inspector.chooseHint')}</p>
      {records.map((record) => (
        <button
          data-annotation-id={record.id}
          data-inkstone-overlap-choice=""
          key={record.id}
          onClick={() => onChoose(record)}
          type="button"
        >
          <span>{annotationTargetText(record.target)}</span>
          <span>{markTypeLabel(i18n, record.mark?.kind ?? 'note')}</span>
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
  const i18n = useI18n();
  const availablePresets = useMemo(() => {
    const result = [...presets];
    const { record, styleId } = state.draft;
    if (record.mark !== undefined && !result.some((preset) => preset.id === styleId)) {
      result.push({
        color: 'var(--text-muted)',
        id: styleId,
        name: i18n.t('inspector.legacyStyle'),
      });
    }
    return result;
  }, [i18n, presets, state.draft.record, state.draft.styleId]);
  const status = inspectorStatus(i18n, state);
  const failed = state.save.kind === 'error';

  return (
    <>
      <blockquote>
        <ObsidianIcon className="inkstone-annotation-inspector__quote-icon" icon="quote" />
        <span>{annotationTargetText(state.draft.record.target)}</span>
      </blockquote>
      <div className="inkstone-annotation-inspector__editor-controls">
        <div
          aria-label={i18n.t('inspector.markType')}
          className="inkstone-annotation-inspector__segments"
          role="group"
        >
          {(['highlight', 'underline', 'note'] as const).map((kind) => (
            <button
              aria-label={i18n.t('inspector.markTypeLabel', {
                type: markTypeLabel(i18n, kind),
              })}
              aria-pressed={kind === state.draft.markKind}
              data-inkstone-mark-type={kind}
              key={kind}
              onClick={() => onUpdateDraft({ markKind: kind })}
              type="button"
            >
              {markTypeLabel(i18n, kind)}
            </button>
          ))}
        </div>
        <div
          aria-label={i18n.t('inspector.style')}
          className="inkstone-annotation-inspector__styles"
          role="group"
        >
          {availablePresets.map((preset) => (
            <button
              aria-label={i18n.t('inspector.styleLabel', {
                name: preset.name ?? preset.id,
              })}
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
        aria-label={i18n.t('inspector.note')}
        data-inkstone-note-field=""
        onChange={(event) => onUpdateDraft({ body: event.currentTarget.value })}
        onInput={(event) => onUpdateDraft({ body: event.currentTarget.value })}
        placeholder={i18n.t('inspector.notePlaceholder')}
        rows={2}
        value={state.draft.body}
      />
      <label className="inkstone-annotation-inspector__tag-field">
        <ObsidianIcon icon="tag" />
        <input
          aria-label={i18n.t('inspector.tags')}
          onChange={(event) => onUpdateDraft({ tags: event.currentTarget.value })}
          onInput={(event) => onUpdateDraft({ tags: event.currentTarget.value })}
          placeholder={i18n.t('inspector.tags')}
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
            label={i18n.t('inspector.copyQuote')}
            onClick={() => onCopy('quote')}
            successfulAction={state.successfulAction}
          />
          <InspectorAction
            action="link"
            icon="link"
            label={i18n.t('inspector.copyLink')}
            onClick={() => onCopy('link')}
            successfulAction={state.successfulAction}
          />
          <InspectorAction
            action="navigate"
            icon="external-link"
            label={i18n.t('inspector.goToSource')}
            onClick={onNavigate}
            successfulAction={state.successfulAction}
          />
          <InspectorAction
            action="export"
            icon="share"
            label={i18n.t('inspector.exportAnnotation')}
            onClick={(event) => onExport(event.currentTarget as HTMLElement)}
            successfulAction={state.successfulAction}
          />
          <InspectorAction
            action="json"
            icon="braces"
            label={i18n.t('inspector.copyJson')}
            onClick={() => onCopy('json')}
            successfulAction={state.successfulAction}
          />
          <IconButton
            danger
            icon="trash-2"
            label={i18n.t('inspector.deleteAnnotation')}
            onClick={onDelete}
          />
        </div>
        <button
          aria-label={failed ? i18n.t('inspector.retrySave') : i18n.t('inspector.saveAnnotation')}
          className="inkstone-annotation-inspector__save mod-cta"
          disabled={state.save.kind === 'pending'}
          onClick={onSave}
          ref={retrySave}
          type="button"
        >
          {failed ? i18n.t('inspector.retry') : i18n.t('inspector.save')}
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
  const i18n = useI18n();
  return (
    <>
      <InspectorHeader icon="scan-text" title={i18n.t('inspector.repairTitle')} />
      <p className="inkstone-annotation-inspector__repair-hint">{i18n.t('inspector.repairHint')}</p>
      <div
        aria-label={i18n.t('inspector.repairPreview')}
        className="inkstone-annotation-inspector__repair-comparison"
      >
        <section className="inkstone-annotation-inspector__repair-target">
          <span>{i18n.t('inspector.targetCurrent')}</span>
          <blockquote>{annotationTargetText(state.record.target)}</blockquote>
        </section>
        <ObsidianIcon className="inkstone-annotation-inspector__repair-arrow" icon="arrow-down" />
        <section className="inkstone-annotation-inspector__repair-target inkstone-annotation-inspector__repair-target--new">
          <span>{i18n.t('inspector.newTarget')}</span>
          <blockquote>{annotationTargetText(state.candidate.target)}</blockquote>
        </section>
      </div>
      <span role="alert">{state.action.kind === 'error' ? state.action.message : ''}</span>
      <div className="inkstone-annotation-inspector__decision-actions">
        <IconButton
          icon="x"
          label={i18n.t('inspector.cancelReattachment')}
          onClick={onCancel}
          text={i18n.t('inspector.cancel')}
        />
        <IconButton
          busy={state.action.kind === 'pending'}
          className="mod-cta"
          disabled={state.action.kind === 'pending'}
          icon="check"
          label={i18n.t('inspector.confirmReattachment')}
          onClick={onConfirm}
          text={i18n.t('inspector.useSelection')}
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
  const i18n = useI18n();
  return (
    <>
      <InspectorHeader icon="trash-2" title={i18n.t('inspector.deletedTitle')} />
      <p>
        {state.action.kind === 'error' ? state.action.message : i18n.t('inspector.savedLocally')}
      </p>
      <IconButton
        busy={state.action.kind === 'pending'}
        className="mod-cta"
        disabled={state.action.kind === 'pending'}
        icon="undo-2"
        label={i18n.t('inspector.undoDelete')}
        onClick={onUndo}
        text={i18n.t('inspector.undo')}
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

function inspectorStatus(
  i18n: I18n,
  state: Extract<InspectorState, { readonly kind: 'editing' }>,
): string {
  if (state.save.kind === 'pending') return i18n.t('inspector.saving');
  if (state.save.kind === 'error') return state.save.message;
  if (state.save.kind === 'success') return i18n.t('inspector.savedLocally');
  return state.feedback;
}

function markTypeLabel(i18n: I18n, kind: 'highlight' | 'note' | 'underline'): string {
  if (kind === 'highlight') return i18n.t('inspector.mark.highlight');
  if (kind === 'underline') return i18n.t('inspector.mark.underline');
  return i18n.t('inspector.mark.note');
}
