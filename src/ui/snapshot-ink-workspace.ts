import type { SnapshotAnnotationSession } from '../application/snapshot-annotation-session';
import { logicalStrokeIdsCoveredByPolygon } from '../domain/ink-closed-loop-erase';
import { SharedInkStrokeGeometry } from '../domain/ink-shared-stroke-geometry';
import type { InkPoint, InkStroke } from '../domain/ink-surface';
import {
  LocalInkToolPreferenceStore,
  resolveInkToolStyles,
  type InkToolPreference,
  type InkToolStyle,
} from '../storage/local-ink-tool-preference';
import {
  drawInkBrushGeometryToCanvas,
  drawInkBrushSelectionChromeToCanvas,
} from './ink-brush-canvas-adapter';
import { InkCapturePipeline, PointerEventInkAdapter } from './ink-capture-pipeline';
import { InkToolbarApp, type InkToolbarAppProps } from './ink/ink-toolbar-app';
import { createInkStageFrame } from './ink-stage-frame';
import { createPreactIsland, type UiIsland } from './runtime/mount-preact-island';
import {
  createInkToolbarStore,
  type InkToolbarState,
  type InkToolbarStore,
} from './stores/ink-toolbar-store';

interface SnapshotInkWorkspaceInput {
  readonly canvas: HTMLCanvasElement;
  readonly controlsHost: HTMLElement;
  readonly document: Document;
  readonly logicalHeight: number;
  readonly logicalWidth: number;
  readonly onDone: () => Promise<void>;
  readonly onExport?: () => Promise<void>;
  readonly onPanBy: (delta: { readonly x: number; readonly y: number }) => void;
  readonly onStatus: (message: string) => void;
  readonly onZoomFit: () => number;
  readonly onZoomStep: (factor: number) => number;
  readonly pixelRatio: number;
  readonly preferenceStore?: Pick<LocalInkToolPreferenceStore, 'load' | 'save'>;
  readonly readOnly: boolean;
  readonly session: SnapshotAnnotationSession;
}

interface SelectionDrag {
  readonly before: readonly InkStroke[];
  readonly pointerId: number;
  readonly start: InkPoint;
}

interface CanvasPanDrag {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

type ToolStyles = Record<InkStroke['tool'], InkToolStyle>;

/** Bounded Snapshot adapter over the same Ink toolbar, capture, geometry, and Canvas contracts. */
export class SnapshotInkWorkspace {
  private activePoints: InkPoint[] = [];
  private activePointerId: number | null = null;
  private canvasPanDrag: CanvasPanDrag | null = null;
  private disposed = false;
  private dragPointerId: number | null = null;
  private dragStart: {
    readonly left: number;
    readonly top: number;
    readonly x: number;
    readonly y: number;
  } | null = null;
  private readonly capturePipeline = new InkCapturePipeline();
  private readonly geometry = new SharedInkStrokeGeometry();
  private readonly pointerAdapter = new PointerEventInkAdapter();
  private readonly preferenceHintShown: boolean;
  private readonly redoStack: (readonly InkStroke[])[] = [];
  private selectedIds = new Set<string>();
  private selectionDelta: { readonly x: number; readonly y: number } | null = null;
  private selectionDrag: SelectionDrag | null = null;
  private strokes: readonly InkStroke[];
  private readonly toolbarIsland: UiIsland<InkToolbarAppProps> = createPreactIsland(InkToolbarApp);
  private readonly toolbarStore: InkToolbarStore;
  private readonly toolStyles: ToolStyles;
  private readonly undoStack: (readonly InkStroke[])[] = [];

  constructor(private readonly input: SnapshotInkWorkspaceInput) {
    this.strokes = [...input.session.snapshot().record.ink.strokes];
    const preference = input.preferenceStore?.load() ?? {
      ...LocalInkToolPreferenceStore.DEFAULT,
      optionsVisible: true,
    };
    this.preferenceHintShown = preference.hintShown;
    this.toolbarStore = createInkToolbarStore(preference);
    const styles = resolveInkToolStyles(preference);
    this.toolStyles = {
      eraser: { ...styles.eraser },
      highlighter: { ...styles.highlighter },
      pen: { ...styles.pen },
    };
    this.toolbarStore.state.value = {
      ...this.toolbarStore.state.value,
      active: !input.readOnly,
    };
    input.canvas.dataset.inkstoneSnapshotInteraction = this.toolbarStore.state.value.interaction;
    if (!input.readOnly) this.toolbarIsland.mount(input.controlsHost, this.toolbarProps());
    input.canvas.addEventListener('pointerdown', this.onPointerDown);
    input.canvas.addEventListener('pointermove', this.onPointerMove);
    input.canvas.addEventListener('pointerup', this.onPointerUp);
    input.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.paint();
  }

  syncZoom(scale: number, mode: InkToolbarState['zoomMode']): void {
    this.updateToolbar({ zoomMode: mode, zoomScale: scale });
  }

  logicalPoint(
    event: Pick<PointerEvent, 'clientX' | 'clientY' | 'pressure' | 'timeStamp'>,
  ): InkPoint {
    const frame = this.stageFrame();
    const logical = frame.clientToLogical({ x: event.clientX, y: event.clientY });
    return {
      pressure: Number.isFinite(event.pressure) && event.pressure > 0 ? event.pressure : 0.5,
      time: event.timeStamp,
      x: clamp(logical.x, 0, this.input.logicalWidth),
      y: clamp(logical.y, 0, this.input.logicalHeight),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelActiveInput();
    this.input.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.input.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.input.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.input.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    delete this.input.canvas.dataset.inkstoneSnapshotInteraction;
    this.input.canvas.classList.remove('is-panning');
    this.input.document.removeEventListener('pointermove', this.onToolbarDragMove, true);
    this.input.document.removeEventListener('pointerup', this.onToolbarDragEnd, true);
    this.toolbarIsland.unmount();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (
      this.disposed ||
      this.input.readOnly ||
      event.pointerType === 'touch' ||
      this.activePointerId !== null
    ) {
      return;
    }
    const state = this.toolbarStore.state.value;
    if (state.interaction === 'select') {
      this.beginSelection(event);
      return;
    }
    if (state.tool === 'eraser') {
      this.activePointerId = event.pointerId;
      this.activePoints = [this.logicalPoint(event)];
      this.eraseAt(this.activePoints[0] as InkPoint);
      this.input.canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    const batch = this.pointerAdapter.createBatch(event, 'down', this.captureContext());
    if (batch === null) return;
    const result = this.capturePipeline.accept(batch);
    if (result.kind !== 'active') return;
    this.activePointerId = event.pointerId;
    this.activePoints = pointsFromBatch(batch);
    this.input.canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    this.paint();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' || event.pointerId !== this.activePointerId) return;
    if (this.canvasPanDrag !== null) {
      this.input.onPanBy({
        x: event.clientX - this.canvasPanDrag.x,
        y: event.clientY - this.canvasPanDrag.y,
      });
      this.canvasPanDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      event.preventDefault();
      return;
    }
    if (this.selectionDrag !== null) {
      const point = this.logicalPoint(event);
      this.selectionDelta = this.constrainedSelectionDelta(
        point.x - this.selectionDrag.start.x,
        point.y - this.selectionDrag.start.y,
      );
      event.preventDefault();
      this.paint();
      return;
    }
    if (this.toolbarStore.state.value.tool === 'eraser') {
      appendDistinct(this.activePoints, this.logicalPoint(event));
      event.preventDefault();
      this.paint();
      return;
    }
    const batch = this.pointerAdapter.createBatch(event, 'move', this.captureContext());
    if (batch === null) return;
    const result = this.capturePipeline.accept(batch);
    if (result.kind !== 'active') return;
    appendBatchPoints(this.activePoints, batch);
    event.preventDefault();
    this.paint();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' || event.pointerId !== this.activePointerId) return;
    if (this.canvasPanDrag !== null) {
      this.canvasPanDrag = null;
      this.activePointerId = null;
      this.input.canvas.classList.remove('is-panning');
      event.preventDefault();
      return;
    }
    if (this.selectionDrag !== null) {
      this.finishSelectionMove();
      event.preventDefault();
      return;
    }
    if (this.toolbarStore.state.value.tool === 'eraser') {
      appendDistinct(this.activePoints, this.logicalPoint(event));
      this.finishClosedLoopErase();
      this.activePointerId = null;
      this.activePoints = [];
      event.preventDefault();
      this.paint();
      return;
    }
    const batch = this.pointerAdapter.createBatch(event, 'up', this.captureContext());
    if (batch !== null) {
      const result = this.capturePipeline.accept(batch);
      if (result.kind === 'completed') {
        this.pushUndo();
        const stroke: InkStroke = {
          ...result.stroke,
          brushRenderVersion: 'legacy-round-v1',
          inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
        };
        this.input.session.addStroke(stroke);
        this.strokes = [...this.input.session.snapshot().record.ink.strokes];
      }
    }
    this.activePointerId = null;
    this.activePoints = [];
    event.preventDefault();
    this.paint();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointerId) return;
    this.cancelActiveInput();
    this.paint();
  };

  private beginSelection(event: PointerEvent): void {
    const point = this.logicalPoint(event);
    const hit = [...this.strokes]
      .reverse()
      .find((stroke) => this.geometry.hitTest(stroke, point, Math.max(6, stroke.width / 2)));
    const multiple = this.toolbarStore.state.value.multiple;
    if (!multiple) this.selectedIds.clear();
    if (hit === undefined) {
      this.updateToolbar({ selectedCount: this.selectedIds.size });
      this.canvasPanDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      this.activePointerId = event.pointerId;
      this.input.canvas.classList.add('is-panning');
      this.input.canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      this.paint();
      return;
    }
    if (multiple && this.selectedIds.has(hit.id)) this.selectedIds.delete(hit.id);
    else this.selectedIds.add(hit.id);
    this.selectionDrag = { before: this.strokes, pointerId: event.pointerId, start: point };
    this.selectionDelta = { x: 0, y: 0 };
    this.activePointerId = event.pointerId;
    this.input.canvas.setPointerCapture?.(event.pointerId);
    this.updateToolbar({ selectedCount: this.selectedIds.size });
    event.preventDefault();
    this.paint();
  }

  private finishSelectionMove(): void {
    const drag = this.selectionDrag;
    const delta = this.selectionDelta;
    if (drag !== null && delta !== null && (delta.x !== 0 || delta.y !== 0)) {
      this.undoStack.push(drag.before);
      this.redoStack.length = 0;
      this.strokes = movedStrokes(this.strokes, this.selectedIds, delta);
      this.input.session.replaceStrokes(this.strokes);
    }
    this.selectionDrag = null;
    this.selectionDelta = null;
    this.activePointerId = null;
    this.updateHistoryState();
    this.paint();
  }

  private eraseAt(point: InkPoint): void {
    const erased = [...this.strokes]
      .reverse()
      .find((stroke) => this.geometry.hitTest(stroke, point, Math.max(6, stroke.width / 2)));
    if (erased === undefined) return;
    this.pushUndo();
    this.strokes = this.strokes.filter((stroke) => stroke.id !== erased.id);
    this.input.session.replaceStrokes(this.strokes);
    this.paint();
  }

  private finishClosedLoopErase(): void {
    if (this.activePoints.length < 3) return;
    const erasedIds = new Set(logicalStrokeIdsCoveredByPolygon(this.strokes, this.activePoints));
    if (erasedIds.size === 0) return;
    this.pushUndo();
    this.strokes = this.strokes.filter(
      (stroke) => !erasedIds.has(stroke.linkedStrokeId ?? stroke.id),
    );
    this.input.session.replaceStrokes(this.strokes);
  }

  private paint(): void {
    const context = this.input.canvas.getContext('2d');
    if (context === null) return;
    context.setTransform(this.input.pixelRatio, 0, 0, this.input.pixelRatio, 0, 0);
    context.clearRect(0, 0, this.input.logicalWidth, this.input.logicalHeight);
    const visible =
      this.selectionDelta === null
        ? this.strokes
        : movedStrokes(this.strokes, this.selectedIds, this.selectionDelta);
    for (const stroke of visible) {
      const compiled = this.geometry.compile(stroke);
      if (compiled.kind !== 'exact' && compiled.kind !== 'unpublished') continue;
      drawInkBrushGeometryToCanvas(context, compiled.geometry);
      if (this.selectedIds.has(stroke.id)) {
        drawInkBrushSelectionChromeToCanvas(context, compiled.geometry, '#7c5cff', 2);
      }
    }
    const state = this.toolbarStore.state.value;
    if (this.activePoints.length > 0 && state.interaction === 'draw') {
      const active: InkStroke = {
        brushRenderVersion: 'legacy-round-v1',
        color: state.tool === 'eraser' ? '#dc2626' : state.color,
        id: 'snapshot-active',
        inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
        points: this.activePoints,
        tool: state.tool === 'eraser' ? 'pen' : state.tool,
        width: state.tool === 'eraser' ? 2 : state.width,
      };
      const compiled = this.geometry.compile(active);
      if (compiled.kind === 'exact' || compiled.kind === 'unpublished') {
        drawInkBrushGeometryToCanvas(context, compiled.geometry);
      }
    }
    this.updateHistoryState();
  }

  private captureContext() {
    const state = this.toolbarStore.state.value;
    return {
      frame: this.stageFrame(),
      frameEpoch: 0,
      logicalBounds: {
        height: this.input.logicalHeight,
        width: this.input.logicalWidth,
        x: 0,
        y: 0,
      },
      style: { color: state.color, tool: state.tool, width: state.width },
    } as const;
  }

  private stageFrame() {
    const bounds = this.input.canvas.getBoundingClientRect();
    const width = bounds.width > 0 ? bounds.width : this.input.logicalWidth;
    const height = bounds.height > 0 ? bounds.height : this.input.logicalHeight;
    const actualScale = Math.min(
      width / this.input.logicalWidth,
      height / this.input.logicalHeight,
    );
    return createInkStageFrame({
      actualScale,
      canvasClientRect: { height, left: bounds.left, top: bounds.top, width },
      documentClientOrigin: { x: bounds.left, y: bounds.top },
    });
  }

  private pushUndo(): void {
    this.undoStack.push(this.strokes);
    this.redoStack.length = 0;
    this.updateHistoryState();
  }

  private undo(): void {
    const previous = this.undoStack.pop();
    if (previous === undefined) return;
    this.redoStack.push(this.strokes);
    this.strokes = previous;
    this.selectedIds.clear();
    this.input.session.replaceStrokes(this.strokes);
    this.input.onStatus('');
    this.paint();
  }

  private redo(): void {
    const replacement = this.redoStack.pop();
    if (replacement === undefined) return;
    this.undoStack.push(this.strokes);
    this.strokes = replacement;
    this.selectedIds.clear();
    this.input.session.replaceStrokes(this.strokes);
    this.input.onStatus('');
    this.paint();
  }

  private deleteSelection(): void {
    if (this.selectedIds.size === 0) return;
    this.pushUndo();
    this.strokes = this.strokes.filter((stroke) => !this.selectedIds.has(stroke.id));
    this.selectedIds.clear();
    this.input.session.replaceStrokes(this.strokes);
    this.paint();
  }

  private constrainedSelectionDelta(
    dx: number,
    dy: number,
  ): { readonly x: number; readonly y: number } {
    const points = this.strokes
      .filter((stroke) => this.selectedIds.has(stroke.id))
      .flatMap((stroke) => stroke.points);
    if (points.length === 0) return { x: 0, y: 0 };
    const minimumX = Math.min(...points.map(({ x }) => x));
    const maximumX = Math.max(...points.map(({ x }) => x));
    const minimumY = Math.min(...points.map(({ y }) => y));
    const maximumY = Math.max(...points.map(({ y }) => y));
    return {
      x: clamp(dx, -minimumX, this.input.logicalWidth - maximumX),
      y: clamp(dy, -minimumY, this.input.logicalHeight - maximumY),
    };
  }

  private cancelActiveInput(): void {
    this.capturePipeline.cancelActive();
    this.activePointerId = null;
    this.activePoints = [];
    this.canvasPanDrag = null;
    this.input.canvas.classList.remove('is-panning');
    this.selectionDrag = null;
    this.selectionDelta = null;
  }

  private async done(): Promise<void> {
    const state = this.toolbarStore.state.value;
    if (state.committing) return;
    this.updateToolbar({
      committing: true,
      saveError: null,
      statusText: 'Snapshot markup · Saving…',
    });
    try {
      await this.input.onDone();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Local save failed. Retry.';
      this.input.onStatus(message);
      this.updateToolbar({ committing: false, saveError: message, statusText: message });
    }
  }

  private async exportUnsaved(): Promise<void> {
    if (this.input.onExport === undefined) return;
    try {
      await this.input.onExport();
      this.input.onStatus('Flattened PNG exported');
    } catch (error) {
      this.input.onStatus(error instanceof Error ? error.message : 'Snapshot PNG export failed.');
    }
  }

  private toolbarProps(): InkToolbarAppProps {
    return {
      labels: {
        done: 'Done',
        exportUnsaved: 'Export flattened Snapshot PNG',
        retry: 'Retry local save',
      },
      onColor: (color) => {
        const tool = this.toolbarStore.state.value.tool;
        this.toolStyles[tool] = { ...this.toolStyles[tool], color };
        this.updateToolbar({ color });
        this.persistPreference();
      },
      onDeleteSelection: () => this.deleteSelection(),
      onDone: () => void this.done(),
      onDragKeyDown: this.onToolbarDragKeyDown,
      onDragStart: this.onToolbarDragStart,
      onExportUnsaved: () => void this.exportUnsaved(),
      onRedo: () => this.redo(),
      onRetry: () => void this.done(),
      onSelectMove: () => {
        this.cancelActiveInput();
        this.input.canvas.dataset.inkstoneSnapshotInteraction = 'select';
        this.updateToolbar({ interaction: 'select', optionsVisible: false });
        this.persistPreference();
      },
      onToggleMultiple: () => {
        this.updateToolbar({ multiple: !this.toolbarStore.state.value.multiple });
        this.persistPreference();
      },
      onToggleOptions: () => {
        this.updateToolbar({ optionsVisible: !this.toolbarStore.state.value.optionsVisible });
        this.persistPreference();
      },
      onTool: (tool) => {
        this.cancelActiveInput();
        this.selectedIds.clear();
        this.input.canvas.dataset.inkstoneSnapshotInteraction = 'draw';
        this.updateToolbar({
          ...this.toolStyles[tool],
          interaction: 'draw',
          selectedCount: 0,
          tool,
        });
        this.paint();
        this.persistPreference();
      },
      onUndo: () => this.undo(),
      onWidth: (width) => {
        const tool = this.toolbarStore.state.value.tool;
        this.toolStyles[tool] = { ...this.toolStyles[tool], width };
        this.updateToolbar({ width });
        this.persistPreference();
      },
      onZoomFit: () => {
        this.syncZoom(this.input.onZoomFit(), 'fit');
        this.persistPreference();
      },
      onZoomIn: () => {
        this.syncZoom(this.input.onZoomStep(1.25), 'manual');
        this.persistPreference();
      },
      onZoomOut: () => {
        this.syncZoom(this.input.onZoomStep(0.8), 'manual');
        this.persistPreference();
      },
      state: this.toolbarStore.state,
    };
  }

  private updateHistoryState(): void {
    this.updateToolbar(
      {
        canRedo: this.redoStack.length > 0,
        canUndo: this.undoStack.length > 0,
        selectedCount: this.selectedIds.size,
      },
      true,
    );
  }

  private updateToolbar(update: Partial<InkToolbarState>, render = true): void {
    const current = this.toolbarStore.state.value;
    if (
      Object.entries(update).every(([key, value]) =>
        Object.is(current[key as keyof InkToolbarState], value),
      )
    )
      return;
    this.toolbarStore.state.value = { ...current, ...update };
    if (render && !this.input.readOnly) this.toolbarIsland.update(this.toolbarProps());
  }

  private readonly onToolbarDragStart = (event: PointerEvent): void => {
    const controls = (event.currentTarget as HTMLElement).closest<HTMLElement>(
      '.inkstone-ink-controls',
    );
    if (controls === null) return;
    const bounds = controls.getBoundingClientRect();
    this.dragPointerId = event.pointerId;
    this.dragStart = { left: bounds.left, top: bounds.top, x: event.clientX, y: event.clientY };
    this.updateToolbar({ dragging: true });
    this.input.document.addEventListener('pointermove', this.onToolbarDragMove, true);
    this.input.document.addEventListener('pointerup', this.onToolbarDragEnd, true);
    event.preventDefault();
  };

  private readonly onToolbarDragMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.dragPointerId || this.dragStart === null) return;
    this.setToolbarPosition(
      this.dragStart.left + event.clientX - this.dragStart.x,
      this.dragStart.top + event.clientY - this.dragStart.y,
    );
  };

  private readonly onToolbarDragEnd = (event: PointerEvent): void => {
    if (event.pointerId !== this.dragPointerId) return;
    this.dragPointerId = null;
    this.dragStart = null;
    this.input.document.removeEventListener('pointermove', this.onToolbarDragMove, true);
    this.input.document.removeEventListener('pointerup', this.onToolbarDragEnd, true);
    this.updateToolbar({ dragging: false });
    this.persistPreference();
  };

  private readonly onToolbarDragKeyDown = (event: KeyboardEvent): void => {
    const delta = event.shiftKey ? 10 : 2;
    const controls = (event.currentTarget as HTMLElement).closest<HTMLElement>(
      '.inkstone-ink-controls',
    );
    if (controls === null) return;
    const bounds = controls.getBoundingClientRect();
    const movement =
      event.key === 'ArrowLeft'
        ? { x: -delta, y: 0 }
        : event.key === 'ArrowRight'
          ? { x: delta, y: 0 }
          : event.key === 'ArrowUp'
            ? { x: 0, y: -delta }
            : event.key === 'ArrowDown'
              ? { x: 0, y: delta }
              : null;
    if (movement === null) return;
    this.setToolbarPosition(bounds.left + movement.x, bounds.top + movement.y);
    this.persistPreference();
    event.preventDefault();
  };

  private persistPreference(): void {
    const state = this.toolbarStore.state.value;
    const preference: InkToolPreference = {
      color: state.color,
      hintShown: this.preferenceHintShown,
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
    };
    this.input.preferenceStore?.save(preference);
  }

  private setToolbarPosition(left: number, top: number): void {
    const viewport = this.input.document.defaultView;
    const maximumLeft = Math.max(0, (viewport?.innerWidth ?? 0) - 48);
    const maximumTop = Math.max(0, (viewport?.innerHeight ?? 0) - 48);
    this.updateToolbar({
      position: {
        dragged: true,
        left: clamp(left, 0, maximumLeft),
        top: clamp(top, 0, maximumTop),
      },
    });
  }
}

function pointsFromBatch(batch: ReturnType<PointerEventInkAdapter['createBatch']>): InkPoint[] {
  if (batch === null) return [];
  return batch.samples.map((sample) => ({
    pressure: sample.pressure.kind === 'measured' ? sample.pressure.value : 0.5,
    time: sample.time,
    x: sample.x,
    y: sample.y,
  }));
}

function appendBatchPoints(
  target: InkPoint[],
  batch: NonNullable<ReturnType<PointerEventInkAdapter['createBatch']>>,
): void {
  for (const point of pointsFromBatch(batch)) appendDistinct(target, point);
}

function appendDistinct(target: InkPoint[], point: InkPoint): void {
  const previous = target.at(-1);
  if (previous?.x === point.x && previous.y === point.y && previous.time === point.time) return;
  target.push(point);
}

function movedStrokes(
  strokes: readonly InkStroke[],
  selectedIds: ReadonlySet<string>,
  delta: { readonly x: number; readonly y: number },
): readonly InkStroke[] {
  return strokes.map((stroke) =>
    selectedIds.has(stroke.id)
      ? {
          ...stroke,
          points: stroke.points.map((point) => ({
            ...point,
            x: point.x + delta.x,
            y: point.y + delta.y,
          })),
        }
      : stroke,
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
