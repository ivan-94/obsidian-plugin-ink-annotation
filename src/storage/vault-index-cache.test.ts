import { describe, expect, it } from 'vitest';

import type { AnnotationIndexEntry } from '../domain/vault-annotation-index';
import type { TextFileStore } from './sidecar-repository';
import { VaultIndexCache } from './vault-index-cache';

describe('disposable Vault index cache', () => {
  it('round-trips list-only entries and treats deletion as a rebuildable cache miss', async () => {
    const store = new MemoryStore();
    const cache = new VaultIndexCache(store);
    const entries = [entry(), inkEntry()];

    await cache.save(entries, '2026-07-14T10:00:00.000Z');
    await expect(cache.load()).resolves.toEqual({
      entries,
      generatedAt: '2026-07-14T10:00:00.000Z',
    });
    await cache.clear();
    await expect(cache.load()).resolves.toBeNull();
    expect([...store.files.keys()].some((path) => path.includes('/annotations/'))).toBe(false);
  });

  it('rejects lifecycle-unaware v1 caches before they can show missing sources', async () => {
    const store = new MemoryStore();
    const cache = new VaultIndexCache(store);
    await store.write(
      '.obsidian-annotations/v1/index.json',
      JSON.stringify({
        derived: true,
        entries: [entry()],
        generatedAt: '2026-07-14T10:00:00.000Z',
        schemaVersion: 1,
      }),
    );

    await expect(cache.load()).resolves.toBeNull();
  });
});

function entry(): AnnotationIndexEntry {
  return {
    conflict: false,
    filePath: 'Note.md',
    id: 'annotation-1',
    noteId: 'note-1',
    position: 5,
    quote: 'Indexed quote',
    revision: 2,
    status: 'active',
    styleId: 'highlight-sun',
    tags: ['review'],
    type: 'highlight',
    updatedAt: '2026-07-14T09:00:00.000Z',
  };
}

function inkEntry(): AnnotationIndexEntry {
  return {
    conflict: true,
    filePath: 'Note.md',
    id: 'surface-1',
    ink: { headingPath: ['Ink'], strokeCount: 3 },
    noteId: 'note-1',
    position: 30,
    quote: 'Ink · Ink',
    revision: 4,
    status: 'needs-rebase',
    tags: [],
    type: 'ink',
    updatedAt: '2026-07-14T09:00:00.000Z',
  };
}

class MemoryStore implements TextFileStore {
  readonly files = new Map<string, string>();

  list(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }
  read(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }
  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
  write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
    return Promise.resolve();
  }
}
