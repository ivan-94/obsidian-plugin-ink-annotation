import { describe, expect, it } from 'vitest';

import type { InkSurfaceRecord } from '../domain/ink-surface';
import { InkDocumentSnapshotRepository } from './ink-document-snapshot-repository';
import type { TextFileStore } from './sidecar-repository';

describe('InkDocumentSnapshotRepository', () => {
  it('replaces one canonical snapshot without reading or comparing the previous value', async () => {
    const store = new RecordingTextFileStore();
    const repository = new InkDocumentSnapshotRepository(store);

    await repository.replace(snapshot('first'));
    await repository.replace(snapshot('second'));

    expect(store.readCount).toBe(0);
    expect(store.writes).toHaveLength(2);
    expect(new Set(store.writes.map(({ path }) => path))).toEqual(
      new Set([
        '.obsidian-annotations/v1/notes/42cd6da88948869da374a046543a3d289fe23698e6f97b0a1a4012e9262fcbee/ink.json',
      ]),
    );
    await expect(repository.read('Ink.md')).resolves.toMatchObject({
      strokes: [{ id: 'second' }],
    });
  });

  it('returns null when no simple snapshot exists', async () => {
    const repository = new InkDocumentSnapshotRepository(new RecordingTextFileStore());

    await expect(repository.read('Ink.md')).resolves.toBeNull();
  });

  it('resolves an external snapshot event back to its validated note path', async () => {
    const store = new RecordingTextFileStore();
    const repository = new InkDocumentSnapshotRepository(store);
    await repository.replace(snapshot('saved'));
    const path = store.writes[0]?.path;
    if (path === undefined) throw new Error('Expected snapshot write path.');

    await expect(repository.resolveFilePath(path)).resolves.toBe('Ink.md');
    await expect(
      repository.resolveFilePath(path.replace('ink.json', 'other.json')),
    ).resolves.toBeNull();
  });

  it('rewrites only the embedded note path after the note root has been renamed', async () => {
    const store = new RecordingTextFileStore();
    const repository = new InkDocumentSnapshotRepository(store);
    await repository.replace(snapshot('renamed'));
    store.moveNoteRoot(
      '42cd6da88948869da374a046543a3d289fe23698e6f97b0a1a4012e9262fcbee',
      'a38a5f1da00de6b2edaea7ce4e834c6545ec1718c04e8ae09addf08f8ecadbcf',
    );

    await repository.reconcileFilePath('Renamed.md', '2026-07-21T01:00:00.000Z');

    await expect(repository.read('Renamed.md')).resolves.toMatchObject({
      filePath: 'Renamed.md',
      strokes: [{ id: 'renamed' }],
      updatedAt: '2026-07-21T01:00:00.000Z',
    });
  });
});

function snapshot(strokeId: string): InkSurfaceRecord {
  return {
    createdAt: '2026-07-21T00:00:00.000Z',
    filePath: 'Ink.md',
    id: 'document',
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
        points: [
          { pressure: 0.5, time: 0, x: 10, y: 10 },
          { pressure: 0.5, time: 16, x: 20, y: 20 },
        ],
        tool: 'pen',
        width: 2,
      },
    ],
    updatedAt: '2026-07-21T00:00:00.000Z',
  };
}

class RecordingTextFileStore implements TextFileStore {
  readonly files = new Map<string, string>();
  readCount = 0;
  readonly writes: { readonly contents: string; readonly path: string }[] = [];

  moveNoteRoot(fromHash: string, toHash: string): void {
    const from = `.obsidian-annotations/v1/notes/${fromHash}/`;
    const to = `.obsidian-annotations/v1/notes/${toHash}/`;
    for (const [path, contents] of [...this.files]) {
      if (!path.startsWith(from)) continue;
      this.files.delete(path);
      this.files.set(`${to}${path.slice(from.length)}`, contents);
    }
  }

  list(directory: string): Promise<readonly string[]> {
    return Promise.resolve(
      [...this.files.keys()]
        .filter((path) => path.startsWith(`${directory}/`))
        .map((path) => path.slice(directory.length + 1))
        .filter((path) => !path.includes('/')),
    );
  }

  mkdir(): Promise<void> {
    return Promise.resolve();
  }

  read(path: string): Promise<string | null> {
    this.readCount += 1;
    return Promise.resolve(this.files.get(path) ?? null);
  }

  write(path: string, contents: string): Promise<void> {
    this.writes.push({ contents, path });
    this.files.set(path, contents);
    return Promise.resolve();
  }
}
