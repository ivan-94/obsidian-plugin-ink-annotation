export interface SnapshotImageCameraState {
  readonly epoch: number;
  readonly scale: number;
  readonly translateX: number;
  readonly translateY: number;
}

export class SnapshotImageCamera {
  private epoch = 0;
  private readonly imageHeight: number;
  private readonly imageWidth: number;
  private scale = 1;
  private translateX = 0;
  private translateY = 0;

  constructor(input: { readonly imageHeight: number; readonly imageWidth: number }) {
    if (!isPositive(input.imageWidth) || !isPositive(input.imageHeight)) {
      throw new Error('Snapshot image camera requires positive image bounds.');
    }
    this.imageWidth = input.imageWidth;
    this.imageHeight = input.imageHeight;
  }

  snapshot(): SnapshotImageCameraState {
    return Object.freeze({
      epoch: this.epoch,
      scale: this.scale,
      translateX: this.translateX,
      translateY: this.translateY,
    });
  }

  fit(viewport: { readonly height: number; readonly width: number }): SnapshotImageCameraState {
    if (!isPositive(viewport.width) || !isPositive(viewport.height)) {
      throw new Error('Snapshot image camera requires positive viewport bounds.');
    }
    this.scale = Math.min(1, viewport.width / this.imageWidth, viewport.height / this.imageHeight);
    this.translateX = (viewport.width - this.imageWidth * this.scale) / 2;
    this.translateY = (viewport.height - this.imageHeight * this.scale) / 2;
    this.epoch += 1;
    return this.snapshot();
  }

  zoomAt(input: {
    readonly factor: number;
    readonly screenX: number;
    readonly screenY: number;
  }): SnapshotImageCameraState {
    if (
      !isPositive(input.factor) ||
      !Number.isFinite(input.screenX) ||
      !Number.isFinite(input.screenY)
    ) {
      throw new Error('Snapshot image camera zoom input must be finite.');
    }
    const nextScale = Math.min(8, Math.max(0.1, this.scale * input.factor));
    const ratio = nextScale / this.scale;
    this.translateX = input.screenX - (input.screenX - this.translateX) * ratio;
    this.translateY = input.screenY - (input.screenY - this.translateY) * ratio;
    this.scale = nextScale;
    this.epoch += 1;
    return this.snapshot();
  }

  panBy(delta: { readonly x: number; readonly y: number }): SnapshotImageCameraState {
    if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) {
      throw new Error('Snapshot image camera pan delta must be finite.');
    }
    this.translateX += delta.x;
    this.translateY += delta.y;
    this.epoch += 1;
    return this.snapshot();
  }

  toImagePoint(
    point: { readonly x: number; readonly y: number },
    state = this.snapshot(),
  ): { readonly x: number; readonly y: number } {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error('Snapshot image camera point must be finite.');
    }
    return {
      x: (point.x - state.translateX) / state.scale,
      y: (point.y - state.translateY) / state.scale,
    };
  }
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
