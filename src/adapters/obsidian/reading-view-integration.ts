import type {
  AnnotationService,
  PendingTextSelection,
  ResolveHighlightsResult,
} from '../../application/annotation-service';
import {
  locateRenderedBlockSourceRange,
  mapRenderedRangeToSource,
  mapSourceRangeToRendered,
} from '../../domain/rendered-source-map';
import {
  annotationIdsAtElement,
  cleanupHighlights,
  renderHighlightPlan,
  renderNoteAnchorIndicator,
} from '../../ui/reading-highlight-renderer';
import { ReadingAnnotationController } from './reading-annotation-controller';
import { captureReadingSelection, SUPPORTED_BLOCK_SELECTOR } from './reading-selection';
import type { DiagnosticMetricName } from '../../runtime/diagnostics';
import { NoteComposer } from '../../ui/note-composer';
import {
  DEFAULT_STYLE_PRESETS,
  StylePresetCatalog,
  type StylePreset,
} from '../../domain/style-preset';

export interface ReadingSectionInfo {
  readonly lineEnd: number;
  readonly lineStart: number;
  readonly text: string;
}

export interface ReadingSectionMountInput {
  readonly filePath: string;
  readonly getFullSource: () => Promise<string>;
  readonly getSectionInfo: (element: HTMLElement) => ReadingSectionInfo | null;
  readonly root: HTMLElement;
}

interface ReadingViewDelegate {
  context: ReadingSectionMountInput;
  dispose: () => void;
}

export class ReadingViewIntegration {
  private readonly controller: ReadingAnnotationController;
  private readonly composers = new Set<NoteComposer>();
  private readonly document: Document;
  private readonly onIssue: (error: unknown) => void;
  private readonly onAnnotationHit: (
    annotationIds: readonly string[],
    invoker: HTMLElement,
  ) => void;
  private readonly now: () => number;
  private readonly recordDuration: (name: DiagnosticMetricName, durationMs: number) => void;
  private readonly pulseTimeouts = new Set<ReturnType<typeof setTimeout>>();
  private presets: readonly StylePreset[];
  private readonly resolvedCache = new Map<
    string,
    { readonly result: Promise<ResolveHighlightsResult>; readonly source: string }
  >();
  private readonly sourceArtifacts = new Map<
    string,
    {
      readonly blockRanges: Map<string, { readonly end: number; readonly start: number }>;
      readonly lineOffsets: readonly number[];
      readonly source: string;
    }
  >();
  private readonly viewDelegates = new Map<HTMLElement, ReadingViewDelegate>();
  private readonly sectionCleanups = new Set<() => void>();
  private readonly sectionCleanupByRoot = new Map<HTMLElement, () => void>();
  private readonly autoPrunableSections = new Set<HTMLElement>();
  private readonly sectionObserver: MutationObserver | null;
  private sectionPruneTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly sections = new Map<HTMLElement, ReadingSectionMountInput>();
  private readonly service: AnnotationService;

  constructor(input: {
    readonly document: Document;
    readonly isMobile?: boolean;
    readonly now?: () => number;
    readonly onAnnotationHit?: (annotationIds: readonly string[], invoker: HTMLElement) => void;
    readonly onIssue?: (error: unknown) => void;
    readonly onRecordsChanged?: (filePath: string) => void;
    readonly presets?: readonly StylePreset[];
    readonly recordDuration?: (name: DiagnosticMetricName, durationMs: number) => void;
    readonly service: AnnotationService;
  }) {
    this.document = input.document;
    this.now = input.now ?? (() => performance.now());
    this.onAnnotationHit = input.onAnnotationHit ?? (() => undefined);
    this.onIssue = input.onIssue ?? (() => undefined);
    this.recordDuration = input.recordDuration ?? (() => undefined);
    this.presets = new StylePresetCatalog(input.presets ?? DEFAULT_STYLE_PRESETS).list();
    this.service = input.service;
    const MutationObserverConstructor = this.document.defaultView?.MutationObserver;
    this.sectionObserver =
      MutationObserverConstructor === undefined
        ? null
        : new MutationObserverConstructor(() => this.scheduleDisconnectedSectionPrune());
    if (this.document.body !== null) {
      this.sectionObserver?.observe(this.document.body, { childList: true, subtree: true });
    }
    const onRecordsChanged = input.onRecordsChanged ?? (() => undefined);
    this.controller = new ReadingAnnotationController({
      collapseSelection: () => this.document.getSelection()?.removeAllRanges(),
      document: input.document,
      onCommitted: (record) => {
        this.resolvedCache.delete(record.filePath);
        onRecordsChanged(record.filePath);
      },
      onIssue: this.onIssue,
      onOpenDetails: (record, invoker) => this.onAnnotationHit([record.id], invoker),
      onNoteDraft: async (draft, target) => {
        for (const composer of [...this.composers]) {
          await composer.close();
        }
        const composer = new NoteComposer({
          anchorRect: target.anchorRect,
          document: this.document,
          draft,
          layout: input.isMobile === true ? 'bottom-sheet' : 'anchored',
          onClose: () => {
            this.composers.delete(composer);
            onRecordsChanged(draft.filePath);
            void this.refreshFile(draft.filePath).catch(this.onIssue);
          },
          onIssue: this.onIssue,
          service: input.service,
        });
        this.composers.add(composer);
        composer.show();
      },
      onRenderCommitted: async (record) => {
        const mounted = [...this.sections.values()].some(
          (section) => section.filePath === record.filePath,
        );
        if (!mounted) {
          return false;
        }
        await this.refreshFile(record.filePath);
        return true;
      },
      service: input.service,
      presets: this.presets,
    });
  }

  async mountSection(input: ReadingSectionMountInput): Promise<() => void> {
    const startedAt = this.now();
    await this.restoreSection(input);
    this.recordDuration('reading-section-render', this.now() - startedAt);
    const delegateRoot = input.root.closest<HTMLElement>('.markdown-reading-view') ?? input.root;
    this.ensureViewDelegate(delegateRoot, { ...input, root: delegateRoot });
    this.sections.set(input.root, input);

    const cleanup = (): void => {
      if (!this.sectionCleanups.delete(cleanup)) {
        return;
      }
      this.sectionCleanupByRoot.delete(input.root);
      this.autoPrunableSections.delete(input.root);
      if (delegateRoot === input.root) this.removeViewDelegate(delegateRoot);
      this.sections.delete(input.root);
      for (const composer of this.composers) {
        void composer.close();
      }
      this.controller.disposeSection(input.root);
      cleanupHighlights(input.root);
    };
    this.sectionCleanups.add(cleanup);
    this.sectionCleanupByRoot.set(input.root, cleanup);
    this.autoPrunableSections.add(input.root);
    if (!input.root.isConnected) this.scheduleDisconnectedSectionPrune();
    return cleanup;
  }

  dispose(): void {
    this.sectionObserver?.disconnect();
    if (this.sectionPruneTimeout !== null) clearTimeout(this.sectionPruneTimeout);
    this.sectionPruneTimeout = null;
    for (const cleanup of [...this.sectionCleanups]) {
      cleanup();
    }
    for (const delegate of this.viewDelegates.values()) delegate.dispose();
    this.viewDelegates.clear();
    this.resolvedCache.clear();
    this.sourceArtifacts.clear();
    for (const timeout of this.pulseTimeouts) {
      clearTimeout(timeout);
    }
    this.pulseTimeouts.clear();
    for (const composer of this.composers) {
      composer.dispose();
    }
    this.composers.clear();
    this.controller.dispose();
  }

  private scheduleDisconnectedSectionPrune(): void {
    if (this.sectionPruneTimeout !== null) clearTimeout(this.sectionPruneTimeout);
    this.sectionPruneTimeout = setTimeout(() => {
      this.sectionPruneTimeout = null;
      for (const root of [...this.autoPrunableSections]) {
        if (!root.isConnected) this.sectionCleanupByRoot.get(root)?.();
      }
      for (const root of this.viewDelegates.keys()) {
        if (!root.isConnected) this.removeViewDelegate(root);
      }
    }, 10_000);
  }

  private ensureViewDelegate(root: HTMLElement, context: ReadingSectionMountInput): void {
    const existing = this.viewDelegates.get(root);
    if (existing !== undefined) {
      existing.context = context;
      return;
    }
    const delegate = {} as ReadingViewDelegate;
    const showToolbar = (): void => {
      void this.showToolbarForSelection(delegate.context).catch(this.onIssue);
    };
    const inspectAnnotations = (event: Event): void => this.inspectAnnotationEvent(event);
    delegate.context = context;
    delegate.dispose = () => {
      root.removeEventListener('mouseup', showToolbar);
      root.removeEventListener('touchend', showToolbar);
      root.removeEventListener('keyup', showToolbar);
      root.removeEventListener('click', inspectAnnotations);
    };
    root.addEventListener('mouseup', showToolbar);
    root.addEventListener('touchend', showToolbar);
    root.addEventListener('keyup', showToolbar);
    root.addEventListener('click', inspectAnnotations);
    this.viewDelegates.set(root, delegate);
  }

  private removeViewDelegate(root: HTMLElement): void {
    this.viewDelegates.get(root)?.dispose();
    this.viewDelegates.delete(root);
  }

  private inspectAnnotationEvent(event: Event): void {
    const target = event.target;
    const ElementConstructor = this.document.defaultView?.Element;
    if (ElementConstructor === undefined || !(target instanceof ElementConstructor)) return;
    const ids = annotationIdsAtElement(target);
    const invoker = target.closest<HTMLElement>('[data-inkstone-annotation-id]');
    if (ids.length > 0 && invoker !== null) this.onAnnotationHit(ids, invoker);
  }

  dismissTransientSelectionUi(): void {
    this.controller.dispose();
    this.document.getSelection()?.removeAllRanges();
  }

  async applyLastHighlightToCurrentSelection(): Promise<boolean> {
    const prepared = await this.prepareCurrentSelection();
    if (!prepared) {
      return false;
    }
    await this.controller.applyRecentHighlight();
    return true;
  }

  async addNoteToCurrentSelection(): Promise<boolean> {
    const prepared = await this.prepareCurrentSelection();
    if (!prepared) {
      return false;
    }
    await this.controller.addNote();
    return true;
  }

  async setPresets(presets: readonly StylePreset[]): Promise<void> {
    this.presets = new StylePresetCatalog(presets).list();
    this.controller.setPresets(this.presets);
    for (const section of this.sections.values()) {
      await this.restoreSection(section);
    }
  }

  async refreshAnnotations(filePath: string): Promise<void> {
    await this.refreshFile(filePath);
  }

  async captureCurrentSelection(): Promise<PendingTextSelection | null> {
    const selection = this.document.getSelection();
    if (selection === null || selection.rangeCount !== 1 || selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const context = await this.contextForRange(range);
    if (context === null) return null;
    const captured = captureReadingSelection(context.readingRoot, range);
    if (!captured.supported) return null;
    const mapped = captured.fragments.map((fragment) =>
      mapRenderedRangeToSource({
        renderedEnd: fragment.renderedEnd,
        renderedStart: fragment.renderedStart,
        renderedText: fragment.block.textContent ?? '',
        sectionSource: context.sectionSource,
        sectionSourceStart: context.sectionSourceStart,
      }),
    );
    const first = mapped[0];
    const last = mapped.at(-1);
    if (first === undefined || last === undefined) return null;
    return this.service.prepareSelection({
      filePath: context.filePath,
      selection: {
        displayText: captured.exact,
        end: last.end,
        scope: context.scope,
        start: first.start,
      },
      source: context.source,
    });
  }

  focusAnnotation(annotationId: string): boolean {
    for (const root of this.sections.keys()) {
      const target = [...root.querySelectorAll<HTMLElement>('[data-inkstone-annotation-id]')].find(
        (element) => annotationIdsAtElement(element).includes(annotationId),
      );
      if (target === undefined) {
        continue;
      }
      target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      target.classList.add('inkstone-annotation-pulse');
      const timeout = setTimeout(() => {
        this.pulseTimeouts.delete(timeout);
        target.classList.remove('inkstone-annotation-pulse');
      }, 1_200);
      this.pulseTimeouts.add(timeout);
      return true;
    }
    return false;
  }

  private async restoreSection(input: ReadingSectionMountInput): Promise<void> {
    cleanupHighlights(input.root);
    const source = await input.getFullSource();
    const artifacts = this.artifactsFor(input.filePath, source);
    const loaded = await this.loadResolved(input.filePath, source);
    for (const issue of loaded.issues) {
      this.onIssue(issue);
    }
    if (loaded.resolved.length === 0) return;

    for (const block of supportedBlocks(input.root)) {
      const info = input.getSectionInfo(block);
      if (info === null) {
        continue;
      }
      const sectionSourceStart = sourceOffsetForSectionWithOffsets(
        source,
        info,
        artifacts.lineOffsets,
      );
      let blockSourceRange: { readonly end: number; readonly start: number };
      try {
        const renderedText = block.textContent ?? '';
        const artifactKey = `${sectionSourceStart}:${renderedText}`;
        blockSourceRange =
          artifacts.blockRanges.get(artifactKey) ??
          locateRenderedBlockSourceRange({
            renderedText,
            sectionSource: info.text,
            sectionSourceStart,
          });
        artifacts.blockRanges.set(artifactKey, blockSourceRange);
      } catch {
        continue;
      }
      const intervals = [];
      const noteAnchors: Array<{ readonly annotationId: string; readonly offset: number }> = [];
      for (const resolved of loaded.resolved) {
        if (resolved.record.status !== 'active') {
          continue;
        }
        if (resolved.end <= blockSourceRange.start || resolved.start >= blockSourceRange.end) {
          continue;
        }
        try {
          const fragmentStart = Math.max(resolved.start, blockSourceRange.start);
          const fragmentEnd = Math.min(resolved.end, blockSourceRange.end);
          const fragmentExact = source.slice(fragmentStart, fragmentEnd);
          const mapped = mapSourceRangeToRendered({
            exact: fragmentExact,
            renderedText: block.textContent ?? '',
            sectionSource: info.text,
            sectionSourceStart,
            sourceEnd: fragmentEnd,
            sourceStart: fragmentStart,
          });
          if (resolved.record.mark === undefined) {
            if (resolved.end === fragmentEnd) {
              noteAnchors.push({ annotationId: resolved.record.id, offset: mapped.end });
            }
          } else {
            intervals.push({
              annotationId: resolved.record.id,
              end: mapped.end,
              kind: resolved.record.mark.kind,
              start: mapped.start,
              styleId: resolved.record.mark.styleId,
              updatedAt: resolved.record.updatedAt,
            });
          }
        } catch {
          // This record belongs to another block, or the block uses restricted Markdown.
        }
      }
      if (intervals.length > 0) {
        const fragments = renderHighlightPlan(block, intervals);
        for (const fragment of fragments) {
          const preset = this.presets.find(
            (candidate) => candidate.id === fragment.dataset.inkstoneStyleId,
          );
          if (preset !== undefined) {
            fragment.style.setProperty('--text-highlight-bg', preset.color);
            fragment.style.setProperty('--inkstone-underline-color', preset.color);
          }
        }
      }
      for (const point of noteAnchors) {
        renderNoteAnchorIndicator(block, point);
      }
    }
  }

  private loadResolved(filePath: string, source: string): Promise<ResolveHighlightsResult> {
    const cached = this.resolvedCache.get(filePath);
    if (cached !== undefined && cached.source === source) {
      return cached.result;
    }
    const result = this.service.resolveHighlights({ filePath, source });
    this.resolvedCache.set(filePath, { result, source });
    return result;
  }

  private async refreshFile(filePath: string): Promise<void> {
    this.resolvedCache.delete(filePath);
    for (const section of this.sections.values()) {
      if (section.filePath === filePath) {
        await this.restoreSection(section);
      }
    }
  }

  private artifactsFor(
    filePath: string,
    source: string,
  ): {
    readonly blockRanges: Map<string, { readonly end: number; readonly start: number }>;
    readonly lineOffsets: readonly number[];
    readonly source: string;
  } {
    const cached = this.sourceArtifacts.get(filePath);
    if (cached !== undefined && cached.source === source) {
      return cached;
    }
    const artifacts = { blockRanges: new Map(), lineOffsets: buildLineOffsets(source), source };
    this.sourceArtifacts.set(filePath, artifacts);
    return artifacts;
  }

  private async showToolbarForSelection(input: ReadingSectionMountInput): Promise<void> {
    const startedAt = this.now();
    const selection = this.document.getSelection();
    if (selection === null || selection.rangeCount !== 1 || selection.isCollapsed) {
      return;
    }
    const range = selection.getRangeAt(0);
    const block = findSupportedBlock(range.startContainer);
    if (block === null) {
      return;
    }
    const context = await this.contextForRange(range);
    if (context === null || context.filePath !== input.filePath) {
      this.onIssue(new Error('Obsidian did not provide Markdown section information.'));
      return;
    }
    const blockRect = block.getBoundingClientRect();
    const anchorRect =
      typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : blockRect;

    const shown = await this.controller.showForRange({
      anchorRect,
      filePath: context.filePath,
      fullSource: context.source,
      range,
      readingRoot: context.readingRoot,
      scope: context.scope,
      sectionSource: context.sectionSource,
      sectionSourceStart: context.sectionSourceStart,
    });
    if (shown.supported) {
      this.recordDuration('quick-toolbar-open', this.now() - startedAt);
    } else if (shown.reason === 'source-mapping-failed') {
      this.onIssue(
        shown.error ?? new Error('Rendered selection could not be mapped to Markdown source.'),
      );
    }
  }

  private async contextForRange(range: Range): Promise<{
    readonly filePath: string;
    readonly readingRoot: HTMLElement;
    readonly scope: { readonly sectionEndLine: number; readonly sectionStartLine: number };
    readonly sectionSource: string;
    readonly sectionSourceStart: number;
    readonly source: string;
  } | null> {
    const startBlock = findSupportedBlock(range.startContainer);
    const endBlock = findSupportedBlock(range.endContainer);
    if (startBlock === null || endBlock === null) return null;
    const startSection = this.contextContaining(startBlock);
    const endSection = this.contextContaining(endBlock);
    if (
      startSection === undefined ||
      endSection === undefined ||
      startSection.filePath !== endSection.filePath
    ) {
      return null;
    }
    const startInfo = startSection.getSectionInfo(startBlock);
    const endInfo = endSection.getSectionInfo(endBlock);
    if (startInfo === null || endInfo === null) return null;
    const source = await startSection.getFullSource();
    const artifacts = this.artifactsFor(startSection.filePath, source);
    const sameSourceSection =
      startInfo.text === endInfo.text && startInfo.lineStart === endInfo.lineStart;
    return {
      filePath: startSection.filePath,
      readingRoot: commonAncestorElement(range),
      scope: {
        sectionEndLine: Math.max(startInfo.lineEnd, endInfo.lineEnd),
        sectionStartLine: Math.min(startInfo.lineStart, endInfo.lineStart),
      },
      sectionSource: sameSourceSection ? startInfo.text : source,
      sectionSourceStart: sameSourceSection
        ? sourceOffsetForSectionWithOffsets(source, startInfo, artifacts.lineOffsets)
        : 0,
      source,
    };
  }

  private async prepareCurrentSelection(): Promise<boolean> {
    const selection = this.document.getSelection();
    if (selection === null || selection.rangeCount !== 1 || selection.isCollapsed) {
      return false;
    }
    const range = selection.getRangeAt(0);
    const section =
      this.contextContaining(range.startContainer) ?? this.contextContaining(range.endContainer);
    if (section === undefined) return false;
    await this.showToolbarForSelection(section);
    return this.document.querySelector('[data-inkstone-quick-toolbar][role="toolbar"]') !== null;
  }

  private contextContaining(node: Node): ReadingSectionMountInput | undefined {
    return (
      [...this.sections.values()].find((candidate) => candidate.root.contains(node)) ??
      [...this.viewDelegates.values()]
        .map((delegate) => delegate.context)
        .find((candidate) => candidate.root.contains(node))
    );
  }
}

function commonAncestorElement(range: Range): HTMLElement {
  const ancestor = range.commonAncestorContainer;
  if (ancestor instanceof HTMLElement) return ancestor;
  const parent = ancestor.parentElement;
  if (parent === null) throw new Error('Reading selection has no common element ancestor.');
  return parent;
}

export function sourceOffsetAtLine(source: string, zeroBasedLine: number): number {
  return sourceOffsetAtLineFromOffsets(zeroBasedLine, buildLineOffsets(source));
}

function sourceOffsetAtLineFromOffsets(zeroBasedLine: number, offsets: readonly number[]): number {
  if (!Number.isInteger(zeroBasedLine) || zeroBasedLine < 0) {
    throw new Error('Source line must be a non-negative integer.');
  }
  const offset = offsets[zeroBasedLine];
  if (offset === undefined) {
    throw new Error(`Source does not contain line ${zeroBasedLine}.`);
  }
  return offset;
}

export function sourceOffsetForSection(source: string, info: ReadingSectionInfo): number {
  return sourceOffsetForSectionWithOffsets(source, info, buildLineOffsets(source));
}

function sourceOffsetForSectionWithOffsets(
  source: string,
  info: ReadingSectionInfo,
  offsets: readonly number[],
): number {
  const lineOffset = sourceOffsetAtLineFromOffsets(info.lineStart, offsets);
  if (source.slice(lineOffset, lineOffset + info.text.length) === info.text) {
    return lineOffset;
  }

  const firstMatch = source.indexOf(info.text);
  if (firstMatch >= 0 && source.indexOf(info.text, firstMatch + 1) < 0) {
    return firstMatch;
  }
  throw new Error('Markdown section text has no unique position in the current source.');
}

function buildLineOffsets(source: string): readonly number[] {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function supportedBlocks(root: HTMLElement): readonly HTMLElement[] {
  const descendants = [...root.querySelectorAll<HTMLElement>(SUPPORTED_BLOCK_SELECTOR)];
  return root.matches(SUPPORTED_BLOCK_SELECTOR) ? [root, ...descendants] : descendants;
}

function findSupportedBlock(node: Node): HTMLElement | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>(SUPPORTED_BLOCK_SELECTOR) ?? null;
}
