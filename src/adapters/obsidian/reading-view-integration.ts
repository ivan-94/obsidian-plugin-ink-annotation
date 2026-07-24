import type {
  AnnotationService,
  PendingTextSelection,
  ResolveHighlightsResult,
} from '../../application/annotation-service';
import {
  mapProjectedSourceRangeToDisplay,
  OBSIDIAN_SOURCE_DIALECT_VERSION,
  sourceProjectionRevision,
  type SourceProjection,
  SourceProjectionCache,
} from '../../domain/source-projection';
import {
  annotationIdsAtElement,
  cleanupHighlights,
  renderHighlightPlan,
  renderNoteAnchorIndicator,
} from '../../ui/reading-highlight-renderer';
import { ReadingAnnotationController } from './reading-annotation-controller';
import { captureReadingSelection, SUPPORTED_BLOCK_SELECTOR } from './reading-selection';
import type { DiagnosticMetricName } from '../../runtime/diagnostics';
import {
  DEFAULT_STYLE_PRESETS,
  StylePresetCatalog,
  type StylePreset,
} from '../../domain/style-preset';
import type { TextAnnotationRecord } from '../../domain/text-annotation';
import type { I18n } from '../../ui/i18n/contract';
import type { NoteDraftRenderTarget } from './reading-annotation-controller';
import {
  bindReadingBlocks,
  isOwnedReadingTextNode,
  mapReadingSelectionToSource,
  type ReadingBlockBinding,
  type ReadingBlockBindingResult,
  ReadingSourceProjectionError,
} from './reading-source-projection';

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
  sectionRoot: HTMLElement;
}

export class ReadingViewIntegration {
  private static readonly MAX_SOURCE_ARTIFACTS = 8;

  private readonly controller: ReadingAnnotationController;
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
      readonly lineOffsets: readonly number[];
      readonly projection: SourceProjection;
      readonly source: string;
    }
  >();
  private readonly sourceArtifactInflight = new Map<
    string,
    {
      readonly promise: Promise<{
        readonly lineOffsets: readonly number[];
        readonly projection: SourceProjection;
        readonly source: string;
      }>;
      readonly source: string;
    }
  >();
  private readonly sourceProjectionCache: SourceProjectionCache;
  private readonly domBindingCache = new WeakMap<
    HTMLElement,
    {
      readonly renderEpoch: number;
      readonly result: ReadingBlockBindingResult;
      readonly sourceRevision: string;
    }
  >();
  private readonly renderEpochs = new WeakMap<HTMLElement, number>();
  private readonly viewDelegates = new Map<HTMLElement, ReadingViewDelegate>();
  private readonly viewRestoreTimeouts = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  private readonly sectionCleanups = new Set<() => void>();
  private readonly sectionCleanupByRoot = new Map<HTMLElement, () => void>();
  private readonly sectionRestoreEpochs = new WeakMap<HTMLElement, number>();
  private readonly pendingSections = new Map<HTMLElement, ReadingSectionMountInput>();
  private readonly autoPrunableSections = new Set<HTMLElement>();
  private readonly sectionObserver: MutationObserver | null;
  private sectionPruneTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly sections = new Map<HTMLElement, ReadingSectionMountInput>();
  private readonly service: AnnotationService;

  constructor(input: {
    readonly document: Document;
    readonly i18n?: I18n;
    readonly isMobile?: boolean;
    readonly now?: () => number;
    readonly onAnnotationHit?: (annotationIds: readonly string[], invoker: HTMLElement) => void;
    readonly onIssue?: (error: unknown) => void;
    readonly onNoteDraft?: (
      draft: TextAnnotationRecord,
      target: NoteDraftRenderTarget,
    ) => Promise<void> | void;
    readonly onRecordsChanged?: (filePath: string) => void;
    readonly onSnapshotFallback?: () => Promise<void> | void;
    readonly presets?: readonly StylePreset[];
    readonly recordDuration?: (name: DiagnosticMetricName, durationMs: number) => void;
    readonly service: AnnotationService;
    readonly sourceProjectionCache?: SourceProjectionCache;
  }) {
    this.document = input.document;
    this.now = input.now ?? (() => performance.now());
    this.onAnnotationHit = input.onAnnotationHit ?? (() => undefined);
    this.onIssue = input.onIssue ?? (() => undefined);
    this.recordDuration = input.recordDuration ?? (() => undefined);
    this.presets = new StylePresetCatalog(input.presets ?? DEFAULT_STYLE_PRESETS).list();
    this.service = input.service;
    this.sourceProjectionCache =
      input.sourceProjectionCache ??
      new SourceProjectionCache({
        maxEntries: ReadingViewIntegration.MAX_SOURCE_ARTIFACTS,
        maxEstimatedBytes: 16 * 1024 * 1024,
      });
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
      ...(input.i18n === undefined ? {} : { i18n: input.i18n }),
      onCommitted: (record) => {
        this.resolvedCache.delete(record.filePath);
        onRecordsChanged(record.filePath);
      },
      onIssue: this.onIssue,
      onOpenDetails: (record, invoker) => this.onAnnotationHit([record.id], invoker),
      onNoteDraft: async (draft, target) => {
        await input.onNoteDraft?.(draft, target);
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
      ...(input.onSnapshotFallback === undefined
        ? {}
        : { onSnapshotFallback: input.onSnapshotFallback }),
      service: input.service,
      presets: this.presets,
      toolbarLayout: input.isMobile === true ? 'mobile-action-bar' : 'anchored',
    });
  }

  async mountSection(input: ReadingSectionMountInput): Promise<() => void> {
    const startedAt = this.now();
    this.pendingSections.set(input.root, input);
    try {
      await this.restoreSection(input);
    } catch (error) {
      if (this.pendingSections.get(input.root) === input) {
        this.pendingSections.delete(input.root);
      }
      throw error;
    }
    if (this.pendingSections.get(input.root) !== input) {
      return () => undefined;
    }
    this.pendingSections.delete(input.root);
    this.recordDuration('reading-section-render', this.now() - startedAt);
    const delegateRoot = readingViewDelegateRoot(input.root);
    this.ensureViewDelegate(delegateRoot, { ...input, root: delegateRoot }, input.root);
    this.sections.set(input.root, input);
    this.scheduleViewRestore(delegateRoot);

    const cleanup = (): void => {
      if (!this.sectionCleanups.delete(cleanup)) {
        return;
      }
      this.sectionCleanupByRoot.delete(input.root);
      this.autoPrunableSections.delete(input.root);
      this.sections.delete(input.root);
      this.releaseViewDelegate(delegateRoot, input.root);
      if (delegateRoot.isConnected) this.scheduleViewRestore(delegateRoot);
      this.controller.disposeSection(input.root);
      this.invalidateSectionRestore(input.root);
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
    for (const timeout of this.viewRestoreTimeouts.values()) clearTimeout(timeout);
    this.viewRestoreTimeouts.clear();
    for (const root of this.pendingSections.keys()) this.invalidateSectionRestore(root);
    this.pendingSections.clear();
    for (const delegate of this.viewDelegates.values()) delegate.dispose();
    this.viewDelegates.clear();
    this.resolvedCache.clear();
    this.sourceArtifacts.clear();
    this.sourceArtifactInflight.clear();
    this.sourceProjectionCache.clear();
    for (const timeout of this.pulseTimeouts) {
      clearTimeout(timeout);
    }
    this.pulseTimeouts.clear();
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

  private ensureViewDelegate(
    root: HTMLElement,
    context: ReadingSectionMountInput,
    sectionRoot: HTMLElement,
  ): void {
    const existing = this.viewDelegates.get(root);
    if (existing !== undefined) {
      existing.context = context;
      existing.sectionRoot = sectionRoot;
      return;
    }
    const delegate = {} as ReadingViewDelegate;
    const showToolbar = (): void => {
      void this.showToolbarForSelection(delegate.context).catch(this.onIssue);
    };
    const inspectAnnotations = (event: Event): void => this.inspectAnnotationEvent(event);
    delegate.context = context;
    delegate.sectionRoot = sectionRoot;
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

  private releaseViewDelegate(root: HTMLElement, sectionRoot: HTMLElement): void {
    const delegate = this.viewDelegates.get(root);
    if (delegate === undefined || delegate.sectionRoot !== sectionRoot) return;
    const replacement = [...this.sections.values()]
      .reverse()
      .find((candidate) => readingViewDelegateRoot(candidate.root) === root);
    if (replacement === undefined) {
      this.removeViewDelegate(root);
      return;
    }
    delegate.context = { ...replacement, root };
    delegate.sectionRoot = replacement.root;
  }

  private removeViewDelegate(root: HTMLElement): void {
    this.viewDelegates.get(root)?.dispose();
    this.viewDelegates.delete(root);
    const timeout = this.viewRestoreTimeouts.get(root);
    if (timeout !== undefined) clearTimeout(timeout);
    this.viewRestoreTimeouts.delete(root);
  }

  private scheduleViewRestore(root: HTMLElement): void {
    const pending = this.viewRestoreTimeouts.get(root);
    if (pending !== undefined) clearTimeout(pending);
    const timeout = setTimeout(() => {
      this.viewRestoreTimeouts.delete(root);
      const delegate = this.viewDelegates.get(root);
      if (delegate === undefined || !root.isConnected) return;
      void this.restoreSection({ ...delegate.context, root }).catch(this.onIssue);
    }, 0);
    this.viewRestoreTimeouts.set(root, timeout);
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
    const mapped = mapReadingSelectionToSource({
      bindings: context.sourceBindings,
      fragments: captured.fragments,
      source: context.source,
    });
    return this.service.prepareSelection({
      filePath: context.filePath,
      selection: {
        displayText: captured.exact,
        end: mapped.end,
        scope: context.scope,
        start: mapped.start,
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
    const restoreEpoch = this.beginSectionRestore(input.root);
    this.invalidateDomBindings(input.root);
    const delegateRoot = readingViewDelegateRoot(input.root);
    if (delegateRoot !== input.root) this.invalidateDomBindings(delegateRoot);
    cleanupHighlights(input.root);
    const source = await input.getFullSource();
    if (!this.isCurrentSectionRestore(input.root, restoreEpoch)) return;
    // Parse while the section mounts so selection handlers only perform DOM binding and lookup.
    const artifacts = this.artifactsFor(input.filePath, source);
    const loaded = await this.loadResolved(input.filePath, source);
    if (!this.isCurrentSectionRestore(input.root, restoreEpoch)) return;
    for (const issue of loaded.issues) {
      this.onIssue(issue);
    }
    if (loaded.resolved.length === 0) return;
    const bindingResult = this.bindingsFor({
      projection: artifacts.projection,
      root: input.root,
      sectionRange: (block) => {
        const info = input.getSectionInfo(block);
        if (info === null) return null;
        try {
          const start = sourceOffsetForSectionWithOffsets(source, info, artifacts.lineOffsets);
          return { end: start + info.text.length, start };
        } catch {
          return null;
        }
      },
    });

    for (const [block, binding] of bindingResult.bindings) {
      const blockSourceRange = binding.projectedBlock;
      const intervals = [];
      const noteAnchors: Array<{ readonly annotationId: string; readonly offset: number }> = [];
      for (const resolved of loaded.resolved) {
        if (resolved.record.status !== 'active') {
          continue;
        }
        if (
          resolved.end <= blockSourceRange.sourceStart ||
          resolved.start >= blockSourceRange.sourceEnd
        ) {
          continue;
        }
        try {
          const fragmentStart = Math.max(resolved.start, blockSourceRange.sourceStart);
          const fragmentEnd = Math.min(resolved.end, blockSourceRange.sourceEnd);
          const mapped = mapProjectedSourceRangeToDisplay({
            block: binding.projectedBlock,
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
        const fragments = renderHighlightPlan(block, intervals, (node) =>
          isOwnedReadingTextNode(block, node),
        );
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
        renderNoteAnchorIndicator(block, point, (node) => isOwnedReadingTextNode(block, node));
      }
    }
  }

  private beginSectionRestore(root: HTMLElement): number {
    const epoch = (this.sectionRestoreEpochs.get(root) ?? 0) + 1;
    this.sectionRestoreEpochs.set(root, epoch);
    return epoch;
  }

  private invalidateSectionRestore(root: HTMLElement): void {
    this.sectionRestoreEpochs.set(root, (this.sectionRestoreEpochs.get(root) ?? 0) + 1);
    this.invalidateDomBindings(root);
  }

  private isCurrentSectionRestore(root: HTMLElement, epoch: number): boolean {
    return this.sectionRestoreEpochs.get(root) === epoch;
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
    const sections = new Map<HTMLElement, ReadingSectionMountInput>([
      ...this.pendingSections,
      ...this.sections,
    ]);
    for (const section of sections.values()) {
      if (section.filePath === filePath) {
        await this.restoreSection(section);
      }
    }
    for (const [root, delegate] of this.viewDelegates) {
      if (delegate.context.filePath === filePath && root.isConnected) {
        await this.restoreSection({ ...delegate.context, root });
      }
    }
  }

  private artifactsFor(
    filePath: string,
    source: string,
  ): {
    readonly lineOffsets: readonly number[];
    readonly projection: SourceProjection;
    readonly source: string;
  } {
    const cached = this.sourceArtifacts.get(filePath);
    if (cached !== undefined && cached.source === source) {
      this.sourceArtifacts.delete(filePath);
      this.sourceArtifacts.set(filePath, cached);
      return cached;
    }
    const sourceRevision = sourceProjectionRevision(source);
    const artifacts = {
      lineOffsets: buildLineOffsets(source),
      projection: this.sourceProjectionCache.getOrBuild({
        dialectVersion: OBSIDIAN_SOURCE_DIALECT_VERSION,
        filePath,
        source,
        sourceRevision,
      }),
      source,
    };
    this.sourceArtifacts.delete(filePath);
    this.sourceArtifacts.set(filePath, artifacts);
    while (this.sourceArtifacts.size > ReadingViewIntegration.MAX_SOURCE_ARTIFACTS) {
      const oldest = this.sourceArtifacts.keys().next().value;
      if (oldest === undefined) break;
      this.sourceArtifacts.delete(oldest);
    }
    return artifacts;
  }

  private artifactsForInteraction(
    filePath: string,
    source: string,
  ): Promise<{
    readonly lineOffsets: readonly number[];
    readonly projection: SourceProjection;
    readonly source: string;
  }> {
    const cached = this.sourceArtifacts.get(filePath);
    if (cached !== undefined && cached.source === source) {
      return Promise.resolve(this.artifactsFor(filePath, source));
    }
    const inflight = this.sourceArtifactInflight.get(filePath);
    if (inflight !== undefined && inflight.source === source) return inflight.promise;

    const promise = new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
      .then(() => this.artifactsFor(filePath, source))
      .finally(() => {
        if (this.sourceArtifactInflight.get(filePath)?.promise === promise) {
          this.sourceArtifactInflight.delete(filePath);
        }
      });
    this.sourceArtifactInflight.set(filePath, { promise, source });
    return promise;
  }

  private bindingsFor(input: {
    readonly projection: SourceProjection;
    readonly root: HTMLElement;
    readonly sectionRange: (
      element: HTMLElement,
    ) => { readonly end: number; readonly start: number } | null;
  }): ReadingBlockBindingResult {
    const renderEpoch = this.renderEpochs.get(input.root) ?? 0;
    const cached = this.domBindingCache.get(input.root);
    if (
      cached !== undefined &&
      cached.renderEpoch === renderEpoch &&
      cached.sourceRevision === input.projection.key.sourceRevision
    ) {
      return cached.result;
    }
    const result = bindReadingBlocks(input);
    this.domBindingCache.set(input.root, {
      renderEpoch,
      result,
      sourceRevision: input.projection.key.sourceRevision,
    });
    return result;
  }

  private invalidateDomBindings(root: HTMLElement): void {
    this.renderEpochs.set(root, (this.renderEpochs.get(root) ?? 0) + 1);
    this.domBindingCache.delete(root);
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
    const blockRect = block.getBoundingClientRect();
    const anchorRect =
      typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : blockRect;
    let context;
    try {
      context = await this.contextForRange(range);
    } catch (error) {
      this.controller.showProjectionFailure(anchorRect, error);
      this.onIssue(error);
      return;
    }
    if (context === null || context.filePath !== input.filePath) {
      this.onIssue(new Error('Obsidian did not provide Markdown section information.'));
      return;
    }

    const shown = await this.controller.showForRange({
      anchorRect,
      filePath: context.filePath,
      fullSource: context.source,
      range,
      readingRoot: context.readingRoot,
      scope: context.scope,
      sectionSource: context.sectionSource,
      sectionSourceStart: context.sectionSourceStart,
      sourceBindings: context.sourceBindings,
      sourceProjection: context.sourceProjection,
    });
    if (shown.supported) {
      this.recordDuration('quick-toolbar-open', this.now() - startedAt);
    } else if (shown.error !== undefined) {
      this.onIssue(shown.error);
    }
  }

  private async contextForRange(range: Range): Promise<{
    readonly filePath: string;
    readonly readingRoot: HTMLElement;
    readonly scope: { readonly sectionEndLine: number; readonly sectionStartLine: number };
    readonly sectionSource: string;
    readonly sectionSourceStart: number;
    readonly source: string;
    readonly sourceBindings: ReadonlyMap<HTMLElement, ReadingBlockBinding>;
    readonly sourceProjection: SourceProjection;
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
    const sameSourceSection =
      startInfo.text === endInfo.text && startInfo.lineStart === endInfo.lineStart;
    const startReadingRoot = readingViewDelegateRoot(startSection.root);
    const endReadingRoot = readingViewDelegateRoot(endSection.root);
    const readingRoot =
      startReadingRoot === endReadingRoot ? startReadingRoot : commonAncestorElement(range);
    const renderEpoch = this.renderEpochs.get(readingRoot) ?? 0;
    const artifacts = await this.artifactsForInteraction(startSection.filePath, source);
    if (
      (await startSection.getFullSource()) !== source ||
      (this.renderEpochs.get(readingRoot) ?? 0) !== renderEpoch ||
      !readingRoot.contains(range.startContainer) ||
      !readingRoot.contains(range.endContainer)
    ) {
      throw new ReadingSourceProjectionError(
        'stale-context',
        'The note or Reading View changed while Source Projection was prepared.',
      );
    }
    const bindingResult = this.bindingsFor({
      projection: artifacts.projection,
      root: readingRoot,
      sectionRange: (element) => {
        const section = this.contextContaining(element);
        const info = section?.getSectionInfo(element);
        if (info === undefined || info === null) return null;
        try {
          const start = sourceOffsetForSectionWithOffsets(source, info, artifacts.lineOffsets);
          return { end: start + info.text.length, start };
        } catch {
          return null;
        }
      },
    });
    return {
      filePath: startSection.filePath,
      readingRoot,
      scope: {
        sectionEndLine: Math.max(startInfo.lineEnd, endInfo.lineEnd),
        sectionStartLine: Math.min(startInfo.lineStart, endInfo.lineStart),
      },
      sectionSource: sameSourceSection ? startInfo.text : source,
      sectionSourceStart: sameSourceSection
        ? sourceOffsetForSectionWithOffsets(source, startInfo, artifacts.lineOffsets)
        : 0,
      source,
      sourceBindings: bindingResult.bindings,
      sourceProjection: artifacts.projection,
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

function readingViewDelegateRoot(root: HTMLElement): HTMLElement {
  return root.closest<HTMLElement>('.markdown-reading-view') ?? root;
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

function findSupportedBlock(node: Node): HTMLElement | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>(SUPPORTED_BLOCK_SELECTOR) ?? null;
}
