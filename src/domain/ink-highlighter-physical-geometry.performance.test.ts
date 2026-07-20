import { describe, expect, it } from 'vitest';

import type { InkPhysicalBrushControlPoint } from './ink-brush-geometry-contract';
import {
  createInkHighlighterPhysicalActiveGeometryCompiler,
  UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE,
} from './ink-highlighter-physical-geometry';

describe('unpublished physical Highlighter geometry performance', () => {
  it('keeps late active work independent of a 50k-point stable prefix', () => {
    const created = createInkHighlighterPhysicalActiveGeometryCompiler({
      color: '#abcdef',
      inputProfile: { pressure: 'measured', tilt: 'measured' },
      logicalStrokeId: 'highlighter-performance',
      nominalWidth: 0.5,
      tool: 'highlighter',
      version: 'highlighter-chisel-v1',
    });
    if (created.kind !== 'ready') throw new Error('expected ready Highlighter compiler');
    const prefix = Array.from({ length: 50_000 }, (_value, index) => point(index, index));
    const startedAt = performance.now();

    created.compiler.extend({
      mutableReplacement: { kind: 'physical-control-trace', points: [] },
      stableAppend: { kind: 'physical-control-trace', points: prefix },
    });
    const prefixDurationMs = performance.now() - startedAt;
    const afterPrefix = created.compiler.stats();
    const lateStartedAt = performance.now();
    created.compiler.extend({
      mutableReplacement: {
        kind: 'physical-control-trace',
        points: [point(50_001, 50_001), point(50_002, 50_002)],
      },
      stableAppend: { kind: 'physical-control-trace', points: [point(50_000, 50_000)] },
    });
    const lateDurationMs = performance.now() - lateStartedAt;
    const afterLate = created.compiler.stats();

    expect(prefixDurationMs).toBeLessThan(2_500);
    expect(lateDurationMs).toBeLessThan(25);
    expect(afterPrefix.emittedContourCount).toBe(50_000);
    expect(afterPrefix.inspectedPointCount).toBe(50_000);
    expect(afterLate.emittedContourCount - afterPrefix.emittedContourCount).toBe(3);
    expect(afterLate.inspectedPointCount - afterPrefix.inspectedPointCount).toBe(3);
    expect(afterLate.maximumMutableTailPointCount).toBeLessThanOrEqual(
      UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.active.maximumMutableTailPoints,
    );
  });
});

function point(index: number, time: number): InkPhysicalBrushControlPoint {
  return {
    orientation: {
      altitude: 0.6,
      azimuth: (index % 32) * 0.001,
      kind: 'measured',
      reliable: true,
    },
    pressure: { kind: 'measured', value: 0.5 },
    time,
    x: index * 0.001,
    y: 0,
  };
}
