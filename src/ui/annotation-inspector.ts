import type { ReattachmentCandidate } from '../domain/annotation-reattachment';
import type { StylePreset } from '../domain/style-preset';
import type { TextAnnotationRecord } from '../domain/text-annotation';
import {
  AnnotationInspectorApp,
  type AnnotationInspectorAppProps,
} from './inspector/annotation-inspector-app';
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

export class AnnotationInspector {
  private anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'> = new DOMRect();
  private readonly document: Document;
  private host: HTMLDivElement | null = null;
  private invoker: HTMLElement | undefined;
  private readonly island: UiIsland<AnnotationInspectorAppProps> =
    createPreactIsland(AnnotationInspectorApp);
  private readonly onDeleteRecord: (record: TextAnnotationRecord) => Promise<TextAnnotationRecord>;
  private readonly onExportRecord: (record: TextAnnotationRecord, invoker: HTMLElement) => void;
  private readonly onNavigateRecord: (record: TextAnnotationRecord) => void;
  private readonly onConfirmReattachRecord:
    | ((
        record: TextAnnotationRecord,
        candidate: ReattachmentCandidate,
      ) => Promise<TextAnnotationRecord>)
    | undefined;
  private readonly onPreviewReattachRecord:
    ((record: TextAnnotationRecord) => Promise<ReattachmentCandidate>) | undefined;
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
    this.setEditingFeedback('Export options opened', 'export');
  };
  private readonly handleNavigate = (): void => {
    const state = this.store.state.value;
    if (state.kind !== 'editing') return;
    this.onNavigateRecord(state.draft.record);
    this.setEditingFeedback('Source opened', 'navigate');
  };
  private readonly handlePreviewReattach = (): void => {
    void this.previewReattach();
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
    readonly onDelete: (record: TextAnnotationRecord) => Promise<TextAnnotationRecord>;
    readonly onExport?: (record: TextAnnotationRecord, invoker: HTMLElement) => void;
    readonly onConfirmReattach?: (
      record: TextAnnotationRecord,
      candidate: ReattachmentCandidate,
    ) => Promise<TextAnnotationRecord>;
    readonly onNavigate: (record: TextAnnotationRecord) => void;
    readonly onPreviewReattach?: (record: TextAnnotationRecord) => Promise<ReattachmentCandidate>;
    readonly onSave: (
      record: TextAnnotationRecord,
      changes: AnnotationInspectorChanges,
    ) => Promise<TextAnnotationRecord>;
    readonly onUndo: (record: TextAnnotationRecord) => Promise<TextAnnotationRecord>;
    readonly presets: readonly StylePreset[];
    readonly writeClipboard: (text: string) => Promise<void>;
  }) {
    this.document = input.document;
    this.onDeleteRecord = input.onDelete;
    this.onExportRecord = input.onExport ?? (() => undefined);
    this.onConfirmReattachRecord = input.onConfirmReattach;
    this.onNavigateRecord = input.onNavigate;
    this.onPreviewReattachRecord = input.onPreviewReattach;
    this.onSaveRecord = input.onSave;
    this.onUndoRecord = input.onUndo;
    this.presets = input.presets;
    this.writeClipboard = input.writeClipboard;
  }

  show(input: {
    readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
    readonly invoker?: HTMLElement;
    readonly records: readonly TextAnnotationRecord[];
  }): void {
    if (input.records.length === 0) {
      throw new Error('Annotation inspector requires at least one record.');
    }
    this.close(false);
    this.anchorRect = input.anchorRect;
    this.invoker = input.invoker;
    const initial =
      input.records.length > 1
        ? ({ kind: 'choosing', records: input.records } as const)
        : inspectorEditingState(input.records[0] as TextAnnotationRecord, this.presets);
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
          message: "Couldn't reattach locally. The original target is unchanged.",
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
        ? record.target.quote.exact
        : kind === 'link'
          ? `obsidian://inkstone-annotation?file=${encodeURIComponent(record.filePath)}&id=${encodeURIComponent(record.id)}`
          : `${JSON.stringify(record, null, 2)}\n`;
    try {
      await this.writeClipboard(text);
      this.setEditingFeedback(
        kind === 'quote'
          ? 'Quote copied'
          : kind === 'link'
            ? 'Annotation link copied'
            : 'Annotation JSON copied',
        kind,
      );
    } catch {
      this.setEditingFeedback("Couldn't copy. Retry.", null);
    }
  }

  private async deleteRecord(): Promise<void> {
    const state = this.store.state.value;
    if (state.kind !== 'editing') return;
    this.transition({ ...state, feedback: 'Deleting…', successfulAction: null });
    try {
      const deleted = await this.onDeleteRecord(state.draft.record);
      this.transition({ action: { kind: 'idle' }, kind: 'deleted', record: deleted });
    } catch {
      this.setEditingFeedback("Couldn't delete locally. Retry.", null);
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
          save: { kind: 'error', message: "Couldn't save locally. Retry." },
        });
      }
      return false;
    }
  }

  private async previewReattach(): Promise<void> {
    const state = this.store.state.value;
    if (state.kind !== 'editing' || this.onPreviewReattachRecord === undefined) return;
    this.transition({
      ...state,
      feedback: 'Reading replacement selection…',
      successfulAction: null,
    });
    try {
      const candidate = await this.onPreviewReattachRecord(state.draft.record);
      this.transition({
        action: { kind: 'idle' },
        candidate,
        kind: 'previewing-reattachment',
        record: state.draft.record,
      });
    } catch {
      this.setEditingFeedback('Select replacement text in Reading View, then retry.', null);
    }
  }

  private props(): AnnotationInspectorAppProps {
    return {
      anchorRect: this.anchorRect,
      canReattach:
        this.onPreviewReattachRecord !== undefined && this.onConfirmReattachRecord !== undefined,
      document: this.document,
      ...(this.invoker === undefined ? {} : { invoker: this.invoker }),
      onCancelReattach: this.handleCancelReattach,
      onChoose: this.handleChoose,
      onConfirmReattach: this.handleConfirmReattach,
      onCopy: this.handleCopy,
      onDelete: this.handleDelete,
      onExport: this.handleExport,
      onNavigate: this.handleNavigate,
      onPreviewReattach: this.handlePreviewReattach,
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
    if (state.kind === 'editing' && !(await this.performSave(false))) return false;
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
        action: { kind: 'error', message: "Couldn't undo locally. Retry." },
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
