import { MarkdownView, Notice, setIcon, setTooltip } from 'obsidian';
import type { App, Menu } from 'obsidian';

import { KeyedSerialTaskQueue } from '../../runtime/keyed-serial-task-queue';
import {
  InkLiveDocument,
  type InkDocumentChange,
  type InkDocumentReadView,
} from '../../application/ink-document-session';
import { ensureInkCanvasExtent, measureInkCanvasExtent } from '../../domain/ink-canvas-extent';
import type { InkSurfaceRecord } from '../../domain/ink-surface';
import {
  orderInkSurfaceRecordsForLegacyRead,
  orderPositionedInkSurfaceRecords,
  upgradeInkSurfaceRecordsToV3,
} from '../../domain/ink-surface-migration';
import { INK_DOCUMENT_LOGICAL_WIDTH } from '../../domain/ink-workspace';
import { hashText } from '../../domain/text-anchor';
import {
  findInkSurfaceCanonicalProjectionBlock,
  type InkSurfaceRepository,
} from '../../storage/ink-surface-repository';
import { normalizeVaultPath, type SidecarRepository } from '../../storage/sidecar-repository';
import { InkCanvasController } from '../../ui/ink-canvas-controller';
import type {
  InkActivePresentationAdapterState,
  InkRenderRuntimeStats,
  InkWorkerPresentationRuntimeOptions,
} from '../../ui/ink-render-runtime';
import type { InkSurfaceSummary } from '../../domain/ink-surface-summary';
import type { LocalInkToolPreferenceStore } from '../../storage/local-ink-tool-preference';
import {
  type InkLegacyRecoveryReader,
  planLocalInkRecovery,
} from '../../storage/local-ink-recovery';
import {
  NOOP_INK_PERFORMANCE_RECORDER,
  type InkPerformanceRecorder,
} from '../../runtime/ink-performance-diagnostics';
import { waitForInkLayoutReadiness } from './ink-layout-readiness';
import { isAnnotationReadingView } from './markdown-view-mode';

const INK_ENTRY_ICON = 'paintbrush';

interface MountedInkSurface {
  readonly complete: boolean;
  readonly controller: InkCanvasController;
  readonly filePath: string;
  readonly session: InkLiveDocument;
}

interface PendingInkExit {
  readonly mounted: MountedInkSurface;
  readonly target: 'raw' | 'preview';
  readonly view: MarkdownView;
}

export type InkUnsavedExitDecision = 'cancel' | 'discard' | 'save';
export type InkPassiveExitReason =
  'active-leaf-change' | 'note-switch' | 'view-close' | 'view-mode-change';

/** Coordinates one continuous canvas backed by independently persisted bounded surfaces. */
export class ObsidianInkModeManager {
  private activeLeafEpoch = 0;
  private activeView: MarkdownView | null = null;
  private readonly actions = new Map<MarkdownView, HTMLElement>();
  private readonly actionFilePaths = new Map<MarkdownView, string | null>();
  private readonly hasInkViews = new Set<MarkdownView>();
  private readonly hasInkStateVersions = new Map<MarkdownView, number>();
  private readonly hiddenPreviewPaths = new Map<MarkdownView, string>();
  private disposed = false;
  private readonly mounted = new Map<MarkdownView, MountedInkSurface>();
  private readonly fileMountQueue = new KeyedSerialTaskQueue<string>();
  private readonly lifecycleQueue = new KeyedSerialTaskQueue<'active-owner'>();
  private readonly mountQueue = new KeyedSerialTaskQueue<MarkdownView>();
  private readonly paneMenuBindings = new Map<
    MarkdownView,
    {
      readonly original: ((menu: Menu, source: string) => void) | undefined;
      readonly wrapped: (menu: Menu, source: string) => void;
    }
  >();
  private readonly refreshQueue = new KeyedSerialTaskQueue<MarkdownView>();
  private readonly onIssue: (error: unknown) => void;
  private readonly inkPerformance: InkPerformanceRecorder;
  private readonly onWillEnter: () => void;
  private pendingAction: 'enter' | 'exit' | null = null;
  private pendingExit: PendingInkExit | null = null;
  private passiveExitRequest: Promise<void> | null = null;
  private pendingView: MarkdownView | null = null;
  private previewByDefault: boolean;
  private readonly previewViews = new Set<MarkdownView>();
  private readonly legacyRecoveryReader: InkLegacyRecoveryReader | undefined;
  private readonly ignoredLegacyRecovery = new Set<string>();
  private observedActiveView: MarkdownView | null = null;
  private toggleTransition: Promise<void> | null = null;
  private readonly visibilityHandler = (): void => {
    if (this.input.document.hidden) {
      void this.background().catch(this.onIssue);
    }
  };

  constructor(
    private readonly input: {
      readonly app: App;
      readonly deviceId: string;
      readonly document: Document;
      readonly exportUnsavedInk?: (surface: InkSurfaceRecord) => Promise<string>;
      readonly inkPerformance?: InkPerformanceRecorder;
      readonly inkRepository: InkSurfaceRepository;
      readonly onIssue?: (error: unknown) => void;
      readonly onWillEnter?: () => void;
      readonly preferenceStore: LocalInkToolPreferenceStore;
      readonly requestUnsavedExitDecision?: (input: {
        readonly filePath: string;
        readonly reason: InkPassiveExitReason;
      }) => Promise<InkUnsavedExitDecision>;
      readonly liveFirstPersistence?: {
        readonly legacyRecoveryReader?: InkLegacyRecoveryReader;
      };
      readonly recordInputToPaint?: (durationMs: number) => void;
      readonly showInkPreviewByDefault?: boolean;
      readonly textRepository: SidecarRepository;
      readonly unpublishedPhysicalInkHat?: Record<string, never>;
      readonly workerPresentation?: InkWorkerPresentationRuntimeOptions;
    },
  ) {
    this.onIssue = input.onIssue ?? (() => undefined);
    this.inkPerformance = input.inkPerformance ?? NOOP_INK_PERFORMANCE_RECORDER;
    this.onWillEnter = input.onWillEnter ?? (() => undefined);
    this.previewByDefault = input.showInkPreviewByDefault ?? false;
    this.legacyRecoveryReader = input.liveFirstPersistence?.legacyRecoveryReader;
    input.document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  get activePresentationAdapterState(): InkActivePresentationAdapterState | null {
    if (this.activeView === null) return null;
    return this.mounted.get(this.activeView)?.controller.activePresentationAdapterState ?? null;
  }

  get activeRenderRuntimeStats(): InkRenderRuntimeStats | null {
    if (this.activeView === null) return null;
    return this.mounted.get(this.activeView)?.controller.renderRuntimeStats ?? null;
  }

  registerAllMarkdownViews(): void {
    const views = new Set<MarkdownView>();
    for (const leaf of this.input.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView) {
        views.add(leaf.view);
        this.registerView(leaf.view);
      }
    }
    if (this.activeView !== null && !views.has(this.activeView)) {
      void this.schedulePassiveExit('view-close').catch(this.onIssue);
    }
  }

  registerView(view: MarkdownView): void {
    if (this.disposed) return;
    const currentPath = view.file?.path;
    const currentFileKey = currentPath === undefined ? null : normalizeVaultPath(currentPath);
    const fileChanged =
      this.actionFilePaths.has(view) && this.actionFilePaths.get(view) !== currentFileKey;
    this.actionFilePaths.set(view, currentFileKey);
    if (fileChanged) {
      this.commitHasInkState(view, false);
      this.hiddenPreviewPaths.delete(view);
      this.previewViews.delete(view);
      this.syncActions();
      if (this.activeView === view) {
        void this.schedulePassiveExit('note-switch').catch(this.onIssue);
        return;
      }
    }
    if (this.actions.has(view)) {
      this.syncActions();
      void this.refreshQueue
        .schedule(view, async () => {
          await this.refreshRegisteredView(view);
          if (fileChanged && isAnnotationReadingView(view)) {
            await this.initializeRegisteredView(view);
          }
        })
        .catch(this.onIssue);
      return;
    }
    view.contentEl
      .querySelectorAll<HTMLElement>('.inkstone-ink-surface')
      .forEach((surface) => surface.remove());
    if (!isAnnotationReadingView(view)) return;
    const hiddenPath = this.hiddenPreviewPaths.get(view);
    if (
      hiddenPath !== undefined &&
      (currentPath === undefined || normalizeVaultPath(currentPath) !== hiddenPath)
    ) {
      this.hiddenPreviewPaths.delete(view);
    }
    const action = view.addAction(INK_ENTRY_ICON, '开始涂鸦', () => {
      void this.activatePrimaryAction(view).catch(this.onIssue);
    });
    action.dataset.inkstoneInkAction = 'true';
    setIcon(action, INK_ENTRY_ICON);
    setTooltip(action, '开始涂鸦', { placement: 'bottom' });
    action.setAttribute('aria-label', '开始涂鸦');
    this.actions.set(view, action);
    this.installPaneMenu(view);
    this.syncActions();
    void this.initializeRegisteredView(view).catch(this.onIssue);
  }

  /** Waits until any file-change reconciliation already queued for this view has completed. */
  synchronizeRegisteredView(view: MarkdownView): Promise<void> {
    return this.refreshQueue.schedule(view, () => Promise.resolve());
  }

  private async initializeRegisteredView(view: MarkdownView): Promise<void> {
    const filePath = view.file?.path;
    if (
      !isAnnotationReadingView(view) ||
      filePath === undefined ||
      (typeof this.input.inkRepository.listSurfaces !== 'function' &&
        typeof this.input.inkRepository.listSurfaceSummaries !== 'function')
    ) {
      if (this.previewByDefault) await this.showPreview(view);
      return;
    }
    const expectedStateVersion = this.hasInkStateVersions.get(view) ?? 0;
    const hasInk = await this.readCanonicalFileHasInkState(filePath);
    if (
      hasInk === null ||
      this.disposed ||
      !this.actions.has(view) ||
      !isAnnotationReadingView(view) ||
      view.file?.path !== filePath ||
      (this.hasInkStateVersions.get(view) ?? 0) !== expectedStateVersion
    ) {
      return;
    }
    this.commitHasInkState(view, hasInk);
    this.syncActions();
    if (this.previewByDefault && hasInk) await this.showPreview(view);
  }

  private async activatePrimaryAction(view: MarkdownView): Promise<void> {
    if (view !== this.activeView && !this.previewViews.has(view) && this.hasInkViews.has(view)) {
      const filePath = view.file?.path;
      if (filePath !== undefined) {
        const hasInk = await this.scheduleLifecycle(() => this.reconcileFileHasInkState(filePath));
        if (
          this.disposed ||
          view.file === null ||
          normalizeVaultPath(view.file.path) !== normalizeVaultPath(filePath)
        ) {
          return;
        }
        if (hasInk === false) {
          await this.toggle(view);
          return;
        }
      }
      await this.showPreview(view, true);
      return;
    }
    await this.toggle(view);
  }

  private installPaneMenu(view: MarkdownView): void {
    if (this.paneMenuBindings.has(view)) return;
    const paneMenu = Reflect.get(view, 'onPaneMenu') as unknown;
    const original =
      typeof paneMenu === 'function'
        ? (paneMenu as (menu: Menu, source: string) => void)
        : undefined;
    const wrapped = (menu: Menu, source: string): void => {
      original?.call(view, menu, source);
      if (source !== 'more-options' || !this.previewViews.has(view)) return;
      menu.addItem((item) =>
        item
          .setTitle('关闭涂鸦预览')
          .setIcon('eye-off')
          .setSection('view')
          .onClick(() => {
            void this.closePreview(view).catch(this.onIssue);
          }),
      );
    };
    this.paneMenuBindings.set(view, { original, wrapped });
    view.onPaneMenu = wrapped;
  }

  private closePreview(view: MarkdownView): Promise<void> {
    return this.scheduleLifecycle(() => {
      if (this.activeView === view || !this.previewViews.has(view)) return Promise.resolve();
      const mounted = this.mounted.get(view);
      if (mounted === undefined) return Promise.resolve();
      const filePath = view.file?.path ?? mounted.filePath;
      this.hiddenPreviewPaths.set(view, normalizeVaultPath(filePath));
      this.commitHasInkState(view, true);
      mounted.controller.hidePreview();
      this.disposeMount(view);
      this.syncActions();
      return Promise.resolve();
    });
  }

  toggle(view = this.input.app.workspace.getActiveViewOfType(MarkdownView)): Promise<void> {
    if (view === null) {
      new Notice('Open a Markdown note in Reading View to use Ink Mode.');
      return Promise.resolve();
    }
    if (!isAnnotationReadingView(view)) {
      new Notice('Open a Markdown note in Reading View to use Ink Mode.');
      return this.scheduleLifecycle(() => this.exitActiveView(true));
    }
    if (this.toggleTransition !== null) {
      const currentTransition = this.toggleTransition;
      if (this.pendingView === view) return currentTransition;
      return currentTransition.then(() => this.toggle(view));
    }
    if (!this.actions.has(view)) {
      this.registerView(view);
      if (!this.actions.has(view)) return Promise.resolve();
    }
    const activeLeafEpoch = this.observeActiveLeaf();
    this.pendingView = view;
    this.pendingAction = this.activeView === view ? 'exit' : 'enter';
    const transition = this.scheduleLifecycle(() =>
      this.performToggle(view, activeLeafEpoch),
    ).finally(() => {
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

  private async performToggle(view: MarkdownView, activeLeafEpoch: number): Promise<void> {
    if (this.activeView === view) {
      await this.exitActiveView(false);
      return;
    }
    if (this.activeView !== null) {
      const previousOwner = this.activeView;
      await this.requestPassiveExitNow('note-switch');
      if (this.activeView === previousOwner) return;
    }
    const previousMount = this.mounted.get(view);
    const mounted = await this.ensureMounted(view, true);
    const currentView = this.input.app.workspace.getActiveViewOfType(MarkdownView);
    if (
      mounted === null ||
      this.disposed ||
      this.mounted.get(view) !== mounted ||
      this.activeLeafEpoch !== activeLeafEpoch ||
      currentView !== view
    ) {
      if (
        mounted !== null &&
        mounted !== previousMount &&
        this.mounted.get(view) === mounted &&
        this.activeView !== view
      ) {
        this.disposeMount(view);
      }
      return;
    }
    this.onWillEnter();
    this.previewViews.delete(view);
    mounted.controller.enter();
    this.activeView = view;
    this.syncActions();
  }

  async exit(): Promise<void> {
    await this.scheduleLifecycle(() => this.exitActiveView(false));
  }

  private async exitActiveView(forceRaw: boolean): Promise<void> {
    const view = this.activeView;
    if (view === null) {
      return;
    }
    const mounted = this.mounted.get(view);
    if (mounted === undefined) {
      this.activeView = null;
      this.pendingExit = null;
      this.syncActions();
      return;
    }
    const target = !forceRaw && mounted.session.read().strokeCount > 0 ? 'preview' : 'raw';
    await this.exitMountedView(view, mounted, target);
  }

  private async exitMountedView(
    view: MarkdownView,
    mounted: MountedInkSurface,
    target: 'raw' | 'preview',
  ): Promise<void> {
    const activeElement = this.input.document.activeElement;
    const restoreActionFocus =
      activeElement !== null && activeElement.closest('.inkstone-ink-controls') !== null;
    try {
      await mounted.controller.exit(target);
    } catch (error) {
      if (this.activeView === view && this.mounted.get(view) === mounted) {
        this.pendingExit = { mounted, target, view };
      }
      throw error;
    }
    if (this.activeView !== view || this.mounted.get(view) !== mounted) return;
    this.pendingExit = null;
    this.activeView = null;
    if (target === 'preview') {
      this.commitHasInkState(view, true);
      this.previewViews.add(view);
    } else if (mounted.session.read().strokeCount === 0) {
      this.commitHasInkState(view, false);
    }
    this.syncActions();
    if (target === 'raw') this.disposeMount(view);
    let reclaimError: unknown;
    if (target === 'raw') {
      try {
        await this.reclaimEmptySurfaces(mounted.filePath);
      } catch (error) {
        reclaimError = error;
      }
    }
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
    await this.scheduleLifecycle(() => this.backgroundActiveView());
  }

  private async backgroundActiveView(): Promise<void> {
    if (this.activeView === null) return;
    await this.mounted.get(this.activeView)?.controller.background();
  }

  private retryFailedSave(view: MarkdownView, controller: InkCanvasController): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.scheduleLifecycle(async () => {
      if (this.activeView !== view) return;
      const mounted = this.mounted.get(view);
      if (mounted === undefined || mounted.controller !== controller) return;
      const pending = this.pendingExit;
      if (pending?.view === view && pending.mounted === mounted) {
        await this.exitMountedView(view, mounted, pending.target);
        return;
      }
      await controller.retrySave();
    });
  }

  async setPreviewByDefault(enabled: boolean): Promise<void> {
    this.previewByDefault = enabled;
    await this.scheduleLifecycle(() => this.applyPreviewPreference(enabled));
  }

  private async applyPreviewPreference(enabled: boolean): Promise<void> {
    const views = new Set([...this.actions.keys(), ...this.mounted.keys()]);
    if (!enabled) {
      for (const view of views) {
        if (view === this.activeView) continue;
        this.mounted.get(view)?.controller.hidePreview();
        this.disposeMount(view);
      }
      this.syncActions();
      return;
    }
    await Promise.all(
      [...views]
        .filter((view) => view !== this.activeView)
        .map((view) => this.showPreview(view).catch(this.onIssue)),
    );
  }

  /** Flushes active Ink before a canonical whole-surface mutation and detaches its live session. */
  async prepareFileMutation(filePath: string): Promise<void> {
    await this.scheduleLifecycle(() => this.prepareFileMutationNow(filePath));
  }

  private async prepareFileMutationNow(filePath: string): Promise<void> {
    const view = this.activeView;
    if (view === null) return;
    const mounted = this.mounted.get(view);
    if (mounted === undefined || mounted.filePath !== filePath) return;
    await this.exitMountedView(view, mounted, 'raw');
  }

  /** Reconciles canonical Ink after delete, restore, or an external sidecar mutation. */
  async refreshFile(filePath: string): Promise<void> {
    await this.scheduleLifecycle(async () => {
      await this.prepareFileMutationNow(filePath);
      for (const [view, mounted] of this.mounted) {
        if (mounted.filePath === filePath) this.disposeMount(view);
      }
      await this.reconcileFileHasInkState(filePath);
    });
  }

  async navigateToSurface(summary: InkSurfaceSummary, enterInk = false): Promise<void> {
    const file = this.input.app.vault.getFileByPath(summary.filePath);
    if (file === null) throw new Error(`Ink source file no longer exists: ${summary.filePath}`);
    const leaf = this.input.app.workspace.getLeaf(false);
    const currentFilePath = leaf.view instanceof MarkdownView ? leaf.view.file?.path : undefined;
    if (currentFilePath !== file.path) await leaf.openFile(file);
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
    this.observeActiveLeaf();
    const current = this.observedActiveView;
    if (this.activeView !== null && current !== this.activeView) {
      void this.schedulePassiveExit('active-leaf-change').catch(this.onIssue);
    }
  }

  private schedulePassiveExit(reason: InkPassiveExitReason): Promise<void> {
    if (this.passiveExitRequest !== null) return this.passiveExitRequest;
    const request = this.scheduleLifecycle(() => this.requestPassiveExitNow(reason)).finally(() => {
      if (this.passiveExitRequest === request) this.passiveExitRequest = null;
    });
    this.passiveExitRequest = request;
    return request;
  }

  private async requestPassiveExitNow(reason: InkPassiveExitReason): Promise<void> {
    const view = this.activeView;
    if (view === null) return;
    const mounted = this.mounted.get(view);
    if (mounted === undefined) return;
    const state = mounted.session.read().state;
    const dirty = state?.kind === 'ink-mode' && state.dirty;
    if (!dirty) {
      await this.exitMountedView(view, mounted, 'raw');
      return;
    }
    const decision = await (this.input.requestUnsavedExitDecision ?? requestUnsavedInkExitDecision)(
      { filePath: mounted.filePath, reason },
    );
    if (decision === 'cancel') {
      await this.restorePassiveExit(view, mounted.filePath, reason);
      return;
    }
    if (decision === 'save') {
      await this.exitMountedView(view, mounted, 'raw');
      return;
    }
    await this.discardMountedView(view, mounted);
  }

  private async restorePassiveExit(
    view: MarkdownView,
    filePath: string,
    reason: InkPassiveExitReason,
  ): Promise<void> {
    try {
      if (reason === 'note-switch') {
        const file = this.input.app.vault?.getFileByPath(filePath);
        if (file !== null && file !== undefined) await view.leaf.openFile(file);
      } else if (reason === 'view-mode-change') {
        const viewState = view.leaf?.getViewState?.();
        if (viewState !== undefined) {
          await view.leaf.setViewState({
            ...viewState,
            state: { ...viewState.state, mode: 'preview' },
          });
        }
      }
      this.input.app.workspace.setActiveLeaf(view.leaf, { focus: true });
    } catch (error) {
      this.onIssue(error);
    }
  }

  private async discardMountedView(view: MarkdownView, mounted: MountedInkSurface): Promise<void> {
    if (this.activeView !== view || this.mounted.get(view) !== mounted) return;
    this.pendingExit = null;
    this.activeView = null;
    this.disposeMount(view);
    this.syncActions();
    await this.reclaimEmptySurfaces(mounted.filePath);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.input.document.removeEventListener('visibilitychange', this.visibilityHandler);
    const activeMount = this.activeView === null ? undefined : this.mounted.get(this.activeView);
    if (activeMount !== undefined) {
      try {
        void activeMount.controller.background().catch(this.onIssue);
      } catch (error) {
        this.onIssue(error);
      }
    }
    for (const view of [...this.mounted.keys()]) this.disposeMount(view);
    this.activeView = null;
    this.pendingExit = null;
    this.passiveExitRequest = null;
    for (const action of this.actions.values()) {
      action.remove();
    }
    for (const view of this.actions.keys()) {
      view.contentEl
        .querySelectorAll<HTMLElement>('.inkstone-ink-surface')
        .forEach((surface) => surface.remove());
    }
    this.lifecycleQueue.clear();
    this.fileMountQueue.clear();
    this.mountQueue.clear();
    this.refreshQueue.clear();
    for (const [view, binding] of this.paneMenuBindings) {
      if (view.onPaneMenu !== binding.wrapped) continue;
      if (binding.original === undefined) Reflect.deleteProperty(view, 'onPaneMenu');
      else view.onPaneMenu = binding.original;
    }
    this.paneMenuBindings.clear();
    this.actionFilePaths.clear();
    this.actions.clear();
    this.hasInkViews.clear();
    this.hiddenPreviewPaths.clear();
    this.previewViews.clear();
  }

  private observeActiveLeaf(): number {
    const current = this.input.app.workspace.getActiveViewOfType(MarkdownView);
    if (current !== this.observedActiveView) {
      this.observedActiveView = current;
      this.activeLeafEpoch += 1;
    }
    return this.activeLeafEpoch;
  }

  private ensureMounted(
    view: MarkdownView,
    createIfMissing: boolean,
  ): Promise<MountedInkSurface | null> {
    return this.mountQueue.schedule(view, () => {
      const filePath = view.file?.path;
      if (filePath === undefined) return this.mountView(view, createIfMissing);
      const fileKey = normalizeVaultPath(filePath);
      return this.fileMountQueue.schedule(fileKey, () => {
        const currentFilePath = view.file?.path;
        if (currentFilePath === undefined || normalizeVaultPath(currentFilePath) !== fileKey) {
          return Promise.resolve(null);
        }
        return this.mountView(view, createIfMissing);
      });
    });
  }

  private scheduleLifecycle<Result>(task: () => Promise<Result>): Promise<Result> {
    return this.lifecycleQueue.schedule('active-owner', task);
  }

  /** Reconciles an existing action with Obsidian's latest virtualized Reading View DOM. */
  private async refreshRegisteredView(view: MarkdownView): Promise<void> {
    await this.scheduleLifecycle(() => this.refreshRegisteredViewNow(view));
  }

  private async refreshRegisteredViewNow(view: MarkdownView): Promise<void> {
    if (this.disposed) return;
    if (!isAnnotationReadingView(view)) {
      if (this.activeView === view) await this.requestPassiveExitNow('view-mode-change');
      else if (this.mounted.has(view)) this.disposeMount(view);
      this.syncActions();
      return;
    }
    if (this.activeView !== view) {
      if (this.previewByDefault) await this.showPreview(view);
      return;
    }
    const previousMount = this.mounted.get(view);
    if (!this.isActiveViewCompatible(view)) {
      const mounted = this.mounted.get(view);
      const reason =
        mounted !== undefined && view.file !== null && mounted.filePath !== view.file.path
          ? 'note-switch'
          : 'view-mode-change';
      await this.requestPassiveExitNow(reason);
      if (
        !this.disposed &&
        this.activeView !== view &&
        this.previewByDefault &&
        view.getMode() === 'preview' &&
        view.file !== null
      ) {
        await this.showPreview(view);
      }
      return;
    }
    const mounted = await this.ensureMounted(view, true);
    if (this.disposed || this.activeView !== view) return;
    if (!this.isActiveViewCompatible(view)) {
      const mounted = this.mounted.get(view);
      const reason =
        mounted !== undefined && view.file !== null && mounted.filePath !== view.file.path
          ? 'note-switch'
          : 'view-mode-change';
      await this.requestPassiveExitNow(reason);
      if (
        !this.disposed &&
        this.activeView !== view &&
        this.previewByDefault &&
        view.getMode() === 'preview' &&
        view.file !== null
      ) {
        await this.showPreview(view);
      }
      return;
    }
    if (mounted === null) return;
    if (mounted !== previousMount) mounted.controller.enter();
  }

  private isActiveViewCompatible(view: MarkdownView): boolean {
    const mounted = this.mounted.get(view);
    return (
      mounted !== undefined &&
      view.getMode() === 'preview' &&
      view.file !== null &&
      normalizeVaultPath(mounted.filePath) === normalizeVaultPath(view.file.path)
    );
  }

  private async showPreview(view: MarkdownView, manual = false): Promise<void> {
    if (this.disposed || this.activeView === view || !isAnnotationReadingView(view)) return;
    const filePath = view.file?.path;
    if (
      !manual &&
      filePath !== undefined &&
      this.hiddenPreviewPaths.get(view) === normalizeVaultPath(filePath)
    ) {
      return;
    }
    if (manual) this.hiddenPreviewPaths.delete(view);
    const mounted = await this.ensureMounted(view, false);
    if (mounted === null || this.disposed || this.activeView === view) return;
    if (!manual && !this.previewByDefault) {
      if (this.mounted.get(view) === mounted) this.disposeMount(view);
      return;
    }
    mounted.controller.showPreview();
    this.commitHasInkState(view, true);
    this.previewViews.add(view);
    this.syncActions();
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
    await waitForInkLayoutReadiness(this.input.document);
    if (this.disposed || view.getMode() !== 'preview' || view.file === null) {
      if (createIfMissing) {
        new Notice('Switch this Markdown note to Reading View before entering Ink Mode.');
      }
      return null;
    }
    const file = view.file;
    let root = view.contentEl.querySelector<HTMLElement>('.markdown-preview-sizer');
    if (root === null) {
      if (createIfMissing) {
        new Notice('The Reading View is still rendering. Try Ink Mode again in a moment.');
      }
      return null;
    }
    let scrollContainer =
      root.closest<HTMLElement>('.markdown-preview-view') ??
      view.contentEl.querySelector<HTMLElement>('.markdown-preview-view') ??
      view.contentEl;
    let minimumTotalHeight = Math.max(root.scrollHeight, root.getBoundingClientRect().height);
    const existingMount = this.mounted.get(view);
    if (
      existingMount !== undefined &&
      normalizeVaultPath(existingMount.filePath) === normalizeVaultPath(file.path) &&
      (!createIfMissing || existingMount.complete) &&
      (this.activeView === view || existingMount.controller.coversHeight(minimumTotalHeight))
    ) {
      if (!existingMount.controller.isAttachedTo(root, scrollContainer, scrollContainer)) {
        existingMount.controller.reattach(root, scrollContainer, scrollContainer);
      }
      return existingMount;
    }
    if (existingMount !== undefined) {
      if (this.activeView === view) return null;
      this.disposeMount(view);
    }

    const filePath = file.path;
    const source = await this.input.app.vault.cachedRead(file);
    const sourceRevision = await hashText(source);
    const loaded = await this.input.inkRepository.listSurfaces(filePath);
    const canonicalBlock = findInkSurfaceCanonicalProjectionBlock(loaded);
    if (canonicalBlock?.kind === 'conflict') {
      if (createIfMissing) {
        new Notice('Ink has an iCloud conflict. Repair the conflicting copies before drawing.');
      }
      return null;
    }
    if (canonicalBlock?.kind === 'unsupported-record') {
      this.onIssue(canonicalBlock.issue);
      if (createIfMissing) {
        new Notice('This note contains Ink from a newer version. Update Inkstone before drawing.');
      }
      return null;
    }
    if (canonicalBlock?.kind === 'corrupt-record') {
      this.onIssue(canonicalBlock.issue);
      if (createIfMissing) {
        new Notice('This note contains damaged Ink. Repair it before drawing.');
      }
      return null;
    }
    let existing = loaded.records.filter((record) => record.deletedAt === undefined);
    if (existing.length === 0 && !createIfMissing) return null;
    if (existing.some((record) => record.schemaVersion === 1)) {
      const readOrder = orderInkSurfaceRecordsForLegacyRead(existing);
      if (readOrder.kind === 'manual-placement-required') {
        if (createIfMissing) {
          new Notice('Existing Ink has no unique canonical order. Manual placement is required.');
        }
        return null;
      }
      existing = [...readOrder.records];
    }
    if (!createIfMissing && !existing.some((record) => record.strokes.length > 0)) return null;

    const note = await this.input.textRepository.getOrCreateNote({
      createId: () => globalThis.crypto.randomUUID(),
      filePath,
      now: new Date().toISOString(),
      sourceFingerprint: sourceRevision,
    });
    existing = [
      ...(this.legacyRecoveryReader === undefined
        ? existing
        : await this.restoreLocalRecovery(filePath, existing)),
    ];
    existing = [...orderPositionedInkSurfaceRecords(existing)];

    if (
      this.disposed ||
      view.getMode() !== 'preview' ||
      view.file === null ||
      view.file.path !== filePath
    ) {
      return null;
    }
    const currentRoot = view.contentEl.querySelector<HTMLElement>('.markdown-preview-sizer');
    if (currentRoot === null) {
      if (createIfMissing) {
        new Notice('The Reading View is still rendering. Try Ink Mode again in a moment.');
      }
      return null;
    }
    root = currentRoot;
    minimumTotalHeight = Math.max(
      minimumTotalHeight,
      root.scrollHeight,
      root.getBoundingClientRect().height,
    );
    const style = getComputedStyle(root);

    const logicalWidth = existing[0]?.layout.logicalWidth ?? INK_DOCUMENT_LOGICAL_WIDTH;
    const baseSurfaces =
      existing.length > 0
        ? existing
        : createContinuousSurfaceRecords({
            deviceId: this.input.deviceId,
            filePath,
            logicalHeight: Math.max(1, Math.ceil(minimumTotalHeight)),
            logicalWidth,
            noteId: note.noteId,
            root,
            sourceRevision,
            style,
          });
    let canonicalSurfaces =
      existing.length > 0 ? baseSurfaces : ensureInkCanvasExtent(baseSurfaces, minimumTotalHeight);
    if (existing.length === 0) {
      for (const created of canonicalSurfaces) {
        await this.input.inkRepository.writeSurface(created);
      }
    }
    if (
      this.input.unpublishedPhysicalInkHat !== undefined &&
      canonicalSurfaces.some(({ schemaVersion }) => schemaVersion < 3)
    ) {
      const upgraded = upgradeInkSurfaceRecordsToV3(canonicalSurfaces, new Date().toISOString());
      const committed = await this.input.inkRepository.upgradeSurfacesToSchemaV3(
        upgraded,
        canonicalSurfaces,
      );
      canonicalSurfaces = committed ?? upgraded;
    }

    if (
      this.disposed ||
      view.getMode() !== 'preview' ||
      view.file === null ||
      view.file.path !== filePath
    ) {
      return null;
    }
    const latestRoot = view.contentEl.querySelector<HTMLElement>('.markdown-preview-sizer');
    if (latestRoot === null) {
      if (createIfMissing) {
        new Notice('The Reading View is still rendering. Try Ink Mode again in a moment.');
      }
      return null;
    }
    root = latestRoot;
    scrollContainer =
      root.closest<HTMLElement>('.markdown-preview-view') ??
      view.contentEl.querySelector<HTMLElement>('.markdown-preview-view') ??
      view.contentEl;
    minimumTotalHeight = Math.max(
      minimumTotalHeight,
      root.scrollHeight,
      root.getBoundingClientRect().height,
    );
    const transientSurfaces = ensureInkCanvasExtent(canonicalSurfaces, minimumTotalHeight);

    let controller: InkCanvasController | null = null;
    const session = new InkLiveDocument({
      instrumentation: {
        beginPersistenceSpan: () => {
          const span = this.inkPerformance.beginSpan('ink-canonical-persistence-submit', {
            workPhase: 'cold',
          });
          return (accepted) => span.finish({ accepted });
        },
        onAuditGuard: (guard) => this.inkPerformance.armAuditGuard(guard),
        onPersistenceWork: ({ kind, phase }) => this.inkPerformance.recordAuditedWork(kind, phase),
      },
      onChange: (read: InkDocumentReadView, change: InkDocumentChange | null) => {
        controller?.sync(read, change);
        if (read.persistence.kind === 'saved-locally') {
          this.commitFileHasInkState(filePath, hasVisibleInkRead(read));
          this.invalidateSiblingMounts(view, filePath, session);
          this.syncActions();
        }
      },
      surfaces: canonicalSurfaces,
      writer: this.input.inkRepository,
    });
    session.ensureMinimumHeight(measureInkCanvasExtent(transientSurfaces));
    controller = new InkCanvasController({
      controlsHost: this.input.document.body,
      document: this.input.document,
      inkPerformance: this.inkPerformance,
      layoutRoot: root,
      onLayoutExtentChanged: (minimumHeight) => {
        session.ensureMinimumHeight(minimumHeight);
      },
      onExitRequested: () => this.exit(),
      onExportUnsavedRequested: async () => {
        if (this.input.exportUnsavedInk === undefined) {
          throw new Error('Unsaved Ink export is unavailable.');
        }
        const snapshot = session.materializeColdSnapshot();
        const path = await this.input.exportUnsavedInk(snapshot.surface);
        new Notice(`Exported retained Ink SVG to ${path}`);
      },
      onPreferenceChanged: (preference) => {
        try {
          this.input.preferenceStore.save(preference);
        } catch (error) {
          this.onIssue(error);
        }
      },
      onRetryRequested: () =>
        controller === null ? Promise.resolve() : this.retryFailedSave(view, controller),
      preference: this.input.preferenceStore.load(),
      ...(this.input.recordInputToPaint === undefined
        ? {}
        : { recordInputToPaint: this.input.recordInputToPaint }),
      root: scrollContainer,
      scrollContainer,
      session,
      ...(this.input.unpublishedPhysicalInkHat === undefined
        ? {}
        : {
            unpublishedPhysicalInkHat: {
              session,
            },
          }),
      viewportHost: view.contentEl,
      ...(this.input.workerPresentation === undefined
        ? {}
        : { workerPresentation: this.input.workerPresentation }),
    });
    const mounted = {
      complete: true,
      controller,
      filePath,
      session,
    };
    this.mounted.set(view, mounted);
    return mounted;
  }

  private async restoreLocalRecovery(
    filePath: string,
    canonical: readonly InkSurfaceRecord[],
  ): Promise<readonly InkSurfaceRecord[]> {
    const reader = this.legacyRecoveryReader;
    if (reader === undefined) return canonical;
    let checkpoint;
    try {
      checkpoint = reader.load(filePath);
    } catch (error) {
      this.warnIgnoredLegacyRecovery(filePath, error);
      return canonical;
    }
    if (checkpoint === null) return canonical;
    const plan = planLocalInkRecovery(canonical, checkpoint, new Date().toISOString());
    if (plan.kind === 'conflict') {
      if (checkpoint.version === 4 && checkpoint.acknowledgedSequence === checkpoint.lastSequence) {
        return canonical;
      }
      this.warnIgnoredLegacyRecovery(filePath, new Error(plan.message));
      return canonical;
    }
    if (plan.writes.length > 1) {
      await this.input.inkRepository.updateSurfacesAtomically(plan.writes, plan.expectedBases);
    } else if (plan.writes[0] !== undefined) {
      await this.input.inkRepository.updateSurface(plan.writes[0], plan.expectedBases[0]);
    }
    return plan.records;
  }

  private warnIgnoredLegacyRecovery(filePath: string, error: unknown): void {
    const key = normalizeVaultPath(filePath);
    if (this.ignoredLegacyRecovery.has(key)) return;
    this.ignoredLegacyRecovery.add(key);
    console.warn(
      `[Inkstone Annotations] Ignoring stale read-only legacy Ink Recovery for ${filePath}; canonical Ink remains authoritative.`,
      error,
    );
  }

  private invalidateSiblingMounts(
    ownerView: MarkdownView,
    filePath: string,
    ownerSession: InkLiveDocument,
  ): void {
    if (this.mounted.get(ownerView)?.session !== ownerSession) return;
    const fileKey = normalizeVaultPath(filePath);
    for (const [view, mounted] of [...this.mounted]) {
      if (
        view !== ownerView &&
        normalizeVaultPath(mounted.filePath) === fileKey &&
        view !== this.activeView
      ) {
        this.disposeMount(view);
      }
    }
  }

  private disposeMount(view: MarkdownView): void {
    const mounted = this.mounted.get(view);
    mounted?.controller.dispose();
    if (mounted !== undefined) this.forgetMount(view, mounted);
  }

  private forgetMount(view: MarkdownView, mounted: MountedInkSurface): void {
    if (this.mounted.get(view) !== mounted) return;
    if (this.pendingExit?.mounted === mounted) this.pendingExit = null;
    this.mounted.delete(view);
    this.previewViews.delete(view);
  }

  /**
   * Commits an authoritative local Ink-presence observation and invalidates older async summaries.
   * The version advances even when Set membership is unchanged: deleting the final stroke can
   * confirm an already-empty state while an earlier sidecar summary is still in flight.
   */
  private commitHasInkState(view: MarkdownView, hasInk: boolean): void {
    this.hasInkStateVersions.set(view, (this.hasInkStateVersions.get(view) ?? 0) + 1);
    if (hasInk) this.hasInkViews.add(view);
    else this.hasInkViews.delete(view);
  }

  /**
   * Publishes one canonical save result to every registered view of the same file.
   *
   * Each view's version must advance independently so a summary request started before the save
   * cannot restore stale Ink-presence UI in a sibling tab after the canonical state changed.
   */
  private commitFileHasInkState(filePath: string, hasInk: boolean): void {
    const fileKey = normalizeVaultPath(filePath);
    for (const view of this.actions.keys()) {
      const currentPath = view.file?.path;
      if (currentPath !== undefined && normalizeVaultPath(currentPath) === fileKey) {
        this.commitHasInkState(view, hasInk);
      }
    }
  }

  /** Re-derives a file's presentation state from canonical surfaces, never from the summary cache. */
  private async reconcileFileHasInkState(filePath: string): Promise<boolean | null> {
    const fileKey = normalizeVaultPath(filePath);
    const expectedVersions = new Map<MarkdownView, number>();
    for (const view of this.actions.keys()) {
      const currentPath = view.file?.path;
      if (currentPath === undefined || normalizeVaultPath(currentPath) !== fileKey) continue;
      const version = (this.hasInkStateVersions.get(view) ?? 0) + 1;
      this.hasInkStateVersions.set(view, version);
      expectedVersions.set(view, version);
    }
    const hasInk = await this.readCanonicalFileHasInkState(filePath);
    if (hasInk === null) return null;
    for (const [view, expectedVersion] of expectedVersions) {
      const currentPath = view.file?.path;
      if (
        !this.actions.has(view) ||
        currentPath === undefined ||
        normalizeVaultPath(currentPath) !== fileKey ||
        this.hasInkStateVersions.get(view) !== expectedVersion
      ) {
        continue;
      }
      this.commitHasInkState(view, hasInk);
    }
    this.syncActions();
    return hasInk;
  }

  private async readCanonicalFileHasInkState(filePath: string): Promise<boolean | null> {
    if (typeof this.input.inkRepository.listSurfaces === 'function') {
      const loaded = await this.input.inkRepository.listSurfaces(filePath);
      const canonicalBlock = findInkSurfaceCanonicalProjectionBlock(loaded);
      if (canonicalBlock?.kind === 'conflict') {
        this.onIssue(canonicalBlock.conflict);
        return null;
      }
      if (canonicalBlock !== null) {
        this.onIssue(canonicalBlock.issue);
        return null;
      }
      return loaded.records.some(hasVisibleInk);
    }
    if (typeof this.input.inkRepository.listSurfaceSummaries === 'function') {
      const summaries = await this.input.inkRepository.listSurfaceSummaries(filePath);
      return summaries.some(
        (summary) => summary.deletedAt === undefined && summary.strokeCount > 0,
      );
    }
    return null;
  }

  private syncActions(): void {
    for (const [view, action] of this.actions) {
      const readingView = isAnnotationReadingView(view);
      action.hidden = !readingView;
      action.toggleAttribute('aria-hidden', !readingView);
      if (!readingView) {
        action.setAttribute('aria-disabled', 'true');
        action.toggleAttribute('disabled', true);
        continue;
      }
      const active = view === this.activeView;
      const pending = view === this.pendingView;
      const preview = !active && this.previewViews.has(view);
      const hiddenInk = !active && !preview && this.hasInkViews.has(view);
      const failed = active && this.pendingExit?.view === view;
      const label = pending
        ? this.pendingAction === 'exit'
          ? '正在保存涂鸦…'
          : '正在打开涂鸦…'
        : failed
          ? '保存失败 · 重试'
          : active
            ? '完成涂鸦并预览'
            : preview
              ? '正在预览涂鸦 · 编辑'
              : hiddenInk
                ? '涂鸦已隐藏 · 显示预览'
                : '开始涂鸦';
      const icon = pending
        ? 'loader-circle'
        : failed
          ? 'rotate-ccw'
          : active
            ? 'check'
            : hiddenInk
              ? 'eye'
              : INK_ENTRY_ICON;
      action.classList.toggle('is-active', active);
      action.classList.toggle('is-preview', preview);
      action.classList.toggle('is-pending', pending);
      action.classList.toggle('is-error', failed);
      action.classList.toggle('has-hidden-ink', hiddenInk);
      action.classList.toggle('is-saving', pending && this.pendingAction === 'exit');
      setIcon(action, icon);
      setTooltip(action, label, { placement: 'bottom' });
      action.setAttribute('aria-busy', String(pending));
      action.setAttribute('aria-disabled', String(pending));
      action.setAttribute('aria-label', label);
      action.toggleAttribute('disabled', pending);
      if (pending && this.pendingAction !== null) {
        action.dataset.inkstoneInkTransition = this.pendingAction;
      } else {
        delete action.dataset.inkstoneInkTransition;
      }
      action.setAttribute('data-tooltip-position', 'bottom');
    }
  }
}

function requestUnsavedInkExitDecision(input: {
  readonly filePath: string;
  readonly reason: InkPassiveExitReason;
}): Promise<InkUnsavedExitDecision> {
  if (typeof globalThis.confirm !== 'function') return Promise.resolve('cancel');
  if (globalThis.confirm(`Save unsaved Ink changes in ${input.filePath}?`)) {
    return Promise.resolve('save');
  }
  if (globalThis.confirm('Discard these unsaved Ink changes? This cannot be undone.')) {
    return Promise.resolve('discard');
  }
  return Promise.resolve('cancel');
}

function hasVisibleInkRead(read: InkDocumentReadView): boolean {
  return read.strokes.some(({ stroke }) => stroke.tool !== 'eraser');
}

function hasVisibleInk(record: InkSurfaceRecord): boolean {
  return (
    record.deletedAt === undefined && record.strokes.some((stroke) => stroke.tool !== 'eraser')
  );
}

function createContinuousSurfaceRecords(input: {
  readonly deviceId: string;
  readonly filePath: string;
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly noteId: string;
  readonly root: HTMLElement;
  readonly sourceRevision: string;
  readonly style: CSSStyleDeclaration;
}): readonly InkSurfaceRecord[] {
  const now = new Date().toISOString();
  const chunkHeight = 4096;
  const count = Math.max(1, Math.ceil(input.logicalHeight / chunkHeight));
  const fontSize = positiveNumber(input.style.fontSize, 16);
  const fontFamily = input.style.fontFamily || 'system-ui';
  return Array.from({ length: count }, (_, index): InkSurfaceRecord => ({
    createdAt: now,
    deviceId: input.deviceId,
    filePath: input.filePath,
    id: `surface-${globalThis.crypto.randomUUID()}`,
    layout: {
      blockFingerprints: [],
      fontFamily,
      fontSize,
      lineHeight: positiveNumber(input.style.lineHeight, fontSize * 1.5),
      logicalHeight: Math.min(chunkHeight, input.logicalHeight - index * chunkHeight),
      logicalWidth: input.logicalWidth,
      originY: index * chunkHeight,
      sourceRevision: input.sourceRevision,
      themeMode: input.root.closest('.theme-dark') === null ? 'light' : 'dark',
    },
    noteId: input.noteId,
    revision: 1,
    schemaVersion: 2,
    status: 'active',
    strokes: [],
    updatedAt: now,
  }));
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
