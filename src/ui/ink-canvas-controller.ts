import type { InkSurfaceSessionSnapshot } from '../application/ink-surface-session';
import type { InkPoint, InkStroke } from '../domain/ink-surface';
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
  type CssPoint,
  type CssRect,
  type InkStageFrame,
} from './ink-stage-frame';
import { createPreactIsland, type UiIsland } from './runtime/mount-preact-island';
import { viewportBounds } from './runtime/anchored-layer-position';
import {
  createInkToolbarStore,
  type InkToolbarState,
  type InkToolbarStore,
} from './stores/ink-toolbar-store';

interface InkSessionLike {
  addStroke(stroke: InkStroke): void;
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
  redo(): boolean;
  previewSelectionMove?(dx: number, dy: number): { readonly dx: number; readonly dy: number };
  retry(): Promise<void>;
  selectStrokeAt?(point: InkPoint, tolerance: number, additive?: boolean): readonly string[];
  selectedStrokeIds?(): readonly string[];
  snapshot(): InkSurfaceSessionSnapshot;
  strokeIdAt?(point: InkPoint, tolerance: number): string | null;
  undo(): boolean;
}

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

interface InkDirtyRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
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

type InkToolStyles = Record<InkStroke['tool'], InkToolStyle>;

/** A single fixed logical surface. Rendering stays pointer-transparent in every view mode. */
export class InkCanvasController {
  private active = false;
  private readonly activeCanvas: HTMLCanvasElement;
  private readonly activeContext: CanvasRenderingContext2D;
  private activePointerId: number | null = null;
  private activeStylusTouchId: number | null = null;
  private activeClientPoints: CssPoint[] = [];
  private activePoints: InkPoint[] = [];
  private activePaintedPointCount = 0;
  private readonly committedCanvas: HTMLCanvasElement;
  private readonly committedContext: CanvasRenderingContext2D;
  private readonly controls: HTMLElement;
  private controlsDragState: InkControlsDragState | null = null;
  private disposed = false;
  private readonly document: Document;
  private documentOriginInset: CssPoint | null;
  private readonly dragHandle: HTMLButtonElement;
  private readonly extentProbeTimeouts = new Set<number>();
  private eraserPreviewColor = '#dc2626';
  private frame: number | null = null;
  private hintShown: boolean;
  private hoveredStrokeId: string | null = null;
  private inputTarget: HTMLElement;
  private layoutRoot: HTMLElement;
  private readonly onExitRequested: () => Promise<void>;
  private readonly onLayoutExtentChanged: (minimumHeight: number) => void;
  private readonly onPreferenceChanged: (preference: InkToolPreference) => void;
  private readonly onRetryRequested: () => Promise<void>;
  private readonly now: () => number;
  private readonly overlay: HTMLElement;
  private pendingInputStartedAt: number | null = null;
  private pendingExitTarget: 'raw' | 'preview' = 'raw';
  private readingContextRestoreFrame: number | null = null;
  private previousPosition: string;
  private readonly recordInputToPaint: (durationMs: number) => void;
  private reportedLayoutExtent = 0;
  private renderedStrokes: readonly InkStroke[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private root: HTMLElement;
  private scrollContainer: HTMLElement | null;
  private readonly session: InkSessionLike;
  private stageFrame: InkStageFrame;
  private stageFrameChanged = true;
  private selectionDragState: InkSelectionDragState | null = null;
  private selectionCommittedStrokes: readonly InkStroke[] | null = null;
  private selectionChromeBounds: InkDirtyRect | null = null;
  private selectionFrame: number | null = null;
  private pendingSelectionDelta: { readonly dx: number; readonly dy: number } | null = null;
  private readonly toolbarHost: HTMLElement;
  private readonly toolbarIsland: UiIsland<InkToolbarAppProps> = createPreactIsland(InkToolbarApp);
  private readonly toolbarStore: InkToolbarStore;
  private readonly toolStyles: InkToolStyles;
  private viewMode: 'raw' | 'preview' | 'edit' = 'raw';
  private readonly viewportHost: HTMLElement | null;

  private get viewportHeight(): number {
    return this.stageFrame.logicalViewport.height;
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
    readonly layoutRoot?: HTMLElement;
    readonly now?: () => number;
    readonly onExitRequested?: () => Promise<void>;
    readonly onLayoutExtentChanged?: (minimumHeight: number) => void;
    readonly onPreferenceChanged?: (preference: InkToolPreference) => void;
    readonly onRetryRequested?: () => Promise<void>;
    readonly preference?: InkToolPreference;
    readonly recordInputToPaint?: (durationMs: number) => void;
    readonly root: HTMLElement;
    readonly scrollContainer?: HTMLElement;
    readonly session: InkSessionLike;
    readonly viewportHost?: HTMLElement;
  }) {
    this.document = input.document;
    this.root = input.root;
    this.layoutRoot = input.layoutRoot ?? input.root;
    this.scrollContainer = input.scrollContainer ?? null;
    this.viewportHost = input.viewportHost ?? null;
    this.inputTarget = this.scrollContainer ?? this.root;
    this.session = input.session;
    this.now = input.now ?? (() => performance.now());
    this.onExitRequested = input.onExitRequested ?? (() => this.exit());
    this.onLayoutExtentChanged = input.onLayoutExtentChanged ?? (() => undefined);
    this.recordInputToPaint = input.recordInputToPaint ?? (() => undefined);
    const preference = input.preference ?? LocalInkToolPreferenceStore.DEFAULT;
    this.hintShown = preference.hintShown;
    this.toolStyles = initialToolStyles(preference);
    this.toolbarStore = createInkToolbarStore({
      ...preference,
      ...this.toolStyles[preference.tool],
    });
    this.onPreferenceChanged = input.onPreferenceChanged ?? (() => undefined);
    this.onRetryRequested = input.onRetryRequested ?? (() => this.retrySave());
    this.previousPosition = input.root.style.position;
    if (getComputedStyle(input.root).position === 'static') {
      input.root.style.position = 'relative';
    }
    input.root.classList.add('inkstone-ink-host');

    const snapshot = input.session.snapshot();
    this.stageFrame = createInkStageFrame({
      actualScale: 1,
      canvasClientRect: {
        height: this.paneHeight(snapshot.surface.layout.logicalHeight),
        left: 0,
        top: 0,
        width: this.paneWidth(INK_DOCUMENT_LOGICAL_WIDTH),
      },
      documentClientOrigin: { x: 0, y: 0 },
    });
    this.overlay = input.document.createElement('div');
    this.overlay.className = 'inkstone-ink-surface';
    this.overlay.dataset.inkstoneInkSurface = snapshot.surface.id;
    this.overlay.hidden = true;
    this.overlay.style.width = `${INK_DOCUMENT_LOGICAL_WIDTH}px`;
    this.overlay.style.height = `${snapshot.surface.layout.logicalHeight}px`;

    this.committedCanvas = this.createCanvas('committed');
    this.committedCanvas.dataset.inkstoneInkCommitted = 'true';
    this.committedCanvas.style.pointerEvents = 'none';
    this.activeCanvas = this.createCanvas('active');
    this.activeCanvas.dataset.inkstoneInkActive = 'true';
    this.activeCanvas.style.pointerEvents = 'none';
    this.committedContext = requireContext(this.committedCanvas);
    this.activeContext = requireContext(this.activeCanvas);

    this.toolbarHost = input.document.createElement('div');
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
    this.overlay.append(this.committedCanvas, this.activeCanvas);
    input.root.append(this.overlay);
    this.documentOriginInset = this.captureDocumentOriginInset();
    this.positionOverlay();

    this.attachHostListeners();
    this.document.defaultView?.addEventListener('resize', this.onRootResized);
    this.document.defaultView?.visualViewport?.addEventListener('resize', this.onRootResized);
    this.document.defaultView?.visualViewport?.addEventListener('scroll', this.onRootResized);
    this.sync(snapshot);
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
    this.viewMode = 'edit';
    this.overlay.hidden = false;
    this.root.classList.remove('is-ink-preview');
    this.root.classList.add('is-ink-mode');
    this.preserveReadingContext(() => {
      this.activateWorkspace();
      this.positionOverlay();
    });
    this.activeCanvas.style.pointerEvents = 'none';
    this.document.addEventListener('keydown', this.onDocumentKeyDown);
    this.updateToolbar({ active: true });
    this.positionControlsDefault();
    this.sync(this.session.snapshot());
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
    this.activeCanvas.style.pointerEvents = 'none';
    this.updateToolbar({ active: false });
    this.preserveReadingContext(() => {
      this.activateWorkspace();
      this.positionOverlay();
    });
    this.sync(this.session.snapshot());
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
    this.pendingExitTarget = target;
    try {
      await this.session.exit();
      this.sync(this.session.snapshot());
      this.deactivate(target);
      this.pendingExitTarget = 'raw';
    } catch (error) {
      this.sync(this.session.snapshot());
      this.enter();
      throw error;
    }
  }

  background(): Promise<void> {
    this.finishStroke(false);
    return this.session.background().finally(() => this.sync(this.session.snapshot()));
  }

  async retrySave(): Promise<void> {
    try {
      await this.session.retry();
    } finally {
      this.sync(this.session.snapshot());
    }
  }

  coversHeight(minimumHeight: number): boolean {
    return this.session.snapshot().surface.layout.logicalHeight >= Math.ceil(minimumHeight);
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

  sync(snapshot: InkSurfaceSessionSnapshot): void {
    if (this.disposed) {
      return;
    }
    const logicalHeight = snapshot.surface.layout.logicalHeight;
    if (this.scrollContainer === null) this.overlay.style.height = `${logicalHeight}px`;
    if (this.viewMode !== 'raw') {
      this.layoutRoot.style.setProperty('--inkstone-ink-logical-height', `${logicalHeight}px`);
    }
    if (this.viewMode !== 'raw') this.positionOverlay();
    this.updateViewport(false);
    this.renderCommitted(this.selectionCommittedStrokes ?? snapshot.surface.strokes);
    this.renderSelectionChrome(snapshot.surface.strokes);
    const error = snapshot.persistence.kind === 'error';
    this.updateToolbar({
      canRedo: this.session.canRedo(),
      canUndo: this.session.canUndo(),
      saveError: error ? snapshot.persistence.message : null,
      selectedCount: this.session.selectedStrokeIds?.().length ?? 0,
      statusText: error
        ? `Ink Mode · ${snapshot.persistence.message}`
        : snapshot.persistence.kind === 'saving'
          ? 'Ink Mode · Saving locally…'
          : snapshot.persistence.kind === 'saved-locally'
            ? 'Ink Mode · Saved locally'
            : 'Ink Mode',
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelFrame();
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
    this.overlay.remove();
    this.toolbarIsland.unmount();
    this.toolbarHost.remove();
    this.root.classList.remove('inkstone-ink-host', 'is-ink-mode', 'is-ink-preview', 'is-ink-fit');
    this.deactivateWorkspace();
    this.root.style.position = this.previousPosition;
  }

  private attachHostListeners(): void {
    this.inputTarget.addEventListener('click', this.onReadingViewActivation, true);
    this.inputTarget.addEventListener('dblclick', this.onReadingViewActivation, true);
    this.inputTarget.addEventListener('selectstart', this.onReadingViewSelection, true);
    this.inputTarget.addEventListener('pointerdown', this.onPointerDown, true);
    this.inputTarget.addEventListener('pointermove', this.onPointerMove, true);
    this.inputTarget.addEventListener('pointerleave', this.onPointerLeave, true);
    this.inputTarget.addEventListener('pointerup', this.onPointerEnd, true);
    this.inputTarget.addEventListener('pointercancel', this.onPointerCancel, true);
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
        this.toolbarStore.state.value.multiple || event.shiftKey || event.metaKey || event.ctrlKey;
      this.beginSelection(event, event.pointerId, additive, true);
      return;
    }
    this.activePointerId = event.pointerId;
    if (this.tool === 'eraser') this.eraserPreviewColor = this.resolveEraserPreviewColor();
    this.activeClientPoints = [];
    this.activePoints = [];
    this.activePaintedPointCount = 0;
    this.clearCanvas(this.activeCanvas, this.activeContext);
    this.selectionChromeBounds = null;
    this.inputTarget.setPointerCapture?.(event.pointerId);
    this.appendEventPoints(event);
    this.scheduleActivePaint();
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
        point === null ? null : (this.session.strokeIdAt?.(point, Math.max(8, this.width)) ?? null);
      this.setHoveredStroke(hovered);
      return;
    }
    if (event.pointerId !== this.activePointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.appendEventPoints(event);
    this.scheduleActivePaint();
  };

  private readonly onPointerLeave = (): void => {
    if (this.selectionDragState === null) this.setHoveredStroke(null);
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (this.preserveNativeTouchNavigation(event)) return;
    if (event.pointerId === this.selectionDragState?.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      if (this.selectionDragState.dragged === false) this.updateSelectionDrag(event);
      this.finishSelectionMove(true);
      return;
    }
    if (event.pointerId !== this.activePointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.appendEventPoints(event);
    this.finishStroke(true);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.preserveNativeTouchNavigation(event)) return;
    if (event.pointerId === this.selectionDragState?.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.finishSelectionMove(false);
      return;
    }
    if (event.pointerId !== this.activePointerId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.finishStroke(false);
  };

  private readonly onTouchStart = (event: TouchEvent): void => {
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
    if (this.activePointerId !== null || this.selectionDragState !== null) return;
    this.activeStylusTouchId = stylus.identifier;
    const pointerId = stylusPointerId(stylus.identifier);
    const sample = touchInputSample(event, stylus);
    if (this.toolbarStore.state.value.interaction === 'select') {
      const additive =
        this.toolbarStore.state.value.multiple || event.shiftKey || event.metaKey || event.ctrlKey;
      if (!this.beginSelection(sample, pointerId, additive, false)) {
        this.activeStylusTouchId = null;
      }
      return;
    }
    this.activePointerId = pointerId;
    if (this.tool === 'eraser') this.eraserPreviewColor = this.resolveEraserPreviewColor();
    this.activeClientPoints = [];
    this.activePoints = [];
    this.activePaintedPointCount = 0;
    this.clearCanvas(this.activeCanvas, this.activeContext);
    this.selectionChromeBounds = null;
    this.appendInputPoint(sample);
    this.scheduleActivePaint();
  };

  private readonly onTouchMove = (event: TouchEvent): void => {
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
    this.appendInputPoint(sample);
    this.scheduleActivePaint();
  };

  private readonly onTouchEnd = (event: TouchEvent): void => {
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
    this.appendInputPoint(sample);
    this.activeStylusTouchId = null;
    this.finishStroke(true);
  };

  private readonly onTouchCancel = (event: TouchEvent): void => {
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
    this.finishStroke(false);
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
      this.sync(this.session.snapshot());
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

  private appendEventPoints(event: PointerEvent): void {
    // Pointer Events exposes coalesced samples for moves, but down/up normally return an empty
    // list. Preserve the parent event so WebKit does not lose the Pencil contact endpoints.
    const coalesced = event.getCoalescedEvents?.() ?? [];
    const samples = coalesced.length === 0 ? [event] : coalesced;
    for (const sample of samples) {
      this.appendInputPoint(sample, sample.tiltX, sample.tiltY);
    }
  }

  private appendInputPoint(sample: InkClientInputSample, tiltX = 0, tiltY = 0): void {
    const layout = this.session.snapshot().surface.layout;
    const previous = this.activePoints.at(-1);
    const time = Math.max(sample.timeStamp, previous?.time ?? Number.NEGATIVE_INFINITY);
    const point = this.stageFrame.clientToLogical({ x: sample.clientX, y: sample.clientY });
    this.activeClientPoints.push({ x: sample.clientX, y: sample.clientY });
    this.activePoints.push({
      pressure: sample.pressure > 0 ? sample.pressure : 0.5,
      time,
      x: point.x,
      y: clamp(point.y, 0, layout.logicalHeight),
      ...(tiltX === 0 ? {} : { tiltX }),
      ...(tiltY === 0 ? {} : { tiltY }),
    });
  }

  private eventPoint(event: InkClientInputSample): InkPoint | null {
    const layout = this.session.snapshot().surface.layout;
    const point = this.stageFrame.clientToLogical({ x: event.clientX, y: event.clientY });
    return {
      pressure: event.pressure > 0 ? event.pressure : 0.5,
      time: event.timeStamp,
      x: point.x,
      y: clamp(point.y, 0, layout.logicalHeight),
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
    this.hoveredStrokeId = hitStrokeId;
    this.inputTarget.style.cursor = this.selectionDragState === null ? '' : 'grabbing';
    if (capturePointer && this.selectionDragState !== null) {
      this.inputTarget.setPointerCapture?.(pointerId);
    }
    this.sync(this.session.snapshot());
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
    this.inputTarget.style.cursor = this.hoveredStrokeId === null ? '' : 'grab';
    this.sync(this.session.snapshot());
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
    this.sync(this.session.snapshot());
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
    this.selectionCommittedStrokes = this.renderedStrokes.filter(
      (stroke) => !selected.has(stroke.id),
    );
    this.renderCommitted(this.selectionCommittedStrokes, true);
  }

  private finishStroke(commit: boolean): void {
    this.cancelFrame();
    const pointerId = this.activePointerId;
    this.activePointerId = null;
    this.activeStylusTouchId = null;
    if (pointerId !== null && this.inputTarget.hasPointerCapture?.(pointerId)) {
      this.inputTarget.releasePointerCapture(pointerId);
    }
    this.clearCanvas(this.activeCanvas, this.activeContext);
    this.selectionChromeBounds = null;
    const closedLoopErase =
      this.tool === 'eraser' && isClosedLoopEraseGesture(this.activeClientPoints);
    const points = simplifyPoints(this.activePoints, 0.8);
    this.activeClientPoints = [];
    this.activePoints = [];
    this.activePaintedPointCount = 0;
    if (!commit || points.length === 0) {
      return;
    }
    if (this.tool === 'eraser') {
      if (closedLoopErase) {
        this.session.eraseStrokesInPolygon(points);
        this.sync(this.session.snapshot());
        return;
      }
      const target = points.at(-1);
      if (target !== undefined) this.session.eraseStrokeAt(target, Math.max(8, this.width));
      this.sync(this.session.snapshot());
      return;
    }
    this.session.addStroke({
      color: this.tool === 'highlighter' ? `${this.color}88` : this.color,
      id: globalThis.crypto.randomUUID(),
      points,
      tool: this.tool,
      width: this.width,
    });
    this.sync(this.session.snapshot());
  }

  private scheduleActivePaint(): void {
    this.pendingInputStartedAt ??= this.now();
    if (this.frame !== null) {
      return;
    }
    let completedSynchronously = false;
    const frame = requestAnimationFrame(() => {
      completedSynchronously = true;
      this.frame = null;
      if (this.disposed) return;
      const inputStartedAt = this.pendingInputStartedAt;
      this.pendingInputStartedAt = null;
      const segment = nextActivePaintSegment(this.activePoints, this.activePaintedPointCount);
      this.activePaintedPointCount = segment.nextPaintedPointCount;
      if (this.tool === 'eraser') {
        drawEraserPreview(
          this.activeContext,
          segment.points,
          this.activePoints[0],
          this.eraserPreviewColor,
          this.width,
          this.stageFrame.actualScale,
          isClosedLoopEraseGesture(this.activeClientPoints),
        );
      } else {
        drawStroke(
          this.activeContext,
          segment.points,
          this.tool === 'highlighter' ? `${this.color}88` : this.color,
          this.width,
        );
      }
      if (inputStartedAt !== null) {
        requestAnimationFrame(() => {
          if (!this.disposed) {
            this.recordInputToPaint(Math.max(0, this.now() - inputStartedAt));
          }
        });
      }
    });
    if (!completedSynchronously) this.frame = frame;
  }

  private renderCommitted(strokes: readonly InkStroke[], forceFull = false): void {
    const delta = forceFull
      ? ({ kind: 'full', strokes } as const)
      : committedStrokeRenderDelta(this.renderedStrokes, strokes);
    if (delta.kind === 'none') return;
    if (delta.kind === 'full') {
      this.clearCanvas(this.committedCanvas, this.committedContext);
    }
    for (const stroke of selectVisibleInkStrokes(
      delta.strokes,
      this.viewportTop,
      this.viewportHeight,
    )) {
      if (stroke.tool !== 'eraser') {
        drawStroke(this.committedContext, stroke.points, stroke.color, stroke.width);
      }
    }
    this.renderedStrokes = [...strokes];
  }

  private renderSelectionChrome(strokes: readonly InkStroke[]): void {
    if (this.activePointerId !== null) return;
    this.clearSelectionChrome();
    if (this.toolbarStore.state.value.interaction !== 'select') return;
    const selected = new Set(this.session.selectedStrokeIds?.() ?? []);
    const hovered = this.hoveredStrokeId;
    const visibleSelected = selectVisibleInkStrokes(
      strokes.filter((candidate) => selected.has(candidate.id)),
      this.viewportTop,
      this.viewportHeight,
    );
    const visibleHovered = selectVisibleInkStrokes(
      strokes.filter((candidate) => candidate.id === hovered && !selected.has(candidate.id)),
      this.viewportTop,
      this.viewportHeight,
    );
    const visible = [...visibleHovered, ...visibleSelected];
    this.selectionChromeBounds = selectionChromeBounds(visible, this.stageFrame);
    for (const stroke of visibleHovered) {
      drawStroke(this.activeContext, stroke.points, 'rgba(79, 70, 229, 0.3)', stroke.width + 4);
      drawStroke(this.activeContext, stroke.points, stroke.color, stroke.width);
    }
    for (const stroke of visibleSelected) {
      drawStroke(this.activeContext, stroke.points, 'rgba(79, 70, 229, 0.45)', stroke.width + 8);
      drawStroke(this.activeContext, stroke.points, stroke.color, stroke.width);
    }
  }

  private clearSelectionChrome(): void {
    const bounds = this.selectionChromeBounds;
    this.selectionChromeBounds = null;
    if (bounds === null) return;
    this.clearCanvasCssRect(this.activeContext, bounds);
  }

  private setHoveredStroke(strokeId: string | null): void {
    if (strokeId === this.hoveredStrokeId) return;
    this.hoveredStrokeId = strokeId;
    this.inputTarget.style.cursor = strokeId === null ? '' : 'grab';
    this.renderSelectionChrome(this.session.snapshot().surface.strokes);
  }

  private createCanvas(layer: string): HTMLCanvasElement {
    const canvas = this.document.createElement('canvas');
    const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
    canvas.className = `inkstone-ink-canvas inkstone-ink-canvas-${layer}`;
    const cssWidth = this.paneWidth(INK_DOCUMENT_LOGICAL_WIDTH);
    const cssHeight = this.paneHeight(this.viewportHeight);
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.top = '0px';
    return canvas;
  }

  private readonly onScrolled = (): void => {
    if (this.disposed) return;
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
    this.updateViewport(true);
  };

  private readonly onNativeNavigationIntent = (): void => {
    this.cancelReadingContextRestore();
  };

  private readonly onRootResized = (): void => {
    if (this.disposed) return;
    const logicalViewportTop = this.viewMode === 'raw' ? null : this.viewportTop;
    this.clampDraggedControls();
    this.applyWorkspaceScale();
    this.positionOverlay();
    if (logicalViewportTop !== null) this.restoreLogicalViewportTop(logicalViewportTop);
    this.updateViewport(true);
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
    const redraw = force || this.stageFrameChanged;
    this.resizeViewportCanvas(this.committedCanvas, this.committedContext);
    this.resizeViewportCanvas(this.activeCanvas, this.activeContext);
    this.stageFrameChanged = false;
    if (redraw) {
      const strokes = this.session.snapshot().surface.strokes;
      this.renderCommitted(this.selectionCommittedStrokes ?? strokes, true);
      this.redrawActiveLayer(strokes);
    }
  }

  private redrawActiveLayer(strokes: readonly InkStroke[]): void {
    this.clearCanvas(this.activeCanvas, this.activeContext);
    this.selectionChromeBounds = null;
    if (this.activePointerId !== null && this.activePoints.length > 0) {
      if (this.tool === 'eraser') {
        drawEraserPreview(
          this.activeContext,
          this.activePoints,
          this.activePoints[0],
          this.eraserPreviewColor,
          this.width,
          this.stageFrame.actualScale,
          isClosedLoopEraseGesture(this.activeClientPoints),
        );
      } else {
        drawStroke(
          this.activeContext,
          this.activePoints,
          this.tool === 'highlighter' ? `${this.color}88` : this.color,
          this.width,
        );
      }
      this.activePaintedPointCount = this.activePoints.length;
      return;
    }
    this.renderSelectionChrome(strokes);
  }

  private positionOverlay(): void {
    if (this.scrollContainer === null) {
      this.overlay.style.left = '0px';
      this.overlay.style.top = '0px';
      const layout = this.measureLayoutPresentation();
      const scale = layout.scale;
      const width = layout.rect.width || INK_DOCUMENT_LOGICAL_WIDTH * scale;
      const height =
        layout.rect.height || this.session.snapshot().surface.layout.logicalHeight * scale;
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

  private resizeViewportCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
    const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
    const { height, width } = this.stageFrame.canvasClientRect;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    const resized = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
    if (resized) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    if (canvas.style.width !== '100%') canvas.style.width = '100%';
    if (canvas.style.height !== '100%') canvas.style.height = '100%';
    if (canvas.style.top !== '0px') canvas.style.top = '0px';
    const transform = this.stageFrame.canvasBackingTransform(ratio);
    context.setTransform(
      transform.a,
      transform.b,
      transform.c,
      transform.d,
      transform.e,
      transform.f,
    );
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (resized && canvas === this.activeCanvas) this.selectionChromeBounds = null;
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
    const canvasRect = this.committedCanvas.getBoundingClientRect();
    if (isMeasurableRect(canvasRect)) return freezeCssRect(canvasRect);
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
    const previous = this.stageFrame;
    this.stageFrameChanged ||=
      previous.actualScale !== next.actualScale ||
      previous.canvasClientRect.left !== next.canvasClientRect.left ||
      previous.canvasClientRect.top !== next.canvasClientRect.top ||
      previous.canvasClientRect.width !== next.canvasClientRect.width ||
      previous.canvasClientRect.height !== next.canvasClientRect.height ||
      previous.documentClientOrigin.x !== next.documentClientOrigin.x ||
      previous.documentClientOrigin.y !== next.documentClientOrigin.y;
    this.stageFrame = next;
  }

  private clearCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.restore();
  }

  private clearCanvasCssRect(context: CanvasRenderingContext2D, bounds: InkDirtyRect): void {
    const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(
      Math.floor(bounds.x * ratio),
      Math.floor(bounds.y * ratio),
      Math.ceil(bounds.width * ratio),
      Math.ceil(bounds.height * ratio),
    );
    context.restore();
  }

  private setToolOptionsVisible(visible: boolean): void {
    this.updateToolbar({ optionsVisible: visible });
  }

  private resolveEraserPreviewColor(): string {
    return getComputedStyle(this.root).getPropertyValue('--text-error').trim() || '#dc2626';
  }

  private readonly onToolbarColor = (color: string): void => {
    this.toolStyles[this.tool] = { ...this.toolStyles[this.tool], color };
    this.updateToolbar({ color });
    this.persistPreference();
  };

  private readonly onToolbarDone = (): void => {
    void this.onExitRequested().catch(() => undefined);
  };

  private readonly onToolbarRedo = (): void => {
    if (this.session.redo()) this.sync(this.session.snapshot());
  };

  private readonly onToolbarDeleteSelection = (): void => {
    const deletedStrokeIds = this.session.deleteSelectedStrokes?.() ?? [];
    if (deletedStrokeIds.length > 0) this.sync(this.session.snapshot());
  };

  private readonly onToolbarRetry = (): void => {
    void this.onRetryRequested().catch(() => this.sync(this.session.snapshot()));
  };

  private readonly onToolbarToggleOptions = (): void => {
    const visible = !this.toolbarStore.state.value.optionsVisible;
    this.setToolOptionsVisible(visible);
    this.persistPreference();
    queueMicrotask(() => this.clampDraggedControls());
  };

  private readonly onToolbarTool = (tool: InkStroke['tool']): void => {
    this.finishStroke(false);
    const style = this.toolStyles[tool];
    this.updateToolbar({
      color: style.color,
      interaction: 'draw',
      selectedCount: 0,
      tool,
      width: style.width,
    });
    this.hoveredStrokeId = null;
    this.inputTarget.style.cursor = '';
    this.session.clearSelection?.();
    this.clearCanvas(this.activeCanvas, this.activeContext);
    this.selectionChromeBounds = null;
    this.persistPreference();
  };

  private readonly onToolbarSelectMove = (): void => {
    this.finishStroke(false);
    this.updateToolbar({ interaction: 'select', optionsVisible: false });
    this.inputTarget.style.cursor = '';
    this.persistPreference();
  };

  private readonly onToolbarToggleMultiple = (): void => {
    this.updateToolbar({ multiple: !this.toolbarStore.state.value.multiple });
    this.persistPreference();
  };

  private readonly onToolbarUndo = (): void => {
    if (this.session.undo()) this.sync(this.session.snapshot());
  };

  private readonly onToolbarWidth = (width: number): void => {
    this.toolStyles[this.tool] = { ...this.toolStyles[this.tool], width };
    this.updateToolbar({ width });
    this.persistPreference();
  };

  private readonly onToolbarZoomFit = (): void => {
    this.updateToolbar({ zoomMode: 'fit' });
    this.refreshWorkspacePresentation();
    this.persistPreference();
  };

  private readonly onToolbarZoomIn = (): void => {
    this.updateToolbar({
      zoomMode: 'manual',
      zoomScale: stepInkWorkspaceScale(this.toolbarStore.state.value.zoomScale, 1),
    });
    this.refreshWorkspacePresentation();
    this.persistPreference();
  };

  private readonly onToolbarZoomOut = (): void => {
    this.updateToolbar({
      zoomMode: 'manual',
      zoomScale: stepInkWorkspaceScale(this.toolbarStore.state.value.zoomScale, -1),
    });
    this.refreshWorkspacePresentation();
    this.persistPreference();
  };

  private refreshWorkspacePresentation(): void {
    const logicalViewportTop = this.viewMode === 'raw' ? null : this.viewportTop;
    this.applyWorkspaceScale();
    this.positionOverlay();
    if (logicalViewportTop !== null) this.restoreLogicalViewportTop(logicalViewportTop);
    this.updateViewport(true);
    this.renderCommitted(
      this.selectionCommittedStrokes ?? this.session.snapshot().surface.strokes,
      true,
    );
    this.renderSelectionChrome(this.session.snapshot().surface.strokes);
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
    this.viewMode = target;
    this.overlay.hidden = target === 'raw';
    this.activeCanvas.style.pointerEvents = 'none';
    this.hoveredStrokeId = null;
    this.clearCanvas(this.activeCanvas, this.activeContext);
    this.selectionChromeBounds = null;
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
    const layout = this.session.snapshot().surface.layout;
    this.layoutRoot.classList.add('inkstone-ink-workspace');
    this.layoutRoot.style.setProperty(
      '--inkstone-ink-logical-width',
      `${INK_DOCUMENT_LOGICAL_WIDTH}px`,
    );
    this.layoutRoot.style.setProperty('--inkstone-ink-logical-height', `${layout.logicalHeight}px`);
    this.applyWorkspaceScale();
  }

  private deactivateWorkspace(): void {
    this.root.classList.remove('is-ink-fit');
    this.layoutRoot.classList.remove('inkstone-ink-workspace');
    this.layoutRoot.style.removeProperty('--inkstone-ink-logical-width');
    this.layoutRoot.style.removeProperty('--inkstone-ink-logical-height');
    this.layoutRoot.style.removeProperty('--inkstone-ink-scale');
  }

  private cancelFrame(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.pendingInputStartedAt = null;
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

export function nextActivePaintSegment(
  points: readonly InkPoint[],
  paintedPointCount: number,
): { readonly nextPaintedPointCount: number; readonly points: readonly InkPoint[] } {
  const validPaintedCount =
    Number.isInteger(paintedPointCount) &&
    paintedPointCount >= 0 &&
    paintedPointCount <= points.length
      ? paintedPointCount
      : 0;
  const start = validPaintedCount === 0 ? 0 : validPaintedCount - 1;
  return {
    nextPaintedPointCount: points.length,
    points: points.slice(start),
  };
}

export function committedStrokeRenderDelta(
  previous: readonly InkStroke[],
  next: readonly InkStroke[],
):
  | { readonly kind: 'append'; readonly strokes: readonly InkStroke[] }
  | { readonly kind: 'full'; readonly strokes: readonly InkStroke[] }
  | { readonly kind: 'none'; readonly strokes: readonly InkStroke[] } {
  const unchangedPrefix =
    next.length >= previous.length && previous.every((stroke, index) => stroke === next[index]);
  if (!unchangedPrefix) return { kind: 'full', strokes: next };
  if (next.length === previous.length) return { kind: 'none', strokes: [] };
  return { kind: 'append', strokes: next.slice(previous.length) };
}

export function selectVisibleInkStrokes(
  strokes: readonly InkStroke[],
  viewportTop: number,
  viewportHeight: number,
): readonly InkStroke[] {
  if (!Number.isFinite(viewportTop) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    throw new Error('Ink viewport bounds must be finite and positive.');
  }
  const viewportBottom = viewportTop + viewportHeight;
  return strokes.filter((stroke) => {
    if (stroke.points.length === 0) return false;
    let minimumY = Number.POSITIVE_INFINITY;
    let maximumY = Number.NEGATIVE_INFINITY;
    for (const point of stroke.points) {
      minimumY = Math.min(minimumY, point.y);
      maximumY = Math.max(maximumY, point.y);
    }
    const radius = stroke.width / 2;
    return maximumY + radius >= viewportTop && minimumY - radius <= viewportBottom;
  });
}

function requireContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('Ink Mode requires a 2D Canvas context.');
  }
  context.lineCap = 'round';
  context.lineJoin = 'round';
  return context;
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

function isClosedLoopEraseGesture(points: readonly CssPoint[]): boolean {
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
  const adaptiveClosingGap = Math.min(120, Math.max(32, diagonal * 0.6));
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
    length >= 48 &&
    width >= 16 &&
    height >= 16 &&
    closingGap <= adaptiveClosingGap &&
    closingGap / length <= 0.3 &&
    effectiveArea >= Math.max(64, width * height * 0.12)
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
    pressure: touch.force,
    timeStamp: event.timeStamp,
  };
}

function selectionChromeBounds(
  strokes: readonly InkStroke[],
  frame: InkStageFrame,
): InkDirtyRect | null {
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const stroke of strokes) {
    const radius = ((stroke.width + 8) / 2 + 2) * frame.actualScale;
    for (const point of stroke.points) {
      const canvasPoint = frame.logicalToCanvasCss(point);
      minimumX = Math.min(minimumX, canvasPoint.x - radius);
      maximumX = Math.max(maximumX, canvasPoint.x + radius);
      minimumY = Math.min(minimumY, canvasPoint.y - radius);
      maximumY = Math.max(maximumY, canvasPoint.y + radius);
    }
  }
  if (!Number.isFinite(minimumX)) return null;
  const left = Math.max(0, Math.floor(minimumX));
  const top = Math.max(0, Math.floor(minimumY));
  const right = Math.min(frame.canvasClientRect.width, Math.ceil(maximumX));
  const bottom = Math.min(frame.canvasClientRect.height, Math.ceil(maximumY));
  if (right <= left || bottom <= top) return null;
  return { height: bottom - top, width: right - left, x: left, y: top };
}

function drawStroke(
  context: CanvasRenderingContext2D,
  points: readonly InkPoint[],
  color: string,
  width: number,
): void {
  const first = points[0];
  if (first === undefined) {
    return;
  }
  context.beginPath();
  context.strokeStyle = color;
  context.lineWidth = width;
  context.moveTo(first.x, first.y);
  if (points.length === 1) {
    context.lineTo(first.x + 0.01, first.y + 0.01);
  } else {
    for (const point of points.slice(1)) {
      context.lineTo(point.x, point.y);
    }
  }
  context.stroke();
}

function drawEraserPreview(
  context: CanvasRenderingContext2D,
  points: readonly InkPoint[],
  start: InkPoint | undefined,
  color: string,
  width: number,
  scale: number,
  closed: boolean,
): void {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  context.save();
  context.setLineDash([6 / safeScale, 4 / safeScale]);
  drawStroke(context, points, color, width);
  if (start !== undefined) {
    const radius = 6 / safeScale;
    context.setLineDash([]);
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = 2 / safeScale;
    context.arc(start.x, start.y, radius, 0, Math.PI * 2);
    if (closed) context.arc(start.x, start.y, radius / 2, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();
}

function simplifyPoints(points: readonly InkPoint[], tolerance: number): readonly InkPoint[] {
  if (points.length <= 2) {
    return [...points];
  }
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return [];
  }
  let furthestDistance = 0;
  let furthestIndex = -1;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    if (point === undefined) continue;
    const distance = distanceToSegment(point, first, last);
    if (distance > furthestDistance) {
      furthestDistance = distance;
      furthestIndex = index;
    }
  }
  if (furthestIndex < 0 || furthestDistance <= tolerance) {
    return [first, last];
  }
  return [
    ...simplifyPoints(points.slice(0, furthestIndex + 1), tolerance).slice(0, -1),
    ...simplifyPoints(points.slice(furthestIndex), tolerance),
  ];
}

function distanceToSegment(point: InkPoint, start: InkPoint, end: InkPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy),
    0,
    1,
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
