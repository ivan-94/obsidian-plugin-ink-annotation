import { describe, expect, it } from 'vitest';

import type { InkSurfaceRecord } from '../domain/ink-surface';
import { InkSurfaceRepository } from '../storage/ink-surface-repository';
import { SidecarRepository, type TextFileStore } from '../storage/sidecar-repository';
import { SidecarLifecycleService } from './sidecar-lifecycle-service';

describe('sidecar lifecycle service', () => {
  it('moves text and Ink ownership together for an observed rename', async () => {
    const store = new MemoryTextFileStore();
    const annotations = new SidecarRepository(store);
    await annotations.getOrCreateNote({
      createId: () => 'note-1',
      filePath: 'Draft.md',
      now: '2026-07-16T15:00:00.000Z',
      sourceFingerprint: 'before-edit',
    });
    const publishedInkChanges: InkSurfaceRecord[] = [];
    const ink = new InkSurfaceRepository(store, {
      onSurfaceChanged: (record) => publishedInkChanges.push(record),
    });
    const original = surface('Draft.md');
    await ink.writeSurface(original);
    publishedInkChanges.length = 0;
    const lifecycle = new SidecarLifecycleService({
      annotations,
      ink,
      now: () => '2026-07-16T15:01:00.000Z',
    });

    const renamed = await lifecycle.reconcileObservedRename('Draft.md', 'Renamed.md');

    expect(renamed).toMatchObject({ filePath: 'Renamed.md', noteId: 'note-1' });
    await expect(ink.readSurface('Renamed.md', original.id)).resolves.toEqual({
      ...original,
      filePath: 'Renamed.md',
      revision: 2,
      updatedAt: '2026-07-16T15:01:00.000Z',
    });
    await expect(ink.readSurface('Draft.md', original.id)).resolves.toBeNull();
    expect(publishedInkChanges).toMatchObject([
      { filePath: 'Renamed.md', id: original.id, revision: 2 },
    ]);
  });

  it('returns the persisted note identity when its source becomes missing', async () => {
    const store = new MemoryTextFileStore();
    const annotations = new SidecarRepository(store);
    await annotations.getOrCreateNote({
      createId: () => 'note-1',
      filePath: 'Deleted.md',
      now: '2026-07-16T15:00:00.000Z',
      sourceFingerprint: 'source',
    });
    const lifecycle = new SidecarLifecycleService({
      annotations,
      ink: new InkSurfaceRepository(store),
      now: () => '2026-07-16T15:02:00.000Z',
    });

    await expect(lifecycle.markSourceMissing('Deleted.md')).resolves.toMatchObject({
      filePath: 'Deleted.md',
      noteId: 'note-1',
      sourceMissingAt: '2026-07-16T15:02:00.000Z',
    });
  });

  it('reports an observed rename when a canonical Ink path rewrite fails', async () => {
    const store = new MemoryTextFileStore();
    const annotations = new SidecarRepository(store);
    await annotations.getOrCreateNote({
      createId: () => 'note-1',
      filePath: 'Draft.md',
      now: '2026-07-16T15:00:00.000Z',
      sourceFingerprint: 'source',
    });
    const ink = new InkSurfaceRepository(store);
    await ink.writeSurface(surface('Draft.md'));
    store.failNextSurfaceWrite();
    const lifecycle = new SidecarLifecycleService({
      annotations,
      ink,
      now: () => '2026-07-16T15:03:00.000Z',
    });

    await expect(lifecycle.reconcileObservedRename('Draft.md', 'Renamed.md')).rejects.toThrow(
      'Injected Ink path write failure',
    );
  });
});

function surface(filePath: string): InkSurfaceRecord {
  return {
    createdAt: '2026-07-16T15:00:00.000Z',
    filePath,
    id: 'surface-1',
    layout: {
      blockFingerprints: [],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 800,
      logicalWidth: 704,
      sourceRevision: 'before-edit',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: [],
    updatedAt: '2026-07-16T15:00:00.000Z',
  };
}

class MemoryTextFileStore implements TextFileStore {
  private readonly files = new Map<string, string>();
  private failSurfaceWrite = false;

  list(directory: string): Promise<readonly string[]> {
    const prefix = `${directory}/`;
    return Promise.resolve(
      [
        ...new Set(
          [...this.files.keys()]
            .filter((path) => path.startsWith(prefix))
            .map((path) => path.slice(prefix.length).split('/')[0])
            .filter((name): name is string => name !== undefined && name.length > 0),
        ),
      ].sort(),
    );
  }

  mkdir(): Promise<void> {
    return Promise.resolve();
  }

  read(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }

  rename(from: string, to: string): Promise<void> {
    for (const [path, contents] of [...this.files.entries()]) {
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      this.files.delete(path);
      this.files.set(`${to}${path.slice(from.length)}`, contents);
    }
    return Promise.resolve();
  }

  write(path: string, contents: string): Promise<void> {
    if (this.failSurfaceWrite && path.includes('/surfaces/')) {
      this.failSurfaceWrite = false;
      return Promise.reject(new Error('Injected Ink path write failure'));
    }
    this.files.set(path, contents);
    return Promise.resolve();
  }

  failNextSurfaceWrite(): void {
    this.failSurfaceWrite = true;
  }
}
