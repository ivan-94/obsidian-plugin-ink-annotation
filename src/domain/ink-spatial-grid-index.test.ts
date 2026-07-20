import { describe, expect, it } from 'vitest';

import { InkSpatialGridIndex } from './ink-spatial-grid-index';

describe('InkSpatialGridIndex', () => {
  it('reads the byte estimate without revisiting indexed history', () => {
    const index = new InkSpatialGridIndex<number>(64);
    let idLengthReads = 0;
    for (let entry = 0; entry < 256; entry += 1) {
      const observableId = {
        get length() {
          idLengthReads += 1;
          return 12;
        },
      } as unknown as string;
      index.set(observableId, { height: 4, width: 4, x: entry * 64 + 1, y: 1 }, entry);
    }
    const readsAfterMutation = idLengthReads;
    const estimate = index.byteSizeEstimate;

    for (let read = 0; read < 32; read += 1) {
      expect(index.byteSizeEstimate).toBe(estimate);
    }

    expect(idLengthReads).toBe(readsAfterMutation);
  });

  it('keeps the byte estimate exact across cross-cell replacement and deletion', () => {
    const index = new InkSpatialGridIndex<string>(10);
    const entryBytes = (id: string, cellCount: number) => 160 + id.length * 2 + cellCount * 32;

    expect(index.byteSizeEstimate).toBe(0);

    index.set('wide', { height: 4, width: 4, x: 8, y: 8 }, 'crosses-four-cells');
    expect(index.byteSizeEstimate).toBe(4 * 96 + entryBytes('wide', 4));

    index.set('point', { height: 2, width: 2, x: 1, y: 1 }, 'shares-one-cell');
    expect(index.byteSizeEstimate).toBe(4 * 96 + entryBytes('wide', 4) + entryBytes('point', 1));

    index.set('wide', { height: 2, width: 2, x: 21, y: 1 }, 'replacement');
    expect(index.byteSizeEstimate).toBe(2 * 96 + entryBytes('wide', 1) + entryBytes('point', 1));

    expect(index.delete('missing')).toBe(false);
    expect(index.byteSizeEstimate).toBe(2 * 96 + entryBytes('wide', 1) + entryBytes('point', 1));
    expect(index.delete('point')).toBe(true);
    expect(index.byteSizeEstimate).toBe(96 + entryBytes('wide', 1));
    expect(index.delete('wide')).toBe(true);
    expect(index.byteSizeEstimate).toBe(0);
  });

  it('keeps a small horizontal-tail query independent of a 50k-segment prefix', () => {
    const index = new InkSpatialGridIndex<number>(64);
    for (let segment = 0; segment < 50_000; segment += 1) {
      index.set(`segment:${segment}`, { height: 4, width: 5, x: segment * 4 - 2, y: 98 }, segment);
    }

    const result = index.query({ height: 8, width: 12, x: 199_988, y: 96 });

    expect(result.values).toEqual([49_997, 49_998, 49_999]);
    expect(result.visitedEntryCount).toBeLessThanOrEqual(32);
    expect(index.byteSizeEstimate).toBeGreaterThan(0);
  });

  it('deduplicates entries spanning multiple cells and replaces an existing ID', () => {
    const index = new InkSpatialGridIndex<string>(32);
    index.set('wide', { height: 40, width: 80, x: 0, y: 0 }, 'first');
    index.set('wide', { height: 4, width: 4, x: 200, y: 200 }, 'replacement');

    expect(index.query({ height: 100, width: 100, x: 0, y: 0 }).values).toEqual([]);
    expect(index.query({ height: 8, width: 8, x: 198, y: 198 }).values).toEqual(['replacement']);
  });
});
