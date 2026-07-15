import { describe, expect, it, vi } from 'vitest';

import { VersionedSourceCache } from './versioned-source-cache';

describe('VersionedSourceCache', () => {
  it('shares one read across concurrent Markdown section mounts', async () => {
    const cache = new VersionedSourceCache(4);
    const read = vi.fn().mockResolvedValue('x'.repeat(200_000));

    const values = await Promise.all(
      Array.from({ length: 1_500 }, () => cache.load('Large.md', 10, read)),
    );

    expect(read).toHaveBeenCalledTimes(1);
    expect(values.every((value) => value === values[0])).toBe(true);
  });

  it('refreshes on version change, retries failures, and bounds retained files', async () => {
    const cache = new VersionedSourceCache(2);
    const first = vi.fn().mockResolvedValue('v1');
    await cache.load('A.md', 1, first);
    await cache.load('A.md', 1, first);
    await cache.load('A.md', 2, () => Promise.resolve('v2'));
    await expect(cache.load('B.md', 1, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await cache.load('B.md', 1, () => Promise.resolve('recovered'));
    await cache.load('C.md', 1, () => Promise.resolve('c'));
    await cache.load('A.md', 2, first);

    expect(first).toHaveBeenCalledTimes(2);
  });
});
