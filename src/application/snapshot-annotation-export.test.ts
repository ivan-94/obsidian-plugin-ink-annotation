import { describe, expect, it, vi } from 'vitest';

import type { SnapshotAnnotationRecord } from '../domain/snapshot-annotation';
import { writeSnapshotAnnotationPngExport } from './snapshot-annotation-export';

describe('Snapshot Annotation flattened PNG export', () => {
  it('writes a unique user-visible PNG without changing canonical data', async () => {
    const writes = new Map<string, Uint8Array>();
    const record = fixtureRecord();
    const flatten = vi.fn(() => Promise.resolve(pngHeader(600, 400)));

    const path = await writeSnapshotAnnotationPngExport({
      flattener: { flatten },
      pngBytes: pngHeader(600, 400),
      record,
      store: {
        exists: (candidate) =>
          Promise.resolve(candidate === 'Inkstone Exports/Snapshot - Notes-Test.md - Test.png'),
        mkdir: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        writeBinary: (candidate, bytes) => {
          writes.set(candidate, new Uint8Array(bytes));
          return Promise.resolve();
        },
      },
    });

    expect(path).toBe('Inkstone Exports/Snapshot - Notes-Test.md - Test 2.png');
    expect(flatten).toHaveBeenCalledWith(record, expect.any(Uint8Array), expect.any(AbortSignal));
    expect(writes.get(path)).toEqual(pngHeader(600, 400));
    expect(record.revision).toBe(1);
  });
});

function fixtureRecord(): SnapshotAnnotationRecord {
  const target = {
    position: { end: 4, start: 0, unit: 'utf16-code-unit' as const },
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
    ink: {
      logicalHeight: 200,
      logicalWidth: 300,
      strokes: [
        {
          brushRenderVersion: 'legacy-round-v1',
          color: '#d97777',
          id: 'stroke-a',
          inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
          points: [{ pressure: 0.5, time: 1, x: 10, y: 20 }],
          tool: 'pen',
          width: 4,
        },
      ],
    },
    noteId: 'note-a',
    revision: 1,
    schemaVersion: 1,
    source: {
      coverage: [target],
      focus: target,
      headingPath: ['Test'],
      sourceRevision: 'source-a',
    },
    status: 'active',
    updatedAt: '2026-07-22T00:00:00.000Z',
  };
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
