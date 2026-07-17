import { describe, expect, it } from 'vitest';

import type { InkPoint, InkStroke } from './ink-surface';
import { logicalStrokeIdsCoveredByPolygon } from './ink-closed-loop-erase';

describe('closed-loop whole-stroke erase geometry', () => {
  it('returns only logical strokes enclosed by a convex loop', () => {
    const polygon = [point(0, 0), point(100, 0), point(100, 100), point(0, 100)];

    expect(
      logicalStrokeIdsCoveredByPolygon(
        [stroke('inside', [point(20, 20), point(80, 80)]), stroke('outside', [point(120, 40)])],
        polygon,
      ),
    ).toEqual(['inside']);
  });

  it('includes a stroke whose centerline lies on the loop boundary', () => {
    const polygon = [point(0, 0), point(100, 0), point(100, 100), point(0, 100)];

    expect(
      logicalStrokeIdsCoveredByPolygon(
        [stroke('boundary', [point(100, 20), point(100, 80)])],
        polygon,
      ),
    ).toEqual(['boundary']);
  });

  it('includes a stroke when only a small share of its centerline protrudes outside', () => {
    const polygon = [point(0, 0), point(100, 0), point(100, 100), point(0, 100)];

    expect(
      logicalStrokeIdsCoveredByPolygon(
        [stroke('mostly-inside', [point(10, 50), point(110, 50)])],
        polygon,
      ),
    ).toEqual(['mostly-inside']);
  });

  it('includes a stroke when roughly one quarter of its centerline protrudes outside', () => {
    const polygon = [point(0, 0), point(100, 0), point(100, 100), point(0, 100)];

    expect(
      logicalStrokeIdsCoveredByPolygon(
        [stroke('natural-overshoot', [point(10, 50), point(130, 50)])],
        polygon,
      ),
    ).toEqual(['natural-overshoot']);
  });

  it('retains a crossing stroke when a material share of its centerline is outside', () => {
    const polygon = [point(0, 0), point(100, 0), point(100, 100), point(0, 100)];

    expect(
      logicalStrokeIdsCoveredByPolygon(
        [stroke('crossing', [point(50, 50), point(150, 50)])],
        polygon,
      ),
    ).toEqual([]);
  });

  it('retains a sparse stroke whose segment leaves a concave loop', () => {
    const concave = [
      point(0, 0),
      point(100, 0),
      point(100, 100),
      point(70, 100),
      point(70, 30),
      point(30, 30),
      point(30, 100),
      point(0, 100),
    ];

    expect(
      logicalStrokeIdsCoveredByPolygon(
        [stroke('crossing-notch', [point(20, 80), point(80, 80)])],
        concave,
      ),
    ).toEqual([]);
  });

  it('checks the complete sparse segment instead of only its midpoint', () => {
    const offsetNotch = [
      point(0, 0),
      point(100, 0),
      point(100, 100),
      point(82, 100),
      point(82, 30),
      point(58, 30),
      point(58, 100),
      point(0, 100),
    ];

    expect(
      logicalStrokeIdsCoveredByPolygon(
        [stroke('crossing-offset-notch', [point(20, 80), point(90, 80)])],
        offsetNotch,
      ),
    ).toEqual([]);
  });

  it('retains one linked logical point stroke when any fragment is outside the loop', () => {
    const polygon = [point(0, 0), point(100, 0), point(100, 100), point(0, 100)];
    const inside = { ...stroke('fragment-a', [point(20, 20)]), linkedStrokeId: 'user-stroke' };
    const outside = { ...stroke('fragment-b', [point(120, 20)]), linkedStrokeId: 'user-stroke' };

    expect(logicalStrokeIdsCoveredByPolygon([inside, outside], polygon)).toEqual([]);
  });

  it('aggregates centerline coverage across linked fragments', () => {
    const polygon = [point(0, 0), point(100, 0), point(100, 100), point(0, 100)];
    const inside = {
      ...stroke('fragment-a', [point(10, 50), point(90, 50)]),
      linkedStrokeId: 'user-stroke',
    };
    const protruding = {
      ...stroke('fragment-b', [point(100, 50), point(110, 50)]),
      linkedStrokeId: 'user-stroke',
    };

    expect(logicalStrokeIdsCoveredByPolygon([inside, protruding], polygon)).toEqual([
      'user-stroke',
    ]);
  });

  it('ignores stored legacy eraser paths as deletion candidates', () => {
    const polygon = [point(0, 0), point(100, 0), point(100, 100), point(0, 100)];

    expect(
      logicalStrokeIdsCoveredByPolygon(
        [stroke('pen', [point(20, 20)]), { ...stroke('eraser', [point(30, 30)]), tool: 'eraser' }],
        polygon,
      ),
    ).toEqual(['pen']);
  });

  it('fails closed for a degenerate polygon', () => {
    expect(
      logicalStrokeIdsCoveredByPolygon(
        [stroke('on-line', [point(50, 0)])],
        [point(0, 0), point(100, 0)],
      ),
    ).toEqual([]);
  });

  it('uses the even-odd fill rule for a self-intersecting loop', () => {
    const bowTie = [point(0, 0), point(100, 100), point(0, 100), point(100, 0)];

    expect(
      logicalStrokeIdsCoveredByPolygon(
        [stroke('inside-lobe', [point(40, 20), point(60, 20)]), stroke('outside', [point(10, 50)])],
        bowTie,
      ),
    ).toEqual(['inside-lobe']);
  });

  it('keeps pane-margin coordinates outside the 704 document width', () => {
    const marginLoop = [point(-200, 0), point(900, 0), point(900, 100), point(-200, 100)];

    expect(
      logicalStrokeIdsCoveredByPolygon(
        [stroke('left-margin', [point(-100, 50)]), stroke('right-margin', [point(800, 50)])],
        marginLoop,
      ),
    ).toEqual(['left-margin', 'right-margin']);
  });
});

function stroke(id: string, points: readonly InkPoint[]): InkStroke {
  return { color: '#111111', id, points, tool: 'pen', width: 4 };
}

function point(x: number, y: number): InkPoint {
  return { pressure: 0.5, time: x + y, x, y };
}
