import type { InkPreviewProjection } from '../application/ink-preview-projection';
import { SharedInkStrokeGeometry } from '../domain/ink-shared-stroke-geometry';
import {
  NOOP_INK_PERFORMANCE_RECORDER,
  type InkPerformanceRecorder,
  type InkPerformanceSpan,
} from '../runtime/ink-performance-diagnostics';
import { InkWorkScheduler } from '../runtime/ink-work-scheduler';
import type {
  IndexedDbInkPreviewCache,
  InkPreviewCacheHit,
  InkPreviewCacheKey,
  InkPreviewCacheTile,
} from '../storage/indexeddb-ink-preview-cache';
import { drawInkBrushGeometryToCanvas } from './ink-brush-canvas-adapter';
import {
  InkDisposableMemoryReservation,
  type InkGeometryCacheCoordinator,
} from './ink-geometry-cache';
import {
  type InkPreviewTileEncoder,
  InkPreviewTileWorkerEncoder,
} from './ink-preview-tile-encoder';

type InkPreviewCachePort = Pick<IndexedDbInkPreviewCache, 'load' | 'publish'>;

interface InkPreviewViewport {
  readonly backingHeight: number;
  readonly backingWidth: number;
  readonly dpr: number;
  readonly height: number;
  readonly left: number;
  readonly logicalHeight: number;
  readonly logicalLeft: number;
  readonly logicalTop: number;
  readonly logicalWidth: number;
  readonly scale: number;
  readonly top: number;
  readonly width: number;
}

/** One-canvas, read-only Preview presenter. It owns no Pencil, toolbar, Undo, or persistence state. */
export class InkPreviewProjectionController {
  private readonly cancelFrame: (handle: number) => void;
  private readonly cache: InkPreviewCachePort | null;
  private readonly cacheKey: InkPreviewCacheKey | null;
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private readonly document: Document;
  private documentOriginInset: Readonly<{ x: number; y: number }> | null = null;
  private disposed = false;
  private readonly decodeTile: (bytes: ArrayBuffer) => Promise<CanvasImageSource>;
  private frame: number | null = null;
  private readonly firstPresentation: Promise<void>;
  private resolveFirstPresentation: (() => void) | null = null;
  private firstInkSpan: InkPerformanceSpan | null = null;
  private readonly geometry = new SharedInkStrokeGeometry();
  private readonly inkPerformance: InkPerformanceRecorder;
  private readonly memoryReservation: InkDisposableMemoryReservation;
  private layoutRoot: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly projection: InkPreviewProjection;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private root: HTMLElement;
  private scrollContainer: HTMLElement | null;
  private stagingCanvas: HTMLCanvasElement;
  private stagingContext: CanvasRenderingContext2D;
  private readonly tileEncoder: InkPreviewTileEncoder;
  private visible = false;
  private presentationEpoch = 0;
  private viewportEpoch = 0;
  private cachedSeedTiles: readonly InkPreviewCacheTile[] = [];
  private publishingCache = false;
  private viewportCompleteSpan: InkPerformanceSpan | null = null;
  private presentedViewport: InkPreviewViewport | null = null;
  private cacheLookupSpan: InkPerformanceSpan | null = null;
  private cacheFallbackFrame: number | null = null;
  private cachePublishSpan: InkPerformanceSpan | null = null;
  private readonly workScheduler: InkWorkScheduler;

  constructor(input: {
    readonly cancelFrame?: (handle: number) => void;
    readonly cache?: InkPreviewCachePort;
    readonly cacheKey?: InkPreviewCacheKey;
    readonly decodeTile?: (bytes: ArrayBuffer) => Promise<CanvasImageSource>;
    readonly document: Document;
    readonly inkPerformance?: InkPerformanceRecorder;
    readonly layoutRoot?: HTMLElement;
    readonly memoryCoordinator?: InkGeometryCacheCoordinator;
    readonly projection: InkPreviewProjection;
    readonly requestFrame?: (callback: FrameRequestCallback) => number;
    readonly root: HTMLElement;
    readonly scrollContainer?: HTMLElement;
    readonly tileEncoder?: InkPreviewTileEncoder;
    readonly workScheduler?: InkWorkScheduler;
  }) {
    this.projection = input.projection;
    this.firstPresentation = new Promise((resolve) => {
      this.resolveFirstPresentation = resolve;
    });
    this.document = input.document;
    this.cache = input.cache ?? null;
    this.cacheKey = input.cacheKey ?? null;
    this.decodeTile = input.decodeTile ?? decodePngTile;
    this.inkPerformance = input.inkPerformance ?? NOOP_INK_PERFORMANCE_RECORDER;
    this.memoryReservation = new InkDisposableMemoryReservation(input.memoryCoordinator);
    this.workScheduler = input.workScheduler ?? new InkWorkScheduler();
    this.tileEncoder = input.tileEncoder ?? new InkPreviewTileWorkerEncoder();
    this.root = input.root;
    this.layoutRoot = input.layoutRoot ?? input.root;
    this.scrollContainer = input.scrollContainer ?? null;
    this.requestFrame = input.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = input.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    this.overlay = input.document.createElement('div');
    this.overlay.className = 'inkstone-ink-surface inkstone-ink-preview-projection';
    this.overlay.dataset.inkstoneInkPreviewProjection = this.projection.read().documentId;
    this.overlay.hidden = true;
    this.canvas = input.document.createElement('canvas');
    this.canvas.className = 'inkstone-ink-canvas inkstone-ink-canvas-preview';
    this.canvas.dataset.inkstoneInkPreviewCanvas = 'true';
    this.canvas.hidden = true;
    const context = this.canvas.getContext('2d');
    if (context === null) throw new Error('Ink Preview Canvas 2D is unavailable.');
    this.context = context;
    this.stagingCanvas = input.document.createElement('canvas');
    this.stagingCanvas.className =
      'inkstone-ink-canvas inkstone-ink-canvas-preview inkstone-ink-canvas-preview-staging';
    this.stagingCanvas.hidden = true;
    const stagingContext = this.stagingCanvas.getContext('2d');
    if (stagingContext === null) throw new Error('Ink Preview staging Canvas 2D is unavailable.');
    this.stagingContext = stagingContext;
    this.overlay.append(this.canvas, this.stagingCanvas);
    this.root.append(this.overlay);
    this.scrollContainer?.addEventListener('scroll', this.onViewportChanged, { passive: true });
    input.document.defaultView?.addEventListener('resize', this.onViewportChanged);
  }

  showPreview(): void {
    if (this.disposed) throw new Error('Cannot show a disposed Ink Preview.');
    this.visible = true;
    this.activatePreviewHost();
    this.firstInkSpan?.cancel();
    this.viewportCompleteSpan?.cancel();
    this.cacheLookupSpan?.cancel();
    if (this.cacheFallbackFrame !== null) this.cancelFrame(this.cacheFallbackFrame);
    this.cacheFallbackFrame = null;
    this.firstInkSpan = this.inkPerformance.beginSpan('ink-preview-first-ink', {
      workPhase: 'preview',
    });
    this.viewportCompleteSpan = this.inkPerformance.beginSpan('ink-preview-viewport-complete', {
      workPhase: 'preview',
    });
    const epoch = ++this.presentationEpoch;
    if (this.cache === null || this.cacheKey === null) {
      this.schedule();
      return;
    }
    this.cacheLookupSpan = this.inkPerformance.beginSpan('ink-preview-cache-lookup', {
      workPhase: 'preview',
    });
    const lookupSpan = this.cacheLookupSpan;
    let cacheSettled = false;
    let canonicalFallbackStarted = false;
    queueMicrotask(() =>
      queueMicrotask(() => {
        if (cacheSettled || this.disposed || !this.visible || epoch !== this.presentationEpoch) {
          return;
        }
        let completedSynchronously = false;
        const fallbackFrame = this.requestFrame(() => {
          completedSynchronously = true;
          if (cacheSettled || this.disposed || !this.visible || epoch !== this.presentationEpoch) {
            return;
          }
          this.cacheFallbackFrame = null;
          canonicalFallbackStarted = true;
          lookupSpan.finish({ accepted: false });
          if (this.cacheLookupSpan === lookupSpan) this.cacheLookupSpan = null;
          this.schedule();
        });
        if (!completedSynchronously) this.cacheFallbackFrame = fallbackFrame;
      }),
    );
    void this.cache.load(this.cacheKey).then(
      (hit) => {
        cacheSettled = true;
        if (this.disposed || !this.visible || epoch !== this.presentationEpoch) return;
        if (this.cacheFallbackFrame !== null) this.cancelFrame(this.cacheFallbackFrame);
        this.cacheFallbackFrame = null;
        if (canonicalFallbackStarted) {
          if (hit !== null) this.cachedSeedTiles = hit.tiles;
          return;
        }
        lookupSpan.finish({ accepted: hit !== null });
        if (this.cacheLookupSpan === lookupSpan) this.cacheLookupSpan = null;
        if (hit === null) {
          this.cachedSeedTiles = [];
          this.schedule();
          return;
        }
        void this.renderCached(hit, epoch).then((presented) => {
          if (!presented && !this.disposed && this.visible && epoch === this.presentationEpoch) {
            this.cachedSeedTiles = hit.tiles;
            this.schedule();
          }
        });
      },
      () => {
        cacheSettled = true;
        if (this.disposed || !this.visible || epoch !== this.presentationEpoch) return;
        if (this.cacheFallbackFrame !== null) this.cancelFrame(this.cacheFallbackFrame);
        this.cacheFallbackFrame = null;
        if (canonicalFallbackStarted) return;
        lookupSpan.finish({ accepted: false });
        if (this.cacheLookupSpan === lookupSpan) this.cacheLookupSpan = null;
        this.schedule();
      },
    );
  }

  whenFirstPresented(): Promise<void> {
    return this.firstPresentation;
  }

  presentationLayer(): HTMLElement {
    return this.overlay;
  }

  /** Reclaims shared host classes after an older editable presenter releases the same root. */
  reassertHostPresentation(): void {
    if (this.disposed || !this.visible) return;
    this.activatePreviewHost();
  }

  hidePreview(): void {
    this.visible = false;
    this.presentationEpoch += 1;
    this.overlay.hidden = true;
    this.cancelPreviewSpans();
    this.resolveFirstPresentation?.();
    this.resolveFirstPresentation = null;
    this.root.classList.remove('is-ink-preview');
    this.deactivateWorkspace();
  }

  coversHeight(minimumHeight: number): boolean {
    return this.projection.read().logicalHeight >= Math.ceil(minimumHeight);
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

  reattach(
    layoutRoot: HTMLElement,
    hostRoot: HTMLElement = this.root,
    scrollContainer: HTMLElement | null = this.scrollContainer,
  ): void {
    this.scrollContainer?.removeEventListener('scroll', this.onViewportChanged);
    this.layoutRoot = layoutRoot;
    this.root = hostRoot;
    this.scrollContainer = scrollContainer;
    this.scrollContainer?.addEventListener('scroll', this.onViewportChanged, { passive: true });
    this.root.append(this.overlay);
    if (this.visible) this.showPreview();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.presentationEpoch += 1;
    this.cancelPreviewSpans();
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
    this.scrollContainer?.removeEventListener('scroll', this.onViewportChanged);
    this.overlay.ownerDocument.defaultView?.removeEventListener('resize', this.onViewportChanged);
    this.hidePreview();
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.stagingCanvas.width = 0;
    this.stagingCanvas.height = 0;
    this.overlay.remove();
    this.root.classList.remove('inkstone-ink-host');
    this.memoryReservation.dispose();
    this.tileEncoder.dispose();
  }

  private readonly onViewportChanged = (): void => {
    const measured = this.measureViewport();
    this.projectPresentedViewport(measured);
    this.schedule();
  };

  private schedule(): void {
    if (this.disposed || !this.visible) return;
    this.viewportEpoch += 1;
    if (this.frame !== null) return;
    let completedSynchronously = false;
    const frame = this.requestFrame(() => {
      completedSynchronously = true;
      this.frame = null;
      void this.renderVisibleViewport(this.viewportEpoch);
    });
    if (!completedSynchronously) this.frame = frame;
  }

  private async renderVisibleViewport(viewportEpoch: number): Promise<void> {
    const viewport = this.prepareStagingViewport();
    const targetContext = this.stagingContext;
    const presentationEpoch = this.presentationEpoch;
    const query = this.projection.prepareQuery({
      height: viewport.logicalHeight,
      width: viewport.logicalWidth,
      x: viewport.logicalLeft,
      y: viewport.logicalTop,
    });
    const queryOutcome = await this.workScheduler.schedule({
      isCurrent: () => this.previewWorkIsCurrent(presentationEpoch, viewportEpoch),
      lane: 'visible',
      unitKinds: query.unitKinds,
      units: query.units,
    });
    if (queryOutcome === 'cancelled') return;
    const visible = query.result();
    this.memoryReservation.setBytes(this.projection.read().indexBytes);
    const drawUnits = visible.flatMap(({ stroke }) => {
      let compiled: ReturnType<SharedInkStrokeGeometry['compile']> | null = null;
      return [
        () => {
          compiled = this.geometry.compile(stroke);
        },
        () => {
          if (compiled?.kind !== 'exact' && compiled?.kind !== 'unpublished') return;
          drawInkBrushGeometryToCanvas(targetContext, compiled.geometry);
        },
      ];
    });
    const drawOutcome = await this.workScheduler.schedule({
      isCurrent: () => this.previewWorkIsCurrent(presentationEpoch, viewportEpoch),
      lane: 'visible',
      unitKinds: visible.flatMap(() => ['preview-geometry-compile', 'preview-canvas-draw']),
      units: drawUnits,
    });
    if (
      drawOutcome === 'cancelled' ||
      !this.previewWorkIsCurrent(presentationEpoch, viewportEpoch)
    ) {
      return;
    }
    this.presentStagingViewport(viewport);
    this.finishPreviewPresentation();
    this.scheduleCachePublication(viewport, viewportEpoch);
  }

  private scheduleCachePublication(viewport: InkPreviewViewport, viewportEpoch: number): void {
    if (
      this.cache === null ||
      this.cacheKey === null ||
      this.publishingCache ||
      typeof globalThis.OffscreenCanvas !== 'function'
    ) {
      return;
    }
    this.publishingCache = true;
    const presentationEpoch = this.presentationEpoch;
    const publishSpan = this.inkPerformance.beginSpan('ink-preview-cache-publish', {
      workPhase: 'preview',
    });
    this.cachePublishSpan = publishSpan;
    void this.publishVisibleTiles(viewport, presentationEpoch, viewportEpoch)
      .then(
        (published) => publishSpan?.finish({ accepted: published }),
        () => publishSpan?.finish({ accepted: false }),
      )
      .finally(() => {
        if (this.cachePublishSpan === publishSpan) this.cachePublishSpan = null;
        this.publishingCache = false;
      });
  }

  private async publishVisibleTiles(
    viewport: InkPreviewViewport,
    presentationEpoch: number,
    viewportEpoch: number,
  ): Promise<boolean> {
    const cache = this.cache;
    const key = this.cacheKey;
    if (cache === null || key === null) return false;
    const tileSize = key.logicalTileSize;
    const firstX = Math.floor(viewport.logicalLeft / tileSize);
    const lastX = Math.floor(
      Math.max(viewport.logicalLeft, viewport.logicalLeft + viewport.logicalWidth - 0.001) /
        tileSize,
    );
    const firstY = Math.floor(viewport.logicalTop / tileSize);
    const lastY = Math.floor(
      Math.max(viewport.logicalTop, viewport.logicalTop + viewport.logicalHeight - 0.001) /
        tileSize,
    );
    const byCoordinate = new Map(
      this.cachedSeedTiles.map((tile) => [`${tile.x}:${tile.y}`, tile] as const),
    );
    for (let y = firstY; y <= lastY; y += 1) {
      for (let x = firstX; x <= lastX; x += 1) {
        if (byCoordinate.has(`${x}:${y}`)) continue;
        const bytes = await this.renderEncodedTile(x, y, key, presentationEpoch, viewportEpoch);
        if (bytes === null) return false;
        byCoordinate.set(`${x}:${y}`, {
          byteLength: bytes.byteLength,
          bytes,
          x,
          y,
        });
      }
    }
    if (!this.previewWorkIsCurrent(presentationEpoch, viewportEpoch)) return false;
    const tiles = [...byCoordinate.values()];
    const published = await cache.publish(key, tiles);
    if (published) this.cachedSeedTiles = tiles;
    return published;
  }

  private async renderEncodedTile(
    tileX: number,
    tileY: number,
    key: InkPreviewCacheKey,
    presentationEpoch: number,
    viewportEpoch: number,
  ): Promise<ArrayBuffer | null> {
    const pixelScale = key.scaleBucket * key.devicePixelRatio;
    const canvas = createPreviewTileCanvas(
      Math.max(1, Math.ceil(key.logicalTileSize * pixelScale)),
      Math.max(1, Math.ceil(key.logicalTileSize * pixelScale)),
    );
    if (canvas === null) return null;
    const context = previewTileContext(canvas);
    if (context === null) return null;
    context.setTransform(
      pixelScale,
      0,
      0,
      pixelScale,
      -tileX * key.logicalTileSize * pixelScale,
      -tileY * key.logicalTileSize * pixelScale,
    );
    const query = this.projection.prepareQuery({
      height: key.logicalTileSize,
      width: key.logicalTileSize,
      x: tileX * key.logicalTileSize,
      y: tileY * key.logicalTileSize,
    });
    const queryOutcome = await this.workScheduler.schedule({
      isCurrent: () => this.previewWorkIsCurrent(presentationEpoch, viewportEpoch),
      lane: 'cold',
      unitKinds: query.unitKinds,
      units: query.units,
    });
    if (queryOutcome === 'cancelled') {
      canvas.width = 0;
      canvas.height = 0;
      return null;
    }
    const visible = query.result();
    this.memoryReservation.setBytes(this.projection.read().indexBytes);
    const drawUnits = visible.flatMap(({ stroke }) => {
      let compiled: ReturnType<SharedInkStrokeGeometry['compile']> | null = null;
      return [
        () => {
          compiled = this.geometry.compile(stroke);
        },
        () => {
          if (compiled?.kind === 'exact' || compiled?.kind === 'unpublished') {
            drawInkBrushGeometryToCanvas(context, compiled.geometry);
          }
        },
      ];
    });
    const drawOutcome = await this.workScheduler.schedule({
      isCurrent: () => this.previewWorkIsCurrent(presentationEpoch, viewportEpoch),
      lane: 'cold',
      unitKinds: visible.flatMap(() => ['preview-geometry-compile', 'preview-canvas-draw']),
      units: drawUnits,
    });
    if (
      drawOutcome === 'cancelled' ||
      !this.previewWorkIsCurrent(presentationEpoch, viewportEpoch)
    ) {
      canvas.width = 0;
      canvas.height = 0;
      return null;
    }
    const encoded: { bytes: ArrayBuffer | null } = { bytes: null };
    const encodeOutcome = await this.workScheduler.schedule({
      isCurrent: () => this.previewWorkIsCurrent(presentationEpoch, viewportEpoch),
      lane: 'cold',
      unitKinds: ['preview-worker-submit'],
      units: [
        async () => {
          encoded.bytes = await this.tileEncoder.encode(canvas);
        },
      ],
    });
    releasePreviewTileCanvas(canvas);
    return encodeOutcome === 'cancelled' ? null : encoded.bytes;
  }

  private async renderCached(hit: InkPreviewCacheHit, epoch: number): Promise<boolean> {
    const viewportEpoch = this.viewportEpoch;
    const viewport = this.measureViewport();
    const tileSize = this.cacheKey?.logicalTileSize;
    if (tileSize === undefined) return false;
    const tileByCoordinate = new Map(hit.tiles.map((tile) => [`${tile.x}:${tile.y}`, tile]));
    const firstX = Math.floor(viewport.logicalLeft / tileSize);
    const lastX = Math.floor(
      Math.max(viewport.logicalLeft, viewport.logicalLeft + viewport.logicalWidth - 0.001) /
        tileSize,
    );
    const firstY = Math.floor(viewport.logicalTop / tileSize);
    const lastY = Math.floor(
      Math.max(viewport.logicalTop, viewport.logicalTop + viewport.logicalHeight - 0.001) /
        tileSize,
    );
    const required = [];
    for (let y = firstY; y <= lastY; y += 1) {
      for (let x = firstX; x <= lastX; x += 1) {
        const tile = tileByCoordinate.get(`${x}:${y}`);
        if (tile === undefined) return false;
        required.push(tile);
      }
    }
    const outcomes = await Promise.all(
      required.map(({ bytes }) =>
        this.decodeTile(bytes).then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        ),
      ),
    );
    const decoded = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.value] : []));
    if (decoded.length !== required.length) {
      for (const source of decoded) releaseCanvasImageSource(source);
      return false;
    }
    try {
      if (!this.previewWorkIsCurrent(epoch, viewportEpoch)) return false;
      this.prepareStagingViewport(viewport);
      const targetContext = this.stagingContext;
      for (const [index, tile] of required.entries()) {
        const bitmap = decoded[index];
        if (bitmap === undefined) continue;
        targetContext.drawImage(bitmap, tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
      }
      this.presentStagingViewport(viewport);
      this.finishPreviewPresentation();
      return true;
    } finally {
      for (const source of decoded) releaseCanvasImageSource(source);
    }
  }

  private finishPreviewPresentation(): void {
    this.finishFirstInkPresentation();
    this.viewportCompleteSpan?.finish({ accepted: true });
    this.viewportCompleteSpan = null;
    this.resolveFirstPresentation?.();
    this.resolveFirstPresentation = null;
  }

  private finishFirstInkPresentation(): void {
    this.firstInkSpan?.finish({ accepted: true });
    this.firstInkSpan = null;
  }

  private previewWorkIsCurrent(presentationEpoch: number, viewportEpoch: number): boolean {
    return (
      !this.disposed &&
      this.visible &&
      presentationEpoch === this.presentationEpoch &&
      viewportEpoch === this.viewportEpoch
    );
  }

  private activatePreviewHost(): void {
    const read = this.projection.read();
    this.overlay.hidden = false;
    this.root.classList.add('inkstone-ink-host', 'is-ink-preview');
    this.layoutRoot.classList.add('inkstone-ink-workspace');
    this.layoutRoot.style.setProperty('--inkstone-ink-logical-width', `${read.logicalWidth}px`);
    this.layoutRoot.style.setProperty('--inkstone-ink-logical-height', `${read.logicalHeight}px`);
    this.layoutRoot.style.setProperty('--inkstone-ink-scale', '1');
  }

  private cancelPreviewSpans(): void {
    if (this.cacheFallbackFrame !== null) this.cancelFrame(this.cacheFallbackFrame);
    this.cacheFallbackFrame = null;
    this.cacheLookupSpan?.cancel();
    this.cacheLookupSpan = null;
    this.cachePublishSpan?.cancel();
    this.cachePublishSpan = null;
    this.firstInkSpan?.cancel();
    this.firstInkSpan = null;
    this.viewportCompleteSpan?.cancel();
    this.viewportCompleteSpan = null;
  }

  private prepareStagingViewport(
    measured: InkPreviewViewport = this.measureViewport(),
  ): InkPreviewViewport {
    const canvas = this.stagingCanvas;
    const context = this.stagingContext;
    if (canvas.width !== measured.backingWidth) canvas.width = measured.backingWidth;
    if (canvas.height !== measured.backingHeight) canvas.height = measured.backingHeight;
    this.positionAndMeasureOverlay(measured.left, measured.top, measured.width, measured.height);
    canvas.style.width = `${measured.width}px`;
    canvas.style.height = `${measured.height}px`;
    canvas.style.transform = '';
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, measured.backingWidth, measured.backingHeight);
    context.setTransform(
      measured.dpr * measured.scale,
      0,
      0,
      measured.dpr * measured.scale,
      -measured.logicalLeft * measured.dpr * measured.scale,
      -measured.logicalTop * measured.dpr * measured.scale,
    );
    return measured;
  }

  private presentStagingViewport(viewport: InkPreviewViewport): void {
    const previousCanvas = this.canvas;
    const previousContext = this.context;
    previousCanvas.hidden = true;
    previousCanvas.style.transform = '';
    delete previousCanvas.dataset.inkstoneInkPreviewCanvas;
    this.stagingCanvas.hidden = false;
    this.stagingCanvas.dataset.inkstoneInkPreviewCanvas = 'true';
    this.canvas = this.stagingCanvas;
    this.context = this.stagingContext;
    this.stagingCanvas = previousCanvas;
    this.stagingContext = previousContext;
    this.presentedViewport = viewport;
  }

  private projectPresentedViewport(next: InkPreviewViewport): void {
    const presented = this.presentedViewport;
    if (presented === null || this.canvas.hidden) return;
    if (Math.abs(presented.scale - next.scale) > 1e-6) return;
    const translateX = (presented.logicalLeft - next.logicalLeft) * next.scale;
    const translateY = (presented.logicalTop - next.logicalTop) * next.scale;
    this.canvas.style.transformOrigin = '0 0';
    this.canvas.style.transform = `translate3d(${translateX}px, ${translateY}px, 0)`;
    this.canvas.style.willChange = 'transform';
  }

  private positionAndMeasureOverlay(
    targetLeft: number,
    targetTop: number,
    width: number,
    height: number,
  ): void {
    this.overlay.style.left = `${targetLeft}px`;
    this.overlay.style.top = `${targetTop}px`;
    this.overlay.style.width = `${width}px`;
    this.overlay.style.height = `${height}px`;
    if (this.overlay.hidden) return;

    // A transformed ancestor makes WebKit resolve a fixed descendant against that containing
    // block. CSS `top`/`left` are then not client-space coordinates. Measure the actual box and
    // converge on the requested client-space origin before any canonical pixels are presented.
    for (let pass = 0; pass < 2; pass += 1) {
      const actual = this.overlay.getBoundingClientRect();
      const localWidth = cssPixels(this.overlay.style.width);
      const localHeight = cssPixels(this.overlay.style.height);
      if (actual.width <= 0 || actual.height <= 0 || localWidth <= 0 || localHeight <= 0) break;
      const scaleX = actual.width / localWidth;
      const scaleY = actual.height / localHeight;
      const deltaX = targetLeft - actual.left;
      const deltaY = targetTop - actual.top;
      if (Math.abs(deltaX) <= 1 / 64 && Math.abs(deltaY) <= 1 / 64) break;
      this.overlay.style.left = `${cssPixels(this.overlay.style.left) + deltaX / scaleX}px`;
      this.overlay.style.top = `${cssPixels(this.overlay.style.top) + deltaY / scaleY}px`;
    }
  }

  private measureViewport(): InkPreviewViewport {
    const read = this.projection.read();
    const layout = this.layoutRoot.getBoundingClientRect();
    const pane = this.scrollContainer?.getBoundingClientRect() ?? this.root.getBoundingClientRect();
    const scale = layout.width > 0 ? layout.width / read.logicalWidth : 1;
    const documentOriginInset = this.documentOriginInset ??
      this.captureDocumentOriginInset(scale) ?? { x: 0, y: 0 };
    this.documentOriginInset = documentOriginInset;
    const left = pane.left + (this.scrollContainer?.clientLeft ?? 0);
    const top = pane.top + (this.scrollContainer?.clientTop ?? 0);
    const width = Math.max(
      1,
      this.scrollContainer?.clientWidth || pane.width || read.logicalWidth * scale,
    );
    const height = Math.max(
      1,
      this.scrollContainer?.clientHeight || pane.height || read.logicalHeight * scale,
    );
    const dpr = Math.max(
      1,
      Math.min(4, this.overlay.ownerDocument.defaultView?.devicePixelRatio ?? 1),
    );
    const backingWidth = Math.max(1, Math.ceil(width * dpr));
    const backingHeight = Math.max(1, Math.ceil(height * dpr));
    const documentLeft = layout.left + documentOriginInset.x * scale;
    const documentTop = layout.top + documentOriginInset.y * scale;
    const logicalLeft = (left - documentLeft) / scale;
    const logicalTop = (top - documentTop) / scale;
    return {
      backingHeight,
      backingWidth,
      dpr,
      height,
      left,
      logicalHeight: height / scale,
      logicalLeft,
      logicalTop,
      logicalWidth: width / scale,
      scale,
      top,
      width,
    };
  }

  private captureDocumentOriginInset(scale: number): Readonly<{ x: number; y: number }> | null {
    if (this.scrollContainer === null) return Object.freeze({ x: 0, y: 0 });
    const previous = {
      height: this.overlay.style.height,
      hidden: this.overlay.hidden,
      left: this.overlay.style.left,
      top: this.overlay.style.top,
      width: this.overlay.style.width,
    };
    try {
      const read = this.projection.read();
      const host = this.root.getBoundingClientRect();
      const pane = this.scrollContainer.getBoundingClientRect();
      const paneWidth = Math.max(
        1,
        this.scrollContainer.clientWidth || pane.width || read.logicalWidth * scale,
      );
      const paneHeight = Math.max(
        1,
        this.scrollContainer.clientHeight || pane.height || read.logicalHeight * scale,
      );
      this.overlay.hidden = false;
      this.overlay.style.left = `${pane.left - host.left}px`;
      this.overlay.style.top = `${pane.top - host.top}px`;
      this.overlay.style.width = `${paneWidth}px`;
      this.overlay.style.height = `${paneHeight}px`;
      const fixed = this.overlay.getBoundingClientRect();
      const localWidth = cssPixels(this.overlay.style.width);
      const localHeight = cssPixels(this.overlay.style.height);
      if (
        pane.width <= 0 ||
        pane.height <= 0 ||
        fixed.width <= 0 ||
        fixed.height <= 0 ||
        localWidth <= 0 ||
        localHeight <= 0
      ) {
        return null;
      }
      const containingBlockScaleX = fixed.width / localWidth;
      const containingBlockScaleY = fixed.height / localHeight;
      return Object.freeze({
        x: (fixed.left - pane.left) / (containingBlockScaleX > 0 ? containingBlockScaleX : 1),
        y: (fixed.top - pane.top) / (containingBlockScaleY > 0 ? containingBlockScaleY : 1),
      });
    } finally {
      this.overlay.style.left = previous.left;
      this.overlay.style.top = previous.top;
      this.overlay.style.width = previous.width;
      this.overlay.style.height = previous.height;
      this.overlay.hidden = previous.hidden;
    }
  }

  private deactivateWorkspace(): void {
    this.layoutRoot.classList.remove('inkstone-ink-workspace');
    this.layoutRoot.style.removeProperty('--inkstone-ink-logical-width');
    this.layoutRoot.style.removeProperty('--inkstone-ink-logical-height');
    this.layoutRoot.style.removeProperty('--inkstone-ink-scale');
  }
}

async function decodePngTile(bytes: ArrayBuffer): Promise<CanvasImageSource> {
  if (typeof globalThis.createImageBitmap !== 'function') {
    throw new Error('ImageBitmap decoding is unavailable.');
  }
  return globalThis.createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}

function releaseCanvasImageSource(source: CanvasImageSource): void {
  if (isCloseableCanvasImageSource(source)) source.close();
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isCloseableCanvasImageSource(
  source: CanvasImageSource,
): source is CanvasImageSource & { close(): void } {
  return typeof (source as { readonly close?: unknown }).close === 'function';
}

function createPreviewTileCanvas(width: number, height: number): OffscreenCanvas | null {
  return typeof globalThis.OffscreenCanvas === 'function'
    ? new globalThis.OffscreenCanvas(width, height)
    : null;
}

function previewTileContext(canvas: OffscreenCanvas): CanvasRenderingContext2D | null {
  return canvas.getContext('2d') as unknown as CanvasRenderingContext2D | null;
}

function releasePreviewTileCanvas(canvas: OffscreenCanvas): void {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // A transferred OffscreenCanvas is already detached from the main thread.
  }
}
