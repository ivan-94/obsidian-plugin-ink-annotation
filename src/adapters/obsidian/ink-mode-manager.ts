import { MarkdownView, Notice } from 'obsidian';
import type { App } from 'obsidian';

import { type InkSurfaceSessionSnapshot } from '../../application/ink-surface-session';
import { selectInkLayoutObservation } from '../../application/ink-layout-observation-policy';
import { KeyedSerialTaskQueue } from '../../runtime/keyed-serial-task-queue';
import { InkDocumentSession } from '../../application/ink-document-session';
import type { InkSurfaceRecord } from '../../domain/ink-surface';
import { buildInkMarkdownPartitions } from '../../domain/ink-markdown-partitioner';
import {
  reconcileInkSurface,
  type InkLayoutObservation,
  type InkSurfacePartition,
} from '../../domain/ink-surface-layout';
import { hashText } from '../../domain/text-anchor';
import type { InkSurfaceRepository } from '../../storage/ink-surface-repository';
import type { SidecarRepository } from '../../storage/sidecar-repository';
import { InkCanvasController } from '../../ui/ink-canvas-controller';
import { InkRebaseDialog, type InkRebaseTarget } from '../../ui/ink-rebase-dialog';
import { measureInkSurfaceHeights } from '../../ui/ink-surface-geometry';
import type { InkSurfaceSummary } from '../../domain/ink-surface-summary';
import type { LocalInkToolPreferenceStore } from '../../storage/local-ink-tool-preference';
import { shouldReconcileInkMutations } from './ink-mode-mutation-filter';
import { waitForInkLayoutReadiness } from './ink-layout-readiness';
import { shouldPersistInkReconciliation } from './ink-reconciliation-policy';
import { KeyedTrailingTaskQueue } from '../../runtime/keyed-trailing-task-queue';

interface MountedInkSurface {
  readonly complete: boolean;
  readonly controller: InkCanvasController;
  readonly filePath: string;
  readonly session: InkDocumentSession;
}

/** Coordinates one continuous canvas backed by independently persisted bounded surfaces. */
export class ObsidianInkModeManager {
  private activeView: MarkdownView | null = null;
  private readonly actions = new Map<MarkdownView, HTMLElement>();
  private disposed = false;
  private readonly layoutProbeTimeouts = new Set<number>();
  private readonly mounted = new Map<MarkdownView, MountedInkSurface>();
  private readonly mountQueue = new KeyedSerialTaskQueue<MarkdownView>();
  private readonly observers = new Map<MarkdownView, MutationObserver>();
  private readonly reconcileQueue = new KeyedTrailingTaskQueue<MarkdownView>();
  private readonly onIssue: (error: unknown) => void;
  private readonly onWillEnter: () => void;
  private pendingAction: 'enter' | 'exit' | null = null;
  private pendingView: MarkdownView | null = null;
  private rebaseDialog: InkRebaseDialog | null = null;
  private toggleTransition: Promise<void> | null = null;
  private readonly visibilityHandler = (): void => {
    if (this.input.document.hidden) {
      void this.background().catch(this.onIssue);
    }
  };
  private readonly windowBlurHandler = (): void => {
    void this.background().catch(this.onIssue);
  };

  constructor(
    private readonly input: {
      readonly app: App;
      readonly deviceId: string;
      readonly document: Document;
      readonly inkRepository: InkSurfaceRepository;
      readonly onIssue?: (error: unknown) => void;
      readonly onWillEnter?: () => void;
      readonly preferenceStore: LocalInkToolPreferenceStore;
      readonly recordInputToPaint?: (durationMs: number) => void;
      readonly textRepository: SidecarRepository;
    },
  ) {
    this.onIssue = input.onIssue ?? (() => undefined);
    this.onWillEnter = input.onWillEnter ?? (() => undefined);
    input.document.addEventListener('visibilitychange', this.visibilityHandler);
    input.document.defaultView?.addEventListener('blur', this.windowBlurHandler);
  }

  registerAllMarkdownViews(): void {
    for (const leaf of this.input.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView) {
        this.registerView(leaf.view);
        void this.scheduleReconcile(leaf.view).catch(this.onIssue);
      }
    }
  }

  registerView(view: MarkdownView): void {
    if (this.actions.has(view)) {
      return;
    }
    view.contentEl
      .querySelectorAll<HTMLElement>('.inkstone-ink-surface')
      .forEach((surface) => surface.remove());
    const action = view.addAction('paintbrush', 'Draw on this note', () => {
      void this.toggle(view).catch(this.onIssue);
    });
    action.dataset.inkstoneInkAction = 'true';
    action.setAttribute('aria-pressed', 'false');
    this.actions.set(view, action);
    const observer = new MutationObserver((mutations) => {
      if (shouldReconcileInkMutations(mutations)) {
        void this.scheduleReconcile(view).catch(this.onIssue);
      }
    });
    observer.observe(view.contentEl, { childList: true, subtree: true });
    this.observers.set(view, observer);
  }

  toggle(view = this.input.app.workspace.getActiveViewOfType(MarkdownView)): Promise<void> {
    if (view === null) {
      new Notice('Open a Markdown note in Reading View to use Ink Mode.');
      return Promise.resolve();
    }
    if (this.toggleTransition !== null) return this.toggleTransition;
    this.registerView(view);
    this.pendingView = view;
    this.pendingAction = this.activeView === view ? 'exit' : 'enter';
    const transition = this.performToggle(view).finally(() => {
      if (this.toggleTransition !== transition) return;
      this.toggleTransition = null;
      this.pendingView = null;
      this.pendingAction = null;
      this.syncActions();
    });
    this.toggleTransition = transition;
    this.syncActions();
    return transition;
  }

  private async performToggle(view: MarkdownView): Promise<void> {
    if (this.activeView === view) {
      await this.exit();
      return;
    }
    if (this.activeView !== null) {
      await this.exit();
    }
    // Passive Reading View reconciliation is deliberately read-only. Rebuild once on explicit
    // entry so any real layout drift (or recovery from it) is persisted before drawing starts.
    this.disposeMount(view);
    const mounted = await this.ensureMounted(view, true);
    if (mounted === null) {
      return;
    }
    this.onWillEnter();
    mounted.controller.enter();
    this.activeView = view;
    this.syncActions();
    this.scheduleActiveLayoutProbes(view);
  }

  async exit(): Promise<void> {
    const view = this.activeView;
    if (view === null) {
      return;
    }
    const mounted = this.mounted.get(view);
    if (mounted === undefined) {
      this.activeView = null;
      this.syncActions();
      return;
    }
    const activeElement = this.input.document.activeElement;
    const restoreActionFocus =
      activeElement !== null && activeElement.closest('.inkstone-ink-controls') !== null;
    await mounted.controller.exit();
    this.activeView = null;
    this.syncActions();
    this.disposeMount(view);
    let reclaimError: unknown;
    try {
      await this.reclaimEmptySurfaces(mounted.filePath);
    } catch (error) {
      reclaimError = error;
    }
    await this.ensureMounted(view, false);
    if (restoreActionFocus) {
      const action = this.actions.get(view);
      const restoreFocus = (): void => {
        if (action?.isConnected === true) action.focus({ preventScroll: true });
      };
      restoreFocus();
      this.input.document.defaultView?.requestAnimationFrame(restoreFocus);
    }
    if (reclaimError !== undefined) {
      throw reclaimError instanceof Error
        ? reclaimError
        : new Error('Failed to reclaim empty Ink surfaces.', { cause: reclaimError });
    }
  }

  async background(): Promise<void> {
    if (this.activeView === null) {
      return;
    }
    await this.mounted.get(this.activeView)?.controller.background();
  }

  /** Flushes active Ink before a canonical whole-surface mutation and detaches its live session. */
  async prepareFileMutation(filePath: string): Promise<void> {
    const view = this.activeView;
    if (view === null) return;
    const mounted = this.mounted.get(view);
    if (mounted === undefined || mounted.filePath !== filePath) return;
    await mounted.controller.exit();
    this.activeView = null;
    this.syncActions();
    this.disposeMount(view);
    await this.reclaimEmptySurfaces(filePath);
  }

  /** Rebuilds passive Ink overlays from canonical records after delete or restore. */
  async refreshFile(filePath: string): Promise<void> {
    await this.prepareFileMutation(filePath);
    const views = new Set<MarkdownView>();
    for (const [view, mounted] of this.mounted) {
      if (mounted.filePath === filePath) views.add(view);
    }
    for (const view of this.actions.keys()) {
      if (view.file?.path === filePath) views.add(view);
    }
    for (const view of views) {
      this.disposeMount(view);
      await this.ensureMounted(view, false);
    }
  }

  async navigateToSurface(summary: InkSurfaceSummary, enterInk = false): Promise<void> {
    const file = this.input.app.vault.getFileByPath(summary.filePath);
    if (file === null) throw new Error(`Ink source file no longer exists: ${summary.filePath}`);
    const leaf = this.input.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    if (!(leaf.view instanceof MarkdownView)) return;
    const root = leaf.view.contentEl.querySelector<HTMLElement>('.markdown-preview-sizer');
    if (root !== null) {
      const source = await this.input.app.vault.cachedRead(file);
      const targetLine = sourceLineAtOffset(source, summary.position);
      const markers = [...root.querySelectorAll<HTMLElement>('[data-line]')]
        .map((element) => ({
          element,
          line: Number.parseInt(element.dataset.line ?? '', 10),
        }))
        .filter(({ line }) => Number.isInteger(line));
      const target = markers.find(({ line }) => line >= targetLine)?.element;
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (enterInk) await this.toggle(leaf.view);
  }

  handleActiveLeafChange(): void {
    this.registerAllMarkdownViews();
    const current = this.input.app.workspace.getActiveViewOfType(MarkdownView);
    if (this.activeView !== null && current !== this.activeView) {
      void this.exit().catch(this.onIssue);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.input.document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.input.document.defaultView?.removeEventListener('blur', this.windowBlurHandler);
    void this.background().catch(this.onIssue);
    for (const observer of this.observers.values()) {
      observer.disconnect();
    }
    this.observers.clear();
    for (const view of [...this.mounted.keys()]) {
      this.disposeMount(view);
    }
    this.rebaseDialog?.dispose();
    this.rebaseDialog = null;
    this.activeView = null;
    for (const action of this.actions.values()) {
      action.remove();
    }
    for (const view of this.actions.keys()) {
      view.contentEl
        .querySelectorAll<HTMLElement>('.inkstone-ink-surface')
        .forEach((surface) => surface.remove());
    }
    this.reconcileQueue.clear();
    this.mountQueue.clear();
    for (const timeout of this.layoutProbeTimeouts) {
      this.input.document.defaultView?.clearTimeout(timeout);
    }
    this.layoutProbeTimeouts.clear();
    this.actions.clear();
  }

  private ensureMounted(
    view: MarkdownView,
    createIfMissing: boolean,
  ): Promise<MountedInkSurface | null> {
    return this.mountQueue.schedule(view, () => this.mountView(view, createIfMissing));
  }

  private reclaimEmptySurfaces(filePath: string): Promise<readonly InkSurfaceRecord[]> {
    return this.input.inkRepository.reclaimEmptySurfaces(
      filePath,
      new Date().toISOString(),
      this.input.deviceId,
    );
  }

  private async mountView(
    view: MarkdownView,
    createIfMissing: boolean,
  ): Promise<MountedInkSurface | null> {
    if (this.disposed || view.getMode() !== 'preview' || view.file === null) {
      if (createIfMissing) {
        new Notice('Switch this Markdown note to Reading View before entering Ink Mode.');
      }
      return null;
    }
    const root = view.contentEl.querySelector<HTMLElement>('.markdown-preview-sizer');
    if (root === null) {
      if (createIfMissing) {
        new Notice('The Reading View is still rendering. Try Ink Mode again in a moment.');
      }
      return null;
    }
    const scrollContainer =
      root.closest<HTMLElement>('.markdown-preview-view') ??
      view.contentEl.querySelector<HTMLElement>('.markdown-preview-view') ??
      view.contentEl;
    const minimumTotalHeight = Math.max(root.scrollHeight, root.getBoundingClientRect().height);
    await waitForInkLayoutReadiness(this.input.document);
    const existingMount = this.mounted.get(view);
    if (
      existingMount !== undefined &&
      existingMount.filePath === view.file.path &&
      (!createIfMissing || existingMount.complete) &&
      existingMount.controller.coversHeight(minimumTotalHeight)
    ) {
      if (!existingMount.controller.isAttachedTo(root)) {
        existingMount.controller.reattach(root);
      }
      return existingMount;
    }
    if (existingMount !== undefined) {
      this.disposeMount(view);
    }

    const filePath = view.file.path;
    const source = await this.input.app.vault.cachedRead(view.file);
    const sourceRevision = await hashText(source);
    const loaded = await this.input.inkRepository.listSurfaces(filePath);
    if (loaded.conflicts.some((conflict) => conflict.kind === 'same-revision-divergence')) {
      if (createIfMissing) {
        new Notice('Ink has an iCloud conflict. Repair the conflicting copies before drawing.');
      }
      return null;
    }
    const existing = loaded.records.filter((record) => record.deletedAt === undefined);
    if (existing.length === 0 && !createIfMissing) return null;

    const note = await this.input.textRepository.getOrCreateNote({
      createId: () => globalThis.crypto.randomUUID(),
      filePath,
      now: new Date().toISOString(),
      sourceFingerprint: sourceRevision,
    });
    const partitions = currentPartitions(source, sourceRevision);
    const measuredHeights = measureInkSurfaceHeights({
      minimumTotalHeight,
      partitions,
      root,
      source,
    });
    const style = getComputedStyle(root);
    const logicalWidth =
      existing.find((record) => record.status === 'active')?.layout.logicalWidth ??
      positiveDimension(root.clientWidth, root.scrollWidth);
    const observations = partitions.map((partition, index) =>
      observeLayout({
        height: measuredHeights[index] ?? 1,
        logicalWidth,
        partition,
        root,
        sourceRevision,
        style,
      }),
    );
    const reconciled: InkSurfaceRecord[] = [];
    let problemCount = 0;
    let blockingProblemCount = 0;
    for (const record of existing) {
      const targetIndex = matchingPartitionIndex(record, partitions);
      const observation = selectInkLayoutObservation(
        record,
        observations[targetIndex] ?? observations[0],
      );
      if (observation === undefined) continue;
      const result = reconcileInkSurface(record, partitions, observation);
      reconciled.push(result.record);
      if (
        shouldPersistInkReconciliation({
          currentRevision: record.revision,
          interactive: createIfMissing,
          reconciledRevision: result.record.revision,
        })
      ) {
        await this.input.inkRepository.updateSurface(result.record);
      }
      if (result.kind === 'needs-rebase' || result.kind === 'unanchored') {
        problemCount += 1;
      }
      if (result.kind === 'needs-rebase') blockingProblemCount += 1;
    }
    if (createIfMissing && blockingProblemCount > 0) {
      const problem = reconciled.find((record) => record.status === 'needs-rebase');
      if (problem !== undefined) {
        this.openRebaseDialog(view, problem, partitions, observations);
      }
      return null;
    }
    if (createIfMissing && problemCount > blockingProblemCount) {
      new Notice('Unanchored Ink was preserved as a problem item; drawing can continue elsewhere.');
    }

    const activeByFingerprint = new Map(
      reconciled
        .filter(
          (
            record,
          ): record is InkSurfaceRecord & { binding: NonNullable<InkSurfaceRecord['binding']> } =>
            record.status === 'active' && record.binding !== undefined,
        )
        .map((record) => [record.binding.sectionFingerprint, record]),
    );
    const surfaces: InkSurfaceRecord[] = [];
    let complete = true;
    for (let index = 0; index < partitions.length; index += 1) {
      const partition = partitions[index] as InkSurfacePartition;
      const active = activeByFingerprint.get(partition.sectionFingerprint);
      if (active !== undefined) {
        surfaces.push(active);
        continue;
      }
      const created = createSurfaceRecord({
        deviceId: this.input.deviceId,
        filePath,
        layout: observations[index] as InkLayoutObservation,
        noteId: note.noteId,
        partition,
      });
      surfaces.push(created);
      if (createIfMissing) {
        await this.input.inkRepository.writeSurface(created);
      } else {
        complete = false;
      }
    }

    let controller: InkCanvasController | null = null;
    const session = new InkDocumentSession({
      onChange: (snapshot: InkSurfaceSessionSnapshot) => controller?.sync(snapshot),
      surfaces,
      writer: this.input.inkRepository,
    });
    controller = new InkCanvasController({
      controlsHost: this.input.document.body,
      document: this.input.document,
      layoutRoot: root,
      onExitRequested: () => this.exit(),
      onLayoutExtentChanged: () => {
        void this.scheduleReconcile(view).catch(this.onIssue);
      },
      onPreferenceChanged: (preference) => {
        try {
          this.input.preferenceStore.save(preference);
        } catch (error) {
          this.onIssue(error);
        }
      },
      preference: this.input.preferenceStore.load(),
      ...(this.input.recordInputToPaint === undefined
        ? {}
        : { recordInputToPaint: this.input.recordInputToPaint }),
      root: scrollContainer,
      scrollContainer,
      session,
    });
    const mounted = { complete, controller, filePath, session };
    this.mounted.set(view, mounted);
    return mounted;
  }

  private disposeMount(view: MarkdownView): void {
    this.mounted.get(view)?.controller.dispose();
    this.mounted.delete(view);
  }

  private async reconcileView(view: MarkdownView): Promise<void> {
    const active = view === this.activeView;
    const mounted = await this.ensureMounted(view, active);
    if (active && mounted !== null) {
      mounted.controller.enter();
    }
  }

  private scheduleReconcile(view: MarkdownView): Promise<void> {
    return this.reconcileQueue.schedule(view, () => this.reconcileView(view));
  }

  private scheduleActiveLayoutProbes(view: MarkdownView): void {
    const window = this.input.document.defaultView;
    if (window === null) return;
    for (const delay of [50, 250, 1000]) {
      const timeout = window.setTimeout(() => {
        this.layoutProbeTimeouts.delete(timeout);
        if (this.disposed || this.activeView !== view) return;
        void this.ensureMounted(view, true)
          .then((mounted) => {
            if (this.activeView === view) mounted?.controller.enter();
          })
          .catch(this.onIssue);
      }, delay);
      this.layoutProbeTimeouts.add(timeout);
    }
  }

  private syncActions(): void {
    for (const [view, action] of this.actions) {
      const active = view === this.activeView;
      const pending = view === this.pendingView;
      const label = pending
        ? this.pendingAction === 'exit'
          ? 'Exiting Ink Mode…'
          : 'Opening Ink Mode…'
        : active
          ? 'Exit Ink Mode'
          : 'Draw on this note';
      action.classList.toggle('is-active', active);
      action.classList.toggle('is-pending', pending);
      action.setAttribute('aria-pressed', String(active));
      action.setAttribute('aria-busy', String(pending));
      action.setAttribute('aria-label', label);
      if (pending && this.pendingAction !== null) {
        action.dataset.inkstoneInkTransition = this.pendingAction;
      } else {
        delete action.dataset.inkstoneInkTransition;
      }
      action.setAttribute('data-tooltip-position', 'bottom');
    }
  }

  private openRebaseDialog(
    view: MarkdownView,
    record: InkSurfaceRecord,
    partitions: readonly InkSurfacePartition[],
    observations: readonly InkLayoutObservation[],
  ): void {
    if (this.rebaseDialog !== null) return;
    const targets: InkRebaseTarget[] = partitions.map((section, index) => ({
      layout: observations[index] as InkLayoutObservation,
      section,
    }));
    const oldHeading = record.binding?.headingPath;
    targets.sort((left, right) => {
      const leftMatches = JSON.stringify(left.section.headingPath) === JSON.stringify(oldHeading);
      const rightMatches = JSON.stringify(right.section.headingPath) === JSON.stringify(oldHeading);
      return Number(rightMatches) - Number(leftMatches);
    });
    const dialog = new InkRebaseDialog({
      document: this.input.document,
      onConfirm: (updated) => this.input.inkRepository.updateSurface(updated),
      record,
      targets,
    });
    this.rebaseDialog = dialog;
    void dialog
      .show()
      .then((result) => {
        if (result === 'confirmed') {
          new Notice('Ink rebase saved. Enter Ink Mode again to continue drawing.');
          void this.scheduleReconcile(view).catch(this.onIssue);
        }
      })
      .finally(() => {
        if (this.rebaseDialog === dialog) this.rebaseDialog = null;
      });
  }
}

function createSurfaceRecord(input: {
  readonly deviceId: string;
  readonly filePath: string;
  readonly layout: InkLayoutObservation;
  readonly noteId: string;
  readonly partition: InkSurfacePartition;
}): InkSurfaceRecord {
  const now = new Date().toISOString();
  return {
    binding: {
      blockFingerprints: input.partition.blockFingerprints,
      headingPath: input.partition.headingPath,
      sectionFingerprint: input.partition.sectionFingerprint,
      sourceEnd: input.partition.sourceEnd,
      sourceStart: input.partition.sourceStart,
    },
    createdAt: now,
    deviceId: input.deviceId,
    filePath: input.filePath,
    id: `surface-${globalThis.crypto.randomUUID()}`,
    layout: {
      blockFingerprints: input.partition.blockFingerprints,
      fontFamily: input.layout.fontFamily,
      fontSize: input.layout.fontSize,
      lineHeight: input.layout.lineHeight,
      logicalHeight: input.layout.logicalHeight,
      logicalWidth: input.layout.logicalWidth,
      sourceRevision: input.layout.sourceRevision,
      themeMode: input.layout.themeMode,
    },
    noteId: input.noteId,
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: [],
    updatedAt: now,
  };
}

function currentPartitions(source: string, sourceRevision: string): readonly InkSurfacePartition[] {
  const partitions = buildInkMarkdownPartitions(source, { maxBlocks: 12 });
  if (partitions.length > 0) return partitions;
  return [
    {
      blockFingerprints: [sourceRevision],
      fullNoteFallback: true,
      headingPath: [],
      sectionFingerprint: `empty:${sourceRevision}`,
      sourceEnd: source.length,
      sourceStart: 0,
    },
  ];
}

function matchingPartitionIndex(
  record: InkSurfaceRecord,
  partitions: readonly InkSurfacePartition[],
): number {
  if (record.binding === undefined) return -1;
  const exact = partitions.findIndex(
    (partition) => partition.sectionFingerprint === record.binding?.sectionFingerprint,
  );
  if (exact >= 0) return exact;
  return partitions.findIndex(
    (partition) =>
      JSON.stringify(partition.headingPath) === JSON.stringify(record.binding?.headingPath),
  );
}

function observeLayout(input: {
  readonly height: number;
  readonly logicalWidth: number;
  readonly partition: InkSurfacePartition;
  readonly root: HTMLElement;
  readonly sourceRevision: string;
  readonly style: CSSStyleDeclaration;
}): InkLayoutObservation {
  const fontSize = positiveNumber(input.style.fontSize, 16);
  const fontFamily = input.style.fontFamily || 'system-ui';
  return {
    fontAvailable: document.fonts?.check(`${fontSize}px ${fontFamily}`) ?? true,
    fontFamily,
    fontSize,
    lineHeight: positiveNumber(input.style.lineHeight, fontSize * 1.5),
    logicalHeight: Math.max(1, input.height),
    logicalWidth: input.logicalWidth,
    sourceRevision: input.sourceRevision,
    themeMode: input.root.closest('.theme-dark') === null ? 'light' : 'dark',
    viewportWidth: input.root.clientWidth,
  };
}

function positiveDimension(primary: number, fallback: number): number {
  return Math.max(1, Math.ceil(primary > 0 ? primary : fallback > 0 ? fallback : 1));
}

function positiveNumber(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sourceLineAtOffset(source: string, offset: number): number {
  let line = 0;
  for (let index = 0; index < Math.min(offset, source.length); index += 1) {
    if (source[index] === '\n') line += 1;
  }
  return line;
}
