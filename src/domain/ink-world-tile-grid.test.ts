import { describe, expect, it } from 'vitest';

import {
  createInkNoteLogicalPoint,
  createInkNoteLogicalRect,
  InkWorldTileGrid,
} from './ink-world-tile-grid';

describe('InkWorldTileGrid', () => {
  it('maps negative note-logical coordinates with mathematical floor', () => {
    const grid = new InkWorldTileGrid({ baseWorldSpan: 256 });

    expect(grid.address(createInkNoteLogicalPoint({ x: -1, y: -257 }), 0)).toEqual({
      coordinate: { column: -1, lod: 0, row: -2 },
      kind: 'tileable',
    });
  });

  it('uses one exact LOD hierarchy for bounds and negative parent coordinates', () => {
    const grid = new InkWorldTileGrid({ baseWorldSpan: 256 });
    const child = { column: -1, lod: 1, row: -3 };

    expect(grid.nominalBounds(child)).toEqual({
      coordinateSpace: 'note-logical',
      height: 128,
      width: 128,
      x: -128,
      y: -384,
    });
    expect(grid.parent(child)).toEqual({ column: -1, lod: 0, row: -2 });
  });

  it('addresses half-open note-logical regions without duplicating exact tile edges', () => {
    const grid = new InkWorldTileGrid({ baseWorldSpan: 256 });

    expect(
      grid.addresses(createInkNoteLogicalRect({ height: 256, width: 257, x: -1, y: 0 }), 0),
    ).toEqual({
      coordinates: [
        { column: -1, lod: 0, row: 0 },
        { column: 0, lod: 0, row: 0 },
      ],
      kind: 'tileable',
    });
  });

  it('fails closed before allocating an unbounded region coordinate array', () => {
    const grid = new InkWorldTileGrid({ baseWorldSpan: 256, maximumRegionTileCount: 4 });

    expect(
      grid.addresses(createInkNoteLogicalRect({ height: 512, width: 768, x: 0, y: 0 }), 0),
    ).toEqual({ kind: 'untileable-range' });
  });
});
