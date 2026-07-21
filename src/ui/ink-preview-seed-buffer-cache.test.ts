import { describe, expect, it } from 'vitest';

import type { InkPreviewCacheTile } from '../storage/indexeddb-ink-preview-cache';
import { InkGeometryCacheCoordinator } from './ink-geometry-cache';
import { InkPreviewSeedBufferCache } from './ink-preview-seed-buffer-cache';

describe('Ink Preview seed buffer cache', () => {
  it('accounts encoded buffers globally and evicts cold LRU coordinates under pressure', () => {
    const coordinator = new InkGeometryCacheCoordinator(3);
    const cache = new InkPreviewSeedBufferCache(coordinator);

    cache.merge([tile(0, 0, 0, 2)]);
    cache.merge([tile(0, 1, 0, 2)]);

    expect(coordinator.byteSize).toBe(2);
    expect(cache.snapshot()).toMatchObject([{ lod: 0, x: 1, y: 0 }]);
    cache.dispose();
    expect(coordinator.byteSize).toBe(0);
  });

  it('replaces the same LOD coordinate without double-accounting its old bytes', () => {
    const coordinator = new InkGeometryCacheCoordinator(16);
    const cache = new InkPreviewSeedBufferCache(coordinator);

    cache.merge([tile(-1, -2, 3, 2)]);
    cache.merge([tile(-1, -2, 3, 4)]);

    expect(coordinator.byteSize).toBe(4);
    expect(cache.snapshot()).toHaveLength(1);
    cache.dispose();
  });
});

function tile(lod: number, x: number, y: number, byteLength: number): InkPreviewCacheTile {
  const bytes = new Uint8Array(byteLength).buffer;
  return Object.freeze({ byteLength, bytes, lod, x, y });
}
