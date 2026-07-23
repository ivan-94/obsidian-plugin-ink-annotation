import {
  type AnnotationService,
  type PendingTextSelection,
} from '../../application/annotation-service';
import {
  buildSourceProjection,
  OBSIDIAN_SOURCE_DIALECT_VERSION,
  type SourceProjection,
} from '../../domain/source-projection';
import { DEFAULT_STYLE_PRESETS, type StylePreset } from '../../domain/style-preset';
import type { TextStructuralScope } from '../../domain/text-annotation';
import type { TextAnnotationRecord } from '../../domain/text-annotation';
import {
  QuickHighlightToolbar,
  type QuickToolbarAction,
  type QuickToolbarLayout,
} from '../../ui/quick-highlight-toolbar';
import { renderHighlight } from '../../ui/reading-highlight-renderer';
import { captureReadingSelection } from './reading-selection';
import {
  bindReadingBlocks,
  isOwnedReadingTextNode,
  type ReadingBlockBinding,
  ReadingSourceProjectionError,
  type ReadingSourceProjectionFailureCode,
  mapReadingSelectionToSource,
} from './reading-source-projection';

interface PendingRenderTarget {
  readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
  readonly block: HTMLElement;
  readonly fragments: readonly CommittedRenderFragment[];
  readonly renderedEnd: number;
  readonly renderedStart: number;
  readonly selection: PendingTextSelection;
}

export interface CommittedRenderFragment {
  readonly block: HTMLElement;
  readonly renderedEnd: number;
  readonly renderedStart: number;
}

export interface CommittedRenderTarget {
  readonly block: HTMLElement;
  readonly fragments: readonly CommittedRenderFragment[];
  readonly renderedEnd: number;
  readonly renderedStart: number;
}

export interface NoteDraftRenderTarget extends CommittedRenderTarget {
  readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
}

export interface ShowForRangeInput {
  readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
  readonly filePath: string;
  readonly fullSource: string;
  readonly range: Range;
  readonly readingRoot: HTMLElement;
  readonly scope: TextStructuralScope;
  readonly sectionSource: string;
  readonly sectionSourceStart: number;
  readonly sourceBindings?: ReadonlyMap<HTMLElement, ReadingBlockBinding>;
  readonly sourceProjection?: SourceProjection;
}

export type ShowForRangeResult =
  | { readonly supported: true }
  | {
      readonly error?: Error;
      readonly reason: ReadingSourceProjectionFailureCode;
      readonly supported: false;
    };

export class ReadingAnnotationController {
  private pending: PendingRenderTarget | null = null;
  private readonly collapseSelection: () => void;
  private readonly onCommitted: (record: TextAnnotationRecord) => void;
  private readonly onNoteDraft: (
    draft: TextAnnotationRecord,
    target: NoteDraftRenderTarget,
  ) => Promise<void>;
  private readonly onOpenDetails: (
    record: TextAnnotationRecord,
    invoker: HTMLElement,
  ) => void | Promise<void>;
  private readonly onRenderCommitted: (
    record: TextAnnotationRecord,
    target: CommittedRenderTarget,
  ) => Promise<boolean>;
  private readonly onSnapshotFallback: () => Promise<void>;
  private readonly service: AnnotationService;
  private presets: readonly StylePreset[];
  private recentStyleId: string;
  private readonly toolbar: QuickHighlightToolbar;

  constructor(input: {
    readonly collapseSelection: () => void;
    readonly document: Document;
    readonly onCommitted?: (record: TextAnnotationRecord) => void;
    readonly onIssue?: (error: unknown) => void;
    readonly onOpenDetails?: (
      record: TextAnnotationRecord,
      invoker: HTMLElement,
    ) => void | Promise<void>;
    readonly onNoteDraft?: (
      draft: TextAnnotationRecord,
      target: NoteDraftRenderTarget,
    ) => Promise<void>;
    readonly onRenderCommitted?: (
      record: TextAnnotationRecord,
      target: CommittedRenderTarget,
    ) => Promise<boolean>;
    readonly onSnapshotFallback?: () => Promise<void> | void;
    readonly service: AnnotationService;
    readonly presets?: readonly StylePreset[];
    readonly toolbarLayout?: QuickToolbarLayout;
  }) {
    const mobileActionBar = input.toolbarLayout === 'mobile-action-bar';
    this.collapseSelection = input.collapseSelection;
    this.onCommitted = input.onCommitted ?? (() => undefined);
    this.onNoteDraft = input.onNoteDraft ?? (() => Promise.resolve());
    this.onOpenDetails = input.onOpenDetails ?? (() => undefined);
    this.onRenderCommitted = input.onRenderCommitted ?? (() => Promise.resolve(false));
    this.onSnapshotFallback = async () => input.onSnapshotFallback?.();
    this.service = input.service;
    this.presets = input.presets ?? DEFAULT_STYLE_PRESETS;
    const defaultStyleId = this.presets[0]?.id;
    if (defaultStyleId === undefined) {
      throw new Error('Reading annotation controller requires a style preset.');
    }
    this.recentStyleId = defaultStyleId;
    this.toolbar = new QuickHighlightToolbar({
      document: input.document,
      ...(input.toolbarLayout === undefined ? {} : { layout: input.toolbarLayout }),
      onAction: async (action) => this.commit(action),
      onDismiss: () => {
        const pending = this.pending;
        this.pending = null;
        if (pending !== null) {
          this.collapseSelection();
          if (!mobileActionBar) focusReadingBlock(pending.block);
        }
      },
      onError: input.onIssue ?? (() => undefined),
    });
  }

  async showForRange(input: ShowForRangeInput): Promise<ShowForRangeResult> {
    const captured = captureReadingSelection(input.readingRoot, input.range);
    if (!captured.supported) {
      const reason = normalizeCaptureFailure(captured.reason);
      return this.reject(input.anchorRect, reason);
    }

    let mapped: { readonly end: number; readonly exact: string; readonly start: number };
    try {
      const projection =
        input.sourceProjection ??
        buildSourceProjection({
          dialectVersion: OBSIDIAN_SOURCE_DIALECT_VERSION,
          filePath: input.filePath,
          source: input.fullSource,
          sourceRevision: `interaction:${input.fullSource.length}`,
        });
      const bindingResult =
        input.sourceBindings === undefined
          ? bindReadingBlocks({
              projection,
              root: input.readingRoot,
              sectionRange: () => ({
                end: input.sectionSourceStart + input.sectionSource.length,
                start: input.sectionSourceStart,
              }),
            })
          : { bindings: input.sourceBindings, failures: [] };
      const selectedFailure = bindingResult.failures.find((failure) =>
        captured.fragments.some((fragment) => fragment.block === failure.element),
      );
      if (selectedFailure !== undefined) {
        throw new ReadingSourceProjectionError(
          selectedFailure.code,
          `Reading View block could not bind to source (${selectedFailure.code}).`,
        );
      }
      mapped = mapReadingSelectionToSource({
        bindings: bindingResult.bindings,
        fragments: captured.fragments,
        source: input.fullSource,
      });
    } catch (error) {
      const reason =
        error instanceof ReadingSourceProjectionError ? error.code : ('internal-error' as const);
      return this.reject(
        input.anchorRect,
        reason,
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    const selection = await this.service.prepareSelection({
      filePath: input.filePath,
      selection: {
        displayText: captured.exact,
        end: mapped.end,
        scope: input.scope,
        start: mapped.start,
      },
      source: input.fullSource,
    });
    this.pending = {
      anchorRect: input.anchorRect,
      block: captured.block,
      fragments: captured.fragments,
      renderedEnd: captured.renderedEnd,
      renderedStart: captured.renderedStart,
      selection,
    };
    this.toolbar.show({
      anchorRect: input.anchorRect,
      presets: this.presets,
      recentStyleId: this.recentStyleId,
    });
    return { supported: true };
  }

  showProjectionFailure(
    anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>,
    error: unknown,
  ): ShowForRangeResult {
    const reason =
      error instanceof ReadingSourceProjectionError ? error.code : ('internal-error' as const);
    return this.reject(
      anchorRect,
      reason,
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  dispose(): void {
    this.pending = null;
    this.toolbar.close(false);
  }

  disposeSection(root: HTMLElement): void {
    if (this.pending !== null && root.contains(this.pending.block)) {
      this.dispose();
    }
  }

  async applyRecentHighlight(): Promise<void> {
    await this.commit({ kind: 'highlight', styleId: this.recentStyleId });
    this.toolbar.close(false);
  }

  async addNote(): Promise<void> {
    await this.commit({ kind: 'add-note' });
    this.toolbar.close(false);
  }

  setPresets(presets: readonly StylePreset[]): void {
    if (presets.length === 0) {
      throw new Error('Reading annotation controller requires a style preset.');
    }
    this.presets = presets;
    if (!presets.some((preset) => preset.id === this.recentStyleId)) {
      this.recentStyleId = presets[0]?.id ?? this.recentStyleId;
    }
  }

  private async commit(action: QuickToolbarAction): Promise<void> {
    const pending = this.pending;
    if (pending === null) {
      throw new Error('No pending text selection is available.');
    }

    if (action.kind === 'add-note') {
      const draft = await this.service.beginNoteDraft(pending.selection);
      this.onCommitted(draft);
      await this.onNoteDraft(draft, pending);
      if (this.pending === pending) {
        this.pending = null;
        this.collapseSelection();
      }
      return;
    }
    const openDetails = action.kind === 'more';
    const mark = openDetails
      ? ({ kind: 'highlight', styleId: this.recentStyleId } as const)
      : action;
    const record = await this.service.commitMark(pending.selection, {
      kind: mark.kind,
      styleId: mark.styleId,
    });
    this.recentStyleId = mark.styleId;
    this.onCommitted(record);
    const renderedByHost = await this.onRenderCommitted(record, pending);
    if (this.pending !== pending) {
      return;
    }
    if (!renderedByHost) {
      const fragments = pending.fragments.flatMap((fragment) =>
        renderHighlight(
          fragment.block,
          {
            annotationId: record.id,
            end: fragment.renderedEnd,
            kind: mark.kind,
            start: fragment.renderedStart,
            styleId: mark.styleId,
          },
          (node) => isOwnedReadingTextNode(fragment.block, node),
        ),
      );
      const color = this.presets.find((preset) => preset.id === mark.styleId)?.color;
      if (color !== undefined) {
        for (const fragment of fragments) {
          fragment.style.setProperty('--text-highlight-bg', color);
          fragment.style.setProperty('--inkstone-underline-color', color);
        }
      }
    }
    this.pending = null;
    this.collapseSelection();
    if (openDetails) await this.onOpenDetails(record, pending.block);
  }

  private reject(
    anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>,
    reason: ReadingSourceProjectionFailureCode,
    error?: Error,
  ): Extract<ShowForRangeResult, { supported: false }> {
    this.pending = null;
    if (reason === 'empty-selection' || reason === 'outside-reading-view') {
      this.toolbar.close(false);
    } else {
      this.toolbar.showUnavailable({
        ...(reason === 'generated-content' || reason === 'unsupported-syntax'
          ? {
              action: {
                label: 'Annotate a snapshot instead',
                onActivate: this.onSnapshotFallback,
              },
            }
          : {}),
        anchorRect,
        message: unsupportedReasonMessage(reason),
      });
    }
    return {
      ...(error === undefined ? {} : { error }),
      reason,
      supported: false,
    };
  }
}

function focusReadingBlock(block: HTMLElement): void {
  const hadTabIndex = block.hasAttribute('tabindex');
  if (!hadTabIndex) {
    block.tabIndex = -1;
    block.addEventListener('blur', () => block.removeAttribute('tabindex'), { once: true });
  }
  block.focus({ preventScroll: true });
}

function unsupportedReasonMessage(
  reason: Exclude<
    Extract<ShowForRangeResult, { supported: false }>['reason'],
    'empty-selection' | 'outside-reading-view'
  >,
): string {
  switch (reason) {
    case 'generated-content':
      return 'This visible content cannot be traced to the current Markdown source.';
    case 'unsupported-syntax':
      return 'This Markdown feature is not selectable yet.';
    case 'non-monotonic-selection':
      return 'This visible selection does not correspond to one continuous source range.';
    case 'source-target-not-found':
      return 'Inkstone could not connect this rendered block to the current source.';
    case 'source-target-ambiguous':
      return 'More than one Markdown source target remains possible.';
    case 'stale-context':
      return 'The note or Reading View changed while Inkstone mapped this selection.';
    case 'internal-error':
      return 'Inkstone could not prepare this annotation.';
    case 'projection-warming':
      return 'Inkstone is preparing this note for selection.';
  }
}

function normalizeCaptureFailure(
  reason: Extract<ReturnType<typeof captureReadingSelection>, { supported: false }>['reason'],
): ReadingSourceProjectionFailureCode {
  switch (reason) {
    case 'empty':
      return 'empty-selection';
    case 'outside-reading-view':
      return 'outside-reading-view';
    case 'embedded-content':
    case 'generated-content':
      return 'generated-content';
    case 'cross-block':
      return 'non-monotonic-selection';
    case 'code-content':
    case 'math-content':
    case 'unsupported-block':
      return 'unsupported-syntax';
  }
}
