import { describe, expect, it } from 'vitest';

import { InkViewportPresentationTransaction } from './ink-viewport-presentation-transaction';

describe('Ink Viewport Presentation Transaction', () => {
  it('fences stale coverage while allowing compatible fallback to refine to exact coverage', () => {
    const transaction = new InkViewportPresentationTransaction({
      hysteresisRatio: 0.1,
      maximumLod: 4,
      minimumLod: -4,
    });
    const first = transaction.request(request(1, 0, 0));
    const reversed = transaction.request(request(2, 512, 0));

    expect(
      transaction.accept({
        cameraEpoch: first.cameraEpoch,
        coverage: 'exact',
        projectionIdentity: first.projectionIdentity,
      }),
    ).toBe(false);
    expect(
      transaction.accept({
        cameraEpoch: reversed.cameraEpoch,
        coverage: 'fallback',
        projectionIdentity: reversed.projectionIdentity,
      }),
    ).toBe(true);
    expect(transaction.snapshot()?.presentedCoverage).toBe('fallback');
    expect(
      transaction.accept({
        cameraEpoch: reversed.cameraEpoch,
        coverage: 'exact',
        projectionIdentity: reversed.projectionIdentity,
      }),
    ).toBe(true);
    expect(transaction.snapshot()?.presentedCoverage).toBe('exact');
  });

  it('keeps exact floating zoom out of identity and applies LOD hysteresis', () => {
    const transaction = new InkViewportPresentationTransaction({
      hysteresisRatio: 0.1,
      maximumLod: 4,
      minimumLod: -4,
    });

    const baseline = transaction.request(request(1, 0, 0, 1));
    const withinHysteresis = transaction.request(request(2, 0, 0, 1.95));
    const crossed = transaction.request(request(3, 0, 0, 2.25));

    expect(baseline.targetLod).toBe(0);
    expect(withinHysteresis.targetLod).toBe(0);
    expect(crossed.targetLod).toBe(1);
    expect(crossed.transform).toEqual({ a: 2.25, d: 2.25, e: 0, f: 0 });
  });
});

function request(stageFrameEpoch: number, logicalLeft: number, logicalTop: number, scale = 1) {
  return {
    camera: { devicePixelRatio: 1, logicalLeft, logicalTop, scale },
    motion: 'settled' as const,
    projectionIdentity: 'projection-a',
    stageFrameEpoch,
  };
}
