import { describe, expect, it } from 'vitest';

import type { InkSurfaceRecord } from './ink-surface';
import { INK_SAFE_EDITING_MARGIN, ensureInkCanvasExtent } from './ink-canvas-extent';

describe('continuous Ink canvas extent', () => {
  it('extends the final chunk past the farthest stored Ink visual bound', () => {
    const records = [surface('top', 0, 600), surface('bottom', 600, 400, 350)];

    const extended = ensureInkCanvasExtent(records, 800);

    expect(INK_SAFE_EDITING_MARGIN).toBe(512);
    expect(extended[0]).toBe(records[0]);
    expect(extended[1]).not.toBe(records[1]);
    expect(extended[1]?.layout.logicalHeight).toBe(864);
    expect(extended[1]?.revision).toBe(1);
    expect(records[1]?.layout.logicalHeight).toBe(400);
  });

  it('uses rendered document height when it is farther than stored Ink plus margin', () => {
    const records = [surface('only', 0, 1_000, 100)];

    const extended = ensureInkCanvasExtent(records, 2_000);

    expect(extended[0]?.layout.logicalHeight).toBe(2_000);
  });

  it('keeps already sufficient canonical chunks byte-shape stable', () => {
    const records = [surface('only', 0, 2_000, 100)];

    expect(ensureInkCanvasExtent(records, 1_500)).toEqual(records);
    expect(ensureInkCanvasExtent(records, 1_500)[0]).toBe(records[0]);
  });

  it('uses explicit origins for reordered schema-v3 chunks separated by a gap', () => {
    const records: readonly InkSurfaceRecord[] = [
      { ...surface('bottom', 1_000, 100), schemaVersion: 3 },
      { ...surface('top', 0, 100), schemaVersion: 3 },
    ];

    const extended = ensureInkCanvasExtent(records, 1_200, 0);

    expect(extended[0]?.layout.logicalHeight).toBe(200);
    expect(extended[1]).toBe(records[1]);
  });

  it('extends from the shared physical nib bound instead of a legacy line width', () => {
    const base = surface('physical', 0, 100);
    const records: readonly InkSurfaceRecord[] = [
      {
        ...base,
        schemaVersion: 3,
        strokes: [
          {
            brushRenderVersion: 'pen-physical-v1',
            color: '#111111',
            id: 'pressure-tap',
            inputProfile: { pressure: 'measured', tilt: 'unavailable' },
            points: [
              {
                orientation: { kind: 'unavailable' },
                pressure: 1,
                pressureKind: 'measured',
                time: 0,
                x: 10,
                y: 99,
              },
            ],
            tool: 'pen',
            width: 4,
          },
        ],
      },
    ];

    expect(ensureInkCanvasExtent(records, 0, 0)[0]?.layout.logicalHeight).toBe(102);
  });

  it('does not extend the visible canvas for a preserved historical Eraser record', () => {
    const base = surface('historical-eraser', 0, 100);
    const records: readonly InkSurfaceRecord[] = [
      {
        ...base,
        schemaVersion: 3,
        strokes: [
          {
            color: '#ffffff',
            id: 'historical-eraser',
            points: [
              { pressure: 0.5, time: 0, x: 10, y: 10_000 },
              { pressure: 0.5, time: 1, x: 20, y: 10_010 },
            ],
            tool: 'eraser',
            width: 20,
          },
        ],
      },
    ];

    expect(ensureInkCanvasExtent(records, 0, 0)).toBe(records);
  });
});

function surface(
  id: string,
  originY: number,
  logicalHeight: number,
  inkY?: number,
): InkSurfaceRecord {
  return {
    createdAt: '2026-07-15T00:00:00.000Z',
    filePath: 'Ink.md',
    id,
    layout: {
      blockFingerprints: [],
      fontFamily: 'Inter',
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
    strokes:
      inkY === undefined
        ? []
        : [
            {
              color: '#111111',
              id: `stroke-${id}`,
              points: [
                { pressure: 0.5, time: 0, x: 10, y: inkY },
                { pressure: 0.5, time: 1, x: 20, y: inkY },
              ],
              tool: 'pen',
              width: 4,
            },
          ],
    updatedAt: '2026-07-15T00:00:00.000Z',
  };
}
