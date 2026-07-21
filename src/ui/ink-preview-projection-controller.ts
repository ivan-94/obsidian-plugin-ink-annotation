import type { InkPreviewProjection } from '../application/ink-preview-projection';
import { SharedInkStrokeGeometry } from '../domain/ink-shared-stroke-geometry';
import { InkViewportDemandPlanner } from '../domain/ink-viewport-demand-planner';
import {
  createInkNoteLogicalRect,
  InkWorldTileGrid,
  type InkWorldTileCoordinate,
} from '../domain/ink-world-tile-grid';
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
  InkPreviewCacheTileCoordinate,
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
import { InkPreviewSeedBufferCache } from './ink-preview-seed-buffer-cache';
import { InkMainThreadTileBuilder } from './ink-main-thread-tile-builder';
import { InkRetainedTileScene } from './ink-retained-tile-scene';
import { InkViewportPresentationTransaction } from './ink-viewport-presentation-transaction';

type InkPreviewCachePort = Pick<IndexedDbInkPreviewCache, 'publish'> &
  Partial<Pick<IndexedDbInkPreviewCache, 'load' | 'loadRegion' | 'publishCompleteTiles'>>;

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

interface InkPreviewTileDemand {
  readonly all: readonly InkPreviewCacheTileCoordinate[];
  readonly exact: readonly InkPreviewCacheTileCoordinate[];
  readonly visible: readonly InkPreviewCacheTileCoordinate[];
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
  private readonly retainedSceneKeys = new Map<string, string>();
  private readonly retainedScene: InkRetainedTileScene;
  private root: HTMLElement;
  private scrollContainer: HTMLElement | null;
  private stagingCanvas: HTMLCanvasElement;
  private stagingContext: CanvasRenderingContext2D;
  private readonly tileBuilder: InkMainThreadTileBuilder;
  private readonly tileEncoder: InkPreviewTileEncoder;
  private visible = false;
  private presentationEpoch = 0;
  private viewportEpoch = 0;
  private readonly seedBuffers: InkPreviewSeedBufferCache;
  private publishingCache = false;
  private canonicalPrefetchRun = 0;
  private viewportCompleteSpan: InkPerformanceSpan | null = null;
  private presentedViewport: InkPreviewViewport | null = null;
  private cacheLookupSpan: InkPerformanceSpan | null = null;
  private cacheFallbackFrame: number | null = null;
  private cachePublishSpan: InkPerformanceSpan | null = null;
  private readonly workScheduler: InkWorkScheduler;
  private readonly demandPlanner: InkViewportDemandPlanner;
  private readonly tileGrid: InkWorldTileGrid;
  private readonly viewportTransaction = new InkViewportPresentationTransaction({
    hysteresisRatio: 0.1,
    maximumLod: 4,
    minimumLod: -4,
  });
  private scheduledCacheLookup = false;

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
    this.tileGrid = new InkWorldTileGrid({
      baseWorldSpan: input.cacheKey?.logicalTileSize ?? 512,
    });
    this.demandPlanner = new InkViewportDemandPlanner({
      grid: this.tileGrid,
      lookAheadRings: 1,
      nearVisibleRings: 1,
    });
    this.decodeTile = input.decodeTile ?? decodePngTile;
    this.inkPerformance = input.inkPerformance ?? NOOP_INK_PERFORMANCE_RECORDER;
    this.memoryReservation = new InkDisposableMemoryReservation(input.memoryCoordinator);
    this.seedBuffers = new InkPreviewSeedBufferCache(input.memoryCoordinator);
    this.workScheduler = input.workScheduler ?? new InkWorkScheduler();
    this.tileBuilder = new InkMainThreadTileBuilder({
      document: input.document,
      scheduler: this.workScheduler,
      ...(input.memoryCoordinator === undefined
        ? {}
        : { memoryCoordinator: input.memoryCoordinator }),
    });
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
    this.retainedScene = new InkRetainedTileScene({
      document: input.document,
      host: this.overlay,
      maximumNodeCount: 64,
      ...(input.memoryCoordinator === undefined
        ? {}
        : { memoryCoordinator: input.memoryCoordinator }),
    });
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
          this.schedule();
        });
        if (!completedSynchronously) this.cacheFallbackFrame = fallbackFrame;
      }),
    );
    const demandedCoordinates = this.previewTileDemand(this.measureViewport()).all;
    const cacheLoad =
      this.cache.loadRegion?.(this.cacheKey, demandedCoordinates) ??
      this.cache.load?.(this.cacheKey) ??
      Promise.resolve(null);
    void cacheLoad.then(
      (hit) => {
        cacheSettled = true;
        if (this.disposed || !this.visible || epoch !== this.presentationEpoch) return;
        if (this.cacheFallbackFrame !== null) this.cancelFrame(this.cacheFallbackFrame);
        this.cacheFallbackFrame = null;
        lookupSpan.finish({ accepted: hit !== null });
        if (this.cacheLookupSpan === lookupSpan) this.cacheLookupSpan = null;
        if (hit === null) {
          this.seedBuffers.replace([]);
          if (!canonicalFallbackStarted) this.schedule();
          return;
        }
        this.seedBuffers.replace(hit.tiles);
        void this.renderCached(hit, epoch).then((presented) => {
          if (!presented && !this.disposed && this.visible && epoch === this.presentationEpoch) {
            this.seedBuffers.replace(hit.tiles);
            if (!canonicalFallbackStarted) this.schedule();
          }
        });
      },
      () => {
        cacheSettled = true;
        if (this.disposed || !this.visible || epoch !== this.presentationEpoch) return;
        if (this.cacheFallbackFrame !== null) this.cancelFrame(this.cacheFallbackFrame);
        this.cacheFallbackFrame = null;
        lookupSpan.finish({ accepted: false });
        if (this.cacheLookupSpan === lookupSpan) this.cacheLookupSpan = null;
        if (!canonicalFallbackStarted) this.schedule();
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
    this.canonicalPrefetchRun += 1;
    this.overlay.hidden = true;
    this.retainedScene.hide();
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
    this.canonicalPrefetchRun += 1;
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
    this.seedBuffers.dispose();
    this.retainedScene.dispose();
    this.tileBuilder.dispose();
    this.tileEncoder.dispose();
  }

  private readonly onViewportChanged = (): void => {
    const measured = this.measureViewport();
    this.projectPresentedViewport(measured);
    this.schedule(true);
  };

  private schedule(cacheFirst = false): void {
    if (this.disposed || !this.visible) return;
    if (cacheFirst) this.scheduledCacheLookup = true;
    this.viewportEpoch += 1;
    if (this.frame !== null) return;
    let completedSynchronously = false;
    const frame = this.requestFrame(() => {
      completedSynchronously = true;
      this.frame = null;
      const lookupCache = this.scheduledCacheLookup;
      this.scheduledCacheLookup = false;
      void this.renderVisibleViewport(this.viewportEpoch, lookupCache);
    });
    if (!completedSynchronously) this.frame = frame;
  }

  private async renderVisibleViewport(viewportEpoch: number, lookupCache: boolean): Promise<void> {
    const presentationEpoch = this.presentationEpoch;
    if (
      lookupCache &&
      this.cache !== null &&
      this.cacheKey !== null &&
      this.cache.loadRegion !== undefined
    ) {
      const measured = this.measureViewport();
      const pendingHit = this.cache.loadRegion(this.cacheKey, this.previewTileDemand(measured).all);
      const cacheOutcome = await this.cacheRegionBeforeNextFrame(pendingHit);
      if (cacheOutcome.kind === 'deadline') {
        void pendingHit.then(
          (lateHit) => {
            if (lateHit !== null) {
              this.seedBuffers.merge(lateHit.tiles);
            }
          },
          () => undefined,
        );
      }
      if (!this.previewWorkIsCurrent(presentationEpoch, viewportEpoch)) return;
      if (
        cacheOutcome.kind === 'settled' &&
        cacheOutcome.hit !== null &&
        (await this.renderCached(cacheOutcome.hit, presentationEpoch))
      ) {
        this.seedBuffers.merge(cacheOutcome.hit.tiles);
        return;
      }
    }
    const tiledViewport = this.measureViewport();
    if (await this.renderCanonicalVisibleTiles(tiledViewport, presentationEpoch, viewportEpoch)) {
      return;
    }
    if (!this.previewWorkIsCurrent(presentationEpoch, viewportEpoch)) return;
    const viewport = this.prepareStagingViewport();
    const targetContext = this.stagingContext;
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

  private async renderCanonicalVisibleTiles(
    viewport: InkPreviewViewport,
    presentationEpoch: number,
    viewportEpoch: number,
  ): Promise<boolean> {
    const plan = this.demandPlanner.plan({
      lod: this.targetTileLod(viewport),
      viewport: previewLogicalRect(viewport),
    });
    if (plan.kind === 'untileable-range' || plan.visible.length === 0) return false;
    this.positionAndMeasureOverlay(viewport.left, viewport.top, viewport.width, viewport.height);
    for (const coordinate of plan.visible) {
      const identity = previewCoordinateIdentity(coordinate.lod, coordinate.column, coordinate.row);
      if (this.hasRetainedCoordinate(coordinate)) continue;
      const adoptedKey = await this.buildCanonicalTile(
        coordinate,
        viewport,
        presentationEpoch,
        viewportEpoch,
        'visible',
      );
      if (adoptedKey === null) return false;
      this.retainedSceneKeys.set(identity, adoptedKey);
      this.retainedScene.project(retainedTileCamera(viewport));
    }
    if (!this.previewWorkIsCurrent(presentationEpoch, viewportEpoch)) return false;
    const complete = plan.visible.every((coordinate) => this.hasRetainedCoordinate(coordinate));
    if (!complete) return false;
    this.retainedScene.presentOnly(
      new Set(
        plan.visible.flatMap((coordinate) => {
          const key = this.retainedSceneKey(coordinate);
          return key === null ? [] : [key];
        }),
      ),
    );
    this.canvas.hidden = true;
    this.stagingCanvas.hidden = true;
    this.retainedScene.project(retainedTileCamera(viewport));
    this.presentedViewport = viewport;
    this.viewportTransaction.accept({
      cameraEpoch: viewportEpoch,
      coverage: 'exact',
      projectionIdentity: this.projection.read().documentId,
    });
    this.finishPreviewPresentation();
    this.scheduleCachePublication(viewport, viewportEpoch);
    this.scheduleCanonicalPrefetch(
      [...plan.nearVisible, ...plan.lookAhead],
      viewport,
      presentationEpoch,
      viewportEpoch,
    );
    return true;
  }

  private async buildCanonicalTile(
    coordinate: InkWorldTileCoordinate,
    viewport: InkPreviewViewport,
    presentationEpoch: number,
    viewportEpoch: number,
    lane: 'cold' | 'visible',
  ): Promise<string | null> {
    const bounds = this.tileGrid.nominalBounds(coordinate);
    const density = Math.max(1, Math.min(4, viewport.dpr * viewport.scale));
    const key = `canonical:${this.projection.read().documentId}:${coordinate.lod}:${coordinate.column}:${coordinate.row}`;
    const result = await this.tileBuilder.build({
      backingHeight: Math.max(1, Math.ceil(bounds.height * density)),
      backingWidth: Math.max(1, Math.ceil(bounds.width * density)),
      bounds,
      createDrawPlan: (context, visible) => {
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
        return {
          unitKinds: visible.flatMap(() => ['preview-geometry-compile', 'preview-canvas-draw']),
          units: drawUnits,
        };
      },
      density,
      isCurrent: () => this.previewWorkIsCurrent(presentationEpoch, viewportEpoch),
      key,
      lane,
      prepareQuery: () => this.projection.prepareQuery(bounds),
    });
    if (result === null) return null;
    const adopted = this.retainedScene.adopt({
      backingHeight: result.canvas.height,
      backingWidth: result.canvas.width,
      key,
      logicalBounds: bounds,
      presented: lane === 'visible' && !this.retainedScene.hasPresentation,
      source: result.canvas,
    });
    result.canvas.width = 0;
    result.canvas.height = 0;
    return adopted ? key : null;
  }

  private scheduleCanonicalPrefetch(
    coordinates: readonly InkWorldTileCoordinate[],
    viewport: InkPreviewViewport,
    presentationEpoch: number,
    viewportEpoch: number,
  ): void {
    const run = ++this.canonicalPrefetchRun;
    void (async () => {
      for (const coordinate of coordinates) {
        if (
          run !== this.canonicalPrefetchRun ||
          !this.previewWorkIsCurrent(presentationEpoch, viewportEpoch)
        ) {
          return;
        }
        if (this.hasRetainedCoordinate(coordinate)) continue;
        const adoptedKey = await this.buildCanonicalTile(
          coordinate,
          viewport,
          presentationEpoch,
          viewportEpoch,
          'cold',
        );
        if (adoptedKey === null) return;
        this.retainedSceneKeys.set(
          previewCoordinateIdentity(coordinate.lod, coordinate.column, coordinate.row),
          adoptedKey,
        );
      }
    })().catch(() => undefined);
  }

  private cacheRegionBeforeNextFrame(
    pending: Promise<InkPreviewCacheHit | null>,
  ): Promise<
    | { readonly hit: InkPreviewCacheHit | null; readonly kind: 'settled' }
    | { readonly kind: 'deadline' }
  > {
    return new Promise((resolve) => {
      let finished = false;
      let deadlineHandle: number | null = null;
      const finish = (
        outcome:
          | { readonly hit: InkPreviewCacheHit | null; readonly kind: 'settled' }
          | { readonly kind: 'deadline' },
      ): void => {
        if (finished) return;
        finished = true;
        if (deadlineHandle !== null) this.cancelFrame(deadlineHandle);
        resolve(outcome);
      };
      void pending.then(
        (hit) => finish({ hit, kind: 'settled' }),
        () => finish({ hit: null, kind: 'settled' }),
      );
      let completedSynchronously = false;
      const handle = this.requestFrame(() => {
        completedSynchronously = true;
        finish({ kind: 'deadline' });
      });
      if (!completedSynchronously && !finished) deadlineHandle = handle;
    });
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
    const lod = this.targetTileLod(viewport);
    const tileSize = key.logicalTileSize / 2 ** lod;
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
      this.seedBuffers
        .snapshot()
        .map((tile) => [previewCoordinateIdentity(tile.lod, tile.x, tile.y), tile] as const),
    );
    const completedTiles: InkPreviewCacheTile[] = [];
    for (let y = firstY; y <= lastY; y += 1) {
      for (let x = firstX; x <= lastX; x += 1) {
        const identity = previewCoordinateIdentity(lod, x, y);
        if (byCoordinate.has(identity)) continue;
        const bytes = await this.renderEncodedTile(
          lod,
          x,
          y,
          key,
          presentationEpoch,
          viewportEpoch,
        );
        if (bytes === null) return false;
        const completed = {
          byteLength: bytes.byteLength,
          bytes,
          lod,
          x,
          y,
        };
        byCoordinate.set(identity, completed);
        completedTiles.push(completed);
      }
    }
    if (!this.previewWorkIsCurrent(presentationEpoch, viewportEpoch)) return false;
    if (completedTiles.length === 0) return true;
    const tiles = [...byCoordinate.values()];
    const published =
      cache.publishCompleteTiles === undefined
        ? await cache.publish(key, tiles)
        : await cache.publishCompleteTiles(key, completedTiles);
    if (published) this.seedBuffers.replace(tiles);
    return published;
  }

  private async renderEncodedTile(
    lod: number,
    tileX: number,
    tileY: number,
    key: InkPreviewCacheKey,
    presentationEpoch: number,
    viewportEpoch: number,
  ): Promise<ArrayBuffer | null> {
    const pixelScale = key.scaleBucket * key.devicePixelRatio;
    const logicalTileSize = key.logicalTileSize / 2 ** lod;
    const canvas = createPreviewTileCanvas(
      Math.max(1, Math.ceil(logicalTileSize * pixelScale)),
      Math.max(1, Math.ceil(logicalTileSize * pixelScale)),
    );
    if (canvas === null) return null;
    const context = previewTileContext(canvas);
    if (context === null) return null;
    context.setTransform(
      pixelScale,
      0,
      0,
      pixelScale,
      -tileX * logicalTileSize * pixelScale,
      -tileY * logicalTileSize * pixelScale,
    );
    const query = this.projection.prepareQuery({
      height: logicalTileSize,
      width: logicalTileSize,
      x: tileX * logicalTileSize,
      y: tileY * logicalTileSize,
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
    const demand = this.previewTileDemand(viewport);
    const required = hit.tiles.filter(
      ({ lod, x, y }) => !this.hasRetainedCoordinate({ column: x, lod, row: y }),
    );
    const outcomes = await Promise.all(
      required.map((tile) =>
        this.decodeTile(tile.bytes).then(
          (source) => ({ ok: true as const, source, tile }),
          () => ({ ok: false as const, tile }),
        ),
      ),
    );
    const decoded = outcomes.flatMap((outcome) =>
      outcome.ok ? [{ source: outcome.source, tile: outcome.tile }] : [],
    );
    try {
      if (!this.previewWorkIsCurrent(epoch, viewportEpoch)) return false;
      this.positionAndMeasureOverlay(viewport.left, viewport.top, viewport.width, viewport.height);
      for (const { source, tile } of decoded) {
        const bounds = this.tileGrid.nominalBounds({
          column: tile.x,
          lod: tile.lod,
          row: tile.y,
        });
        if (
          !this.retainedScene.adopt({
            backingHeight: Math.max(
              1,
              Math.ceil(
                bounds.height *
                  (this.cacheKey?.scaleBucket ?? 1) *
                  (this.cacheKey?.devicePixelRatio ?? 1),
              ),
            ),
            backingWidth: Math.max(
              1,
              Math.ceil(
                bounds.width *
                  (this.cacheKey?.scaleBucket ?? 1) *
                  (this.cacheKey?.devicePixelRatio ?? 1),
              ),
            ),
            key: `${hit.generation}:${tile.lod}:${tile.x}:${tile.y}`,
            logicalBounds: bounds,
            presented: false,
            source,
          })
        ) {
          continue;
        }
        const identity = previewCoordinateIdentity(tile.lod, tile.x, tile.y);
        const sceneKey = `${hit.generation}:${tile.lod}:${tile.x}:${tile.y}`;
        this.retainedSceneKeys.set(identity, sceneKey);
      }
      const visibleComplete = demand.visible.every((coordinate) =>
        this.hasRetainedCoordinateOrParent(coordinate),
      );
      if (!visibleComplete) return false;
      this.retainedScene.presentOnly(this.bestRetainedCoverage(demand.exact));
      this.canvas.hidden = true;
      this.stagingCanvas.hidden = true;
      this.retainedScene.project(retainedTileCamera(viewport));
      this.presentedViewport = viewport;
      this.viewportTransaction.accept({
        cameraEpoch: viewportEpoch,
        coverage: demand.visible.every(({ lod, x, y }) =>
          this.hasRetainedCoordinate({ column: x, lod, row: y }),
        )
          ? 'exact'
          : 'fallback',
        projectionIdentity: this.projection.read().documentId,
      });
      this.finishPreviewPresentation();
      if (
        !demand.visible.every(({ lod, x, y }) =>
          this.hasRetainedCoordinate({ column: x, lod, row: y }),
        )
      ) {
        this.schedule();
      }
      return true;
    } finally {
      for (const { source } of decoded) releaseCanvasImageSource(source);
    }
  }

  private previewTileDemand(viewport: InkPreviewViewport): InkPreviewTileDemand {
    const plan = this.demandPlanner.plan({
      lod: this.targetTileLod(viewport),
      ...(this.presentedViewport === null
        ? {}
        : { previousViewport: previewLogicalRect(this.presentedViewport) }),
      viewport: previewLogicalRect(viewport),
    });
    if (plan.kind === 'untileable-range') {
      return Object.freeze({
        all: Object.freeze([]),
        exact: Object.freeze([]),
        visible: Object.freeze([]),
      });
    }
    const visible = plan.visible.map(previewStorageCoordinate);
    const exact = [...plan.visible, ...plan.nearVisible, ...plan.lookAhead];
    const parents = exact.map((coordinate) => this.tileGrid.parent(coordinate));
    return Object.freeze({
      all: Object.freeze(
        uniquePreviewCoordinates([...exact, ...parents].map(previewStorageCoordinate)),
      ),
      exact: Object.freeze(exact.map(previewStorageCoordinate)),
      visible: Object.freeze(visible),
    });
  }

  private hasRetainedCoordinate(coordinate: InkWorldTileCoordinate): boolean {
    return this.retainedSceneKey(coordinate) !== null;
  }

  private hasRetainedCoordinateOrParent(coordinate: InkPreviewCacheTileCoordinate): boolean {
    const exact = { column: coordinate.x, lod: coordinate.lod, row: coordinate.y };
    return (
      this.hasRetainedCoordinate(exact) || this.hasRetainedCoordinate(this.tileGrid.parent(exact))
    );
  }

  private retainedSceneKey(coordinate: InkWorldTileCoordinate): string | null {
    const identity = previewCoordinateIdentity(coordinate.lod, coordinate.column, coordinate.row);
    const key = this.retainedSceneKeys.get(identity);
    return key !== undefined && this.retainedScene.has(key) ? key : null;
  }

  private bestRetainedCoverage(
    exact: readonly InkPreviewCacheTileCoordinate[],
  ): ReadonlySet<string> {
    const groups = new Map<
      string,
      { readonly parent: InkWorldTileCoordinate; readonly children: InkWorldTileCoordinate[] }
    >();
    for (const coordinate of exact) {
      const child = { column: coordinate.x, lod: coordinate.lod, row: coordinate.y };
      const parent = this.tileGrid.parent(child);
      const parentIdentity = previewCoordinateIdentity(parent.lod, parent.column, parent.row);
      const group = groups.get(parentIdentity);
      if (group === undefined) groups.set(parentIdentity, { children: [child], parent });
      else group.children.push(child);
    }
    const selected = new Set<string>();
    for (const { children, parent } of groups.values()) {
      const childKeys = children.map((child) => this.retainedSceneKey(child));
      if (childKeys.every((key): key is string => key !== null)) {
        for (const key of childKeys) selected.add(key);
        continue;
      }
      const parentKey = this.retainedSceneKey(parent);
      if (parentKey !== null) {
        selected.add(parentKey);
        continue;
      }
      for (const key of childKeys) if (key !== null) selected.add(key);
    }
    return selected;
  }

  private targetTileLod(viewport: InkPreviewViewport): number {
    return this.viewportTransaction.request({
      camera: {
        devicePixelRatio: viewport.dpr,
        logicalLeft: viewport.logicalLeft,
        logicalTop: viewport.logicalTop,
        scale: viewport.scale,
      },
      motion:
        this.presentedViewport === null
          ? 'mount'
          : Math.abs(this.presentedViewport.scale - viewport.scale) > 1e-6
            ? 'zoom'
            : 'settled',
      projectionIdentity: this.projection.read().documentId,
      stageFrameEpoch: this.viewportEpoch,
    }).targetLod;
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
    this.retainedScene.hide();
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
    if (this.retainedScene.hasPresentation) {
      this.retainedScene.project(retainedTileCamera(next));
      return;
    }
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

function previewLogicalRect(viewport: InkPreviewViewport) {
  return createInkNoteLogicalRect({
    height: viewport.logicalHeight,
    width: viewport.logicalWidth,
    x: viewport.logicalLeft,
    y: viewport.logicalTop,
  });
}

function previewStorageCoordinate(
  coordinate: InkWorldTileCoordinate,
): InkPreviewCacheTileCoordinate {
  return Object.freeze({ lod: coordinate.lod, x: coordinate.column, y: coordinate.row });
}

function previewCoordinateIdentity(lod: number, x: number, y: number): string {
  return `${lod}:${x}:${y}`;
}

function uniquePreviewCoordinates(
  coordinates: readonly InkPreviewCacheTileCoordinate[],
): readonly InkPreviewCacheTileCoordinate[] {
  const unique = new Map<string, InkPreviewCacheTileCoordinate>();
  for (const coordinate of coordinates) {
    unique.set(previewCoordinateIdentity(coordinate.lod, coordinate.x, coordinate.y), coordinate);
  }
  return Object.freeze([...unique.values()]);
}

function retainedTileCamera(viewport: InkPreviewViewport): {
  readonly height: number;
  readonly logicalLeft: number;
  readonly logicalTop: number;
  readonly scale: number;
  readonly width: number;
} {
  return Object.freeze({
    height: viewport.height,
    logicalLeft: viewport.logicalLeft,
    logicalTop: viewport.logicalTop,
    scale: viewport.scale,
    width: viewport.width,
  });
}
