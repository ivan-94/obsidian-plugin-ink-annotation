import { describe, expect, it } from 'vitest';

import { assertSnapshotAnnotationRecord } from './snapshot-annotation';

describe('Snapshot Annotation canonical invariants', () => {
  it('rejects duplicate Coverage Anchors even when Focus is present', () => {
    const record = validRecord();
    record.source.coverage = [record.source.focus, structuredClone(record.source.focus)];

    expect(() => assertSnapshotAnnotationRecord(record)).toThrow(
      'Snapshot Annotation Coverage Anchors must be unique.',
    );
  });

  it('rejects malformed optional lifecycle and recovery metadata', () => {
    const malformed = [
      { anchorFailure: { candidateCount: -1, reason: 'ambiguous' } },
      { anchorFailure: { candidateCount: 1, reason: 'guessed' } },
      { deletedAt: 42 },
      { deviceId: '' },
    ];

    for (const patch of malformed) {
      expect(() => assertSnapshotAnnotationRecord({ ...validRecord(), ...patch })).toThrow(
        'Snapshot Annotation optional metadata is invalid.',
      );
    }
  });
});

function validRecord() {
  const focus = {
    position: { end: 4, start: 0, unit: 'utf16-code-unit' },
    quote: { exact: 'Test', prefix: '', suffix: '' },
    scope: { headingPath: ['Test'] },
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
    ink: { logicalHeight: 200, logicalWidth: 300, strokes: [] },
    noteId: 'note-a',
    revision: 1,
    schemaVersion: 1,
    source: {
      coverage: [focus],
      focus,
      headingPath: ['Test'],
      sourceRevision: 'source-a',
    },
    status: 'active',
    updatedAt: '2026-07-22T00:00:00.000Z',
  };
}
