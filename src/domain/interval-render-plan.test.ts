import { describe, expect, it } from 'vitest';

import { buildIntervalRenderPlan } from './interval-render-plan';

describe('overlap interval render plan', () => {
  it('preserves every record while choosing the most specific background and all underline layers', () => {
    const plan = buildIntervalRenderPlan([
      {
        annotationId: 'wide-highlight',
        end: 10,
        kind: 'highlight',
        start: 0,
        styleId: 'sun',
        updatedAt: '2026-07-14T08:00:00.000Z',
      },
      {
        annotationId: 'specific-highlight',
        end: 8,
        kind: 'highlight',
        start: 4,
        styleId: 'mint',
        updatedAt: '2026-07-14T08:01:00.000Z',
      },
      {
        annotationId: 'underline-1',
        end: 12,
        kind: 'underline',
        start: 6,
        styleId: 'blue',
        updatedAt: '2026-07-14T08:02:00.000Z',
      },
      {
        annotationId: 'underline-2',
        end: 12,
        kind: 'underline',
        start: 6,
        styleId: 'rose',
        updatedAt: '2026-07-14T08:03:00.000Z',
      },
    ]);

    expect(plan).toEqual([
      expect.objectContaining({ annotationIds: ['wide-highlight'], end: 4, start: 0 }),
      expect.objectContaining({
        annotationIds: ['specific-highlight', 'wide-highlight'],
        backgroundAnnotationId: 'specific-highlight',
        end: 6,
        start: 4,
      }),
      expect.objectContaining({
        annotationIds: ['specific-highlight', 'underline-1', 'underline-2', 'wide-highlight'],
        backgroundAnnotationId: 'specific-highlight',
        end: 8,
        start: 6,
        underlineAnnotationIds: ['underline-1', 'underline-2'],
      }),
      expect.objectContaining({
        annotationIds: ['underline-1', 'underline-2', 'wide-highlight'],
        backgroundAnnotationId: 'wide-highlight',
        end: 10,
        start: 8,
      }),
      expect.objectContaining({
        annotationIds: ['underline-1', 'underline-2'],
        end: 12,
        start: 10,
        underlineAnnotationIds: ['underline-1', 'underline-2'],
      }),
    ]);
  });
});
