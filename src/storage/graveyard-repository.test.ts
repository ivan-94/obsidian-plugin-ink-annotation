import { describe, expect, it } from 'vitest';

import type { TextAnnotationRecord } from '../domain/text-annotation';
import { encodeTextAnnotationRecord } from '../domain/text-annotation';
import { GraveyardRepository } from './graveyard-repository';
import type { TextFileStore } from './sidecar-repository';

describe('graveyard repository', () => {
  it('durably records text deletion evidence and suppresses only stale or exact payloads', async () => {
    const store = new MemoryTextFileStore();
    const repository = new GraveyardRepository(store, 'device-a');
    const tombstone = record({
      deletedAt: '2026-07-23T10:00:00.000Z',
      revision: 2,
      updatedAt: '2026-07-23T10:00:00.000Z',
    });

    await repository.recordTextTombstones([tombstone], '2026-07-23T11:00:00.000Z');

    expect(store.paths()).toEqual([
      expect.stringMatching(
        /^\.obsidian-annotations\/v1\/graveyard\/[a-f0-9]{64}\/2026-07-001\.json$/u,
      ),
    ]);
    await expect(
      repository.suppressesTextRecord(tombstone, encodeTextAnnotationRecord(tombstone)),
    ).resolves.toBe(true);
    const stale = record({ revision: 1, updatedAt: '2026-07-23T09:00:00.000Z' });
    await expect(
      repository.suppressesTextRecord(stale, encodeTextAnnotationRecord(stale)),
    ).resolves.toBe(true);
    const newer = record({ revision: 3, updatedAt: '2026-07-23T12:00:00.000Z' });
    await expect(
      repository.suppressesTextRecord(newer, encodeTextAnnotationRecord(newer)),
    ).resolves.toBe(false);
  });

  it('fails closed without hiding annotations when graveyard evidence is corrupt', async () => {
    const store = new MemoryTextFileStore();
    await store.write('.obsidian-annotations/v1/graveyard/broken-owner/2026-07-001.json', '{');
    const repository = new GraveyardRepository(store, 'device-a');
    const active = record();

    await expect(
      repository.suppressesTextRecord(active, encodeTextAnnotationRecord(active)),
    ).resolves.toBe(false);
  });
});

function record(patch: Partial<TextAnnotationRecord> = {}): TextAnnotationRecord {
  return {
    createdAt: '2026-07-23T09:00:00.000Z',
    deviceId: 'device-a',
    filePath: 'Guide.md',
    id: 'annotation-1',
    mark: { kind: 'highlight', styleId: 'highlight-rose' },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    tags: [],
    target: {
      position: { end: 7, start: 0, unit: 'utf16-code-unit' },
      quote: { exact: 'Deleted', prefix: '', suffix: '' },
      scope: {},
      sourceRevision: 'source',
    },
    updatedAt: '2026-07-23T09:00:00.000Z',
    ...patch,
  };
}

class MemoryTextFileStore implements TextFileStore {
  private readonly files = new Map<string, string>();

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

  write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
    return Promise.resolve();
  }

  paths(): readonly string[] {
    return [...this.files.keys()].sort();
  }
}
