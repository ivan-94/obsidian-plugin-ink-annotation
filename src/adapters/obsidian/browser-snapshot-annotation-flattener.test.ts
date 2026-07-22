import { describe, expect, it, vi } from 'vitest';

import { SnapshotAnnotationSession } from '../../application/snapshot-annotation-session';
import {
  BrowserSnapshotAnnotationFlattener,
  type SnapshotFlattenRasterInput,
} from './browser-snapshot-annotation-flattener';

describe('Browser Snapshot Annotation flattener', () => {
  it('compiles accepted brush geometry before rasterizing the immutable image', async () => {
    const session = await fixtureSession();
    session.addStroke(stroke());
    const rasterize = vi.fn((input: SnapshotFlattenRasterInput) => {
      expect(input.geometries).toHaveLength(1);
      expect(input.geometries[0]).toMatchObject({ kind: 'exact' });
      return Promise.resolve(pngHeader(600, 400));
    });
    const flattener = new BrowserSnapshotAnnotationFlattener({ rasterize });

    await expect(
      flattener.flatten(
        session.snapshot().record,
        pngHeader(600, 400),
        new AbortController().signal,
      ),
    ).resolves.toEqual(pngHeader(600, 400));
    expect(rasterize).toHaveBeenCalledOnce();
  });

  it('fails closed before rasterization for an unknown brush renderer', async () => {
    const session = await fixtureSession();
    session.addStroke(stroke());
    const record = structuredClone(session.snapshot().record);
    Object.assign(record.ink.strokes[0] as object, { brushRenderVersion: 'future-brush-v9' });
    const rasterize = vi.fn(() => Promise.resolve(pngHeader(600, 400)));
    const flattener = new BrowserSnapshotAnnotationFlattener({ rasterize });

    await expect(
      flattener.flatten(record, pngHeader(600, 400), new AbortController().signal),
    ).rejects.toThrow('unsupported brush renderer');
    expect(rasterize).not.toHaveBeenCalled();
  });
});

async function fixtureSession(): Promise<SnapshotAnnotationSession> {
  const target = {
    position: { end: 4, start: 0, unit: 'utf16-code-unit' as const },
    quote: { exact: 'Test', prefix: '', suffix: '' },
    scope: { headingPath: ['Test'] },
    sourceRevision: 'source-a',
  };
  return SnapshotAnnotationSession.create({
    backend: { id: 'fake', version: '1' },
    capturedAt: '2026-07-22T00:00:00.000Z',
    filePath: 'Notes/Test.md',
    id: 'snapshot-a',
    logicalHeight: 200,
    logicalWidth: 300,
    noteId: 'note-a',
    pixelHeight: 400,
    pixelRatio: 2,
    pixelWidth: 600,
    pngBytes: pngHeader(600, 400),
    source: {
      coverage: [target],
      focus: target,
      headingPath: ['Test'],
      sourceRevision: 'source-a',
    },
  });
}

function stroke() {
  return {
    brushRenderVersion: 'legacy-round-v1' as const,
    color: '#d97777',
    id: 'stroke-a',
    inputProfile: { pressure: 'legacy-unknown' as const, tilt: 'legacy-unknown' as const },
    points: [{ pressure: 0.5, time: 1, x: 10, y: 20 }],
    tool: 'pen' as const,
    width: 4,
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
