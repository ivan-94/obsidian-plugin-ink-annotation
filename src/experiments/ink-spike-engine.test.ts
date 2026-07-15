import { describe, expect, it } from 'vitest';

import {
  buildInkSpikeMetrics,
  compareInkLayoutFingerprint,
  deltaEncodeInkPoints,
  mapClientPointToLogical,
  routeInkPointer,
  simplifyInkPoints,
  splitStrokeAcrossSurfaces,
  type InkSpikePoint,
} from './ink-spike-engine';

describe('S09 Ink feasibility engine', () => {
  it('routes pen and primary mouse to draw while touch and wheel remain navigation', () => {
    expect(routeInkPointer({ button: 0, pointerType: 'pen', spacePressed: false })).toBe('draw');
    expect(routeInkPointer({ button: 0, pointerType: 'mouse', spacePressed: false })).toBe('draw');
    expect(routeInkPointer({ button: 0, pointerType: 'touch', spacePressed: false })).toBe(
      'scroll',
    );
    expect(routeInkPointer({ button: 0, pointerType: 'mouse', spacePressed: true })).toBe('pan');
    expect(routeInkPointer({ button: 2, pointerType: 'mouse', spacePressed: false })).toBe(
      'ignore',
    );
  });

  it('maps CSS coordinates to stable logical coordinates independent of device pixels', () => {
    expect(
      mapClientPointToLogical(
        { clientX: 260, clientY: 350 },
        { height: 600, left: 20, top: 50, width: 480 },
        { height: 1200, width: 960 },
      ),
    ).toEqual({ x: 480, y: 600 });
  });

  it('simplifies only after capture and delta-encodes a round-trippable stroke', () => {
    const points: InkSpikePoint[] = [
      point(0, 0),
      point(1, 0.02),
      point(2, -0.01),
      point(3, 0),
      point(4, 4),
    ];

    const simplified = simplifyInkPoints(points, 0.1);
    const encoded = deltaEncodeInkPoints(simplified);

    expect(simplified).toEqual([points[0], points[3], points[4]]);
    expect(encoded).toMatchObject({
      origin: { x: 0, y: 0 },
      points: [
        { dx: 3, dy: 0 },
        { dx: 1, dy: 4 },
      ],
    });
  });

  it('splits one visual stroke into linked fragments with the same boundary point', () => {
    const fragments = splitStrokeAcrossSurfaces(
      'stroke-1',
      [point(100, 550), point(200, 650)],
      [
        { endY: 600, id: 'surface-a', startY: 0 },
        { endY: 1200, id: 'surface-b', startY: 600 },
      ],
    );

    expect(fragments).toHaveLength(2);
    expect(fragments.map((fragment) => fragment.surfaceId)).toEqual(['surface-a', 'surface-b']);
    expect(fragments[0]?.points.at(-1)).toMatchObject({ x: 150, y: 600 });
    expect(fragments[1]?.points[0]).toMatchObject({ x: 150, y: 600 });
    expect(new Set(fragments.map((fragment) => fragment.linkedStrokeId))).toEqual(
      new Set(['stroke-1']),
    );
  });

  it('blocks misleading alignment when typography, theme, source or blocks drift', () => {
    const expected = {
      blockFingerprints: ['a', 'b'],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalWidth: 960,
      sourceRevision: 'source-1',
      theme: 'light',
    } as const;

    expect(compareInkLayoutFingerprint(expected, expected)).toEqual({ status: 'match' });
    expect(compareInkLayoutFingerprint(expected, { ...expected, fontFamily: 'Arial' })).toEqual({
      changed: ['fontFamily'],
      status: 'needs-rebase',
    });
  });

  it('reports timing and ratios without leaking recognizable point geometry', () => {
    const metrics = buildInkSpikeMetrics({
      coalescedEvents: 12,
      dirtyAreaRatio: 0.08,
      frameDurationsMs: [4, 8, 20],
      fragments: 2,
      inputPoints: 100,
      pointerType: 'pen',
      simplifiedPoints: 25,
      strokes: 1,
    });

    expect(metrics).toMatchObject({
      coalescedEvents: 12,
      dirtyAreaRatio: 0.08,
      inputToPaintP95Ms: 20,
      pointerType: 'pen',
      simplificationRatio: 0.25,
    });
    expect(JSON.stringify(metrics)).not.toMatch(/"x"|"y"|points/iu);
  });
});

function point(x: number, y: number): InkSpikePoint {
  return { pressure: 0.5, time: x + y, x, y };
}
