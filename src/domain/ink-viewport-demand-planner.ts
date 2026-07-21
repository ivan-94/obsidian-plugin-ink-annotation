import {
  createInkNoteLogicalRect,
  type InkNoteLogicalRect,
  type InkWorldTileCoordinate,
  type InkWorldTileGrid,
} from './ink-world-tile-grid';

export type InkViewportDemandPlan =
  | {
      readonly kind: 'tileable';
      readonly lookAhead: readonly InkWorldTileCoordinate[];
      readonly nearVisible: readonly InkWorldTileCoordinate[];
      readonly visible: readonly InkWorldTileCoordinate[];
    }
  | { readonly kind: 'untileable-range' };

/** Pure spatial demand planning. Stage Frame measurement remains an Adapter responsibility. */
export class InkViewportDemandPlanner {
  private readonly grid: InkWorldTileGrid;
  private readonly lookAheadRings: number;
  private readonly nearVisibleRings: number;

  constructor(input: {
    readonly grid: InkWorldTileGrid;
    readonly lookAheadRings?: number;
    readonly nearVisibleRings?: number;
  }) {
    this.grid = input.grid;
    this.lookAheadRings = boundedRingCount(input.lookAheadRings ?? 1, 'look-ahead');
    this.nearVisibleRings = boundedRingCount(input.nearVisibleRings ?? 1, 'near-visible');
  }

  plan(input: {
    readonly lod: number;
    readonly previousViewport?: InkNoteLogicalRect;
    readonly viewport: InkNoteLogicalRect;
  }): InkViewportDemandPlan {
    const visible = this.grid.addresses(input.viewport, input.lod);
    if (visible.kind === 'untileable-range') return visible;
    const unitBounds =
      visible.coordinates[0] === undefined ? null : this.grid.nominalBounds(visible.coordinates[0]);
    if (unitBounds === null) {
      return Object.freeze({
        kind: 'tileable',
        lookAhead: Object.freeze([]),
        nearVisible: Object.freeze([]),
        visible: visible.coordinates,
      });
    }
    const span = unitBounds.width;
    const nearBounds = expandRect(input.viewport, this.nearVisibleRings * span);
    const near = this.grid.addresses(nearBounds, input.lod);
    if (near.kind === 'untileable-range') return near;

    const visibleIds = identities(visible.coordinates);
    const nearVisible = near.coordinates.filter(
      (coordinate) => !visibleIds.has(coordinateIdentity(coordinate)),
    );
    const retainedIds = identities([...visible.coordinates, ...nearVisible]);
    const lookAheadBounds = directionalExpansion(
      nearBounds,
      input.previousViewport,
      input.viewport,
      this.lookAheadRings * span,
    );
    if (lookAheadBounds === null) {
      return Object.freeze({
        kind: 'tileable',
        lookAhead: Object.freeze([]),
        nearVisible: Object.freeze(nearVisible),
        visible: visible.coordinates,
      });
    }
    const lookAhead = this.grid.addresses(lookAheadBounds, input.lod);
    if (lookAhead.kind === 'untileable-range') return lookAhead;
    return Object.freeze({
      kind: 'tileable',
      lookAhead: Object.freeze(
        lookAhead.coordinates.filter(
          (coordinate) => !retainedIds.has(coordinateIdentity(coordinate)),
        ),
      ),
      nearVisible: Object.freeze(nearVisible),
      visible: visible.coordinates,
    });
  }
}

function boundedRingCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8) {
    throw new Error(`Ink ${label} ring count must be a safe integer from zero through eight.`);
  }
  return value;
}

function expandRect(bounds: InkNoteLogicalRect, inset: number): InkNoteLogicalRect {
  return createInkNoteLogicalRect({
    height: bounds.height + inset * 2,
    width: bounds.width + inset * 2,
    x: bounds.x - inset,
    y: bounds.y - inset,
  });
}

function directionalExpansion(
  bounds: InkNoteLogicalRect,
  previous: InkNoteLogicalRect | undefined,
  current: InkNoteLogicalRect,
  distance: number,
): InkNoteLogicalRect | null {
  if (previous === undefined || distance === 0) return null;
  const deltaX = current.x - previous.x;
  const deltaY = current.y - previous.y;
  if (deltaX === 0 && deltaY === 0) return null;
  return createInkNoteLogicalRect({
    height: bounds.height + (deltaY === 0 ? 0 : distance),
    width: bounds.width + (deltaX === 0 ? 0 : distance),
    x: bounds.x - (deltaX < 0 ? distance : 0),
    y: bounds.y - (deltaY < 0 ? distance : 0),
  });
}

function identities(coordinates: readonly InkWorldTileCoordinate[]): Set<string> {
  return new Set(coordinates.map(coordinateIdentity));
}

function coordinateIdentity(coordinate: InkWorldTileCoordinate): string {
  return `${coordinate.lod}:${coordinate.column}:${coordinate.row}`;
}
