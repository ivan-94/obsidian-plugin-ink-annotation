import { describe, expect, it } from 'vitest';

import { calculateVirtualListWindow } from './virtual-list-window';

describe('virtual list window', () => {
  it('materializes only the viewport and overscan for 20,000 compact rows', () => {
    const window = calculateVirtualListWindow({
      overscan: 4,
      rowHeight: 56,
      scrollTop: 560_000,
      total: 20_000,
      viewportHeight: 560,
    });

    expect(window).toEqual({
      end: 10_014,
      offsetTop: 559_776,
      start: 9_996,
      totalHeight: 1_120_000,
    });
    expect(window.end - window.start).toBeLessThan(25);
  });
});
