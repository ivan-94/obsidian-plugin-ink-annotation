import { describe, expect, it } from 'vitest';

import { InkTileContentKeyFactory } from './ink-tile-content-key';

describe('InkTileContentKeyFactory', () => {
  it('separates stable spatial coordinates from exact disposable content identity', () => {
    const factory = new InkTileContentKeyFactory();
    const coordinate = { column: -2, lod: 1, row: 3 };
    const rasterVariant = {
      alphaContract: 'premultiplied-transparent-v1' as const,
      backingHeight: 256,
      backingWidth: 256,
      colorSpace: 'srgb' as const,
      pixelsPerLogicalUnit: 2,
    };
    const current = factory.create({
      coordinate,
      projectionIdentity: 'edit-session-a',
      rasterVariant,
      rendererVersion: 'pen-v1',
      tileContentToken: 'tile-token-7',
    });
    const changed = factory.create({
      coordinate,
      projectionIdentity: 'edit-session-a',
      rasterVariant,
      rendererVersion: 'pen-v1',
      tileContentToken: 'tile-token-8',
    });

    expect(current.coordinate).toEqual(changed.coordinate);
    expect(factory.identity(current)).not.toBe(factory.identity(changed));
  });
});
