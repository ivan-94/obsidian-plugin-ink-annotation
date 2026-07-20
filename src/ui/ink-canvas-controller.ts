import type {
  InkDocumentApplyResult,
  InkDocumentChange,
  InkDocumentCommand,
  InkDocumentReadView,
  InkLogicalRect,
  InkRenderableStrokeRef,
} from '../application/ink-document-session';
import type { InkPoint, InkStroke } from '../domain/ink-surface';
import {
  NOOP_INK_PERFORMANCE_RECORDER,
  type InkInputAdapter,
  type InkInputPhase,
  type InkPerformanceContact,
  type InkPerformanceRecorder,
  type InkPerformanceSpan,
  type InkPerformanceSpanName,
  type InkPerformanceWorkPhase,
} from '../runtime/ink-performance-diagnostics';
import { InkPresentationGenerationLedger } from '../runtime/ink-presentation-generation-ledger';
import {
  fitInkWorkspaceScale,
  INK_DOCUMENT_LOGICAL_WIDTH,
  INK_FIT_GUTTER,
  stepInkWorkspaceScale,
} from '../domain/ink-workspace';
import {
  LocalInkToolPreferenceStore,
  resolveInkToolStyles,
  type InkToolPreference,
} from '../storage/local-ink-tool-preference';
import { InkToolbarApp, type InkToolbarAppProps } from './ink/ink-toolbar-app';
import {
  createInkStageFrame,
  sameInkStageFrame,
  type CssPoint,
  type CssRect,
  type InkStageFrame,
} from './ink-stage-frame';
import {
  InkCapturePipeline,
  PointerEventInkAdapter,
  WebKitStylusTouchAdapter,
  type InkBorrowedProvisionalTail,
  type InkCaptureBatchContext,
  type InkCaptureResult,
} from './ink-capture-pipeline';
import {
  InkRenderRuntime,
  type InkActivePresentationAdapterState,
  type InkRenderRuntimeStats,
  type InkWorkerPresentationRuntimeOptions,
} from './ink-render-runtime';
import {
  InkUnpublishedPhysicalInkCandidate,
  type InkPhysicalCandidateDocumentPort,
  type InkUnpublishedPhysicalCandidateCapture,
  type InkUnpublishedPhysicalCandidateRead,
} from './ink-physical-candidate-controller';
import { createPreactIsland, type UiIsland } from './runtime/mount-preact-island';
import { viewportBounds } from './runtime/anchored-layer-position';
import {
  createInkToolbarStore,
  type InkToolbarState,
  type InkToolbarStore,
} from './stores/ink-toolbar-store';

interface InkSessionLike {
  apply(
    command: InkDocumentCommand,
    preparedGeometry?: {
      readonly bounds: InkLogicalRect;
      readonly color: string;
      readonly logicalStrokeId: string;
      readonly tool: InkStroke['tool'];
      readonly version: InkStroke['brushRenderVersion'];
    },
  ): InkDocumentApplyResult;
  background(): Promise<void>;
  cancelSelectionMove?(): boolean;
  canRedo(): boolean;
  canUndo(): boolean;
  clearSelection?(): boolean;
  commitSelectionMove?(): boolean;
  deleteSelectedStrokes?(): readonly string[];
  eraseStrokeAt(point: InkPoint, radius: number): string | null;
  eraseStrokesInPolygon(polygon: readonly InkPoint[]): readonly string[];
  enter(): void;
  exit(): Promise<void>;
  noteUserInteraction?(): void;
  redo(): boolean;
  previewSelectionMove?(dx: number, dy: number): { readonly dx: number; readonly dy: number };
  query(viewport: InkLogicalRect): readonly InkRenderableStrokeRef[];
  read(): InkDocumentReadView;
  retry(): Promise<void>;
  selectStrokeAt?(point: InkPoint, tolerance: number, additive?: boolean): readonly string[];
  setInteractionActive?(active: boolean): void;
  selectedStrokeIds?(): readonly string[];
  strokeIdAt?(point: InkPoint, tolerance: number): string | null;
  undo(): boolean;
}

let nextInkControllerInstance = 0;
const VIEWPORT_SETTLE_DELAY_MS = 120;

interface InkControlsDragState {
  readonly left: number;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly top: number;
}

interface InkSelectionDragState {
  readonly dragged: boolean;
  readonly pointerId: number;
  readonly start: InkPoint;
  readonly startClient: CssPoint;
  readonly toggleOnClick: boolean;
}

interface InkClientInputSample {
  readonly clientX: number;
  readonly clientY: number;
  readonly pressure: number;
  readonly timeStamp: number;
}

interface InkLayoutPresentation {
  readonly rect: CssRect;
  readonly scale: number;
}

interface InkToolStyle {
  readonly color: string;
  readonly width: number;
}

export interface InkUnpublishedPhysicalInkHatControllerOptions {
  readonly session: InkPhysicalCandidateDocumentPort;
}

type InkControllerCapture =
  | {
      readonly lane: 'legacy';
      readonly provisionalTail: InkBorrowedProvisionalTail | null;
      readonly result: InkCaptureResult;
      readonly sampleCount: number;
    }
  | {
      readonly lane: 'physical';
      readonly provisionalTail: null;
      readonly result: InkUnpublishedPhysicalCandidateCapture;
      readonly sampleCount: number;
    };

type InkToolStyles = Record<InkStroke['tool'], InkToolStyle>;

const DISABLED_POINTER_PERFORMANCE_CONTACT: InkPerformanceContact = Object.freeze({
  adapter: 'pointer',
  sequence: 0,
});
const DISABLED_STYLUS_PERFORMANCE_CONTACT: InkPerformanceContact = Object.freeze({
  adapter: 'stylus-touch',
  sequence: 0,
});

/** A single fixed logical surface. Rendering stays pointer-transparent in every view mode. */
export class InkCanvasController {
  private active = false;
  private activeContactDiagnosticsEnabled = false;
  private activePointerId: number | null = null;
  private activeStylusTouchId: number | null = null;
  private activePerformanceContact: InkPerformanceContact | null = null;
  private cachedCaptureBatchContext: InkCaptureBatchContext | null = null;
  private readonly capturePipeline = new InkCapturePipeline();
  private readonly controls: HTMLElement;
  private currentRead: InkDocumentReadView;
  private lastSynchronizedChange: InkDocumentChange | null = null;
  private controlsDragState: InkControlsDragState | null = null;
  private disposed = false;
  private readonly document: Document;
  private documentOriginInset: CssPoint | null;
  private contactStageFrameFrozen = false;
  private deferredStageFrame: InkStageFrame | null = null;
  private readonly dragHandle: HTMLButtonElement;
  private readonly extentProbeTimeouts = new Set<number>();
  private eraserPreviewColor = '#dc2626';
  private hintShown: boolean;
  private hoveredStrokeId: string | null = null;
  private inputTarget: HTMLElement;
  private layoutRoot: HTMLElement;
  private readonly onExitRequested: () => Promise<void>;
  private readonly onExportUnsavedRequested: () => Promise<void>;
  private readonly onLayoutExtentChanged: (minimumHeight: number) => void;
  private readonly onPreferenceChanged: (preference: InkToolPreference) => void;
  private readonly onRetryRequested: () => Promise<void>;
  private readonly inkPerformance: InkPerformanceRecorder;
  private readonly overlay: HTMLElement;
  private readonly presentationLedger: InkPresentationGenerationLedger;
  private readonly physicalCandidate: InkUnpublishedPhysicalInkCandidate | null;
  private pendingExitTarget: 'raw' | 'preview' = 'raw';
  private readingContextRestoreFrame: number | null = null;
  private previousPosition: string;
  private reportedLayoutExtent = 0;
  private readonly renderRuntime: InkRenderRuntime;
  private resizeObserver: ResizeObserver | null = null;
  private root: HTMLElement;
  private scrollContainer: HTMLElement | null;
  private readonly session: InkSessionLike;
  private stageFrame: InkStageFrame;
  private stageFrameChanged = true;
  private stageFrameEpoch = 0;
  private selectionDragState: InkSelectionDragState | null = null;
  private selectionCommittedStrokes: readonly InkStroke[] | null = null;
  private selectionFrame: number | null = null;
  private pendingSelectionDelta: { readonly dx: number; readonly dy: number } | null = null;
  private readonly pointerInkAdapter = new PointerEventInkAdapter();
  private readonly toolbarHost: HTMLElement;
  private readonly toolbarIsland: UiIsland<InkToolbarAppProps> = createPreactIsland(InkToolbarApp);
  private readonly toolbarStore: InkToolbarStore;
  private readonly toolStyles: InkToolStyles;
  private readonly touchInkAdapter = new WebKitStylusTouchAdapter();
  private viewMode: 'raw' | 'preview' | 'edit' = 'raw';
  private viewportSettleTimer: number | null = null;
  private readonly viewportHost: HTMLElement | null;

  private get viewportHeight(): number {
    return this.stageFrame.logicalViewport.height;
  }

  get activePresentationAdapterState(): InkActivePresentationAdapterState | null {
    return this.renderRuntime.activePresentationAdapterState;
  }

  get renderRuntimeStats(): InkRenderRuntimeStats {
    return this.renderRuntime.stats();
  }

  private get viewportLeft(): number {
    return this.stageFrame.logicalViewport.left;
  }

  private get viewportTop(): number {
    return this.stageFrame.logicalViewport.top;
  }

  private get viewportWidth(): number {
    return this.stageFrame.logicalViewport.width;
  }

  private get color(): string {
    return this.toolbarStore.state.value.color;
  }

  private get tool(): InkStroke['tool'] {
    return this.toolbarStore.state.value.tool;
  }

  private get width(): number {
    return this.toolbarStore.state.value.width;
  }

  constructor(input: {
    readonly controlsHost?: HTMLElement;
    readonly document: Document;
    readonly inkPerformance?: InkPerformanceRecorder;
    readonly layoutRoot?: HTMLElement;
    readonly now?: () => number;
    readonly onExitRequested?: () => Promise<void>;
    readonly onExportUnsavedRequested?: () => Promise<void>;
    readonly onLayoutExtentChanged?: (minimumHeight: number) => void;
    readonly onPreferenceChanged?: (preference: InkToolPreference) => void;
    readonly onRetryRequested?: () => Promise<void>;
    readonly preference?: InkToolPreference;
    readonly recordInputToPaint?: (durationMs: number) => void;
    readonly root: HTMLElement;
    readonly scrollContainer?: HTMLElement;
    readonly session: InkSessionLike;
    readonly viewportHost?: HTMLElement;
    readonly workerPresentation?: InkWorkerPresentationRuntimeOptions;
    readonly unpublishedPhysicalInkHat?: InkUnpublishedPhysicalInkHatControllerOptions;
  }) {
    nextInkControllerInstance += 1;
    const controllerInstance = String(nextInkControllerInstance);
    this.document = input.document;
    this.root = input.root;
    this.layoutRoot = input.layoutRoot ?? input.root;
    this.scrollContainer = input.scrollContainer ?? null;
    this.viewportHost = input.viewportHost ?? null;
    this.inputTarget = this.scrollContainer ?? this.root;
    this.session = input.session;
    this.inkPerformance = input.inkPerformance ?? NOOP_INK_PERFORMANCE_RECORDER;
    this.onExitRequested = input.onExitRequested ?? (() => this.exit());
    this.onExportUnsavedRequested = input.onExportUnsavedRequested ?? (() => Promise.resolve());
    this.onLayoutExtentChanged = input.onLayoutExtentChanged ?? (() => undefined);
    this.presentationLedger = new InkPresentationGenerationLedger({
      diagnostics: this.inkPerformance,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.recordInputToPaint === undefined ? {} : { onSubmitted: input.recordInputToPaint }),
    });
    const preference = input.preference ?? LocalInkToolPreferenceStore.DEFAULT;
    this.hintShown = preference.hintShown;
    this.toolStyles = initialToolStyles(preference);
    this.toolbarStore = createInkToolbarStore({
      ...preference,
      ...this.toolStyles[preference.tool],
    });
    this.onPreferenceChanged = input.onPreferenceChanged ?? (() => undefined);
    this.onRetryRequested = input.onRetryRequested ?? (() => this.retrySave());
    this.physicalCandidate =
      input.unpublishedPhysicalInkHat === undefined
        ? null
        : new InkUnpublishedPhysicalInkCandidate({
            onStateChange: this.onPhysicalCandidateStateChange,
            session: input.unpublishedPhysicalInkHat.session,
          });
    this.previousPosition = input.root.style.position;
    if (getComputedStyle(input.root).position === 'static') {
      input.root.style.position = 'relative';
    }
    input.root.classList.add('inkstone-ink-host');

    const read = input.session.read();
    this.currentRead = read;
    this.stageFrame = createInkStageFrame({
      actualScale: 1,
      canvasClientRect: {
        height: this.paneHeight(read.logicalHeight),
        left: 0,
        top: 0,
        width: this.paneWidth(INK_DOCUMENT_LOGICAL_WIDTH),
      },
      documentClientOrigin: { x: 0, y: 0 },
    });
    this.overlay = input.document.createElement('div');
    this.overlay.className = 'inkstone-ink-surface';
    this.overlay.dataset.inkstoneInkController = controllerInstance;
    this.overlay.dataset.inkstoneInkSurface = read.documentId;
    this.overlay.hidden = true;
    this.overlay.style.width = `${INK_DOCUMENT_LOGICAL_WIDTH}px`;
    this.overlay.style.height = `${read.logicalHeight}px`;

    this.renderRuntime = new InkRenderRuntime({
      document: input.document,
      host: this.overlay,
      inkPerformance: this.inkPerformance,
      onActiveFrame: this.onRenderActiveFrame,
      onActiveFrameUnpresented: (generation) =>
        this.presentationLedger.cancel('unpresented', generation),
      onDiagnostic: this.onRenderDiagnostic,
      query: (viewport) => this.session.query(viewport),
      read: () => this.session.read(),
      ...(input.workerPresentation === undefined
        ? {}
        : { workerPresentation: input.workerPresentation }),
    });

    this.toolbarHost = input.document.createElement('div');
    this.toolbarHost.dataset.inkstoneControllerActive = 'false';
    this.toolbarHost.dataset.inkstoneInkController = controllerInstance;
    this.toolbarHost.dataset.inkstonePhysicalCandidate =
      this.physicalCandidate === null ? 'unavailable' : this.physicalCandidate.read().kind;
    this.toolbarHost.dataset.inkstoneInkToolbarHost = '';
    (input.controlsHost ?? input.root).append(this.toolbarHost);
    this.toolbarIsland.mount(this.toolbarHost, this.toolbarProps());
    const controls = this.toolbarHost.querySelector<HTMLElement>('.inkstone-ink-controls');
    const dragHandle = this.toolbarHost.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-drag-handle]',
    );
    if (controls === null || dragHandle === null) throw new Error('Ink toolbar failed to mount.');
    this.controls = controls;
    this.dragHandle = dragHandle;
    input.root.append(this.overlay);
    this.documentOriginInset = this.captureDocumentOriginInset();
    this.positionOverlay();

    this.attachHostListeners();
    this.document.defaultView?.addEventListener('resize', this.onRootResized);
    this.document.defaultView?.visualViewport?.addEventListener('resize', this.onRootResized);
    this.document.defaultView?.visualViewport?.addEventListener('scroll', this.onRootResized);
    this.sync(read, null);
    const ResizeObserverConstructor =
      input.document.defaultView?.ResizeObserver ??
      (typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver);
    if (ResizeObserverConstructor !== undefined) {
      this.resizeObserver = new ResizeObserverConstructor(this.onRootResized);
      this.resizeObserver.observe(this.layoutRoot);
      if (this.root !== this.layoutRoot) this.resizeObserver.observe(this.root);
    }
    queueMicrotask(this.onRootResized);
    this.scheduleExtentProbes();
  }

  enter(): void {
    if (this.disposed) {
      throw new Error('Cannot enter a disposed Ink surface.');
    }
    this.session.enter();
    this.active = true;
    this.toolbarHost.dataset.inkstoneControllerActive = 'true';
    this.viewMode = 'edit';
    this.overlay.hidden = false;
    this.root.classList.remove('is-ink-preview');
    this.root.classList.add('is-ink-mode');
    this.preserveReadingContext(() => {
      this.activateWorkspace();
      this.positionOverlay();
    });
    this.document.addEventListener('keydown', this.onDocumentKeyDown);
    this.updateToolbar({ active: true });
    this.positionControlsDefault();
    this.sync(this.session.read());
    this.enterPhysicalCandidate();
    if (!this.hintShown) {
      this.hintShown = true;
      this.updateToolbar({
        statusText: 'Ink Mode · Draw with mouse or pen. Exit returns to reading.',
      });
      this.persistPreference();
    }
  }

  showPreview(): void {
    if (this.disposed) throw new Error('Cannot preview a disposed Ink surface.');
    if (this.active) return;
    this.viewMode = 'preview';
    this.overlay.hidden = false;
    this.root.classList.remove('is-ink-mode');
    this.root.classList.add('is-ink-preview');
    this.updateToolbar({ active: false });
    this.preserveReadingContext(() => {
      this.activateWorkspace();
      this.positionOverlay();
    });
    this.sync(this.session.read());
  }

  hidePreview(): void {
    if (this.active) return;
    this.viewMode = 'raw';
    this.overlay.hidden = true;
    this.root.classList.remove('is-ink-preview');
    this.preserveReadingContext(() => this.deactivateWorkspace());
  }

  async exit(target: 'raw' | 'preview' = 'raw'): Promise<void> {
    this.finishStroke(false);
    const resumeAfterFailure = this.active;
    this.active = false;
    this.updateToolbar({ statusText: 'Ink Mode · Saving…' });
    this.pendingExitTarget = target;
    try {
      await this.physicalCandidate?.discardUnused();
      await this.session.exit();
      this.sync(this.session.read());
      this.deactivate(target);
      this.pendingExitTarget = 'raw';
    } catch (error) {
      this.sync(this.session.read());
      if (resumeAfterFailure) this.enter();
      throw error;
    }
  }

  background(): Promise<void> {
    this.finishStroke(false);
    return (async () => {
      await this.physicalCandidate?.discardUnused();
      await this.session.background();
    })().finally(() => {
      this.sync(this.session.read());
      if (this.active) this.enterPhysicalCandidate();
    });
  }

  async retrySave(): Promise<void> {
    try {
      await this.session.retry();
    } finally {
      this.sync(this.session.read());
    }
  }

  coversHeight(minimumHeight: number): boolean {
    return this.currentRead.logicalHeight >= Math.ceil(minimumHeight);
  }

  isAttachedTo(
    layoutRoot: HTMLElement,
    hostRoot: HTMLElement = this.root,
    scrollContainer: HTMLElement | null = this.scrollContainer,
  ): boolean {
    return (
      this.layoutRoot === layoutRoot &&
      this.root === hostRoot &&
      this.scrollContainer === scrollContainer &&
      this.overlay.parentElement === hostRoot
    );
  }

  /** Keeps an active document session alive when Obsidian replaces its virtualized layout root. */
  reattach(
    layoutRoot: HTMLElement,
    hostRoot: HTMLElement = this.root,
    scrollContainer: HTMLElement | null = this.scrollContainer,
  ): void {
    if (this.disposed) {
      throw new Error('Cannot reattach a disposed Ink surface.');
    }
    if (this.isAttachedTo(layoutRoot, hostRoot, scrollContainer)) {
      this.positionOverlay();
      this.updateViewport(true);
      return;
    }
    const hostChanged = hostRoot !== this.root || scrollContainer !== this.scrollContainer;
    const logicalViewportTop = hostChanged ? this.viewportTop : null;
    if (hostChanged) {
      this.presentationLedger.cancel('unpresented');
      this.finishStroke(false);
      this.finishSelectionMove(false);
      this.cancelReadingContextRestore();
    }
    this.deactivateWorkspace();
    if (hostChanged) this.replaceHost(hostRoot, scrollContainer);
    this.layoutRoot = layoutRoot;
    if (this.viewMode !== 'raw') this.activateWorkspace();
    if (this.overlay.parentElement !== this.root) this.root.append(this.overlay);
    this.positionOverlay();
    if (logicalViewportTop !== null) this.restoreLogicalViewportTop(logicalViewportTop);
    this.reportedLayoutExtent = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver?.observe(layoutRoot);
    if (this.root !== layoutRoot) this.resizeObserver?.observe(this.root);
    this.updateViewport(true);
    this.onRootResized();
    this.scheduleExtentProbes();
  }

  sync(read: InkDocumentReadView, change: InkDocumentChange | null = null): void {
    if (this.disposed) {
      return;
    }
    if (change !== null && this.currentRead === read && this.lastSynchronizedChange === change) {
      return;
    }
    this.currentRead = read;
    this.lastSynchronizedChange = change;
    if (this.active && this.physicalCandidate !== null) {
      void this.physicalCandidate.synchronizePreparation().catch((error: unknown) => {
        if (this.disposed) return;
        this.updateToolbar({
          saveError:
            error instanceof Error ? error.message : 'Physical Ink preparation could not refresh.',
          statusText: 'Ink Mode · Physical Ink unavailable',
        });
      });
    }
    const logicalHeight = read.logicalHeight;
    if (this.scrollContainer === null) this.overlay.style.height = `${logicalHeight}px`;
    if (this.viewMode !== 'raw') {
      this.layoutRoot.style.setProperty('--inkstone-ink-logical-height', `${logicalHeight}px`);
    }
    if (this.viewMode !== 'raw') this.positionOverlay();
    this.updateViewport(false);
    if (change === null) {
      if (this.selectionCommittedStrokes === null) this.renderRuntime.installDocument(read);
    } else this.renderRuntime.applyDocumentChange(change);
    this.updateRenderOverlay();
    this.syncToolbarFromRead(read);
  }

  private syncToolbarFromRead(read: InkDocumentReadView): void {
    const error = read.persistence.kind === 'error';
    const saveError = error ? read.persistence.message : null;
    this.updateToolbar({
      canRedo: this.session.canRedo(),
      canUndo: this.session.canUndo(),
      saveError,
      selectedCount: this.session.selectedStrokeIds?.().length ?? 0,
      statusText: error
        ? `Ink Mode · ${read.persistence.message}`
        : read.persistence.kind === 'saving'
          ? 'Ink Mode · Saving locally…'
          : read.persistence.kind === 'saved-locally'
            ? 'Ink Mode · Saved locally'
            : 'Ink Mode',
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.physicalCandidate?.cancelActive();
    void this.physicalCandidate?.discardUnused().catch(() => undefined);
    this.session.setInteractionActive?.(false);
    this.presentationLedger.cancel('unpresented');
    this.renderRuntime.dispose();
    if (this.activePerformanceContact !== null) {
      this.inkPerformance.closeContact(this.activePerformanceContact);
      this.activePerformanceContact = null;
    }
    this.cancelReadingContextRestore();
    this.detachHostListeners();
    this.document.removeEventListener('keydown', this.onDocumentKeyDown);
    if (this.selectionFrame !== null) cancelAnimationFrame(this.selectionFrame);
    this.selectionFrame = null;
    this.pendingSelectionDelta = null;
    this.stopControlsDrag();
    this.document.defaultView?.removeEventListener('resize', this.onRootResized);
    this.document.defaultView?.visualViewport?.removeEventListener('resize', this.onRootResized);
    this.document.defaultView?.visualViewport?.removeEventListener('scroll', this.onRootResized);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const timeout of this.extentProbeTimeouts) {
      this.document.defaultView?.clearTimeout(timeout);
    }
    this.extentProbeTimeouts.clear();
    if (this.viewportSettleTimer !== null) {
      this.document.defaultView?.clearTimeout(this.viewportSettleTimer);
      this.viewportSettleTimer = null;
    }
    this.overlay.remove();
    this.toolbarIsland.unmount();
    this.toolbarHost.remove();
    this.root.classList.remove('inkstone-ink-host', 'is-ink-mode', 'is-ink-preview', 'is-ink-fit');
    this.deactivateWorkspace();
    this.root.style.position = this.previousPosition;
  }

  private enterPhysicalCandidate(): void {
    const candidate = this.physicalCandidate;
    if (candidate === null) return;
    const state = candidate.read();
    if (state.kind !== 'idle' && state.kind !== 'failed') return;
    void candidate.enter().catch((error: unknown) => {
      if (this.disposed) return;
      this.updateToolbar({
        saveError:
          error instanceof Error ? error.message : 'Physical Ink preparation could not start.',
        statusText: 'Ink Mode · Physical Ink unavailable',
      });
    });
  }

  private readonly onPhysicalCandidateStateChange = (
    state: InkUnpublishedPhysicalCandidateRead,
  ): void => {
    if (this.disposed) return;
    this.toolbarHost.dataset.inkstonePhysicalCandidate = state.kind;
    if (state.kind === 'failed') {
      this.updateToolbar({
        saveError: state.message,
        statusText: 'Ink Mode · Physical Ink failed',
      });
      return;
    }
    if (state.kind === 'ready') this.syncToolbarFromRead(this.session.read());
  };

  private readonly onRenderDiagnostic = (message: string): void => {
    if (this.disposed) return;
    this.updateToolbar({ statusText: `Ink Mode · ${message}` });
  };

  private attachHostListeners(): void {
    this.inputTarget.addEventListener('click', this.onReadingViewActivation, true);
    this.inputTarget.addEventListener('dblclick', this.onReadingViewActivation, true);
    this.inputTarget.addEventListener('selectstart', this.onReadingViewSelection, true);
    this.inputTarget.addEventListener('pointerdown', this.onPointerDown, true);
    this.inputTarget.addEventListener('pointermove', this.onPointerMove, true);
    this.inputTarget.addEventListener('pointerleave', this.onPointerLeave, true);
    this.inputTarget.addEventListener('pointerup', this.onPointerEnd, true);
    this.inputTarget.addEventListener('pointercancel', this.onPointerCancel, true);
    this.inputTarget.addEventListener('lostpointercapture', this.onLostPointerCapture, true);
    this.inputTarget.addEventListener('touchstart', this.onTouchStart, {
      capture: true,
      passive: false,
    });
    this.inputTarget.addEventListener('touchmove', this.onTouchMove, {
      capture: true,
      passive: false,
    });
    this.inputTarget.addEventListener('touchend', this.onTouchEnd, {
      capture: true,
      passive: false,
    });
    this.inputTarget.addEventListener('touchcancel', this.onTouchCancel, {
      capture: true,
      passive: false,
    });
    this.inputTarget.addEventListener('wheel', this.onNativeNavigationIntent, { passive: true });
    this.scrollContainer?.addEventListener('scroll', this.onScrolled, { passive: true });
  }

  private detachHostListeners(): void {
    this.inputTarget.removeEventListener('click', this.onReadingViewActivation, true);
    this.inputTarget.removeEventListener('dblclick', this.onReadingViewActivation, true);
    this.inputTarget.removeEventListener('selectstart', this.onReadingViewSelection, true);
    this.inputTarget.removeEventListener('pointerdown', this.onPointerDown, true);
    this.inputTarget.removeEventListener('pointermove', this.onPointerMove, true);
    this.inputTarget.removeEventListener('pointerleave', this.onPointerLeave, true);
    this.inputTarget.removeEventListener('pointerup', this.onPointerEnd, true);
    this.inputTarget.removeEventListener('pointercancel', this.onPointerCancel, true);
    this.inputTarget.removeEventListener('lostpointercapture', this.onLostPointerCapture, true);
    this.inputTarget.removeEventListener('touchstart', this.onTouchStart, true);
    this.inputTarget.removeEventListener('touchmove', this.onTouchMove, true);
    this.inputTarget.removeEventListener('touchend', this.onTouchEnd, true);
    this.inputTarget.removeEventListener('touchcancel', this.onTouchCancel, true);
    this.inputTarget.removeEventListener('wheel', this.onNativeNavigationIntent);
    this.scrollContainer?.removeEventListener('scroll', this.onScrolled);
  }

  private replaceHost(root: HTMLElement, scrollContainer: HTMLElement | null): void {
    const previousRoot = this.root;
    const controlsFollowRoot = this.toolbarHost.parentElement === previousRoot;
    this.detachHostListeners();
    previousRoot.classList.remove(
      'inkstone-ink-host',
      'is-ink-mode',
      'is-ink-preview',
      'is-ink-fit',
    );
    previousRoot.style.position = this.previousPosition;

    this.root = root;
    this.scrollContainer = scrollContainer;
    this.inputTarget = scrollContainer ?? root;
    this.previousPosition = root.style.position;
    if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
    root.classList.add('inkstone-ink-host');
    root.classList.toggle('is-ink-mode', this.viewMode === 'edit');
    root.classList.toggle('is-ink-preview', this.viewMode === 'preview');
    if (controlsFollowRoot) root.append(this.toolbarHost);
    root.append(this.overlay);
    this.documentOriginInset = null;
    this.attachHostListeners();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    const measurement = this.beginPerformanceSpan('ink-input-handler', 'input', 'pointer', 'down');
    const inputToSubmit = this.beginPerformanceSpan(
      'ink-input-to-submit',
      'input',
      'pointer',
      'down',
    );
    let accepted = false;
    let sampleCount = 0;
    try {
      if (this.active) this.session.noteUserInteraction?.();
      this.cancelReadingContextRestore();
      if (event.target instanceof Node && this.toolbarHost.contains(event.target)) return;
      if (this.preserveNativeTouchNavigation(event)) return;
      if (!this.active || event.button !== 0 || !isDrawingPointer(event.pointerType)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (this.toolbarStore.state.value.interaction === 'select') {
        const additive =
          this.toolbarStore.state.value.multiple ||
          event.shiftKey ||
          event.metaKey ||
          event.ctrlKey;
        this.beginSelection(event, event.pointerId, additive, true);
        return;
      }
      if (this.activePointerId !== null || this.activeStylusTouchId !== null) return;
      if (this.tool === 'eraser') this.eraserPreviewColor = this.resolveEraserPreviewColor();
      const captured = this.capturePointerEvent(event, 'down');
      if (captured === null || captured.result.kind !== 'active') return;
      accepted = true;
      this.contactStageFrameFrozen = true;
      this.session.setInteractionActive?.(true);
      this.activePerformanceContact = this.beginPerformanceContact('pointer');
      this.activePointerId = event.pointerId;
      sampleCount = captured.sampleCount;
      const presentationGeneration = this.presentationLedger.begin(
        this.activePerformanceContact,
        sampleCount,
        inputToSubmit,
      );
      // Synthetic Gate input and some WebKit lifecycle edges can reject pointer capture even
      // though the accepted contact remains routable by pointerId. Capture is an optional host
      // aid: never let it abort presentation ownership or the drawing path.
      try {
        this.inputTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // Continue with the controller's explicit pointerId ownership.
      }
      this.applyActiveCapture(captured, presentationGeneration);
    } finally {
      if (accepted) {
        measurement?.finish({ contact: this.activePerformanceContact, sampleCount });
      } else {
        inputToSubmit?.cancel();
        measurement?.cancel();
      }
    }
  };

  private readonly onReadingViewActivation = (event: MouseEvent): void => {
    if (!this.active) return;
    if (event.target instanceof Node && this.toolbarHost.contains(event.target)) return;
    if (event.type === 'click' && event.detail < 2) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly onReadingViewSelection = (event: Event): void => {
    if (!this.active) return;
    if (event.target instanceof Node && this.toolbarHost.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const measurement = this.beginPerformanceSpan('ink-input-handler', 'input', 'pointer', 'move');
    const inputToSubmit = this.beginPerformanceSpan(
      'ink-input-to-submit',
      'input',
      'pointer',
      'move',
    );
    const contact = this.activePerformanceContact;
    let accepted = false;
    let sampleCount = 0;
    try {
      if (this.preserveNativeTouchNavigation(event)) return;
      if (event.pointerId === this.selectionDragState?.pointerId) {
        event.preventDefault();
        event.stopPropagation();
        this.updateSelectionDrag(event);
        return;
      }
      if (
        this.active &&
        this.toolbarStore.state.value.interaction === 'select' &&
        this.selectionDragState === null &&
        this.activePointerId === null &&
        isDrawingPointer(event.pointerType)
      ) {
        const point = this.eventPoint(event);
        const hovered =
          point === null
            ? null
            : (this.session.strokeIdAt?.(point, Math.max(8, this.width)) ?? null);
        this.setHoveredStroke(hovered);
        return;
      }
      if (event.pointerId !== this.activePointerId || contact === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const captured = this.capturePointerEvent(event, 'move');
      if (captured === null) {
        if (this.pointerInkAdapter.lastAdmissionKind === 'invalid') this.finishStroke(false);
        return;
      }
      if (captured.result.kind !== 'active') return;
      accepted = true;
      sampleCount = captured.sampleCount;
      const presentationGeneration = this.presentationLedger.begin(
        contact,
        sampleCount,
        inputToSubmit,
      );
      this.applyActiveCapture(captured, presentationGeneration);
    } finally {
      if (accepted) {
        measurement?.finish({
          ...(this.pointerInkAdapter.lastCausalRepairKind === null
            ? {}
            : { causalRepair: this.pointerInkAdapter.lastCausalRepairKind }),
          contact,
          sampleCount,
        });
      } else {
        inputToSubmit?.cancel();
        measurement?.cancel();
      }
    }
  };

  private readonly onPointerLeave = (): void => {
    if (this.selectionDragState === null) this.setHoveredStroke(null);
  };

  private readonly onLostPointerCapture = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    this.finishStroke(false);
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    const measurement = this.beginPerformanceSpan(
      'ink-input-handler',
      'completion',
      'pointer',
      'up',
    );
    const contact = this.activePerformanceContact;
    let accepted = false;
    let sampleCount = 0;
    try {
      if (this.preserveNativeTouchNavigation(event)) return;
      if (event.pointerId === this.selectionDragState?.pointerId) {
        event.preventDefault();
        event.stopPropagation();
        if (this.selectionDragState.dragged === false) this.updateSelectionDrag(event);
        this.finishSelectionMove(true);
        return;
      }
      if (event.pointerId !== this.activePointerId || contact === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const captured = this.capturePointerEvent(event, 'up');
      if (captured === null || captured.result.kind === 'ignored') {
        this.finishStroke(false);
        return;
      }
      accepted = true;
      sampleCount = captured.sampleCount;
      this.finishStroke(true, captured);
    } finally {
      if (accepted) measurement?.finish({ contact, sampleCount });
      else measurement?.cancel();
    }
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    const measurement = this.beginPerformanceSpan(
      'ink-input-handler',
      'completion',
      'pointer',
      'cancel',
    );
    const contact = this.activePerformanceContact;
    let accepted = false;
    try {
      if (this.preserveNativeTouchNavigation(event)) return;
      if (event.pointerId === this.selectionDragState?.pointerId) {
        event.preventDefault();
        event.stopPropagation();
        this.finishSelectionMove(false);
        return;
      }
      if (event.pointerId !== this.activePointerId || contact === null) {
        return;
      }
      accepted = true;
      event.preventDefault();
      event.stopPropagation();
      this.capturePointerEvent(event, 'cancel');
      this.finishStroke(false);
    } finally {
      if (accepted) measurement?.finish({ contact, sampleCount: 0 });
      else measurement?.cancel();
    }
  };

  private readonly onTouchStart = (event: TouchEvent): void => {
    const measurement = this.beginPerformanceSpan(
      'ink-input-handler',
      'input',
      'stylus-touch',
      'down',
    );
    const inputToSubmit = this.beginPerformanceSpan(
      'ink-input-to-submit',
      'input',
      'stylus-touch',
      'down',
    );
    let accepted = false;
    let sampleCount = 0;
    try {
      this.cancelReadingContextRestore();
      if (!this.active) return;
      if (event.target instanceof Node && this.toolbarHost.contains(event.target)) return;
      const stylus = findStylusTouch(event.changedTouches);
      if (stylus === null) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const pointerId = stylusPointerId(stylus.identifier);
      const sample = touchInputSample(event, stylus);
      if (this.toolbarStore.state.value.interaction === 'select') {
        if (this.activePointerId !== null || this.selectionDragState !== null) return;
        this.activeStylusTouchId = stylus.identifier;
        const additive =
          this.toolbarStore.state.value.multiple ||
          event.shiftKey ||
          event.metaKey ||
          event.ctrlKey;
        if (!this.beginSelection(sample, pointerId, additive, false)) {
          this.activeStylusTouchId = null;
        }
        return;
      }
      if (this.activePointerId !== null || this.activeStylusTouchId !== null) return;
      if (this.tool === 'eraser') this.eraserPreviewColor = this.resolveEraserPreviewColor();
      const captured = this.captureTouchEvent(event, 'down');
      if (captured === null || captured.result.kind !== 'active') return;
      accepted = true;
      this.contactStageFrameFrozen = true;
      this.session.setInteractionActive?.(true);
      this.activeStylusTouchId = stylus.identifier;
      this.activePerformanceContact = this.beginPerformanceContact('stylus-touch');
      this.activePointerId = pointerId;
      sampleCount = captured.sampleCount;
      const presentationGeneration = this.presentationLedger.begin(
        this.activePerformanceContact,
        sampleCount,
        inputToSubmit,
      );
      this.applyActiveCapture(captured, presentationGeneration);
    } finally {
      if (accepted) {
        measurement?.finish({ contact: this.activePerformanceContact, sampleCount });
      } else {
        inputToSubmit?.cancel();
        measurement?.cancel();
      }
    }
  };

  private readonly onTouchMove = (event: TouchEvent): void => {
    const measurement = this.beginPerformanceSpan(
      'ink-input-handler',
      'input',
      'stylus-touch',
      'move',
    );
    const inputToSubmit = this.beginPerformanceSpan(
      'ink-input-to-submit',
      'input',
      'stylus-touch',
      'move',
    );
    const contact = this.activePerformanceContact;
    let accepted = false;
    let sampleCount = 0;
    try {
      if (!this.active) return;
      const stylus = findStylusTouch(event.changedTouches);
      if (stylus === null) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (stylus.identifier !== this.activeStylusTouchId) return;
      const sample = touchInputSample(event, stylus);
      if (stylusPointerId(stylus.identifier) === this.selectionDragState?.pointerId) {
        this.updateSelectionDrag(sample);
        return;
      }
      if (contact === null) return;
      const captured = this.captureTouchEvent(event, 'move');
      if (captured === null || captured.result.kind !== 'active') return;
      accepted = true;
      sampleCount = captured.sampleCount;
      const presentationGeneration = this.presentationLedger.begin(
        contact,
        sampleCount,
        inputToSubmit,
      );
      this.applyActiveCapture(captured, presentationGeneration);
    } finally {
      if (accepted) {
        measurement?.finish({ contact, sampleCount });
      } else {
        inputToSubmit?.cancel();
        measurement?.cancel();
      }
    }
  };

  private readonly onTouchEnd = (event: TouchEvent): void => {
    const measurement = this.beginPerformanceSpan(
      'ink-input-handler',
      'completion',
      'stylus-touch',
      'up',
    );
    const contact = this.activePerformanceContact;
    let accepted = false;
    let sampleCount = 0;
    try {
      if (!this.active) return;
      const stylus = findStylusTouch(event.changedTouches);
      if (stylus === null) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (stylus.identifier !== this.activeStylusTouchId) return;
      const sample = touchInputSample(event, stylus);
      if (stylusPointerId(stylus.identifier) === this.selectionDragState?.pointerId) {
        if (this.selectionDragState.dragged === false) this.updateSelectionDrag(sample);
        this.activeStylusTouchId = null;
        this.finishSelectionMove(true);
        return;
      }
      if (contact === null) return;
      const captured = this.captureTouchEvent(event, 'up');
      if (captured === null || captured.result.kind === 'ignored') {
        this.finishStroke(false);
        return;
      }
      accepted = true;
      sampleCount = captured.sampleCount;
      this.activeStylusTouchId = null;
      this.finishStroke(true, captured);
    } finally {
      if (accepted) measurement?.finish({ contact, sampleCount });
      else measurement?.cancel();
    }
  };

  private readonly onTouchCancel = (event: TouchEvent): void => {
    const measurement = this.beginPerformanceSpan(
      'ink-input-handler',
      'completion',
      'stylus-touch',
      'cancel',
    );
    const contact = this.activePerformanceContact;
    let accepted = false;
    try {
      if (!this.active) return;
      const stylus = findStylusTouch(event.changedTouches);
      if (stylus === null) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (stylus.identifier !== this.activeStylusTouchId) return;
      this.activeStylusTouchId = null;
      if (stylusPointerId(stylus.identifier) === this.selectionDragState?.pointerId) {
        this.finishSelectionMove(false);
        return;
      }
      if (contact === null) return;
      accepted = true;
      this.captureTouchEvent(event, 'cancel');
      this.finishStroke(false);
    } finally {
      if (accepted) measurement?.finish({ contact, sampleCount: 0 });
      else measurement?.cancel();
    }
  };

  private preserveNativeTouchNavigation(event: PointerEvent): boolean {
    if (!this.active || event.pointerType !== 'touch') return false;
    // WKWebView scrolls only when the real Reading View remains the hit target. Isolate its
    // component listeners without cancelling the browser's native pan action.
    event.stopPropagation();
    return true;
  }

  private readonly onControlsDragStart = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const bounds = this.controls.getBoundingClientRect();
    event.preventDefault();
    event.stopPropagation();
    this.controlsDragState = {
      left: bounds.left,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      top: bounds.top,
    };
    this.updateToolbar({ dragging: true });
    this.dragHandle.setPointerCapture?.(event.pointerId);
    this.document.addEventListener('pointermove', this.onControlsDragMove);
    this.document.addEventListener('pointerup', this.onControlsDragEnd);
    this.document.addEventListener('pointercancel', this.onControlsDragEnd);
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    this.cancelReadingContextRestore();
    if (this.active) this.session.noteUserInteraction?.();
    if (!this.active || event.key !== 'Escape') return;
    if (this.selectionDragState !== null) {
      event.preventDefault();
      event.stopPropagation();
      this.finishSelectionMove(false);
      return;
    }
    if (this.session.clearSelection?.() === true) {
      event.preventDefault();
      event.stopPropagation();
      this.sync(this.session.read());
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void this.onExitRequested().catch(() => undefined);
  };

  private readonly onControlsDragMove = (event: PointerEvent): void => {
    const drag = this.controlsDragState;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    this.moveControls(
      drag.left + event.clientX - drag.startX,
      drag.top + event.clientY - drag.startY,
    );
  };

  private readonly onControlsDragEnd = (event: PointerEvent): void => {
    if (event.pointerId !== this.controlsDragState?.pointerId) return;
    this.stopControlsDrag();
    this.persistPreference();
  };

  private readonly onControlsDragKeyDown = (event: KeyboardEvent): void => {
    const delta = event.shiftKey ? 32 : 8;
    const movements: Record<string, readonly [number, number]> = {
      ArrowDown: [0, delta],
      ArrowLeft: [-delta, 0],
      ArrowRight: [delta, 0],
      ArrowUp: [0, -delta],
    };
    const movement = movements[event.key];
    if (movement === undefined) return;
    event.preventDefault();
    const bounds = this.controls.getBoundingClientRect();
    this.moveControls(bounds.left + movement[0], bounds.top + movement[1]);
    this.persistPreference();
  };

  private captureBatchContext(): InkCaptureBatchContext {
    const style = this.toolStyles[this.tool];
    const physicalVisibleTool =
      this.physicalCandidate !== null && (this.tool === 'pen' || this.tool === 'highlighter');
    const color =
      this.tool === 'highlighter' && !physicalVisibleTool ? `${style.color}88` : style.color;
    const cached = this.cachedCaptureBatchContext;
    if (
      cached !== null &&
      cached.frame === this.stageFrame &&
      cached.frameEpoch === this.stageFrameEpoch &&
      cached.logicalBounds.height === this.currentRead.logicalHeight &&
      cached.logicalBounds.width === this.currentRead.logicalWidth &&
      cached.style.color === color &&
      cached.style.tool === this.tool &&
      cached.style.width === style.width
    ) {
      return cached;
    }
    const next = Object.freeze({
      frame: this.stageFrame,
      frameEpoch: this.stageFrameEpoch,
      logicalBounds: Object.freeze({
        height: this.currentRead.logicalHeight,
        width: this.currentRead.logicalWidth,
        x: 0,
        y: 0,
      }),
      style: Object.freeze({
        color,
        tool: this.tool,
        width: style.width,
      }),
    });
    this.cachedCaptureBatchContext = next;
    return next;
  }

  private capturePointerEvent(
    event: PointerEvent,
    phase: 'cancel' | 'down' | 'move' | 'up',
  ): InkControllerCapture | null {
    const context = this.captureBatchContext();
    const batch = this.pointerInkAdapter.createBatch(event, phase, context);
    if (batch === null) return null;
    if (
      this.physicalCandidate !== null &&
      (batch.style.tool === 'pen' || batch.style.tool === 'highlighter')
    ) {
      return {
        lane: 'physical',
        provisionalTail: null,
        result: this.physicalCandidate.accept(batch),
        sampleCount: batch.sampleCount,
      };
    }
    const result = this.capturePipeline.accept(batch);
    const provisionalTail =
      result.kind === 'active' &&
      (phase === 'down' || phase === 'move') &&
      result.style.tool !== 'eraser'
        ? this.pointerInkAdapter.createProvisionalTail(event, context)
        : null;
    return { lane: 'legacy', provisionalTail, result, sampleCount: batch.sampleCount };
  }

  private captureTouchEvent(
    event: TouchEvent,
    phase: 'cancel' | 'down' | 'move' | 'up',
  ): InkControllerCapture | null {
    const batch = this.touchInkAdapter.createBatch(event, phase, this.captureBatchContext());
    if (batch === null) return null;
    if (
      this.physicalCandidate !== null &&
      (batch.style.tool === 'pen' || batch.style.tool === 'highlighter')
    ) {
      return {
        lane: 'physical',
        provisionalTail: null,
        result: this.physicalCandidate.accept(batch),
        sampleCount: batch.sampleCount,
      };
    }
    return {
      lane: 'legacy',
      provisionalTail: null,
      result: this.capturePipeline.accept(batch),
      sampleCount: batch.sampleCount,
    };
  }

  private applyActiveCapture(captured: InkControllerCapture, presentationGeneration: number): void {
    if (captured.lane === 'physical') {
      const result = captured.result;
      if (result.kind !== 'active') {
        throw new Error('Ink controller cannot present a non-active physical capture.');
      }
      if (result.presentation === 'degraded-legacy') {
        this.renderRuntime.applyDegradedPhysicalActiveDelta({
          diagnostic: result.diagnostic,
          presentationDelta: result.presentationDelta,
          presentationGeneration,
          strokeId: result.strokeId,
          style: result.style,
        });
        return;
      }
      this.renderRuntime.applyPhysicalActiveDelta({
        alpha: result.alpha,
        color: result.style.color,
        geometryUpdate: result.geometryUpdate,
        presentationDelta: result.presentationDelta,
        presentationGeneration,
        strokeId: result.strokeId,
        style: result.style,
      });
      return;
    }
    const result = captured.result;
    if (result.kind !== 'active') {
      throw new Error('Ink controller cannot present a non-active legacy capture.');
    }
    this.renderRuntime.applyActiveDelta({
      ...(result.style.tool === 'eraser' ? { eraserColor: this.eraserPreviewColor } : {}),
      presentationDelta: result.presentationDelta,
      presentationGeneration,
      ...(captured.provisionalTail === null ? {} : { provisionalTail: captured.provisionalTail }),
      strokeId: result.strokeId,
      style: result.style,
    });
  }

  private eventPoint(event: InkClientInputSample): InkPoint | null {
    const logicalHeight = this.currentRead.logicalHeight;
    const point = this.stageFrame.clientToLogical({ x: event.clientX, y: event.clientY });
    return {
      pressure: event.pressure,
      time: event.timeStamp,
      x: point.x,
      y: clamp(point.y, 0, logicalHeight),
    };
  }

  private beginSelection(
    sample: InkClientInputSample,
    pointerId: number,
    additive: boolean,
    capturePointer: boolean,
  ): boolean {
    const start = this.eventPoint(sample);
    if (start === null) return false;
    const tolerance = Math.max(8, this.width);
    const hitStrokeId = this.session.strokeIdAt?.(start, tolerance) ?? null;
    const currentSelection = this.session.selectedStrokeIds?.() ?? [];
    const toggleOnClick =
      additive && hitStrokeId !== null && currentSelection.includes(hitStrokeId);
    const selected = toggleOnClick
      ? currentSelection
      : (this.session.selectStrokeAt?.(start, tolerance, additive) ?? []);
    this.selectionDragState =
      selected.length === 0
        ? null
        : {
            dragged: false,
            pointerId,
            start,
            startClient: { x: sample.clientX, y: sample.clientY },
            toggleOnClick,
          };
    if (this.selectionDragState !== null) this.session.setInteractionActive?.(true);
    this.hoveredStrokeId = hitStrokeId;
    this.inputTarget.style.cursor = this.selectionDragState === null ? '' : 'grabbing';
    if (capturePointer && this.selectionDragState !== null) {
      this.inputTarget.setPointerCapture?.(pointerId);
    }
    this.sync(this.session.read());
    return this.selectionDragState !== null;
  }

  private finishSelectionMove(commit: boolean): void {
    const drag = this.selectionDragState;
    const pointerId = drag?.pointerId;
    this.selectionDragState = null;
    this.activeStylusTouchId = null;
    if (
      pointerId !== undefined &&
      pointerId >= 0 &&
      this.inputTarget.hasPointerCapture?.(pointerId)
    ) {
      this.inputTarget.releasePointerCapture(pointerId);
    }
    this.flushSelectionPreview();
    if (commit && drag?.dragged === true) {
      this.session.commitSelectionMove?.();
    } else if (commit && drag?.toggleOnClick === true) {
      this.session.selectStrokeAt?.(drag.start, Math.max(8, this.width), true);
    } else if (!commit) {
      this.session.cancelSelectionMove?.();
    }
    this.selectionCommittedStrokes = null;
    this.renderRuntime.setCommittedExclusions([]);
    this.inputTarget.style.cursor = this.hoveredStrokeId === null ? '' : 'grab';
    this.sync(this.session.read());
  }

  private updateSelectionDrag(event: InkClientInputSample): void {
    const drag = this.selectionDragState;
    if (drag === null) return;
    const dragged =
      drag.dragged ||
      Math.hypot(event.clientX - drag.startClient.x, event.clientY - drag.startClient.y) >= 4;
    if (!dragged) return;
    if (!drag.dragged) this.selectionDragState = { ...drag, dragged: true };
    const point = this.eventPoint(event);
    if (point !== null) {
      this.scheduleSelectionPreview(point.x - drag.start.x, point.y - drag.start.y);
    }
  }

  private scheduleSelectionPreview(dx: number, dy: number): void {
    this.pendingSelectionDelta = { dx, dy };
    if (this.selectionFrame !== null) return;
    let completedSynchronously = false;
    const frame = requestAnimationFrame(() => {
      completedSynchronously = true;
      this.selectionFrame = null;
      this.flushSelectionPreview();
    });
    if (!completedSynchronously) this.selectionFrame = frame;
  }

  private flushSelectionPreview(): void {
    if (this.selectionFrame !== null) cancelAnimationFrame(this.selectionFrame);
    this.selectionFrame = null;
    const delta = this.pendingSelectionDelta;
    this.pendingSelectionDelta = null;
    if (delta === null) return;
    this.isolateSelectionPreviewFromCommittedLayer();
    this.session.previewSelectionMove?.(delta.dx, delta.dy);
    this.sync(this.session.read());
  }

  private isolateSelectionPreviewFromCommittedLayer(): void {
    if (
      this.selectionCommittedStrokes !== null ||
      this.session.previewSelectionMove === undefined
    ) {
      return;
    }
    const selected = new Set(this.session.selectedStrokeIds?.() ?? []);
    if (selected.size === 0) return;
    this.selectionCommittedStrokes = [];
    this.renderRuntime.setCommittedExclusions([...selected]);
  }

  private sealActiveContactForForcedStageFrame(): void {
    if (this.activePointerId === null && this.activeStylusTouchId === null) return;
    const captured: InkControllerCapture =
      this.physicalCandidate !== null && (this.tool === 'pen' || this.tool === 'highlighter')
        ? {
            lane: 'physical',
            provisionalTail: null,
            result: this.physicalCandidate.sealActive(),
            sampleCount: 0,
          }
        : {
            lane: 'legacy',
            provisionalTail: null,
            result: this.capturePipeline.sealActive(),
            sampleCount: 0,
          };
    this.finishStroke(true, captured);
  }

  private finishStroke(commit: boolean, captured?: InkControllerCapture): void {
    const measurement = commit
      ? this.beginPerformanceSpan('ink-stroke-commit', 'completion')
      : null;
    const contact = this.activePerformanceContact;
    let documentCommandProduced = false;
    try {
      const pointerId = this.activePointerId;
      this.activePointerId = null;
      this.activeStylusTouchId = null;
      if (!commit) {
        this.capturePipeline.cancelActive();
        this.physicalCandidate?.cancelActive();
        this.renderRuntime.cancelActive();
        this.presentationLedger.cancel('cancelled');
      }
      if (pointerId !== null && this.inputTarget.hasPointerCapture?.(pointerId)) {
        this.inputTarget.releasePointerCapture(pointerId);
      }
      if (captured?.lane === 'physical') {
        documentCommandProduced = this.finishPhysicalStroke(commit, captured.result);
        return;
      }
      const captureResult = captured?.lane === 'legacy' ? captured.result : undefined;
      if (captureResult?.kind === 'rejected') {
        this.renderRuntime.cancelActive();
        this.updateToolbar({
          saveError: null,
          statusText: 'Ink Mode · Stroke exceeded the capture safety limit and was discarded',
        });
        return;
      }
      const completed = captureResult?.kind === 'completed' ? captureResult : null;
      if (completed !== null) {
        const presentationGeneration = this.presentationLedger.begin();
        this.renderRuntime.applyActiveDelta({
          ...(completed.stroke.tool === 'eraser' ? { eraserColor: this.eraserPreviewColor } : {}),
          presentationDelta: completed.presentationDelta,
          presentationGeneration,
          strokeId: completed.stroke.id,
          style: {
            color: completed.stroke.color,
            tool: completed.stroke.tool,
            width: completed.stroke.width,
          },
        });
        this.renderRuntime.finalizeActive(completed.stroke);
      }
      const completedStroke = completed?.stroke ?? null;
      const points = completedStroke?.points ?? [];
      const closedLoopErase =
        (completedStroke?.tool ?? this.tool) === 'eraser' &&
        isClosedLoopEraseGesture(points, 1 / this.stageFrame.actualScale);
      if (!commit || points.length === 0) {
        return;
      }
      if ((completedStroke?.tool ?? this.tool) === 'eraser') {
        if (closedLoopErase) {
          documentCommandProduced = this.session.eraseStrokesInPolygon(points).length > 0;
          this.renderRuntime.cancelActive();
          this.sync(this.session.read());
          return;
        }
        const target = points.at(-1);
        if (target !== undefined) {
          documentCommandProduced =
            this.session.eraseStrokeAt(
              target,
              Math.max(8, completedStroke?.width ?? this.width),
            ) !== null;
        }
        this.renderRuntime.cancelActive();
        this.sync(this.session.read());
        return;
      }
      if (completed === null) return;
      const stroke = completed.stroke;
      documentCommandProduced = true;
      const result = this.session.apply(
        { id: `draw:${stroke.id}`, kind: 'add', stroke },
        {
          bounds: completed.bounds,
          color: stroke.color,
          logicalStrokeId: stroke.id,
          tool: stroke.tool,
          version: stroke.brushRenderVersion,
        },
      );
      this.renderRuntime.promoteActive(stroke.id);
      this.sync(this.session.read(), result.change);
    } finally {
      if (contact === null) measurement?.cancel();
      else measurement?.finish({ contact, documentCommandProduced });
      if (contact !== null) {
        this.presentationLedger.cancel('cancelled');
        if (this.activeContactDiagnosticsEnabled) this.inkPerformance.closeContact(contact);
        this.activeContactDiagnosticsEnabled = false;
        if (this.activePerformanceContact === contact) {
          this.activePerformanceContact = null;
          this.renderRuntime.setActivePerformanceContact(null);
        }
      }
      this.releaseContactStageFrame();
    }
  }

  private finishPhysicalStroke(
    commit: boolean,
    capture: InkUnpublishedPhysicalCandidateCapture,
  ): boolean {
    const candidate = this.physicalCandidate;
    if (candidate === null || !commit) return false;
    if (capture.kind === 'failed') {
      this.renderRuntime.cancelActive();
      this.updateToolbar({
        saveError: null,
        statusText: 'Ink Mode · Physical stroke failed closed',
      });
      return false;
    }
    if (capture.kind !== 'completed') {
      this.renderRuntime.cancelActive();
      return false;
    }

    // The logical document owns durability and undo semantics. A disposable renderer/cache
    // failure must never strand the physical candidate in `completed` or block the next contact.
    const result = candidate.commitCompleted();
    const presentationGeneration = this.presentationLedger.begin();
    const style = {
      color: capture.stroke.color,
      tool: capture.stroke.tool,
      width: capture.stroke.width,
    } as const;
    try {
      if (capture.presentation === 'degraded-legacy') {
        this.renderRuntime.applyDegradedPhysicalActiveDelta({
          diagnostic: capture.diagnostic,
          presentationDelta: capture.presentationDelta,
          presentationGeneration,
          strokeId: capture.stroke.id,
          style,
        });
      } else {
        this.renderRuntime.applyPhysicalActiveDelta({
          alpha: capture.alpha,
          color: capture.stroke.color,
          geometryUpdate: capture.geometryUpdate,
          presentationDelta: capture.presentationDelta,
          presentationGeneration,
          strokeId: capture.stroke.id,
          style,
        });
      }
      this.renderRuntime.finalizeActive(capture.stroke);
      this.renderRuntime.promoteActive(capture.stroke.id);
    } catch (error) {
      this.renderRuntime.cancelActive();
      this.sync(this.session.read(), result.change);
      this.onRenderDiagnostic(
        `Renderer recovered after stroke commit: ${error instanceof Error ? error.message : 'unknown rendering failure'}`,
      );
      return true;
    }
    this.sync(this.session.read(), result.change);
    return true;
  }

  private readonly onRenderActiveFrame = (renderGeneration: number | null): void => {
    if (this.disposed) {
      this.presentationLedger.cancel('unpresented');
      return;
    }
    this.presentationLedger.settle(renderGeneration, this.activePerformanceContact);
    if (this.activePointerId === null && this.selectionDragState === null) {
      this.session.setInteractionActive?.(false);
    }
  };

  private beginPerformanceContact(
    adapter: InkPerformanceContact['adapter'],
  ): InkPerformanceContact {
    this.activeContactDiagnosticsEnabled = this.inkPerformance.isEnabled();
    if (!this.activeContactDiagnosticsEnabled) {
      const contact =
        adapter === 'pointer'
          ? DISABLED_POINTER_PERFORMANCE_CONTACT
          : DISABLED_STYLUS_PERFORMANCE_CONTACT;
      this.renderRuntime.setActivePerformanceContact(contact);
      return contact;
    }
    const contact = this.inkPerformance.openContact(adapter);
    this.renderRuntime.setActivePerformanceContact(contact);
    return contact;
  }

  private beginPerformanceSpan(
    name: InkPerformanceSpanName,
    workPhase: InkPerformanceWorkPhase,
    adapter?: InkInputAdapter,
    inputPhase?: InkInputPhase,
  ): InkPerformanceSpan | null {
    if (!this.inkPerformance.isEnabled()) return null;
    if (
      this.activePointerId !== null &&
      (!this.activeContactDiagnosticsEnabled ||
        this.activePerformanceContact === null ||
        !this.inkPerformance.ownsContact(this.activePerformanceContact))
    ) {
      return null;
    }
    return adapter === undefined || inputPhase === undefined
      ? this.inkPerformance.beginSpan(name, { workPhase })
      : this.inkPerformance.beginSpan(name, { adapter, inputPhase, workPhase });
  }

  private visibleRefs(): readonly InkRenderableStrokeRef[] {
    const viewport = this.stageFrame.logicalViewport;
    const refs = this.session.query({
      height: viewport.height,
      width: viewport.width,
      x: viewport.left,
      y: viewport.top,
    });
    return [...refs].sort((left, right) => left.order - right.order);
  }

  private updateRenderOverlay(): void {
    if (this.activePointerId !== null || this.toolbarStore.state.value.interaction !== 'select') {
      this.renderRuntime.setOverlay({ hovered: [], selected: [] });
      return;
    }
    const refs = this.visibleRefs();
    const selected = new Set(this.session.selectedStrokeIds?.() ?? []);
    const hovered = this.hoveredStrokeId;
    this.renderRuntime.setOverlay({
      hovered: refs.filter(({ id }) => id === hovered && !selected.has(id)),
      selected: refs.filter(({ id }) => selected.has(id)),
    });
  }

  private setHoveredStroke(strokeId: string | null): void {
    if (strokeId === this.hoveredStrokeId) return;
    this.hoveredStrokeId = strokeId;
    this.inputTarget.style.cursor = strokeId === null ? '' : 'grab';
    this.updateRenderOverlay();
  }

  private readonly onScrolled = (): void => {
    if (this.disposed) return;
    if (this.active) this.session.noteUserInteraction?.();
    this.cancelReadingContextRestore();
    // Native scrolling changes only the client-space projection of the immutable document.
    // The pane-fixed Canvas rect and CSS zoom stay unchanged; only the document origin moves.
    // Recalibrating the fixed overlay here would create a write/read/write layout feedback loop.
    const layout = this.measureLayoutPresentation();
    const scale = layout.scale;
    const inset = this.documentOriginInset ?? { x: 0, y: 0 };
    this.publishStageFrame(
      createInkStageFrame({
        actualScale: scale,
        canvasClientRect: this.stageFrame.canvasClientRect,
        documentClientOrigin: {
          x: layout.rect.left + inset.x * scale,
          y: layout.rect.top + inset.y * scale,
        },
      }),
    );
    this.renderRuntime.projectFrame(this.stageFrame);
    this.scheduleViewportSettle();
  };

  private readonly onNativeNavigationIntent = (): void => {
    if (this.active) this.session.noteUserInteraction?.();
    this.cancelReadingContextRestore();
  };

  private readonly onRootResized = (): void => {
    if (this.disposed) return;
    const logicalViewportTop = this.viewMode === 'raw' ? null : this.viewportTop;
    this.clampDraggedControls();
    this.applyWorkspaceScale();
    this.positionOverlay();
    if (
      (this.activePointerId !== null || this.activeStylusTouchId !== null) &&
      this.deferredStageFrame !== null
    ) {
      this.sealActiveContactForForcedStageFrame();
    }
    if (logicalViewportTop !== null) this.restoreLogicalViewportTop(logicalViewportTop);
    if (this.viewportSettleTimer === null) {
      this.updateViewport(false);
    } else {
      this.renderRuntime.projectFrame(this.stageFrame);
      this.scheduleViewportSettle();
    }
    const scale = this.viewMode === 'raw' ? 1 : this.stageFrame.actualScale;
    const layout = this.measureLayoutPresentation();
    const visibleLogicalBottom =
      this.stageFrame.logicalViewport.top + this.stageFrame.logicalViewport.height;
    const extent = Math.ceil(
      Math.max(this.layoutRoot.scrollHeight, layout.rect.height / scale, visibleLogicalBottom),
    );
    if (!this.coversHeight(extent) && extent > this.reportedLayoutExtent) {
      this.reportedLayoutExtent = extent;
      this.onLayoutExtentChanged(extent);
    }
  };

  private scheduleExtentProbes(): void {
    const window = this.document.defaultView;
    if (window === null) return;
    for (const delay of [100, 500, 1500]) {
      const timeout = window.setTimeout(() => {
        this.extentProbeTimeouts.delete(timeout);
        this.onRootResized();
      }, delay);
      this.extentProbeTimeouts.add(timeout);
    }
  }

  private updateViewport(force: boolean): void {
    this.renderRuntime.setFrame(this.stageFrame);
    if (force || this.stageFrameChanged) this.renderRuntime.invalidateViewport();
    this.stageFrameChanged = false;
  }

  private scheduleViewportSettle(): void {
    const window = this.document.defaultView;
    if (window === null) {
      this.updateViewport(true);
      return;
    }
    if (this.viewportSettleTimer !== null) window.clearTimeout(this.viewportSettleTimer);
    this.viewportSettleTimer = window.setTimeout(() => {
      this.viewportSettleTimer = null;
      this.updateViewport(true);
    }, VIEWPORT_SETTLE_DELAY_MS);
  }

  private positionOverlay(): void {
    if (this.scrollContainer === null) {
      this.overlay.style.left = '0px';
      this.overlay.style.top = '0px';
      const layout = this.measureLayoutPresentation();
      const scale = layout.scale;
      const width = layout.rect.width || INK_DOCUMENT_LOGICAL_WIDTH * scale;
      const height = layout.rect.height || this.currentRead.logicalHeight * scale;
      const left = layout.rect.left;
      const top = layout.rect.top;
      const documentOriginInset = this.documentOriginInset ?? { x: 0, y: 0 };
      this.overlay.style.width = `${width}px`;
      this.overlay.style.height = `${height}px`;
      this.publishStageFrame(
        createInkStageFrame({
          actualScale: scale,
          canvasClientRect: { height, left, top, width },
          documentClientOrigin: {
            x: layout.rect.left + documentOriginInset.x * scale,
            y: layout.rect.top + documentOriginInset.y * scale,
          },
        }),
      );
      return;
    }
    const hostRect = this.root.getBoundingClientRect();
    const paneRect = this.scrollContainer.getBoundingClientRect();
    const layout = this.measureLayoutPresentation();
    const scale = layout.scale;
    const paneWidth = this.paneWidth(INK_DOCUMENT_LOGICAL_WIDTH);
    const paneHeight = this.paneHeight(this.stageFrame.canvasClientRect.height);
    if (this.documentOriginInset === null && !this.overlay.hidden) {
      this.documentOriginInset = this.captureDocumentOriginInset();
    }
    const targetCanvasRect = {
      height: paneHeight,
      left: paneRect.left + this.scrollContainer.clientLeft,
      top: paneRect.top + this.scrollContainer.clientTop,
      width: paneWidth,
    };
    const canvasClientRect = this.positionAndMeasureCanvas(hostRect, targetCanvasRect);
    const documentOriginInset = this.documentOriginInset ?? { x: 0, y: 0 };
    this.publishStageFrame(
      createInkStageFrame({
        actualScale: scale,
        canvasClientRect,
        documentClientOrigin: {
          x: layout.rect.left + documentOriginInset.x * scale,
          y: layout.rect.top + documentOriginInset.y * scale,
        },
      }),
    );
  }

  private restoreLogicalViewportTop(logicalTop: number): void {
    if (this.scrollContainer === null) return;
    const logicalDelta = logicalTop - this.viewportTop;
    if (!Number.isFinite(logicalDelta) || Math.abs(logicalDelta) <= 0.5) return;
    this.scrollContainer.scrollTop += logicalDelta * this.stageFrame.actualScale;
    this.positionOverlay();
  }

  private captureDocumentOriginInset(): CssPoint | null {
    if (this.scrollContainer === null) return Object.freeze({ x: 0, y: 0 });
    const previous = {
      height: this.overlay.style.height,
      hidden: this.overlay.hidden,
      left: this.overlay.style.left,
      top: this.overlay.style.top,
      width: this.overlay.style.width,
    };
    try {
      this.overlay.hidden = false;
      const hostRect = this.root.getBoundingClientRect();
      const paneRect = this.scrollContainer.getBoundingClientRect();
      this.overlay.style.left = `${paneRect.left - hostRect.left}px`;
      this.overlay.style.top = `${paneRect.top - hostRect.top}px`;
      this.overlay.style.width = `${this.paneWidth(INK_DOCUMENT_LOGICAL_WIDTH)}px`;
      this.overlay.style.height = `${this.paneHeight(this.stageFrame.canvasClientRect.height)}px`;
      const fixedRect = this.overlay.getBoundingClientRect();
      if (
        paneRect.width <= 0 ||
        paneRect.height <= 0 ||
        fixedRect.width <= 0 ||
        fixedRect.height <= 0
      ) {
        return null;
      }
      const localWidth = cssPixels(this.overlay.style.width);
      const localHeight = cssPixels(this.overlay.style.height);
      const containingBlockScaleX = localWidth > 0 ? fixedRect.width / localWidth : 1;
      const containingBlockScaleY = localHeight > 0 ? fixedRect.height / localHeight : 1;
      return Object.freeze({
        x:
          (fixedRect.left - paneRect.left) /
          (containingBlockScaleX > 0 ? containingBlockScaleX : 1),
        y: (fixedRect.top - paneRect.top) / (containingBlockScaleY > 0 ? containingBlockScaleY : 1),
      });
    } finally {
      this.overlay.style.left = previous.left;
      this.overlay.style.top = previous.top;
      this.overlay.style.width = previous.width;
      this.overlay.style.height = previous.height;
      this.overlay.hidden = previous.hidden;
    }
  }

  private positionAndMeasureCanvas(hostRect: DOMRect, target: CssRect): CssRect {
    this.overlay.style.left = `${target.left - hostRect.left}px`;
    this.overlay.style.top = `${target.top - hostRect.top}px`;
    this.overlay.style.width = `${target.width}px`;
    this.overlay.style.height = `${target.height}px`;
    if (!this.overlay.hidden) {
      for (let pass = 0; pass < 2; pass += 1) {
        const actual = this.overlay.getBoundingClientRect();
        const localWidth = cssPixels(this.overlay.style.width);
        const localHeight = cssPixels(this.overlay.style.height);
        if (actual.width <= 0 || actual.height <= 0 || localWidth <= 0 || localHeight <= 0) {
          break;
        }
        const scaleX = actual.width / localWidth;
        const scaleY = actual.height / localHeight;
        this.overlay.style.left = `${
          cssPixels(this.overlay.style.left) + (target.left - actual.left) / scaleX
        }px`;
        this.overlay.style.top = `${
          cssPixels(this.overlay.style.top) + (target.top - actual.top) / scaleY
        }px`;
        this.overlay.style.width = `${(localWidth * target.width) / actual.width}px`;
        this.overlay.style.height = `${(localHeight * target.height) / actual.height}px`;
      }
    }
    const overlayRect = this.overlay.getBoundingClientRect();
    if (isMeasurableRect(overlayRect)) return freezeCssRect(overlayRect);
    return Object.freeze({ ...target });
  }

  private measureLayoutPresentation(): InkLayoutPresentation {
    const layoutRect = this.layoutRoot.getBoundingClientRect();
    const unscaledBorderBoxWidth =
      this.layoutRoot.offsetWidth > 0 ? this.layoutRoot.offsetWidth : INK_DOCUMENT_LOGICAL_WIDTH;
    const measured = layoutRect.width / unscaledBorderBoxWidth;
    const presented = this.presentedWorkspaceScale();
    const containingScale = this.measureContainingScale();
    const expected = presented * containingScale;
    const ignoresCssZoom =
      Math.abs(presented - 1) > 0.000_001 &&
      approximatelyEqual(measured, containingScale) &&
      !approximatelyEqual(measured, expected);
    if (ignoresCssZoom) {
      return Object.freeze({
        rect: Object.freeze({
          height: layoutRect.height * presented,
          left: layoutRect.left * presented,
          top: layoutRect.top * presented,
          width: layoutRect.width * presented,
        }),
        scale: expected,
      });
    }
    return Object.freeze({
      rect: freezeCssRect(layoutRect),
      scale: Number.isFinite(measured) && measured > 0 ? measured : expected,
    });
  }

  private measureContainingScale(): number {
    const rootRect = this.root.getBoundingClientRect();
    const unscaledWidth = this.root.offsetWidth || this.root.clientWidth;
    const measured = unscaledWidth > 0 ? rootRect.width / unscaledWidth : 1;
    return Number.isFinite(measured) && measured > 0 ? measured : 1;
  }

  private presentedWorkspaceScale(): number {
    if (this.viewMode === 'raw' || !this.layoutRoot.classList.contains('inkstone-ink-workspace')) {
      return 1;
    }
    const presented = Number(this.layoutRoot.style.getPropertyValue('--inkstone-ink-scale'));
    return Number.isFinite(presented) && presented > 0
      ? presented
      : this.toolbarStore.state.value.zoomScale;
  }

  private publishStageFrame(next: InkStageFrame): void {
    if (this.contactStageFrameFrozen) {
      this.deferredStageFrame = sameInkStageFrame(this.stageFrame, next) ? null : next;
      return;
    }
    this.publishStageFrameNow(next);
  }

  private publishStageFrameNow(next: InkStageFrame): void {
    const previous = this.stageFrame;
    const changed = !sameInkStageFrame(previous, next);
    this.stageFrameChanged ||= changed;
    if (changed) this.stageFrameEpoch += 1;
    this.stageFrame = next;
  }

  private releaseContactStageFrame(): void {
    this.contactStageFrameFrozen = false;
    const deferred = this.deferredStageFrame;
    this.deferredStageFrame = null;
    if (deferred === null) return;
    this.publishStageFrameNow(deferred);
    this.updateViewport(true);
  }

  private setToolOptionsVisible(visible: boolean): void {
    this.updateToolbar({ optionsVisible: visible });
  }

  private resolveEraserPreviewColor(): string {
    return getComputedStyle(this.root).getPropertyValue('--text-error').trim() || '#dc2626';
  }

  private readonly onToolbarColor = (color: string): void => {
    this.noteToolbarInteraction();
    this.toolStyles[this.tool] = { ...this.toolStyles[this.tool], color };
    this.updateToolbar({ color });
    this.persistPreference();
  };

  private readonly onToolbarDone = (): void => {
    void this.onExitRequested().catch(() => undefined);
  };

  private readonly onToolbarRedo = (): void => {
    this.noteToolbarInteraction();
    if (this.session.redo()) this.sync(this.session.read());
  };

  private readonly onToolbarExportUnsaved = (): void => {
    this.noteToolbarInteraction();
    void this.onExportUnsavedRequested().catch(() => this.sync(this.session.read()));
  };

  private readonly onToolbarDeleteSelection = (): void => {
    this.noteToolbarInteraction();
    const deletedStrokeIds = this.session.deleteSelectedStrokes?.() ?? [];
    if (deletedStrokeIds.length > 0) this.sync(this.session.read());
  };

  private readonly onToolbarRetry = (): void => {
    this.noteToolbarInteraction();
    const physicalState = this.physicalCandidate?.read();
    if (physicalState?.kind === 'failed') {
      this.enterPhysicalCandidate();
      return;
    }
    void this.onRetryRequested().catch(() => this.sync(this.session.read()));
  };

  private readonly onToolbarToggleOptions = (): void => {
    this.noteToolbarInteraction();
    const visible = !this.toolbarStore.state.value.optionsVisible;
    this.setToolOptionsVisible(visible);
    this.persistPreference();
    queueMicrotask(() => this.clampDraggedControls());
  };

  private readonly onToolbarTool = (tool: InkStroke['tool']): void => {
    this.noteToolbarInteraction();
    if (this.activePointerId !== null) this.finishStroke(false);
    const style = this.toolStyles[tool];
    const previousToolbar = this.toolbarStore.state.value;
    this.updateToolbar(
      {
        color: style.color,
        interaction: 'draw',
        selectedCount: 0,
        tool,
        width: style.width,
      },
      previousToolbar.optionsVisible ||
        previousToolbar.interaction !== 'draw' ||
        previousToolbar.selectedCount !== 0,
    );
    this.hoveredStrokeId = null;
    this.inputTarget.style.cursor = '';
    this.session.clearSelection?.();
    this.renderRuntime.cancelActive();
    this.renderRuntime.setOverlay({ hovered: [], selected: [] });
    this.persistPreference();
  };

  private readonly onToolbarSelectMove = (): void => {
    this.noteToolbarInteraction();
    if (this.activePointerId !== null) this.finishStroke(false);
    this.updateToolbar({ interaction: 'select', optionsVisible: false });
    this.inputTarget.style.cursor = '';
    this.persistPreference();
  };

  private readonly onToolbarToggleMultiple = (): void => {
    this.noteToolbarInteraction();
    this.updateToolbar({ multiple: !this.toolbarStore.state.value.multiple });
    this.persistPreference();
  };

  private readonly onToolbarUndo = (): void => {
    this.noteToolbarInteraction();
    if (this.session.undo()) this.sync(this.session.read());
  };

  private readonly onToolbarWidth = (width: number): void => {
    this.noteToolbarInteraction();
    this.toolStyles[this.tool] = { ...this.toolStyles[this.tool], width };
    this.updateToolbar({ width });
    this.persistPreference();
  };

  private readonly onToolbarZoomFit = (): void => {
    this.noteToolbarInteraction();
    this.updateToolbar({ zoomMode: 'fit' });
    this.refreshWorkspacePresentation();
    this.persistPreference();
  };

  private readonly onToolbarZoomIn = (): void => {
    this.noteToolbarInteraction();
    this.updateToolbar({
      zoomMode: 'manual',
      zoomScale: stepInkWorkspaceScale(this.toolbarStore.state.value.zoomScale, 1),
    });
    this.refreshWorkspacePresentation();
    this.persistPreference();
  };

  private readonly onToolbarZoomOut = (): void => {
    this.noteToolbarInteraction();
    this.updateToolbar({
      zoomMode: 'manual',
      zoomScale: stepInkWorkspaceScale(this.toolbarStore.state.value.zoomScale, -1),
    });
    this.refreshWorkspacePresentation();
    this.persistPreference();
  };

  private noteToolbarInteraction(): void {
    if (this.active) this.session.noteUserInteraction?.();
  }

  private refreshWorkspacePresentation(): void {
    const logicalViewportTop = this.viewMode === 'raw' ? null : this.viewportTop;
    this.applyWorkspaceScale();
    this.positionOverlay();
    if (logicalViewportTop !== null) this.restoreLogicalViewportTop(logicalViewportTop);
    // Zoom controls are a continuous viewport gesture. Keep presenting the retained bitmap through
    // the compositor and share the same trailing settle as native scrolling; rebuilding here would
    // put a full history query and raster preparation on every zoom tick.
    this.renderRuntime.projectFrame(this.stageFrame);
    this.scheduleViewportSettle();
    this.updateRenderOverlay();
  }

  private applyWorkspaceScale(): void {
    if (this.viewMode === 'raw') return;
    const state = this.toolbarStore.state.value;
    const preview = this.viewMode === 'preview';
    const fit = !preview && state.zoomMode === 'fit';
    if (this.root.classList.contains('is-ink-fit') !== fit) {
      this.root.classList.toggle('is-ink-fit', fit);
    }
    const logicalWidth = INK_DOCUMENT_LOGICAL_WIDTH;
    const availableWidth =
      this.scrollContainer === null
        ? logicalWidth + INK_FIT_GUTTER * 2
        : this.fitPaneWidth(logicalWidth + INK_FIT_GUTTER * 2);
    const zoomScale = preview
      ? 1
      : fit
        ? fitInkWorkspaceScale(availableWidth, logicalWidth)
        : state.zoomScale;
    const presentedScale = Number(this.layoutRoot.style.getPropertyValue('--inkstone-ink-scale'));
    if (!Number.isFinite(presentedScale) || Math.abs(presentedScale - zoomScale) > 0.000_001) {
      this.layoutRoot.style.setProperty('--inkstone-ink-scale', String(zoomScale));
    }
    if (!preview && zoomScale !== state.zoomScale) this.updateToolbar({ zoomScale });
  }

  private paneWidth(fallback: number): number {
    if (this.scrollContainer === null) return fallback;
    return (
      this.scrollContainer.clientWidth ||
      this.scrollContainer.getBoundingClientRect().width ||
      fallback
    );
  }

  private fitPaneWidth(fallback: number): number {
    const paneWidth = this.paneWidth(fallback);
    if (this.scrollContainer === null) return paneWidth;
    const style = getComputedStyle(this.scrollContainer);
    const paddingStart = Math.max(
      cssPixels(style.paddingLeft),
      cssPixels(style.paddingInlineStart),
    );
    const paddingEnd = Math.max(cssPixels(style.paddingRight), cssPixels(style.paddingInlineEnd));
    return Math.max(
      1,
      paneWidth -
        Math.max(0, paddingStart - INK_FIT_GUTTER) -
        Math.max(0, paddingEnd - INK_FIT_GUTTER),
    );
  }

  private paneHeight(fallback: number): number {
    if (this.scrollContainer === null) return fallback;
    const paneRect = this.scrollContainer.getBoundingClientRect();
    let measured = Math.max(this.scrollContainer.clientHeight, paneRect.height);
    const viewportRect = this.viewportHost?.getBoundingClientRect();
    if (viewportRect !== undefined && viewportRect.height > 0) {
      const visibleTop = Math.max(paneRect.top, viewportRect.top);
      const visibleBottom = viewportRect.bottom;
      measured = Math.max(measured, visibleBottom - visibleTop);
    }
    return measured > 0 ? measured : fallback;
  }

  private toolbarProps(): InkToolbarAppProps {
    return {
      onColor: this.onToolbarColor,
      onDeleteSelection: this.onToolbarDeleteSelection,
      onDone: this.onToolbarDone,
      onDragKeyDown: this.onControlsDragKeyDown,
      onDragStart: this.onControlsDragStart,
      onExportUnsaved: this.onToolbarExportUnsaved,
      onRedo: this.onToolbarRedo,
      onRetry: this.onToolbarRetry,
      onSelectMove: this.onToolbarSelectMove,
      onToggleMultiple: this.onToolbarToggleMultiple,
      onToggleOptions: this.onToolbarToggleOptions,
      onTool: this.onToolbarTool,
      onUndo: this.onToolbarUndo,
      onWidth: this.onToolbarWidth,
      onZoomFit: this.onToolbarZoomFit,
      onZoomIn: this.onToolbarZoomIn,
      onZoomOut: this.onToolbarZoomOut,
      state: this.toolbarStore.state,
    };
  }

  private updateToolbar(update: Partial<InkToolbarState>, render = true): void {
    this.toolbarStore.state.value = { ...this.toolbarStore.state.value, ...update };
    if (render) this.toolbarIsland.update(this.toolbarProps());
  }

  private moveControls(left: number, top: number, markDragged = true): void {
    const bounds = this.controls.getBoundingClientRect();
    const viewport = viewportBounds(this.document);
    const width = bounds.width || this.controls.offsetWidth;
    const height = bounds.height || this.controls.offsetHeight;
    const safeLeft = viewport.left + 12;
    const safeTop = viewport.top + 12;
    const maxLeft = Math.max(safeLeft, viewport.left + viewport.width - width - 12);
    const maxTop = Math.max(safeTop, viewport.top + viewport.height - height - 12);
    this.updateToolbar({
      position: {
        dragged: markDragged || this.toolbarStore.state.value.position?.dragged === true,
        left: Math.round(clamp(left, safeLeft, maxLeft)),
        top: Math.round(clamp(top, safeTop, maxTop)),
      },
    });
  }

  private positionControlsDefault(): void {
    if (this.toolbarStore.state.value.position?.dragged === true) {
      this.clampDraggedControls();
      return;
    }
    if (this.document.documentElement.clientWidth <= 600) return;
    const hostBounds = this.root.getBoundingClientRect();
    const controlsBounds = this.controls.getBoundingClientRect();
    if (hostBounds.width <= 0 || hostBounds.height <= 0 || controlsBounds.width <= 0) return;
    const compactHost = hostBounds.width < controlsBounds.width + 160;
    this.moveControls(
      Math.max(hostBounds.left + 8, hostBounds.right - controlsBounds.width - 12),
      compactHost ? hostBounds.bottom - controlsBounds.height - 16 : hostBounds.top + 8,
      false,
    );
  }

  private clampDraggedControls(): void {
    if (this.disposed) return;
    const position = this.toolbarStore.state.value.position;
    if (position?.dragged !== true) return;
    this.moveControls(position.left, position.top);
  }

  private stopControlsDrag(): void {
    const pointerId = this.controlsDragState?.pointerId;
    if (pointerId !== undefined && this.dragHandle.hasPointerCapture?.(pointerId)) {
      this.dragHandle.releasePointerCapture(pointerId);
    }
    this.controlsDragState = null;
    if (!this.disposed) this.updateToolbar({ dragging: false });
    this.document.removeEventListener('pointermove', this.onControlsDragMove);
    this.document.removeEventListener('pointerup', this.onControlsDragEnd);
    this.document.removeEventListener('pointercancel', this.onControlsDragEnd);
  }

  private persistPreference(): void {
    const state = this.toolbarStore.state.value;
    this.onPreferenceChanged({
      color: state.color,
      hintShown: this.hintShown,
      interaction: state.interaction,
      multiple: state.multiple,
      optionsVisible: state.optionsVisible,
      tool: state.tool,
      ...(state.position?.dragged === true
        ? { toolbarPosition: { left: state.position.left, top: state.position.top } }
        : {}),
      toolStyles: {
        eraser: { ...this.toolStyles.eraser },
        highlighter: { ...this.toolStyles.highlighter },
        pen: { ...this.toolStyles.pen },
      },
      width: state.width,
      zoomMode: state.zoomMode,
      zoomScale: state.zoomScale,
    });
  }

  private deactivate(target: 'raw' | 'preview' = 'raw'): void {
    this.finishSelectionMove(false);
    this.session.clearSelection?.();
    this.document.removeEventListener('keydown', this.onDocumentKeyDown);
    this.active = false;
    this.toolbarHost.dataset.inkstoneControllerActive = 'false';
    this.viewMode = target;
    this.overlay.hidden = target === 'raw';
    this.hoveredStrokeId = null;
    this.renderRuntime.cancelActive();
    this.renderRuntime.setOverlay({ hovered: [], selected: [] });
    this.inputTarget.style.cursor = '';
    this.updateToolbar({ active: false });
    this.root.classList.remove('is-ink-mode', 'is-ink-preview');
    if (target === 'preview') {
      this.root.classList.add('is-ink-preview');
      this.activateWorkspace();
      this.positionOverlay();
    } else {
      this.preserveReadingContext(() => this.deactivateWorkspace());
    }
  }

  private preserveReadingContext(changeLayout: () => void): void {
    this.cancelReadingContextRestore();
    const scroll = this.scrollContainer;
    if (scroll === null) {
      changeLayout();
      return;
    }
    const maximumBefore = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const ratio = maximumBefore === 0 ? 0 : scroll.scrollTop / maximumBefore;
    changeLayout();
    const restore = (): void => {
      if (this.disposed || this.scrollContainer !== scroll) return;
      const maximumAfter = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      scroll.scrollTop = ratio * maximumAfter;
    };
    // Reading layout is synchronously measurable after the class/style mutation. Restore once
    // before the manager may dispose this controller, then refine after Obsidian finishes reflow.
    restore();
    let completedSynchronously = false;
    const frame = requestAnimationFrame(() => {
      completedSynchronously = true;
      this.readingContextRestoreFrame = null;
      restore();
    });
    if (!completedSynchronously) this.readingContextRestoreFrame = frame;
  }

  private cancelReadingContextRestore(): void {
    if (this.readingContextRestoreFrame === null) return;
    cancelAnimationFrame(this.readingContextRestoreFrame);
    this.readingContextRestoreFrame = null;
  }

  private activateWorkspace(): void {
    const logicalHeight = this.currentRead.logicalHeight;
    this.layoutRoot.classList.add('inkstone-ink-workspace');
    this.layoutRoot.style.setProperty(
      '--inkstone-ink-logical-width',
      `${INK_DOCUMENT_LOGICAL_WIDTH}px`,
    );
    this.layoutRoot.style.setProperty('--inkstone-ink-logical-height', `${logicalHeight}px`);
    this.applyWorkspaceScale();
  }

  private deactivateWorkspace(): void {
    this.root.classList.remove('is-ink-fit');
    this.layoutRoot.classList.remove('inkstone-ink-workspace');
    this.layoutRoot.style.removeProperty('--inkstone-ink-logical-width');
    this.layoutRoot.style.removeProperty('--inkstone-ink-logical-height');
    this.layoutRoot.style.removeProperty('--inkstone-ink-scale');
  }
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function approximatelyEqual(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= Math.max(0.005, Math.abs(right) * 0.01);
}

function isMeasurableRect(rect: DOMRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function freezeCssRect(rect: DOMRect): CssRect {
  return Object.freeze({ height: rect.height, left: rect.left, top: rect.top, width: rect.width });
}

function isDrawingPointer(pointerType: string): boolean {
  return pointerType === 'pen' || pointerType === 'mouse' || pointerType === '';
}

function initialToolStyles(preference: InkToolPreference): InkToolStyles {
  const styles = resolveInkToolStyles(preference);
  return {
    eraser: { ...styles.eraser },
    highlighter: { ...styles.highlighter },
    pen: { ...styles.pen },
  };
}

function isClosedLoopEraseGesture(
  points: readonly CssPoint[],
  logicalUnitsPerCssPixel = 1,
): boolean {
  if (points.length < 3 || points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) {
    return false;
  }
  let length = 0;
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const previous = points[index - 1];
    if (point === undefined) continue;
    minimumX = Math.min(minimumX, point.x);
    minimumY = Math.min(minimumY, point.y);
    maximumX = Math.max(maximumX, point.x);
    maximumY = Math.max(maximumY, point.y);
    if (previous !== undefined) length += Math.hypot(point.x - previous.x, point.y - previous.y);
  }
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) return false;
  const width = maximumX - minimumX;
  const height = maximumY - minimumY;
  const diagonal = Math.hypot(width, height);
  const closingGap = Math.hypot(last.x - first.x, last.y - first.y);
  const adaptiveClosingGap = Math.min(
    120 * logicalUnitsPerCssPixel,
    Math.max(32 * logicalUnitsPerCssPixel, diagonal * 0.6),
  );
  let effectiveArea = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    if (point === undefined || next === undefined) continue;
    effectiveArea +=
      Math.abs(
        (point.x - first.x) * (next.y - first.y) - (point.y - first.y) * (next.x - first.x),
      ) / 2;
  }
  return (
    length >= 48 * logicalUnitsPerCssPixel &&
    width >= 16 * logicalUnitsPerCssPixel &&
    height >= 16 * logicalUnitsPerCssPixel &&
    closingGap <= adaptiveClosingGap &&
    closingGap / length <= 0.3 &&
    effectiveArea >= Math.max(64 * logicalUnitsPerCssPixel ** 2, width * height * 0.12)
  );
}

function findStylusTouch(touches: TouchList): Touch | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (touch?.touchType === 'stylus') return touch;
  }
  return null;
}

function stylusPointerId(identifier: number): number {
  return -(identifier + 1);
}

function touchInputSample(event: TouchEvent, touch: Touch): InkClientInputSample {
  return {
    clientX: touch.clientX,
    clientY: touch.clientY,
    pressure: 0.5,
    timeStamp: event.timeStamp,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
