import { describe, expect, it } from 'vitest';

import { runInkPerformanceBaseline } from './ink-performance-baseline';

describe('Ink performance baseline harness', () => {
  it('measures real InkDocumentSession snapshots at empty, 1k, and 10k/30 scale', () => {
    const result = runInkPerformanceBaseline({ sampleCount: 3, warmupCount: 1 });

    expect(
      result.conditions.map(({ compositeStrokeCount, strokeCount, surfaceCount }) => ({
        compositeStrokeCount,
        strokeCount,
        surfaceCount,
      })),
    ).toEqual([
      { compositeStrokeCount: 0, strokeCount: 0, surfaceCount: 1 },
      { compositeStrokeCount: 1_000, strokeCount: 1_000, surfaceCount: 3 },
      { compositeStrokeCount: 10_000, strokeCount: 10_000, surfaceCount: 30 },
    ]);
    expect(result.conditions.at(-1)?.durationMs.sampleCount).toBe(3);
    expect(result.forbiddenWork).toEqual([
      { countPerMeasuredSnapshot: 1, kind: 'cold-snapshot', phase: 'input' },
      { countPerMeasuredSnapshot: 1, kind: 'historical-scan', phase: 'input' },
      { countPerMeasuredSnapshot: 1, kind: 'historical-sort', phase: 'input' },
      { countPerMeasuredSnapshot: 1, kind: 'historical-copy', phase: 'input' },
    ]);
  });
});
