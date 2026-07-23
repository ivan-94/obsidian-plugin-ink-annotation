import { describe, expect, it } from 'vitest';

import { AnnotationService } from './annotation-service';
import { SidecarGarbageCollector } from './sidecar-garbage-collector';
import { encodeTextAnnotationRecord } from '../domain/text-annotation';
import { GraveyardRepository } from '../storage/graveyard-repository';
import { SidecarRepository, type TextFileStore } from '../storage/sidecar-repository';

describe('sidecar garbage collector', () => {
  it('previews deleted text annotations without removing canonical payloads', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'deleted-annotation', 'active-annotation'];
    const times = [
      '2026-07-23T10:00:00.000Z',
      '2026-07-23T10:01:00.000Z',
      '2026-07-23T10:02:00.000Z',
    ];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => times.shift() ?? '2026-07-23T10:03:00.000Z',
      repository,
    });
    const deleted = await service.createHighlight({
      filePath: 'Guide.md',
      selection: { end: 7, scope: {}, start: 0 },
      source: 'Deleted text and active text.',
      styleId: 'highlight-rose',
    });
    await service.deleteAnnotation(deleted.filePath, deleted.id, deleted.revision);
    await service.createHighlight({
      filePath: 'Guide.md',
      selection: { end: 23, scope: {}, start: 12 },
      source: 'Deleted text and active text.',
      styleId: 'highlight-sky',
    });
    const collector = new SidecarGarbageCollector({
      graveyard: {
        recordTextTombstones: () => Promise.resolve(),
      },
      now: () => '2026-07-23T11:00:00.000Z',
      repository,
    });

    await expect(collector.preview()).resolves.toEqual({
      eligibleTextAnnotations: 1,
      heldTextAnnotations: 0,
    });
    expect(store.hasPathSuffix(`/annotations/${deleted.id}.json`)).toBe(true);
  });

  it('records deletion evidence before removing a tombstoned payload', async () => {
    const events: string[] = [];
    const store = new MemoryTextFileStore(events);
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'deleted-annotation'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => '2026-07-23T10:00:00.000Z',
      repository,
    });
    const record = await service.createHighlight({
      filePath: 'Guide.md',
      selection: { end: 7, scope: {}, start: 0 },
      source: 'Deleted text.',
      styleId: 'highlight-rose',
    });
    await service.deleteAnnotation(record.filePath, record.id, record.revision);
    events.length = 0;
    const collector = new SidecarGarbageCollector({
      graveyard: {
        recordTextTombstones: (records) => {
          events.push(`graveyard:${records.map(({ id }) => id).join(',')}`);
          return Promise.resolve();
        },
      },
      now: () => '2026-07-23T11:00:00.000Z',
      repository,
    });

    await expect(collector.clear()).resolves.toEqual({
      failedTextAnnotations: 0,
      heldTextAnnotations: 0,
      removedTextAnnotations: 1,
    });
    expect(events).toEqual([
      `graveyard:${record.id}`,
      expect.stringMatching(new RegExp(`^remove:.*/annotations/${record.id}\\.json$`, 'u')),
    ]);
    expect(store.hasPathSuffix(`/annotations/${record.id}.json`)).toBe(false);
  });

  it('suppresses a delayed stale artifact after clearing while preserving a newer edit', async () => {
    const store = new MemoryTextFileStore();
    const graveyard = new GraveyardRepository(store, 'device-a');
    const repository = new SidecarRepository(store, { deletionEvidence: graveyard });
    const ids = ['note-1', 'deleted-annotation'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => '2026-07-23T10:00:00.000Z',
      repository,
    });
    const active = await service.createHighlight({
      filePath: 'Guide.md',
      selection: { end: 7, scope: {}, start: 0 },
      source: 'Deleted text.',
      styleId: 'highlight-rose',
    });
    await service.deleteAnnotation(active.filePath, active.id, active.revision);
    const canonicalPath = store.pathBySuffix(`/annotations/${active.id}.json`);
    expect(canonicalPath).not.toBeNull();
    const collector = new SidecarGarbageCollector({
      graveyard,
      now: () => '2026-07-23T11:00:00.000Z',
      repository,
    });
    await collector.clear();

    await store.write(canonicalPath ?? '', encodeTextAnnotationRecord(active));
    await expect(repository.listAnnotations(active.filePath)).resolves.toMatchObject({
      records: [],
    });

    const newer = {
      ...active,
      revision: 3,
      updatedAt: '2026-07-23T12:00:00.000Z',
    };
    await store.write(canonicalPath ?? '', encodeTextAnnotationRecord(newer));
    await expect(repository.listAnnotations(active.filePath)).resolves.toMatchObject({
      records: [newer],
    });
  });

  it('does not remove a record that changed after the cleanup preview', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'deleted-annotation'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => '2026-07-23T10:00:00.000Z',
      repository,
    });
    const active = await service.createHighlight({
      filePath: 'Guide.md',
      selection: { end: 7, scope: {}, start: 0 },
      source: 'Deleted text.',
      styleId: 'highlight-rose',
    });
    const tombstone = await service.deleteAnnotation(active.filePath, active.id, active.revision);
    const canonicalPath = store.pathBySuffix(`/annotations/${active.id}.json`);
    const newer = {
      ...active,
      revision: tombstone.revision + 1,
      updatedAt: '2026-07-23T12:00:00.000Z',
    };
    const collector = new SidecarGarbageCollector({
      graveyard: {
        recordTextTombstones: async () => {
          await store.write(canonicalPath ?? '', encodeTextAnnotationRecord(newer));
        },
      },
      now: () => '2026-07-23T11:00:00.000Z',
      repository,
    });

    await expect(collector.clear()).resolves.toEqual({
      failedTextAnnotations: 1,
      heldTextAnnotations: 0,
      removedTextAnnotations: 0,
    });
    await expect(repository.readAnnotation(active.filePath, active.id)).resolves.toEqual(newer);
  });

  it('retries a payload left behind after verified graveyard evidence', async () => {
    const store = new MemoryTextFileStore();
    const graveyard = new GraveyardRepository(store, 'device-a');
    const repository = new SidecarRepository(store, { deletionEvidence: graveyard });
    const ids = ['note-1', 'deleted-annotation'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => '2026-07-23T10:00:00.000Z',
      repository,
    });
    const active = await service.createHighlight({
      filePath: 'Guide.md',
      selection: { end: 7, scope: {}, start: 0 },
      source: 'Deleted text.',
      styleId: 'highlight-rose',
    });
    await service.deleteAnnotation(active.filePath, active.id, active.revision);
    store.failNextRemoveFor(`/annotations/${active.id}.json`);
    const collector = new SidecarGarbageCollector({
      graveyard,
      now: () => '2026-07-23T11:00:00.000Z',
      repository,
    });

    await expect(collector.clear()).resolves.toMatchObject({
      failedTextAnnotations: 1,
      removedTextAnnotations: 0,
    });
    await expect(collector.preview()).resolves.toEqual({
      eligibleTextAnnotations: 1,
      heldTextAnnotations: 0,
    });
    await expect(collector.clear()).resolves.toMatchObject({
      failedTextAnnotations: 0,
      removedTextAnnotations: 1,
    });
  });
});

class MemoryTextFileStore implements TextFileStore {
  private readonly files = new Map<string, string>();
  private failingRemoveSuffix: string | null = null;

  constructor(private readonly events: string[] = []) {}

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

  remove(path: string): Promise<void> {
    this.events.push(`remove:${path}`);
    if (this.failingRemoveSuffix !== null && path.endsWith(this.failingRemoveSuffix)) {
      this.failingRemoveSuffix = null;
      return Promise.reject(new Error('Injected payload removal failure.'));
    }
    this.files.delete(path);
    return Promise.resolve();
  }

  write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
    return Promise.resolve();
  }

  hasPathSuffix(suffix: string): boolean {
    return [...this.files.keys()].some((path) => path.endsWith(suffix));
  }

  pathBySuffix(suffix: string): string | null {
    return [...this.files.keys()].find((path) => path.endsWith(suffix)) ?? null;
  }

  failNextRemoveFor(suffix: string): void {
    this.failingRemoveSuffix = suffix;
  }
}
