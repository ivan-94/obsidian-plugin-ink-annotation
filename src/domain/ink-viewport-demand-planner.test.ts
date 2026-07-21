import { describe, expect, it } from 'vitest';

import { InkViewportDemandPlanner } from './ink-viewport-demand-planner';
import { createInkNoteLogicalRect, InkWorldTileGrid } from './ink-world-tile-grid';

describe('InkViewportDemandPlanner', () => {
  const planner = new InkViewportDemandPlanner({
    grid: new InkWorldTileGrid({ baseWorldSpan: 100 }),
    lookAheadRings: 1,
    nearVisibleRings: 1,
  });

  it('keeps visible, near-visible, and directional look-ahead coordinates disjoint', () => {
    const plan = planner.plan({
      lod: 0,
      previousViewport: createInkNoteLogicalRect({ height: 100, width: 100, x: 0, y: 0 }),
      viewport: createInkNoteLogicalRect({ height: 100, width: 100, x: 100, y: 0 }),
    });

    expect(plan.kind).toBe('tileable');
    if (plan.kind !== 'tileable') return;
    expect(plan.visible).toEqual([{ column: 1, lod: 0, row: 0 }]);
    expect(plan.nearVisible).toContainEqual({ column: 2, lod: 0, row: 0 });
    expect(plan.lookAhead).toContainEqual({ column: 3, lod: 0, row: 0 });
    expect(plan.lookAhead).not.toContainEqual({ column: -2, lod: 0, row: 0 });
    const identities = [...plan.visible, ...plan.nearVisible, ...plan.lookAhead].map(
      ({ column, lod, row }) => `${lod}:${column}:${row}`,
    );
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('preserves signed coordinates while planning reverse scroll', () => {
    const plan = planner.plan({
      lod: 0,
      previousViewport: createInkNoteLogicalRect({ height: 100, width: 100, x: 0, y: 0 }),
      viewport: createInkNoteLogicalRect({ height: 100, width: 100, x: -100, y: -100 }),
    });

    expect(plan.kind).toBe('tileable');
    if (plan.kind !== 'tileable') return;
    expect(plan.visible).toEqual([{ column: -1, lod: 0, row: -1 }]);
    expect(plan.lookAhead).toContainEqual({ column: -3, lod: 0, row: -3 });
  });
});
