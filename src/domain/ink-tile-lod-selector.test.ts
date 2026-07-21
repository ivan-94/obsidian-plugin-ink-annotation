import { describe, expect, it } from 'vitest';

import { InkTileLodSelector } from './ink-tile-lod-selector';

describe('Ink tile LOD selector', () => {
  it('selects a bounded density floor and applies hysteresis around the retained LOD', () => {
    const selector = new InkTileLodSelector({
      hysteresisRatio: 0.1,
      maximumLod: 8,
      minimumLod: -8,
    });

    expect(selector.select(1)).toBe(0);
    expect(selector.select(0.8)).toBe(-1);
    expect(selector.select(2)).toBe(1);
    expect(selector.select(0.95, 0)).toBe(0);
    expect(selector.select(0.89, 0)).toBe(-1);
    expect(selector.select(1.09, -1)).toBe(-1);
    expect(selector.select(1.1, -1)).toBe(0);
  });
});
