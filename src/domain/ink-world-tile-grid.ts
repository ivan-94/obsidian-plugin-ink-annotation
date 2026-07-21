export interface InkNoteLogicalPoint {
  readonly coordinateSpace: 'note-logical';
  readonly x: number;
  readonly y: number;
}

export interface InkNoteLogicalRect {
  readonly coordinateSpace: 'note-logical';
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface InkWorldTileCoordinate {
  readonly column: number;
  readonly lod: number;
  readonly row: number;
}

export type InkTileAddressResult =
  | {
      readonly coordinate: InkWorldTileCoordinate;
      readonly kind: 'tileable';
    }
  | { readonly kind: 'untileable-range' };

export type InkTileRegionAddressResult =
  | {
      readonly coordinates: readonly InkWorldTileCoordinate[];
      readonly kind: 'tileable';
    }
  | { readonly kind: 'untileable-range' };

export function createInkNoteLogicalPoint(input: {
  readonly x: number;
  readonly y: number;
}): InkNoteLogicalPoint {
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
    throw new Error('Ink note-logical point coordinates must be finite.');
  }
  return Object.freeze({ coordinateSpace: 'note-logical', x: input.x, y: input.y });
}

export function createInkNoteLogicalRect(input: {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}): InkNoteLogicalRect {
  if (
    !Number.isFinite(input.x) ||
    !Number.isFinite(input.y) ||
    !Number.isFinite(input.width) ||
    !Number.isFinite(input.height) ||
    input.width < 0 ||
    input.height < 0
  ) {
    throw new Error('Ink note-logical rect must have finite non-negative dimensions.');
  }
  return Object.freeze({ coordinateSpace: 'note-logical', ...input });
}

export class InkWorldTileGrid {
  private readonly baseWorldSpan: number;
  private readonly maximumRegionTileCount: number;

  constructor(input: { readonly baseWorldSpan: number; readonly maximumRegionTileCount?: number }) {
    if (!Number.isFinite(input.baseWorldSpan) || input.baseWorldSpan <= 0) {
      throw new Error('Ink world tile base span must be finite and positive.');
    }
    this.baseWorldSpan = input.baseWorldSpan;
    this.maximumRegionTileCount = input.maximumRegionTileCount ?? 4_096;
    if (!Number.isSafeInteger(this.maximumRegionTileCount) || this.maximumRegionTileCount <= 0) {
      throw new Error('Ink world tile region limit must be a positive safe integer.');
    }
  }

  address(point: InkNoteLogicalPoint, lod: number): InkTileAddressResult {
    const span = this.worldSpan(lod);
    const column = Math.floor(point.x / span);
    const row = Math.floor(point.y / span);
    if (!Number.isSafeInteger(column) || !Number.isSafeInteger(row)) {
      return Object.freeze({ kind: 'untileable-range' });
    }
    return Object.freeze({
      coordinate: Object.freeze({ column, lod, row }),
      kind: 'tileable',
    });
  }

  addresses(bounds: InkNoteLogicalRect, lod: number): InkTileRegionAddressResult {
    if (bounds.width === 0 || bounds.height === 0) {
      return Object.freeze({ coordinates: Object.freeze([]), kind: 'tileable' });
    }
    const span = this.worldSpan(lod);
    const minimumColumn = Math.floor(bounds.x / span);
    const minimumRow = Math.floor(bounds.y / span);
    const maximumColumn = Math.ceil((bounds.x + bounds.width) / span) - 1;
    const maximumRow = Math.ceil((bounds.y + bounds.height) / span) - 1;
    if (
      !Number.isSafeInteger(minimumColumn) ||
      !Number.isSafeInteger(minimumRow) ||
      !Number.isSafeInteger(maximumColumn) ||
      !Number.isSafeInteger(maximumRow)
    ) {
      return Object.freeze({ kind: 'untileable-range' });
    }
    const columnCount = maximumColumn - minimumColumn + 1;
    const rowCount = maximumRow - minimumRow + 1;
    if (
      !Number.isSafeInteger(columnCount) ||
      !Number.isSafeInteger(rowCount) ||
      columnCount > this.maximumRegionTileCount / rowCount
    ) {
      return Object.freeze({ kind: 'untileable-range' });
    }
    const coordinates: InkWorldTileCoordinate[] = [];
    for (let row = minimumRow; row <= maximumRow; row += 1) {
      for (let column = minimumColumn; column <= maximumColumn; column += 1) {
        coordinates.push(Object.freeze({ column, lod, row }));
      }
    }
    return Object.freeze({ coordinates: Object.freeze(coordinates), kind: 'tileable' });
  }

  nominalBounds(coordinate: InkWorldTileCoordinate): InkNoteLogicalRect {
    const span = this.worldSpan(coordinate.lod);
    return Object.freeze({
      coordinateSpace: 'note-logical',
      height: span,
      width: span,
      x: coordinate.column * span,
      y: coordinate.row * span,
    });
  }

  parent(coordinate: InkWorldTileCoordinate): InkWorldTileCoordinate {
    const lod = coordinate.lod - 1;
    this.worldSpan(lod);
    return Object.freeze({
      column: Math.floor(coordinate.column / 2),
      lod,
      row: Math.floor(coordinate.row / 2),
    });
  }

  private worldSpan(lod: number): number {
    if (!Number.isSafeInteger(lod)) {
      throw new Error('Ink world tile LOD must be a safe integer.');
    }
    const span = this.baseWorldSpan / 2 ** lod;
    if (!Number.isFinite(span) || span <= 0) {
      throw new Error('Ink world tile LOD is outside the representable range.');
    }
    return span;
  }
}
