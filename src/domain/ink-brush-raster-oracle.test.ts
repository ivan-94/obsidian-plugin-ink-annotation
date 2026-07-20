import { describe, expect, it } from 'vitest';

import {
  compareInkBrushRasterReplays,
  type InkBrushRasterSnapshot,
} from './ink-brush-raster-oracle';

describe('Ink Brush raster oracle', () => {
  it('fails closed when replaying the same raster input changes its normalized alpha', () => {
    const reference = snapshot([0, 255, 255, 0]);
    const candidate = snapshot([0, 255, 255, 0]);
    const changedReplay = snapshot([0, 255, 254, 0]);

    expect(
      compareInkBrushRasterReplays({
        candidate: { first: candidate, replay: changedReplay },
        reference: { first: reference, replay: reference },
        tool: 'pen',
      }),
    ).toEqual({
      deterministic: false,
      kind: 'invalid',
      reason: 'non-deterministic-replay',
      thresholds: {
        maximumBoundaryP95PhysicalPixels: 0.5,
        maximumNormalizedAlphaDelta: 1 / 255,
        minimumAlphaWeightedIoU: 0.995,
        requiredBoundaryOutputScale: 2,
      },
    });
  });

  it('fails closed when replaying the same raster input changes geometric coverage only', () => {
    const raster = snapshot([0, 255, 255, 0], 2, 2, [0, 64, 64, 0]);
    const changedCoverage: InkBrushRasterSnapshot = {
      ...raster,
      coverage: Uint8Array.from([0, 255, 254, 0]),
    };

    expect(
      compareInkBrushRasterReplays({
        candidate: { first: raster, replay: changedCoverage },
        reference: { first: raster, replay: raster },
        tool: 'highlighter',
      }),
    ).toMatchObject({
      deterministic: false,
      kind: 'invalid',
      reason: 'non-deterministic-replay',
    });
  });

  it('fails closed before comparison when raster dimensions are invalid', () => {
    const reference = snapshot([0, 255, 255, 0]);
    const invalid = { ...snapshot([0, 255, 255, 0]), width: 0 };

    expect(
      compareInkBrushRasterReplays({
        candidate: { first: invalid, replay: invalid },
        reference: { first: reference, replay: reference },
        tool: 'pen',
      }),
    ).toMatchObject({
      deterministic: false,
      kind: 'invalid',
      reason: 'invalid-snapshot',
    });
  });

  it('fails closed when a deterministic raster snapshot has no visible alpha coverage', () => {
    const empty = snapshot([0, 0, 0, 0]);

    expect(
      compareInkBrushRasterReplays({
        candidate: { first: empty, replay: empty },
        reference: { first: empty, replay: empty },
        tool: 'pen',
      }),
    ).toMatchObject({
      deterministic: false,
      kind: 'invalid',
      reason: 'invalid-snapshot',
      thresholds: { minimumAlphaWeightedIoU: 0.995 },
    });
  });

  it('fails closed when raster scale or logical bounds cannot define a finite pixel projection', () => {
    const reference = snapshot([0, 255, 255, 0]);
    const invalidSnapshots: readonly InkBrushRasterSnapshot[] = [
      { ...reference, scale: Number.NaN },
      { ...reference, bounds: { ...reference.bounds, x: Number.POSITIVE_INFINITY } },
      { ...reference, bounds: { ...reference.bounds, width: 2 } },
    ];

    expect(
      invalidSnapshots.map((invalid) =>
        compareInkBrushRasterReplays({
          candidate: { first: invalid, replay: invalid },
          reference: { first: reference, replay: reference },
          tool: 'pen',
        }),
      ),
    ).toMatchObject(
      invalidSnapshots.map(() => ({
        deterministic: false,
        kind: 'invalid',
        reason: 'invalid-snapshot',
      })),
    );
  });

  it('compares deterministic normalized alpha with the frozen alpha-weighted IoU threshold', () => {
    const reference = snapshot([255, 255, 0, 0]);
    const candidate = snapshot([255, 0, 0, 0]);

    expect(
      compareInkBrushRasterReplays({
        candidate: { first: candidate, replay: candidate },
        reference: { first: reference, replay: reference },
        tool: 'pen',
      }),
    ).toMatchObject({
      checks: { alphaWeightedIoU: false },
      deterministic: true,
      kind: 'compared',
      metrics: { alphaWeightedIoU: 0.5 },
      thresholds: { minimumAlphaWeightedIoU: 0.995 },
    });
  });

  it('measures symmetric boundary P95 in physical pixels under the frozen 2x threshold', () => {
    const reference = snapshot([0, 255, 0, 0, 0, 0], 3, 2);
    const candidate = snapshot([0, 0, 255, 0, 0, 0], 3, 2);

    expect(
      compareInkBrushRasterReplays({
        candidate: { first: candidate, replay: candidate },
        reference: { first: reference, replay: reference },
        tool: 'pen',
      }),
    ).toMatchObject({
      checks: { boundaryP95: false },
      deterministic: true,
      kind: 'compared',
      metrics: { boundaryP95PhysicalPixels: 1 },
      thresholds: {
        maximumBoundaryP95PhysicalPixels: 0.5,
        requiredBoundaryOutputScale: 2,
      },
    });
  });

  it('uses Euclidean rather than grid-step distance for diagonal raster boundaries', () => {
    const reference = snapshot([255, 0, 0, 0], 2, 2);
    const candidate = snapshot([0, 0, 0, 255], 2, 2);
    const result = compareInkBrushRasterReplays({
      candidate: { first: candidate, replay: candidate },
      reference: { first: reference, replay: reference },
      tool: 'pen',
    });

    expect(result.kind).toBe('compared');
    if (result.kind === 'compared') {
      expect(result.metrics.boundaryP95PhysicalPixels).toBe(Math.SQRT2);
    }
  });

  it('applies the frozen Highlighter IoU and one-byte normalized alpha-delta thresholds', () => {
    const reference = snapshot([0, 128, 255, 0]);
    const candidate = snapshot([0, 130, 255, 0]);

    expect(
      compareInkBrushRasterReplays({
        candidate: { first: candidate, replay: candidate },
        reference: { first: reference, replay: reference },
        tool: 'highlighter',
      }),
    ).toMatchObject({
      checks: {
        alphaWeightedIoU: true,
        boundaryP95: true,
        maximumNormalizedAlphaDelta: false,
      },
      deterministic: true,
      kind: 'compared',
      metrics: { maximumNormalizedAlphaDelta: 2 / 255 },
      passed: false,
      thresholds: {
        maximumNormalizedAlphaDelta: 1 / 255,
        minimumAlphaWeightedIoU: 0.99,
      },
    });
  });

  it('measures Highlighter coverage boundaries independently from low optical alpha', () => {
    const reference = snapshot([0, 255, 0, 0], 2, 2, [0, 64, 0, 0]);
    const candidate = snapshot([0, 0, 255, 0], 2, 2, [0, 0, 64, 0]);
    const result = compareInkBrushRasterReplays({
      candidate: { first: candidate, replay: candidate },
      reference: { first: reference, replay: reference },
      tool: 'highlighter',
    });

    expect(result.kind).toBe('compared');
    if (result.kind === 'compared') {
      expect(result.metrics.boundaryP95PhysicalPixels).toBe(Math.SQRT2);
      expect(result.checks.boundaryP95).toBe(false);
    }
  });

  it('resolves a half-pixel contour shift from antialiased normalized coverage', () => {
    const referenceCoverage = repeatedRows([255, 128, 0], 20);
    const candidateCoverage = repeatedRows([255, 1, 0], 20);
    const reference = snapshot(referenceCoverage, 3, 20);
    const candidate = snapshot(candidateCoverage, 3, 20);
    const result = compareInkBrushRasterReplays({
      candidate: { first: candidate, replay: candidate },
      reference: { first: reference, replay: reference },
      tool: 'pen',
    });

    expect(result.kind).toBe('compared');
    if (result.kind === 'compared') {
      expect(result.metrics.boundaryP95PhysicalPixels).toBeCloseTo(0.5, 6);
      expect(result.checks.boundaryP95).toBe(true);
    }
  });

  it('passes deterministic identical Pen evidence with every frozen metric present', () => {
    const raster = snapshot([0, 128, 255, 0]);

    expect(
      compareInkBrushRasterReplays({
        candidate: { first: raster, replay: raster },
        reference: { first: raster, replay: raster },
        tool: 'pen',
      }),
    ).toMatchObject({
      checks: {
        alphaWeightedIoU: true,
        boundaryP95: true,
        maximumNormalizedAlphaDelta: true,
      },
      deterministic: true,
      kind: 'compared',
      metrics: {
        alphaWeightedIoU: 1,
        boundaryP95PhysicalPixels: 0,
        maximumNormalizedAlphaDelta: 0,
      },
      passed: true,
      thresholds: {
        maximumBoundaryP95PhysicalPixels: 0.5,
        maximumNormalizedAlphaDelta: 1 / 255,
        minimumAlphaWeightedIoU: 0.995,
        requiredBoundaryOutputScale: 2,
      },
    });
  });

  it('does not apply the 2x boundary threshold to otherwise valid 1x evidence', () => {
    const atOneX: InkBrushRasterSnapshot = {
      ...snapshot([0, 255, 255, 0]),
      bounds: { height: 2, width: 2, x: 0, y: 0 },
      scale: 1,
    };

    expect(
      compareInkBrushRasterReplays({
        candidate: { first: atOneX, replay: atOneX },
        reference: { first: atOneX, replay: atOneX },
        tool: 'pen',
      }),
    ).toMatchObject({
      checks: { boundaryP95: false },
      deterministic: true,
      kind: 'compared',
      passed: false,
      thresholds: { requiredBoundaryOutputScale: 2 },
    });
  });

  it('fails closed instead of aligning raster evidence from different logical grids', () => {
    const reference = snapshot([0, 255, 255, 0]);
    const shifted: InkBrushRasterSnapshot = {
      ...reference,
      bounds: { ...reference.bounds, x: 0.5 },
    };

    expect(
      compareInkBrushRasterReplays({
        candidate: { first: shifted, replay: shifted },
        reference: { first: reference, replay: reference },
        tool: 'pen',
      }),
    ).toMatchObject({
      deterministic: false,
      kind: 'invalid',
      reason: 'incompatible-snapshots',
    });
  });
});

function snapshot(
  coverage: readonly number[],
  width = 2,
  height = 2,
  alpha: readonly number[] = coverage,
): InkBrushRasterSnapshot {
  return {
    alpha: Uint8Array.from(alpha),
    bounds: { height: height / 2, width: width / 2, x: 0, y: 0 },
    coverage: Uint8Array.from(coverage),
    height,
    scale: 2,
    width,
  };
}

function repeatedRows(row: readonly number[], count: number): number[] {
  return Array.from({ length: count }, () => row).flat();
}
