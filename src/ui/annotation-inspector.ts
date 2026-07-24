import type { ReattachmentCandidate } from '../domain/annotation-reattachment';
import type { StylePreset } from '../domain/style-preset';
import { annotationTargetText, type TextAnnotationRecord } from '../domain/text-annotation';
import {
  AnnotationInspectorApp,
  type AnnotationInspectorAppProps,
} from './inspector/annotation-inspector-app';
import type { I18n } from './i18n/contract';
import { createI18n } from './i18n/create-i18n';
import { createPreactIsland, type UiIsland } from './runtime/mount-preact-island';
import {
  createAnnotationInspectorStore,
  inspectorEditingState,
  type AnnotationInspectorStore,
  type InspectorDraft,
  type InspectorState,
} from './stores/annotation-inspector-store';

export interface AnnotationInspectorChanges {
  readonly body: string;
  readonly mark?: TextAnnotationRecord['mark'];
  readonly tags: readonly string[];
}

export type AnnotationInspectorInitialFocus = 'mark-type' | 'note';

export class AnnotationInspector {
  private anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'> = new DOMRect();
  private readonly document: Document;
  private host: HTMLDivElement | null = null;
  private readonly i18n: I18n;
  private initialFocus: AnnotationInspectorInitialFocus = 'mark-type';
  private invoker: HTMLElement | undefined;
  private readonly island: UiIsland<AnnotationInspectorAppProps>;
  private readonly onDeleteRecord: (record: TextAnnotationRecord) => Promise<TextAnnotationRecord>;
  private readonly onDiscardRecord: (record: TextAnnotationRecord) => Promise<void> | void;
  private readonly onExportRecord: (record: TextAnnotationRecord, invoker: HTMLElement) => void;
  private readonly onNavigateRecord: (record: TextAnnotationRecord) => void;
  private readonly onConfirmReattachRecord:
    | ((
        record: TextAnnotationRecord,
        candidate: ReattachmentCandidate,
      ) => Promise<TextAnnotationRecord>)
    | undefined;
  private readonly onSaveRecord: (
    record: TextAnnotationRecord,
    changes: AnnotationInspectorChanges,
  ) => Promise<TextAnnotationRecord>;
  private readonly onUndoRecord: (record: TextAnnotationRecord) => Promise<TextAnnotationRecord>;
  private presets: readonly StylePreset[];
  private readonly store: AnnotationInspectorStore = createAnnotationInspectorStore();
  private readonly writeClipboard: (text: string) => Promise<void>;

  private readonly handleCancelReattach = (): void => {
    const state = this.store.state.value;
    if (state.kind === 'previewing-reattachment') {
      this.transition(inspectorEditingState(state.record, this.presets));
    }
  };
  private readonly handleChoose = (record: TextAnnotationRecord): void => {
    this.transition(inspectorEditingState(record, this.presets));
  };
  private readonly handleConfirmReattach = (): void => {
    void this.confirmReattach();
  };
  private readonly handleCopy = (kind: 'json' | 'link' | 'quote'): void => {
    void this.copy(kind);
  };
  private readonly handleDelete = (): void => {
    void this.deleteRecord();
  };
  private readonly handleExport = (invoker: HTMLElement): void => {
    const state = this.store.state.value;
    if (state.kind !== 'editing') return;
    this.onExportRecord(state.draft.record, invoker);
    this.setEditingFeedback(this.i18n.t('inspector.exportOpened'), 'export');
  };
  private readonly handleNavigate = (): void => {
    const state = this.store.state.value;
    if (state.kind !== 'editing') return;
    this.onNavigateRecord(state.draft.record);
    this.setEditingFeedback(this.i18n.t('inspector.sourceOpened'), 'navigate');
  };
  private readonly handleRequestDismiss = (): Promise<boolean> => this.requestDismiss();
  private readonly handleSave = (): void => {
    void this.performSave(true).then((saved) => {
      if (saved) this.close();
    });
  };
  private readonly handleUndo = (): void => {
    void this.undoDelete();
  };
  private readonly handleUpdateDraft = (
    update: Partial<Pick<InspectorDraft, 'body' | 'markKind' | 'styleId' | 'tags'>>,
  ): void => {
    const state = this.store.state.value;
    if (state.kind !== 'editing' || state.save.kind === 'pending') return;
    this.transition({
      ...state,
      draft: { ...state.draft, ...update, dirty: true },
      feedback: '',
      save: { kind: 'idle' },
      successfulAction: null,
    });
  };

  constructor(input: {
    readonly document: Document;
    readonly i18n?: I18n;
    readonly onDelete: (record: TextAnnotationRecord) => Promise<TextAnnotationRecord>;
    readonly onDiscard?: (record: TextAnnotationRecord) => Promise<void> | void;
    readonly onExport?: (record: TextAnnotationRecord, invoker: HTMLElement) => void;
    readonly onConfirmReattach?: (
      record: TextAnnotationRecord,
      candidate: ReattachmentCandidate,
    ) => Promise<TextAnnotationRecord>;
    readonly onNavigate: (record: TextAnnotationRecord) => void;
    readonly onSave: (
      record: TextAnnotationRecord,
      changes: AnnotationInspectorChanges,
    ) => Promise<TextAnnotationRecord>;
    readonly onUndo: (record: TextAnnotationRecord) => Promise<TextAnnotationRecord>;
    readonly presets: readonly StylePreset[];
    readonly writeClipboard: (text: string) => Promise<void>;
  }) {
    this.document = input.document;
    this.i18n = input.i18n ?? createI18n('en');
    this.island = createPreactIsland(AnnotationInspectorApp, { i18n: this.i18n });
    this.onDeleteRecord = input.onDelete;
    this.onDiscardRecord = input.onDiscard ?? (() => undefined);
    this.onExportRecord = input.onExport ?? (() => undefined);
    this.onConfirmReattachRecord = input.onConfirmReattach;
    this.onNavigateRecord = input.onNavigate;
    this.onSaveRecord = input.onSave;
    this.onUndoRecord = input.onUndo;
    this.presets = input.presets;
    this.writeClipboard = input.writeClipboard;
  }

  show(input: {
    readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
    readonly initialFocus?: AnnotationInspectorInitialFocus;
    readonly invoker?: HTMLElement;
    readonly records: readonly TextAnnotationRecord[];
  }): void {
    if (input.records.length === 0) {
      throw new Error('Annotation inspector requires at least one record.');
    }
    const initial =
      input.records.length > 1
        ? ({ kind: 'choosing', records: input.records } as const)
        : inspectorEditingState(input.records[0] as TextAnnotationRecord, this.presets);
    this.mount(initial, input.anchorRect, input.invoker, input.initialFocus ?? 'mark-type');
  }

  showReattachmentPreview(input: {
    readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
    readonly candidate: ReattachmentCandidate;
    readonly invoker?: HTMLElement;
    readonly record: TextAnnotationRecord;
  }): void {
    if (input.record.status !== 'unanchored') {
      throw new Error('Only an unanchored annotation can be repaired.');
    }
    if (input.candidate.annotationId !== input.record.id) {
      throw new Error('Reattachment preview does not belong to this annotation.');
    }
    this.mount(
      {
        action: { kind: 'idle' },
        candidate: input.candidate,
        kind: 'previewing-reattachment',
        record: input.record,
      },
      input.anchorRect,
      input.invoker,
    );
  }

  private mount(
    initial: InspectorState,
    anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>,
    invoker: HTMLElement | undefined,
    initialFocus: AnnotationInspectorInitialFocus = 'mark-type',
  ): void {
    this.close(false);
    this.anchorRect = anchorRect;
    this.initialFocus = initialFocus;
    this.invoker = invoker;
    this.store.state.value = initial;
    const host = this.document.createElement('div');
    host.dataset.inkstoneAnnotationInspectorHost = '';
    this.document.body.append(host);
    this.host = host;
    this.island.mount(host, this.props());
  }

  close(returnFocus = true): void {
    if (this.host === null) return;
    this.island.unmount();
    this.host.remove();
    this.host = null;
    this.store.state.value = { kind: 'closed' };
    if (returnFocus) this.invoker?.focus({ preventScroll: true });
    this.invoker = undefined;
  }

  setPresets(presets: readonly StylePreset[]): void {
    if (presets.length === 0) {
      throw new Error('Annotation inspector requires at least one style preset.');
    }
    this.presets = presets;
    if (this.host !== null) this.island.update(this.props());
  }

  private async confirmReattach(): Promise<void> {
    const state = this.store.state.value;
    if (
      state.kind !== 'previewing-reattachment' ||
      state.action.kind === 'pending' ||
      this.onConfirmReattachRecord === undefined
    ) {
      return;
    }
    this.transition({ ...state, action: { kind: 'pending' } });
    try {
      const repaired = await this.onConfirmReattachRecord(state.record, state.candidate);
      this.transition(inspectorEditingState(repaired, this.presets));
    } catch {
      this.transition({
        ...state,
        action: {
          kind: 'error',
          message: this.i18n.t('inspector.reattachFailed'),
        },
      });
    }
  }

  private async copy(kind: 'json' | 'link' | 'quote'): Promise<void> {
    const state = this.store.state.value;
    if (state.kind !== 'editing') return;
    const record = state.draft.record;
    const text =
      kind === 'quote'
        ? annotationTargetText(record.target)
        : kind === 'link'
          ? `obsidian://inkstone-annotation?file=${encodeURIComponent(record.filePath)}&id=${encodeURIComponent(record.id)}`
          : `${JSON.stringify(record, null, 2)}\n`;
    try {
      await this.writeClipboard(text);
      this.setEditingFeedback(
        kind === 'quote'
          ? this.i18n.t('inspector.quoteCopied')
          : kind === 'link'
            ? this.i18n.t('inspector.annotationLinkCopied')
            : this.i18n.t('inspector.annotationJsonCopied'),
        kind,
      );
    } catch {
      this.setEditingFeedback(this.i18n.t('inspector.copyFailed'), null);
    }
  }

  private async deleteRecord(): Promise<void> {
    const state = this.store.state.value;
    if (state.kind !== 'editing') return;
    this.transition({
      ...state,
      feedback: this.i18n.t('inspector.deleting'),
      successfulAction: null,
    });
    try {
      const deleted = await this.onDeleteRecord(state.draft.record);
      this.transition({ action: { kind: 'idle' }, kind: 'deleted', record: deleted });
    } catch {
      this.setEditingFeedback(this.i18n.t('inspector.deleteFailed'), null);
    }
  }

  private async performSave(force: boolean): Promise<boolean> {
    const state = this.store.state.value;
    if (state.kind !== 'editing' || state.save.kind === 'pending') return false;
    if (!state.draft.dirty && !force) return true;
    this.transition({ ...state, feedback: '', save: { kind: 'pending' }, successfulAction: null });
    try {
      const record = await this.onSaveRecord(state.draft.record, changesFrom(state.draft));
      const current = this.store.state.value;
      if (current.kind !== 'editing') return false;
      const changedWhileSaving = !sameDraftValues(current.draft, state.draft);
      this.transition({
        ...current,
        draft: { ...current.draft, dirty: changedWhileSaving, record },
        save: { kind: 'success' },
      });
      return !changedWhileSaving;
    } catch {
      const current = this.store.state.value;
      if (current.kind === 'editing') {
        this.transition({
          ...current,
          save: { kind: 'error', message: this.i18n.t('inspector.saveFailed') },
        });
      }
      return false;
    }
  }

  private props(): AnnotationInspectorAppProps {
    return {
      anchorRect: this.anchorRect,
      document: this.document,
      initialFocus: this.initialFocus,
      ...(this.invoker === undefined ? {} : { invoker: this.invoker }),
      onCancelReattach: this.handleCancelReattach,
      onChoose: this.handleChoose,
      onConfirmReattach: this.handleConfirmReattach,
      onCopy: this.handleCopy,
      onDelete: this.handleDelete,
      onExport: this.handleExport,
      onNavigate: this.handleNavigate,
      onRequestDismiss: this.handleRequestDismiss,
      onSave: this.handleSave,
      onUndo: this.handleUndo,
      onUpdateDraft: this.handleUpdateDraft,
      presets: this.presets,
      state: this.store.state,
    };
  }

  private async requestDismiss(): Promise<boolean> {
    const state = this.store.state.value;
    if (state.kind === 'closed') return true;
    if (state.kind === 'editing') {
      const discardCleanDraft = state.draft.record.status === 'draft' && !state.draft.dirty;
      if (discardCleanDraft || !(await this.performSave(false))) {
        try {
          await this.onDiscardRecord(state.draft.record);
        } catch {
          // Dismissal must never trap the user in an invalid editor. The caller owns cleanup retry.
        }
      }
    }
    this.close(false);
    return true;
  }

  private setEditingFeedback(message: string, successfulAction: string | null): void {
    const state = this.store.state.value;
    if (state.kind !== 'editing') return;
    this.transition({
      ...state,
      feedback: message,
      save: { kind: 'idle' },
      successfulAction,
    });
  }

  private transition(state: InspectorState): void {
    this.store.state.value = state;
    if (this.host !== null) this.island.update(this.props());
  }

  private async undoDelete(): Promise<void> {
    const state = this.store.state.value;
    if (state.kind !== 'deleted' || state.action.kind === 'pending') return;
    this.transition({ ...state, action: { kind: 'pending' } });
    try {
      const restored = await this.onUndoRecord(state.record);
      this.transition(inspectorEditingState(restored, this.presets));
    } catch {
      this.transition({
        ...state,
        action: { kind: 'error', message: this.i18n.t('inspector.undoFailed') },
      });
    }
  }
}

function changesFrom(draft: InspectorDraft): AnnotationInspectorChanges {
  return {
    body: draft.body,
    ...(draft.markKind === 'note'
      ? {}
      : { mark: { kind: draft.markKind, styleId: draft.styleId } }),
    tags: parseTags(draft.tags),
  };
}

function sameDraftValues(left: InspectorDraft, right: InspectorDraft): boolean {
  return (
    left.body === right.body &&
    left.markKind === right.markKind &&
    left.styleId === right.styleId &&
    left.tags === right.tags
  );
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
