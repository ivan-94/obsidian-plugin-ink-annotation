import type { ReattachmentCandidate } from '../domain/annotation-reattachment';
import type { StylePreset } from '../domain/style-preset';
import type { TextAnnotationRecord } from '../domain/text-annotation';
import { createDismissibleMenu } from './dismissible-menu';
import { createIcon, createIconButton } from './icon-button';

export interface AnnotationInspectorChanges {
  readonly body: string;
  readonly mark?: TextAnnotationRecord['mark'];
  readonly tags: readonly string[];
}

export class AnnotationInspector {
  private readonly document: Document;
  private element: HTMLDivElement | null = null;
  private removeDismissListeners: (() => void) | null = null;
  private saveBeforeDismiss: (() => Promise<boolean>) | null = null;
  private readonly onDelete: (record: TextAnnotationRecord) => Promise<TextAnnotationRecord>;
  private readonly onExport: (record: TextAnnotationRecord, invoker: HTMLElement) => void;
  private readonly onNavigate: (record: TextAnnotationRecord) => void;
  private readonly onConfirmReattach:
    | ((
        record: TextAnnotationRecord,
        candidate: ReattachmentCandidate,
      ) => Promise<TextAnnotationRecord>)
    | undefined;
  private readonly onPreviewReattach:
    ((record: TextAnnotationRecord) => Promise<ReattachmentCandidate>) | undefined;
  private readonly onSave: (
    record: TextAnnotationRecord,
    changes: AnnotationInspectorChanges,
  ) => Promise<TextAnnotationRecord>;
  private readonly onUndo: (record: TextAnnotationRecord) => Promise<TextAnnotationRecord>;
  private presets: readonly StylePreset[];
  private readonly writeClipboard: (text: string) => Promise<void>;

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
    this.onDelete = input.onDelete;
    this.onExport = input.onExport ?? (() => undefined);
    this.onConfirmReattach = input.onConfirmReattach;
    this.onNavigate = input.onNavigate;
    this.onPreviewReattach = input.onPreviewReattach;
    this.onSave = input.onSave;
    this.onUndo = input.onUndo;
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
    const inspector = this.document.createElement('div');
    inspector.className = 'inkstone-annotation-inspector';
    inspector.dataset.inkstoneAnnotationInspector = '';
    inspector.setAttribute('aria-label', 'Annotation inspector');
    inspector.setAttribute('aria-modal', 'false');
    inspector.setAttribute('role', 'dialog');
    inspector.style.setProperty(
      '--inkstone-inspector-x',
      `${Math.round(input.anchorRect.left + input.anchorRect.width / 2)}px`,
    );
    inspector.style.setProperty(
      '--inkstone-inspector-y',
      `${Math.round(input.anchorRect.bottom)}px`,
    );
    inspector.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void this.requestDismiss();
      }
    });
    this.element = inspector;
    this.document.body.append(inspector);
    this.installOutsideDismiss(inspector);
    if (input.records.length > 1) {
      this.renderChooser(input.records, input.invoker);
    } else {
      this.renderEditor(input.records[0] as TextAnnotationRecord, input.invoker);
    }
  }

  close(returnFocus = true): void {
    const invokerId = this.element?.dataset.inkstoneInvokerId;
    this.removeDismissListeners?.();
    this.removeDismissListeners = null;
    this.saveBeforeDismiss = null;
    this.element?.remove();
    this.element = null;
    if (returnFocus && invokerId !== undefined) {
      this.document.getElementById(invokerId)?.focus({ preventScroll: true });
    }
  }

  setPresets(presets: readonly StylePreset[]): void {
    if (presets.length === 0) {
      throw new Error('Annotation inspector requires at least one style preset.');
    }
    this.presets = presets;
  }

  private installOutsideDismiss(inspector: HTMLElement): void {
    const outside = (event: PointerEvent): void => {
      const target = event.target;
      const NodeConstructor = this.document.defaultView?.Node;
      if (
        NodeConstructor !== undefined &&
        target instanceof NodeConstructor &&
        inspector.contains(target)
      ) {
        return;
      }
      void this.requestDismiss();
    };
    this.document.addEventListener('pointerdown', outside, true);
    this.removeDismissListeners = () =>
      this.document.removeEventListener('pointerdown', outside, true);
  }

  private async requestDismiss(): Promise<void> {
    const inspector = this.element;
    if (inspector === null || inspector.dataset.inkstoneDismissPending === 'true') return;
    inspector.dataset.inkstoneDismissPending = 'true';
    try {
      if (this.saveBeforeDismiss !== null && !(await this.saveBeforeDismiss())) return;
      if (this.element === inspector) this.close();
    } finally {
      delete inspector.dataset.inkstoneDismissPending;
    }
  }

  private renderChooser(records: readonly TextAnnotationRecord[], invoker?: HTMLElement): void {
    const inspector = this.requireElement();
    inspector.replaceChildren();
    inspector.dataset.inkstoneOverlapChooser = '';
    this.saveBeforeDismiss = null;
    this.rememberInvoker(invoker);
    const header = this.createHeader('Choose annotation', 'layers-3');
    const hint = this.document.createElement('p');
    hint.className = 'inkstone-annotation-inspector__hint';
    hint.textContent = 'Several annotations share this passage.';
    inspector.append(header, hint);
    for (const record of records) {
      const choice = this.document.createElement('button');
      choice.type = 'button';
      choice.dataset.annotationId = record.id;
      choice.dataset.inkstoneOverlapChoice = '';
      const quote = this.document.createElement('span');
      quote.textContent = record.target.quote.exact;
      const type = this.document.createElement('span');
      type.textContent = markTypeLabel(record.mark?.kind ?? 'note');
      choice.append(quote, type);
      choice.addEventListener('click', () => this.renderEditor(record, invoker));
      inspector.append(choice);
    }
    inspector.querySelector<HTMLButtonElement>('button[data-inkstone-overlap-choice]')?.focus({
      preventScroll: true,
    });
  }

  private renderEditor(record: TextAnnotationRecord, invoker?: HTMLElement): void {
    let currentRecord = record;
    let dirty = false;
    let saving = false;
    let markKind: 'highlight' | 'note' | 'underline' = record.mark?.kind ?? 'note';
    let styleId = record.mark?.styleId ?? this.presets[0]?.id ?? '';
    const inspector = this.requireElement();
    inspector.replaceChildren();
    delete inspector.dataset.inkstoneOverlapChooser;
    inspector.dataset.inkstoneInspectorEditor = '';
    inspector.dataset.annotationId = record.id;
    this.rememberInvoker(invoker);

    const quote = this.document.createElement('blockquote');
    quote.append(createIcon(this.document, 'quote', 'inkstone-annotation-inspector__quote-icon'));
    const quoteText = this.document.createElement('span');
    quoteText.textContent = record.target.quote.exact;
    quote.append(quoteText);
    inspector.append(quote);

    const markTypes = this.document.createElement('div');
    markTypes.className = 'inkstone-annotation-inspector__segments';
    markTypes.setAttribute('aria-label', 'Mark type');
    markTypes.setAttribute('role', 'group');
    const markButtons = new Map<typeof markKind, HTMLButtonElement>();
    for (const kind of ['highlight', 'underline', 'note'] as const) {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.dataset.inkstoneMarkType = kind;
      button.setAttribute('aria-label', `${markTypeLabel(kind)} mark type`);
      button.textContent = kind === 'note' ? 'Note' : markTypeLabel(kind);
      button.addEventListener('click', () => {
        markKind = kind;
        dirty = true;
        syncControls();
      });
      markButtons.set(kind, button);
      markTypes.append(button);
    }
    inspector.append(markTypes);

    const styleRow = this.document.createElement('div');
    styleRow.className = 'inkstone-annotation-inspector__styles';
    styleRow.setAttribute('aria-label', 'Style');
    styleRow.setAttribute('role', 'group');
    const styleButtons = new Map<string, HTMLButtonElement>();
    const availablePresets = [...this.presets];
    if (record.mark !== undefined && !availablePresets.some((preset) => preset.id === styleId)) {
      availablePresets.push({ color: 'var(--text-muted)', id: styleId, name: 'Legacy style' });
    }
    for (const preset of availablePresets) {
      const button = this.document.createElement('button');
      const label = preset.name ?? preset.id;
      button.type = 'button';
      button.className = 'inkstone-annotation-inspector__style';
      button.dataset.inkstoneStyleId = preset.id;
      button.setAttribute('aria-label', `Style: ${label}`);
      button.style.setProperty('--inkstone-preset-color', preset.color);
      const swatch = this.document.createElement('span');
      swatch.setAttribute('aria-hidden', 'true');
      button.append(swatch);
      button.addEventListener('click', () => {
        styleId = preset.id;
        dirty = true;
        syncControls();
      });
      styleButtons.set(preset.id, button);
      styleRow.append(button);
    }
    inspector.append(styleRow);

    const note = this.document.createElement('textarea');
    note.setAttribute('aria-label', 'Note');
    note.placeholder = 'Add a note…';
    note.rows = 4;
    note.value = record.body ?? '';
    note.addEventListener('input', () => {
      dirty = true;
    });
    inspector.append(note);

    const tagField = this.document.createElement('label');
    tagField.className = 'inkstone-annotation-inspector__tag-field';
    tagField.append(createIcon(this.document, 'tag'));
    const tags = this.document.createElement('input');
    tags.type = 'text';
    tags.setAttribute('aria-label', 'Tags');
    tags.placeholder = 'Tags';
    tags.value = record.tags.join(', ');
    tags.addEventListener('input', () => {
      dirty = true;
    });
    tagField.append(tags);
    inspector.append(tagField);

    const status = this.document.createElement('span');
    status.dataset.inkstoneInspectorStatus = '';
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('role', 'status');
    inspector.append(status);

    const save = this.document.createElement('button');
    save.type = 'button';
    save.className = 'inkstone-annotation-inspector__save mod-cta';
    save.setAttribute('aria-label', 'Save annotation');
    save.textContent = 'Save';
    inspector.append(save);

    const changes = (): AnnotationInspectorChanges => ({
      body: note.value,
      ...(markKind === 'note' ? {} : { mark: { kind: markKind, styleId } }),
      tags: parseTags(tags.value),
    });
    const performSave = async (force: boolean): Promise<boolean> => {
      if (saving) return false;
      if (!dirty && !force) return true;
      const restoreSaveFocus = this.document.activeElement === save;
      saving = true;
      status.textContent = 'Saving…';
      save.disabled = true;
      try {
        currentRecord = await this.onSave(currentRecord, changes());
        dirty = false;
        status.textContent = 'Saved locally';
        return true;
      } catch {
        status.textContent = "Couldn't save locally. Retry.";
        return false;
      } finally {
        saving = false;
        save.disabled = false;
        if (restoreSaveFocus && inspector.isConnected) save.focus({ preventScroll: true });
      }
    };
    save.addEventListener('click', () => {
      void performSave(true).then((saved) => {
        if (saved && this.element === inspector) this.close();
      });
    });
    this.saveBeforeDismiss = () => performSave(false);

    const actions = this.document.createElement('div');
    actions.className = 'inkstone-annotation-inspector__actions';
    const showActionFeedback = (button: HTMLButtonElement, message: string): void => {
      for (const action of actions.querySelectorAll('.is-success')) {
        action.classList.remove('is-success');
      }
      button.classList.add('is-success');
      status.textContent = message;
    };
    const exportAnnotation = createIconButton(this.document, {
      icon: 'share',
      label: 'Export annotation',
    });
    exportAnnotation.addEventListener('click', () => {
      this.onExport(currentRecord, exportAnnotation);
      showActionFeedback(exportAnnotation, 'Export options opened');
    });
    const copyQuote = createIconButton(this.document, { icon: 'copy', label: 'Copy quote' });
    copyQuote.addEventListener('click', () => {
      void this.writeClipboard(currentRecord.target.quote.exact).then(
        () => showActionFeedback(copyQuote, 'Quote copied'),
        () => {
          status.textContent = "Couldn't copy. Retry.";
        },
      );
    });
    const copyLink = createIconButton(this.document, {
      icon: 'link',
      label: 'Copy annotation link',
    });
    copyLink.addEventListener('click', () => {
      const link = `obsidian://inkstone-annotation?file=${encodeURIComponent(currentRecord.filePath)}&id=${encodeURIComponent(currentRecord.id)}`;
      void this.writeClipboard(link).then(
        () => showActionFeedback(copyLink, 'Annotation link copied'),
        () => {
          status.textContent = "Couldn't copy. Retry.";
        },
      );
    });
    const navigate = createIconButton(this.document, {
      icon: 'external-link',
      label: 'Go to source',
    });
    navigate.addEventListener('click', () => {
      this.onNavigate(currentRecord);
      showActionFeedback(navigate, 'Source opened');
    });
    const more = createIconButton(this.document, { icon: 'ellipsis', label: 'More actions' });
    more.setAttribute('aria-haspopup', 'menu');
    const moreMenu = this.document.createElement('div');
    moreMenu.className = 'inkstone-annotation-inspector__more-menu';
    moreMenu.hidden = true;
    moreMenu.setAttribute('role', 'menu');
    const moreMenuController = createDismissibleMenu({
      document: this.document,
      menu: moreMenu,
      trigger: more,
    });
    const copyJson = createIconButton(this.document, {
      icon: 'braces',
      label: 'Copy annotation JSON',
      text: 'Copy JSON',
    });
    copyJson.setAttribute('role', 'menuitem');
    copyJson.addEventListener('click', () => {
      void this.writeClipboard(`${JSON.stringify(currentRecord, null, 2)}\n`).then(
        () => showActionFeedback(copyJson, 'Annotation JSON copied'),
        () => {
          status.textContent = "Couldn't copy. Retry.";
        },
      );
      moreMenuController.close();
    });
    more.addEventListener('click', moreMenuController.toggle);
    moreMenu.append(copyJson);
    const remove = createIconButton(this.document, {
      danger: true,
      icon: 'trash-2',
      label: 'Delete annotation',
    });
    remove.addEventListener('click', () => {
      status.textContent = 'Deleting…';
      void this.onDelete(currentRecord)
        .then((deleted) => this.renderDeleted(deleted, invoker))
        .catch(() => {
          status.textContent = "Couldn't delete locally. Retry.";
        });
    });
    actions.append(copyQuote, copyLink, navigate, exportAnnotation, more, remove, moreMenu);
    if (
      record.status === 'unanchored' &&
      this.onPreviewReattach !== undefined &&
      this.onConfirmReattach !== undefined
    ) {
      const repair = createIconButton(this.document, {
        icon: 'scan-text',
        label: 'Preview reattachment',
        text: 'Repair target',
      });
      repair.classList.add('inkstone-annotation-inspector__repair');
      repair.addEventListener('click', () => {
        status.textContent = 'Reading replacement selection…';
        void this.onPreviewReattach?.(currentRecord)
          .then((candidate) => this.renderReattachmentPreview(currentRecord, candidate, invoker))
          .catch(() => {
            status.textContent = 'Select replacement text in Reading View, then retry.';
          });
      });
      inspector.append(repair);
    }
    inspector.append(actions);

    const syncControls = (): void => {
      for (const [kind, button] of markButtons) {
        button.setAttribute('aria-pressed', String(kind === markKind));
      }
      for (const [id, button] of styleButtons) {
        button.setAttribute('aria-pressed', String(id === styleId));
        button.disabled = markKind === 'note';
      }
    };
    syncControls();
    markButtons.get(markKind)?.focus({ preventScroll: true });
  }

  private renderReattachmentPreview(
    record: TextAnnotationRecord,
    candidate: ReattachmentCandidate,
    invoker?: HTMLElement,
  ): void {
    const inspector = this.requireElement();
    inspector.replaceChildren();
    delete inspector.dataset.inkstoneInspectorEditor;
    inspector.dataset.inkstoneReattachmentPreview = '';
    this.saveBeforeDismiss = null;
    this.rememberInvoker(invoker);
    inspector.append(this.createHeader('Confirm replacement', 'scan-text'));
    const oldQuote = this.document.createElement('p');
    oldQuote.textContent = `Original: ${record.target.quote.exact}`;
    const replacement = this.document.createElement('p');
    replacement.textContent = `Replacement: ${candidate.contextPreview}`;
    const error = this.document.createElement('span');
    error.setAttribute('role', 'alert');
    inspector.append(oldQuote, replacement, error);
    const actions = this.document.createElement('div');
    actions.className = 'inkstone-annotation-inspector__decision-actions';
    const confirm = createIconButton(this.document, {
      icon: 'check',
      label: 'Confirm reattachment',
      text: 'Confirm',
    });
    confirm.classList.add('mod-cta');
    confirm.addEventListener('click', () => {
      confirm.disabled = true;
      void this.onConfirmReattach?.(record, candidate)
        .then((repaired) => this.renderEditor(repaired, invoker))
        .catch(() => {
          confirm.disabled = false;
          error.textContent = "Couldn't reattach locally. The original target is unchanged.";
        });
    });
    const cancel = createIconButton(this.document, {
      icon: 'x',
      label: 'Cancel reattachment',
      text: 'Cancel',
    });
    cancel.addEventListener('click', () => this.renderEditor(record, invoker));
    actions.append(cancel, confirm);
    inspector.append(actions);
    confirm.focus({ preventScroll: true });
  }

  private renderDeleted(record: TextAnnotationRecord, invoker?: HTMLElement): void {
    const inspector = this.requireElement();
    inspector.replaceChildren();
    delete inspector.dataset.inkstoneInspectorEditor;
    inspector.dataset.inkstoneDeletedState = '';
    this.saveBeforeDismiss = null;
    this.rememberInvoker(invoker);
    inspector.append(this.createHeader('Annotation deleted', 'trash-2'));
    const message = this.document.createElement('p');
    message.textContent = 'Saved locally. You can undo this deletion.';
    inspector.append(message);
    const undo = createIconButton(this.document, {
      icon: 'undo-2',
      label: 'Undo delete',
      text: 'Undo delete',
    });
    undo.classList.add('mod-cta');
    undo.addEventListener('click', () => {
      undo.disabled = true;
      void this.onUndo(record)
        .then((restored) => this.renderEditor(restored, invoker))
        .catch(() => {
          undo.disabled = false;
          message.textContent = "Couldn't undo locally. Retry.";
        });
    });
    inspector.append(undo);
    undo.focus({ preventScroll: true });
  }

  private createHeader(title: string, iconId: string): HTMLElement {
    const header = this.document.createElement('header');
    header.className = 'inkstone-annotation-inspector__header';
    header.append(createIcon(this.document, iconId));
    const heading = this.document.createElement('h3');
    heading.textContent = title;
    header.append(heading);
    return header;
  }

  private rememberInvoker(invoker?: HTMLElement): void {
    if (invoker === undefined) return;
    if (invoker.id.length === 0) invoker.id = `inkstone-invoker-${crypto.randomUUID()}`;
    this.requireElement().dataset.inkstoneInvokerId = invoker.id;
  }

  private requireElement(): HTMLDivElement {
    if (this.element === null) throw new Error('Annotation inspector is not open.');
    return this.element;
  }
}

function markTypeLabel(kind: 'highlight' | 'note' | 'underline'): string {
  if (kind === 'highlight') return 'Highlight';
  if (kind === 'underline') return 'Underline';
  return 'Note';
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
