export type InkBrushRasterTool = 'highlighter' | 'pen';

export interface InkBrushRasterBounds {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface InkBrushRasterSnapshot {
  /** Final optical alpha after the version's once-per-logical-stroke density is applied. */
  readonly alpha: Uint8Array;
  readonly bounds: InkBrushRasterBounds;
  /** Geometry-only normalized coverage. It is independent from brush optical alpha. */
  readonly coverage: Uint8Array;
  readonly height: number;
  readonly scale: number;
  readonly width: number;
}

export interface InkBrushRasterReplay {
  readonly first: InkBrushRasterSnapshot;
  readonly replay: InkBrushRasterSnapshot;
}

export interface InkBrushRasterThresholds {
  readonly maximumBoundaryP95PhysicalPixels: number;
  readonly maximumNormalizedAlphaDelta: number;
  readonly minimumAlphaWeightedIoU: number;
  readonly requiredBoundaryOutputScale: 2;
}

export const INK_BRUSH_RASTER_THRESHOLDS: Readonly<
  Record<InkBrushRasterTool, InkBrushRasterThresholds>
> = Object.freeze({
  highlighter: frozenThresholds(0.99),
  pen: frozenThresholds(0.995),
});

export interface InkBrushRasterMetrics {
  readonly alphaWeightedIoU: number;
  readonly boundaryP95PhysicalPixels: number | null;
  readonly maximumNormalizedAlphaDelta: number;
}

export type InkBrushRasterComparison =
  | {
      readonly deterministic: false;
      readonly kind: 'invalid';
      readonly reason: 'incompatible-snapshots' | 'invalid-snapshot' | 'non-deterministic-replay';
      readonly thresholds: InkBrushRasterThresholds;
    }
  | {
      readonly checks: {
        readonly alphaWeightedIoU: boolean;
        readonly boundaryP95: boolean;
        readonly maximumNormalizedAlphaDelta: boolean;
      };
      readonly deterministic: true;
      readonly kind: 'compared';
      readonly metrics: InkBrushRasterMetrics;
      readonly passed: boolean;
      readonly thresholds: InkBrushRasterThresholds;
    };

export function compareInkBrushRasterReplays(input: {
  readonly candidate: InkBrushRasterReplay;
  readonly reference: InkBrushRasterReplay;
  readonly tool: InkBrushRasterTool;
}): InkBrushRasterComparison {
  const thresholds = INK_BRUSH_RASTER_THRESHOLDS[input.tool];
  const snapshots = [
    input.reference.first,
    input.reference.replay,
    input.candidate.first,
    input.candidate.replay,
  ];
  if (snapshots.some((snapshot) => !hasValidDimensions(snapshot))) {
    return Object.freeze({
      deterministic: false,
      kind: 'invalid',
      reason: 'invalid-snapshot',
      thresholds,
    });
  }
  if (
    !sameSnapshot(input.reference.first, input.reference.replay) ||
    !sameSnapshot(input.candidate.first, input.candidate.replay)
  ) {
    return Object.freeze({
      deterministic: false,
      kind: 'invalid',
      reason: 'non-deterministic-replay',
      thresholds,
    });
  }
  if (!sameRasterGrid(input.reference.first, input.candidate.first)) {
    return Object.freeze({
      deterministic: false,
      kind: 'invalid',
      reason: 'incompatible-snapshots',
      thresholds,
    });
  }
  const alphaWeightedIoU = calculateAlphaWeightedIoU(
    input.reference.first.coverage,
    input.candidate.first.coverage,
  );
  const boundaryP95PhysicalPixels = calculateBoundaryP95(
    input.reference.first.coverage,
    input.candidate.first.coverage,
    input.reference.first.width,
    input.reference.first.height,
  );
  const measuredMaximumNormalizedAlphaDelta = calculateMaximumNormalizedAlphaDelta(
    input.reference.first.alpha,
    input.candidate.first.alpha,
  );
  const checks = Object.freeze({
    alphaWeightedIoU: alphaWeightedIoU >= thresholds.minimumAlphaWeightedIoU,
    boundaryP95:
      input.reference.first.scale === thresholds.requiredBoundaryOutputScale &&
      boundaryP95PhysicalPixels !== null &&
      boundaryP95PhysicalPixels <= thresholds.maximumBoundaryP95PhysicalPixels,
    maximumNormalizedAlphaDelta:
      measuredMaximumNormalizedAlphaDelta <= thresholds.maximumNormalizedAlphaDelta,
  });
  return Object.freeze({
    checks,
    deterministic: true,
    kind: 'compared',
    metrics: Object.freeze({
      alphaWeightedIoU,
      boundaryP95PhysicalPixels,
      maximumNormalizedAlphaDelta: measuredMaximumNormalizedAlphaDelta,
    }),
    passed: checks.alphaWeightedIoU && checks.boundaryP95 && checks.maximumNormalizedAlphaDelta,
    thresholds,
  });
}

function frozenThresholds(minimumAlphaWeightedIoU: number): InkBrushRasterThresholds {
  return Object.freeze({
    maximumBoundaryP95PhysicalPixels: 0.5,
    maximumNormalizedAlphaDelta: 1 / 255,
    minimumAlphaWeightedIoU,
    requiredBoundaryOutputScale: 2,
  });
}

function hasValidDimensions(snapshot: InkBrushRasterSnapshot): boolean {
  const { bounds } = snapshot;
  return (
    Number.isInteger(snapshot.width) &&
    snapshot.width > 0 &&
    Number.isInteger(snapshot.height) &&
    snapshot.height > 0 &&
    snapshot.alpha instanceof Uint8Array &&
    snapshot.alpha.length === snapshot.width * snapshot.height &&
    snapshot.alpha.some((alpha) => alpha !== 0) &&
    snapshot.coverage instanceof Uint8Array &&
    snapshot.coverage.length === snapshot.width * snapshot.height &&
    snapshot.coverage.some((coverage) => coverage !== 0) &&
    Number.isFinite(snapshot.scale) &&
    snapshot.scale > 0 &&
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    bounds.width > 0 &&
    Number.isFinite(bounds.height) &&
    bounds.height > 0 &&
    samePixelSpan(bounds.width * snapshot.scale, snapshot.width) &&
    samePixelSpan(bounds.height * snapshot.scale, snapshot.height)
  );
}

function samePixelSpan(projected: number, pixels: number): boolean {
  return Math.abs(projected - pixels) <= Number.EPSILON * Math.max(1, pixels) * 8;
}

function sameSnapshot(left: InkBrushRasterSnapshot, right: InkBrushRasterSnapshot): boolean {
  return (
    sameRasterGrid(left, right) &&
    sameBytes(left.alpha, right.alpha) &&
    sameBytes(left.coverage, right.coverage)
  );
}

function sameRasterGrid(left: InkBrushRasterSnapshot, right: InkBrushRasterSnapshot): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.scale === right.scale &&
    sameBounds(left.bounds, right.bounds)
  );
}

function sameBounds(left: InkBrushRasterBounds, right: InkBrushRasterBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function calculateAlphaWeightedIoU(reference: Uint8Array, candidate: Uint8Array): number {
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < reference.length; index += 1) {
    const left = reference[index] as number;
    const right = candidate[index] as number;
    intersection += Math.min(left, right);
    union += Math.max(left, right);
  }
  return union === 0 ? 1 : intersection / union;
}

function calculateMaximumNormalizedAlphaDelta(
  reference: Uint8Array,
  candidate: Uint8Array,
): number {
  let maximum = 0;
  for (let index = 0; index < reference.length; index += 1) {
    maximum = Math.max(
      maximum,
      Math.abs((reference[index] as number) - (candidate[index] as number)),
    );
  }
  return maximum / 255;
}

const COVERAGE_ISOLINE = 128;

interface RasterBoundaryPoint {
  readonly x: number;
  readonly y: number;
}

function calculateBoundaryP95(
  reference: Uint8Array,
  candidate: Uint8Array,
  width: number,
  height: number,
): number | null {
  const referenceBoundary = collectSubpixelBoundary(reference, width, height);
  const candidateBoundary = collectSubpixelBoundary(candidate, width, height);
  if (referenceBoundary.length === 0 && candidateBoundary.length === 0) return 0;
  if (referenceBoundary.length === 0 || candidateBoundary.length === 0) return null;
  const referenceGrid = new BoundaryPointGrid(referenceBoundary);
  const candidateGrid = new BoundaryPointGrid(candidateBoundary);
  const distances = [
    ...referenceBoundary.map((point) => candidateGrid.nearestDistance(point)),
    ...candidateBoundary.map((point) => referenceGrid.nearestDistance(point)),
  ].sort((left, right) => left - right);
  const percentileIndex = Math.max(0, Math.ceil(distances.length * 0.95) - 1);
  return distances[percentileIndex] as number;
}

function collectSubpixelBoundary(
  coverage: Uint8Array,
  width: number,
  height: number,
): RasterBoundaryPoint[] {
  const boundary: RasterBoundaryPoint[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let leftX = -1; leftX < width; leftX += 1) {
      const left = coverageAt(coverage, width, height, leftX, y);
      const right = coverageAt(coverage, width, height, leftX + 1, y);
      if (!crossesCoverageIsoline(left, right)) continue;
      boundary.push(
        Object.freeze({
          x: leftX + 0.5 + isolineFraction(left, right),
          y: y + 0.5,
        }),
      );
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (let topY = -1; topY < height; topY += 1) {
      const top = coverageAt(coverage, width, height, x, topY);
      const bottom = coverageAt(coverage, width, height, x, topY + 1);
      if (!crossesCoverageIsoline(top, bottom)) continue;
      boundary.push(
        Object.freeze({
          x: x + 0.5,
          y: topY + 0.5 + isolineFraction(top, bottom),
        }),
      );
    }
  }
  return boundary;
}

function coverageAt(
  coverage: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  if (x < 0 || x >= width || y < 0 || y >= height) return 0;
  return coverage[y * width + x] as number;
}

function crossesCoverageIsoline(first: number, second: number): boolean {
  return first >= COVERAGE_ISOLINE !== second >= COVERAGE_ISOLINE;
}

function isolineFraction(first: number, second: number): number {
  return (COVERAGE_ISOLINE - first) / (second - first);
}

class BoundaryPointGrid {
  private readonly cells = new Map<string, readonly RasterBoundaryPoint[]>();
  private readonly maximumCellX: number;
  private readonly maximumCellY: number;
  private readonly minimumCellX: number;
  private readonly minimumCellY: number;

  constructor(points: readonly RasterBoundaryPoint[]) {
    const mutable = new Map<string, RasterBoundaryPoint[]>();
    let minimumCellX = Number.POSITIVE_INFINITY;
    let minimumCellY = Number.POSITIVE_INFINITY;
    let maximumCellX = Number.NEGATIVE_INFINITY;
    let maximumCellY = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      const cellX = Math.floor(point.x);
      const cellY = Math.floor(point.y);
      minimumCellX = Math.min(minimumCellX, cellX);
      minimumCellY = Math.min(minimumCellY, cellY);
      maximumCellX = Math.max(maximumCellX, cellX);
      maximumCellY = Math.max(maximumCellY, cellY);
      const key = boundaryCellKey(cellX, cellY);
      const cell = mutable.get(key);
      if (cell === undefined) mutable.set(key, [point]);
      else cell.push(point);
    }
    for (const [key, pointsInCell] of mutable) {
      this.cells.set(key, Object.freeze(pointsInCell));
    }
    this.minimumCellX = minimumCellX;
    this.minimumCellY = minimumCellY;
    this.maximumCellX = maximumCellX;
    this.maximumCellY = maximumCellY;
  }

  nearestDistance(source: RasterBoundaryPoint): number {
    const sourceCellX = Math.floor(source.x);
    const sourceCellY = Math.floor(source.y);
    const maximumRing = Math.max(
      Math.abs(sourceCellX - this.minimumCellX),
      Math.abs(sourceCellX - this.maximumCellX),
      Math.abs(sourceCellY - this.minimumCellY),
      Math.abs(sourceCellY - this.maximumCellY),
    );
    let minimumSquared = Number.POSITIVE_INFINITY;
    for (let ring = 0; ring <= maximumRing; ring += 1) {
      minimumSquared = this.visitRing(source, sourceCellX, sourceCellY, ring, minimumSquared);
      const outsideDistance = Math.min(
        source.x - (sourceCellX - ring),
        sourceCellX + ring + 1 - source.x,
        source.y - (sourceCellY - ring),
        sourceCellY + ring + 1 - source.y,
      );
      if (minimumSquared <= outsideDistance * outsideDistance) break;
    }
    return Math.sqrt(minimumSquared);
  }

  private visitRing(
    source: RasterBoundaryPoint,
    sourceCellX: number,
    sourceCellY: number,
    ring: number,
    currentMinimum: number,
  ): number {
    let minimumSquared = currentMinimum;
    const visit = (cellX: number, cellY: number): void => {
      const points = this.cells.get(boundaryCellKey(cellX, cellY));
      if (points === undefined) return;
      for (const target of points) {
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        minimumSquared = Math.min(minimumSquared, dx * dx + dy * dy);
      }
    };
    if (ring === 0) {
      visit(sourceCellX, sourceCellY);
      return minimumSquared;
    }
    const minimumX = sourceCellX - ring;
    const maximumX = sourceCellX + ring;
    const minimumY = sourceCellY - ring;
    const maximumY = sourceCellY + ring;
    for (let x = minimumX; x <= maximumX; x += 1) {
      visit(x, minimumY);
      visit(x, maximumY);
    }
    for (let y = minimumY + 1; y < maximumY; y += 1) {
      visit(minimumX, y);
      visit(maximumX, y);
    }
    return minimumSquared;
  }
}

function boundaryCellKey(x: number, y: number): string {
  return `${x}:${y}`;
}
