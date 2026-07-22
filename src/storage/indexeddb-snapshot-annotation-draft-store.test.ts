import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { SnapshotAnnotationSession } from '../application/snapshot-annotation-session';
import { IndexedDbSnapshotAnnotationDraftStore } from './indexeddb-snapshot-annotation-draft-store';

describe('IndexedDbSnapshotAnnotationDraftStore', () => {
  it('replaces, restores, and discards one complete image-and-Ink draft per Snapshot', async () => {
    const store = new IndexedDbSnapshotAnnotationDraftStore(
      new IDBFactory(),
      'snapshot-annotation-draft-test',
    );
    const draft = await createDraft();

    await store.replace(draft);

    await expect(store.load('Notes/Test.md:snapshot-a')).resolves.toMatchObject({
      draftKey: 'Notes/Test.md:snapshot-a',
      record: { id: 'snapshot-a', ink: { strokes: [{ id: 'stroke-a' }] } },
      savedAt: '2026-07-22T01:00:00.000Z',
    });
    expect((await store.load('Notes/Test.md:snapshot-a'))?.pngBytes).toEqual(draft.pngBytes);
    await expect(store.loadLatest('Notes/Test.md')).resolves.toMatchObject({
      draftKey: 'Notes/Test.md:snapshot-a',
    });
    await store.discard('Notes/Test.md:snapshot-a');
    await expect(store.load('Notes/Test.md:snapshot-a')).resolves.toBeNull();
    store.close();
  });

  it('rejects a Draft whose image bytes do not match its canonical asset metadata', async () => {
    const store = new IndexedDbSnapshotAnnotationDraftStore(
      new IDBFactory(),
      'snapshot-annotation-draft-integrity-test',
    );
    const draft = await createDraft();
    const corrupted = Uint8Array.from(draft.pngBytes);
    corrupted[0] = 0;

    await expect(store.replace({ ...draft, pngBytes: corrupted })).rejects.toThrow(
      'Snapshot Annotation capture asset failed local integrity verification.',
    );
    await expect(store.load(draft.draftKey)).resolves.toBeNull();
    store.close();
  });
});

async function createDraft() {
  const pngBytes = pngHeader(600, 400);
  const session = await SnapshotAnnotationSession.create({
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
    pngBytes,
    source: {
      coverage: [target()],
      focus: target(),
      headingPath: ['Test'],
      sourceRevision: 'source-a',
    },
  });
  session.addStroke({
    brushRenderVersion: 'legacy-round-v1',
    color: '#111111',
    id: 'stroke-a',
    inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
    points: [{ pressure: 0.5, time: 1, x: 10, y: 20 }],
    tool: 'pen',
    width: 2,
  });
  return {
    draftKey: 'Notes/Test.md:snapshot-a',
    isNew: true,
    pngBytes,
    record: session.snapshot().record,
    savedAt: '2026-07-22T01:00:00.000Z',
  };
}

function target() {
  return {
    position: { end: 4, start: 0, unit: 'utf16-code-unit' as const },
    quote: { exact: 'Test', prefix: '', suffix: '' },
    scope: { headingPath: ['Test'] },
    sourceRevision: 'source-a',
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
