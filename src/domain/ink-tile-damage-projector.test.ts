import { describe, expect, it } from 'vitest';

import {
  InkTileDamageProjector,
  createInkVersionedRenderOutset,
} from './ink-tile-damage-projector';
import { InkWorldTileGrid, createInkNoteLogicalRect } from './ink-world-tile-grid';

describe('Ink tile damage projector', () => {
  it('uses the renderer outset once and invalidates only intersecting signed world tiles', () => {
    const grid = new InkWorldTileGrid({ baseWorldSpan: 256 });
    const projector = new InkTileDamageProjector(grid);

    const damage = projector.project(
      [createInkNoteLogicalRect({ height: 2, width: 2, x: 255, y: -1 })],
      createInkVersionedRenderOutset({
        bottom: 1,
        left: 1,
        rendererVersion: 'pen-v7',
        right: 1,
        top: 1,
      }),
      0,
    );

    expect(damage).toEqual({
      coordinates: [
        { column: 0, lod: 0, row: -1 },
        { column: 1, lod: 0, row: -1 },
        { column: 0, lod: 0, row: 0 },
        { column: 1, lod: 0, row: 0 },
      ],
      kind: 'tileable',
      rendererVersion: 'pen-v7',
    });
  });
});
