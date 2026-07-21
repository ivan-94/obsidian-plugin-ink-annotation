import { describe, expect, it, vi } from 'vitest';

import { InkRasterTileCache } from './ink-raster-tile-cache';

describe('Ink committed raster tile cache', () => {
  it('evicts least-recently-used tiles to remain inside the byte budget', () => {
    const dispose = vi.fn();
    const cache = new InkRasterTileCache<string>(200, dispose);

    cache.put('a', 'A', { height: 10, width: 10, x: 0, y: 0 }, 100);
    cache.put('b', 'B', { height: 10, width: 10, x: 10, y: 0 }, 100);
    expect(cache.get('a')).toBe('A');
    cache.put('c', 'C', { height: 10, width: 10, x: 20, y: 0 }, 100);

    expect(cache.get('a')).toBe('A');
    expect(cache.get('b')).toBeNull();
    expect(cache.get('c')).toBe('C');
    expect(cache.stats()).toMatchObject({ bytes: 200, entryCount: 2, evictionCount: 1 });
    expect(dispose).toHaveBeenCalledWith('B');
  });

  it('invalidates only tiles intersecting document damage', () => {
    const dispose = vi.fn();
    const cache = new InkRasterTileCache<string>(1_000, dispose);
    cache.put('top', 'TOP', { height: 100, width: 100, x: 0, y: 0 }, 100);
    cache.put('bottom', 'BOTTOM', { height: 100, width: 100, x: 0, y: 200 }, 100);

    cache.invalidate({ height: 20, width: 20, x: 40, y: 40 });

    expect(cache.get('top')).toBeNull();
    expect(cache.get('bottom')).toBe('BOTTOM');
    expect(dispose).toHaveBeenCalledWith('TOP');
  });

  it('releases every retained backing when cleared', () => {
    const disposed: string[] = [];
    const dispose = (value: string): void => {
      disposed.push(value);
    };
    const cache = new InkRasterTileCache<string>(1_000, dispose);
    cache.put('a', 'A', { height: 10, width: 10, x: 0, y: 0 }, 100);
    cache.put('b', 'B', { height: 10, width: 10, x: 10, y: 0 }, 100);

    cache.clear();

    expect(cache.stats()).toMatchObject({ bytes: 0, entryCount: 0 });
    expect(disposed.sort()).toEqual(['A', 'B']);
  });

  it('transfers retained ownership without disposing or leaking byte accounting', () => {
    const dispose = vi.fn();
    const cache = new InkRasterTileCache<string>(1_000, dispose);
    cache.put('a', 'A', { height: 10, width: 10, x: 0, y: 0 }, 100, 'visible');

    expect(cache.take('a')).toBe('A');

    expect(cache.stats()).toMatchObject({ bytes: 0, entryCount: 0 });
    expect(dispose).not.toHaveBeenCalled();
  });

  it('reports when a tile cannot remain inside the byte budget', () => {
    const dispose = vi.fn();
    const cache = new InkRasterTileCache<string>(99, dispose);

    const retained = cache.put('oversized', 'VALUE', { height: 10, width: 10, x: 0, y: 0 }, 100);

    expect(retained).toBe(false);
    expect(cache.stats()).toMatchObject({ bytes: 0, entryCount: 0 });
    expect(dispose).toHaveBeenCalledWith('VALUE');
  });

  it('evicts cold tiles before visible retained coverage even when the cold tile was used later', () => {
    const cache = new InkRasterTileCache<string>(200, () => undefined);
    cache.put('visible', 'VISIBLE', { height: 10, width: 10, x: 0, y: 0 }, 100);
    cache.put('cold', 'COLD', { height: 10, width: 10, x: 10, y: 0 }, 100);
    cache.setResidency('visible', 'visible');
    cache.setResidency('cold', 'cold');
    cache.get('cold');

    cache.put('new', 'NEW', { height: 10, width: 10, x: 20, y: 0 }, 100);

    expect(cache.get('visible')).toBe('VISIBLE');
    expect(cache.get('cold')).toBeNull();
    expect(cache.get('new')).toBe('NEW');
  });

  it('never evicts visible or dirty presentation truth before its replacement is adopted', () => {
    const dispose = vi.fn();
    const cache = new InkRasterTileCache<string>(300, dispose);
    cache.put('visible', 'VISIBLE', { height: 10, width: 10, x: 0, y: 0 }, 100, 'visible');
    cache.put('dirty', 'DIRTY', { height: 10, width: 10, x: 10, y: 0 }, 100, 'dirty');
    cache.put('cold', 'COLD', { height: 10, width: 10, x: 20, y: 0 }, 100, 'cold');

    cache.setMaxBytes(0);

    expect(cache.get('visible')).toBe('VISIBLE');
    expect(cache.get('dirty')).toBe('DIRTY');
    expect(cache.get('cold')).toBeNull();
    expect(cache.stats()).toMatchObject({ bytes: 200, entryCount: 2 });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps invalidated visible coverage as dirty presentation truth unless forced', () => {
    const dispose = vi.fn();
    const cache = new InkRasterTileCache<string>(200, dispose);
    const bounds = { height: 100, width: 100, x: 0, y: 0 } as const;
    cache.put('visible', 'VISIBLE', bounds, 100, 'visible');

    cache.invalidate({ height: 20, width: 20, x: 40, y: 40 });

    expect(cache.get('visible')).toBe('VISIBLE');
    expect(dispose).not.toHaveBeenCalled();

    cache.invalidate(bounds, { evictPresented: true });

    expect(cache.get('visible')).toBeNull();
    expect(dispose).toHaveBeenCalledWith('VISIBLE');
  });

  it('makes dispose terminal so released tile memory cannot be retained outside accounting', () => {
    const cache = new InkRasterTileCache<string>(200, () => undefined);
    cache.dispose();

    expect(() => cache.put('late', 'LATE', { height: 10, width: 10, x: 0, y: 0 }, 100)).toThrow(
      'disposed',
    );
  });
});
