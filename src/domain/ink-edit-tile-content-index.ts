import type { InkTileDamageSet } from './ink-tile-damage-projector';
import type {
  InkNoteLogicalRect,
  InkWorldTileCoordinate,
  InkWorldTileGrid,
} from './ink-world-tile-grid';

interface AddressedTileRevision {
  readonly coordinate: InkWorldTileCoordinate;
  revision: number;
}

/** Process-local Edit freshness. Spatial coordinates never include this mutable state. */
export class InkEditTileContentIndex {
  readonly projectionIdentity: string;
  private readonly addressed = new Map<string, AddressedTileRevision>();
  private readonly grid: InkWorldTileGrid;
  private revision = 0;

  constructor(input: { readonly grid: InkWorldTileGrid; readonly projectionIdentity: string }) {
    if (input.projectionIdentity.length === 0) {
      throw new Error('Ink Edit tile projection identity must not be empty.');
    }
    this.grid = input.grid;
    this.projectionIdentity = input.projectionIdentity;
  }

  get sceneRevision(): number {
    return this.revision;
  }

  contentToken(coordinate: InkWorldTileCoordinate): string {
    const identity = coordinateIdentity(coordinate);
    let addressed = this.addressed.get(identity);
    if (addressed === undefined) {
      addressed = { coordinate: Object.freeze({ ...coordinate }), revision: this.revision };
      this.addressed.set(identity, addressed);
    }
    return addressed.revision === 0
      ? `${this.projectionIdentity}:initial`
      : `${this.projectionIdentity}:revision:${addressed.revision}`;
  }

  applyDamage(damage: InkTileDamageSet): number {
    this.revision += 1;
    if (damage.kind === 'untileable-range') {
      for (const addressed of this.addressed.values()) addressed.revision = this.revision;
      return this.revision;
    }
    const damagedBounds = damage.coordinates.map((coordinate) =>
      this.grid.nominalBounds(coordinate),
    );
    for (const addressed of this.addressed.values()) {
      const bounds = this.grid.nominalBounds(addressed.coordinate);
      if (damagedBounds.some((damaged) => overlaps(bounds, damaged))) {
        addressed.revision = this.revision;
      }
    }
    return this.revision;
  }
}

function coordinateIdentity(coordinate: InkWorldTileCoordinate): string {
  if (
    !Number.isSafeInteger(coordinate.lod) ||
    !Number.isSafeInteger(coordinate.column) ||
    !Number.isSafeInteger(coordinate.row)
  ) {
    throw new Error('Ink Edit tile coordinate must contain safe integers.');
  }
  return `${coordinate.lod}:${coordinate.column}:${coordinate.row}`;
}

function overlaps(left: InkNoteLogicalRect, right: InkNoteLogicalRect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}
