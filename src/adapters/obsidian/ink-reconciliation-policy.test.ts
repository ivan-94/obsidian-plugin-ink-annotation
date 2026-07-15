import { describe, expect, it } from 'vitest';

import { shouldPersistInkReconciliation } from './ink-reconciliation-policy';

describe('Ink reconciliation persistence policy', () => {
  it('keeps passive reading and startup reconciliation read-only', () => {
    expect(
      shouldPersistInkReconciliation({
        currentRevision: 7,
        interactive: false,
        reconciledRevision: 8,
      }),
    ).toBe(false);
  });

  it('persists a changed reconciliation only after an explicit Ink entry', () => {
    expect(
      shouldPersistInkReconciliation({
        currentRevision: 7,
        interactive: true,
        reconciledRevision: 8,
      }),
    ).toBe(true);
    expect(
      shouldPersistInkReconciliation({
        currentRevision: 7,
        interactive: true,
        reconciledRevision: 7,
      }),
    ).toBe(false);
  });
});
