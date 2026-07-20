import { describe, expect, it } from 'vitest';

import type { CompiledInkStroke } from '../domain/ink-stroke-geometry';
import { InkGeometryCache, InkGeometryCacheCoordinator } from './ink-geometry-cache';

describe('Ink geometry cache budgets', () => {
  it('evicts outside-viewport least-recently-used geometry before visible geometry', () => {
    const coordinator = new InkGeometryCacheCoordinator(1_000);
    const cache = new InkGeometryCache({ coordinator, maximumBytes: 300 });
    cache.put('outside-old', geometry('outside-old', 140), false);
    cache.put('visible', geometry('visible', 140), true);
    cache.get('visible');
    cache.put('outside-new', geometry('outside-new', 140), false);

    expect(cache.get('outside-old')).toBeNull();
    expect(cache.get('visible')?.strokeId).toBe('visible');
    expect(cache.get('outside-new')?.strokeId).toBe('outside-new');
    expect(cache.stats().bytes).toBeLessThanOrEqual(300);
  });

  it('enforces a plugin-wide budget across mounted documents', () => {
    const coordinator = new InkGeometryCacheCoordinator(360);
    const first = new InkGeometryCache({ coordinator, maximumBytes: 300 });
    const second = new InkGeometryCache({ coordinator, maximumBytes: 300 });
    first.put('first', geometry('first', 200), false);
    second.put('second', geometry('second', 200), false);

    expect(coordinator.byteSize).toBeLessThanOrEqual(360);
    expect(first.stats().entryCount + second.stats().entryCount).toBe(1);
  });

  it('counts every mounted spatial index inside the plugin-wide disposable budget', () => {
    const coordinator = new InkGeometryCacheCoordinator(360);
    const first = new InkGeometryCache({ coordinator, maximumBytes: 300 });
    const second = new InkGeometryCache({ coordinator, maximumBytes: 300 });
    first.setIndexBytes(160);
    second.setIndexBytes(160);
    first.put('first', geometry('first', 100), false);
    second.put('second', geometry('second', 100), false);

    expect(coordinator.byteSize).toBeLessThanOrEqual(360);
    expect(first.stats().bytes + second.stats().bytes).toBe(0);
  });

  it('reserves index bytes inside the local disposable budget and invalidates exact IDs', () => {
    const cache = new InkGeometryCache({
      coordinator: new InkGeometryCacheCoordinator(2_000),
      maximumBytes: 500,
    });
    cache.setIndexBytes(300);
    cache.put('stroke-a|one', geometry('stroke-a', 120), true);
    cache.put('stroke-b|one', geometry('stroke-b', 120), true);

    expect(cache.stats()).toMatchObject({ bytes: 120, indexBytes: 300 });
    expect(cache.invalidateStrokeIds(['stroke-a'])).toBe(0);
    expect(cache.invalidateStrokeIds(['stroke-b'])).toBe(1);
    expect(cache.stats().bytes + cache.stats().indexBytes).toBeLessThanOrEqual(500);
  });
});

function geometry(strokeId: string, byteSizeEstimate: number): CompiledInkStroke {
  return {
    bounds: { height: 1, width: 1, x: 0, y: 0 },
    byteSizeEstimate,
    digest: strokeId,
    paint: {
      color: '#000000',
      composite: 'source-over',
      lineCap: 'round',
      lineJoin: 'round',
      opacity: 1,
    },
    points: [{ pressure: 0.5, time: 0, x: 0, y: 0 }],
    strokeId,
    tool: 'pen',
    version: 'legacy-round-v1',
    width: 1,
  };
}
