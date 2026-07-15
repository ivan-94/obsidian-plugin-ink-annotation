import type { InkSurfaceSessionSnapshot } from '../application/ink-surface-session';
import type { InkPoint, InkStroke } from '../domain/ink-surface';
import {
  LocalInkToolPreferenceStore,
  type InkToolPreference,
} from '../storage/local-ink-tool-preference';
import { InkToolbarApp, type InkToolbarAppProps } from './ink/ink-toolbar-app';
import { createPreactIsland, type UiIsland } from './runtime/mount-preact-island';
import {
  createInkToolbarStore,
  type InkToolbarState,
  type InkToolbarStore,
} from './stores/ink-toolbar-store';

interface InkSessionLike {
  addStroke(stroke: InkStroke): void;
  background(): Promise<void>;
  canRedo(): boolean;
  canUndo(): boolean;
  eraseStrokeAt(point: InkPoint, radius: number): string | null;
  exit(): Promise<void>;
  redo(): boolean;
  retry(): Promise<void>;
  snapshot(): InkSurfaceSessionSnapshot;
  undo(): boolean;
}

interface InkControlsDragState {
  readonly left: number;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly top: number;
}

/** A single fixed logical surface. It is visible but pointer-transparent outside Ink Mode. */
export class InkCanvasController {
  private active = false;
  private readonly activeCanvas: HTMLCanvasElement;
  private readonly activeContext: CanvasRenderingContext2D;
  private activePointerId: number | null = null;
  private activePoints: InkPoint[] = [];
  private activePaintedPointCount = 0;
  private readonly committedCanvas: HTMLCanvasElement;
  private readonly committedContext: CanvasRenderingContext2D;
  private readonly controls: HTMLElement;
  private controlsDragState: InkControlsDragState | null = null;
  private disposed = false;
  private readonly document: Document;
  private readonly dragHandle: HTMLButtonElement;
  private readonly extentProbeTimeouts = new Set<number>();
  private frame: number | null = null;
  private hintShown: boolean;
  private layoutRoot: HTMLElement;
  private readonly onExitRequested: () => Promise<void>;
  private readonly onLayoutExtentChanged: (minimumHeight: number) => void;
  private readonly onPreferenceChanged: (preference: InkToolPreference) => void;
  private readonly now: () => number;
  private readonly overlay: HTMLElement;
  private pendingInputStartedAt: number | null = null;
  private previousPosition: string;
  private readonly recordInputToPaint: (durationMs: number) => void;
  private reportedLayoutExtent = 0;
  private renderedStrokes: readonly InkStroke[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private root: HTMLElement;
  private readonly scrollContainer: HTMLElement | null;
  private readonly session: InkSessionLike;
  private readonly toolbarHost: HTMLElement;
  private readonly toolbarIsland: UiIsland<InkToolbarAppProps> = createPreactIsland(InkToolbarApp);
  private readonly toolbarStore: InkToolbarStore;
  private viewportHeight: number;
  private viewportTop: number;

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
    readonly preference?: InkToolPreference;
    readonly recordInputToPaint?: (durationMs: number) => void;
    readonly root: HTMLElement;
    readonly scrollContainer?: HTMLElement;
    readonly session: InkSessionLike;
  }) {
    this.document = input.document;
    this.root = input.root;
    this.layoutRoot = input.layoutRoot ?? input.root;
    this.scrollContainer = input.scrollContainer ?? null;
    this.session = input.session;
    this.now = input.now ?? (() => performance.now());
    this.onExitRequested = input.onExitRequested ?? (() => this.exit());
    this.onLayoutExtentChanged = input.onLayoutExtentChanged ?? (() => undefined);
    this.recordInputToPaint = input.recordInputToPaint ?? (() => undefined);
    const preference = input.preference ?? LocalInkToolPreferenceStore.DEFAULT;
    this.hintShown = preference.hintShown;
    this.toolbarStore = createInkToolbarStore(preference);
    this.onPreferenceChanged = input.onPreferenceChanged ?? (() => undefined);
    this.previousPosition = input.root.style.position;
    if (getComputedStyle(input.root).position === 'static') {
      input.root.style.position = 'relative';
    }
    input.root.classList.add('inkstone-ink-host');

    const snapshot = input.session.snapshot();
    this.viewportHeight = this.measureViewportHeight(snapshot.surface.layout.logicalHeight);
    this.viewportTop = this.measureViewportTop(
      snapshot.surface.layout.logicalHeight,
      this.viewportHeight,
    );
    this.overlay = input.document.createElement('div');
    this.overlay.className = 'inkstone-ink-surface';
    this.overlay.dataset.inkstoneInkSurface = snapshot.surface.id;
    this.overlay.style.width = `${snapshot.surface.layout.logicalWidth}px`;
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
    this.positionOverlay();
    input.root.append(this.overlay);

    this.activeCanvas.addEventListener('pointerdown', this.onPointerDown);
    this.activeCanvas.addEventListener('pointermove', this.onPointerMove);
    this.activeCanvas.addEventListener('pointerup', this.onPointerEnd);
    this.activeCanvas.addEventListener('pointercancel', this.onPointerCancel);
    this.scrollContainer?.addEventListener('scroll', this.onViewportChanged, { passive: true });
    this.document.defaultView?.addEventListener('resize', this.onViewportChanged);
    this.sync(snapshot);
    const ResizeObserverConstructor =
      input.document.defaultView?.ResizeObserver ??
      (typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver);
    if (ResizeObserverConstructor !== undefined) {
      this.resizeObserver = new ResizeObserverConstructor(this.onRootResized);
      this.resizeObserver.observe(this.layoutRoot);
    }
    queueMicrotask(this.onRootResized);
    this.scheduleExtentProbes();
  }

  enter(): void {
    if (this.disposed) {
      throw new Error('Cannot enter a disposed Ink surface.');
    }
    this.active = true;
    this.root.classList.add('is-ink-mode');
    this.activeCanvas.style.pointerEvents = 'auto';
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

  async exit(): Promise<void> {
    this.finishStroke(false);
    try {
      await this.session.exit();
      this.sync(this.session.snapshot());
      this.deactivate();
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

  coversHeight(minimumHeight: number): boolean {
    return this.session.snapshot().surface.layout.logicalHeight >= Math.ceil(minimumHeight);
  }

  isAttachedTo(root: HTMLElement): boolean {
    return this.layoutRoot === root && this.overlay.parentElement === this.root;
  }

  /** Keeps an active document session alive when Obsidian replaces its virtualized layout root. */
  reattach(root: HTMLElement): void {
    if (this.disposed) {
      throw new Error('Cannot reattach a disposed Ink surface.');
    }
    if (root === this.layoutRoot) {
      if (this.overlay.parentElement !== this.root) this.root.append(this.overlay);
      this.positionOverlay();
      this.updateViewport(true);
      return;
    }
    this.layoutRoot = root;
    if (this.overlay.parentElement !== this.root) this.root.append(this.overlay);
    this.positionOverlay();
    this.reportedLayoutExtent = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver?.observe(root);
    this.updateViewport(true);
    this.onRootResized();
    this.scheduleExtentProbes();
  }

  sync(snapshot: InkSurfaceSessionSnapshot): void {
    if (this.disposed) {
      return;
    }
    this.renderCommitted(snapshot.surface.strokes);
    const error = snapshot.persistence.kind === 'error';
    this.updateToolbar({
      canRedo: this.session.canRedo(),
      canUndo: this.session.canUndo(),
      saveError: error ? snapshot.persistence.message : null,
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
    this.activeCanvas.removeEventListener('pointerdown', this.onPointerDown);
    this.activeCanvas.removeEventListener('pointermove', this.onPointerMove);
    this.activeCanvas.removeEventListener('pointerup', this.onPointerEnd);
    this.activeCanvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.stopControlsDrag();
    this.scrollContainer?.removeEventListener('scroll', this.onViewportChanged);
    this.document.defaultView?.removeEventListener('resize', this.onViewportChanged);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const timeout of this.extentProbeTimeouts) {
      this.document.defaultView?.clearTimeout(timeout);
    }
    this.extentProbeTimeouts.clear();
    this.overlay.remove();
    this.toolbarIsland.unmount();
    this.toolbarHost.remove();
    this.root.classList.remove('inkstone-ink-host', 'is-ink-mode');
    this.root.style.position = this.previousPosition;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.active || event.button !== 0 || !isDrawingPointer(event.pointerType)) {
      return;
    }
    event.preventDefault();
    this.activePointerId = event.pointerId;
    this.activePoints = [];
    this.activePaintedPointCount = 0;
    this.activeContext.clearRect(0, 0, this.activeCanvas.width, this.activeCanvas.height);
    this.activeCanvas.setPointerCapture?.(event.pointerId);
    this.appendEventPoints(event);
    this.scheduleActivePaint();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }
    event.preventDefault();
    this.appendEventPoints(event);
    this.scheduleActivePaint();
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }
    event.preventDefault();
    this.appendEventPoints(event);
    this.finishStroke(true);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) {
      return;
    }
    event.preventDefault();
    this.finishStroke(false);
  };

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
  };

  private appendEventPoints(event: PointerEvent): void {
    const bounds = this.activeCanvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }
    const layout = this.session.snapshot().surface.layout;
    const samples = event.getCoalescedEvents?.() ?? [event];
    for (const sample of samples) {
      const previous = this.activePoints.at(-1);
      const time = Math.max(sample.timeStamp, previous?.time ?? Number.NEGATIVE_INFINITY);
      this.activePoints.push({
        pressure: sample.pressure > 0 ? sample.pressure : 0.5,
        time,
        x: clamp(
          ((sample.clientX - bounds.left) / bounds.width) * layout.logicalWidth,
          0,
          layout.logicalWidth,
        ),
        y: clamp(
          this.viewportTop + ((sample.clientY - bounds.top) / bounds.height) * this.viewportHeight,
          0,
          layout.logicalHeight,
        ),
        ...(sample.tiltX === 0 ? {} : { tiltX: sample.tiltX }),
        ...(sample.tiltY === 0 ? {} : { tiltY: sample.tiltY }),
      });
    }
  }

  private finishStroke(commit: boolean): void {
    this.cancelFrame();
    const pointerId = this.activePointerId;
    this.activePointerId = null;
    if (pointerId !== null && this.activeCanvas.hasPointerCapture?.(pointerId)) {
      this.activeCanvas.releasePointerCapture(pointerId);
    }
    this.activeContext.clearRect(0, 0, this.activeCanvas.width, this.activeCanvas.height);
    const points = simplifyPoints(this.activePoints, 0.8);
    this.activePoints = [];
    this.activePaintedPointCount = 0;
    if (!commit || points.length === 0) {
      return;
    }
    if (this.tool === 'eraser') {
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
      const inputStartedAt = this.pendingInputStartedAt;
      this.pendingInputStartedAt = null;
      const segment = nextActivePaintSegment(this.activePoints, this.activePaintedPointCount);
      this.activePaintedPointCount = segment.nextPaintedPointCount;
      drawStroke(
        this.activeContext,
        segment.points,
        this.tool === 'highlighter' ? `${this.color}88` : this.color,
        this.width,
        this.viewportTop,
      );
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
      this.committedContext.clearRect(
        0,
        0,
        this.committedCanvas.width,
        this.committedCanvas.height,
      );
    }
    for (const stroke of selectVisibleInkStrokes(
      delta.strokes,
      this.viewportTop,
      this.viewportHeight,
    )) {
      if (stroke.tool !== 'eraser') {
        drawStroke(
          this.committedContext,
          stroke.points,
          stroke.color,
          stroke.width,
          this.viewportTop,
        );
      }
    }
    this.renderedStrokes = [...strokes];
  }

  private createCanvas(layer: string): HTMLCanvasElement {
    const snapshot = this.session.snapshot();
    const canvas = this.document.createElement('canvas');
    const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
    canvas.className = `inkstone-ink-canvas inkstone-ink-canvas-${layer}`;
    canvas.width = Math.round(snapshot.surface.layout.logicalWidth * ratio);
    canvas.height = Math.round(this.viewportHeight * ratio);
    canvas.style.width = `${snapshot.surface.layout.logicalWidth}px`;
    canvas.style.height = `${this.viewportHeight}px`;
    canvas.style.top = `${this.viewportTop}px`;
    const context = requireContext(canvas);
    context.scale(ratio, ratio);
    return canvas;
  }

  private readonly onViewportChanged = (): void => {
    this.onRootResized();
  };

  private readonly onRootResized = (): void => {
    if (this.disposed) return;
    this.clampDraggedControls();
    this.updateViewport(false);
    const extent = Math.ceil(
      Math.max(this.layoutRoot.scrollHeight, this.layoutRoot.getBoundingClientRect().height),
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
    const layoutHeight = this.session.snapshot().surface.layout.logicalHeight;
    const nextHeight = this.measureViewportHeight(layoutHeight);
    const nextTop = this.measureViewportTop(layoutHeight, nextHeight);
    if (!force && nextHeight === this.viewportHeight && nextTop === this.viewportTop) return;
    this.viewportHeight = nextHeight;
    this.viewportTop = nextTop;
    this.resizeViewportCanvas(this.committedCanvas, this.committedContext);
    this.resizeViewportCanvas(this.activeCanvas, this.activeContext);
    this.renderCommitted(this.session.snapshot().surface.strokes, true);
  }

  private measureViewportHeight(layoutHeight: number): number {
    if (this.scrollContainer === null) return layoutHeight;
    const measured =
      this.scrollContainer.clientHeight || this.scrollContainer.getBoundingClientRect().height;
    return clamp(measured, 1, layoutHeight);
  }

  private measureViewportTop(layoutHeight: number, viewportHeight: number): number {
    if (this.scrollContainer === null) return 0;
    const containerTop = this.scrollContainer.getBoundingClientRect().top;
    const rootTop = this.layoutRoot.getBoundingClientRect().top;
    return clamp(containerTop - rootTop, 0, Math.max(0, layoutHeight - viewportHeight));
  }

  private positionOverlay(): void {
    if (this.scrollContainer === null || this.root === this.layoutRoot) {
      this.overlay.style.left = '0px';
      this.overlay.style.top = '0px';
      return;
    }
    const hostRect = this.root.getBoundingClientRect();
    const layoutRect = this.layoutRoot.getBoundingClientRect();
    this.overlay.style.left = `${layoutRect.left - hostRect.left + this.root.scrollLeft}px`;
    this.overlay.style.top = `${layoutRect.top - hostRect.top + this.root.scrollTop}px`;
  }

  private resizeViewportCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
    const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
    const width = this.session.snapshot().surface.layout.logicalWidth;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(this.viewportHeight * ratio);
    const resized = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${this.viewportHeight}px`;
    canvas.style.top = `${this.viewportTop}px`;
    if (resized) {
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.scale(ratio, ratio);
    }
  }

  private setToolOptionsVisible(visible: boolean): void {
    this.updateToolbar({ optionsVisible: visible });
  }

  private readonly onToolbarColor = (color: string): void => {
    this.updateToolbar({ color });
    this.persistPreference();
  };

  private readonly onToolbarDone = (): void => {
    void this.onExitRequested().catch(() => undefined);
  };

  private readonly onToolbarRedo = (): void => {
    if (this.session.redo()) this.sync(this.session.snapshot());
  };

  private readonly onToolbarRetry = (): void => {
    void this.session
      .retry()
      .then(() => {
        this.sync(this.session.snapshot());
        if (this.session.snapshot().state.kind === 'reading') this.deactivate();
      })
      .catch(() => this.sync(this.session.snapshot()));
  };

  private readonly onToolbarToggleOptions = (): void => {
    const visible = !this.toolbarStore.state.value.optionsVisible;
    this.setToolOptionsVisible(visible);
    if (visible) {
      this.controls
        .querySelector<HTMLInputElement>('[data-inkstone-ink-color]')
        ?.focus({ preventScroll: true });
    }
  };

  private readonly onToolbarTool = (tool: InkStroke['tool']): void => {
    const state = this.toolbarStore.state.value;
    if (state.tool === tool && tool !== 'eraser') {
      this.setToolOptionsVisible(!state.optionsVisible);
      return;
    }
    this.updateToolbar(
      {
        optionsVisible: false,
        tool,
        width: tool === 'pen' ? 4 : tool === 'highlighter' ? 12 : 16,
      },
      false,
    );
    this.persistPreference();
  };

  private readonly onToolbarUndo = (): void => {
    if (this.session.undo()) this.sync(this.session.snapshot());
  };

  private readonly onToolbarWidth = (width: number): void => {
    this.updateToolbar({ width });
    this.persistPreference();
  };

  private toolbarProps(): InkToolbarAppProps {
    return {
      onColor: this.onToolbarColor,
      onDone: this.onToolbarDone,
      onDragKeyDown: this.onControlsDragKeyDown,
      onDragStart: this.onControlsDragStart,
      onRedo: this.onToolbarRedo,
      onRetry: this.onToolbarRetry,
      onToggleOptions: this.onToolbarToggleOptions,
      onTool: this.onToolbarTool,
      onUndo: this.onToolbarUndo,
      onWidth: this.onToolbarWidth,
      state: this.toolbarStore.state,
    };
  }

  private updateToolbar(update: Partial<InkToolbarState>, render = true): void {
    this.toolbarStore.state.value = { ...this.toolbarStore.state.value, ...update };
    if (render) this.toolbarIsland.update(this.toolbarProps());
  }

  private moveControls(left: number, top: number, markDragged = true): void {
    const bounds = this.controls.getBoundingClientRect();
    const viewport = this.document.documentElement;
    const width = bounds.width || this.controls.offsetWidth;
    const height = bounds.height || this.controls.offsetHeight;
    const maxLeft = Math.max(8, viewport.clientWidth - width - 8);
    const maxTop = Math.max(8, viewport.clientHeight - height - 8);
    this.updateToolbar({
      position: {
        dragged: markDragged || this.toolbarStore.state.value.position?.dragged === true,
        left: Math.round(clamp(left, 8, maxLeft)),
        top: Math.round(clamp(top, 8, maxTop)),
      },
    });
  }

  private positionControlsDefault(): void {
    if (this.toolbarStore.state.value.position?.dragged === true) return;
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
    if (this.toolbarStore.state.value.position?.dragged !== true) return;
    const bounds = this.controls.getBoundingClientRect();
    this.moveControls(bounds.left, bounds.top);
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
      tool: state.tool,
      width: state.width,
    });
  }

  private deactivate(): void {
    this.active = false;
    this.activeCanvas.style.pointerEvents = 'none';
    this.updateToolbar({ active: false });
    this.root.classList.remove('is-ink-mode');
  }

  private cancelFrame(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.pendingInputStartedAt = null;
  }
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
  if (
    !Number.isFinite(viewportTop) ||
    !Number.isFinite(viewportHeight) ||
    viewportTop < 0 ||
    viewportHeight <= 0
  ) {
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

function drawStroke(
  context: CanvasRenderingContext2D,
  points: readonly InkPoint[],
  color: string,
  width: number,
  offsetY = 0,
): void {
  const first = points[0];
  if (first === undefined) {
    return;
  }
  context.beginPath();
  context.strokeStyle = color;
  context.lineWidth = width;
  context.moveTo(first.x, first.y - offsetY);
  if (points.length === 1) {
    context.lineTo(first.x + 0.01, first.y + 0.01 - offsetY);
  } else {
    for (const point of points.slice(1)) {
      context.lineTo(point.x, point.y - offsetY);
    }
  }
  context.stroke();
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
