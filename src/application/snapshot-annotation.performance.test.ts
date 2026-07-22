import { describe, expect, it } from 'vitest';

import {
  createSnapshotAnnotationSummaryFromIndexEntry,
  type SnapshotAnnotationIndexEntry,
} from '../domain/snapshot-annotation-summary';

describe('Snapshot Annotation summary performance', () => {
  it('projects 500 compact rows inside the Current file 300 ms budget without asset data', () => {
    const blocks = Array.from(
      { length: 500 },
      (_, index) => `Block ${String(index).padStart(3, '0')}`,
    );
    const source = blocks.join('\n\n');
    let offset = 0;
    const entries = blocks.map((exact, index) => {
      const start = source.indexOf(exact, offset);
      offset = start + exact.length;
      return entry(index, exact, start);
    });
    const startedAt = performance.now();

    const summaries = entries.map((candidate) =>
      createSnapshotAnnotationSummaryFromIndexEntry(candidate, source),
    );
    const durationMs = performance.now() - startedAt;

    expect(summaries).toHaveLength(500);
    expect(durationMs).toBeLessThanOrEqual(300);
    expect(JSON.stringify(summaries)).not.toMatch(/pngBytes|points|strokes/u);
  });
});

function entry(index: number, exact: string, start: number): SnapshotAnnotationIndexEntry {
  const target = {
    position: { end: start + exact.length, start, unit: 'utf16-code-unit' as const },
    quote: { exact, prefix: '', suffix: '' },
    scope: { headingPath: [`Chapter ${Math.floor(index / 25)}`] },
    sourceRevision: 'fixture-source',
  };
  return {
    assetSha256: index.toString(16).padStart(64, '0'),
    capturedAt: '2026-07-22T00:00:00.000Z',
    filePath: 'Notes/Scale.md',
    id: `snapshot-${index}`,
    logicalHeight: 200,
    logicalWidth: 300,
    revision: 1,
    schemaVersion: 1,
    source: {
      coverage: [target],
      focus: target,
      headingPath: target.scope.headingPath,
      sourceRevision: 'fixture-source',
    },
    status: 'active',
    strokeCount: 3,
    updatedAt: '2026-07-22T00:00:00.000Z',
  };
}
