import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import type { InkSurfaceRecord } from '../domain/ink-surface';
import { IndexedDbInkDocumentDraftStore } from './indexeddb-ink-document-draft-store';

describe('IndexedDbInkDocumentDraftStore', () => {
  it('keeps only the latest complete snapshot per note', async () => {
    const store = new IndexedDbInkDocumentDraftStore(
      new IDBFactory(),
      'ink-document-draft-latest-test',
    );

    await store.replace({ noteKey: 'Ink.md', revision: 1, snapshot: snapshot('first') });
    await store.replace({ noteKey: 'Ink.md', revision: 2, snapshot: snapshot('second') });

    await expect(store.load('Ink.md')).resolves.toMatchObject({
      noteKey: 'Ink.md',
      revision: 2,
      snapshot: { strokes: [{ id: 'second' }] },
    });
    await store.discard('Ink.md');
    await expect(store.load('Ink.md')).resolves.toBeNull();
    store.close();
  });
});

function snapshot(strokeId: string): InkSurfaceRecord {
  return {
    createdAt: '2026-07-21T00:00:00.000Z',
    filePath: 'Ink.md',
    id: 'document:note-1',
    layout: {
      blockFingerprints: [],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1200,
      logicalWidth: 960,
      originY: 0,
      sourceRevision: 'source-revision',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: [
      {
        color: '#111111',
        id: strokeId,
        points: [{ pressure: 0.5, time: 0, x: 10, y: 10 }],
        tool: 'pen',
        width: 2,
      },
    ],
    updatedAt: '2026-07-21T00:00:00.000Z',
  };
}
