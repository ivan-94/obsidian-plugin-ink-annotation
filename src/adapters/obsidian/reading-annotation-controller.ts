import {
  type AnnotationService,
  type PendingTextSelection,
} from '../../application/annotation-service';
import { mapRenderedRangeToSource } from '../../domain/rendered-source-map';
import { DEFAULT_STYLE_PRESETS, type StylePreset } from '../../domain/style-preset';
import type { TextStructuralScope } from '../../domain/text-annotation';
import type { TextAnnotationRecord } from '../../domain/text-annotation';
import { QuickHighlightToolbar, type QuickToolbarAction } from '../../ui/quick-highlight-toolbar';
import { renderHighlight } from '../../ui/reading-highlight-renderer';
import { captureReadingSelection } from './reading-selection';

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
}

export type ShowForRangeResult =
  | { readonly supported: true }
  | {
      readonly error?: Error;
      readonly reason:
        | 'code-content'
        | 'cross-block'
        | 'embedded-content'
        | 'empty'
        | 'generated-content'
        | 'math-content'
        | 'outside-reading-view'
        | 'source-mapping-failed'
        | 'unsupported-block';
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
    readonly service: AnnotationService;
    readonly presets?: readonly StylePreset[];
  }) {
    this.collapseSelection = input.collapseSelection;
    this.onCommitted = input.onCommitted ?? (() => undefined);
    this.onNoteDraft = input.onNoteDraft ?? (() => Promise.resolve());
    this.onOpenDetails = input.onOpenDetails ?? (() => undefined);
    this.onRenderCommitted = input.onRenderCommitted ?? (() => Promise.resolve(false));
    this.service = input.service;
    this.presets = input.presets ?? DEFAULT_STYLE_PRESETS;
    const defaultStyleId = this.presets[0]?.id;
    if (defaultStyleId === undefined) {
      throw new Error('Reading annotation controller requires a style preset.');
    }
    this.recentStyleId = defaultStyleId;
    this.toolbar = new QuickHighlightToolbar({
      document: input.document,
      onAction: async (action) => this.commit(action),
      onDismiss: () => {
        const pending = this.pending;
        this.pending = null;
        if (pending !== null) {
          focusReadingBlock(pending.block);
        }
      },
      onError: input.onIssue ?? (() => undefined),
    });
  }

  async showForRange(input: ShowForRangeInput): Promise<ShowForRangeResult> {
    const captured = captureReadingSelection(input.readingRoot, input.range);
    if (!captured.supported) {
      this.pending = null;
      if (captured.reason === 'empty' || captured.reason === 'outside-reading-view') {
        this.toolbar.close(false);
      } else {
        this.toolbar.showUnavailable({
          anchorRect: input.anchorRect,
          message: unsupportedReasonMessage(captured.reason),
        });
      }
      return captured;
    }

    let mapped: ReturnType<typeof mapRenderedRangeToSource>;
    try {
      const mappedFragments = captured.fragments.map((fragment) =>
        mapRenderedRangeToSource({
          renderedEnd: fragment.renderedEnd,
          renderedStart: fragment.renderedStart,
          renderedText: fragment.block.textContent ?? '',
          sectionSource: input.sectionSource,
          sectionSourceStart: input.sectionSourceStart,
        }),
      );
      const first = mappedFragments[0];
      const last = mappedFragments.at(-1);
      if (first === undefined || last === undefined || last.end <= first.start) {
        throw new Error('Cross-block selection has no stable source span.');
      }
      mapped = {
        end: last.end,
        exact: input.fullSource.slice(first.start, last.end),
        start: first.start,
      };
    } catch (error) {
      this.pending = null;
      this.toolbar.showUnavailable({
        anchorRect: input.anchorRect,
        message: unsupportedReasonMessage('source-mapping-failed'),
      });
      return {
        error: error instanceof Error ? error : new Error(String(error)),
        reason: 'source-mapping-failed',
        supported: false,
      };
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
        renderHighlight(fragment.block, {
          annotationId: record.id,
          end: fragment.renderedEnd,
          kind: mark.kind,
          start: fragment.renderedStart,
          styleId: mark.styleId,
        }),
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
    'empty' | 'outside-reading-view'
  >,
): string {
  switch (reason) {
    case 'code-content':
      return 'Code selections cannot be mapped to stable Markdown text.';
    case 'embedded-content':
      return 'Embedded note text belongs to another source file.';
    case 'generated-content':
      return 'Generated content cannot be mapped to stable Markdown source.';
    case 'math-content':
      return 'Partial rendered math selections are not supported.';
    case 'cross-block':
      return 'Selections across different block types are not supported.';
    case 'source-mapping-failed':
      return 'This selection is ambiguous in the Markdown source.';
    case 'unsupported-block':
      return 'This Markdown block is not supported yet.';
  }
}
