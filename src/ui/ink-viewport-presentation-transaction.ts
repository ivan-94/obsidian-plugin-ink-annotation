import { InkTileLodSelector } from '../domain/ink-tile-lod-selector';

export type InkViewportCameraMotion = 'mount' | 'resize' | 'scroll' | 'settled' | 'zoom';
export type InkViewportPresentedCoverage = 'exact' | 'fallback' | 'unknown';

export interface InkViewportCameraState {
  readonly devicePixelRatio: number;
  readonly logicalLeft: number;
  readonly logicalTop: number;
  readonly scale: number;
}

export interface InkViewportPresentationSnapshot {
  readonly cameraEpoch: number;
  readonly motion: InkViewportCameraMotion;
  readonly presentedCoverage: InkViewportPresentedCoverage;
  readonly projectionIdentity: string;
  readonly targetLod: number;
  readonly transform: Readonly<{ a: number; d: number; e: number; f: number }>;
}

/**
 * Pure Camera/content fence shared by Preview and Edit presentation adapters.
 * It owns no DOM measurement, raster work, storage, or canonical state.
 */
export class InkViewportPresentationTransaction {
  private current: InkViewportPresentationSnapshot | null = null;
  private readonly lodSelector: InkTileLodSelector;
  private retainedLod: number | null = null;

  constructor(input: {
    readonly hysteresisRatio: number;
    readonly maximumLod: number;
    readonly minimumLod: number;
  }) {
    this.lodSelector = new InkTileLodSelector(input);
  }

  request(input: {
    readonly camera: InkViewportCameraState;
    readonly motion: InkViewportCameraMotion;
    readonly projectionIdentity: string;
    readonly stageFrameEpoch: number;
  }): InkViewportPresentationSnapshot {
    assertRequest(input);
    const transform = Object.freeze({
      a: input.camera.scale,
      d: input.camera.scale,
      e: normalizeZero(-input.camera.logicalLeft * input.camera.scale),
      f: normalizeZero(-input.camera.logicalTop * input.camera.scale),
    });
    if (
      this.current !== null &&
      this.current.cameraEpoch === input.stageFrameEpoch &&
      this.current.projectionIdentity === input.projectionIdentity &&
      this.current.motion === input.motion &&
      sameTransform(this.current.transform, transform)
    ) {
      return this.current;
    }
    const sameProjection = this.current?.projectionIdentity === input.projectionIdentity;
    if (!sameProjection) this.retainedLod = null;
    const targetLod = this.lodSelector.select(
      input.camera.devicePixelRatio * input.camera.scale,
      this.retainedLod ?? undefined,
    );
    this.retainedLod = targetLod;
    const snapshot = Object.freeze({
      cameraEpoch: input.stageFrameEpoch,
      motion: input.motion,
      presentedCoverage: 'unknown' as const,
      projectionIdentity: input.projectionIdentity,
      targetLod,
      transform,
    });
    this.current = snapshot;
    return snapshot;
  }

  accept(input: {
    readonly cameraEpoch: number;
    readonly coverage: Exclude<InkViewportPresentedCoverage, 'unknown'>;
    readonly projectionIdentity: string;
  }): boolean {
    const current = this.current;
    if (
      current === null ||
      input.cameraEpoch !== current.cameraEpoch ||
      input.projectionIdentity !== current.projectionIdentity ||
      (current.presentedCoverage === 'exact' && input.coverage === 'fallback')
    ) {
      return false;
    }
    this.current = Object.freeze({ ...current, presentedCoverage: input.coverage });
    return true;
  }

  snapshot(): InkViewportPresentationSnapshot | null {
    return this.current;
  }
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function sameTransform(
  left: Readonly<{ a: number; d: number; e: number; f: number }>,
  right: Readonly<{ a: number; d: number; e: number; f: number }>,
): boolean {
  return left.a === right.a && left.d === right.d && left.e === right.e && left.f === right.f;
}

function assertRequest(input: {
  readonly camera: InkViewportCameraState;
  readonly projectionIdentity: string;
  readonly stageFrameEpoch: number;
}): void {
  if (!Number.isSafeInteger(input.stageFrameEpoch) || input.stageFrameEpoch < 0) {
    throw new Error('Ink Viewport Stage Frame epoch must be a non-negative safe integer.');
  }
  if (input.projectionIdentity.length === 0) {
    throw new Error('Ink Viewport projection identity must not be empty.');
  }
  const { devicePixelRatio, logicalLeft, logicalTop, scale } = input.camera;
  if (
    !Number.isFinite(devicePixelRatio) ||
    devicePixelRatio <= 0 ||
    !Number.isFinite(logicalLeft) ||
    !Number.isFinite(logicalTop) ||
    !Number.isFinite(scale) ||
    scale <= 0
  ) {
    throw new Error('Ink Viewport Camera must be finite with positive density and scale.');
  }
}
