import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';

import { IndexedDbVaultCatalog } from '../storage/indexeddb-vault-catalog';
import { VaultCatalogMarkdownProjector } from './vault-catalog-markdown-projector';

describe('VaultCatalogMarkdownProjector', () => {
  it('recomputes Snapshot links from one supplied Markdown body in 100-row batches', async () => {
    const catalog = new IndexedDbVaultCatalog({
      IDBKeyRange,
      databaseName: 'vault-catalog-markdown-projector-test',
      indexedDB: new IDBFactory(),
      vaultFingerprint: 'vault-a',
    });
    const target = {
      position: { end: 11, start: 0, unit: 'utf16-code-unit' as const },
      quote: { exact: 'Gamma block', prefix: '', suffix: '' },
      scope: { headingPath: ['Chapter'] },
      sourceRevision: 'source-a',
    };
    await catalog.upsertEntry({
      annotationId: 'snapshot-a',
      capturedAt: '2026-07-22T00:00:00.000Z',
      conflict: 0,
      filePath: 'Notes/Test.md',
      folder: 'Notes',
      headingPath: ['Chapter'],
      linkState: 'linked',
      logicalHeight: 200,
      logicalWidth: 300,
      noteId: 'note-a',
      position: 0,
      quote: 'Snapshot · Chapter',
      revision: 2,
      searchTextNormalized: 'snapshot chapter linked',
      status: 'active',
      strokeCount: 1,
      tags: [],
      tagsNormalized: [],
      thumbnailKey: 'snapshot:a:2',
      type: 'snapshot',
      updatedAt: '2026-07-22T01:00:00.000Z',
    });
    await catalog.putSnapshotBinding({
      annotationId: 'snapshot-a',
      filePath: 'Notes/Test.md',
      noteId: 'note-a',
      source: {
        coverage: [target],
        focus: target,
        headingPath: ['Chapter'],
        sourceRevision: 'source-a',
      },
      sourceRevision: 'source-a',
    });
    const yieldControl = vi.fn(() => Promise.resolve());
    const projector = new VaultCatalogMarkdownProjector(catalog, { yieldControl });

    await projector.apply({ noteId: 'note-a', source: 'Entirely different note' });

    const page = await catalog.entriesForNote({ noteId: 'note-a' });
    expect(page.state).toBe('ready');
    if (page.state !== 'ready') throw new Error('Expected a ready Catalog page.');
    expect(page.entries[0]).toMatchObject({ linkState: 'unanchored', position: 0 });
    expect(page.entries[0]?.searchTextNormalized).toContain('unanchored');
    expect(yieldControl).not.toHaveBeenCalled();
    catalog.close();
  });
});
