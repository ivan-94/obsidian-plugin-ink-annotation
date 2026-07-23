import { describe, expect, it, vi } from 'vitest';

import type { TextAnnotationRecord } from '../domain/text-annotation';
import {
  VaultCatalogReconciler,
  type VaultCatalogReconcileStore,
} from './vault-catalog-reconciler';

describe('VaultCatalogReconciler', () => {
  it('reprojects a known file path without running a Vault-wide note inventory', async () => {
    const note = {
      filePath: 'Notes/Known.md',
      lastReconciledAt: '2026-07-23T00:00:00.000Z',
      noteId: 'note-known',
      pathHash: 'a'.repeat(64),
      schemaVersion: 1 as const,
      sourceFingerprint: 'source-known',
    };
    const replaceNoteProjection = vi.fn(() => Promise.resolve());
    const store: VaultCatalogReconcileStore = {
      isInitialized: vi.fn().mockResolvedValue(true),
      removeFile: vi.fn(),
      removeNote: vi.fn(),
      removeNotesNotIn: vi.fn(),
      replaceNoteProjection,
      setFreshness: vi.fn(),
      setInitialized: vi.fn(),
    };
    const listNotes = vi.fn();
    const readNoteMeta = vi.fn().mockResolvedValue(note);
    const reconciler = new VaultCatalogReconciler({
      source: {
        isSourceAvailable: () => true,
        listAnnotations: vi.fn().mockResolvedValue({
          conflicts: [],
          issues: [],
          records: [textRecord()],
        }),
        listNotes,
        listSnapshotRecords: vi.fn().mockResolvedValue([]),
        listSurfaceSummaries: vi.fn().mockResolvedValue([]),
        readMarkdown: vi.fn(),
        readNoteMeta,
      },
    });

    await reconciler.reconcileFiles(store, ['Notes/Known.md']);

    expect(readNoteMeta).toHaveBeenCalledWith('Notes/Known.md');
    expect(listNotes).not.toHaveBeenCalled();
    expect(replaceNoteProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [expect.objectContaining({ annotationId: 'annotation-known' })],
        noteId: 'note-known',
      }),
    );
  });
});

function textRecord(): TextAnnotationRecord {
  return {
    createdAt: '2026-07-23T00:00:00.000Z',
    filePath: 'Notes/Known.md',
    id: 'annotation-known',
    mark: { kind: 'highlight', styleId: 'highlight-sun' },
    noteId: 'note-known',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    tags: [],
    target: {
      position: { end: 5, start: 0, unit: 'utf16-code-unit' },
      quote: { exact: 'Known', prefix: '', suffix: '' },
      scope: {},
    },
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
}
