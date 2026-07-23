import { describe, expect, it } from 'vitest';

import {
  mapProjectedDisplayRangeToSource,
  OBSIDIAN_SOURCE_DIALECT_VERSION,
  SourceProjectionCache,
} from './source-projection';

describe('Source Projection performance', () => {
  it('parses one 200,000-character revision once and keeps cached endpoint mapping interactive', () => {
    const line = 'Paragraph with **bold**, `code`, [[Target|label]], 中文, and 😀.\n\n';
    const source = line.repeat(Math.ceil(200_000 / line.length)).slice(0, 200_000);
    const cache = new SourceProjectionCache({
      maxEntries: 8,
      maxEstimatedBytes: 16 * 1024 * 1024,
    });
    const input = {
      dialectVersion: OBSIDIAN_SOURCE_DIALECT_VERSION,
      filePath: 'Large.md',
      source,
      sourceRevision: 'large-revision-1',
    };
    const parseStartedAt = performance.now();
    const projection = cache.getOrBuild(input);
    const parseDurationMs = performance.now() - parseStartedAt;
    const block = projection.blocks.find((candidate) =>
      candidate.visibleText.startsWith('Paragraph'),
    );
    if (block === undefined) throw new Error('Large-note fixture produced no paragraph block.');

    const durations = Array.from({ length: 100 }, () => {
      const startedAt = performance.now();
      const cached = cache.getOrBuild(input);
      mapProjectedDisplayRangeToSource({
        block: cached.blocks[0]!,
        displayEnd: 'Paragraph'.length,
        displayStart: 0,
        source,
      });
      return performance.now() - startedAt;
    });
    const p95 = percentile(durations, 0.95);

    expect(projection.sourceLength).toBe(200_000);
    expect(parseDurationMs).toBeLessThan(1_500);
    expect(p95).toBeLessThan(8);
  });

  it('keeps ten-block cached projection under the desktop P95 budget', () => {
    const source = Array.from({ length: 20 }, (_, index) => `Paragraph ${index}.`).join('\n\n');
    const cache = new SourceProjectionCache();
    const input = {
      dialectVersion: OBSIDIAN_SOURCE_DIALECT_VERSION,
      filePath: 'Ten blocks.md',
      source,
      sourceRevision: 'revision-1',
    };
    const projection = cache.getOrBuild(input);
    const durations = Array.from({ length: 100 }, () => {
      const startedAt = performance.now();
      const cached = cache.getOrBuild(input);
      for (const block of cached.blocks.slice(0, 10)) {
        mapProjectedDisplayRangeToSource({
          block,
          displayEnd: block.visibleText.length,
          displayStart: 0,
          source,
        });
      }
      return performance.now() - startedAt;
    });

    expect(projection.blocks).toHaveLength(20);
    expect(percentile(durations, 0.95)).toBeLessThan(16);
  });
});

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? Number.POSITIVE_INFINITY;
}
