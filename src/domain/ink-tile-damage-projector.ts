import {
  createInkNoteLogicalRect,
  type InkNoteLogicalRect,
  type InkWorldTileCoordinate,
  type InkWorldTileGrid,
} from './ink-world-tile-grid';

export interface InkVersionedRenderOutset {
  readonly bottom: number;
  readonly left: number;
  readonly rendererVersion: string;
  readonly right: number;
  readonly top: number;
}

export type InkTileDamageSet =
  | {
      readonly coordinates: readonly InkWorldTileCoordinate[];
      readonly kind: 'tileable';
      readonly rendererVersion: string;
    }
  | {
      readonly kind: 'untileable-range';
      readonly rendererVersion: string;
    };

export function createInkVersionedRenderOutset(
  input: InkVersionedRenderOutset,
): InkVersionedRenderOutset {
  if (input.rendererVersion.length === 0) {
    throw new Error('Ink render-outset renderer version must not be empty.');
  }
  for (const value of [input.bottom, input.left, input.right, input.top]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Ink render-outset edges must be finite and non-negative.');
    }
  }
  return Object.freeze({ ...input });
}

export class InkTileDamageProjector {
  constructor(private readonly grid: InkWorldTileGrid) {}

  project(
    changedBounds: readonly InkNoteLogicalRect[],
    renderOutset: InkVersionedRenderOutset,
    lod: number,
  ): InkTileDamageSet {
    const coordinates = new Map<string, InkWorldTileCoordinate>();
    for (const bounds of changedBounds) {
      const expanded = createInkNoteLogicalRect({
        height: bounds.height + renderOutset.top + renderOutset.bottom,
        width: bounds.width + renderOutset.left + renderOutset.right,
        x: bounds.x - renderOutset.left,
        y: bounds.y - renderOutset.top,
      });
      const addressed = this.grid.addresses(expanded, lod);
      if (addressed.kind === 'untileable-range') {
        return Object.freeze({
          kind: 'untileable-range',
          rendererVersion: renderOutset.rendererVersion,
        });
      }
      for (const coordinate of addressed.coordinates) {
        coordinates.set(coordinateIdentity(coordinate), coordinate);
      }
    }
    return Object.freeze({
      coordinates: Object.freeze([...coordinates.values()]),
      kind: 'tileable',
      rendererVersion: renderOutset.rendererVersion,
    });
  }
}

function coordinateIdentity(coordinate: InkWorldTileCoordinate): string {
  return `${coordinate.lod}:${coordinate.column}:${coordinate.row}`;
}
