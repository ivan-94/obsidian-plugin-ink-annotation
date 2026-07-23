import { describe, expect, it, vi } from 'vitest';

import type { CatalogResultMeta } from './vault-catalog';
import { VaultCatalogSession, type VaultCatalogSessionStore } from './vault-catalog-session';

describe('VaultCatalogSession', () => {
  it('keeps only 20 note-open hints without opening IndexedDB while the Catalog is closed', async () => {
    const opened: Array<{ readonly noteId: string; readonly openedAt: string }> = [];
    const meta: CatalogResultMeta = { freshness: 'current', projectionEpoch: 0 };
    const store: VaultCatalogSessionStore = {
      close: vi.fn(),
      entriesForNote: vi.fn(),
      recentNotes: vi.fn().mockResolvedValue({ meta, notes: [] }),
      recordNoteOpened: vi.fn((noteId: string, openedAt: string) => {
        opened.push({ noteId, openedAt });
        return Promise.resolve();
      }),
      search: vi.fn(),
      suggestFacet: vi.fn(),
    };
    const openCatalog = vi.fn(() => Promise.resolve(store));
    const session = new VaultCatalogSession({ openCatalog });

    for (let index = 0; index < 25; index += 1) {
      session.recordNoteOpened(`note-${index}`, `2026-07-23T01:00:${index}.000Z`);
    }

    expect(openCatalog).not.toHaveBeenCalled();
    await session.recentNotes();
    expect(openCatalog).toHaveBeenCalledTimes(1);
    expect(opened).toHaveLength(20);
    expect(opened.map(({ noteId }) => noteId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `note-${index + 5}`),
    );
  });

  it('collapses more than 256 closed-Catalog dirty paths into one reconciliation', async () => {
    const meta: CatalogResultMeta = { freshness: 'current', projectionEpoch: 0 };
    const store: VaultCatalogSessionStore = {
      close: vi.fn(),
      entriesForNote: vi.fn(),
      recentNotes: vi.fn().mockResolvedValue({ meta, notes: [] }),
      recordNoteOpened: vi.fn(),
      search: vi.fn(),
      suggestFacet: vi.fn(),
    };
    const openCatalog = vi.fn(() => Promise.resolve(store));
    const reconcile = vi.fn(() => Promise.resolve());
    const projectPaths = vi.fn(() => Promise.resolve());
    const session = new VaultCatalogSession({ openCatalog, projectPaths, reconcile });
    for (let index = 0; index < 257; index += 1) {
      session.markDirtyPath(`.obsidian-annotations/source-${index}.json`);
    }

    expect(openCatalog).not.toHaveBeenCalled();
    await session.recentNotes();

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(projectPaths).not.toHaveBeenCalled();
  });

  it('cancels an in-progress first open when the scope closes', async () => {
    const session = new VaultCatalogSession({
      openCatalog: (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
        }),
    });

    const opening = session.recentNotes();
    session.close();

    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
  });
});
