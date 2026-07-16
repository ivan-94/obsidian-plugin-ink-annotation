import { MarkdownView, Notice } from 'obsidian';
import type { App } from 'obsidian';

import { type InkSurfaceSessionSnapshot } from '../../application/ink-surface-session';
import { KeyedSerialTaskQueue } from '../../runtime/keyed-serial-task-queue';
import { InkDocumentSession } from '../../application/ink-document-session';
import { ensureInkCanvasExtent } from '../../domain/ink-canvas-extent';
import type { InkSurfaceRecord } from '../../domain/ink-surface';
import { migrateInkSurfaceRecordsToV2 } from '../../domain/ink-surface-migration';
import { INK_DOCUMENT_LOGICAL_WIDTH } from '../../domain/ink-workspace';
import { hashText } from '../../domain/text-anchor';
import type { InkSurfaceRepository } from '../../storage/ink-surface-repository';
import { normalizeVaultPath, type SidecarRepository } from '../../storage/sidecar-repository';
import { InkCanvasController } from '../../ui/ink-canvas-controller';
import type { InkSurfaceSummary } from '../../domain/ink-surface-summary';
import type { LocalInkToolPreferenceStore } from '../../storage/local-ink-tool-preference';
import { type InkRecoveryStore, planLocalInkRecovery } from '../../storage/local-ink-recovery';
import { waitForInkLayoutReadiness } from './ink-layout-readiness';

const NO_LOCAL_INK_RECOVERY: InkRecoveryStore = Object.freeze({
  claim: () => undefined,
  clear: () => undefined,
  load: () => null,
  save: () => '',
});

interface MountedInkSurface {
  readonly complete: boolean;
  readonly controller: InkCanvasController;
  readonly filePath: string;
  readonly session: InkDocumentSession;
}

interface PendingInkExit {
  readonly mounted: MountedInkSurface;
  readonly target: 'raw' | 'preview';
  readonly view: MarkdownView;
}

interface RetainedInkSessionOwner {
  readonly filePath: string;
  readonly ownerId: string;
  readonly retry: () => Promise<void>;
  retryPromise: Promise<void> | null;
  readonly session: InkDocumentSession;
  readonly waiters: Set<() => void>;
}

const RETAINED_INK_SESSION_OWNERS = Symbol.for(
  'inkstone.annotations.retained-ink-session-owners.v2',
);

type RetainedInkSessionRegistry = WeakMap<Document, Map<string, RetainedInkSessionOwner>>;

/** Coordinates one continuous canvas backed by independently persisted bounded surfaces. */
export class ObsidianInkModeManager {
  private activeLeafEpoch = 0;
  private activeView: MarkdownView | null = null;
  private readonly actions = new Map<MarkdownView, HTMLElement>();
  private readonly deferredRegistrations = new Map<
    MarkdownView,
    { readonly owner: RetainedInkSessionOwner; readonly resume: () => void }
  >();
  private disposed = false;
  private readonly mounted = new Map<MarkdownView, MountedInkSurface>();
  private readonly fileMountQueue = new KeyedSerialTaskQueue<string>();
  private readonly lifecycleQueue = new KeyedSerialTaskQueue<'active-owner'>();
  private readonly mountQueue = new KeyedSerialTaskQueue<MarkdownView>();
  private readonly refreshQueue = new KeyedSerialTaskQueue<MarkdownView>();
  private readonly onIssue: (error: unknown) => void;
  private readonly onWillEnter: () => void;
  private pendingAction: 'enter' | 'exit' | null = null;
  private pendingExit: PendingInkExit | null = null;
  private pendingView: MarkdownView | null = null;
  private previewByDefault: boolean;
  private readonly previewViews = new Set<MarkdownView>();
  private readonly recoveryStore: InkRecoveryStore;
  private readonly recoveryOwnerId: string;
  private readonly recoveryActions = new Map<MarkdownView, HTMLElement>();
  private observedActiveView: MarkdownView | null = null;
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
      readonly recoveryStore?: InkRecoveryStore;
      readonly recordInputToPaint?: (durationMs: number) => void;
      readonly showInkPreviewByDefault?: boolean;
      readonly textRepository: SidecarRepository;
    },
  ) {
    this.onIssue = input.onIssue ?? (() => undefined);
    this.onWillEnter = input.onWillEnter ?? (() => undefined);
    this.previewByDefault = input.showInkPreviewByDefault ?? false;
    this.recoveryStore = input.recoveryStore ?? NO_LOCAL_INK_RECOVERY;
    this.recoveryOwnerId = globalThis.crypto.randomUUID();
    input.document.addEventListener('visibilitychange', this.visibilityHandler);
    input.document.defaultView?.addEventListener('blur', this.windowBlurHandler);
  }

  registerAllMarkdownViews(): void {
    for (const leaf of this.input.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView) {
        this.registerView(leaf.view);
      }
    }
  }

  registerView(view: MarkdownView): void {
    if (this.disposed) return;
    const retainedOwner = this.retainedOwnerFor(view);
    if (retainedOwner !== null) {
      this.deferRegistration(view, retainedOwner);
      return;
    }
    this.cancelDeferredRegistration(view);
    if (this.actions.has(view)) {
      void this.refreshQueue
        .schedule(view, () => this.refreshRegisteredView(view))
        .catch(this.onIssue);
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
    if (this.previewByDefault) void this.showPreview(view).catch(this.onIssue);
  }

  toggle(view = this.input.app.workspace.getActiveViewOfType(MarkdownView)): Promise<void> {
    if (view === null) {
      new Notice('Open a Markdown note in Reading View to use Ink Mode.');
      return Promise.resolve();
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
      await this.exitActiveView(false);
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
    const target =
      !forceRaw && this.previewByDefault && mounted.session.snapshot().surface.strokes.length > 0
        ? 'preview'
        : 'raw';
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
    if (target === 'preview') this.previewViews.add(view);
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
    if (this.disposed) {
      const mounted = this.mounted.get(view);
      return mounted?.controller === controller
        ? this.retryRetainedSave(view, mounted)
        : Promise.resolve();
    }
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

  private async retryRetainedSave(
    view: MarkdownView,
    retainedMount: MountedInkSurface,
  ): Promise<void> {
    const mounted = this.mounted.get(view);
    if (mounted !== retainedMount) return;
    await mounted.session.retry();
    if (!mounted.session.recoverySnapshot().requiresRecovery) {
      mounted.controller.dispose();
      this.forgetMount(view, mounted);
      if (this.activeView === view) this.activeView = null;
      const owner = retainedInkSessionRegistry()
        .get(this.input.document)
        ?.get(normalizeVaultPath(mounted.filePath));
      if (owner?.session === mounted.session && owner.ownerId === this.recoveryOwnerId) {
        releaseRetainedInkSessionOwner(this.input.document, owner);
      }
    }
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

  /** Detaches stale Ink sessions after delete or restore; Reading View never mounts an overlay. */
  async refreshFile(filePath: string): Promise<void> {
    await this.scheduleLifecycle(async () => {
      await this.prepareFileMutationNow(filePath);
      for (const [view, mounted] of this.mounted) {
        if (mounted.filePath === filePath) this.disposeMount(view);
      }
    });
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
    this.observeActiveLeaf();
    const current = this.observedActiveView;
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
    const activeView = this.activeView;
    const activeMount = activeView === null ? undefined : this.mounted.get(activeView);
    let retainedView: MarkdownView | null = null;
    if (activeMount !== undefined) {
      let flushResult: Promise<{ readonly ok: boolean }>;
      try {
        const flush = activeMount.controller.background();
        flushResult = flush.then(
          () => ({ ok: true }),
          (error: unknown) => {
            this.onIssue(error);
            return { ok: false };
          },
        );
      } catch (error) {
        this.onIssue(error);
        flushResult = Promise.resolve({ ok: false });
      }
      let generation: string | null = null;
      let checkpointFailed = false;
      try {
        generation = this.checkpointMountedSession(activeMount);
      } catch (error) {
        checkpointFailed = true;
        this.onIssue(error);
      }
      if (generation !== null) {
        void flushResult.then(({ ok }) => {
          if (!ok) return;
          try {
            this.recoveryStore.clear(activeMount.filePath, generation);
          } catch (error) {
            this.onIssue(error);
          }
        });
      }
      if (checkpointFailed && activeView !== null) {
        const owner = this.retainSessionOwner(activeMount, flushResult);
        if (owner === null) {
          // An already-retained same-file owner means an invariant was violated by overlapping
          // plugin lifecycles. Keep this controller reachable instead of discarding a second
          // unsaved session; the existing owner still prevents any new canonical writer.
          retainedView = activeView;
        } else {
          activeMount.controller.dispose();
          this.forgetMount(activeView, activeMount);
          if (this.activeView === activeView) this.activeView = null;
        }
      }
    }
    for (const view of [...this.mounted.keys()]) {
      if (view !== retainedView) this.disposeMount(view);
    }
    if (retainedView === null) this.activeView = null;
    this.pendingExit = null;
    for (const action of this.actions.values()) {
      action.remove();
    }
    for (const view of this.actions.keys()) {
      if (view === retainedView) continue;
      view.contentEl
        .querySelectorAll<HTMLElement>('.inkstone-ink-surface')
        .forEach((surface) => surface.remove());
    }
    this.lifecycleQueue.clear();
    this.fileMountQueue.clear();
    this.mountQueue.clear();
    this.refreshQueue.clear();
    for (const view of [...this.deferredRegistrations.keys()]) {
      this.cancelDeferredRegistration(view);
    }
    for (const action of this.recoveryActions.values()) action.remove();
    this.recoveryActions.clear();
    this.actions.clear();
    this.previewViews.clear();
  }

  private retainedOwnerFor(view: MarkdownView): RetainedInkSessionOwner | null {
    const filePath = view.file?.path;
    if (filePath === undefined) return null;
    const owner = retainedInkSessionRegistry()
      .get(this.input.document)
      ?.get(normalizeVaultPath(filePath));
    return owner === undefined || owner.ownerId === this.recoveryOwnerId ? null : owner;
  }

  private retainSessionOwner(
    mounted: MountedInkSurface,
    flushResult: Promise<{ readonly ok: boolean }>,
  ): RetainedInkSessionOwner | null {
    const registry = retainedInkSessionRegistry();
    let byFile = registry.get(this.input.document);
    if (byFile === undefined) {
      byFile = new Map();
      registry.set(this.input.document, byFile);
    }
    const filePath = normalizeVaultPath(mounted.filePath);
    const existing = byFile.get(filePath);
    if (existing !== undefined && existing.ownerId !== this.recoveryOwnerId) {
      this.onIssue(
        new Error(`Cannot retain a second live Ink session owner for ${mounted.filePath}.`),
      );
      return null;
    }
    const session = mounted.session;
    const document = this.input.document;
    const owner: RetainedInkSessionOwner = {
      filePath,
      ownerId: this.recoveryOwnerId,
      retry: async () => {
        const { ok } = await flushResult;
        if (!ok) await session.retry();
        if (!session.recoverySnapshot().requiresRecovery) {
          releaseRetainedInkSessionOwner(document, owner);
        }
      },
      retryPromise: null,
      session,
      waiters: existing?.waiters ?? new Set(),
    };
    byFile.set(filePath, owner);
    void flushResult.then(({ ok }) => {
      if (ok) releaseRetainedInkSessionOwner(document, owner);
    });
    return owner;
  }

  private deferRegistration(view: MarkdownView, owner: RetainedInkSessionOwner): void {
    const deferred = this.deferredRegistrations.get(view);
    if (deferred?.owner === owner) {
      this.ensureRecoveryAction(view, owner);
      return;
    }
    if (deferred !== undefined) {
      deferred.owner.waiters.delete(deferred.resume);
      this.removeRecoveryAction(view);
    }
    const resume = (): void => {
      if (this.deferredRegistrations.get(view)?.resume !== resume) return;
      this.deferredRegistrations.delete(view);
      this.removeRecoveryAction(view);
      if (!this.disposed) this.registerView(view);
    };
    owner.waiters.add(resume);
    this.deferredRegistrations.set(view, { owner, resume });
    this.ensureRecoveryAction(view, owner);
  }

  private cancelDeferredRegistration(view: MarkdownView): void {
    const deferred = this.deferredRegistrations.get(view);
    if (deferred === undefined) return;
    deferred.owner.waiters.delete(deferred.resume);
    this.deferredRegistrations.delete(view);
    this.removeRecoveryAction(view);
  }

  private ensureRecoveryAction(view: MarkdownView, owner: RetainedInkSessionOwner): void {
    if (this.recoveryActions.has(view)) return;
    const action = view.addAction('rotate-ccw', 'Retry unsaved Ink', () => {
      void this.retryRetainedOwner(owner).catch(this.onIssue);
    });
    action.dataset.inkstoneInkRecoveryAction = 'true';
    action.setAttribute('aria-label', 'Retry unsaved Ink');
    this.recoveryActions.set(view, action);
  }

  private removeRecoveryAction(view: MarkdownView): void {
    this.recoveryActions.get(view)?.remove();
    this.recoveryActions.delete(view);
  }

  private retryRetainedOwner(owner: RetainedInkSessionOwner): Promise<void> {
    const current = retainedInkSessionRegistry().get(this.input.document)?.get(owner.filePath);
    if (current !== owner) return Promise.resolve();
    if (owner.retryPromise !== null) return owner.retryPromise;
    const retry = owner.retry().finally(() => {
      if (owner.retryPromise === retry) owner.retryPromise = null;
    });
    owner.retryPromise = retry;
    return retry;
  }

  private observeActiveLeaf(): number {
    const current = this.input.app.workspace.getActiveViewOfType(MarkdownView);
    if (current !== this.observedActiveView) {
      this.observedActiveView = current;
      this.activeLeafEpoch += 1;
    }
    return this.activeLeafEpoch;
  }

  private checkpointMountedSession(mounted: MountedInkSurface): string | null {
    const recovery = mounted.session.recoverySnapshot();
    return recovery.requiresRecovery
      ? this.recoveryStore.save(mounted.filePath, recovery.records, this.recoveryOwnerId, {
          expectedBases: recovery.expectedBases,
          pendingAttempts: recovery.pendingAttempts,
        })
      : null;
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
    if (this.activeView !== view) {
      if (this.previewByDefault) await this.showPreview(view);
      return;
    }
    const previousMount = this.mounted.get(view);
    if (!this.isActiveViewCompatible(view)) {
      await this.exitActiveView(true);
      if (
        !this.disposed &&
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
      await this.exitActiveView(true);
      if (
        !this.disposed &&
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

  private async showPreview(view: MarkdownView): Promise<void> {
    if (this.disposed || this.activeView === view) return;
    const mounted = await this.ensureMounted(view, false);
    if (mounted === null || this.disposed || this.activeView === view) return;
    if (!this.previewByDefault) {
      if (this.mounted.get(view) === mounted) this.disposeMount(view);
      return;
    }
    mounted.controller.showPreview();
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
    if (this.retainedOwnerFor(view) !== null) return null;
    if (this.disposed || view.getMode() !== 'preview' || view.file === null) {
      if (createIfMissing) {
        new Notice('Switch this Markdown note to Reading View before entering Ink Mode.');
      }
      return null;
    }
    await waitForInkLayoutReadiness(this.input.document);
    if (this.retainedOwnerFor(view) !== null) return null;
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
    const fileKey = normalizeVaultPath(filePath);
    let recoveryClaimed = ![...this.mounted].some(
      ([mountedView, mounted]) =>
        mountedView !== view && normalizeVaultPath(mounted.filePath) === fileKey,
    );
    if (recoveryClaimed) {
      try {
        this.recoveryStore.claim?.(filePath, this.recoveryOwnerId);
      } catch (error) {
        recoveryClaimed = false;
        this.onIssue(error);
      }
    }
    const source = await this.input.app.vault.cachedRead(file);
    const sourceRevision = await hashText(source);
    const loaded = await this.input.inkRepository.listSurfaces(filePath);
    if (loaded.conflicts.some((conflict) => conflict.kind === 'same-revision-divergence')) {
      if (createIfMissing) {
        new Notice('Ink has an iCloud conflict. Repair the conflicting copies before drawing.');
      }
      return null;
    }
    let existing = loaded.records.filter((record) => record.deletedAt === undefined);
    if (existing.length === 0 && !createIfMissing) return null;
    if (!createIfMissing && !existing.some((record) => record.strokes.length > 0)) return null;

    const note = await this.input.textRepository.getOrCreateNote({
      createId: () => globalThis.crypto.randomUUID(),
      filePath,
      now: new Date().toISOString(),
      sourceFingerprint: sourceRevision,
    });
    if (existing.some((record) => record.schemaVersion === 1)) {
      if (!createIfMissing) return null;
      const migration = migrateInkSurfaceRecordsToV2(existing, new Date().toISOString());
      if (migration.kind === 'manual-placement-required') {
        if (createIfMissing) {
          new Notice('Existing Ink has no unique canonical order. Manual placement is required.');
        }
        return null;
      }
      await this.input.inkRepository.updateSurfacesAtomically(migration.records);
      existing = [...migration.records];
    }
    existing = [
      ...(recoveryClaimed ? await this.restoreLocalRecovery(filePath, existing) : existing),
    ];

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
    const preparedSurfaces = ensureInkCanvasExtent(baseSurfaces, minimumTotalHeight);
    if (existing.length === 0) {
      for (const created of preparedSurfaces) {
        await this.input.inkRepository.writeSurface(created);
      }
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
    const surfaces = ensureInkCanvasExtent(preparedSurfaces, minimumTotalHeight);

    let controller: InkCanvasController | null = null;
    let recoveryGeneration: string | null = null;
    let recoveryRecords: readonly InkSurfaceRecord[] | null = null;
    let recoveryFailureFlushScheduled = false;
    const session = new InkDocumentSession({
      onChange: (snapshot: InkSurfaceSessionSnapshot) => {
        if (this.disposed) {
          controller?.sync(snapshot);
          return;
        }
        const recovery = session.recoverySnapshot();
        try {
          if (recovery.requiresRecovery) {
            const changed =
              recoveryRecords === null ||
              recoveryRecords.length !== recovery.records.length ||
              recovery.records.some((record, index) => recoveryRecords?.[index] !== record);
            if (changed) {
              recoveryGeneration = this.recoveryStore.save(
                filePath,
                recovery.records,
                this.recoveryOwnerId,
                {
                  expectedBases: recovery.expectedBases,
                  pendingAttempts: recovery.pendingAttempts,
                },
              );
              recoveryRecords = recovery.records;
            }
          } else if (recoveryGeneration !== null) {
            this.recoveryStore.clear(filePath, recoveryGeneration);
            recoveryGeneration = null;
            recoveryRecords = null;
          }
        } catch (error) {
          this.onIssue(error);
          if (recovery.requiresRecovery && !recoveryFailureFlushScheduled) {
            recoveryFailureFlushScheduled = true;
            queueMicrotask(() => {
              void session
                .background()
                .catch(this.onIssue)
                .finally(() => {
                  recoveryFailureFlushScheduled = false;
                });
            });
          }
        }
        controller?.sync(snapshot);
        if (snapshot.persistence.kind === 'saved-locally') {
          this.invalidateSiblingMounts(view, filePath, session);
        }
      },
      surfaces,
      writer: this.input.inkRepository,
    });
    controller = new InkCanvasController({
      controlsHost: this.input.document.body,
      document: this.input.document,
      layoutRoot: root,
      onLayoutExtentChanged: (minimumHeight) => {
        session.ensureMinimumHeight(minimumHeight);
      },
      onExitRequested: () => this.exit(),
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
    });
    const mounted = { complete: true, controller, filePath, session };
    this.mounted.set(view, mounted);
    return mounted;
  }

  private async restoreLocalRecovery(
    filePath: string,
    canonical: readonly InkSurfaceRecord[],
  ): Promise<readonly InkSurfaceRecord[]> {
    let checkpoint;
    try {
      checkpoint = this.recoveryStore.load(filePath);
    } catch (error) {
      this.onIssue(error);
      return canonical;
    }
    if (checkpoint === null) return canonical;
    const plan = planLocalInkRecovery(canonical, checkpoint, new Date().toISOString());
    if (plan.kind === 'conflict') throw new Error(plan.message);
    if (plan.writes.length > 1) {
      await this.input.inkRepository.updateSurfacesAtomically(plan.writes, plan.expectedBases);
    } else if (plan.writes[0] !== undefined) {
      await this.input.inkRepository.updateSurface(plan.writes[0], plan.expectedBases[0]);
    }
    try {
      this.recoveryStore.clear(filePath, checkpoint.generation);
    } catch (error) {
      this.onIssue(error);
    }
    return plan.records;
  }

  private invalidateSiblingMounts(
    ownerView: MarkdownView,
    filePath: string,
    ownerSession: InkDocumentSession,
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

  private syncActions(): void {
    for (const [view, action] of this.actions) {
      const active = view === this.activeView;
      const pending = view === this.pendingView;
      const preview = !active && this.previewViews.has(view);
      const label = pending
        ? this.pendingAction === 'exit'
          ? 'Exiting Ink Mode…'
          : 'Opening Ink Mode…'
        : active
          ? 'Exit Ink Mode'
          : preview
            ? 'Edit Ink'
            : 'Draw on this note';
      action.classList.toggle('is-active', active);
      action.classList.toggle('is-preview', preview);
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
}

function retainedInkSessionRegistry(): RetainedInkSessionRegistry {
  const scope = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const existing = scope[RETAINED_INK_SESSION_OWNERS];
  if (existing instanceof WeakMap) return existing as RetainedInkSessionRegistry;
  const created: RetainedInkSessionRegistry = new WeakMap();
  scope[RETAINED_INK_SESSION_OWNERS] = created;
  return created;
}

function releaseRetainedInkSessionOwner(document: Document, owner: RetainedInkSessionOwner): void {
  const registry = retainedInkSessionRegistry();
  const byFile = registry.get(document);
  if (byFile?.get(owner.filePath) !== owner) return;
  byFile.delete(owner.filePath);
  if (byFile.size === 0) registry.delete(document);
  for (const resume of owner.waiters) queueMicrotask(resume);
  owner.waiters.clear();
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
