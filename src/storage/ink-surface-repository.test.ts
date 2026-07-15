import { describe, expect, it } from 'vitest';

import { encodeInkSurfaceRecord, type InkSurfaceRecord } from '../domain/ink-surface';
import { SidecarRepository, type TextFileStore } from './sidecar-repository';
import { InkSurfaceConflictError, InkSurfaceRepository } from './ink-surface-repository';

describe('ink surface repository contract', () => {
  it('creates, reads and updates one canonical surface file under the note identity', async () => {
    const { repository, surface, store } = await createFixture();

    await repository.writeSurface(surface);
    await expect(repository.readSurface(surface.filePath, surface.id)).resolves.toEqual(surface);

    const updated = revision(surface, 2, [stroke('stroke-1')]);
    await repository.updateSurface(updated);

    await expect(
      new InkSurfaceRepository(store).readSurface(surface.filePath, surface.id),
    ).resolves.toEqual(updated);
    expect(store.readBySuffix(`/surfaces/${surface.id}.json`)).toContain('"stroke-1"');
  });

  it('serializes writes per surface and rejects a concurrent stale branch', async () => {
    const { repository, surface, store } = await createFixture(10);
    await repository.writeSurface(surface);

    const results = await Promise.allSettled([
      repository.updateSurface(revision(surface, 2, [stroke('first')])),
      repository.updateSurface(revision(surface, 2, [stroke('stale')])),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(store.maximumConcurrentWrites(`${surface.id}.json`)).toBe(1);
    await expect(repository.readSurface(surface.filePath, surface.id)).resolves.toMatchObject({
      revision: 2,
      strokes: [{ id: 'first' }],
    });
  });

  it('re-reads bounced candidates before update and rejects a stale visible revision', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    const visibleNewer = revision(surface, 3, [stroke('icloud-newer')]);
    store.addSurfaceArtifact(
      `${surface.id} (conflicted copy).json`,
      encodeInkSurfaceRecord(visibleNewer),
    );

    await expect(
      repository.updateSurface(revision(surface, 2, [stroke('local-stale')])),
    ).rejects.toThrow(/increase revision/u);
    await expect(repository.readSurface(surface.filePath, surface.id)).resolves.toEqual(
      visibleNewer,
    );
  });

  it('preserves and reports all same-revision divergent candidates', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    store.addSurfaceArtifact(
      `${surface.id} Mac.json`,
      encodeInkSurfaceRecord(revision(surface, 2, [stroke('mac')])),
    );
    store.addSurfaceArtifact(
      `${surface.id} iPad.json`,
      encodeInkSurfaceRecord(revision(surface, 2, [stroke('ipad')])),
    );

    const loaded = await repository.listSurfaces(surface.filePath);

    expect(loaded.conflicts).toMatchObject([
      { kind: 'same-revision-divergence', surfaceId: surface.id },
    ]);
    expect(loaded.conflicts[0]?.candidates).toHaveLength(3);
    await expect(repository.readSurface(surface.filePath, surface.id)).rejects.toBeInstanceOf(
      InkSurfaceConflictError,
    );
  });

  it('resolves an explicitly reviewed Ink candidate to a higher canonical revision', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    store.addSurfaceArtifact(
      `${surface.id} Mac.json`,
      encodeInkSurfaceRecord(revision(surface, 2, [stroke('mac')])),
    );
    store.addSurfaceArtifact(
      `${surface.id} iPad.json`,
      encodeInkSurfaceRecord(revision(surface, 2, [stroke('ipad')])),
    );
    const conflict = (await repository.listSurfaces(surface.filePath)).conflicts[0];
    const chosen = conflict?.candidates.find(
      (candidate) => candidate.record.strokes[0]?.id === 'ipad',
    );
    if (chosen === undefined) throw new Error('Missing reviewed Ink candidate.');

    const resolved = await repository.resolveConflict({
      candidate: chosen,
      deviceId: 'repair-device',
      expectedHighestRevision: 2,
      filePath: surface.filePath,
      now: '2026-07-14T10:05:00.000Z',
    });

    expect(resolved).toMatchObject({
      deviceId: 'repair-device',
      revision: 3,
      strokes: [{ id: 'ipad' }],
      updatedAt: '2026-07-14T10:05:00.000Z',
    });
    const after = await repository.listSurfaces(surface.filePath);
    expect(after.records).toEqual([resolved]);
    expect(after.conflicts).toMatchObject([{ kind: 'duplicate-artifact' }]);
    await expect(
      repository.resolveConflict({
        candidate: chosen,
        expectedHighestRevision: 2,
        filePath: surface.filePath,
        now: '2026-07-14T10:06:00.000Z',
      }),
    ).rejects.toThrow(/changed since review/u);
  });

  it('selects a newer tombstone over a delayed active artifact', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    const tombstone = {
      ...revision(surface, 2, []),
      deletedAt: '2026-07-14T10:10:00.000Z',
    };
    await repository.updateSurface(tombstone);
    store.addSurfaceArtifact(`${surface.id} delayed.json`, encodeInkSurfaceRecord(surface));

    const loaded = await repository.listSurfaces(surface.filePath);

    expect(loaded.records).toEqual([tombstone]);
    expect(loaded.conflicts[0]?.kind).toBe('duplicate-artifact');
  });

  it('restores the last canonical bytes when a write fails and emits changes only after success', async () => {
    const store = new MemoryTextFileStore();
    const textRepository = new SidecarRepository(store);
    await textRepository.getOrCreateNote({
      createId: () => 'note-1',
      filePath: 'Ink.md',
      now: '2026-07-14T08:00:00.000Z',
      sourceFingerprint: 'source-revision',
    });
    const changes: string[] = [];
    const repository = new InkSurfaceRepository(store, {
      onSurfaceChanged: (record) => changes.push(`${record.id}:${record.revision}`),
    });
    const surface = surfaceFixture();
    await repository.writeSurface(surface);
    store.corruptAndFailNextSurfaceWrite();

    await expect(repository.updateSurface(revision(surface, 2, [stroke('lost')]))).rejects.toThrow(
      'Injected partial write',
    );

    await expect(repository.readSurface(surface.filePath, surface.id)).resolves.toEqual(surface);
    expect(changes).toEqual([`${surface.id}:1`]);
  });

  it('isolates a corrupt sibling and rejects a surface whose note identity does not match meta', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    store.addSurfaceArtifact('corrupt.json', '{');

    const loaded = await repository.listSurfaces(surface.filePath);

    expect(loaded.records).toEqual([surface]);
    expect(loaded.issues).toMatchObject([{ kind: 'corrupt-record' }]);
    await expect(
      repository.writeSurface({ ...surface, id: 'surface-other', noteId: 'wrong-note' }),
    ).rejects.toThrow(/note identity/u);
  });

  it('maintains compact thumbnail summaries without loading canonical point arrays on the hot path', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface({
      ...surface,
      binding: {
        blockFingerprints: ['block-1'],
        headingPath: ['Intro'],
        sectionFingerprint: 'intro-v1',
        sourceEnd: 200,
        sourceStart: 100,
      },
      strokes: [stroke('thumbnail-stroke')],
    });
    store.resetReadCounts();

    const summaries = await new InkSurfaceRepository(store).listSurfaceSummaries(surface.filePath);

    expect(summaries).toMatchObject([
      {
        headingPath: ['Intro'],
        id: surface.id,
        position: 100,
        status: 'active',
        strokeCount: 1,
      },
    ]);
    expect(summaries[0]?.thumbnailSvg).toContain('<svg');
    expect(summaries[0]?.thumbnailSvg).not.toContain('points');
    expect(store.readCountBySuffix(`/surfaces/${surface.id}.json`)).toBe(0);
  });

  it('rebuilds a stale derived summary after an external canonical sidecar change', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    const externallyUpdated = revision(surface, 2, [stroke('from-other-device')]);
    store.replaceBySuffix(
      `/surfaces/${surface.id}.json`,
      encodeInkSurfaceRecord(externallyUpdated),
    );
    const canonicalPath = store.pathBySuffix(`/surfaces/${surface.id}.json`);
    if (canonicalPath === null) throw new Error('Missing canonical surface fixture path.');

    await expect(repository.rebuildSummariesForSidecarPath(canonicalPath)).resolves.toBe('Ink.md');

    await expect(repository.listSurfaceSummaries(surface.filePath)).resolves.toMatchObject([
      { id: surface.id, revision: 2, strokeCount: 1 },
    ]);
  });

  it('tombstones and restores a whole surface with monotonic revisions and retained vectors', async () => {
    const { repository, surface } = await createFixture();
    const withInk = { ...surface, strokes: [stroke('keep-me')] };
    await repository.writeSurface(withInk);

    const deleted = await repository.tombstoneSurface(
      surface.filePath,
      surface.id,
      '2026-07-14T12:00:00.000Z',
      'desktop-device',
    );
    expect(deleted).toMatchObject({
      deletedAt: '2026-07-14T12:00:00.000Z',
      deviceId: 'desktop-device',
      revision: 2,
      strokes: [{ id: 'keep-me' }],
    });

    const restored = await repository.restoreSurface(
      surface.filePath,
      surface.id,
      '2026-07-14T12:01:00.000Z',
      'desktop-device',
    );
    expect(restored).toMatchObject({ revision: 3, strokes: [{ id: 'keep-me' }] });
    expect(restored.deletedAt).toBeUndefined();
  });
});

async function createFixture(writeDelayMs = 0): Promise<{
  repository: InkSurfaceRepository;
  store: MemoryTextFileStore;
  surface: InkSurfaceRecord;
}> {
  const store = new MemoryTextFileStore(writeDelayMs);
  await new SidecarRepository(store).getOrCreateNote({
    createId: () => 'note-1',
    filePath: 'Ink.md',
    now: '2026-07-14T08:00:00.000Z',
    sourceFingerprint: 'source-revision',
  });
  return { repository: new InkSurfaceRepository(store), store, surface: surfaceFixture() };
}

function surfaceFixture(): InkSurfaceRecord {
  return {
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Ink.md',
    id: 'surface-1',
    layout: {
      blockFingerprints: ['block-1'],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1200,
      logicalWidth: 960,
      sourceRevision: 'source-revision',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: [],
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}

function revision(
  surface: InkSurfaceRecord,
  nextRevision: number,
  strokes: InkSurfaceRecord['strokes'],
): InkSurfaceRecord {
  return {
    ...surface,
    revision: nextRevision,
    strokes,
    updatedAt: `2026-07-14T08:0${nextRevision}:00.000Z`,
  };
}

function stroke(id: string): InkSurfaceRecord['strokes'][number] {
  return {
    color: '#111111',
    id,
    points: [
      { pressure: 0.5, time: 0, x: 10, y: 10 },
      { pressure: 0.5, time: 16, x: 20, y: 20 },
    ],
    tool: 'pen',
    width: 2,
  };
}

class MemoryTextFileStore implements TextFileStore {
  private readonly files = new Map<string, string>();
  private readonly activeWrites = new Map<string, number>();
  private readonly maximumWrites = new Map<string, number>();
  private failNextSurfaceWrite = false;
  private readonly readCounts = new Map<string, number>();

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
    this.readCounts.set(path, (this.readCounts.get(path) ?? 0) + 1);
    return Promise.resolve(this.files.get(path) ?? null);
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  async write(path: string, contents: string): Promise<void> {
    const active = (this.activeWrites.get(path) ?? 0) + 1;
    this.activeWrites.set(path, active);
    this.maximumWrites.set(path, Math.max(active, this.maximumWrites.get(path) ?? 0));
    if (this.writeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
    }
    if (this.failNextSurfaceWrite && path.includes('/surfaces/')) {
      this.failNextSurfaceWrite = false;
      this.files.set(path, '{');
      this.activeWrites.set(path, active - 1);
      throw new Error('Injected partial write');
    }
    this.files.set(path, contents);
    this.activeWrites.set(path, active - 1);
  }

  readBySuffix(suffix: string): string | null {
    return [...this.files.entries()].find(([path]) => path.endsWith(suffix))?.[1] ?? null;
  }

  readCountBySuffix(suffix: string): number {
    return [...this.readCounts.entries()]
      .filter(([path]) => path.endsWith(suffix))
      .reduce((total, [, count]) => total + count, 0);
  }

  resetReadCounts(): void {
    this.readCounts.clear();
  }

  addSurfaceArtifact(filename: string, contents: string): void {
    const healthy = [...this.files.keys()].find((path) => path.includes('/surfaces/'));
    if (healthy === undefined) {
      throw new Error('Fixture has no surface record.');
    }
    this.files.set(`${healthy.slice(0, healthy.lastIndexOf('/'))}/${filename}`, contents);
  }

  pathBySuffix(suffix: string): string | null {
    return [...this.files.keys()].find((path) => path.endsWith(suffix)) ?? null;
  }

  replaceBySuffix(suffix: string, contents: string): void {
    const path = this.pathBySuffix(suffix);
    if (path === null) throw new Error(`Fixture has no file ending in ${suffix}.`);
    this.files.set(path, contents);
  }

  maximumConcurrentWrites(suffix: string): number {
    return Math.max(
      0,
      ...[...this.maximumWrites.entries()]
        .filter(([path]) => path.endsWith(suffix))
        .map(([, maximum]) => maximum),
    );
  }

  corruptAndFailNextSurfaceWrite(): void {
    this.failNextSurfaceWrite = true;
  }
}
