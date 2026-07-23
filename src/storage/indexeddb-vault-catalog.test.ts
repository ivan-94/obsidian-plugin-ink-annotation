import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { IndexedDbVaultCatalog } from './indexeddb-vault-catalog';

describe('IndexedDbVaultCatalog', () => {
  it('returns recent note summaries without embedding child entries', async () => {
    const catalog = new IndexedDbVaultCatalog({
      IDBKeyRange,
      databaseName: 'vault-catalog-recent-notes-test',
      indexedDB: new IDBFactory(),
      vaultFingerprint: 'vault-a',
    });

    await catalog.upsertEntry({
      annotationId: 'annotation-a',
      conflict: 0,
      filePath: 'Folder/Note.md',
      folder: 'Folder',
      noteId: 'note-a',
      position: 4,
      quote: 'bounded catalog',
      revision: 1,
      searchTextNormalized: 'bounded catalog\nfolder/note.md',
      status: 'active',
      tags: [],
      tagsNormalized: [],
      type: 'highlight',
      updatedAt: '2026-07-23T01:00:00.000Z',
    });

    await expect(catalog.recentNotes()).resolves.toEqual({
      meta: { freshness: 'current', projectionEpoch: 1 },
      notes: [
        {
          activityAt: '2026-07-23T01:00:00.000Z',
          annotationCount: 1,
          conflictCount: 0,
          filePath: 'Folder/Note.md',
          folder: 'Folder',
          legacyInkCount: 0,
          lastAnnotatedAt: '2026-07-23T01:00:00.000Z',
          noteId: 'note-a',
          problemCount: 0,
          snapshotCount: 0,
          textCount: 1,
          title: 'Note',
        },
      ],
    });

    catalog.close();
  });

  it('pages one note in document order with an opaque keyset cursor', async () => {
    const catalog = new IndexedDbVaultCatalog({
      IDBKeyRange,
      databaseName: 'vault-catalog-note-page-test',
      indexedDB: new IDBFactory(),
      vaultFingerprint: 'vault-a',
    });
    for (const [annotationId, noteId, position] of [
      ['annotation-c', 'note-a', 30],
      ['annotation-other', 'note-b', 1],
      ['annotation-a', 'note-a', 10],
      ['annotation-b', 'note-a', 20],
    ] as const) {
      await catalog.upsertEntry(
        entry({ annotationId, noteId, position, filePath: `${noteId}.md` }),
      );
    }

    const first = await catalog.entriesForNote({ limit: 2, noteId: 'note-a' });
    expect(first.state).toBe('ready');
    if (first.state !== 'ready') throw new Error('Expected a ready Catalog page.');
    expect(first.entries.map(({ annotationId }) => annotationId)).toEqual([
      'annotation-a',
      'annotation-b',
    ]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await catalog.entriesForNote({
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
      limit: 2,
      noteId: 'note-a',
    });
    expect(second).toMatchObject({ hasMore: false, state: 'ready' });
    if (second.state !== 'ready') throw new Error('Expected a ready Catalog page.');
    expect(second.entries.map(({ annotationId }) => annotationId)).toEqual(['annotation-c']);
    catalog.close();
  });

  it('searches normalized text in bounded updated-time order', async () => {
    const catalog = new IndexedDbVaultCatalog({
      IDBKeyRange,
      databaseName: 'vault-catalog-search-test',
      indexedDB: new IDBFactory(),
      vaultFingerprint: 'vault-a',
    });
    await catalog.upsertEntry({
      ...entry({
        annotationId: 'older',
        filePath: 'One.md',
        noteId: 'note-one',
        position: 1,
      }),
      searchTextNormalized: 'bounded 中文',
      updatedAt: '2026-07-23T01:00:00.000Z',
    });
    await catalog.upsertEntry({
      ...entry({
        annotationId: 'newer',
        filePath: 'Two.md',
        noteId: 'note-two',
        position: 1,
      }),
      searchTextNormalized: 'also bounded',
      updatedAt: '2026-07-23T02:00:00.000Z',
    });
    await catalog.upsertEntry({
      ...entry({
        annotationId: 'non-match',
        filePath: 'Three.md',
        noteId: 'note-three',
        position: 1,
      }),
      searchTextNormalized: 'unrelated',
      updatedAt: '2026-07-23T03:00:00.000Z',
    });

    const result = await catalog.search({ limit: 10, text: 'ＢＯＵＮＤＥＤ' });

    expect(result.state).toBe('ready');
    if (result.state !== 'ready') throw new Error('Expected a ready Catalog search page.');
    expect(result.entries.map(({ annotationId }) => annotationId)).toEqual(['newer', 'older']);
    expect(result.progress).toEqual({ exhaustive: true, scanned: 3 });
    expect(result.hasMore).toBe(false);
    catalog.close();
  });

  it('moves an opened note to the front without changing its annotation timestamp', async () => {
    const catalog = new IndexedDbVaultCatalog({
      IDBKeyRange,
      databaseName: 'vault-catalog-note-opened-test',
      indexedDB: new IDBFactory(),
      vaultFingerprint: 'vault-a',
    });
    await catalog.upsertEntry({
      ...entry({ annotationId: 'a', filePath: 'A.md', noteId: 'note-a', position: 1 }),
      updatedAt: '2026-07-23T01:00:00.000Z',
    });
    await catalog.upsertEntry({
      ...entry({ annotationId: 'b', filePath: 'B.md', noteId: 'note-b', position: 1 }),
      updatedAt: '2026-07-23T02:00:00.000Z',
    });

    await catalog.recordNoteOpened('note-a', '2026-07-23T03:00:00.000Z');

    const result = await catalog.recentNotes();
    expect(result.notes.map(({ noteId }) => noteId)).toEqual(['note-a', 'note-b']);
    expect(result.notes[0]).toMatchObject({
      activityAt: '2026-07-23T03:00:00.000Z',
      lastAnnotatedAt: '2026-07-23T01:00:00.000Z',
      lastOpenedAt: '2026-07-23T03:00:00.000Z',
    });
    catalog.close();
  });

  it('rejects a stale projection without advancing the epoch', async () => {
    const catalog = new IndexedDbVaultCatalog({
      IDBKeyRange,
      databaseName: 'vault-catalog-stale-revision-test',
      indexedDB: new IDBFactory(),
      vaultFingerprint: 'vault-a',
    });
    const projected = entry({
      annotationId: 'annotation-a',
      filePath: 'Note.md',
      noteId: 'note-a',
      position: 1,
    });
    await catalog.upsertEntry({ ...projected, quote: 'newer', revision: 2 });

    await expect(catalog.upsertEntry({ ...projected, quote: 'stale', revision: 1 })).resolves.toBe(
      'stale',
    );

    const page = await catalog.entriesForNote({ noteId: 'note-a' });
    expect(page.state).toBe('ready');
    if (page.state !== 'ready') throw new Error('Expected a ready Catalog page.');
    expect(page.entries[0]).toMatchObject({ quote: 'newer', revision: 2 });
    expect(page.meta.projectionEpoch).toBe(1);
    catalog.close();
  });
});

function entry(input: {
  readonly annotationId: string;
  readonly filePath: string;
  readonly noteId: string;
  readonly position: number;
}) {
  return {
    ...input,
    conflict: 0 as const,
    folder: '',
    quote: input.annotationId,
    revision: 1,
    searchTextNormalized: input.annotationId,
    status: 'active' as const,
    tags: [],
    tagsNormalized: [],
    type: 'highlight' as const,
    updatedAt: `2026-07-23T01:00:${String(input.position).padStart(2, '0')}.000Z`,
  };
}
