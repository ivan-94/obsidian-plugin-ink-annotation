import { describe, expect, it } from 'vitest';

import {
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  type InkPhysicalPoint,
  type InkStroke,
  type InkSurfaceRecord,
} from './ink-surface';
import {
  joinInkStrokeSurfaceFragments,
  splitInkStrokeIntoSurfaceFragments,
} from './ink-surface-layout';

describe('physical Ink fragment coordinate provenance', () => {
  it('round-trips an interior authored point exactly across a fractional surface origin', () => {
    const startY = 56.970881592869134;
    const logicalHeight = 500;
    const endY = startY + logicalHeight;
    const original = physicalStroke('fractional-interior', [
      physicalPoint(10.125, 100.125, 1),
      physicalPoint(20.25, 240.50144108255907, 2),
      physicalPoint(30.5, 400.75, 3),
    ]);

    const fragment = splitInkStrokeIntoSurfaceFragments({
      stroke: original,
      surfaces: [{ endY, id: 'fractional', logicalHeight, startY }],
    })[0];
    if (fragment === undefined) throw new Error('Missing fractional-origin fragment.');

    expect(fragment.stroke.points[1]).toMatchObject({
      fragmentGlobalY: original.points[1]?.y,
      y: 183.53055948968995,
    });

    const reloaded = reloadFragment(fragment.stroke, startY, logicalHeight);
    const joined = joinInkStrokeSurfaceFragments([
      {
        endY,
        logicalHeight,
        schemaVersion: 3,
        startY,
        stroke: reloaded,
        surfaceId: 'fractional',
      },
    ])[0];

    expect(joined?.points).toEqual(original.points);
    expect(joined?.points.every((point) => !('fragmentGlobalY' in point))).toBe(true);
  });

  it('uses canonical logicalHeight for a fractional outer edge without subtraction drift', () => {
    const startY = 549.0192043307547;
    const logicalHeight = 59.241322142312214;
    const endY = startY + logicalHeight;
    const original = physicalStroke('fractional-outer-edge', [
      physicalPoint(10, startY, 1),
      physicalPoint(20, endY, 2),
    ]);

    const fragment = splitInkStrokeIntoSurfaceFragments({
      stroke: original,
      surfaces: [{ endY, id: 'fractional-edge', logicalHeight, startY }],
    })[0];
    if (fragment === undefined) throw new Error('Missing fractional-edge fragment.');

    expect(fragment.stroke.points).toMatchObject([
      { fragmentGlobalY: startY, y: 0 },
      { fragmentGlobalY: endY, y: logicalHeight },
    ]);
    const reloaded = reloadFragment(fragment.stroke, startY, logicalHeight);
    expect(() => reloadFragment(reloaded, startY, logicalHeight + 100)).not.toThrow();
    const grown = reloadFragment(reloaded, startY, logicalHeight + 100);
    expect(
      joinInkStrokeSurfaceFragments([
        {
          endY: startY + logicalHeight + 100,
          logicalHeight: logicalHeight + 100,
          schemaVersion: 3,
          startY,
          stroke: grown,
          surfaceId: 'fractional-edge',
        },
      ])[0]?.points,
    ).toEqual(original.points);
  });

  it('preserves deterministic fractional interior samples across many surface origins', () => {
    let seed = 0x27f00d;
    for (let index = 0; index < 128; index += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const startY = (seed / 0x1_0000_0000) * 10_000 + 0.123456789;
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const logicalHeight = (seed / 0x1_0000_0000) * 1_000 + 1.987654321;
      const endY = startY + logicalHeight;
      const original = physicalStroke(`fractional-${index}`, [
        physicalPoint(10 + index, startY + logicalHeight * 0.2, 1),
        physicalPoint(20 + index, startY + logicalHeight * 0.61, 2),
        physicalPoint(30 + index, startY + logicalHeight * 0.8, 3),
      ]);
      const fragment = splitInkStrokeIntoSurfaceFragments({
        stroke: original,
        surfaces: [{ endY, id: `surface-${index}`, logicalHeight, startY }],
      })[0];
      if (fragment === undefined) throw new Error(`Missing generated fragment ${index}.`);
      const reloaded = reloadFragment(fragment.stroke, startY, logicalHeight);

      expect(
        joinInkStrokeSurfaceFragments([
          {
            endY,
            logicalHeight,
            schemaVersion: 3,
            startY,
            stroke: reloaded,
            surfaceId: `surface-${index}`,
          },
        ])[0]?.points,
      ).toEqual(original.points);
    }
  });
});

function reloadFragment(stroke: InkStroke, originY: number, logicalHeight: number): InkStroke {
  const record: InkSurfaceRecord = {
    createdAt: '2026-07-18T00:00:00.000Z',
    filePath: 'Physical.md',
    id: 'fractional',
    layout: {
      blockFingerprints: ['physical'],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight,
      logicalWidth: 1_024,
      originY,
      sourceRevision: 'physical-source',
      themeMode: 'light',
    },
    noteId: 'physical-note',
    revision: 1,
    schemaVersion: 3,
    status: 'active',
    strokes: [stroke],
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
  return decodeInkSurfaceRecord(encodeInkSurfaceRecord(record)).strokes[0] as InkStroke;
}

function physicalStroke(id: string, points: readonly InkPhysicalPoint[]): InkStroke {
  return {
    brushRenderVersion: 'pen-physical-v1',
    color: '#112233',
    id,
    inputProfile: { pressure: 'measured', tilt: 'unavailable' },
    points,
    tool: 'pen',
    width: 4,
  };
}

function physicalPoint(x: number, y: number, time: number): InkPhysicalPoint {
  return {
    orientation: { kind: 'unavailable' },
    pressure: 0.5,
    pressureKind: 'measured',
    time,
    x,
    y,
  };
}
