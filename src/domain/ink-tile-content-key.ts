import type { InkWorldTileCoordinate } from './ink-world-tile-grid';

export interface InkRasterVariant {
  readonly alphaContract: 'premultiplied-transparent-v1';
  readonly backingHeight: number;
  readonly backingWidth: number;
  readonly colorSpace: 'srgb';
  readonly pixelsPerLogicalUnit: number;
}

export interface InkTileContentKey {
  readonly coordinate: InkWorldTileCoordinate;
  readonly projectionIdentity: string;
  readonly rasterVariant: InkRasterVariant;
  readonly rendererVersion: string;
  readonly tileContentToken: string;
}

export class InkTileContentKeyFactory {
  create(input: InkTileContentKey): InkTileContentKey {
    assertIdentity(input.projectionIdentity, 'projection identity');
    assertIdentity(input.rendererVersion, 'renderer version');
    assertIdentity(input.tileContentToken, 'tile content token');
    assertCoordinate(input.coordinate);
    assertRasterVariant(input.rasterVariant);
    return Object.freeze({
      coordinate: Object.freeze({ ...input.coordinate }),
      projectionIdentity: input.projectionIdentity,
      rasterVariant: Object.freeze({ ...input.rasterVariant }),
      rendererVersion: input.rendererVersion,
      tileContentToken: input.tileContentToken,
    });
  }

  identity(key: InkTileContentKey): string {
    return JSON.stringify([
      key.projectionIdentity,
      key.rendererVersion,
      key.coordinate.lod,
      key.coordinate.column,
      key.coordinate.row,
      key.tileContentToken,
      key.rasterVariant.backingWidth,
      key.rasterVariant.backingHeight,
      key.rasterVariant.pixelsPerLogicalUnit,
      key.rasterVariant.colorSpace,
      key.rasterVariant.alphaContract,
    ]);
  }
}

function assertIdentity(value: string, label: string): void {
  if (value.length === 0) throw new Error(`Ink tile ${label} must not be empty.`);
}

function assertCoordinate(coordinate: InkWorldTileCoordinate): void {
  if (
    !Number.isSafeInteger(coordinate.lod) ||
    !Number.isSafeInteger(coordinate.column) ||
    !Number.isSafeInteger(coordinate.row)
  ) {
    throw new Error('Ink tile coordinate must contain safe integers.');
  }
}

function assertRasterVariant(variant: InkRasterVariant): void {
  if (
    !Number.isSafeInteger(variant.backingWidth) ||
    variant.backingWidth <= 0 ||
    !Number.isSafeInteger(variant.backingHeight) ||
    variant.backingHeight <= 0 ||
    !Number.isFinite(variant.pixelsPerLogicalUnit) ||
    variant.pixelsPerLogicalUnit <= 0
  ) {
    throw new Error('Ink raster variant dimensions and density must be finite and positive.');
  }
}
