import { describe, expect, it, vi } from 'vitest';

import type { SnapshotAnnotationRecord } from '../../domain/snapshot-annotation';
import { BrowserSnapshotThumbnailer } from './browser-snapshot-thumbnailer';

describe('Browser Snapshot thumbnailer', () => {
  it('flattens lazily at a Retina-capable bounded thumbnail size', async () => {
    const flatten = vi.fn(() => Promise.resolve(pngHeader(1200, 800)));
    const resize = vi.fn((input: { height: number; width: number }) => {
      expect(input).toMatchObject({ height: 427, width: 640 });
      return Promise.resolve('data:image/png;base64,thumb');
    });
    const thumbnailer = new BrowserSnapshotThumbnailer({ flattener: { flatten }, resize });

    await expect(
      thumbnailer.create(fixtureRecord(), pngHeader(1200, 800), new AbortController().signal),
    ).resolves.toBe('data:image/png;base64,thumb');
    expect(flatten).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledOnce();
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
      logicalHeight: 400,
      logicalWidth: 600,
      mimeType: 'image/png',
      pixelHeight: 800,
      pixelRatio: 2,
      pixelWidth: 1200,
      sha256: 'a'.repeat(64),
    },
    capturedAt: '2026-07-22T00:00:00.000Z',
    createdAt: '2026-07-22T00:00:00.000Z',
    filePath: 'Notes/Test.md',
    id: 'snapshot-a',
    ink: { logicalHeight: 400, logicalWidth: 600, strokes: [] },
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
