import type {
  InkDocumentChange,
  InkDocumentReadView,
  InkLogicalRect,
  InkRenderableStrokeRef,
} from '../application/ink-document-session';
import type {
  InkBorrowedControlTraceDelta,
  InkLegacyTraceDelta,
} from '../domain/ink-control-trace';
import {
  INK_SAMPLE_FLAGS,
  type InkContactStyleSnapshot,
  type InkSampleCursor,
} from '../domain/ink-contact';
import {
  LegacyRoundInkStrokeGeometry,
  legacyGeometryCacheKey,
  unionBounds,
  type CompiledInkStroke,
  type InkActivePresentationSession,
  type InkActivePresentationState,
  type InkActivePresentationWriter,
  type InkGeometryBounds,
  type InkStrokeGeometry,
  type LegacyActiveGeometryState,
} from '../domain/ink-stroke-geometry';
import {
  type InkBrushActiveGeometryUpdate,
  type InkBrushCoverage,
  type InkCompiledBrushGeometry,
  type InkFilledContourCoverage,
  type InkPromotedBrushGeometry,
} from '../domain/ink-brush-geometry-contract';
import { SharedInkStrokeGeometry } from '../domain/ink-shared-stroke-geometry';
import type { InkPoint, InkStroke } from '../domain/ink-surface';
import { InkEditTileContentIndex } from '../domain/ink-edit-tile-content-index';
import { InkTileContentKeyFactory } from '../domain/ink-tile-content-key';
import {
  createInkVersionedRenderOutset,
  InkTileDamageProjector,
} from '../domain/ink-tile-damage-projector';
import {
  createInkNoteLogicalRect,
  type InkNoteLogicalRect,
  InkWorldTileGrid,
  type InkWorldTileCoordinate,
} from '../domain/ink-world-tile-grid';
import { InkViewportDemandPlanner } from '../domain/ink-viewport-demand-planner';
import {
  NOOP_INK_PERFORMANCE_RECORDER,
  type InkPerformanceContact,
  type InkPerformanceRecorder,
} from '../runtime/ink-performance-diagnostics';
import type { InkWorkScheduler } from '../runtime/ink-work-scheduler';
import {
  INK_GEOMETRY_CACHE_BYTES_PER_MOUNT,
  InkDisposableMemoryReservation,
  InkGeometryCache,
  type InkGeometryCacheCoordinator,
} from './ink-geometry-cache';
import {
  InkRasterTileCache,
  type InkRasterTileBounds,
  type InkRasterTileResidency,
} from './ink-raster-tile-cache';
import {
  drawInkBrushGeometryToCanvas,
  drawInkBrushSelectionChromeToCanvas,
} from './ink-brush-canvas-adapter';
import type { InkBorrowedProvisionalTail } from './ink-capture-pipeline';
import { sameInkStageFrame, type InkStageFrame } from './ink-stage-frame';
import {
  InkViewportPresentationTransaction,
  type InkViewportCameraMotion,
} from './ink-viewport-presentation-transaction';
import {
  prepareInkWorkerOffscreenPresentationAdapter,
  type InkWorkerPresentationAck,
  type InkWorkerPresentationContactConfig,
  type InkWorkerPresentationFailureCategory,
  type InkWorkerPresentationFrameConfig,
  type InkWorkerPresentationSubmission,
  type InkWorkerPresentationSubmitResult,
} from './ink-worker-offscreen-presentation-adapter';

interface InkRenderActiveDeltaBase {
  readonly eraserColor?: string;
  readonly presentationGeneration?: number;
  readonly provisionalTail?: InkBorrowedProvisionalTail;
  readonly strokeId: string;
  readonly style: InkContactStyleSnapshot;
}

export type InkRenderActiveDelta = InkRenderActiveDeltaBase &
  (
    | { readonly delta: InkLegacyTraceDelta; readonly presentationDelta?: never }
    | {
        readonly delta?: never;
        readonly presentationDelta: InkBorrowedControlTraceDelta;
      }
  );

export interface InkRenderPhysicalActiveDelta {
  /** Fixed Logical-Stroke alpha. Applied once by the shared Active stack, never per contour. */
  readonly alpha: number;
  /** Opaque canonical sRGB color. */
  readonly color: string;
  readonly geometryUpdate: InkBrushActiveGeometryUpdate;
  readonly presentationDelta: InkBorrowedControlTraceDelta;
  readonly presentationGeneration?: number;
  readonly strokeId: string;
  readonly style: InkContactStyleSnapshot & { readonly tool: 'highlighter' | 'pen' };
}

export interface InkRenderDegradedPhysicalActiveDelta {
  readonly diagnostic: 'known-version-geometry-failure';
  readonly presentationDelta: InkBorrowedControlTraceDelta;
  readonly presentationGeneration?: number;
  readonly strokeId: string;
  readonly style: InkContactStyleSnapshot & { readonly tool: 'highlighter' | 'pen' };
}

export interface InkRenderRuntimeStats {
  readonly activeSegmentCount: number;
  readonly activeStableEncoding: ActiveNumericPathEncoding | null;
  readonly activeStableSampleCount: number;
  readonly activeStableChunkCount: number;
  readonly activeStableStorageKind: 'float64-chunks';
  readonly activeStrokeId: string | null;
  readonly activeTailEncoding: ActiveNumericPathEncoding | null;
  readonly activeTailStorageKind: 'float64-ring';
  readonly activeWorkingSetBytes: number;
  readonly backingStoreBytes: number;
  readonly backingStoreCount: 3;
  readonly backingStoreDimensionMutationCount: number;
  readonly cacheBytes: number;
  readonly cacheEntries: number;
  readonly committedCompileCount: number;
  readonly compositorLayerCount: 3;
  readonly editSceneRevision: number;
  readonly indexBytes: number;
  readonly lastActiveSubmittedSegmentCount: number;
  readonly queuedFrameCount: 0 | 1;
  readonly rasterTileBytes: number;
  readonly rasterTileCount: number;
  readonly rasterTileEvictions: number;
  readonly rasterTileHits: number;
  readonly rasterTileMisses: number;
  readonly rasterTileRebuildCount: number;
  readonly visibleRecoveryRebuildCount: number;
  readonly visibleRecoveryRebuildReason: InkVisibleRecoveryRebuildReason | null;
}

export type InkVisibleRecoveryRebuildReason =
  | 'backing-replacement'
  | 'canvas-context-restoration'
  | 'initial-document-install'
  | 'settled-projection'
  | 'unclassified-document-change';

export type InkActivePresentationAdapterKind = 'main-canvas-2d' | 'worker-offscreen-2d';

export interface InkActivePresentationAdapterState {
  readonly adapter: InkActivePresentationAdapterKind;
  readonly epoch: number;
  readonly requestedAdapter: InkActivePresentationAdapterKind;
}

export interface InkWorkerPresentationAdapterPort {
  readonly canvases: {
    readonly stable: HTMLCanvasElement;
    readonly tail: HTMLCanvasElement;
  };
  beginContact(input: InkWorkerPresentationContactConfig): void;
  configure(input: InkWorkerPresentationFrameConfig): void;
  dispose(): void;
  reset(): void;
  submit(input: InkWorkerPresentationSubmission): InkWorkerPresentationSubmitResult;
}

export type InkWorkerPresentationActivationResult =
  | { readonly adapter: InkWorkerPresentationAdapterPort; readonly kind: 'ready' }
  | {
      readonly failureCategory: InkWorkerPresentationFailureCategory;
      readonly kind: 'unavailable';
    };

export interface InkWorkerPresentationActivationPort {
  readonly canvases: {
    readonly stable: HTMLCanvasElement;
    readonly tail: HTMLCanvasElement;
  };
  cancel(): void;
  readonly result: Promise<InkWorkerPresentationActivationResult>;
}

export interface InkWorkerPreparedPresentationPort {
  activate(): InkWorkerPresentationActivationPort;
  dispose(): void;
}

export type InkWorkerPresentationPreparationResult =
  | { readonly kind: 'ready'; readonly prepared: InkWorkerPreparedPresentationPort }
  | {
      readonly failureCategory: InkWorkerPresentationFailureCategory;
      readonly kind: 'unavailable';
    };

export type InkWorkerPresentationPreparationFactory = (input: {
  readonly document: Document;
  readonly onAck: (ack: InkWorkerPresentationAck) => void;
  readonly onFault: (failure: InkWorkerPresentationFailureCategory) => void;
}) => Promise<InkWorkerPresentationPreparationResult>;

export interface InkWorkerPresentationDeadlineScheduler {
  cancel(handle: unknown): void;
  schedule(callback: () => void, delayMs: number): unknown;
}

export interface InkWorkerPresentationRuntimeOptions {
  readonly ackDeadlineMs?: number;
  readonly deadlineScheduler?: InkWorkerPresentationDeadlineScheduler;
  readonly enabled: boolean;
  readonly prepare?: InkWorkerPresentationPreparationFactory;
  readonly refreshIntervalMs?: number;
}

interface ActiveRenderState {
  legacyGeometryState: LegacyActiveGeometryState | null;
  physicalGeometryState: PhysicalActiveGeometryState | null;
  presentationState: InkActivePresentationState;
  readonly presentationSession: InkActivePresentationSession | null;
  readonly presentationWriter: InkActivePresentationWriter | null;
  readonly stablePoints: ChunkedNumericActivePath;
  readonly provisionalPoints: FixedNumericProvisionalPath;
  readonly presentationTail: ActivePresentationTailPath;
  paintedStablePointCount: number;
  readonly mutablePath: FixedNumericActivePath;
  lastPaintedTailBounds: InkGeometryBounds | null;
  pendingFullRedraw: boolean;
  pendingTailRedraw: boolean;
  physicalDegradationReported: boolean;
  finalized: CompiledInkStroke | null;
  readonly startPoint: Readonly<Pick<InkPoint, 'x' | 'y'>> | null;
  readonly eraserColor: string | null;
  presentationRevision: number;
}

interface PhysicalActiveGeometryState {
  readonly alpha: number;
  readonly color: string;
  completedBounds: InkGeometryBounds | null;
  generation: number;
  lastPaintedMutableBounds: InkGeometryBounds | null;
  readonly logicalGrid: number;
  mutableByteSize: number;
  mutableCoverage: readonly InkFilledContourCoverage[];
  paintedStableCoverageCount: number;
  stableByteSize: number;
  stableCoverage: InkFilledContourCoverage[];
  readonly version: 'highlighter-chisel-v1' | 'pen-physical-v1';
}

interface MainActiveCanvasPair {
  backingHeight: number;
  backingWidth: number;
  readonly kind: 'main-2d';
  readonly stable: HTMLCanvasElement;
  readonly stableContext: CanvasRenderingContext2D;
  readonly tail: HTMLCanvasElement;
  readonly tailContext: CanvasRenderingContext2D;
}

interface WorkerActiveCanvasPair {
  readonly adapter: InkWorkerPresentationAdapterPort;
  backingHeight: number;
  backingWidth: number;
  contactSequence: number | null;
  frameEpoch: number;
  readonly kind: 'worker-offscreen-2d';
  readonly sessionToken: number;
  readonly stable: HTMLCanvasElement;
  readonly tail: HTMLCanvasElement;
}

interface ActivatingWorkerCanvasPair {
  readonly activation: InkWorkerPresentationActivationPort;
  readonly backingHeight: 0;
  readonly backingWidth: 0;
  readonly kind: 'worker-activating';
  readonly sessionToken: number;
  readonly stable: HTMLCanvasElement;
  readonly tail: HTMLCanvasElement;
}

type ActiveCanvasPair = ActivatingWorkerCanvasPair | MainActiveCanvasPair | WorkerActiveCanvasPair;

interface PreparedWorkerPresentation {
  readonly prepared: InkWorkerPreparedPresentationPort;
  readonly sessionToken: number;
}

interface PendingWorkerPresentationAck {
  readonly contactSequence: number;
  readonly frameEpoch: number;
  readonly generation: number;
  readonly packetSequence: number;
  readonly presentationRevision: number;
  readonly sessionToken: number;
}

type ActiveDrawResult = 'main-submitted' | 'none' | 'worker-submitted';
type CommittedRasterPreparation = 'fallback' | 'pending' | 'ready';

interface CommittedRasterTile {
  readonly bounds: InkRasterTileBounds;
  readonly canvas: HTMLCanvasElement;
  readonly digests: ReadonlyArray<readonly [strokeId: string, digest: string]>;
}

interface CommittedRasterRegion {
  readonly bounds: InkRasterTileBounds;
  readonly coordinate: InkWorldTileCoordinate;
  readonly key: string;
  readonly rasterDensity: number;
}

interface CommittedRasterVisiblePlan {
  readonly devicePixelRatio: number;
  readonly frame: InkStageFrame;
  readonly generation: number;
  readonly regions: readonly CommittedRasterRegion[];
}

interface CommittedRasterTileBuildState {
  readonly bounds: InkRasterTileBounds;
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly digests: Array<readonly [strokeId: string, digest: string]>;
  readonly key: string;
  nextRef: number;
  pendingGeometry: CompiledInkStroke | null;
  readonly residency: InkRasterTileResidency;
  readonly refs: readonly InkRenderableStrokeRef[];
}

export interface InkRenderOverlay {
  readonly hovered: readonly InkRenderableStrokeRef[];
  readonly selected: readonly InkRenderableStrokeRef[];
}

interface InkPointPath {
  readonly length: number;
  at(index: number): Pick<InkPoint, 'x' | 'y'> | undefined;
}

class InkPointPathWindow implements InkPointPath {
  readonly length: number;

  constructor(
    private readonly source: InkPointPath,
    private readonly start: number,
  ) {
    this.length = Math.max(0, source.length - start);
  }

  at(index: number): Pick<InkPoint, 'x' | 'y'> | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    return this.source.at(this.start + index);
  }
}

type ActiveNumericPathEncoding = 'legacy-ink-point' | 'raw-spherical-sample';

const DEFAULT_DPR = (): number => Math.max(1, globalThis.devicePixelRatio || 1);
const DEFAULT_WORKER_REFRESH_INTERVAL_MS = 1_000 / 60;
const COMMITTED_RASTER_TILE_CSS_SIZE = 120;
const COMMITTED_RASTER_VIEWPORT_MULTIPLIER = 1.5;
const COMMITTED_RASTER_TILE_GRID = new InkWorldTileGrid({
  baseWorldSpan: COMMITTED_RASTER_TILE_CSS_SIZE,
});
const COMMITTED_RASTER_DEMAND_PLANNER = new InkViewportDemandPlanner({
  grid: COMMITTED_RASTER_TILE_GRID,
  lookAheadRings: 1,
  nearVisibleRings: 1,
});
const COMMITTED_RASTER_DAMAGE_PROJECTOR = new InkTileDamageProjector(COMMITTED_RASTER_TILE_GRID);
const COMMITTED_RASTER_RENDER_OUTSET = createInkVersionedRenderOutset({
  bottom: 64,
  left: 64,
  rendererVersion: 'ink-retained-tile-v1-outset-64',
  right: 64,
  top: 64,
});
const COMMITTED_RASTER_TILE_KEY_FACTORY = new InkTileContentKeyFactory();
const COMMITTED_RASTER_TILE_RENDERER_VERSION = 'ink-retained-tile-v1';
const DEFAULT_WORKER_DEADLINE_SCHEDULER: InkWorkerPresentationDeadlineScheduler = Object.freeze({
  cancel: (handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs),
});
let nextEditTileSession = 0;

export class InkRenderRuntime {
  private active: ActiveRenderState | null = null;
  private activePair: ActiveCanvasPair;
  private activePairEpoch = 1;
  private activePresentationAdapterSnapshot: InkActivePresentationAdapterState | null;
  private activePerformanceContact: InkPerformanceContact | null = null;
  private readonly activeStack: HTMLElement;
  private readonly cache: InkGeometryCache;
  private readonly cancelFrame: (handle: number) => void;
  private readonly committedCanvas: HTMLCanvasElement;
  private readonly committedContext: CanvasRenderingContext2D;
  private readonly committedTileScene: HTMLElement;
  private readonly committedRasterBuildMemory: InkDisposableMemoryReservation;
  private committedRasterBuild: CommittedRasterTileBuildState | null = null;
  private committedRasterBudget = -1;
  private committedRasterPrefetchAdmissionBlocked = false;
  private committedRasterPrefetchGeneration = 0;
  private committedRasterPrefetchScheduledGeneration: number | null = null;
  private committedRasterMotionDemandKey: string | null = null;
  private committedRasterVisibleBuildGeneration = 0;
  private committedRasterVisibleBuildScheduledGeneration: number | null = null;
  private committedRasterVisiblePlan: CommittedRasterVisiblePlan | null = null;
  private committedRasterPreparationIncomplete = false;
  private readonly committedRasterTiles: InkRasterTileCache<CommittedRasterTile>;
  private backingStoreDimensionMutationCount = 0;
  private committedCompileCount = 0;
  private disposed = false;
  private readonly dpr: () => number;
  private readonly document: Document;
  private readonly editProjectionIdentity = `mounted-edit-v1:${++nextEditTileSession}`;
  private readonly editTileContentIndex = new InkEditTileContentIndex({
    grid: COMMITTED_RASTER_TILE_GRID,
    projectionIdentity: this.editProjectionIdentity,
  });
  private readonly viewportTransaction = new InkViewportPresentationTransaction({
    hysteresisRatio: 0.1,
    maximumLod: 8,
    minimumLod: -8,
  });
  private deferredFrame: InkStageFrame | null = null;
  private deferredViewportInvalidation = false;
  private frame: InkStageFrame | null = null;
  private frameHandle: number | null = null;
  private frameReplacementPending = false;
  private excludedCommittedIds = new Set<string>();
  private readonly geometry: InkStrokeGeometry;
  private readonly sharedGeometry = new SharedInkStrokeGeometry();
  private readonly host: HTMLElement;
  private readonly inkPerformance: InkPerformanceRecorder;
  private readonly workScheduler: InkWorkScheduler | null;
  private lastActiveSubmittedSegmentCount = 0;
  private readonly now: () => number;
  private readonly onDiagnostic: (message: string) => void;
  private readonly onActiveFrame: (submittedThroughGeneration: number | null) => void;
  private readonly onActiveFrameUnpresented: (generation: number) => void;
  private readonly onDocumentChangesPresented: (changes: readonly InkDocumentChange[]) => void;
  private readonly onOverlayPresented: () => void;
  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.clearActivePrediction();
    if (event.currentTarget instanceof HTMLCanvasElement) {
      this.lostContexts.add(event.currentTarget);
    }
    if (this.activePair.kind === 'worker-offscreen-2d') {
      this.retirePendingWorkerGeneration();
      this.fallbackWorkerPairToMain(this.activePair);
    } else if (this.activePair.kind === 'worker-activating') {
      this.fallbackActivatingWorkerPairToMain(this.activePair);
    }
    const pendingGeneration = this.pendingPresentationGeneration;
    if (pendingGeneration !== null) {
      this.pendingPresentationGeneration = null;
      this.pendingActiveFrameRequestedAt = null;
      this.onActiveFrameUnpresented(pendingGeneration);
    }
  };
  private readonly onContextRestored = (event: Event): void => {
    if (event.currentTarget instanceof HTMLCanvasElement) {
      this.lostContexts.delete(event.currentTarget);
    }
    if (this.lostContexts.size === 0) this.restoreContexts();
  };
  private readonly lostContexts = new Set<HTMLCanvasElement>();
  private overlay: InkRenderOverlay = Object.freeze({ hovered: [], selected: [] });
  private overlayBounds: InkGeometryBounds | null = null;
  private overlayPending = false;
  private pendingChanges: InkDocumentChange[] = [];
  private pendingCommittedDamage: InkGeometryBounds[] = [];
  private pendingDocumentInstall = false;
  private pendingVisibleRecoveryReason: InkVisibleRecoveryRebuildReason | null = null;
  private pendingActiveFrameRequestedAt: number | null = null;
  private pendingCommittedPrefetchRegions: readonly CommittedRasterRegion[] = [];
  private pendingPresentationGeneration: number | null = null;
  private readonly presentedPromotionDigests = new Map<string, string>();
  private prefetchedCommittedLod: number | null = null;
  private readonly prefetchedCommittedTileKeys = new Set<string>();
  private readonly presentedCommittedTileKeys = new Set<string>();
  private readonly pendingPromotions = new Map<string, string>();
  private pendingWorkerAck: PendingWorkerPresentationAck | null = null;
  private preparedWorker: PreparedWorkerPresentation | null = null;
  private presentationFrameEpoch = -1;
  private projectedFrame: InkStageFrame | null = null;
  private lastCommittedViewport: InkNoteLogicalRect | null = null;
  private readonly query: (viewport: InkLogicalRect) => readonly InkRenderableStrokeRef[];
  private readonly read: () => InkDocumentReadView;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly supportsCommittedRasterTiles: boolean;
  private readonly requestedPresentationAdapter: InkActivePresentationAdapterKind;
  private readonly renderedDigests = new Map<string, string>();
  private readonly seenDocumentChanges = new Set<string>();
  private readonly strokeGenerations = new Map<string, number>();
  private nextWorkerContactSequence = 0;
  private configuredDpr = 0;
  private rasterTileRebuildCount = 0;
  private visibleRecoveryRebuildCount = 0;
  private visibleRecoveryRebuildReason: InkVisibleRecoveryRebuildReason | null = null;
  private workerFrameEpoch = 0;
  private workerAckDeadlineHandle: unknown = null;
  private workerAckDeadlineMs = DEFAULT_WORKER_REFRESH_INTERVAL_MS * 3;
  private workerDeadlineScheduler = DEFAULT_WORKER_DEADLINE_SCHEDULER;
  private workerSessionToken = 0;

  private get activeCanvas(): HTMLCanvasElement {
    return this.activePair.tail;
  }

  get activePresentationAdapterState(): InkActivePresentationAdapterState | null {
    return this.disposed ? null : this.activePresentationAdapterSnapshot;
  }

  private get activeContext(): CanvasRenderingContext2D {
    if (this.activePair.kind !== 'main-2d') {
      throw new Error('Main-thread Active tail context is unavailable while Worker owns it.');
    }
    return this.activePair.tailContext;
  }

  private get activeStableCanvas(): HTMLCanvasElement {
    return this.activePair.stable;
  }

  private get activeStableContext(): CanvasRenderingContext2D {
    if (this.activePair.kind !== 'main-2d') {
      throw new Error('Main-thread Active stable context is unavailable while Worker owns it.');
    }
    return this.activePair.stableContext;
  }

  constructor(input: {
    readonly cache?: InkGeometryCache;
    readonly cancelFrame?: (handle: number) => void;
    readonly devicePixelRatio?: () => number;
    readonly document: Document;
    readonly geometry?: InkStrokeGeometry;
    readonly host: HTMLElement;
    readonly inkPerformance?: InkPerformanceRecorder;
    readonly memoryCoordinator?: InkGeometryCacheCoordinator;
    readonly now?: () => number;
    readonly onDiagnostic?: (message: string) => void;
    readonly onActiveFrame?: (submittedThroughGeneration: number | null) => void;
    readonly onActiveFrameUnpresented?: (generation: number) => void;
    readonly onDocumentChangesPresented?: (changes: readonly InkDocumentChange[]) => void;
    readonly onOverlayPresented?: () => void;
    readonly query: (viewport: InkLogicalRect) => readonly InkRenderableStrokeRef[];
    readonly read: () => InkDocumentReadView;
    readonly requestFrame?: (callback: FrameRequestCallback) => number;
    readonly workScheduler?: InkWorkScheduler;
    readonly workerPresentation?: InkWorkerPresentationRuntimeOptions;
  }) {
    this.document = input.document;
    this.host = input.host;
    this.query = input.query;
    this.read = input.read;
    this.geometry = input.geometry ?? new LegacyRoundInkStrokeGeometry();
    this.cache =
      input.cache ??
      (input.memoryCoordinator === undefined
        ? new InkGeometryCache()
        : new InkGeometryCache({ coordinator: input.memoryCoordinator }));
    this.committedRasterBuildMemory = new InkDisposableMemoryReservation(
      this.cache.memoryCoordinator,
    );
    this.requestFrame = input.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = input.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    this.dpr = input.devicePixelRatio ?? DEFAULT_DPR;
    this.inkPerformance = input.inkPerformance ?? NOOP_INK_PERFORMANCE_RECORDER;
    this.workScheduler = input.workScheduler ?? null;
    this.inkPerformance.armAuditGuard('physical-finalize-no-recompile');
    this.now = input.now ?? (() => performance.now());
    this.onDiagnostic = input.onDiagnostic ?? (() => undefined);
    this.onActiveFrame = input.onActiveFrame ?? (() => undefined);
    this.onActiveFrameUnpresented = input.onActiveFrameUnpresented ?? (() => undefined);
    this.onDocumentChangesPresented = input.onDocumentChangesPresented ?? (() => undefined);
    this.onOverlayPresented = input.onOverlayPresented ?? (() => undefined);
    this.requestedPresentationAdapter =
      input.workerPresentation?.enabled === true ? 'worker-offscreen-2d' : 'main-canvas-2d';
    this.committedCanvas = createCanvas(input.document, 'committed');
    this.committedTileScene = createCommittedTileScene(input.document);
    this.activeStack = createActiveStack(input.document);
    this.committedContext = requireContext(this.committedCanvas);
    this.supportsCommittedRasterTiles =
      this.committedContext.canvas === this.committedCanvas &&
      typeof this.committedContext.drawImage === 'function';
    this.committedRasterTiles = new InkRasterTileCache(
      0,
      (tile) => {
        const key = tile.canvas.dataset.inkstoneCommittedTile;
        if (key !== undefined) {
          this.prefetchedCommittedTileKeys.delete(key);
          this.presentedCommittedTileKeys.delete(key);
        }
        tile.canvas.remove();
        tile.canvas.width = 0;
        tile.canvas.height = 0;
      },
      this.cache.memoryCoordinator,
    );
    const activePair = createMainActiveCanvasPair(input.document);
    this.activePair = activePair;
    this.activePresentationAdapterSnapshot = this.presentationAdapterState('main-canvas-2d');
    this.committedCanvas.addEventListener('contextlost', this.onContextLost);
    this.committedCanvas.addEventListener('contextrestored', this.onContextRestored);
    this.attachMainActivePairListeners(activePair);
    this.activeStack.append(this.activeStableCanvas, this.activeCanvas);
    this.host.append(this.committedTileScene, this.committedCanvas, this.activeStack);
    if (input.workerPresentation?.enabled === true) {
      this.workerAckDeadlineMs = boundedWorkerAckDeadline(input.workerPresentation);
      this.workerDeadlineScheduler =
        input.workerPresentation.deadlineScheduler ?? DEFAULT_WORKER_DEADLINE_SCHEDULER;
      this.prepareWorkerPresentation(input.workerPresentation);
    }
  }

  private presentationAdapterState(
    adapter: InkActivePresentationAdapterKind,
  ): InkActivePresentationAdapterState {
    return Object.freeze({
      adapter,
      epoch: this.activePairEpoch,
      requestedAdapter: this.requestedPresentationAdapter,
    });
  }

  private prepareWorkerPresentation(options: InkWorkerPresentationRuntimeOptions): void {
    const sessionToken = ++this.workerSessionToken;
    const prepare: InkWorkerPresentationPreparationFactory =
      options.prepare ?? ((input) => prepareInkWorkerOffscreenPresentationAdapter(input));
    let preparation: Promise<InkWorkerPresentationPreparationResult>;
    try {
      preparation = prepare({
        document: this.document,
        onAck: (ack) => this.handleWorkerAck(sessionToken, ack),
        onFault: () => this.handleWorkerFault(sessionToken),
      });
    } catch {
      return;
    }
    void preparation.then(
      (result) => {
        if (result.kind !== 'ready') return;
        if (this.disposed || sessionToken !== this.workerSessionToken) {
          result.prepared.dispose();
          return;
        }
        this.preparedWorker?.prepared.dispose();
        this.preparedWorker = { prepared: result.prepared, sessionToken };
        this.tryActivatePreparedWorker();
      },
      () => undefined,
    );
  }

  private tryActivatePreparedWorker(): void {
    const pending = this.preparedWorker;
    if (
      pending === null ||
      this.disposed ||
      pending.sessionToken !== this.workerSessionToken ||
      this.active !== null ||
      hasOverlayRequirement(this.overlay) ||
      this.activePair.kind !== 'main-2d'
    ) {
      return;
    }
    this.preparedWorker = null;
    const main = this.activePair;
    this.detachMainActivePairListeners(main);
    releaseMainActivePairBackingStores(main);
    this.activeStack.replaceChildren();
    this.activePairEpoch += 1;
    this.activePresentationAdapterSnapshot = null;

    let activation: InkWorkerPresentationActivationPort;
    try {
      activation = pending.prepared.activate();
    } catch {
      pending.prepared.dispose();
      this.workerSessionToken += 1;
      this.installFreshMainPair(false);
      return;
    }
    const pair: ActivatingWorkerCanvasPair = {
      activation,
      backingHeight: 0,
      backingWidth: 0,
      kind: 'worker-activating',
      sessionToken: pending.sessionToken,
      stable: activation.canvases.stable,
      tail: activation.canvases.tail,
    };
    pair.stable.style.opacity = '1';
    pair.tail.style.opacity = '1';
    this.activePair = pair;
    this.activeStack.replaceChildren(pair.stable, pair.tail);
    this.overlayBounds = null;
    this.overlayPending = false;
    void activation.result.then(
      (result) => this.completeWorkerActivation(pair, result),
      () => this.fallbackActivatingWorkerPairToMain(pair),
    );
  }

  private completeWorkerActivation(
    pair: ActivatingWorkerCanvasPair,
    result: InkWorkerPresentationActivationResult,
  ): void {
    if (
      this.disposed ||
      this.activePair !== pair ||
      pair.sessionToken !== this.workerSessionToken
    ) {
      if (result.kind === 'ready') result.adapter.dispose();
      return;
    }
    if (result.kind !== 'ready') {
      this.fallbackActivatingWorkerPairToMain(pair);
      return;
    }
    if (
      result.adapter.canvases.stable !== pair.stable ||
      result.adapter.canvases.tail !== pair.tail
    ) {
      result.adapter.dispose();
      this.fallbackActivatingWorkerPairToMain(pair);
      return;
    }
    const workerPair: WorkerActiveCanvasPair = {
      adapter: result.adapter,
      backingHeight: 0,
      backingWidth: 0,
      contactSequence: null,
      frameEpoch: 0,
      kind: 'worker-offscreen-2d',
      sessionToken: pair.sessionToken,
      stable: pair.stable,
      tail: pair.tail,
    };
    this.activePair = workerPair;
    this.activePairEpoch += 1;
    this.activePresentationAdapterSnapshot = this.presentationAdapterState('worker-offscreen-2d');
    if (this.frame !== null) this.tryConfigureWorkerActivePair(workerPair, this.frame);
  }

  private fallbackActivatingWorkerPairToMain(pair: ActivatingWorkerCanvasPair): void {
    if (this.activePair !== pair) return;
    this.workerSessionToken += 1;
    pair.activation.cancel();
    this.installFreshMainPair(false);
  }

  private attachMainActivePairListeners(pair: MainActiveCanvasPair): void {
    for (const canvas of [pair.stable, pair.tail]) {
      canvas.addEventListener('contextlost', this.onContextLost);
      canvas.addEventListener('contextrestored', this.onContextRestored);
    }
  }

  private detachMainActivePairListeners(pair: MainActiveCanvasPair): void {
    for (const canvas of [pair.stable, pair.tail]) {
      canvas.removeEventListener('contextlost', this.onContextLost);
      canvas.removeEventListener('contextrestored', this.onContextRestored);
      this.lostContexts.delete(canvas);
    }
  }

  private configureWorkerActivePair(pair: WorkerActiveCanvasPair, frame: InkStageFrame): void {
    const ratio = Math.max(1, this.dpr());
    const transform = frame.canvasBackingTransform(ratio);
    this.workerFrameEpoch += 1;
    pair.frameEpoch = this.workerFrameEpoch;
    pair.backingHeight = Math.max(1, Math.round(frame.canvasClientRect.height * ratio));
    pair.backingWidth = Math.max(1, Math.round(frame.canvasClientRect.width * ratio));
    pair.adapter.configure({
      backingHeight: pair.backingHeight,
      backingWidth: pair.backingWidth,
      frameEpoch: pair.frameEpoch,
      transform: [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f],
    });
  }

  private tryConfigureWorkerActivePair(
    pair: WorkerActiveCanvasPair,
    frame: InkStageFrame,
  ): boolean {
    try {
      this.configureWorkerActivePair(pair, frame);
    } catch {
      if (this.activePair === pair) {
        this.retirePendingWorkerGeneration();
        this.fallbackWorkerPairToMain(pair);
      }
      return false;
    }
    return this.activePair === pair;
  }

  private handleWorkerAck(sessionToken: number, ack: InkWorkerPresentationAck): void {
    const pending = this.pendingWorkerAck;
    const active = this.active;
    if (
      this.disposed ||
      this.activePair.kind !== 'worker-offscreen-2d' ||
      this.activePair.sessionToken !== sessionToken ||
      pending === null ||
      pending.sessionToken !== sessionToken ||
      pending.contactSequence !== ack.contactSequence ||
      pending.frameEpoch !== ack.frameEpoch ||
      pending.generation !== ack.generation ||
      pending.packetSequence !== ack.packetSequence ||
      active === null ||
      active.presentationRevision !== pending.presentationRevision ||
      active.pendingFullRedraw ||
      active.pendingTailRedraw ||
      this.pendingPresentationGeneration !== pending.generation
    ) {
      return;
    }
    this.cancelWorkerAckDeadline();
    this.pendingWorkerAck = null;
    this.pendingPresentationGeneration = null;
    this.recordActiveFrameDebt(this.now());
    this.onActiveFrame(ack.generation);
  }

  private handleWorkerFault(sessionToken: number): void {
    if (this.disposed || sessionToken !== this.workerSessionToken) return;
    if (
      this.activePair.kind !== 'worker-offscreen-2d' ||
      this.activePair.sessionToken !== sessionToken
    ) {
      this.workerSessionToken += 1;
      return;
    }
    this.retirePendingWorkerGeneration();
    this.fallbackWorkerPairToMain(this.activePair);
  }

  private retirePendingWorkerGeneration(): void {
    this.cancelWorkerAckDeadline();
    this.pendingWorkerAck = null;
    const generation = this.pendingPresentationGeneration;
    if (generation === null) return;
    this.pendingPresentationGeneration = null;
    this.pendingActiveFrameRequestedAt = null;
    this.onActiveFrameUnpresented(generation);
  }

  private fallbackWorkerPairToMain(pair: WorkerActiveCanvasPair): void {
    if (this.activePair !== pair) return;
    this.clearActivePrediction();
    this.workerSessionToken += 1;
    pair.adapter.dispose();
    this.installFreshMainPair(this.active !== null);
  }

  private installFreshMainPair(replayActiveTruth: boolean): void {
    const main = createMainActiveCanvasPair(this.document);
    this.attachMainActivePairListeners(main);
    this.activePair = main;
    this.activePairEpoch += 1;
    this.activePresentationAdapterSnapshot = this.presentationAdapterState('main-canvas-2d');
    this.activeStack.replaceChildren(main.stable, main.tail);
    if (this.frame !== null) this.configureMainActivePair(main, this.frame);
    if (replayActiveTruth && this.active !== null) {
      this.active.paintedStablePointCount = 0;
      this.active.lastPaintedTailBounds = null;
      this.active.pendingFullRedraw = true;
      this.active.pendingTailRedraw = true;
    }
    this.overlayBounds = null;
    this.overlayPending = true;
    this.schedule();
  }

  private configureMainActivePair(pair: MainActiveCanvasPair, frame: InkStageFrame): void {
    const ratio = Math.max(1, this.dpr());
    const width = Math.max(1, Math.round(frame.canvasClientRect.width * ratio));
    const height = Math.max(1, Math.round(frame.canvasClientRect.height * ratio));
    const transform = frame.canvasBackingTransform(ratio);
    for (const [canvas, context] of [
      [pair.stable, pair.stableContext],
      [pair.tail, pair.tailContext],
    ] as const) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.top = '0px';
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
    }
    pair.backingHeight = height;
    pair.backingWidth = width;
  }

  private armWorkerAckDeadline(pending: PendingWorkerPresentationAck): void {
    this.cancelWorkerAckDeadline();
    try {
      this.workerAckDeadlineHandle = this.workerDeadlineScheduler.schedule(() => {
        if (
          this.disposed ||
          this.pendingWorkerAck !== pending ||
          this.activePair.kind !== 'worker-offscreen-2d' ||
          this.activePair.sessionToken !== pending.sessionToken
        ) {
          return;
        }
        const pair = this.activePair;
        this.retirePendingWorkerGeneration();
        this.fallbackWorkerPairToMain(pair);
      }, this.workerAckDeadlineMs);
    } catch {
      const pair = this.activePair;
      if (pair.kind === 'worker-offscreen-2d') {
        this.retirePendingWorkerGeneration();
        this.fallbackWorkerPairToMain(pair);
      }
    }
  }

  private cancelWorkerAckDeadline(): void {
    const handle = this.workerAckDeadlineHandle;
    this.workerAckDeadlineHandle = null;
    if (handle === null) return;
    try {
      this.workerDeadlineScheduler.cancel(handle);
    } catch {
      // The acknowledgement identity is fenced independently of timer cleanup.
    }
  }

  setFrame(frame: InkStageFrame): void {
    if (this.disposed) return;
    if (
      this.activePerformanceContact !== null ||
      (this.active !== null && this.active.finalized === null)
    ) {
      if (sameInkStageFrame(this.deferredFrame ?? this.frame, frame)) return;
      this.deferredFrame = sameInkStageFrame(this.frame, frame) ? null : frame;
      return;
    }
    this.replaceFrame(frame);
  }

  /** Compositor-only preview used while a scroll/zoom gesture is still changing the viewport. */
  projectFrame(frame: InkStageFrame): void {
    if (
      this.disposed ||
      this.frame === null ||
      this.activePerformanceContact !== null ||
      (this.active !== null && this.active.finalized === null)
    ) {
      return;
    }
    if (sameInkStageFrame(this.frame, frame)) {
      this.clearBitmapProjection();
      return;
    }
    const base = this.frame;
    const scale = frame.actualScale / base.actualScale;
    const translateX =
      frame.documentClientOrigin.x -
      frame.canvasClientRect.left -
      scale * (base.documentClientOrigin.x - base.canvasClientRect.left);
    const translateY =
      frame.documentClientOrigin.y -
      frame.canvasClientRect.top -
      scale * (base.documentClientOrigin.y - base.canvasClientRect.top);
    const transform = `matrix(${scale}, 0, 0, ${scale}, ${translateX}, ${translateY})`;
    this.projectCommittedTileScene(
      frame,
      frame.actualScale === base.actualScale ? 'scroll' : 'zoom',
      this.presentationFrameEpoch + 1,
    );
    if (frame.actualScale === base.actualScale) {
      this.planCommittedRasterMotionPrefetch(frame, this.viewportTransaction.snapshot()?.targetLod);
    }
    for (const layer of [this.committedCanvas, this.activeStack]) {
      layer.style.transformOrigin = '0 0';
      layer.style.transform = transform;
      layer.style.willChange = 'transform';
    }
    this.projectedFrame = frame;
  }

  private replaceFrame(frame: InkStageFrame): void {
    if (sameInkStageFrame(this.frame, frame)) return;
    const previousFrame = this.frame;
    this.clearActivePrediction();
    this.presentationFrameEpoch += 1;
    this.invalidateCommittedRasterVisibleBuild();
    this.frame = frame;
    if (this.activePair.kind === 'worker-activating') {
      this.fallbackActivatingWorkerPairToMain(this.activePair);
    } else if (this.active !== null && this.activePair.kind === 'worker-offscreen-2d') {
      this.retirePendingWorkerGeneration();
      this.fallbackWorkerPairToMain(this.activePair);
    }
    this.frameReplacementPending = true;
    this.pendingVisibleRecoveryReason =
      previousFrame === null ? 'initial-document-install' : 'backing-replacement';
    if (this.active?.finalized === null) this.active.pendingFullRedraw = true;
    this.schedule();
  }

  invalidateViewport(): void {
    if (this.disposed || this.frame === null) return;
    if (
      this.activePerformanceContact !== null ||
      (this.active !== null && this.active.finalized === null)
    ) {
      this.deferredViewportInvalidation = true;
      return;
    }
    this.invalidateViewportNow();
  }

  private invalidateViewportNow(): void {
    this.clearActivePrediction();
    this.invalidateCommittedRasterVisibleBuild();
    if (this.activePair.kind === 'worker-activating') {
      this.fallbackActivatingWorkerPairToMain(this.activePair);
    } else if (this.active !== null && this.activePair.kind === 'worker-offscreen-2d') {
      this.retirePendingWorkerGeneration();
      this.fallbackWorkerPairToMain(this.activePair);
    }
    this.frameReplacementPending = true;
    if (this.active?.finalized === null) this.active.pendingFullRedraw = true;
    this.schedule();
  }

  private applyDeferredViewportMutation(): void {
    const deferredFrame = this.deferredFrame;
    const invalidation = this.deferredViewportInvalidation;
    this.deferredFrame = null;
    this.deferredViewportInvalidation = false;
    if (deferredFrame !== null) {
      this.replaceFrame(deferredFrame);
      return;
    }
    if (invalidation) this.invalidateViewportNow();
  }

  installDocument(read: InkDocumentReadView): void {
    if (this.disposed) return;
    this.invalidateCommittedRasterVisibleBuild();
    this.cache.setIndexBytes(read.indexBytes);
    this.cancelCommittedRasterBuild();
    this.resetCommittedRasterPrefetch(true);
    this.committedRasterTiles.clear();
    this.pendingDocumentInstall = true;
    this.pendingVisibleRecoveryReason = 'initial-document-install';
    this.schedule();
  }

  applyDocumentChange(change: InkDocumentChange): void {
    if (this.disposed) return;
    if (
      change.addedIds.length === 0 &&
      change.updatedIds.length === 0 &&
      change.removedIds.length === 0 &&
      change.bounds.length === 0
    ) {
      return;
    }
    const changeKey = `${change.generation}:${change.commandId}`;
    if (this.seenDocumentChanges.has(changeKey)) return;
    this.seenDocumentChanges.add(changeKey);
    this.invalidateCommittedRasterVisibleBuild();
    this.cancelCommittedRasterBuild();
    this.resetCommittedRasterPrefetch(false);
    const dirtyBounds = changeBounds(change);
    const damage =
      dirtyBounds === null
        ? Object.freeze({
            kind: 'untileable-range' as const,
            rendererVersion: COMMITTED_RASTER_RENDER_OUTSET.rendererVersion,
          })
        : COMMITTED_RASTER_DAMAGE_PROJECTOR.project(
            change.bounds.flatMap(({ newBounds, oldBounds }) =>
              [newBounds, oldBounds].flatMap((bounds) =>
                bounds === null || bounds === undefined
                  ? []
                  : [
                      createInkNoteLogicalRect({
                        height: bounds.height,
                        width: bounds.width,
                        x: bounds.x,
                        y: bounds.y,
                      }),
                    ],
              ),
            ),
            COMMITTED_RASTER_RENDER_OUTSET,
            this.viewportTransaction.snapshot()?.targetLod ?? 0,
          );
    this.editTileContentIndex.applyDamage(damage);
    if (dirtyBounds === null) {
      this.committedRasterTiles.invalidateAll();
      this.pendingDocumentInstall = true;
      this.pendingVisibleRecoveryReason = 'unclassified-document-change';
    } else {
      this.committedRasterTiles.markResidency(dirtyBounds, 'dirty');
    }
    const replaced = [...change.updatedIds, ...change.removedIds];
    this.cache.invalidateStrokeIds(replaced);
    for (const id of replaced) {
      this.strokeGenerations.set(id, (this.strokeGenerations.get(id) ?? 0) + 1);
      this.renderedDigests.delete(id);
    }
    this.cache.setIndexBytes(this.read().indexBytes);
    this.pendingChanges.push(change);
    this.schedule();
  }

  applyActiveDelta(input: InkRenderActiveDelta): void {
    if (this.disposed) return;
    this.applyActiveDeltaOwned(input);
    this.schedule();
  }

  private applyActiveDeltaOwned(input: InkRenderActiveDelta): ActiveRenderState {
    if (
      input.presentationGeneration !== undefined &&
      (!Number.isSafeInteger(input.presentationGeneration) || input.presentationGeneration <= 0)
    ) {
      throw new Error('Ink presentation generation must be a positive safe integer.');
    }
    if (
      input.presentationGeneration !== undefined &&
      this.pendingPresentationGeneration !== null &&
      input.presentationGeneration < this.pendingPresentationGeneration
    ) {
      throw new Error('Ink presentation generations must be monotonic.');
    }
    if (this.active !== null && this.active.presentationState.strokeId !== input.strokeId) {
      const previousStrokeId = this.active.presentationState.strokeId;
      if (
        this.active.finalized === null ||
        this.pendingPromotions.get(previousStrokeId) !== this.active.finalized.digest
      ) {
        throw new Error('InkRenderRuntime already owns another active stroke.');
      }
      // The prior Logical Stroke is already in the Live Document and is only waiting for the
      // committed promotion frame. Stage its already-compiled geometry on the committed overlay
      // before retiring the shared Active pair, so a rapid next contact cannot make it disappear
      // while committed tile work is correctly paused for that new contact.
      this.presentPromotingActive(this.active);
      this.retirePromotingActive();
    }
    const beginsContact = this.active === null;
    this.active?.provisionalPoints.reset();
    if (beginsContact && this.activePair.kind === 'worker-activating') {
      this.fallbackActivatingWorkerPairToMain(this.activePair);
    }
    if (
      beginsContact &&
      input.style.tool === 'eraser' &&
      this.activePair.kind === 'worker-offscreen-2d'
    ) {
      this.fallbackWorkerPairToMain(this.activePair);
    }
    const active =
      input.presentationDelta === undefined
        ? this.applyLegacyActiveDelta(input)
        : this.applyBorrowedActiveDelta(input, input.presentationDelta);
    if (input.style.tool !== 'eraser' && input.provisionalTail !== undefined) {
      active.provisionalPoints.replaceBorrowed(input.provisionalTail, this.presentationFrameEpoch);
    }
    active.presentationRevision += 1;
    active.pendingTailRedraw = true;
    this.active = active;
    if (input.presentationGeneration !== undefined) {
      this.pendingPresentationGeneration = input.presentationGeneration;
    }
    this.activeStack.style.opacity = formatOpacity(active.presentationState.paint.opacity);
    if (beginsContact && this.activePair.kind === 'worker-offscreen-2d') {
      this.tryBeginWorkerContact(this.activePair, active);
    }
    if (
      this.activePerformanceContact !== null &&
      this.inkPerformance.ownsContact(this.activePerformanceContact)
    ) {
      this.pendingActiveFrameRequestedAt ??= this.now();
    }
    return active;
  }

  applyPhysicalActiveDelta(input: InkRenderPhysicalActiveDelta): void {
    if (this.disposed) return;
    const update = input.geometryUpdate;
    if (
      (update.version !== 'pen-physical-v1' && update.version !== 'highlighter-chisel-v1') ||
      update.logicalStrokeId !== input.strokeId ||
      input.style.tool !== (update.version === 'pen-physical-v1' ? 'pen' : 'highlighter') ||
      input.style.color !== input.color ||
      !/^#[0-9a-f]{6}$/iu.test(input.color) ||
      !Number.isFinite(input.alpha) ||
      input.alpha <= 0 ||
      input.alpha > 1
    ) {
      throw new Error('Invalid physical Active Ink presentation.');
    }

    const existing = this.active?.physicalGeometryState ?? null;
    if (this.active !== null && existing === null) {
      throw new Error('InkRenderRuntime cannot mix physical and legacy active geometry.');
    }
    if (
      existing !== null &&
      (existing.version !== update.version ||
        existing.color !== input.color ||
        existing.alpha !== input.alpha ||
        existing.logicalGrid !== update.quantization.logicalGrid ||
        existing.completedBounds !== null ||
        update.mutable.generation <= existing.generation)
    ) {
      throw new Error('Physical Active Ink updates must preserve identity and generation order.');
    }
    if (existing === null && update.mutable.generation <= 0) {
      throw new Error('Physical Active Ink generation must be positive.');
    }

    const stableAppend = borrowPhysicalCoverage(update.stable.coverage);
    const mutableReplacement = borrowPhysicalCoverage(update.mutable.coverage);
    const stableAppendByteSize = physicalCoverageByteSize(stableAppend);
    const mutableReplacementByteSize = physicalCoverageByteSize(mutableReplacement);
    if (this.activePair.kind === 'worker-activating') {
      this.fallbackActivatingWorkerPairToMain(this.activePair);
    } else if (this.activePair.kind === 'worker-offscreen-2d') {
      this.retirePendingWorkerGeneration();
      this.fallbackWorkerPairToMain(this.activePair);
    }

    const active = this.applyActiveDeltaOwned({
      presentationDelta: input.presentationDelta,
      ...(input.presentationGeneration === undefined
        ? {}
        : { presentationGeneration: input.presentationGeneration }),
      strokeId: input.strokeId,
      style: input.style,
    });
    if (existing === null) {
      active.physicalGeometryState = {
        alpha: input.alpha,
        color: input.color,
        completedBounds: update.kind === 'active-finish' ? update.bounds : null,
        generation: update.mutable.generation,
        lastPaintedMutableBounds: null,
        logicalGrid: update.quantization.logicalGrid,
        mutableByteSize: mutableReplacementByteSize,
        mutableCoverage: mutableReplacement,
        paintedStableCoverageCount: 0,
        stableByteSize: stableAppendByteSize,
        stableCoverage: [...stableAppend],
        version: update.version,
      };
    } else {
      existing.completedBounds = update.kind === 'active-finish' ? update.bounds : null;
      existing.generation = update.mutable.generation;
      existing.mutableByteSize = mutableReplacementByteSize;
      existing.mutableCoverage = mutableReplacement;
      existing.stableByteSize += stableAppendByteSize;
      existing.stableCoverage.push(...stableAppend);
    }
    active.pendingTailRedraw = true;
    this.activeStack.style.opacity = formatOpacity(input.alpha);
    if (existing !== null || !this.submitFirstPhysicalFrame()) this.schedule();
  }

  applyDegradedPhysicalActiveDelta(input: InkRenderDegradedPhysicalActiveDelta): void {
    if (this.disposed) return;
    if (input.diagnostic !== 'known-version-geometry-failure') {
      throw new Error('Invalid physical Active Ink degradation diagnostic.');
    }
    const previous = this.active;
    if (previous !== null && previous.presentationState.strokeId !== input.strokeId) {
      throw new Error('InkRenderRuntime already owns another active stroke.');
    }
    if (
      previous !== null &&
      (previous.presentationState.tool !== input.style.tool ||
        previous.presentationState.width !== input.style.width ||
        previous.presentationState.paint.color !== input.style.color)
    ) {
      throw new Error('Physical Active Ink degradation must preserve presentation identity.');
    }
    const physical = previous?.physicalGeometryState ?? null;
    const version = input.style.tool === 'pen' ? 'pen-physical-v1' : 'highlighter-chisel-v1';
    if (physical !== null && physical.version !== version) {
      throw new Error('Physical Active Ink degradation must preserve brush identity.');
    }
    const active = this.applyActiveDeltaOwned({
      presentationDelta: input.presentationDelta,
      ...(input.presentationGeneration === undefined
        ? {}
        : { presentationGeneration: input.presentationGeneration }),
      strokeId: input.strokeId,
      style: input.style,
    });
    active.physicalGeometryState = null;
    active.pendingFullRedraw = true;
    if (!active.physicalDegradationReported) {
      this.onDiagnostic(
        `Known ${version} Active geometry failed for ${input.strokeId}; using local legacy presentation.`,
      );
      active.physicalDegradationReported = true;
    }
    this.schedule();
  }

  private beginWorkerContact(pair: WorkerActiveCanvasPair, active: ActiveRenderState): void {
    this.nextWorkerContactSequence =
      this.nextWorkerContactSequence >= 0xffff_ffff ? 1 : this.nextWorkerContactSequence + 1;
    pair.contactSequence = this.nextWorkerContactSequence;
    pair.adapter.beginContact({
      color: active.presentationState.paint.color,
      contactSequence: pair.contactSequence,
      ...(active.eraserColor === null ? {} : { eraserColor: active.eraserColor }),
      opacity: active.presentationState.paint.opacity,
      ...(active.startPoint === null ? {} : { startPoint: active.startPoint }),
      tool: active.presentationState.tool,
      width: active.presentationState.width,
    });
  }

  private tryBeginWorkerContact(pair: WorkerActiveCanvasPair, active: ActiveRenderState): boolean {
    try {
      this.beginWorkerContact(pair, active);
    } catch {
      if (this.activePair === pair) {
        this.retirePendingWorkerGeneration();
        this.fallbackWorkerPairToMain(pair);
      }
      return false;
    }
    return this.activePair === pair;
  }

  private applyBorrowedActiveDelta(
    input: InkRenderActiveDeltaBase,
    delta: InkBorrowedControlTraceDelta,
  ): ActiveRenderState {
    const existing = this.active;
    if (existing !== null && existing.presentationSession === null) {
      throw new Error('InkRenderRuntime cannot mix legacy and numeric active presentation.');
    }
    if (existing !== null) {
      const session = existing.presentationSession;
      const writer = existing.presentationWriter;
      if (session === null || writer === null) {
        throw new Error('Ink numeric presentation ownership is inconsistent.');
      }
      existing.presentationState = session.extend(delta, writer);
      return existing;
    }

    const stablePoints = new ChunkedNumericActivePath('raw-spherical-sample');
    const mutablePath = new FixedNumericActivePath('raw-spherical-sample');
    const provisionalPoints = new FixedNumericProvisionalPath();
    const writer = new RuntimeActivePresentationWriter(stablePoints, mutablePath);
    const session = this.geometry.beginActivePresentation({
      strokeId: input.strokeId,
      style: input.style,
    });
    const presentationState = session.extend(delta, writer);
    const firstPoint = stablePoints.at(0) ?? mutablePath.at(0);
    return {
      eraserColor: input.eraserColor ?? null,
      finalized: null,
      lastPaintedTailBounds: null,
      legacyGeometryState: null,
      mutablePath,
      paintedStablePointCount: 0,
      pendingFullRedraw: true,
      pendingTailRedraw: true,
      physicalDegradationReported: false,
      physicalGeometryState: null,
      presentationSession: session,
      presentationState,
      presentationRevision: 0,
      presentationWriter: writer,
      presentationTail: new ActivePresentationTailPath(
        stablePoints,
        mutablePath,
        provisionalPoints,
      ),
      provisionalPoints,
      stablePoints,
      startPoint:
        firstPoint === undefined ? null : Object.freeze({ x: firstPoint.x, y: firstPoint.y }),
    };
  }

  private applyLegacyActiveDelta(
    input: InkRenderActiveDeltaBase & { readonly delta: InkLegacyTraceDelta },
  ): ActiveRenderState {
    const existing = this.active;
    if (existing !== null && existing.presentationSession !== null) {
      throw new Error('InkRenderRuntime cannot mix numeric and legacy active presentation.');
    }
    const extended = this.geometry.extend(existing?.legacyGeometryState ?? null, input);
    const firstPoint = extended.stablePathDelta[0] ?? extended.mutablePath[0] ?? null;
    let active = existing;
    if (active === null) {
      const stablePoints = new ChunkedNumericActivePath('legacy-ink-point');
      const mutablePath = new FixedNumericActivePath('legacy-ink-point');
      const provisionalPoints = new FixedNumericProvisionalPath();
      active = {
        eraserColor: input.eraserColor ?? null,
        finalized: null,
        lastPaintedTailBounds: null,
        legacyGeometryState: ownActiveGeometryState(extended.state),
        mutablePath,
        paintedStablePointCount: 0,
        pendingFullRedraw: true,
        pendingTailRedraw: true,
        physicalDegradationReported: false,
        physicalGeometryState: null,
        presentationSession: null,
        presentationState: presentationStateFromLegacy(extended.state),
        presentationRevision: 0,
        presentationWriter: null,
        presentationTail: new ActivePresentationTailPath(
          stablePoints,
          mutablePath,
          provisionalPoints,
        ),
        provisionalPoints,
        stablePoints,
        startPoint:
          firstPoint === null ? null : Object.freeze({ x: firstPoint.x, y: firstPoint.y }),
      };
    }
    active.legacyGeometryState = ownActiveGeometryState(extended.state);
    active.presentationState = presentationStateFromLegacy(extended.state);
    active.mutablePath.replace(extended.mutablePath);
    for (const point of extended.stablePathDelta) appendStablePoint(active.stablePoints, point);
    return active;
  }

  setOverlay(overlay: InkRenderOverlay): void {
    if (this.disposed) return;
    if (
      this.overlay.hovered.length === overlay.hovered.length &&
      this.overlay.selected.length === overlay.selected.length &&
      this.overlay.hovered.every((stroke, index) => stroke === overlay.hovered[index]) &&
      this.overlay.selected.every((stroke, index) => stroke === overlay.selected[index])
    ) {
      return;
    }
    this.overlay = Object.freeze({
      hovered: Object.freeze([...overlay.hovered]),
      selected: Object.freeze([...overlay.selected]),
    });
    if (hasOverlayRequirement(this.overlay)) {
      if (this.activePair.kind === 'worker-activating') {
        this.fallbackActivatingWorkerPairToMain(this.activePair);
      } else if (this.activePair.kind === 'worker-offscreen-2d') {
        this.retirePendingWorkerGeneration();
        this.fallbackWorkerPairToMain(this.activePair);
      }
    }
    this.overlayPending = true;
    this.schedule();
    if (!hasOverlayRequirement(this.overlay)) this.tryActivatePreparedWorker();
  }

  setActivePerformanceContact(contact: InkPerformanceContact | null): void {
    const contactWasActive = this.activePerformanceContact !== null;
    if (contact?.sequence !== this.activePerformanceContact?.sequence) {
      this.pendingActiveFrameRequestedAt = null;
    }
    this.activePerformanceContact = contact;
    if (contact === null && contactWasActive) {
      if (
        this.active !== null &&
        this.active.finalized !== null &&
        (this.deferredFrame !== null || this.deferredViewportInvalidation)
      ) {
        this.applyDeferredViewportMutation();
      }
      if (this.hasPendingCommittedWork()) this.schedule();
      this.scheduleCommittedRasterPrefetch();
    }
  }

  setCommittedExclusions(strokeIds: readonly string[]): void {
    const next = new Set(strokeIds);
    if (
      next.size === this.excludedCommittedIds.size &&
      [...next].every((id) => this.excludedCommittedIds.has(id))
    ) {
      return;
    }
    const changedIds = new Set<string>();
    for (const id of this.excludedCommittedIds) if (!next.has(id)) changedIds.add(id);
    for (const id of next) if (!this.excludedCommittedIds.has(id)) changedIds.add(id);
    const dirty = unionBounds(
      ...this.read()
        .strokes.filter(({ id }) => changedIds.has(id))
        .map(({ bounds }) => bounds),
    );
    this.invalidateCommittedRasterVisibleBuild();
    this.excludedCommittedIds = next;
    this.cancelCommittedRasterBuild();
    this.resetCommittedRasterPrefetch(false);
    if (dirty === null) {
      this.editTileContentIndex.applyDamage({
        kind: 'untileable-range',
        rendererVersion: COMMITTED_RASTER_RENDER_OUTSET.rendererVersion,
      });
      this.committedRasterTiles.invalidateAll();
      this.pendingDocumentInstall = true;
      this.pendingVisibleRecoveryReason = 'unclassified-document-change';
    } else {
      this.editTileContentIndex.applyDamage(
        COMMITTED_RASTER_DAMAGE_PROJECTOR.project(
          [
            createInkNoteLogicalRect({
              height: dirty.height,
              width: dirty.width,
              x: dirty.x,
              y: dirty.y,
            }),
          ],
          COMMITTED_RASTER_RENDER_OUTSET,
          this.viewportTransaction.snapshot()?.targetLod ?? 0,
        ),
      );
      this.committedRasterTiles.invalidate(dirty);
      this.pendingCommittedDamage.push(dirty);
    }
    this.schedule();
  }

  finalizeActive(stroke: InkStroke): void {
    const active = this.active;
    if (active === null || active.presentationState.strokeId !== stroke.id) {
      throw new Error(`InkRenderRuntime does not own active stroke ${stroke.id}.`);
    }
    this.clearActivePrediction();
    if (active.physicalGeometryState === null) {
      this.inkPerformance.recordAuditedWork('historical-copy', 'completion');
    }
    const finalized =
      active.physicalGeometryState === null
        ? this.compile(stroke)
        : compiledPromotedPhysicalStroke(
            stroke,
            active.physicalGeometryState,
            this.strokeGenerations.get(stroke.id) ?? 0,
          );
    active.finalized = finalized;
    const generation = this.strokeGenerations.get(stroke.id) ?? 0;
    this.cache.put(renderGeometryCacheKey(stroke, generation), finalized, true);
    this.schedule();
  }

  promoteActive(strokeId: string): void {
    const active = this.active;
    if (
      active === null ||
      active.presentationState.strokeId !== strokeId ||
      active.finalized === null
    ) {
      throw new Error(`InkRenderRuntime cannot promote unfinalized stroke ${strokeId}.`);
    }
    this.pendingPromotions.set(strokeId, active.finalized.digest);
    this.schedule();
  }

  cancelActive(): void {
    if (this.active === null) return;
    const strokeId = this.active.presentationState.strokeId;
    this.clearActivePrediction();
    if (this.activePair.kind === 'worker-offscreen-2d') {
      this.retirePendingWorkerGeneration();
    }
    this.active = null;
    this.pendingActiveFrameRequestedAt = null;
    this.pendingPresentationGeneration = null;
    this.pendingPromotions.delete(strokeId);
    this.activeStack.style.opacity = '1';
    this.clearActiveLayers();
    this.overlayBounds = null;
    this.overlayPending = true;
    this.applyDeferredViewportMutation();
    this.schedule();
    this.tryActivatePreparedWorker();
  }

  restoreContexts(): void {
    if (this.disposed) return;
    this.invalidateCommittedRasterVisibleBuild();
    this.clearActivePrediction();
    this.lostContexts.clear();
    this.frameReplacementPending = true;
    this.pendingDocumentInstall = true;
    if (this.active !== null) this.active.pendingFullRedraw = true;
    this.cache.clear();
    this.cancelCommittedRasterBuild();
    this.resetCommittedRasterPrefetch(true);
    this.committedRasterTiles.clear();
    this.pendingVisibleRecoveryReason = 'canvas-context-restoration';
    this.schedule();
  }

  stats(): InkRenderRuntimeStats {
    const cache = this.cache.stats();
    const rasterTiles = this.committedRasterTiles.stats();
    const activeWorkingSetBytes =
      this.active === null
        ? 0
        : this.active.stablePoints.byteSizeEstimate +
          this.active.mutablePath.byteSizeEstimate +
          this.active.provisionalPoints.byteSizeEstimate +
          (this.active.legacyGeometryState?.mutableTail.length ?? 0) * 56 +
          physicalActiveByteSize(this.active.physicalGeometryState) +
          (this.active.finalized?.byteSizeEstimate ?? 0) +
          256;
    return Object.freeze({
      activeSegmentCount: this.active?.presentationState.stableSegmentCount ?? 0,
      activeStableEncoding: this.active?.stablePoints.encoding ?? null,
      activeStableSampleCount: this.active?.stablePoints.length ?? 0,
      activeStableChunkCount: this.active?.stablePoints.chunkCount ?? 0,
      activeStableStorageKind: 'float64-chunks',
      activeStrokeId: this.active?.presentationState.strokeId ?? null,
      activeTailEncoding: this.active?.mutablePath.encoding ?? null,
      activeTailStorageKind: 'float64-ring',
      activeWorkingSetBytes,
      backingStoreBytes:
        (this.committedCanvas.width * this.committedCanvas.height +
          this.activePair.backingWidth * this.activePair.backingHeight * 2) *
        4,
      backingStoreCount: 3,
      backingStoreDimensionMutationCount: this.backingStoreDimensionMutationCount,
      cacheBytes: cache.bytes,
      cacheEntries: cache.entryCount,
      committedCompileCount: this.committedCompileCount,
      compositorLayerCount: 3,
      editSceneRevision: this.editTileContentIndex.sceneRevision,
      indexBytes: cache.indexBytes,
      lastActiveSubmittedSegmentCount: this.lastActiveSubmittedSegmentCount,
      queuedFrameCount: this.frameHandle === null ? 0 : 1,
      rasterTileBytes: rasterTiles.bytes,
      rasterTileCount: rasterTiles.entryCount,
      rasterTileEvictions: rasterTiles.evictionCount,
      rasterTileHits: rasterTiles.hitCount,
      rasterTileMisses: rasterTiles.missCount,
      rasterTileRebuildCount: this.rasterTileRebuildCount,
      visibleRecoveryRebuildCount: this.visibleRecoveryRebuildCount,
      visibleRecoveryRebuildReason: this.visibleRecoveryRebuildReason,
    });
  }

  flushNow(): void {
    if (this.disposed || this.frame === null) return;
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.flush(this.now());
  }

  dispose(): void {
    if (this.disposed) return;
    this.clearActivePrediction();
    this.disposed = true;
    this.invalidateCommittedRasterVisibleBuild();
    this.activePresentationAdapterSnapshot = null;
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.pendingActiveFrameRequestedAt = null;
    this.pendingPresentationGeneration = null;
    this.cancelWorkerAckDeadline();
    this.pendingWorkerAck = null;
    this.preparedWorker?.prepared.dispose();
    this.preparedWorker = null;
    this.lostContexts.clear();
    this.cancelCommittedRasterBuild();
    this.resetCommittedRasterPrefetch(true);
    this.committedRasterBuildMemory.dispose();
    this.cache.dispose();
    this.committedRasterTiles.dispose();
    this.committedCanvas.removeEventListener('contextlost', this.onContextLost);
    this.committedCanvas.removeEventListener('contextrestored', this.onContextRestored);
    if (this.activePair.kind === 'main-2d') {
      this.detachMainActivePairListeners(this.activePair);
    } else if (this.activePair.kind === 'worker-offscreen-2d') {
      this.activePair.adapter.dispose();
    } else {
      this.activePair.activation.cancel();
    }
    this.activeStack.remove();
    this.committedCanvas.remove();
    this.committedTileScene.remove();
  }

  private schedule(): void {
    if (this.disposed || this.frameHandle !== null) return;
    let completedSynchronously = false;
    const handle = this.requestFrame((timestamp) => {
      completedSynchronously = true;
      this.frameHandle = null;
      this.flush(timestamp);
    });
    if (!completedSynchronously) this.frameHandle = handle;
  }

  private recordActiveFrameDebt(submittedAt: number): void {
    const requestedAt = this.pendingActiveFrameRequestedAt;
    this.pendingActiveFrameRequestedAt = null;
    if (
      requestedAt === null ||
      this.activePerformanceContact === null ||
      !this.inkPerformance.ownsContact(this.activePerformanceContact)
    ) {
      return;
    }
    this.inkPerformance.recordFrameInterval(
      Math.max(0, submittedAt - requestedAt),
      'active-writing',
    );
  }

  private flush(submittedAt: number): void {
    const frame = this.frame;
    if (this.disposed || frame === null) return;
    if (this.lostContexts.size > 0) {
      this.onActiveFrame(null);
      return;
    }
    const diagnosticsEnabled =
      this.inkPerformance.isEnabled() &&
      (this.activePerformanceContact === null ||
        this.inkPerformance.ownsContact(this.activePerformanceContact));
    const measurement = diagnosticsEnabled
      ? this.inkPerformance.beginSpan('ink-frame-work', {
          contact: this.activePerformanceContact,
          workPhase: 'active-frame',
        })
      : null;
    const activeOwnsFrame =
      this.activePerformanceContact !== null ||
      (this.active !== null && this.active.finalized === null);
    const viewportMeasurement =
      diagnosticsEnabled &&
      !activeOwnsFrame &&
      (this.pendingDocumentInstall ||
        this.frameReplacementPending ||
        this.pendingCommittedDamage.length > 0 ||
        this.pendingChanges.length > 0)
        ? this.inkPerformance.beginSpan('ink-viewport-redraw', { workPhase: 'viewport' })
        : null;
    let viewportResultCount = 0;
    let activeDraw: ActiveDrawResult = 'none';
    let frameBackingReady = true;
    let presentedChanges: readonly InkDocumentChange[] = [];
    let commandPatchPresented = false;
    let overlayPresented = false;
    let submittedThroughGeneration: number | null = null;
    let succeeded = false;
    this.committedRasterPreparationIncomplete = false;
    try {
      if (this.frameReplacementPending && activeOwnsFrame && this.configuredDpr !== 0) {
        frameBackingReady = false;
      } else if (
        this.frameReplacementPending &&
        this.supportsCommittedRasterTiles &&
        !activeOwnsFrame
      ) {
        const ratio = Math.max(1, this.dpr());
        const targetWidth = Math.max(1, Math.round(frame.canvasClientRect.width * ratio));
        const targetHeight = Math.max(1, Math.round(frame.canvasClientRect.height * ratio));
        if (this.prepareCommittedRasterTiles(frame, targetWidth, targetHeight) === 'pending') {
          frameBackingReady = false;
          if (!this.scheduleCommittedRasterVisibleBuild(frame)) this.schedule();
        }
      }
      if (this.frameReplacementPending && frameBackingReady) {
        this.configureCanvases(frame);
        this.frameReplacementPending = false;
        this.pendingDocumentInstall = true;
      }
      activeDraw = this.drawActive(frame);
      if (!activeOwnsFrame && frameBackingReady) {
        if (this.pendingDocumentInstall) {
          viewportResultCount = this.redrawCommittedViewport(
            frame,
            this.pendingVisibleRecoveryReason ?? 'settled-projection',
          );
        } else {
          if (
            this.supportsCommittedRasterTiles &&
            !this.committedTileScene.hidden &&
            this.pendingChanges.length > 0 &&
            (this.pendingCommittedDamage.length > 0 ||
              this.pendingChanges.some(
                (change) =>
                  !isAddedOnlyDocumentChange(change) || !this.hasMatchingActivePromotion(change),
              ))
          ) {
            const dirty = unionBounds(...this.pendingChanges.map((change) => changeBounds(change)));
            const patched = dirty === null ? null : this.presentCommittedCommandPatch(frame, dirty);
            if (patched !== null && dirty !== null) {
              viewportResultCount += patched;
              presentedChanges = this.pendingChanges;
              this.pendingChanges = [];
              commandPatchPresented = true;
            }
          }

          if (
            !commandPatchPresented &&
            this.supportsCommittedRasterTiles &&
            (this.pendingChanges.length > 0 || this.pendingCommittedDamage.length > 0)
          ) {
            for (const change of this.pendingChanges) {
              if (isAddedOnlyDocumentChange(change)) {
                viewportResultCount += this.drawDocumentChange(frame, change);
                continue;
              }
              const dirty = changeBounds(change);
              viewportResultCount +=
                dirty === null
                  ? this.redrawCommittedViewport(frame, 'unclassified-document-change')
                  : this.redrawCommittedRasterDamage(frame, dirty);
              if (this.committedRasterPreparationIncomplete) break;
            }
            if (!this.committedRasterPreparationIncomplete) {
              for (const dirty of this.pendingCommittedDamage) {
                viewportResultCount += this.redrawCommittedRasterDamage(frame, dirty);
                if (this.committedRasterPreparationIncomplete) break;
              }
            }
          } else if (!commandPatchPresented) {
            for (const change of this.pendingChanges) {
              viewportResultCount += this.drawDocumentChange(frame, change);
            }
            for (const dirty of this.pendingCommittedDamage) {
              viewportResultCount += this.redrawCommittedBounds(frame, dirty);
            }
          }
        }
        if (commandPatchPresented) {
          // The copy-on-write patch is the matching command presentation. Exact replacement tiles
          // continue in the visible lane without delaying this command generation.
        } else if (this.committedRasterPreparationIncomplete) {
          if (!this.scheduleCommittedRasterVisibleBuild(frame)) this.schedule();
        } else {
          presentedChanges = this.pendingChanges;
          this.pendingChanges = [];
          this.pendingCommittedDamage = [];
          this.pendingDocumentInstall = false;
          this.pendingVisibleRecoveryReason = null;
        }
      }
      if (activeDraw === 'main-submitted') {
        submittedThroughGeneration = this.pendingPresentationGeneration;
      }
      this.completePromotion();
      if (frameBackingReady) {
        const overlayWasPending = this.overlayPending;
        this.drawOverlay(frame);
        overlayPresented = overlayWasPending && !this.overlayPending;
        this.applyCanvasTransforms(frame);
      }
      if (
        !this.pendingDocumentInstall &&
        !this.frameReplacementPending &&
        this.pendingChanges.length === 0 &&
        this.pendingCommittedDamage.length === 0
      ) {
        this.clearBitmapProjection();
      }
      if (diagnosticsEnabled) {
        const stats = this.stats();
        this.inkPerformance.recordMemory({
          activeWorkingSetBytes: stats.activeWorkingSetBytes,
          backingStoreBytes: stats.backingStoreBytes,
          disposableCacheBytes: stats.cacheBytes + stats.indexBytes + stats.rasterTileBytes,
        });
      }
      succeeded = true;
    } finally {
      viewportMeasurement?.finish({ viewportResultCount });
      measurement?.finish({ viewportResultCount });
      if (succeeded && submittedThroughGeneration !== null) {
        this.pendingPresentationGeneration = null;
      }
      if (succeeded && activeDraw === 'main-submitted') this.recordActiveFrameDebt(submittedAt);
      if (!succeeded || activeDraw !== 'worker-submitted') {
        this.onActiveFrame(succeeded ? submittedThroughGeneration : null);
      }
      if (succeeded && presentedChanges.length > 0) {
        this.onDocumentChangesPresented(presentedChanges);
      }
      if (succeeded && overlayPresented) this.onOverlayPresented();
    }
  }

  private hasPendingCommittedWork(): boolean {
    return (
      this.pendingDocumentInstall ||
      this.frameReplacementPending ||
      this.pendingCommittedDamage.length > 0 ||
      this.pendingChanges.length > 0
    );
  }

  private scheduleCommittedRasterVisibleBuild(frame: InkStageFrame): boolean {
    const scheduler = this.workScheduler;
    if (scheduler === null) return false;
    if (
      this.disposed ||
      (this.active !== null && this.active.finalized === null) ||
      this.activePerformanceContact !== null ||
      this.committedRasterVisibleBuildScheduledGeneration !== null
    ) {
      return true;
    }
    const generation = this.committedRasterVisibleBuildGeneration;
    let preparation: CommittedRasterPreparation = 'pending';
    this.committedRasterVisibleBuildScheduledGeneration = generation;
    void scheduler
      .schedule({
        isCurrent: () =>
          !this.disposed &&
          generation === this.committedRasterVisibleBuildGeneration &&
          this.frame === frame &&
          (this.active === null || this.active.finalized !== null) &&
          this.activePerformanceContact === null,
        lane: 'visible',
        unitKinds: ['edit-visible-tile-build-unit'],
        units: [
          () => {
            this.committedRasterPreparationIncomplete = false;
            const ratio = Math.max(1, this.dpr());
            preparation = this.prepareCommittedRasterTiles(
              frame,
              Math.max(1, Math.round(frame.canvasClientRect.width * ratio)),
              Math.max(1, Math.round(frame.canvasClientRect.height * ratio)),
            );
          },
        ],
      })
      .then(
        (outcome) => {
          if (this.committedRasterVisibleBuildScheduledGeneration !== generation) return;
          this.committedRasterVisibleBuildScheduledGeneration = null;
          if (
            this.disposed ||
            generation !== this.committedRasterVisibleBuildGeneration ||
            this.frame !== frame
          ) {
            return;
          }
          if (outcome === 'completed' && preparation !== 'pending') {
            this.schedule();
            return;
          }
          this.scheduleCommittedRasterVisibleBuild(frame);
        },
        (error: unknown) => {
          if (this.committedRasterVisibleBuildScheduledGeneration === generation) {
            this.committedRasterVisibleBuildScheduledGeneration = null;
          }
          this.onDiagnostic(
            `Visible committed raster build stopped after a scheduled failure: ${
              error instanceof Error ? error.message : 'unknown failure'
            }`,
          );
          if (!this.disposed && generation === this.committedRasterVisibleBuildGeneration) {
            this.schedule();
          }
        },
      );
    return true;
  }

  private invalidateCommittedRasterVisibleBuild(): void {
    this.committedRasterVisibleBuildGeneration += 1;
    this.committedRasterVisibleBuildScheduledGeneration = null;
    this.committedRasterVisiblePlan = null;
  }

  private configureCanvases(frame: InkStageFrame): void {
    const ratio = Math.max(1, this.dpr());
    this.configuredDpr = ratio;
    const width = Math.max(1, Math.round(frame.canvasClientRect.width * ratio));
    const height = Math.max(1, Math.round(frame.canvasClientRect.height * ratio));
    const mainPairs: ReadonlyArray<readonly [HTMLCanvasElement, CanvasRenderingContext2D]> = [
      [this.committedCanvas, this.committedContext],
      ...(this.activePair.kind === 'main-2d'
        ? [
            [this.activePair.stable, this.activePair.stableContext] as const,
            [this.activePair.tail, this.activePair.tailContext] as const,
          ]
        : []),
    ];
    for (const [canvas, context] of mainPairs) {
      if (canvas.width !== width) {
        canvas.width = width;
        this.backingStoreDimensionMutationCount += 1;
      }
      if (canvas.height !== height) {
        canvas.height = height;
        this.backingStoreDimensionMutationCount += 1;
      }
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.top = '0px';
      context.lineCap = 'round';
      context.lineJoin = 'round';
    }
    if (this.activePair.kind === 'main-2d') {
      this.activePair.backingHeight = height;
      this.activePair.backingWidth = width;
    }
    if (this.activePair.kind === 'worker-offscreen-2d') {
      this.tryConfigureWorkerActivePair(this.activePair, frame);
    }
    if (this.active === null) {
      this.clearActiveLayers();
      this.overlayBounds = null;
      this.overlayPending = true;
    }
    this.applyCanvasTransforms(frame);
  }

  private applyCanvasTransforms(frame: InkStageFrame): void {
    const transform = frame.canvasBackingTransform(Math.max(1, this.dpr()));
    const contexts = [
      this.committedContext,
      ...(this.activePair.kind === 'main-2d'
        ? [this.activePair.stableContext, this.activePair.tailContext]
        : []),
    ];
    for (const context of contexts) {
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
    }
  }

  private clearBitmapProjection(): void {
    if (this.projectedFrame === null) return;
    if (this.frame === null || !sameInkStageFrame(this.frame, this.projectedFrame)) return;
    this.projectedFrame = null;
    for (const layer of [this.committedCanvas, this.activeStack]) {
      layer.style.transform = '';
      layer.style.transformOrigin = '';
      layer.style.willChange = '';
    }
    if (this.frame !== null) this.projectCommittedTileScene(this.frame);
  }

  private projectCommittedTileScene(
    frame: InkStageFrame,
    motion: InkViewportCameraMotion = 'settled',
    stageFrameEpoch = Math.max(0, this.presentationFrameEpoch),
  ): void {
    const { transform } = this.requestViewportPresentation(frame, motion, stageFrameEpoch);
    this.committedTileScene.style.transform = `matrix(${transform.a}, 0, 0, ${transform.d}, ${transform.e}, ${transform.f})`;
  }

  private requestViewportPresentation(
    frame: InkStageFrame,
    motion: InkViewportCameraMotion,
    stageFrameEpoch = Math.max(0, this.presentationFrameEpoch),
  ) {
    return this.viewportTransaction.request({
      camera: {
        devicePixelRatio: Math.max(1, this.dpr()),
        logicalLeft: frame.logicalViewport.left,
        logicalTop: frame.logicalViewport.top,
        scale: frame.actualScale,
      },
      motion,
      projectionIdentity: this.editProjectionIdentity,
      stageFrameEpoch,
    });
  }

  private redrawCommittedViewport(
    frame: InkStageFrame,
    reason: InkVisibleRecoveryRebuildReason = 'settled-projection',
  ): number {
    const resultCount = this.supportsCommittedRasterTiles
      ? this.redrawCommittedRasterTiles(frame)
      : this.redrawCommittedViewportDirect(frame);
    if (!this.committedRasterPreparationIncomplete) {
      this.visibleRecoveryRebuildCount += 1;
      this.visibleRecoveryRebuildReason = reason;
    }
    return resultCount;
  }

  private redrawCommittedViewportDirect(frame: InkStageFrame): number {
    this.committedTileScene.hidden = true;
    this.committedCanvas.hidden = false;
    clearCanvas(this.committedCanvas, this.committedContext);
    this.presentedPromotionDigests.clear();
    this.renderedDigests.clear();
    const refs = ordered(this.query(logicalViewport(frame))).filter(
      ({ id }) => !this.excludedCommittedIds.has(id),
    );
    this.cache.setVisibleStrokeIds(new Set(refs.map(({ id }) => id)));
    for (const ref of refs) this.drawCommittedRef(ref, true);
    return refs.length;
  }

  private committedRasterRegions(
    frame: InkStageFrame,
    devicePixelRatio: number,
  ): readonly CommittedRasterRegion[] {
    const cached = this.committedRasterVisiblePlan;
    if (
      cached !== null &&
      cached.devicePixelRatio === devicePixelRatio &&
      cached.frame === frame &&
      cached.generation === this.committedRasterVisibleBuildGeneration
    ) {
      return cached.regions;
    }
    const lod = this.viewportTransaction.request({
      camera: {
        devicePixelRatio,
        logicalLeft: frame.logicalViewport.left,
        logicalTop: frame.logicalViewport.top,
        scale: frame.actualScale,
      },
      motion: 'settled',
      projectionIdentity: this.editProjectionIdentity,
      stageFrameEpoch: Math.max(0, this.presentationFrameEpoch),
    }).targetLod;
    const regions = committedRasterRegions(frame, lod, this.editTileContentIndex);
    this.committedRasterVisiblePlan = Object.freeze({
      devicePixelRatio,
      frame,
      generation: this.committedRasterVisibleBuildGeneration,
      regions,
    });
    return regions;
  }

  /** Composites bounded non-DOM raster tiles; unchanged history is never rerasterized. */
  private redrawCommittedRasterTiles(frame: InkStageFrame): number {
    const ratio = Math.max(1, this.dpr());
    const preparation = this.prepareCommittedRasterTiles(
      frame,
      this.committedCanvas.width,
      this.committedCanvas.height,
    );
    if (preparation === 'fallback') return this.redrawCommittedViewportDirect(frame);
    if (preparation === 'pending') return 0;
    const regions = this.committedRasterRegions(frame, ratio);
    const visibleStrokeIds = this.presentCommittedRasterRegions(frame, regions);
    if (visibleStrokeIds === null) return this.redrawCommittedViewportDirect(frame);
    this.cache.setVisibleStrokeIds(visibleStrokeIds);
    return visibleStrokeIds.size;
  }

  private presentCommittedRasterRegions(
    frame: InkStageFrame,
    regions: readonly CommittedRasterRegion[],
  ): Set<string> | null {
    const tiles: Array<readonly [CommittedRasterRegion, CommittedRasterTile]> = [];
    for (const region of regions) {
      const tile = this.committedRasterTiles.get(region.key);
      if (tile === null) return null;
      tiles.push([region, tile]);
    }
    const previouslyPresentedKeys = new Set(this.presentedCommittedTileKeys);
    const presentedLod =
      regions[0]?.coordinate.lod ?? this.viewportTransaction.snapshot()?.targetLod;
    if (presentedLod !== undefined && this.prefetchedCommittedLod !== presentedLod) {
      this.resetCommittedRasterPrefetch(false);
      this.prefetchedCommittedLod = presentedLod;
    }
    const nextKeys = new Set(regions.map(({ key }) => key));
    for (const key of this.prefetchedCommittedTileKeys) nextKeys.add(key);
    for (const child of this.committedTileScene.children) {
      if (child instanceof HTMLCanvasElement) {
        child.hidden = !nextKeys.has(child.dataset.inkstoneCommittedTile ?? '');
      }
    }
    this.renderedDigests.clear();
    const visibleStrokeIds = new Set<string>();
    for (const [region, tile] of tiles) {
      tile.canvas.hidden = false;
      this.committedRasterTiles.setResidency(region.key, 'visible');
      for (const [strokeId, digest] of tile.digests) {
        visibleStrokeIds.add(strokeId);
        this.renderedDigests.set(strokeId, digest);
      }
    }
    this.presentedCommittedTileKeys.clear();
    for (const key of nextKeys) this.presentedCommittedTileKeys.add(key);
    // Only after complete replacement coverage is visible may the previous scene lose its
    // presentation lease and re-enter the disposable LRU. This keeps damage adoption atomic while
    // returning temporary over-budget bytes as soon as continuity no longer depends on them.
    for (const key of previouslyPresentedKeys) {
      if (!nextKeys.has(key)) this.committedRasterTiles.setResidency(key, 'stale');
    }
    if (this.committedRasterBudget >= 0) {
      this.committedRasterTiles.setMaxBytes(this.committedRasterBudget);
    }
    this.committedTileScene.hidden = false;
    this.projectCommittedTileScene(frame);
    this.viewportTransaction.accept({
      cameraEpoch: Math.max(0, this.presentationFrameEpoch),
      coverage: 'exact',
      projectionIdentity: this.editProjectionIdentity,
    });
    this.planCommittedRasterPrefetch(frame, presentedLod);
    if (!this.committedCanvas.hidden) clearCanvas(this.committedCanvas, this.committedContext);
    this.presentedPromotionDigests.clear();
    this.committedCanvas.hidden = true;
    return visibleStrokeIds;
  }

  /**
   * Presents an exact, bounded command result into the already-composited visible tile backing.
   * Keeping the Canvas node stable avoids a blank WebKit compositor frame between replacements.
   */
  private presentCommittedCommandPatch(
    frame: InkStageFrame,
    dirty: InkGeometryBounds,
  ): number | null {
    const patchBounds = expandGeometryBounds(dirty, 2);
    const targetRegions = this.committedRasterRegions(frame, Math.max(1, this.dpr()));
    const changedIds = new Set(
      this.pendingChanges.flatMap((change) => [...change.updatedIds, ...change.removedIds]),
    );
    const prepared: Array<{
      readonly bounds: InkRasterTileBounds;
      readonly destinationX: number;
      readonly destinationY: number;
      readonly digests: readonly (readonly [string, string])[];
      readonly key: string;
      readonly patch: HTMLCanvasElement;
      readonly sourceCanvas: HTMLCanvasElement;
      readonly targetKey: string;
    }> = [];
    let resultCount = 0;

    for (const child of [...this.committedTileScene.children]) {
      if (!(child instanceof HTMLCanvasElement) || child.hidden) continue;
      const key = child.dataset.inkstoneCommittedTile;
      if (key === undefined) continue;
      const source = this.committedRasterTiles.get(key);
      if (source === null || !intersects(source.bounds, patchBounds)) continue;
      const targetRegion = targetRegions.find(({ bounds }) =>
        sameRasterBounds(bounds, source.bounds),
      );
      if (targetRegion === undefined) continue;
      const intersection = intersectBounds(source.bounds, patchBounds);
      if (intersection === null) continue;

      const rasterDensity = child.width / source.bounds.width;
      const destinationX = Math.max(
        0,
        Math.floor((intersection.x - source.bounds.x) * rasterDensity),
      );
      const destinationY = Math.max(
        0,
        Math.floor((intersection.y - source.bounds.y) * rasterDensity),
      );
      const destinationRight = Math.min(
        child.width,
        Math.ceil((intersection.x + intersection.width - source.bounds.x) * rasterDensity),
      );
      const destinationBottom = Math.min(
        child.height,
        Math.ceil((intersection.y + intersection.height - source.bounds.y) * rasterDensity),
      );
      if (destinationRight <= destinationX || destinationBottom <= destinationY) continue;
      const exactPatchBounds = Object.freeze({
        height: (destinationBottom - destinationY) / rasterDensity,
        width: (destinationRight - destinationX) / rasterDensity,
        x: source.bounds.x + destinationX / rasterDensity,
        y: source.bounds.y + destinationY / rasterDensity,
      });
      const patch = this.document.createElement('canvas');
      patch.width = destinationRight - destinationX;
      patch.height = destinationBottom - destinationY;
      const context = patch.getContext('2d');
      if (context === null || typeof context.drawImage !== 'function') {
        patch.width = 0;
        patch.height = 0;
        for (const entry of prepared) {
          entry.patch.width = 0;
          entry.patch.height = 0;
        }
        return null;
      }
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.save();
      context.setTransform(
        rasterDensity,
        0,
        0,
        rasterDensity,
        -exactPatchBounds.x * rasterDensity,
        -exactPatchBounds.y * rasterDensity,
      );

      const digests = new Map(source.digests.filter(([strokeId]) => !changedIds.has(strokeId)));
      const refs = ordered(this.query(exactPatchBounds)).filter(
        ({ bounds, id, stroke }) =>
          stroke.tool !== 'eraser' &&
          !this.excludedCommittedIds.has(id) &&
          intersects(bounds, exactPatchBounds),
      );
      for (const ref of refs) {
        const geometry = this.compileRef(ref, true);
        drawCompiled(context, geometry, false);
        digests.set(ref.id, geometry.digest);
        this.renderedDigests.set(ref.id, geometry.digest);
      }
      context.restore();

      prepared.push({
        bounds: source.bounds,
        destinationX,
        destinationY,
        digests: Object.freeze([...digests]),
        key,
        patch,
        sourceCanvas: child,
        targetKey: targetRegion.key,
      });
      resultCount += refs.length;
    }

    if (prepared.length === 0) return null;
    const scratchBytes = prepared.reduce(
      (bytes, { patch }) => bytes + patch.width * patch.height * 4,
      0,
    );
    const targetContexts = prepared.map(({ sourceCanvas }) => sourceCanvas.getContext('2d'));
    if (
      this.committedRasterBudget < 0 ||
      scratchBytes > this.committedRasterBudget ||
      targetContexts.some((context) => context === null || typeof context.drawImage !== 'function')
    ) {
      for (const { patch } of prepared) {
        patch.width = 0;
        patch.height = 0;
      }
      return null;
    }

    for (const [
      index,
      { bounds, destinationX, destinationY, digests, key, patch, sourceCanvas, targetKey },
    ] of prepared.entries()) {
      const targetContext = targetContexts[index];
      if (targetContext === null || targetContext === undefined) {
        throw new Error(`Committed command patch lost its visible Canvas context ${key}.`);
      }
      const previousAlpha = targetContext.globalAlpha;
      const previousComposite = targetContext.globalCompositeOperation;
      targetContext.save();
      targetContext.setTransform(1, 0, 0, 1, 0, 0);
      targetContext.globalAlpha = 1;
      targetContext.globalCompositeOperation = 'copy';
      targetContext.drawImage(patch, destinationX, destinationY);
      targetContext.globalAlpha = previousAlpha;
      targetContext.globalCompositeOperation = previousComposite;
      targetContext.restore();
      patch.width = 0;
      patch.height = 0;
      if (this.committedRasterTiles.take(key) === null) {
        throw new Error(`Committed command patch lost its retained source tile ${key}.`);
      }
      sourceCanvas.dataset.inkstoneCommittedTile = targetKey;
      const adopted = Object.freeze({
        bounds,
        canvas: sourceCanvas,
        digests,
      });
      const byteSize = sourceCanvas.width * sourceCanvas.height * 4;
      if (!this.committedRasterTiles.put(targetKey, adopted, bounds, byteSize, 'visible')) {
        throw new Error(`Committed command patch could not retain its exact tile ${targetKey}.`);
      }
      this.presentedCommittedTileKeys.delete(key);
      this.presentedCommittedTileKeys.add(targetKey);
      if (this.prefetchedCommittedTileKeys.delete(key)) {
        this.prefetchedCommittedTileKeys.add(targetKey);
      }
    }
    return resultCount;
  }

  private prepareCommittedRasterTiles(
    frame: InkStageFrame,
    targetBackingWidth: number,
    targetBackingHeight: number,
  ): CommittedRasterPreparation {
    const geometryCache = this.cache.stats();
    const remainingDisposableBudget = Math.max(
      0,
      INK_GEOMETRY_CACHE_BYTES_PER_MOUNT - geometryCache.bytes - geometryCache.indexBytes,
    );
    const requiredVisibleBytes = targetBackingWidth * targetBackingHeight * 4;
    const viewportRasterBudget = Math.floor(
      requiredVisibleBytes * COMMITTED_RASTER_VIEWPORT_MULTIPLIER,
    );
    const rasterBudget = Math.min(remainingDisposableBudget, viewportRasterBudget);
    if (rasterBudget !== this.committedRasterBudget) {
      this.committedRasterBudget = rasterBudget;
      this.committedRasterPrefetchAdmissionBlocked = false;
    }
    this.committedRasterTiles.setMaxBytes(rasterBudget);
    if (rasterBudget < requiredVisibleBytes) return 'fallback';

    const ratio = Math.max(1, this.dpr());
    for (const region of this.committedRasterRegions(frame, ratio)) {
      const { bounds, key, rasterDensity } = region;
      if (this.committedRasterBuild?.key !== key && this.committedRasterTiles.get(key) !== null) {
        this.committedRasterTiles.setResidency(key, 'visible');
        continue;
      }
      const build = this.advanceCommittedRasterTile(key, bounds, rasterDensity);
      if (build === 'fallback') {
        return 'fallback';
      }
      this.committedRasterPreparationIncomplete = true;
      return 'pending';
    }
    return 'ready';
  }

  private redrawCommittedRasterDamage(frame: InkStageFrame, dirty: InkRasterTileBounds): number {
    const ratio = Math.max(1, this.dpr());
    const regions = this.committedRasterRegions(frame, ratio).filter(({ bounds }) =>
      intersects(bounds, dirty),
    );
    for (const region of regions) {
      const { bounds, key, rasterDensity } = region;
      if (this.committedRasterBuild?.key !== key && this.committedRasterTiles.get(key) !== null) {
        continue;
      }
      const build = this.advanceCommittedRasterTile(key, bounds, rasterDensity);
      if (build === 'fallback') {
        return this.redrawCommittedBounds(frame, dirty);
      }
      this.committedRasterPreparationIncomplete = true;
      return 0;
    }

    if (!this.committedTileScene.hidden) {
      const presented = this.presentCommittedRasterRegions(
        frame,
        this.committedRasterRegions(frame, ratio),
      );
      if (presented !== null) {
        this.cache.setVisibleStrokeIds(presented);
        return presented.size;
      }
    }

    const visibleStrokeIds = new Set<string>();
    this.committedContext.save();
    this.committedContext.setTransform(1, 0, 0, 1, 0, 0);
    for (const region of regions) {
      const { bounds, key } = region;
      const tile = this.committedRasterTiles.get(key);
      if (tile === null) continue;
      const destination = frame.logicalToCanvasCss({ x: bounds.x, y: bounds.y });
      const left = Math.floor(destination.x * ratio);
      const top = Math.floor(destination.y * ratio);
      const destinationWidth = bounds.width * frame.actualScale * ratio;
      const destinationHeight = bounds.height * frame.actualScale * ratio;
      const right = Math.ceil(destination.x * ratio + destinationWidth);
      const bottom = Math.ceil(destination.y * ratio + destinationHeight);
      this.committedContext.clearRect(left, top, right - left, bottom - top);
      this.committedContext.drawImage(
        tile.canvas,
        destination.x * ratio,
        destination.y * ratio,
        destinationWidth,
        destinationHeight,
      );
      this.committedRasterTiles.setResidency(key, 'visible');
      for (const [strokeId, digest] of tile.digests) {
        visibleStrokeIds.add(strokeId);
        this.renderedDigests.set(strokeId, digest);
      }
    }
    this.committedContext.restore();
    return visibleStrokeIds.size;
  }

  private advanceCommittedRasterTile(
    key: string,
    bounds: InkRasterTileBounds,
    rasterDensity: number,
    residency: InkRasterTileResidency = 'visible',
  ): 'fallback' | 'pending' {
    const pending = this.committedRasterBuild;
    if (pending !== null && pending.key !== key) this.cancelCommittedRasterBuild();
    const current = this.committedRasterBuild;
    if (current === null) {
      return this.startCommittedRasterTile(key, bounds, rasterDensity, residency);
    }
    try {
      if (current.pendingGeometry !== null) {
        drawCompiled(current.context, current.pendingGeometry, false);
        current.digests.push([current.pendingGeometry.strokeId, current.pendingGeometry.digest]);
        current.pendingGeometry = null;
        current.nextRef += 1;
        return 'pending';
      }
      const ref = current.refs[current.nextRef];
      if (ref !== undefined) {
        current.pendingGeometry = this.compileRef(ref, true);
        return 'pending';
      }
      return this.finishCommittedRasterTile(current);
    } catch (error) {
      this.cancelCommittedRasterBuild();
      throw error;
    }
  }

  private startCommittedRasterTile(
    key: string,
    bounds: InkRasterTileBounds,
    rasterDensity: number,
    residency: InkRasterTileResidency,
  ): 'fallback' | 'pending' {
    const canvas = this.document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(bounds.width * rasterDensity));
    canvas.height = Math.max(1, Math.ceil(bounds.height * rasterDensity));
    const context = canvas.getContext('2d');
    if (context === null) {
      canvas.width = 0;
      canvas.height = 0;
      return 'fallback';
    }
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.setTransform(
      rasterDensity,
      0,
      0,
      rasterDensity,
      -bounds.x * rasterDensity,
      -bounds.y * rasterDensity,
    );
    const refs = ordered(this.query(bounds)).filter(
      ({ bounds: strokeBounds, id }) =>
        !this.excludedCommittedIds.has(id) && intersects(strokeBounds, bounds),
    );
    const drawableRefs = refs.filter(({ stroke }) => stroke.tool !== 'eraser');
    try {
      this.committedRasterBuildMemory.setBytes(canvas.width * canvas.height * 4);
    } catch {
      canvas.width = 0;
      canvas.height = 0;
      return 'fallback';
    }
    this.rasterTileRebuildCount += 1;
    this.committedRasterBuild = {
      bounds: Object.freeze({ ...bounds }),
      canvas,
      context,
      digests: [],
      key,
      nextRef: 0,
      pendingGeometry: null,
      residency,
      refs: drawableRefs,
    };
    return 'pending';
  }

  private finishCommittedRasterTile(build: CommittedRasterTileBuildState): 'fallback' | 'pending' {
    const tile: CommittedRasterTile = Object.freeze({
      bounds: build.bounds,
      canvas: build.canvas,
      digests: Object.freeze(build.digests),
    });
    const byteSize = build.canvas.width * build.canvas.height * 4;
    this.committedRasterBuild = null;
    this.committedRasterBuildMemory.setBytes(0);
    if (!this.committedRasterTiles.put(build.key, tile, build.bounds, byteSize, build.residency)) {
      return 'fallback';
    }
    build.canvas.className = 'inkstone-ink-committed-tile';
    build.canvas.dataset.inkstoneCommittedTile = build.key;
    build.canvas.hidden = true;
    build.canvas.style.height = `${build.bounds.height}px`;
    build.canvas.style.position = 'absolute';
    build.canvas.style.transform = `translate3d(${build.bounds.x}px, ${build.bounds.y}px, 0)`;
    build.canvas.style.transformOrigin = '0 0';
    build.canvas.style.width = `${build.bounds.width}px`;
    this.committedTileScene.append(build.canvas);
    return 'pending';
  }

  private cancelCommittedRasterBuild(): void {
    const build = this.committedRasterBuild;
    if (build === null) return;
    this.committedRasterBuild = null;
    this.committedRasterBuildMemory.setBytes(0);
    build.canvas.width = 0;
    build.canvas.height = 0;
  }

  private planCommittedRasterPrefetch(frame: InkStageFrame, lod: number | undefined): void {
    this.planCommittedRasterPrefetchDemand(frame, lod, false);
  }

  private planCommittedRasterMotionPrefetch(frame: InkStageFrame, lod: number | undefined): void {
    if (
      lod === undefined ||
      this.workScheduler === null ||
      this.committedTileScene.hidden ||
      this.active !== null ||
      this.activePerformanceContact !== null
    ) {
      return;
    }
    const viewport = createInkNoteLogicalRect({
      height: frame.logicalViewport.height,
      width: frame.logicalViewport.width,
      x: frame.logicalViewport.left,
      y: frame.logicalViewport.top,
    });
    const addressed = COMMITTED_RASTER_TILE_GRID.addresses(viewport, lod);
    if (addressed.kind === 'untileable-range') return;
    const first = addressed.coordinates[0];
    const last = addressed.coordinates.at(-1);
    const demandKey =
      first === undefined || last === undefined
        ? `${lod}:empty`
        : `${lod}:${first.column}:${first.row}:${last.column}:${last.row}`;
    if (demandKey === this.committedRasterMotionDemandKey) return;
    this.committedRasterMotionDemandKey = demandKey;
    this.planCommittedRasterPrefetchDemand(frame, lod, true);
  }

  private planCommittedRasterPrefetchDemand(
    frame: InkStageFrame,
    lod: number | undefined,
    includeVisible: boolean,
  ): void {
    this.invalidateCommittedRasterPrefetchTask();
    if (lod === undefined) {
      this.pendingCommittedPrefetchRegions = [];
      return;
    }
    if (this.committedRasterPrefetchAdmissionBlocked) {
      this.pendingCommittedPrefetchRegions = [];
      return;
    }
    const viewport = createInkNoteLogicalRect({
      height: frame.logicalViewport.height,
      width: frame.logicalViewport.width,
      x: frame.logicalViewport.left,
      y: frame.logicalViewport.top,
    });
    const plan = COMMITTED_RASTER_DEMAND_PLANNER.plan({
      lod,
      ...(this.lastCommittedViewport === null
        ? {}
        : { previousViewport: this.lastCommittedViewport }),
      viewport,
    });
    this.lastCommittedViewport = viewport;
    if (plan.kind === 'untileable-range') {
      this.pendingCommittedPrefetchRegions = [];
      return;
    }
    if (!includeVisible) this.committedRasterMotionDemandKey = null;
    this.prefetchedCommittedLod = lod;
    const visibleRegions = includeVisible
      ? committedRasterRegionsForCoordinates(plan.visible, this.editTileContentIndex)
      : [];
    this.pendingCommittedPrefetchRegions = [
      ...visibleRegions,
      ...committedRasterRegionsForCoordinates(
        [...plan.nearVisible, ...plan.lookAhead],
        this.editTileContentIndex,
      ),
    ];
    if (includeVisible) {
      const demandedVisibleKeys = new Set(visibleRegions.map(({ key }) => key));
      for (const key of this.presentedCommittedTileKeys) {
        this.committedRasterTiles.setResidency(
          key,
          demandedVisibleKeys.has(key) ? 'visible' : 'near-visible',
        );
      }
    }
    this.scheduleCommittedRasterPrefetch();
  }

  private scheduleCommittedRasterPrefetch(): void {
    const scheduler = this.workScheduler;
    if (
      scheduler === null ||
      this.disposed ||
      this.active !== null ||
      this.activePerformanceContact !== null ||
      this.pendingCommittedPrefetchRegions.length === 0 ||
      this.committedRasterPrefetchScheduledGeneration !== null
    ) {
      return;
    }
    const generation = this.committedRasterPrefetchGeneration;
    this.committedRasterPrefetchScheduledGeneration = generation;
    void scheduler
      .schedule({
        isCurrent: () =>
          !this.disposed &&
          generation === this.committedRasterPrefetchGeneration &&
          this.active === null &&
          this.activePerformanceContact === null,
        lane: 'cold',
        unitKinds: ['edit-tile-prefetch-unit'],
        units: [() => this.advanceCommittedRasterPrefetch()],
      })
      .then(
        () => this.completeCommittedRasterPrefetchTask(generation),
        (error: unknown) => {
          if (this.committedRasterPrefetchScheduledGeneration === generation) {
            this.committedRasterPrefetchScheduledGeneration = null;
          }
          this.pendingCommittedPrefetchRegions = [];
          this.onDiagnostic(
            `Committed raster prefetch stopped after a cold-lane failure: ${
              error instanceof Error ? error.message : 'unknown failure'
            }`,
          );
        },
      );
  }

  private completeCommittedRasterPrefetchTask(generation: number): void {
    if (this.committedRasterPrefetchScheduledGeneration !== generation) return;
    this.committedRasterPrefetchScheduledGeneration = null;
    if (generation !== this.committedRasterPrefetchGeneration || this.disposed) return;
    this.scheduleCommittedRasterPrefetch();
  }

  private invalidateCommittedRasterPrefetchTask(): void {
    this.committedRasterPrefetchGeneration += 1;
    this.committedRasterPrefetchScheduledGeneration = null;
    if (this.committedRasterBuild?.residency === 'near-visible') {
      this.cancelCommittedRasterBuild();
    }
  }

  private advanceCommittedRasterPrefetch(): boolean {
    const region = this.pendingCommittedPrefetchRegions[0];
    if (region === undefined) return false;
    if (
      this.presentedCommittedTileKeys.has(region.key) ||
      this.prefetchedCommittedTileKeys.has(region.key)
    ) {
      this.pendingCommittedPrefetchRegions = this.pendingCommittedPrefetchRegions.slice(1);
      return this.pendingCommittedPrefetchRegions.length > 0;
    }
    if (this.committedRasterBuild?.key !== region.key) {
      const tile = this.committedRasterTiles.get(region.key);
      if (tile !== null) {
        tile.canvas.hidden = false;
        // Once a tile is exposed it is presentation truth, not merely speculative cache data.
        // Keep it pinned until an exact replacement is ready; document damage must never turn a
        // currently visible tile into a blank region.
        this.committedRasterTiles.setResidency(region.key, 'visible');
        this.prefetchedCommittedTileKeys.add(region.key);
        this.presentedCommittedTileKeys.add(region.key);
        this.pendingCommittedPrefetchRegions = this.pendingCommittedPrefetchRegions.slice(1);
        return this.pendingCommittedPrefetchRegions.length > 0;
      }
    }
    const outcome = this.advanceCommittedRasterTile(
      region.key,
      region.bounds,
      region.rasterDensity,
      'near-visible',
    );
    if (outcome === 'fallback') {
      this.pendingCommittedPrefetchRegions = [];
      this.committedRasterPrefetchAdmissionBlocked = true;
      return false;
    }
    return true;
  }

  private resetCommittedRasterPrefetch(resetViewport: boolean): void {
    this.invalidateCommittedRasterPrefetchTask();
    this.pendingCommittedPrefetchRegions = [];
    for (const child of this.committedTileScene.children) {
      if (
        child instanceof HTMLCanvasElement &&
        this.prefetchedCommittedTileKeys.has(child.dataset.inkstoneCommittedTile ?? '') &&
        !this.presentedCommittedTileKeys.has(child.dataset.inkstoneCommittedTile ?? '')
      ) {
        child.hidden = true;
      }
    }
    this.prefetchedCommittedTileKeys.clear();
    this.prefetchedCommittedLod = null;
    this.committedRasterMotionDemandKey = null;
    this.committedRasterPrefetchAdmissionBlocked = false;
    if (resetViewport) this.lastCommittedViewport = null;
  }

  private drawDocumentChange(frame: InkStageFrame, change: InkDocumentChange): number {
    const addedOnly = isAddedOnlyDocumentChange(change);
    if (addedOnly) {
      this.committedCanvas.hidden = false;
      const added = new Set(change.addedIds);
      const changedRefs = refsForChange(this.query, change);
      const refs = (
        changedRefs.length === 0 ? this.query(logicalViewport(frame)) : changedRefs
      ).filter(({ id }) => added.has(id) && !this.excludedCommittedIds.has(id));
      for (const ref of refs) {
        const visible = intersects(ref.bounds, logicalViewport(frame));
        const geometry = this.compileRef(ref, visible);
        const alreadyPresented = this.presentedPromotionDigests.get(ref.id) === geometry.digest;
        if (visible && !alreadyPresented) {
          drawCompiled(this.committedContext, geometry, false);
        }
        if (visible || alreadyPresented) this.renderedDigests.set(ref.id, geometry.digest);
      }
      return refs.filter(({ bounds }) => intersects(bounds, logicalViewport(frame))).length;
    }
    const dirty = changeBounds(change);
    if (dirty === null) return 0;
    return this.redrawCommittedBounds(frame, dirty);
  }

  private hasMatchingActivePromotion(change: InkDocumentChange): boolean {
    if (!isAddedOnlyDocumentChange(change)) return false;
    const activeStrokeId = this.active?.presentationState.strokeId ?? null;
    return change.addedIds.every(
      (strokeId) => strokeId === activeStrokeId || this.presentedPromotionDigests.has(strokeId),
    );
  }

  private redrawCommittedBounds(frame: InkStageFrame, dirty: InkGeometryBounds): number {
    clearLogicalRect(this.committedContext, dirty, frame, this.dpr());
    const refs = ordered(this.query(dirty)).filter(
      ({ bounds, id }) =>
        !this.excludedCommittedIds.has(id) && intersects(bounds, logicalViewport(frame)),
    );
    for (const ref of refs) this.drawCommittedRef(ref, true);
    return refs.length;
  }

  private drawCommittedRef(ref: InkRenderableStrokeRef, visible: boolean): void {
    if (ref.stroke.tool === 'eraser') return;
    const geometry = this.compileRef(ref, visible);
    drawCompiled(this.committedContext, geometry, false);
    this.renderedDigests.set(ref.id, geometry.digest);
  }

  private compileRef(ref: InkRenderableStrokeRef, visible: boolean): CompiledInkStroke {
    const generation = this.strokeGenerations.get(ref.id) ?? 0;
    const key = renderGeometryCacheKey(ref.stroke, generation);
    const cached = this.cache.get(key);
    if (cached !== null) return cached;
    this.committedCompileCount += 1;
    const geometry = this.compile(ref.stroke);
    this.cache.put(key, geometry, visible);
    return geometry;
  }

  private compile(stroke: InkStroke): CompiledInkStroke {
    if (
      stroke.brushRenderVersion !== undefined &&
      stroke.brushRenderVersion !== 'legacy-round-v1'
    ) {
      const result = this.sharedGeometry.compile(stroke);
      if (!('geometry' in result)) {
        throw new Error(
          `Unsupported Ink Brush Geometry ${result.requestedVersion}: ${result.reason}.`,
        );
      }
      if (result.kind === 'degraded') {
        this.onDiagnostic(
          `Known ${result.requestedVersion} geometry failed for ${stroke.id}; using its typed degradation.`,
        );
      }
      return compiledSharedBrushStroke(stroke, result.geometry);
    }
    try {
      return this.geometry.compile(stroke);
    } catch {
      this.onDiagnostic(`Known legacy Ink geometry failed for ${stroke.id}; using fallback.`);
      const fallback = deterministicFallback(stroke);
      return new LegacyRoundInkStrokeGeometry().compile(fallback);
    }
  }

  private drawActive(frame: InkStageFrame): ActiveDrawResult {
    const active = this.active;
    if (active === null) return 'none';
    if (active.physicalGeometryState !== null) {
      return this.drawPhysicalActive(frame, active, active.physicalGeometryState);
    }
    if (this.activePair.kind === 'worker-offscreen-2d') {
      return this.drawWorkerActive(this.activePair, active);
    }
    const submitted =
      active.pendingFullRedraw ||
      active.pendingTailRedraw ||
      active.paintedStablePointCount < active.stablePoints.length;
    if (active.pendingFullRedraw) {
      this.clearActiveLayers();
      active.paintedStablePointCount = 0;
      active.lastPaintedTailBounds = null;
      active.pendingTailRedraw = true;
    }

    let submittedSegments = 0;
    if (active.paintedStablePointCount < active.stablePoints.length) {
      const firstPendingPoint =
        active.paintedStablePointCount === 0 ? 0 : active.paintedStablePointCount - 1;
      this.drawActivePath(
        this.activeStableContext,
        active,
        active.stablePoints,
        frame,
        firstPendingPoint,
      );
      submittedSegments += Math.max(1, active.stablePoints.length - firstPendingPoint - 1);
      active.paintedStablePointCount = active.stablePoints.length;
    }

    if (active.pendingTailRedraw) {
      const nextTailBounds =
        active.presentationTail.length === 0
          ? null
          : boundsForPointPath(active.presentationTail, active.presentationState.width);
      const dirtyTailBounds = unionBounds(active.lastPaintedTailBounds, nextTailBounds);
      if (dirtyTailBounds !== null) {
        clearLogicalRect(this.activeContext, dirtyTailBounds, frame, this.dpr());
      }
      if (active.presentationTail.length > 0) {
        this.drawActivePath(this.activeContext, active, active.presentationTail, frame);
        submittedSegments += Math.max(1, active.presentationTail.length - 1);
      }
      if (active.presentationState.tool === 'eraser' && active.startPoint !== null) {
        drawEraserStart(
          this.activeContext,
          active.startPoint,
          active.eraserColor ?? active.presentationState.paint.color,
          frame.actualScale,
        );
      }
      active.lastPaintedTailBounds = nextTailBounds;
    }

    this.lastActiveSubmittedSegmentCount = submittedSegments;
    active.pendingFullRedraw = false;
    active.pendingTailRedraw = false;
    return submitted ? 'main-submitted' : 'none';
  }

  private drawPhysicalActive(
    frame: InkStageFrame,
    active: ActiveRenderState,
    physical: PhysicalActiveGeometryState,
  ): ActiveDrawResult {
    if (this.activePair.kind !== 'main-2d') {
      throw new Error('Physical Active Ink requires the main Canvas presentation pair.');
    }
    const submitted =
      active.pendingFullRedraw ||
      active.pendingTailRedraw ||
      physical.paintedStableCoverageCount < physical.stableCoverage.length;
    if (active.pendingFullRedraw) {
      this.clearActiveLayers();
      physical.paintedStableCoverageCount = 0;
      physical.lastPaintedMutableBounds = null;
      active.paintedStablePointCount = 0;
      active.lastPaintedTailBounds = null;
      active.pendingTailRedraw = true;
    }

    let submittedContours = 0;
    if (physical.paintedStableCoverageCount < physical.stableCoverage.length) {
      const pending = physical.stableCoverage.slice(physical.paintedStableCoverageCount);
      drawPhysicalFilledCoverage(
        this.activeStableContext,
        pending,
        physical.logicalGrid,
        physical.color,
      );
      submittedContours += countPhysicalContours(pending);
      physical.paintedStableCoverageCount = physical.stableCoverage.length;
    }

    if (active.pendingTailRedraw) {
      const nextBounds = boundsForPhysicalCoverage(physical.mutableCoverage, physical.logicalGrid);
      const dirtyBounds = unionBounds(physical.lastPaintedMutableBounds, nextBounds);
      if (dirtyBounds !== null) {
        clearLogicalRect(this.activeContext, dirtyBounds, frame, this.dpr());
      }
      if (physical.mutableCoverage.length > 0) {
        drawPhysicalFilledCoverage(
          this.activeContext,
          physical.mutableCoverage,
          physical.logicalGrid,
          physical.color,
        );
        submittedContours += countPhysicalContours(physical.mutableCoverage);
      }
      physical.lastPaintedMutableBounds = nextBounds;
    }

    this.lastActiveSubmittedSegmentCount = submittedContours;
    active.paintedStablePointCount = active.stablePoints.length;
    active.pendingFullRedraw = false;
    active.pendingTailRedraw = false;
    return submitted ? 'main-submitted' : 'none';
  }

  /**
   * A Pencil down must not wait behind an already queued history frame. Submit only the tiny
   * Active layer synchronously; committed work remains deferred until contact release.
   */
  private submitFirstPhysicalFrame(): boolean {
    const frame = this.frame;
    if (
      this.disposed ||
      frame === null ||
      this.configuredDpr === 0 ||
      this.lostContexts.size > 0 ||
      this.activePair.kind !== 'main-2d'
    ) {
      return false;
    }
    let activeDraw: ActiveDrawResult;
    try {
      activeDraw = this.drawActive(frame);
    } catch {
      return false;
    }
    if (activeDraw !== 'main-submitted') return false;
    const submittedThroughGeneration = this.pendingPresentationGeneration;
    this.pendingPresentationGeneration = null;
    this.recordActiveFrameDebt(this.now());
    this.onActiveFrame(submittedThroughGeneration);
    return submittedThroughGeneration !== null;
  }

  private drawWorkerActive(
    pair: WorkerActiveCanvasPair,
    active: ActiveRenderState,
  ): ActiveDrawResult {
    const contactSequence = pair.contactSequence;
    const generation = this.pendingPresentationGeneration;
    const submitted =
      active.pendingFullRedraw ||
      active.pendingTailRedraw ||
      active.paintedStablePointCount < active.stablePoints.length;
    if (!submitted || contactSequence === null || generation === null) return 'none';
    const stableStart = active.paintedStablePointCount;
    let result: InkWorkerPresentationSubmitResult;
    try {
      result = pair.adapter.submit({
        generation,
        provisionalPoints: active.provisionalPoints,
        stablePoints: new InkPointPathWindow(active.stablePoints, stableStart),
        stableStart,
        tailPoints: active.mutablePath,
      });
    } catch {
      result = { kind: 'unavailable' };
    }
    if (result.kind !== 'submitted-async') {
      if (this.activePair === pair) {
        this.retirePendingWorkerGeneration();
        this.fallbackWorkerPairToMain(pair);
      }
      return 'none';
    }
    active.paintedStablePointCount = active.stablePoints.length;
    active.pendingFullRedraw = false;
    active.pendingTailRedraw = false;
    active.lastPaintedTailBounds =
      active.presentationTail.length === 0
        ? null
        : boundsForPointPath(active.presentationTail, active.presentationState.width);
    this.lastActiveSubmittedSegmentCount = result.submittedSegmentCount;
    const pending: PendingWorkerPresentationAck = {
      contactSequence,
      frameEpoch: pair.frameEpoch,
      generation,
      packetSequence: result.packetSequence,
      presentationRevision: active.presentationRevision,
      sessionToken: pair.sessionToken,
    };
    this.pendingWorkerAck = pending;
    this.armWorkerAckDeadline(pending);
    return 'worker-submitted';
  }

  private drawActivePath(
    context: CanvasRenderingContext2D,
    active: ActiveRenderState,
    points: InkPointPath,
    frame: InkStageFrame,
    firstPoint = 0,
  ): void {
    if (active.presentationState.tool !== 'eraser') {
      drawPath(
        context,
        points,
        active.presentationState.paint.color,
        active.presentationState.width,
        1,
        firstPoint,
      );
      return;
    }
    const scale =
      Number.isFinite(frame.actualScale) && frame.actualScale > 0 ? frame.actualScale : 1;
    context.save();
    context.setLineDash([6 / scale, 4 / scale]);
    drawPath(
      context,
      points,
      active.eraserColor ?? active.presentationState.paint.color,
      active.presentationState.width,
      1,
      firstPoint,
    );
    context.restore();
  }

  private drawOverlay(frame: InkStageFrame): void {
    if (this.active !== null || !this.overlayPending) return;
    const nextBounds = overlayGeometryBounds(this.overlay);
    const dirty = unionBounds(this.overlayBounds, nextBounds);
    if (dirty !== null) clearLogicalRect(this.activeContext, dirty, frame, this.dpr());
    this.activeStack.style.opacity = '1';
    for (const ref of this.overlay.hovered) {
      const geometry = this.compileRef(ref, true);
      const brushGeometry = geometry.promotedBrushGeometry ?? geometry.brushGeometry;
      if (brushGeometry === undefined) {
        drawPath(
          this.activeContext,
          geometry.points,
          'rgba(79, 70, 229, 0.3)',
          geometry.width + 4,
          1,
        );
      } else {
        drawInkBrushSelectionChromeToCanvas(
          this.activeContext,
          brushGeometry,
          'rgba(79, 70, 229, 0.3)',
          2,
        );
      }
      drawCompiled(this.activeContext, geometry, false);
    }
    for (const ref of this.overlay.selected) {
      const geometry = this.compileRef(ref, true);
      const brushGeometry = geometry.promotedBrushGeometry ?? geometry.brushGeometry;
      if (brushGeometry === undefined) {
        drawPath(
          this.activeContext,
          geometry.points,
          'rgba(79, 70, 229, 0.45)',
          geometry.width + 8,
          1,
        );
      } else {
        drawInkBrushSelectionChromeToCanvas(
          this.activeContext,
          brushGeometry,
          'rgba(79, 70, 229, 0.45)',
          4,
        );
      }
      drawCompiled(this.activeContext, geometry, false);
    }
    this.overlayBounds = nextBounds;
    this.overlayPending = false;
  }

  private completePromotion(): void {
    let completedActivePromotion = false;
    for (const [strokeId, digest] of this.pendingPromotions) {
      const renderedDigest = this.renderedDigests.get(strokeId);
      if (renderedDigest !== digest) {
        if (renderedDigest !== undefined) {
          this.onDiagnostic(`Ink promotion digest mismatch for ${strokeId}; active retained.`);
        }
        continue;
      }
      this.pendingPromotions.delete(strokeId);
      if (this.active?.presentationState.strokeId === strokeId) {
        completedActivePromotion = true;
      }
    }
    if (!completedActivePromotion) return;
    if (this.activePair.kind === 'worker-offscreen-2d') {
      this.retirePendingWorkerGeneration();
    }
    this.clearActivePrediction();
    this.active = null;
    this.activeStack.style.opacity = '1';
    this.clearActiveLayers();
    this.overlayBounds = null;
    this.overlayPending = true;
    this.applyDeferredViewportMutation();
    this.tryActivatePreparedWorker();
  }

  private presentPromotingActive(active: ActiveRenderState): void {
    const finalized = active.finalized;
    if (
      finalized === null ||
      this.frame === null ||
      this.lostContexts.has(this.committedCanvas) ||
      this.presentedPromotionDigests.get(finalized.strokeId) === finalized.digest
    ) {
      return;
    }
    this.committedCanvas.hidden = false;
    drawCompiled(this.committedContext, finalized, false);
    this.presentedPromotionDigests.set(finalized.strokeId, finalized.digest);
    this.renderedDigests.set(finalized.strokeId, finalized.digest);
  }

  private retirePromotingActive(): void {
    if (this.active === null) return;
    if (this.activePair.kind === 'worker-offscreen-2d') {
      this.retirePendingWorkerGeneration();
    }
    this.clearActivePrediction();
    this.active = null;
    this.activeStack.style.opacity = '1';
    this.clearActiveLayers();
    this.overlayBounds = null;
    this.overlayPending = true;
  }

  private clearActiveLayers(): void {
    if (this.activePair.kind === 'worker-offscreen-2d') {
      this.cancelWorkerAckDeadline();
      this.activePair.adapter.reset();
      this.activePair.contactSequence = null;
      this.pendingWorkerAck = null;
      return;
    }
    if (this.activePair.kind === 'worker-activating') return;
    clearCanvas(this.activePair.stable, this.activePair.stableContext);
    clearCanvas(this.activePair.tail, this.activePair.tailContext);
  }

  private clearActivePrediction(): void {
    const active = this.active;
    if (active === null || active.provisionalPoints.length === 0) return;
    active.provisionalPoints.reset();
    active.pendingTailRedraw = true;
  }
}

function createCanvas(
  document: Document,
  layer: 'active' | 'active-stable' | 'committed',
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = `inkstone-ink-canvas inkstone-ink-canvas-${layer}`;
  if (layer === 'active') canvas.dataset.inkstoneInkActive = 'true';
  if (layer === 'active-stable') canvas.dataset.inkstoneInkActiveStable = 'true';
  if (layer === 'committed') canvas.dataset.inkstoneInkCommitted = 'true';
  canvas.style.pointerEvents = 'none';
  canvas.style.opacity = '1';
  return canvas;
}

function createCommittedTileScene(document: Document): HTMLElement {
  const scene = document.createElement('div');
  scene.className = 'inkstone-ink-committed-tile-scene';
  scene.dataset.inkstoneCommittedTileScene = 'true';
  scene.hidden = true;
  scene.style.inset = '0';
  scene.style.overflow = 'visible';
  scene.style.pointerEvents = 'none';
  scene.style.position = 'absolute';
  scene.style.transformOrigin = '0 0';
  scene.style.willChange = 'transform';
  return scene;
}

function createMainActiveCanvasPair(document: Document): MainActiveCanvasPair {
  const stable = createCanvas(document, 'active-stable');
  const tail = createCanvas(document, 'active');
  return {
    backingHeight: tail.height,
    backingWidth: tail.width,
    kind: 'main-2d',
    stable,
    stableContext: requireContext(stable),
    tail,
    tailContext: requireContext(tail),
  };
}

function releaseMainActivePairBackingStores(pair: MainActiveCanvasPair): void {
  pair.stable.width = 0;
  pair.stable.height = 0;
  pair.tail.width = 0;
  pair.tail.height = 0;
  pair.backingWidth = 0;
  pair.backingHeight = 0;
}

function createActiveStack(document: Document): HTMLElement {
  const stack = document.createElement('div');
  stack.className = 'inkstone-ink-active-stack';
  stack.style.opacity = '1';
  stack.style.pointerEvents = 'none';
  return stack;
}

function hasOverlayRequirement(overlay: InkRenderOverlay): boolean {
  return overlay.hovered.length > 0 || overlay.selected.length > 0;
}

function boundedWorkerAckDeadline(options: InkWorkerPresentationRuntimeOptions): number {
  const refreshInterval =
    Number.isFinite(options.refreshIntervalMs) && (options.refreshIntervalMs ?? 0) > 0
      ? (options.refreshIntervalMs as number)
      : DEFAULT_WORKER_REFRESH_INTERVAL_MS;
  const requested = options.ackDeadlineMs ?? refreshInterval * 3;
  return Math.min(5_000, Math.max(1, Math.round(requested)));
}

const ACTIVE_POINT_CHUNK_SIZE = 256;
const ACTIVE_POINT_WIDTH = 6;
const ACTIVE_TAIL_POINT_CAPACITY = 9;
const ACTIVE_PROVISIONAL_POINT_CAPACITY = 16;
const TILT_X_PRESENT = 1 << 0;
const TILT_Y_PRESENT = 1 << 1;
const KNOWN_SAMPLE_FLAGS =
  INK_SAMPLE_FLAGS.pressureMeasured |
  INK_SAMPLE_FLAGS.altitudeMeasured |
  INK_SAMPLE_FLAGS.azimuthMeasured;

interface MutableInkCoordinateCursor {
  x: number;
  y: number;
}

class ChunkedNumericActivePath implements InkPointPath {
  private readonly chunks: Float64Array[] = [];
  private readonly cursor: MutableInkCoordinateCursor = createInkCoordinateCursor();
  private readonly flags: Uint8Array[] = [];
  private itemCount = 0;

  constructor(readonly encoding: ActiveNumericPathEncoding) {}

  get chunkCount(): number {
    return this.chunks.length;
  }

  get byteSizeEstimate(): number {
    return (
      this.itemCount * (ACTIVE_POINT_WIDTH * Float64Array.BYTES_PER_ELEMENT + 1) +
      this.chunks.length * 64
    );
  }

  get length(): number {
    return this.itemCount;
  }

  append(point: InkPoint): void {
    this.assertEncoding('legacy-ink-point');
    const chunkIndex = Math.floor(this.itemCount / ACTIVE_POINT_CHUNK_SIZE);
    const itemIndex = this.itemCount % ACTIVE_POINT_CHUNK_SIZE;
    let chunk = this.chunks[chunkIndex];
    let flagChunk = this.flags[chunkIndex];
    if (chunk === undefined || flagChunk === undefined) {
      chunk = new Float64Array(ACTIVE_POINT_CHUNK_SIZE * ACTIVE_POINT_WIDTH);
      flagChunk = new Uint8Array(ACTIVE_POINT_CHUNK_SIZE);
      this.chunks.push(chunk);
      this.flags.push(flagChunk);
    }
    writeNumericLegacyInkPoint(chunk, flagChunk, itemIndex, point);
    this.itemCount += 1;
  }

  appendCursor(sample: InkSampleCursor): void {
    this.assertEncoding('raw-spherical-sample');
    const chunkIndex = Math.floor(this.itemCount / ACTIVE_POINT_CHUNK_SIZE);
    const itemIndex = this.itemCount % ACTIVE_POINT_CHUNK_SIZE;
    let chunk = this.chunks[chunkIndex];
    let flagChunk = this.flags[chunkIndex];
    if (chunk === undefined || flagChunk === undefined) {
      chunk = new Float64Array(ACTIVE_POINT_CHUNK_SIZE * ACTIVE_POINT_WIDTH);
      flagChunk = new Uint8Array(ACTIVE_POINT_CHUNK_SIZE);
      this.chunks.push(chunk);
      this.flags.push(flagChunk);
    }
    writeNumericRawSample(chunk, flagChunk, itemIndex, sample);
    this.itemCount += 1;
  }

  at(index: number): Pick<InkPoint, 'x' | 'y'> | undefined {
    const normalized = index < 0 ? this.itemCount + index : index;
    if (normalized < 0 || normalized >= this.itemCount) return undefined;
    const chunkIndex = Math.floor(normalized / ACTIVE_POINT_CHUNK_SIZE);
    const itemIndex = normalized % ACTIVE_POINT_CHUNK_SIZE;
    const chunk = this.chunks[chunkIndex];
    if (chunk === undefined) return undefined;
    return readNumericCoordinate(chunk, itemIndex, this.cursor);
  }

  sameLast(point: InkPoint): boolean {
    this.assertEncoding('legacy-ink-point');
    if (this.itemCount === 0) return false;
    const index = this.itemCount - 1;
    const chunkIndex = Math.floor(index / ACTIVE_POINT_CHUNK_SIZE);
    const itemIndex = index % ACTIVE_POINT_CHUNK_SIZE;
    const chunk = this.chunks[chunkIndex];
    const flags = this.flags[chunkIndex]?.[itemIndex];
    return (
      chunk !== undefined &&
      flags !== undefined &&
      sameStoredLegacyInkPoint(chunk, flags, itemIndex, point)
    );
  }

  sameLastCursor(sample: InkSampleCursor): boolean {
    this.assertEncoding('raw-spherical-sample');
    if (this.itemCount === 0) return false;
    const index = this.itemCount - 1;
    const chunkIndex = Math.floor(index / ACTIVE_POINT_CHUNK_SIZE);
    const itemIndex = index % ACTIVE_POINT_CHUNK_SIZE;
    const chunk = this.chunks[chunkIndex];
    const flags = this.flags[chunkIndex]?.[itemIndex];
    if (chunk === undefined || flags === undefined) return false;
    return sameStoredRawSample(chunk, flags, itemIndex, sample);
  }

  private assertEncoding(expected: ActiveNumericPathEncoding): void {
    if (this.encoding !== expected) {
      throw new Error(`Ink numeric path is ${this.encoding}, not ${expected}.`);
    }
  }
}

class FixedNumericActivePath implements InkPointPath {
  private readonly cursor: MutableInkCoordinateCursor = createInkCoordinateCursor();
  private readonly flags = new Uint8Array(ACTIVE_TAIL_POINT_CAPACITY);
  private itemCount = 0;
  private readonly values = new Float64Array(ACTIVE_TAIL_POINT_CAPACITY * ACTIVE_POINT_WIDTH);

  constructor(readonly encoding: ActiveNumericPathEncoding) {}

  get byteSizeEstimate(): number {
    return this.values.byteLength + this.flags.byteLength;
  }

  get length(): number {
    return this.itemCount;
  }

  at(index: number): Pick<InkPoint, 'x' | 'y'> | undefined {
    const normalized = index < 0 ? this.itemCount + index : index;
    if (normalized < 0 || normalized >= this.itemCount) return undefined;
    return readNumericCoordinate(this.values, normalized, this.cursor);
  }

  replace(points: readonly InkPoint[]): void {
    this.assertEncoding('legacy-ink-point');
    if (points.length > ACTIVE_TAIL_POINT_CAPACITY) {
      throw new Error('Active Ink mutable path exceeds its numeric ring capacity.');
    }
    this.itemCount = points.length;
    for (const [index, point] of points.entries()) {
      writeNumericLegacyInkPoint(this.values, this.flags, index, point);
    }
  }

  reset(): void {
    this.itemCount = 0;
  }

  appendCursor(sample: InkSampleCursor): void {
    this.assertEncoding('raw-spherical-sample');
    if (this.itemCount >= ACTIVE_TAIL_POINT_CAPACITY) {
      throw new Error('Active Ink mutable path exceeds its numeric ring capacity.');
    }
    writeNumericRawSample(this.values, this.flags, this.itemCount, sample);
    this.itemCount += 1;
  }

  private assertEncoding(expected: ActiveNumericPathEncoding): void {
    if (this.encoding !== expected) {
      throw new Error(`Ink numeric path is ${this.encoding}, not ${expected}.`);
    }
  }
}

class FixedNumericProvisionalPath implements InkPointPath {
  private copyFailed = false;
  private copyIndex = 0;
  private readonly cursor: MutableInkCoordinateCursor = createInkCoordinateCursor();
  private itemCount = 0;
  private readonly values = new Float64Array(ACTIVE_PROVISIONAL_POINT_CAPACITY * 2);
  private readonly copyPoint = (x: number, y: number): void => {
    if (
      this.copyIndex >= ACTIVE_PROVISIONAL_POINT_CAPACITY ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      this.copyFailed = true;
      return;
    }
    const offset = this.copyIndex * 2;
    this.values[offset] = x;
    this.values[offset + 1] = y;
    this.copyIndex += 1;
  };

  get byteSizeEstimate(): number {
    return this.values.byteLength + 32;
  }

  get length(): number {
    return this.itemCount;
  }

  at(index: number): Pick<InkPoint, 'x' | 'y'> | undefined {
    const normalized = index < 0 ? this.itemCount + index : index;
    if (normalized < 0 || normalized >= this.itemCount) return undefined;
    const offset = normalized * 2;
    this.cursor.x = this.values[offset] as number;
    this.cursor.y = this.values[offset + 1] as number;
    return this.cursor;
  }

  replaceBorrowed(source: InkBorrowedProvisionalTail, expectedFrameEpoch: number): void {
    this.reset();
    try {
      const expectedLength = source.length;
      if (
        source.kind !== 'borrowed-provisional-prediction-tail' ||
        source.frameEpoch !== expectedFrameEpoch ||
        !Number.isSafeInteger(source.frameEpoch) ||
        source.frameEpoch < 0 ||
        !Number.isSafeInteger(expectedLength) ||
        expectedLength < 0 ||
        expectedLength > ACTIVE_PROVISIONAL_POINT_CAPACITY
      ) {
        return;
      }
      source.forEachPoint(this.copyPoint);
      if (this.copyFailed || this.copyIndex !== expectedLength) {
        this.reset();
        return;
      }
    } catch {
      this.reset();
      return;
    }
    this.itemCount = this.copyIndex;
  }

  reset(): void {
    this.itemCount = 0;
    this.copyIndex = 0;
    this.copyFailed = false;
  }
}

class ActivePresentationTailPath implements InkPointPath {
  constructor(
    private readonly stable: InkPointPath,
    private readonly confirmed: InkPointPath,
    private readonly provisional: InkPointPath,
  ) {}

  get length(): number {
    if (this.provisional.length === 0) return this.confirmed.length;
    return (
      this.confirmed.length +
      (this.confirmed.length === 0 && this.stable.length > 0 ? 1 : 0) +
      this.provisional.length
    );
  }

  at(index: number): Pick<InkPoint, 'x' | 'y'> | undefined {
    const length = this.length;
    const normalized = index < 0 ? length + index : index;
    if (normalized < 0 || normalized >= length) return undefined;
    if (normalized < this.confirmed.length) return this.confirmed.at(normalized);
    let provisionalIndex = normalized - this.confirmed.length;
    if (this.confirmed.length === 0 && this.stable.length > 0) {
      if (provisionalIndex === 0) return this.stable.at(-1);
      provisionalIndex -= 1;
    }
    return this.provisional.at(provisionalIndex);
  }
}

class RuntimeActivePresentationWriter implements InkActivePresentationWriter {
  constructor(
    private readonly stable: ChunkedNumericActivePath,
    private readonly mutable: FixedNumericActivePath,
  ) {}

  appendMutable(sample: InkSampleCursor): void {
    this.mutable.appendCursor(sample);
  }

  appendStable(sample: InkSampleCursor): void {
    if (!this.stable.sameLastCursor(sample)) this.stable.appendCursor(sample);
  }

  resetMutable(): void {
    this.mutable.reset();
  }
}

function appendStablePoint(points: ChunkedNumericActivePath, point: InkPoint): void {
  if (!points.sameLast(point)) points.append(point);
}

function ownActiveGeometryState(state: LegacyActiveGeometryState): LegacyActiveGeometryState {
  return Object.freeze({
    ...state,
    mutableTail: Object.freeze(state.mutableTail.map(ownInkPoint)),
    stableLast: state.stableLast === null ? null : ownInkPoint(state.stableLast),
  });
}

function presentationStateFromLegacy(state: LegacyActiveGeometryState): InkActivePresentationState {
  return Object.freeze({
    mutableTailSampleCount: state.mutableTail.length,
    paint: state.paint,
    stableSegmentCount: state.stableSegmentCount,
    strokeId: state.strokeId,
    tool: state.tool,
    width: state.width,
  });
}

function ownInkPoint(point: InkPoint): InkPoint {
  return Object.freeze({ ...point });
}

function borrowPhysicalCoverage(
  coverage: readonly InkBrushCoverage[],
): readonly InkFilledContourCoverage[] {
  if (coverage.some((entry) => entry.kind !== 'quantized-filled-contours')) {
    throw new Error('Physical Active Ink cannot render legacy centerline coverage.');
  }
  return coverage as readonly InkFilledContourCoverage[];
}

function drawPhysicalFilledCoverage(
  context: CanvasRenderingContext2D,
  coverage: readonly InkFilledContourCoverage[],
  logicalGrid: number,
  color: string,
): void {
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  context.fillStyle = color;
  context.beginPath();
  for (const entry of coverage) {
    for (const contour of entry.contours) {
      const first = contour[0];
      if (first === undefined) continue;
      context.moveTo(first.x * logicalGrid, first.y * logicalGrid);
      for (let index = 1; index < contour.length; index += 1) {
        const point = contour[index];
        if (point !== undefined) context.lineTo(point.x * logicalGrid, point.y * logicalGrid);
      }
      context.closePath();
    }
  }
  context.fill('nonzero');
}

function boundsForPhysicalCoverage(
  coverage: readonly InkFilledContourCoverage[],
  logicalGrid: number,
): InkGeometryBounds | null {
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const entry of coverage) {
    for (const contour of entry.contours) {
      for (const point of contour) {
        minimumX = Math.min(minimumX, point.x * logicalGrid);
        minimumY = Math.min(minimumY, point.y * logicalGrid);
        maximumX = Math.max(maximumX, point.x * logicalGrid);
        maximumY = Math.max(maximumY, point.y * logicalGrid);
      }
    }
  }
  if (!Number.isFinite(minimumX)) return null;
  // Clear one logical pixel beyond the exact contour so antialiasing cannot leave a fringe.
  return Object.freeze({
    height: maximumY - minimumY + 2,
    width: maximumX - minimumX + 2,
    x: minimumX - 1,
    y: minimumY - 1,
  });
}

function countPhysicalContours(coverage: readonly InkFilledContourCoverage[]): number {
  return coverage.reduce((count, entry) => count + entry.contours.length, 0);
}

function physicalActiveByteSize(state: PhysicalActiveGeometryState | null): number {
  if (state === null) return 0;
  return 128 + state.stableByteSize + state.mutableByteSize;
}

function physicalCoverageByteSize(coverage: readonly InkFilledContourCoverage[]): number {
  let bytes = 0;
  for (const entry of coverage) {
    bytes += 64;
    for (const contour of entry.contours) bytes += 32 + contour.length * 16;
  }
  return bytes;
}

function boundsForPointPath(points: InkPointPath, width: number): InkGeometryBounds {
  if (points.length === 0) throw new Error('Ink geometry requires at least one point.');
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error('Ink geometry width must be positive.');
  }
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const point = points.at(index);
    if (point === undefined || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error('Ink geometry points must be finite.');
    }
    minimumX = Math.min(minimumX, point.x);
    minimumY = Math.min(minimumY, point.y);
    maximumX = Math.max(maximumX, point.x);
    maximumY = Math.max(maximumY, point.y);
  }
  const radius = width / 2;
  return Object.freeze({
    height: maximumY - minimumY + width,
    width: maximumX - minimumX + width,
    x: minimumX - radius,
    y: minimumY - radius,
  });
}

function createInkCoordinateCursor(): MutableInkCoordinateCursor {
  return { x: 0, y: 0 };
}

function writeNumericLegacyInkPoint(
  values: Float64Array,
  flags: Uint8Array,
  index: number,
  point: InkPoint,
): void {
  const offset = index * ACTIVE_POINT_WIDTH;
  values[offset] = point.x;
  values[offset + 1] = point.y;
  values[offset + 2] = point.time;
  values[offset + 3] = point.pressure;
  values[offset + 4] = point.tiltX ?? 0;
  values[offset + 5] = point.tiltY ?? 0;
  flags[index] =
    (point.tiltX === undefined ? 0 : TILT_X_PRESENT) |
    (point.tiltY === undefined ? 0 : TILT_Y_PRESENT);
}

function writeNumericRawSample(
  values: Float64Array,
  flags: Uint8Array,
  index: number,
  sample: InkSampleCursor,
): void {
  const offset = index * ACTIVE_POINT_WIDTH;
  const knownFlags = sample.flags & KNOWN_SAMPLE_FLAGS;
  values[offset] = sample.x;
  values[offset + 1] = sample.y;
  values[offset + 2] = sample.time;
  values[offset + 3] = (knownFlags & INK_SAMPLE_FLAGS.pressureMeasured) === 0 ? 0 : sample.pressure;
  values[offset + 4] = (knownFlags & INK_SAMPLE_FLAGS.altitudeMeasured) === 0 ? 0 : sample.altitude;
  values[offset + 5] = (knownFlags & INK_SAMPLE_FLAGS.azimuthMeasured) === 0 ? 0 : sample.azimuth;
  flags[index] = knownFlags;
}

function readNumericCoordinate(
  values: Float64Array,
  index: number,
  target: MutableInkCoordinateCursor,
): Pick<InkPoint, 'x' | 'y'> {
  const offset = index * ACTIVE_POINT_WIDTH;
  target.x = values[offset] as number;
  target.y = values[offset + 1] as number;
  return target;
}

function sameStoredLegacyInkPoint(
  values: Float64Array,
  storedFlags: number,
  index: number,
  point: InkPoint,
): boolean {
  const offset = index * ACTIVE_POINT_WIDTH;
  const pointFlags =
    (point.tiltX === undefined ? 0 : TILT_X_PRESENT) |
    (point.tiltY === undefined ? 0 : TILT_Y_PRESENT);
  return (
    storedFlags === pointFlags &&
    values[offset] === point.x &&
    values[offset + 1] === point.y &&
    values[offset + 2] === point.time &&
    values[offset + 3] === point.pressure &&
    values[offset + 4] === (point.tiltX ?? 0) &&
    values[offset + 5] === (point.tiltY ?? 0)
  );
}

function sameStoredRawSample(
  values: Float64Array,
  storedFlags: number,
  index: number,
  sample: InkSampleCursor,
): boolean {
  const offset = index * ACTIVE_POINT_WIDTH;
  const sampleFlags = sample.flags & KNOWN_SAMPLE_FLAGS;
  return (
    storedFlags === sampleFlags &&
    values[offset] === sample.x &&
    values[offset + 1] === sample.y &&
    values[offset + 2] === sample.time &&
    values[offset + 3] ===
      ((sampleFlags & INK_SAMPLE_FLAGS.pressureMeasured) === 0 ? 0 : sample.pressure) &&
    values[offset + 4] ===
      ((sampleFlags & INK_SAMPLE_FLAGS.altitudeMeasured) === 0 ? 0 : sample.altitude) &&
    values[offset + 5] ===
      ((sampleFlags & INK_SAMPLE_FLAGS.azimuthMeasured) === 0 ? 0 : sample.azimuth)
  );
}

function requireContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Ink rendering requires a 2D Canvas context.');
  context.lineCap = 'round';
  context.lineJoin = 'round';
  return context;
}

function drawCompiled(
  context: CanvasRenderingContext2D,
  geometry: CompiledInkStroke,
  isolatedCoverage: boolean,
): void {
  const brushGeometry = geometry.promotedBrushGeometry ?? geometry.brushGeometry;
  if (brushGeometry !== undefined) {
    drawInkBrushGeometryToCanvas(context, brushGeometry);
    return;
  }
  drawPath(
    context,
    geometry.points,
    geometry.paint.color,
    geometry.width,
    isolatedCoverage ? 1 : geometry.paint.opacity,
  );
}

function renderGeometryCacheKey(stroke: InkStroke, generation: number): string {
  const version = stroke.brushRenderVersion;
  return version === undefined || version === 'legacy-round-v1'
    ? legacyGeometryCacheKey(stroke, generation)
    : [version, stroke.linkedStrokeId ?? stroke.id, `g${generation}`].join('|');
}

function compiledSharedBrushStroke(
  stroke: InkStroke,
  brushGeometry: InkCompiledBrushGeometry,
): CompiledInkStroke {
  const pointCount =
    brushGeometry.coverage.kind === 'quantized-filled-contours'
      ? brushGeometry.coverage.contours.reduce((total, contour) => total + contour.length, 0)
      : brushGeometry.coverage.centerline.length;
  const alpha =
    brushGeometry.blend.alpha.kind === 'fixed'
      ? brushGeometry.blend.alpha.value
      : legacyGeometryOpacity(brushGeometry.tool, brushGeometry.color);
  return Object.freeze({
    bounds: brushGeometry.bounds,
    brushGeometry,
    byteSizeEstimate: 256 + pointCount * 16,
    digest: brushGeometry.geometryDigest,
    paint: Object.freeze({
      color: stripHexAlpha(brushGeometry.color),
      composite: 'source-over' as const,
      lineCap: 'round' as const,
      lineJoin: 'round' as const,
      opacity: alpha,
    }),
    points: stroke.points,
    strokeId: brushGeometry.logicalStrokeId,
    tool: brushGeometry.tool,
    version: brushGeometry.version,
    width: stroke.width,
  });
}

function compiledPromotedPhysicalStroke(
  stroke: InkStroke,
  physical: PhysicalActiveGeometryState,
  strokeGeneration: number,
): CompiledInkStroke {
  const logicalStrokeId = stroke.linkedStrokeId ?? stroke.id;
  if (
    physical.completedBounds === null ||
    stroke.brushRenderVersion !== physical.version ||
    stroke.color !== physical.color ||
    stroke.tool !== (physical.version === 'pen-physical-v1' ? 'pen' : 'highlighter') ||
    logicalStrokeId !== stroke.id
  ) {
    throw new Error(`Completed Active geometry does not match physical stroke ${stroke.id}.`);
  }
  const stableCoverage = Object.freeze(physical.stableCoverage);
  const promotedBrushGeometry: InkPromotedBrushGeometry = Object.freeze({
    blend: Object.freeze({
      alpha: Object.freeze({ kind: 'fixed' as const, value: physical.alpha }),
      application: 'once-per-logical-stroke' as const,
      colorSpace: 'srgb' as const,
      composite: 'source-over' as const,
    }),
    bounds: physical.completedBounds,
    color: physical.color,
    coverageChunks: Object.freeze([stableCoverage, physical.mutableCoverage]),
    hitShape: Object.freeze({
      fillRule: 'nonzero' as const,
      kind: 'filled-contour-distance' as const,
    }),
    logicalStrokeId,
    ownershipTransfer: 'active-to-committed-without-recompile',
    quantization: Object.freeze({ logicalGrid: physical.logicalGrid }),
    tool: stroke.tool,
    version: physical.version,
  });
  return Object.freeze({
    bounds: physical.completedBounds,
    byteSizeEstimate: 256 + physical.stableByteSize + physical.mutableByteSize,
    digest: [
      physical.version,
      logicalStrokeId,
      'active',
      physical.generation,
      strokeGeneration,
    ].join('|'),
    paint: Object.freeze({
      color: physical.color,
      composite: 'source-over' as const,
      lineCap: 'round' as const,
      lineJoin: 'round' as const,
      opacity: physical.alpha,
    }),
    points: stroke.points,
    promotedBrushGeometry,
    strokeId: logicalStrokeId,
    tool: stroke.tool,
    version: physical.version,
    width: stroke.width,
  });
}

function legacyGeometryOpacity(tool: InkStroke['tool'], color: string): number {
  const match = /^#[0-9a-f]{6}(?<alpha>[0-9a-f]{2})$/iu.exec(color);
  const alpha = match?.groups?.alpha;
  return alpha === undefined
    ? tool === 'highlighter'
      ? 0.45
      : 1
    : Number.parseInt(alpha, 16) / 255;
}

function stripHexAlpha(color: string): string {
  return /^#[0-9a-f]{8}$/iu.test(color) ? color.slice(0, 7) : color;
}

function drawPath(
  context: CanvasRenderingContext2D,
  points: InkPointPath,
  color: string,
  width: number,
  opacity: number,
  firstPoint = 0,
): void {
  const first = points.at(firstPoint);
  if (first === undefined) return;
  context.save();
  context.globalAlpha = opacity;
  context.globalCompositeOperation = 'source-over';
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(first.x, first.y);
  if (points.length - firstPoint === 1) {
    context.lineTo(first.x + 0.01, first.y + 0.01);
  } else {
    for (let index = firstPoint + 1; index < points.length; index += 1) {
      const point = points.at(index);
      if (point !== undefined) context.lineTo(point.x, point.y);
    }
  }
  context.stroke();
  context.restore();
}

function drawEraserStart(
  context: CanvasRenderingContext2D,
  start: Pick<InkPoint, 'x' | 'y'>,
  color: string,
  actualScale: number,
): void {
  const scale = Number.isFinite(actualScale) && actualScale > 0 ? actualScale : 1;
  const radius = 6 / scale;
  context.save();
  context.setLineDash([]);
  context.beginPath();
  context.strokeStyle = color;
  context.lineWidth = 2 / scale;
  context.arc(start.x, start.y, radius, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

function clearCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.restore();
}

function clearLogicalRect(
  context: CanvasRenderingContext2D,
  bounds: InkGeometryBounds,
  frame: InkStageFrame,
  dpr: number,
): void {
  const topLeft = frame.logicalToCanvasCss({ x: bounds.x, y: bounds.y });
  const bottomRight = frame.logicalToCanvasCss({
    x: bounds.x + bounds.width,
    y: bounds.y + bounds.height,
  });
  const padding = 2;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(
    Math.floor((topLeft.x - padding) * dpr),
    Math.floor((topLeft.y - padding) * dpr),
    Math.ceil((bottomRight.x - topLeft.x + padding * 2) * dpr),
    Math.ceil((bottomRight.y - topLeft.y + padding * 2) * dpr),
  );
  context.restore();
}

function refsForChange(
  query: (viewport: InkLogicalRect) => readonly InkRenderableStrokeRef[],
  change: InkDocumentChange,
): readonly InkRenderableStrokeRef[] {
  const bounds = changeBounds(change);
  if (bounds === null) return [];
  const affected = new Set([...change.addedIds, ...change.updatedIds]);
  return query(bounds).filter(({ id }) => affected.has(id));
}

function overlayGeometryBounds(overlay: InkRenderOverlay): InkGeometryBounds | null {
  return unionBounds(
    ...overlay.hovered.map(({ bounds }) => expandGeometryBounds(bounds, 4)),
    ...overlay.selected.map(({ bounds }) => expandGeometryBounds(bounds, 6)),
  );
}

function expandGeometryBounds(bounds: InkGeometryBounds, expansion: number): InkGeometryBounds {
  return {
    height: bounds.height + expansion * 2,
    width: bounds.width + expansion * 2,
    x: bounds.x - expansion,
    y: bounds.y - expansion,
  };
}

function changeBounds(change: InkDocumentChange): InkGeometryBounds | null {
  return unionBounds(
    ...change.bounds.flatMap(({ newBounds, oldBounds }) => [newBounds, oldBounds]),
  );
}

function isAddedOnlyDocumentChange(change: InkDocumentChange): boolean {
  return (
    change.addedIds.length > 0 && change.updatedIds.length === 0 && change.removedIds.length === 0
  );
}

function logicalViewport(frame: InkStageFrame): InkLogicalRect {
  return {
    height: frame.logicalViewport.height,
    width: frame.logicalViewport.width,
    x: frame.logicalViewport.left,
    y: frame.logicalViewport.top,
  };
}

function committedRasterRegions(
  frame: InkStageFrame,
  lod: number,
  contentIndex: InkEditTileContentIndex,
): readonly CommittedRasterRegion[] {
  const viewport = logicalViewport(frame);
  const addressed = COMMITTED_RASTER_TILE_GRID.addresses(
    createInkNoteLogicalRect({
      height: viewport.height,
      width: viewport.width,
      x: viewport.x,
      y: viewport.y,
    }),
    lod,
  );
  if (addressed.kind === 'untileable-range') return Object.freeze([]);
  return committedRasterRegionsForCoordinates(addressed.coordinates, contentIndex);
}

function committedRasterRegionsForCoordinates(
  coordinates: readonly InkWorldTileCoordinate[],
  contentIndex: InkEditTileContentIndex,
): readonly CommittedRasterRegion[] {
  return Object.freeze(
    coordinates.map((coordinate) => {
      const rasterDensity = 2 ** coordinate.lod;
      const bounds = COMMITTED_RASTER_TILE_GRID.nominalBounds(coordinate);
      const backingWidth = Math.max(1, Math.ceil(bounds.width * rasterDensity));
      const backingHeight = Math.max(1, Math.ceil(bounds.height * rasterDensity));
      const key = COMMITTED_RASTER_TILE_KEY_FACTORY.identity(
        COMMITTED_RASTER_TILE_KEY_FACTORY.create({
          coordinate,
          projectionIdentity: contentIndex.projectionIdentity,
          rasterVariant: {
            alphaContract: 'premultiplied-transparent-v1',
            backingHeight,
            backingWidth,
            colorSpace: 'srgb',
            pixelsPerLogicalUnit: rasterDensity,
          },
          rendererVersion: COMMITTED_RASTER_TILE_RENDERER_VERSION,
          tileContentToken: contentIndex.contentToken(coordinate),
        }),
      );
      return Object.freeze({ bounds, coordinate, key, rasterDensity });
    }),
  );
}

function ordered(refs: readonly InkRenderableStrokeRef[]): readonly InkRenderableStrokeRef[] {
  return [...refs].sort((left, right) => left.order - right.order);
}

function sameRasterBounds(left: InkRasterTileBounds, right: InkRasterTileBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function intersects(left: InkLogicalRect, right: InkLogicalRect): boolean {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
  );
}

function intersectBounds(left: InkLogicalRect, right: InkLogicalRect): InkGeometryBounds | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  if (rightEdge <= x || bottomEdge <= y) return null;
  return {
    height: bottomEdge - y,
    width: rightEdge - x,
    x,
    y,
  };
}

function deterministicFallback(stroke: InkStroke): InkStroke {
  const points = stroke.points.filter(
    ({ pressure, time, x, y }) =>
      Number.isFinite(pressure) &&
      Number.isFinite(time) &&
      Number.isFinite(x) &&
      Number.isFinite(y),
  );
  return {
    ...stroke,
    color: stroke.color.length === 0 ? '#000000' : stroke.color,
    points: points.length === 0 ? [{ pressure: 0.5, time: 0, x: 0, y: 0 }] : points,
    width: Number.isFinite(stroke.width) && stroke.width > 0 ? stroke.width : 1,
  };
}

function formatOpacity(value: number): string {
  return (Math.round(value * 1_000_000) / 1_000_000).toString();
}
