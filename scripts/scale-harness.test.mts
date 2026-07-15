import { describe, expect, it } from 'vitest';

import { runScaleHarness } from './scale-harness';

describe('filesystem scale harness', () => {
  it('hydrates real canonical files through production repositories and excludes Ink vectors', async () => {
    const result = await runScaleHarness({
      bulkSelectionSize: 2,
      cleanup: true,
      inkPerNote: 2,
      noteCount: 2,
      textPerNote: 2,
    });

    expect(result).toMatchObject({
      bulk: { failed: 0, selected: 2, succeeded: 2 },
      cache: { restoredEntries: 8 },
      fixture: { canonicalFiles: 10, indexEntries: 8, notes: 2 },
      indexSafety: { containsInkPoints: false, containsThumbnailSvg: false },
      search: { matches: 1 },
    });
    expect(result.virtualWindow.materializedRows).toBeLessThan(30);
  });
});
