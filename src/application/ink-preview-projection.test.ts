import { describe, expect, it } from 'vitest';

import type { InkSurfaceRecord } from '../domain/ink-surface';
import { InkPreviewProjection } from './ink-preview-projection';

describe('InkPreviewProjection', () => {
  it('builds a read-only spatial projection without editable session state', () => {
    const projection = new InkPreviewProjection([
      surface('top', 0, 600, 'top-stroke', 40),
      surface('bottom', 600, 400, 'bottom-stroke', 40),
    ]);

    expect(projection.read()).toMatchObject({
      logicalHeight: 1_000,
      strokeCount: 2,
    });
    expect(projection.read()).not.toHaveProperty('persistence');
    expect(projection.read()).not.toHaveProperty('state');
    expect(projection.query({ height: 120, width: 960, x: 0, y: 580 }).map(({ id }) => id)).toEqual(
      ['bottom-stroke'],
    );
    expect(Object.keys(projection).sort()).toEqual([]);
  });

  it('does not inspect stroke points until a cache miss queries their visible surface', () => {
    const top = surface('top', 0, 600, 'top-stroke', 40);
    const bottom = surface('bottom', 600, 400, 'bottom-stroke', 40);
    let topPointReads = 0;
    let bottomPointReads = 0;
    observePointReads(top.strokes[0] as InkSurfaceRecord['strokes'][number], () => {
      topPointReads += 1;
    });
    observePointReads(bottom.strokes[0] as InkSurfaceRecord['strokes'][number], () => {
      bottomPointReads += 1;
    });

    const projection = new InkPreviewProjection([top, bottom]);

    expect(projection.read().indexBytes).toBe(0);
    expect(topPointReads).toBe(0);
    expect(bottomPointReads).toBe(0);

    expect(projection.query({ height: 120, width: 960, x: 0, y: 0 })).toHaveLength(1);
    expect(topPointReads).toBeGreaterThan(0);
    expect(bottomPointReads).toBe(0);
    expect(projection.read().indexBytes).toBeGreaterThan(0);
  });

  it('splits a many-stroke cache-miss query into bounded resumable index units', () => {
    const base = surface('many', 0, 600, 'stroke-0', 40);
    const record = {
      ...base,
      strokes: Array.from({ length: 25 }, (_value, index) => ({
        ...base.strokes[0]!,
        id: `stroke-${index}`,
        points: [
          { pressure: 0.5, time: 1, x: 10, y: 20 + index * 10 },
          { pressure: 0.5, time: 2, x: 80, y: 25 + index * 10 },
        ],
      })),
    };
    const projection = new InkPreviewProjection([record]);

    const work = projection.prepareQuery({ height: 600, width: 960, x: 0, y: 0 });

    expect(work.units.length).toBeGreaterThan(2);
    work.units[0]?.();
    expect(projection.read().indexBytes).toBeGreaterThan(0);
    expect(work.result()).toEqual([]);
    for (const unit of work.units.slice(1)) unit();
    expect(work.result().map(({ id }) => id)).toEqual(
      Array.from({ length: 25 }, (_value, index) => `stroke-${index}`),
    );
  });
});

function observePointReads(stroke: InkSurfaceRecord['strokes'][number], read: () => void): void {
  const points = stroke.points;
  Object.defineProperty(stroke, 'points', {
    configurable: true,
    get: () => {
      read();
      return points;
    },
  });
}

function surface(
  id: string,
  originY: number,
  logicalHeight: number,
  strokeId: string,
  strokeY: number,
): InkSurfaceRecord {
  return {
    createdAt: '2026-07-20T00:00:00.000Z',
    filePath: 'Ink.md',
    id,
    layout: {
      blockFingerprints: [],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight,
      logicalWidth: 960,
      originY,
      sourceRevision: 'source',
      themeMode: 'light',
    },
    noteId: 'note',
    revision: 1,
    schemaVersion: 2,
    status: 'active',
    strokes: [
      {
        color: '#112233',
        id: strokeId,
        points: [
          { pressure: 0.5, time: 1, x: 10, y: strokeY },
          { pressure: 0.5, time: 2, x: 80, y: strokeY + 10 },
        ],
        tool: 'pen',
        width: 4,
      },
    ],
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}
