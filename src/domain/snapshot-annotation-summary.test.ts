import { describe, expect, it } from 'vitest';

import {
  createSnapshotAnnotationIndexEntry,
  createSnapshotAnnotationSummaryFromIndexEntry,
  createSnapshotAnnotationSummary,
} from './snapshot-annotation-summary';
import type { SnapshotAnnotationRecord } from './snapshot-annotation';

describe('Snapshot Annotation summary', () => {
  it('projects ordering and link state without capture bytes or stroke point arrays', () => {
    const record = snapshotRecord();
    const summary = createSnapshotAnnotationSummary(record, {
      anchors: [{ end: 17, focus: true, start: 6, target: record.source.focus }],
      state: 'source-changed',
    });

    expect(summary).toEqual({
      capturedAt: record.capturedAt,
      filePath: 'Notes/Test.md',
      headingPath: ['Chapter'],
      id: 'snapshot-a',
      linkState: 'source-changed',
      logicalHeight: 200,
      logicalWidth: 300,
      revision: 2,
      sourceOrder: 6,
      status: 'active',
      strokeCount: 1,
      thumbnailKey: `snapshot:${record.asset.sha256}:2`,
      updatedAt: record.updatedAt,
    });
    expect(JSON.stringify(summary)).not.toContain('points');
    expect('asset' in summary).toBe(false);
    expect('ink' in summary).toBe(false);

    const indexEntry = createSnapshotAnnotationIndexEntry(record);
    expect(indexEntry).toMatchObject({
      assetSha256: record.asset.sha256,
      id: 'snapshot-a',
      source: { headingPath: ['Chapter'] },
      strokeCount: 1,
    });
    expect(JSON.stringify(indexEntry)).not.toContain('points');
    expect('ink' in indexEntry).toBe(false);

    expect(
      createSnapshotAnnotationSummaryFromIndexEntry(indexEntry, 'Prefix Gamma block suffix'),
    ).toMatchObject({
      id: 'snapshot-a',
      linkState: 'linked',
      sourceOrder: 7,
      strokeCount: 1,
    });
  });
});

function snapshotRecord(): SnapshotAnnotationRecord {
  const target = {
    position: { end: 11, start: 0, unit: 'utf16-code-unit' as const },
    quote: { exact: 'Gamma block', prefix: '', suffix: '' },
    scope: { headingPath: ['Chapter'] },
    sourceRevision: 'source-a',
  };
  return {
    asset: {
      backend: { id: 'fake', version: '1' },
      byteLength: 33,
      fileName: `capture-${'a'.repeat(64)}.png`,
      logicalHeight: 200,
      logicalWidth: 300,
      mimeType: 'image/png',
      pixelHeight: 400,
      pixelRatio: 2,
      pixelWidth: 600,
      sha256: 'a'.repeat(64),
    },
    capturedAt: '2026-07-22T00:00:00.000Z',
    createdAt: '2026-07-22T00:00:00.000Z',
    filePath: 'Notes/Test.md',
    id: 'snapshot-a',
    ink: {
      logicalHeight: 200,
      logicalWidth: 300,
      strokes: [
        {
          color: '#111111',
          id: 'stroke-a',
          points: [{ pressure: 0.5, time: 1, x: 10, y: 20 }],
          tool: 'pen',
          width: 2,
        },
      ],
    },
    noteId: 'note-a',
    revision: 2,
    schemaVersion: 1,
    source: {
      coverage: [target],
      focus: target,
      headingPath: ['Chapter'],
      sourceRevision: 'source-a',
    },
    status: 'active',
    updatedAt: '2026-07-22T01:00:00.000Z',
  };
}
