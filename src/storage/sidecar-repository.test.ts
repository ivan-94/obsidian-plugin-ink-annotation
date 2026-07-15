import { describe, expect, it } from 'vitest';

import { AnnotationService } from '../application/annotation-service';
import { tombstoneAnnotation } from '../domain/annotation-lifecycle';
import { encodeTextAnnotationRecord } from '../domain/text-annotation';
import { SidecarRepository, type TextFileStore } from './sidecar-repository';

describe('sidecar repository contract', () => {
  it('creates, reads and updates one versioned JSON file per annotation', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const source = 'A durable annotation target.';
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => '2026-07-14T08:00:00.000Z',
      repository,
    });
    const created = await service.createHighlight({
      filePath: 'Contracts.md',
      selection: { end: 20, scope: {}, start: 2 },
      source,
      styleId: 'highlight-yellow',
    });

    await expect(repository.readAnnotation('Contracts.md', created.id)).resolves.toEqual(created);

    const updated = {
      ...created,
      mark: { kind: 'highlight' as const, styleId: 'highlight-blue' },
      revision: 2,
      updatedAt: '2026-07-14T08:05:00.000Z',
    };
    await repository.updateAnnotation(updated);

    await expect(
      new SidecarRepository(store).readAnnotation('Contracts.md', created.id),
    ).resolves.toEqual(updated);
  });

  it('isolates a corrupt annotation file without hiding healthy sibling records', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1', 'annotation-2'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const created = await service.createHighlight({
      filePath: 'Corruption.md',
      selection: { end: 7, scope: {}, start: 0 },
      source: 'Healthy sibling record.',
      styleId: 'highlight-yellow',
    });
    await store.addCorruptSibling();

    const loaded = await repository.listAnnotations('Corruption.md');

    expect(loaded.records).toEqual([created]);
    expect(loaded.issues).toHaveLength(1);
    expect(loaded.issues[0]?.path).toMatch(/annotation-corrupt\.json$/u);
  });

  it('serializes writes per record and rejects a concurrent stale branch', async () => {
    const store = new MemoryTextFileStore(10);
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const created = await service.createHighlight({
      filePath: 'Concurrent.md',
      selection: { end: 10, scope: {}, start: 0 },
      source: 'Concurrent target.',
      styleId: 'highlight-yellow',
    });
    const firstBranch = {
      ...created,
      mark: { kind: 'highlight' as const, styleId: 'highlight-mint' },
      revision: 2,
      updatedAt: '2026-07-14T09:00:00.000Z',
    };
    const staleBranch = {
      ...created,
      mark: { kind: 'highlight' as const, styleId: 'highlight-sky' },
      revision: 2,
      updatedAt: '2026-07-14T09:00:01.000Z',
    };

    const results = await Promise.allSettled([
      repository.updateAnnotation(firstBranch),
      repository.updateAnnotation(staleBranch),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    await expect(repository.readAnnotation('Concurrent.md', created.id)).resolves.toEqual(
      firstBranch,
    );
    expect(store.maximumConcurrentWrites(`${created.id}.json`)).toBe(1);
  });

  it('groups bounced files by record ID and selects the highest visible revision', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const created = await createFixture(repository, 'Bounced.md');
    const newer = {
      ...created,
      mark: { kind: 'highlight' as const, styleId: 'highlight-mint' },
      revision: 2,
      updatedAt: '2026-07-14T10:00:00.000Z',
    };
    await store.addAnnotationArtifact(
      `${created.id} (conflicted copy).json`,
      encodeTextAnnotationRecord(newer),
    );

    const loaded = await repository.listAnnotations('Bounced.md');

    expect(loaded.records).toEqual([newer]);
    expect(loaded.conflicts).toMatchObject([
      {
        annotationId: created.id,
        kind: 'duplicate-artifact',
      },
    ]);
    expect(loaded.conflicts[0]?.candidates).toHaveLength(2);
  });

  it('preserves every candidate when the same revision has divergent content', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const created = await createFixture(repository, 'Diverged.md');
    for (const [suffix, body] of [
      ['Mac', 'Edited on Mac'],
      ['iPad', 'Edited on iPad'],
    ] as const) {
      await store.addAnnotationArtifact(
        `${created.id} ${suffix}.json`,
        encodeTextAnnotationRecord({
          ...created,
          body,
          revision: 2,
          updatedAt: '2026-07-14T10:00:00.000Z',
        }),
      );
    }

    const loaded = await repository.listAnnotations('Diverged.md');

    expect(loaded.conflicts[0]?.kind).toBe('same-revision-divergence');
    expect(
      loaded.conflicts[0]?.candidates
        .filter((candidate) => candidate.record.revision === 2)
        .map((candidate) => candidate.record.body)
        .sort(),
    ).toEqual(['Edited on Mac', 'Edited on iPad']);
    expect(loaded.issues[0]?.message).toContain('divergent candidates');
  });

  it('resolves only the explicitly selected conflict candidate into a higher canonical revision', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const created = await createFixture(repository, 'Repair Conflict.md');
    for (const [suffix, body, deviceId] of [
      ['Mac', 'Edited on Mac', 'mac-device'],
      ['iPad', 'Edited on iPad', 'ipad-device'],
    ] as const) {
      await store.addAnnotationArtifact(
        `${created.id} ${suffix}.json`,
        encodeTextAnnotationRecord({
          ...created,
          body,
          deviceId,
          revision: 2,
          updatedAt: '2026-07-14T10:00:00.000Z',
        }),
      );
    }
    const conflict = (await repository.listAnnotations('Repair Conflict.md')).conflicts[0];
    const chosen = conflict?.candidates.find(
      (candidate) => candidate.record.body === 'Edited on iPad',
    );
    if (conflict === undefined || chosen === undefined)
      throw new Error('Missing conflict fixture.');

    const resolved = await repository.resolveConflict({
      candidate: chosen,
      deviceId: 'repair-device',
      expectedHighestRevision: 2,
      filePath: 'Repair Conflict.md',
      now: '2026-07-14T10:05:00.000Z',
    });

    expect(resolved).toMatchObject({
      body: 'Edited on iPad',
      deviceId: 'repair-device',
      id: created.id,
      revision: 3,
      updatedAt: '2026-07-14T10:05:00.000Z',
    });
    const after = await repository.listAnnotations('Repair Conflict.md');
    expect(after.records).toEqual([resolved]);
    expect(after.conflicts[0]).toMatchObject({ kind: 'duplicate-artifact' });
    expect(after.conflicts[0]?.candidates).toHaveLength(3);
    const retainedBodies = after.conflicts[0]?.candidates.map((candidate) => candidate.record.body);
    expect(retainedBodies).toContain('Edited on Mac');
    expect(retainedBodies?.filter((body) => body === 'Edited on iPad')).toHaveLength(2);

    await expect(
      repository.resolveConflict({
        candidate: chosen,
        deviceId: 'repair-device',
        expectedHighestRevision: 2,
        filePath: 'Repair Conflict.md',
        now: '2026-07-14T10:06:00.000Z',
      }),
    ).rejects.toThrow(/changed since review/u);
  });

  it('selects a newer tombstone over a delayed active artifact', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const created = await createFixture(repository, 'Deletion.md');
    const tombstone = tombstoneAnnotation(created, '2026-07-14T10:00:00.000Z');
    await repository.updateAnnotation(tombstone);
    await store.addAnnotationArtifact(
      `${created.id} delayed.json`,
      encodeTextAnnotationRecord(created),
    );

    const loaded = await repository.listAnnotations('Deletion.md');

    expect(loaded.records).toEqual([tombstone]);
    expect(loaded.conflicts[0]?.kind).toBe('duplicate-artifact');
  });

  it('re-reads bounced candidates before update and rejects a stale visible revision', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const created = await createFixture(repository, 'Preflight.md');
    const visibleNewer = {
      ...created,
      mark: { kind: 'highlight' as const, styleId: 'highlight-mint' },
      revision: 2,
      updatedAt: '2026-07-14T10:00:00.000Z',
    };
    await store.addAnnotationArtifact(
      `${created.id} iCloud.json`,
      encodeTextAnnotationRecord(visibleNewer),
    );

    await expect(
      repository.updateAnnotation({
        ...created,
        mark: { kind: 'highlight', styleId: 'highlight-sky' },
        revision: 2,
        updatedAt: '2026-07-14T10:01:00.000Z',
      }),
    ).rejects.toThrow(/increase revision/u);
    await expect(repository.readAnnotation('Preflight.md', created.id)).resolves.toEqual(
      visibleNewer,
    );
  });

  it('rekeys a uniquely fingerprinted note after an offline rename', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const created = await createFixture(repository, '旧目录/中文笔记.md');

    const reconciled = await repository.reconcileNote({
      filePath: '新目录/中文笔记.md',
      now: '2026-07-14T11:00:00.000Z',
      sourceFingerprint: created.target.sourceRevision ?? '',
    });

    expect(reconciled).toMatchObject({
      filePath: '新目录/中文笔记.md',
      noteId: created.noteId,
      sourceFingerprint: created.target.sourceRevision,
    });
    await expect(repository.readAnnotation('新目录/中文笔记.md', created.id)).resolves.toEqual({
      ...created,
      filePath: '新目录/中文笔记.md',
      revision: 2,
      updatedAt: '2026-07-14T11:00:00.000Z',
    });
    await expect(repository.readAnnotation('旧目录/中文笔记.md', created.id)).resolves.toBeNull();
  });

  it('rebuilds a disposable summary entirely from canonical record files', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const created = await createFixture(repository, 'Summary.md');

    const first = await repository.rebuildSummary('Summary.md', '2026-07-14T12:00:00.000Z');
    store.removeBySuffix('/summary.json');
    const rebuilt = await repository.rebuildSummary('Summary.md', '2026-07-14T12:00:00.000Z');

    expect(rebuilt).toEqual(first);
    expect(rebuilt.records).toEqual([
      {
        id: created.id,
        revision: 1,
        status: 'active',
        updatedAt: created.updatedAt,
      },
    ]);
    expect(store.readBySuffix('/summary.json')).toContain('"derived": true');
  });

  it('restores the last valid canonical bytes when an update write fails partway', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const created = await createFixture(repository, 'Interrupted.md');
    store.corruptAndFailNextAnnotationWrite();

    await expect(
      repository.updateAnnotation({
        ...created,
        revision: 2,
        updatedAt: '2026-07-14T13:00:00.000Z',
      }),
    ).rejects.toThrow('Injected partial write');
    await expect(repository.readAnnotation('Interrupted.md', created.id)).resolves.toEqual(created);
  });

  it('merges different UUID records created by independent repository actors', async () => {
    const store = new MemoryTextFileStore();
    const firstIds = ['note-shared', 'annotation-mac'];
    const mac = new AnnotationService({
      createId: () => firstIds.shift() ?? 'unexpected-mac-id',
      deviceId: 'mac',
      repository: new SidecarRepository(store),
    });
    const ipad = new AnnotationService({
      createId: () => 'annotation-ipad',
      deviceId: 'ipad',
      repository: new SidecarRepository(store),
    });
    const source = 'Mac target and iPad target.';
    await mac.createHighlight({
      filePath: 'Two Actors.md',
      selection: { end: 10, scope: {}, start: 0 },
      source,
      styleId: 'highlight-sun',
    });
    await ipad.createHighlight({
      filePath: 'Two Actors.md',
      selection: { end: 26, scope: {}, start: 15 },
      source,
      styleId: 'highlight-mint',
    });

    const loaded = await new SidecarRepository(store).listAnnotations('Two Actors.md');
    expect(loaded.records.map((record) => [record.id, record.deviceId])).toEqual([
      ['annotation-ipad', 'ipad'],
      ['annotation-mac', 'mac'],
    ]);
    expect(loaded.conflicts).toEqual([]);
  });

  it('marks a deleted Markdown source missing without deleting annotations and clears it on restore', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const created = await createFixture(repository, 'Recoverable.md');

    const missing = await repository.markNoteSourceMissing(
      'Recoverable.md',
      '2026-07-14T14:00:00.000Z',
    );
    expect(missing).toMatchObject({
      noteId: created.noteId,
      sourceMissingAt: '2026-07-14T14:00:00.000Z',
    });
    await expect(repository.readAnnotation('Recoverable.md', created.id)).resolves.toEqual(created);

    const restored = await repository.reconcileNote({
      filePath: 'Recoverable.md',
      now: '2026-07-14T14:05:00.000Z',
      sourceFingerprint: created.target.sourceRevision ?? '',
    });
    expect(restored).not.toHaveProperty('sourceMissingAt');
    expect(restored).toMatchObject({ noteId: created.noteId });
  });

  it('discovers every canonical note meta in stable path order', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    await repository.getOrCreateNote({
      createId: () => 'note-zeta',
      filePath: 'Zeta.md',
      now: '2026-07-14T08:00:00.000Z',
      sourceFingerprint: 'fingerprint-zeta',
    });
    await repository.getOrCreateNote({
      createId: () => 'note-alpha',
      filePath: '研究/Alpha.md',
      now: '2026-07-14T08:00:00.000Z',
      sourceFingerprint: 'fingerprint-alpha',
    });

    const discovered = await repository.listNotes();

    expect(discovered.issues).toEqual([]);
    expect(discovered.notes.map((note) => note.filePath)).toEqual(['Zeta.md', '研究/Alpha.md']);
  });

  it('emits canonical record changes only after successful writes', async () => {
    const store = new MemoryTextFileStore();
    const changes: string[] = [];
    const repository = new SidecarRepository(store, {
      onRecordChanged: (record) => changes.push(`${record.id}:${record.revision}`),
    });
    const created = await createFixture(repository, 'Events.md');
    await repository.updateAnnotation({
      ...created,
      revision: 2,
      updatedAt: '2026-07-14T16:00:00.000Z',
    });

    expect(changes).toEqual([`${created.id}:1`, `${created.id}:2`]);
  });
});

async function createFixture(
  repository: SidecarRepository,
  filePath: string,
): Promise<Awaited<ReturnType<AnnotationService['createHighlight']>>> {
  const ids = ['note-1', 'annotation-1'];
  const service = new AnnotationService({
    createId: () => ids.shift() ?? 'unexpected-id',
    repository,
  });
  return service.createHighlight({
    filePath,
    selection: { end: 10, scope: {}, start: 0 },
    source: 'Annotation target.',
    styleId: 'highlight-yellow',
  });
}

class MemoryTextFileStore implements TextFileStore {
  private readonly files = new Map<string, string>();
  private readonly activeWrites = new Map<string, number>();
  private readonly maximumWrites = new Map<string, number>();
  private failNextAnnotationWrite = false;

  constructor(private readonly writeDelayMs = 0) {}

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

  async write(path: string, contents: string): Promise<void> {
    const active = (this.activeWrites.get(path) ?? 0) + 1;
    this.activeWrites.set(path, active);
    this.maximumWrites.set(path, Math.max(active, this.maximumWrites.get(path) ?? 0));
    if (this.writeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
    }
    if (this.failNextAnnotationWrite && path.includes('/annotations/')) {
      this.failNextAnnotationWrite = false;
      this.files.set(path, '{');
      this.activeWrites.set(path, active - 1);
      throw new Error('Injected partial write');
    }
    this.files.set(path, contents);
    this.activeWrites.set(path, active - 1);
  }

  rename(from: string, to: string): Promise<void> {
    for (const [path, contents] of [...this.files.entries()]) {
      if (path !== from && !path.startsWith(`${from}/`)) {
        continue;
      }
      this.files.delete(path);
      this.files.set(`${to}${path.slice(from.length)}`, contents);
    }
    return Promise.resolve();
  }

  maximumConcurrentWrites(pathSuffix: string): number {
    return Math.max(
      0,
      ...[...this.maximumWrites.entries()]
        .filter(([path]) => path.endsWith(pathSuffix))
        .map(([, maximum]) => maximum),
    );
  }

  addAnnotationArtifact(filename: string, contents: string): Promise<void> {
    const healthy = [...this.files.keys()].find((path) => path.includes('/annotations/'));
    if (healthy === undefined) {
      throw new Error('Fixture has no annotation record.');
    }
    this.files.set(`${healthy.slice(0, healthy.lastIndexOf('/'))}/${filename}`, contents);
    return Promise.resolve();
  }

  removeBySuffix(pathSuffix: string): void {
    for (const path of this.files.keys()) {
      if (path.endsWith(pathSuffix)) {
        this.files.delete(path);
      }
    }
  }

  readBySuffix(pathSuffix: string): string | null {
    return [...this.files.entries()].find(([path]) => path.endsWith(pathSuffix))?.[1] ?? null;
  }

  corruptAndFailNextAnnotationWrite(): void {
    this.failNextAnnotationWrite = true;
  }

  addCorruptSibling(): Promise<void> {
    const healthy = [...this.files.keys()].find((path) => path.includes('/annotations/'));
    if (healthy === undefined) {
      throw new Error('Fixture has no annotation record.');
    }
    this.files.set(`${healthy.slice(0, healthy.lastIndexOf('/'))}/annotation-corrupt.json`, '{');
    return Promise.resolve();
  }
}
