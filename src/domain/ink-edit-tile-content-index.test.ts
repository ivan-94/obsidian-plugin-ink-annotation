import { describe, expect, it } from 'vitest';

import { InkEditTileContentIndex } from './ink-edit-tile-content-index';
import type { InkTileDamageSet } from './ink-tile-damage-projector';
import { InkWorldTileGrid, type InkWorldTileCoordinate } from './ink-world-tile-grid';

describe('Ink Edit tile content index', () => {
  it('advances the scene revision while inheriting unrelated per-coordinate content tokens', () => {
    const grid = new InkWorldTileGrid({ baseWorldSpan: 256 });
    const changed: InkWorldTileCoordinate = { column: -1, lod: 0, row: 2 };
    const unchanged: InkWorldTileCoordinate = { column: 4, lod: 0, row: 2 };
    const index = new InkEditTileContentIndex({ grid, projectionIdentity: 'edit-session-7' });
    const changedBefore = index.contentToken(changed);
    const unchangedBefore = index.contentToken(unchanged);
    const damage: InkTileDamageSet = {
      coordinates: [changed],
      kind: 'tileable',
      rendererVersion: 'pen-v7',
    };

    const revision = index.applyDamage(damage);

    expect(revision).toBe(1);
    expect(index.sceneRevision).toBe(1);
    expect(index.contentToken(changed)).not.toBe(changedBefore);
    expect(index.contentToken(unchanged)).toBe(unchangedBefore);
    expect(index.projectionIdentity).toBe('edit-session-7');
  });

  it('invalidates every already-addressed LOD that overlaps changed Ink', () => {
    const grid = new InkWorldTileGrid({ baseWorldSpan: 256 });
    const changed: InkWorldTileCoordinate = { column: 0, lod: 0, row: 0 };
    const parent: InkWorldTileCoordinate = { column: 0, lod: -1, row: 0 };
    const child: InkWorldTileCoordinate = { column: 1, lod: 1, row: 1 };
    const unrelated: InkWorldTileCoordinate = { column: 1, lod: 0, row: 0 };
    const index = new InkEditTileContentIndex({ grid, projectionIdentity: 'edit-session-lod' });
    const before = new Map(
      [changed, parent, child, unrelated].map((coordinate) => [
        coordinate,
        index.contentToken(coordinate),
      ]),
    );

    index.applyDamage({
      coordinates: [changed],
      kind: 'tileable',
      rendererVersion: 'pen-v7',
    });

    expect(index.contentToken(changed)).not.toBe(before.get(changed));
    expect(index.contentToken(parent)).not.toBe(before.get(parent));
    expect(index.contentToken(child)).not.toBe(before.get(child));
    expect(index.contentToken(unrelated)).toBe(before.get(unrelated));
  });
});
