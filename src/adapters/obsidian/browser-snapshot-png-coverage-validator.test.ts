import { describe, expect, it } from 'vitest';

import { BrowserSnapshotPngCoverageValidator } from './browser-snapshot-png-coverage-validator';

describe('Browser Snapshot PNG coverage validator', () => {
  it('rejects a uniform raster and accepts visible pixel variation', async () => {
    const uniform = new BrowserSnapshotPngCoverageValidator({
      samplePixels: () =>
        Promise.resolve(new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255])),
    });
    const visible = new BrowserSnapshotPngCoverageValidator({
      samplePixels: () =>
        Promise.resolve(new Uint8ClampedArray([255, 255, 255, 255, 20, 20, 20, 255])),
    });

    await expect(
      uniform.assertNonblank(new Uint8Array([1]), new AbortController().signal),
    ).rejects.toThrow('uniform or blank');
    await expect(
      visible.assertNonblank(new Uint8Array([1]), new AbortController().signal),
    ).resolves.toBeUndefined();
  });
});
