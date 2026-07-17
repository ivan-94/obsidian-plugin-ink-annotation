import type { Extension, EditorState } from '@codemirror/state';
import { StateEffect } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';

import type {
  AnnotationService,
  PendingTextSelection,
  ResolveHighlightsResult,
} from '../../application/annotation-service';
import {
  buildEditorAnnotationProjection,
  mapEditorAnnotationProjection,
  type EditorAnnotationProjection,
} from '../../domain/editor-annotation-projection';
import { DEFAULT_STYLE_PRESETS, type StylePreset } from '../../domain/style-preset';
import type { TextAnnotationRecord, TextStructuralScope } from '../../domain/text-annotation';
import { QuickHighlightToolbar, type QuickToolbarAction } from '../../ui/quick-highlight-toolbar';

export interface LivePreviewContext {
  readonly filePath: string | null;
  readonly livePreview: boolean;
}

export interface LivePreviewAnnotationService {
  beginNoteDraft(pending: PendingTextSelection): Promise<TextAnnotationRecord>;
  commitMark(
    pending: PendingTextSelection,
    mark: NonNullable<TextAnnotationRecord['mark']>,
  ): Promise<TextAnnotationRecord>;
  prepareSelection(
    input: Parameters<AnnotationService['prepareSelection']>[0],
  ): Promise<PendingTextSelection>;
  resolveHighlights(input: {
    readonly filePath: string;
    readonly persistChanges?: boolean;
    readonly source: string;
  }): Promise<ResolveHighlightsResult>;
}

export interface LivePreviewRefreshInput {
  readonly composing: boolean;
  readonly documentChanged: boolean;
  readonly livePreview: boolean;
  readonly viewportChanged: boolean;
}

const renderResolvedEffect = StateEffect.define<ResolveHighlightsResult['resolved']>();
const clearDecorationsEffect = StateEffect.define<null>();
const KEYBOARD_SELECTION_SETTLE_MS = 120;

export function shouldResolveLivePreviewAnnotations(input: LivePreviewRefreshInput): boolean {
  return input.livePreview && input.documentChanged && !input.composing;
}

export class LivePreviewAnnotationCoordinator {
  readonly extension: Extension;
  private active: LivePreviewAnnotationPluginValue | null = null;
  private readonly contextForState: (state: EditorState) => LivePreviewContext;
  private disposed = false;
  private readonly instances = new Set<LivePreviewAnnotationPluginValue>();
  private readonly onAnnotationHit: (
    annotationIds: readonly string[],
    invoker: HTMLElement,
  ) => void;
  private readonly onAnnotationsChanged: (filePath: string) => void | Promise<void>;
  private readonly onIssue: (error: unknown) => void;
  private readonly onNoteDraft: (
    draft: TextAnnotationRecord,
    anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>,
  ) => void | Promise<void>;
  private readonly resolveDelayMs: number;
  private readonly service: LivePreviewAnnotationService;
  private readonly styleColor: (styleId: string) => string | undefined;
  private readonly presets: readonly StylePreset[];
  private recentStyleId: string;
  private selectionToolbarTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly toolbar: QuickHighlightToolbar | null;

  constructor(input: {
    readonly contextForState: (state: EditorState) => LivePreviewContext;
    readonly document?: Document;
    readonly enabled?: boolean;
    readonly onAnnotationHit?: (annotationIds: readonly string[], invoker: HTMLElement) => void;
    readonly onAnnotationsChanged?: (filePath: string) => void | Promise<void>;
    readonly onIssue?: (error: unknown) => void;
    readonly onNoteDraft?: (
      draft: TextAnnotationRecord,
      anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>,
    ) => void | Promise<void>;
    readonly resolveDelayMs?: number;
    readonly presets?: readonly StylePreset[];
    readonly service: LivePreviewAnnotationService;
    readonly styleColor?: (styleId: string) => string | undefined;
  }) {
    const enabled = input.enabled ?? true;
    this.contextForState = input.contextForState;
    this.onAnnotationHit = input.onAnnotationHit ?? (() => undefined);
    this.onAnnotationsChanged = input.onAnnotationsChanged ?? (() => undefined);
    this.onIssue = input.onIssue ?? (() => undefined);
    this.onNoteDraft = input.onNoteDraft ?? (() => undefined);
    this.resolveDelayMs = input.resolveDelayMs ?? 90;
    this.service = input.service;
    this.styleColor = input.styleColor ?? (() => undefined);
    this.presets = input.presets ?? DEFAULT_STYLE_PRESETS;
    this.recentStyleId = this.presets[0]?.id ?? 'highlight-sun';
    this.toolbar =
      !enabled || input.document === undefined
        ? null
        : new QuickHighlightToolbar({
            document: input.document,
            onAction: (action) => this.handleToolbarAction(action),
            onDismiss: () => this.activeInstance()?.view.focus(),
            onError: this.onIssue,
          });
    this.extension = enabled
      ? ViewPlugin.define((view) => new LivePreviewAnnotationPluginValue(view, this), {
          decorations: (value) => value.decorations,
          eventHandlers: {
            click: (event, view) => {
              this.activate(view);
              this.handleAnnotationHit(event);
            },
            focus: (_event, view) => {
              this.activate(view);
            },
            keyup: (_event, view) => {
              this.scheduleToolbarForKeyboardSelection(view);
            },
            mouseup: (_event, view) => {
              this.clearSelectionToolbarTimer();
              this.showToolbarForSelection(view);
            },
          },
        })
      : [];
  }

  async commitSelection(mark: NonNullable<TextAnnotationRecord['mark']>): Promise<boolean> {
    const instance = this.activeInstance();
    if (instance === null || instance.view.composing) return false;
    const context = this.contextForState(instance.view.state);
    if (!context.livePreview || context.filePath === null) return false;
    const source = instance.view.state.doc.toString();
    const selections = uniqueNonEmptySelections(instance.view);
    if (selections.length === 0) return false;

    for (const selection of selections) {
      const pending = await this.service.prepareSelection({
        filePath: context.filePath,
        selection: {
          end: selection.to,
          scope: structuralScopeAt(source, selection.from),
          start: selection.from,
        },
        source,
      });
      await this.service.commitMark(pending, mark);
    }
    this.recentStyleId = mark.styleId;
    instance.view.dispatch({ selection: { anchor: selections.at(-1)?.to ?? selections[0]!.to } });
    this.refresh(context.filePath);
    await this.onAnnotationsChanged(context.filePath);
    return true;
  }

  async addNoteToSelection(): Promise<boolean> {
    const instance = this.activeInstance();
    if (instance === null || instance.view.composing) return false;
    const context = this.contextForState(instance.view.state);
    if (!context.livePreview || context.filePath === null) return false;
    const selections = uniqueNonEmptySelections(instance.view);
    const selection = selections.length === 1 ? selections[0] : undefined;
    if (selection === undefined) return false;
    const source = instance.view.state.doc.toString();
    const pending = await this.service.prepareSelection({
      filePath: context.filePath,
      selection: {
        end: selection.to,
        scope: structuralScopeAt(source, selection.from),
        start: selection.from,
      },
      source,
    });
    const draft = await this.service.beginNoteDraft(pending);
    const anchorRect = selectionRect(instance.view, selection.from, selection.to);
    await this.onNoteDraft(draft, anchorRect);
    instance.view.dispatch({ selection: { anchor: selection.to } });
    this.refresh(context.filePath);
    return true;
  }

  refresh(filePath?: string): void {
    for (const instance of this.instances) {
      const context = this.contextForState(instance.view.state);
      if (filePath === undefined || context.filePath === filePath) {
        instance.requestResolve();
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearSelectionToolbarTimer();
    this.toolbar?.close(false);
    for (const instance of [...this.instances]) instance.clear();
    this.instances.clear();
    this.active = null;
  }

  register(instance: LivePreviewAnnotationPluginValue): void {
    if (this.disposed) {
      instance.clear();
      return;
    }
    this.instances.add(instance);
    this.active = instance;
  }

  unregister(instance: LivePreviewAnnotationPluginValue): void {
    this.instances.delete(instance);
    if (this.active === instance) this.active = null;
  }

  resolve(instance: LivePreviewAnnotationPluginValue): void {
    if (this.disposed) return;
    const context = this.contextForState(instance.view.state);
    if (!context.livePreview || context.filePath === null) {
      instance.clear();
      return;
    }
    const filePath = context.filePath;
    const source = instance.view.state.doc.toString();
    const request = instance.beginRequest();
    void this.service
      .resolveHighlights({ filePath, persistChanges: false, source })
      .then((result) => {
        if (!this.disposed && instance.isCurrentRequest(request, filePath, source)) {
          result.issues.forEach((issue) => this.onIssue(issue));
          instance.applyResolved(result.resolved);
        }
      })
      .catch(this.onIssue);
  }

  get delayMs(): number {
    return this.resolveDelayMs;
  }

  colorFor(styleId: string): string | undefined {
    const color = this.styleColor(styleId);
    return color !== undefined && isSafeCssColor(color) ? color : undefined;
  }

  context(state: EditorState): LivePreviewContext {
    return this.contextForState(state);
  }

  annotationHit(ids: readonly string[], invoker: HTMLElement): void {
    this.onAnnotationHit(ids, invoker);
  }

  private activate(view: EditorView): void {
    const instance = [...this.instances].find((candidate) => candidate.view === view);
    if (instance !== undefined) this.active = instance;
  }

  private activeInstance(): LivePreviewAnnotationPluginValue | null {
    if (this.disposed) return null;
    const focused = [...this.instances].find((instance) => instance.view.hasFocus);
    return focused ?? this.active ?? [...this.instances][0] ?? null;
  }

  private handleAnnotationHit(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const ids: string[] = [];
    let current: HTMLElement | null = target;
    while (current !== null && current.classList.contains('cm-editor') === false) {
      const encodedIds = current.dataset.inkstoneAnnotationIds;
      if (encodedIds !== undefined) {
        for (const encodedId of decodeAnnotationIds(encodedIds)) {
          if (!ids.includes(encodedId)) ids.push(encodedId);
        }
      }
      const id = current.dataset.inkstoneAnnotationId;
      if (id !== undefined && !ids.includes(id)) ids.push(id);
      current = current.parentElement;
    }
    if (ids.length > 0) this.annotationHit(ids, target);
  }

  private showToolbarForSelection(view: EditorView): void {
    this.activate(view);
    const context = this.contextForState(view.state);
    const selections = uniqueNonEmptySelections(view);
    if (!context.livePreview || context.filePath === null || selections.length === 0) {
      this.toolbar?.close(false);
      return;
    }
    const first = selections[0];
    const last = selections.at(-1);
    if (first === undefined || last === undefined) return;
    this.toolbar?.show({
      anchorRect: selectionRect(view, first.from, last.to),
      presets: this.presets,
      recentStyleId: this.recentStyleId,
    });
  }

  private scheduleToolbarForKeyboardSelection(view: EditorView): void {
    this.clearSelectionToolbarTimer();
    const context = this.contextForState(view.state);
    if (
      !context.livePreview ||
      context.filePath === null ||
      uniqueNonEmptySelections(view).length === 0
    ) {
      this.toolbar?.close(false);
      return;
    }
    this.selectionToolbarTimer = setTimeout(() => {
      this.selectionToolbarTimer = null;
      if (!this.disposed) this.showToolbarForSelection(view);
    }, KEYBOARD_SELECTION_SETTLE_MS);
  }

  private clearSelectionToolbarTimer(): void {
    if (this.selectionToolbarTimer === null) return;
    clearTimeout(this.selectionToolbarTimer);
    this.selectionToolbarTimer = null;
  }

  private async handleToolbarAction(action: QuickToolbarAction): Promise<void> {
    if (action.kind === 'more') {
      await this.openDetailsForSelection();
      return;
    }
    if (action.kind === 'add-note') {
      await this.addNoteToSelection();
      return;
    }
    await this.commitSelection({ kind: action.kind, styleId: action.styleId });
  }

  private async openDetailsForSelection(): Promise<void> {
    const instance = this.activeInstance();
    if (instance === null || instance.view.composing) return;
    const context = this.contextForState(instance.view.state);
    if (!context.livePreview || context.filePath === null) return;
    const source = instance.view.state.doc.toString();
    const selections = uniqueNonEmptySelections(instance.view);
    if (selections.length === 0) return;
    const records: TextAnnotationRecord[] = [];
    for (const selection of selections) {
      const pending = await this.service.prepareSelection({
        filePath: context.filePath,
        selection: {
          end: selection.to,
          scope: structuralScopeAt(source, selection.from),
          start: selection.from,
        },
        source,
      });
      records.push(
        await this.service.commitMark(pending, {
          kind: 'highlight',
          styleId: this.recentStyleId,
        }),
      );
    }
    instance.view.dispatch({ selection: { anchor: selections.at(-1)?.to ?? selections[0]!.to } });
    this.refresh(context.filePath);
    await this.onAnnotationsChanged(context.filePath);
    this.onAnnotationHit(
      records.map((record) => record.id),
      instance.view.contentDOM,
    );
  }
}

class LivePreviewAnnotationPluginValue {
  private contextSignature: string;
  decorations: DecorationSet = Decoration.none;
  private destroyed = false;
  private projection: EditorAnnotationProjection = { marks: [], noteAnchors: [] };
  private requestId = 0;
  private resolved: ResolveHighlightsResult['resolved'] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly view: EditorView;
  private readonly coordinator: LivePreviewAnnotationCoordinator;
  private readonly handleCompositionEnd = (): void => this.requestResolve();

  constructor(view: EditorView, coordinator: LivePreviewAnnotationCoordinator) {
    this.view = view;
    this.coordinator = coordinator;
    this.contextSignature = signatureForContext(this.coordinator.context(view.state));
    this.view.contentDOM.addEventListener('compositionend', this.handleCompositionEnd);
    this.coordinator.register(this);
    if (this.coordinator.context(view.state).livePreview) this.requestResolve();
  }

  update(update: ViewUpdate): void {
    if (this.destroyed) return;
    const context = this.coordinator.context(update.state);
    const nextContextSignature = signatureForContext(context);
    const contextChanged = nextContextSignature !== this.contextSignature;
    if (contextChanged) {
      this.contextSignature = nextContextSignature;
      this.resetDecorations();
    }
    if (!context.livePreview || context.filePath === null) {
      this.resetDecorations();
      return;
    }
    if (contextChanged) this.requestResolve();
    if (update.docChanged) {
      this.projection = mapEditorAnnotationProjection(this.projection, update.changes);
      this.decorations = decorationsForProjection(this.projection, this.coordinator);
    }
    if (update.viewportChanged && !update.docChanged) this.renderResolved();
    for (const effect of update.transactions.flatMap((transaction) => transaction.effects)) {
      if (effect.is(renderResolvedEffect)) {
        this.resolved = effect.value;
        this.renderResolved();
      } else if (effect.is(clearDecorationsEffect)) {
        this.resetDecorations();
      }
    }
    if (
      shouldResolveLivePreviewAnnotations({
        composing: update.view.composing,
        documentChanged: update.docChanged,
        livePreview: context.livePreview,
        viewportChanged: update.viewportChanged,
      })
    ) {
      this.requestResolve();
    }
  }

  requestResolve(): void {
    if (this.destroyed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.coordinator.resolve(this);
    }, this.coordinator.delayMs);
  }

  beginRequest(): number {
    this.requestId += 1;
    return this.requestId;
  }

  isCurrentRequest(requestId: number, filePath: string, source: string): boolean {
    const context = this.coordinator.context(this.view.state);
    return (
      !this.destroyed &&
      requestId === this.requestId &&
      context.livePreview &&
      context.filePath === filePath &&
      this.view.state.doc.toString() === source
    );
  }

  applyResolved(resolved: ResolveHighlightsResult['resolved']): void {
    if (!this.destroyed) this.view.dispatch({ effects: renderResolvedEffect.of(resolved) });
  }

  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.requestId += 1;
    if (!this.destroyed) this.view.dispatch({ effects: clearDecorationsEffect.of(null) });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.requestId += 1;
    this.view.contentDOM.removeEventListener('compositionend', this.handleCompositionEnd);
    this.coordinator.unregister(this);
  }

  private renderResolved(): void {
    this.projection = buildEditorAnnotationProjection(
      this.resolved,
      this.view.visibleRanges,
      this.view.state.doc.length,
    );
    this.decorations = decorationsForProjection(this.projection, this.coordinator);
  }

  private resetDecorations(): void {
    this.resolved = [];
    this.projection = { marks: [], noteAnchors: [] };
    this.decorations = Decoration.none;
  }
}

class NoteAnchorWidget extends WidgetType {
  constructor(private readonly annotationId: string) {
    super();
  }

  override eq(other: NoteAnchorWidget): boolean {
    return other.annotationId === this.annotationId;
  }

  override toDOM(view: EditorView): HTMLElement {
    const element = view.dom.ownerDocument.createElement('span');
    element.className = 'inkstone-editor-note-anchor';
    element.dataset.inkstoneAnnotationId = this.annotationId;
    element.setAttribute('aria-label', 'Open annotation note');
    element.setAttribute('role', 'button');
    element.tabIndex = 0;
    element.textContent = '◆';
    return element;
  }
}

function decorationsForProjection(
  projection: EditorAnnotationProjection,
  coordinator: LivePreviewAnnotationCoordinator,
): DecorationSet {
  const ranges = [
    ...projection.marks.map((mark) => {
      const color = coordinator.colorFor(mark.styleId);
      const underlineColor =
        mark.underlineStyleId === undefined
          ? undefined
          : coordinator.colorFor(mark.underlineStyleId);
      const className = [
        'inkstone-editor-highlight',
        ...(mark.kind === 'underline' || mark.underlineStyleId !== undefined
          ? ['inkstone-editor-underline']
          : []),
        ...(mark.kind === 'underline' ? ['inkstone-editor-underline-only'] : []),
      ].join(' ');
      const colorStyles = [
        ...(color === undefined ? [] : [`--inkstone-editor-color:${color}`]),
        ...(underlineColor === undefined
          ? []
          : [`--inkstone-editor-underline-color:${underlineColor}`]),
      ];
      return Decoration.mark({
        attributes: {
          'data-inkstone-annotation-id': mark.annotationId,
          'data-inkstone-annotation-ids': JSON.stringify(mark.annotationIds),
          'data-inkstone-style-id': mark.styleId,
          ...(colorStyles.length === 0 ? {} : { style: colorStyles.join(';') }),
        },
        class: className,
      }).range(mark.from, mark.to);
    }),
    ...projection.noteAnchors.map((anchor) =>
      Decoration.widget({ side: 1, widget: new NoteAnchorWidget(anchor.annotationId) }).range(
        anchor.offset,
      ),
    ),
  ];
  return Decoration.set(ranges, true);
}

function uniqueNonEmptySelections(view: EditorView): readonly { from: number; to: number }[] {
  const unique = new Map<string, { from: number; to: number }>();
  for (const range of view.state.selection.ranges) {
    if (range.empty) continue;
    unique.set(`${range.from}:${range.to}`, { from: range.from, to: range.to });
  }
  return [...unique.values()].sort((left, right) => left.from - right.from || left.to - right.to);
}

function structuralScopeAt(source: string, position: number): TextStructuralScope {
  let line = 0;
  for (let index = 0; index < position; index += 1) {
    if (source[index] === '\n') line += 1;
  }
  return { sectionEndLine: line, sectionStartLine: line };
}

function selectionRect(
  view: EditorView,
  from: number,
  to: number,
): Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'> {
  const start = safeCoordsAtPos(view, from);
  const end = safeCoordsAtPos(view, to);
  const fallback = view.dom.getBoundingClientRect();
  const left = Math.min(start?.left ?? 0, end?.left ?? 0);
  const right = Math.max(start?.right ?? left, end?.right ?? left);
  const top = Math.min(start?.top ?? fallback.top, end?.top ?? fallback.top);
  const bottom = Math.max(start?.bottom ?? top, end?.bottom ?? top);
  return { bottom, left, top, width: Math.max(0, right - left) };
}

function safeCoordsAtPos(
  view: EditorView,
  position: number,
): ReturnType<EditorView['coordsAtPos']> {
  try {
    return view.coordsAtPos(position);
  } catch {
    return null;
  }
}

function isSafeCssColor(color: string): boolean {
  return /^#[0-9a-f]{3,8}$/iu.test(color) || /^(?:rgb|hsl)a?\([0-9.,%\s]+\)$/iu.test(color);
}

function signatureForContext(context: LivePreviewContext): string {
  return `${context.livePreview ? 'live' : 'source'}:${context.filePath ?? ''}`;
}

function decodeAnnotationIds(encoded: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(encoded);
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
  } catch {
    return [];
  }
}
