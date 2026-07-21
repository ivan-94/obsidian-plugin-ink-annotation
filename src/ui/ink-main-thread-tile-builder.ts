import {
  InkWorkScheduler,
  type InkWorkLane,
  type InkWorkOutcome,
} from '../runtime/ink-work-scheduler';
import {
  GLOBAL_INK_GEOMETRY_CACHE_COORDINATOR,
  INK_GEOMETRY_CACHE_BYTES_PER_MOUNT,
  type InkDisposableMemoryEvictionCandidate,
  type InkDisposableMemoryParticipant,
  type InkGeometryCacheCoordinator,
} from './ink-geometry-cache';
import type { InkRasterTileBounds } from './ink-raster-tile-cache';

export interface InkTileBuilderWorkPlan<Result> {
  readonly result: () => Result;
  readonly unitKinds: readonly string[];
  readonly units: readonly (() => unknown)[];
}

export interface InkTileBuilderDrawPlan {
  readonly unitKinds: readonly string[];
  readonly units: readonly (() => unknown)[];
}

export interface InkCanvasTileBuildResult {
  readonly bounds: InkRasterTileBounds;
  readonly canvas: HTMLCanvasElement;
  readonly key: string;
}

/** Required resumable Canvas 2D fallback behind the shared Tile Builder contract. */
export class InkMainThreadTileBuilder implements InkDisposableMemoryParticipant {
  private activeBytes = 0;
  private readonly activeCanvases = new Map<
    number,
    { readonly byteSize: number; readonly canvas: HTMLCanvasElement }
  >();
  private readonly coordinator: InkGeometryCacheCoordinator;
  private disposed = false;
  private readonly document: Document;
  private readonly maximumBytes: number;
  private nextBuild = 0;
  private readonly scheduler: InkWorkScheduler;

  constructor(input: {
    readonly document: Document;
    readonly maximumBytes?: number;
    readonly memoryCoordinator?: InkGeometryCacheCoordinator;
    readonly scheduler?: InkWorkScheduler;
  }) {
    this.document = input.document;
    this.scheduler = input.scheduler ?? new InkWorkScheduler();
    this.coordinator = input.memoryCoordinator ?? GLOBAL_INK_GEOMETRY_CACHE_COORDINATOR;
    this.maximumBytes = input.maximumBytes ?? INK_GEOMETRY_CACHE_BYTES_PER_MOUNT;
    if (!Number.isSafeInteger(this.maximumBytes) || this.maximumBytes <= 0) {
      throw new Error('Ink main-thread Tile Builder byte cap must be a positive safe integer.');
    }
    this.coordinator.register(this);
  }

  get disposableBytes(): number {
    return this.activeBytes;
  }

  async build<Reference>(input: {
    readonly backingHeight: number;
    readonly backingWidth: number;
    readonly bounds: InkRasterTileBounds;
    readonly createDrawPlan: (
      context: CanvasRenderingContext2D,
      references: readonly Reference[],
    ) => InkTileBuilderDrawPlan;
    readonly density: number;
    readonly isCurrent: () => boolean;
    readonly key: string;
    readonly lane: Exclude<InkWorkLane, 'interactive'>;
    readonly prepareQuery: () => InkTileBuilderWorkPlan<readonly Reference[]>;
  }): Promise<InkCanvasTileBuildResult | null> {
    this.assertUsable();
    assertBuildInput(input);
    const byteSize = input.backingWidth * input.backingHeight * 4;
    if (!Number.isSafeInteger(byteSize) || byteSize > this.maximumBytes - this.activeBytes) {
      return null;
    }
    const canvas = this.document.createElement('canvas');
    this.nextBuild += 1;
    const buildId = this.nextBuild;
    this.activeCanvases.set(buildId, { byteSize, canvas });
    this.activeBytes += byteSize;
    this.coordinator.enforce();
    if (this.coordinator.byteSize > this.coordinator.maximumBytes) {
      this.releaseBuild(buildId, true);
      return null;
    }
    canvas.width = input.backingWidth;
    canvas.height = input.backingHeight;
    let transferred = false;
    try {
      const context = canvas.getContext('2d');
      if (context === null) return null;
      context.setTransform(
        input.density,
        0,
        0,
        input.density,
        -input.bounds.x * input.density,
        -input.bounds.y * input.density,
      );
      const query = input.prepareQuery();
      if (
        !isCompleted(
          await this.scheduler.schedule({
            isCurrent: () => !this.disposed && input.isCurrent(),
            lane: input.lane,
            unitKinds: query.unitKinds,
            units: query.units,
          }),
        )
      ) {
        return null;
      }
      const draw = input.createDrawPlan(context, query.result());
      if (
        !isCompleted(
          await this.scheduler.schedule({
            isCurrent: () => !this.disposed && input.isCurrent(),
            lane: input.lane,
            unitKinds: draw.unitKinds,
            units: draw.units,
          }),
        ) ||
        this.disposed ||
        !input.isCurrent()
      ) {
        return null;
      }
      transferred = true;
      return Object.freeze({ bounds: Object.freeze({ ...input.bounds }), canvas, key: input.key });
    } finally {
      this.releaseBuild(buildId, !transferred);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { canvas } of this.activeCanvases.values()) {
      canvas.width = 0;
      canvas.height = 0;
    }
    this.activeCanvases.clear();
    this.activeBytes = 0;
    this.coordinator.unregister(this);
  }

  evictionCandidate(): InkDisposableMemoryEvictionCandidate | null {
    return null;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Ink main-thread Tile Builder has been disposed.');
  }

  private releaseBuild(buildId: number, releaseCanvas: boolean): void {
    const build = this.activeCanvases.get(buildId);
    if (build === undefined) return;
    this.activeCanvases.delete(buildId);
    this.activeBytes -= build.byteSize;
    if (!releaseCanvas) return;
    build.canvas.width = 0;
    build.canvas.height = 0;
  }
}

function isCompleted(outcome: InkWorkOutcome): boolean {
  return outcome === 'completed';
}

function assertBuildInput(input: {
  readonly backingHeight: number;
  readonly backingWidth: number;
  readonly bounds: InkRasterTileBounds;
  readonly density: number;
  readonly key: string;
}): void {
  if (
    !Number.isSafeInteger(input.backingWidth) ||
    input.backingWidth <= 0 ||
    !Number.isSafeInteger(input.backingHeight) ||
    input.backingHeight <= 0
  ) {
    throw new Error('Ink Tile Builder backing dimensions must be positive safe integers.');
  }
  if (!Number.isFinite(input.density) || input.density <= 0) {
    throw new Error('Ink Tile Builder density must be finite and positive.');
  }
  if (input.key.length === 0) throw new Error('Ink Tile Builder key must not be empty.');
}
