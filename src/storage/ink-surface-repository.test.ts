import { describe, expect, it } from 'vitest';

import { encodeInkSurfaceRecord, type InkSurfaceRecord } from '../domain/ink-surface';
import { normalizeVaultPath, SidecarRepository, type TextFileStore } from './sidecar-repository';
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

  it('rejects a single-surface revision leapfrog', async () => {
    const { repository, surface } = await createFixture();
    await repository.writeSurface(surface);

    await expect(
      repository.updateSurface(revision(surface, 3, [stroke('leapfrog')])),
    ).rejects.toThrow(/exactly one revision/u);
    await expect(repository.readSurface(surface.filePath, surface.id)).resolves.toEqual(surface);
  });

  it('treats an identical single-surface retry as idempotent', async () => {
    const { repository, surface } = await createFixture();
    await repository.writeSurface(surface);
    const next = revision(surface, 2, [stroke('once')]);
    await repository.updateSurface(next);

    await expect(repository.updateSurface(next)).resolves.toBeUndefined();
    await expect(repository.readSurface(surface.filePath, surface.id)).resolves.toEqual(next);
  });

  it('does not report a canonical write as failed when a projection event throws', async () => {
    const { store, surface } = await createFixture();
    const changed: InkSurfaceRecord[] = [];
    const issues: unknown[] = [];
    let failNextEvent = false;
    const repository = new InkSurfaceRepository(store, {
      onEventIssue: (error) => issues.push(error),
      onSurfaceChanged: (record) => {
        changed.push(record);
        if (failNextEvent) {
          failNextEvent = false;
          throw new Error('subscriber unavailable');
        }
      },
    });
    await repository.writeSurface(surface);
    const next = revision(surface, 2, [stroke('landed')]);
    failNextEvent = true;

    await expect(repository.updateSurface(next, surface)).resolves.toBeUndefined();
    await expect(repository.updateSurface(next, surface)).resolves.toBeUndefined();

    expect(changed).toEqual([surface, next, next]);
    expect(issues).toEqual([expect.objectContaining({ message: 'subscriber unavailable' })]);
    await expect(repository.readSurface(surface.filePath, surface.id)).resolves.toEqual(next);
  });

  it('advances a single surface only from the exact expected base record', async () => {
    const { repository, surface } = await createFixture();
    await repository.writeSurface(surface);
    const second = revision(surface, 2, [stroke('second')]);
    await repository.updateSurface(second, surface);
    const third = revision(second, 3, [stroke('third')]);
    const divergentBase = revision(surface, 2, [stroke('divergent-base')]);

    await expect(repository.updateSurface(third, divergentBase)).rejects.toThrow(/expected base/u);
    await expect(repository.updateSurface(third, second)).resolves.toBeUndefined();
    await expect(repository.readSurface(surface.filePath, surface.id)).resolves.toEqual(third);
  });

  it('serializes canonical revisions across repository instances that share one vault', async () => {
    const { repository: oldRepository, surface, store } = await createFixture();
    await oldRepository.writeSurface(surface);
    const newRepository = new InkSurfaceRepository(new StoreWrapper(store));
    const heldWrite = store.holdNextSurfaceWrite();

    const oldRevision = oldRepository.updateSurface(revision(surface, 2, [stroke('old-owner')]));
    await heldWrite.entered;
    const newRevision = newRepository.updateSurface(revision(surface, 3, [stroke('new-owner')]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    heldWrite.release();

    await Promise.all([oldRevision, newRevision]);
    await expect(newRepository.readSurface(surface.filePath, surface.id)).resolves.toMatchObject({
      revision: 3,
      strokes: [{ id: 'new-owner' }],
    });
    expect(store.maximumConcurrentWrites(`${surface.id}.json`)).toBe(1);
  });

  it('keeps internal queue namespaces distinct from legal surface IDs', async () => {
    const { repository, surface } = await createFixture();
    const reservedLooking = { ...surface, id: 'surface-batch' };

    await expect(
      Promise.race([
        repository.writeSurface(reservedLooking),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('surface write deadlocked')), 50),
        ),
      ]),
    ).resolves.toBeUndefined();
  });

  it('serializes a single-surface update against an overlapping atomic batch', async () => {
    const { repository, surface } = await createFixture(10);
    const second = { ...surface, id: 'surface-2' };
    await repository.writeSurface(surface);
    await repository.writeSurface(second);

    const results = await Promise.allSettled([
      repository.updateSurface(revision(surface, 2, [stroke('single-winner')])),
      repository.updateSurfacesAtomically([
        revision(surface, 2, [stroke('batch-winner')]),
        revision(second, 2, [stroke('batch-second')]),
      ]),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const loaded = await repository.listSurfaces(surface.filePath);
    expect(loaded.records.find((record) => record.id === surface.id)?.revision).toBe(2);
  });

  it('keeps listSurfaces on one all-old or all-new canonical snapshot', async () => {
    const { repository, surface, store } = await createFixture();
    const second = { ...surface, id: 'surface-2' };
    await repository.writeSurface(surface);
    await repository.writeSurface(second);
    const heldList = store.holdNextSurfaceList();
    const read = repository.listSurfaces(surface.filePath);
    await heldList.entered;
    const heldSecondWrite = store.holdNthNextSurfaceWrite(2);
    const write = repository.updateSurfacesAtomically([
      revision(surface, 2, [stroke('next-a')]),
      revision(second, 2, [stroke('next-b')]),
    ]);
    const writerEnteredBeforeRead = await Promise.race([
      heldSecondWrite.entered.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 10)),
    ]);

    heldList.release();
    const snapshot = await read;
    if (!writerEnteredBeforeRead) await heldSecondWrite.entered;
    heldSecondWrite.release();
    await write;

    expect(snapshot.records).toEqual([surface, second]);
  });

  it('keeps readSurface inside the canonical note read lock', async () => {
    const { repository, surface, store } = await createFixture();
    const second = { ...surface, id: 'surface-2' };
    await repository.writeSurface(surface);
    await repository.writeSurface(second);
    const heldList = store.holdNextSurfaceList();
    const read = repository.readSurface(surface.filePath, surface.id);
    await heldList.entered;
    const heldSecondWrite = store.holdNthNextSurfaceWrite(2);
    const write = repository.updateSurfacesAtomically([
      revision(surface, 2, [stroke('next-a')]),
      revision(second, 2, [stroke('next-b')]),
    ]);
    const writerEnteredBeforeRead = await Promise.race([
      heldSecondWrite.entered.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 10)),
    ]);

    heldList.release();
    const snapshot = await read;
    if (!writerEnteredBeforeRead) await heldSecondWrite.entered;
    heldSecondWrite.release();
    await write;

    expect(snapshot).toEqual(surface);
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
    ).rejects.toThrow(/advance exactly one revision/u);
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

  it('retains empty v2 chunks because they define the continuous canvas extent', async () => {
    const { repository, surface } = await createFixture();
    const structural: InkSurfaceRecord = {
      ...surface,
      layout: { ...surface.layout, originY: 0 },
      schemaVersion: 2,
    };
    await repository.writeSurface(structural);

    await expect(
      repository.reclaimEmptySurfaces(structural.filePath, '2026-07-15T12:00:00.000Z', 'device-a'),
    ).resolves.toEqual([]);
    await expect(repository.readSurface(structural.filePath, structural.id)).resolves.toEqual(
      structural,
    );
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

  it('rolls back every canonical surface when one atomic batch write fails', async () => {
    const { repository, surface, store } = await createFixture();
    const second = { ...surface, id: 'surface-2' };
    await repository.writeSurface(surface);
    await repository.writeSurface(second);
    store.failNthNextSurfaceWrite(2);

    await expect(
      repository.updateSurfacesAtomically([
        revision(surface, 2, [stroke('moved-a')]),
        revision(second, 2, [stroke('moved-b')]),
      ]),
    ).rejects.toThrow('Injected partial write');

    await expect(repository.readSurface(surface.filePath, surface.id)).resolves.toEqual(surface);
    await expect(repository.readSurface(second.filePath, second.id)).resolves.toEqual(second);
  });

  it('rejects an atomic batch that leapfrogs canonical revisions', async () => {
    const { repository, surface } = await createFixture();
    const second = { ...surface, id: 'surface-2' };
    await repository.writeSurface(surface);
    await repository.writeSurface(second);

    await expect(
      repository.updateSurfacesAtomically([
        revision(surface, 3, [stroke('leapfrog-a')]),
        revision(second, 3, [stroke('leapfrog-b')]),
      ]),
    ).rejects.toThrow(/exactly one revision/u);
    await expect(repository.listSurfaces(surface.filePath)).resolves.toMatchObject({
      records: [surface, second],
    });
  });

  it('treats an entirely identical atomic retry as idempotent', async () => {
    const { repository, surface } = await createFixture();
    const second = { ...surface, id: 'surface-2' };
    await repository.writeSurface(surface);
    await repository.writeSurface(second);
    const next = [
      revision(surface, 2, [stroke('next-a')]),
      revision(second, 2, [stroke('next-b')]),
    ] as const;
    await repository.updateSurfacesAtomically(next);

    await expect(repository.updateSurfacesAtomically(next)).resolves.toBeUndefined();
    await expect(repository.listSurfaces(surface.filePath)).resolves.toMatchObject({
      records: next,
    });
  });

  it('aligns atomic expected bases by ID and advances only from exact records', async () => {
    const { repository, surface } = await createFixture();
    const secondSurface = { ...surface, id: 'surface-2' };
    await repository.writeSurface(surface);
    await repository.writeSurface(secondSurface);
    const next = [
      revision(surface, 2, [stroke('next-a')]),
      revision(secondSurface, 2, [stroke('next-b')]),
    ] as const;
    await repository.updateSurfacesAtomically(next, [secondSurface, surface]);
    const third = [
      revision(next[0], 3, [stroke('third-a')]),
      revision(next[1], 3, [stroke('third-b')]),
    ] as const;
    const divergentBase = revision(surface, 2, [stroke('divergent-base')]);

    await expect(
      repository.updateSurfacesAtomically(third, [next[1], divergentBase]),
    ).rejects.toThrow(/expected base/u);
    await expect(
      repository.updateSurfacesAtomically(third, [next[1], next[0]]),
    ).resolves.toBeUndefined();
    await expect(repository.listSurfaces(surface.filePath)).resolves.toMatchObject({
      records: third,
    });
  });

  it('rejects a mixed idempotent and advancing atomic retry without partial writes', async () => {
    const { repository, surface } = await createFixture();
    const secondSurface = { ...surface, id: 'surface-2' };
    await repository.writeSurface(surface);
    await repository.writeSurface(secondSurface);
    const next = [
      revision(surface, 2, [stroke('next-a')]),
      revision(secondSurface, 2, [stroke('next-b')]),
    ] as const;
    await repository.updateSurfacesAtomically(next);

    await expect(
      repository.updateSurfacesAtomically([
        next[0],
        revision(next[1], 3, [stroke('partial-third')]),
      ]),
    ).rejects.toThrow(/cannot mix idempotent and advancing/u);
    await expect(repository.listSurfaces(surface.filePath)).resolves.toMatchObject({
      records: next,
    });
  });

  it('rejects atomic expected bases whose IDs do not align exactly', async () => {
    const { repository, surface } = await createFixture();
    const secondSurface = { ...surface, id: 'surface-2' };
    await repository.writeSurface(surface);
    await repository.writeSurface(secondSurface);

    await expect(
      repository.updateSurfacesAtomically(
        [revision(surface, 2, [stroke('next-a')]), revision(secondSurface, 2, [stroke('next-b')])],
        [surface],
      ),
    ).rejects.toThrow(/align exactly by surface ID/u);
  });

  it('rolls back the old batch when journal promotion fails after canonical writes', async () => {
    const { repository, surface, store } = await createFixture();
    const second = { ...surface, id: 'surface-2' };
    await repository.writeSurface(surface);
    await repository.writeSurface(second);
    store.failNextJournalPromotion();

    await expect(
      repository.updateSurfacesAtomically([
        revision(surface, 2, [stroke('moved-a')]),
        revision(second, 2, [stroke('moved-b')]),
      ]),
    ).rejects.toThrow('Injected journal promotion failure');

    await expect(repository.readSurface(surface.filePath, surface.id)).resolves.toEqual(surface);
    await expect(repository.readSurface(second.filePath, second.id)).resolves.toEqual(second);
    expect(store.readBySuffix('/ink-batch-journal.json')).toBeNull();
  });

  it('recovers a prepared batch to all-old and a committed batch to all-new after restart', async () => {
    const { repository, surface, store } = await createFixture();
    const second = { ...surface, id: 'surface-2' };
    await repository.writeSurface(surface);
    await repository.writeSurface(second);
    const next = [
      revision(surface, 2, [stroke('moved-a')]),
      revision(second, 2, [stroke('moved-b')]),
    ];
    const firstPath = store.pathBySuffix(`/surfaces/${surface.id}.json`);
    const secondPath = store.pathBySuffix(`/surfaces/${second.id}.json`);
    if (firstPath === null || secondPath === null) throw new Error('Missing canonical paths.');
    const journalPath = `${firstPath.slice(0, firstPath.lastIndexOf('/surfaces/'))}/ink-batch-journal.json`;
    const entries = [
      {
        nextContents: encodeInkSurfaceRecord(next[0] as InkSurfaceRecord),
        path: firstPath,
        previousContents: encodeInkSurfaceRecord(surface),
      },
      {
        nextContents: encodeInkSurfaceRecord(next[1] as InkSurfaceRecord),
        path: secondPath,
        previousContents: encodeInkSurfaceRecord(second),
      },
    ];
    store.replaceBySuffix(`/surfaces/${surface.id}.json`, entries[0]?.nextContents ?? '');
    await store.write(
      journalPath,
      JSON.stringify({ entries, filePath: surface.filePath, phase: 'prepared', schemaVersion: 1 }),
    );

    await expect(
      new InkSurfaceRepository(store).listSurfaces(surface.filePath),
    ).resolves.toMatchObject({
      records: [surface, second],
    });

    await store.write(
      journalPath,
      JSON.stringify({ entries, filePath: surface.filePath, phase: 'committed', schemaVersion: 1 }),
    );
    await expect(
      new InkSurfaceRepository(store).listSurfaces(surface.filePath),
    ).resolves.toMatchObject({
      records: next,
    });
    await expect(
      new InkSurfaceRepository(store).listSurfaceSummaries(surface.filePath),
    ).resolves.toMatchObject([
      { id: surface.id, revision: 2, strokeCount: 1 },
      { id: second.id, revision: 2, strokeCount: 1 },
    ]);
  });

  it('rejects a journal path that normalizes outside the canonical surface root', async () => {
    const { surface, store } = await createFixture();
    const repository = new InkSurfaceRepository(new NormalizingStoreWrapper(store));
    await repository.writeSurface(surface);
    const surfacePath = store.pathBySuffix(`/surfaces/${surface.id}.json`);
    if (surfacePath === null) throw new Error('Missing canonical surface fixture path.');
    const surfaceRoot = surfacePath.slice(0, surfacePath.lastIndexOf('/') + 1);
    const journalPath = `${surfaceRoot.slice(0, -'/surfaces/'.length)}/ink-batch-journal.json`;
    await store.write('Victim.md', 'safe');
    await store.write(
      journalPath,
      JSON.stringify({
        entries: [
          {
            nextContents: encodeInkSurfaceRecord(revision(surface, 2, [stroke('attack')])),
            path: `${surfaceRoot}../../../../../Victim.md`,
            previousContents: encodeInkSurfaceRecord(surface),
          },
        ],
        filePath: surface.filePath,
        phase: 'committed',
        schemaVersion: 1,
      }),
    );

    await expect(repository.listSurfaces(surface.filePath)).rejects.toThrow(/journal is invalid/u);
    await expect(store.read('Victim.md')).resolves.toBe('safe');
  });

  it('rejects duplicate canonical targets in one recovery journal', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    const surfacePath = store.pathBySuffix(`/surfaces/${surface.id}.json`);
    if (surfacePath === null) throw new Error('Missing canonical surface fixture path.');
    const journalPath = `${surfacePath.slice(0, surfacePath.lastIndexOf('/surfaces/'))}/ink-batch-journal.json`;
    await store.write(
      journalPath,
      JSON.stringify({
        entries: [
          {
            nextContents: encodeInkSurfaceRecord(revision(surface, 2, [stroke('first')])),
            path: surfacePath,
            previousContents: encodeInkSurfaceRecord(surface),
          },
          {
            nextContents: encodeInkSurfaceRecord(revision(surface, 3, [stroke('second')])),
            path: surfacePath,
            previousContents: encodeInkSurfaceRecord(surface),
          },
        ],
        filePath: surface.filePath,
        phase: 'committed',
        schemaVersion: 1,
      }),
    );

    await expect(repository.listSurfaces(surface.filePath)).rejects.toThrow(/journal is invalid/u);
  });

  it('rejects journal record identities that do not match the canonical target path', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    const surfacePath = store.pathBySuffix(`/surfaces/${surface.id}.json`);
    if (surfacePath === null) throw new Error('Missing canonical surface fixture path.');
    const journalPath = `${surfacePath.slice(0, surfacePath.lastIndexOf('/surfaces/'))}/ink-batch-journal.json`;
    const wrongIdentity = { ...surface, id: 'surface-other' };
    await store.write(
      journalPath,
      JSON.stringify({
        entries: [
          {
            nextContents: encodeInkSurfaceRecord(revision(wrongIdentity, 2, [stroke('wrong')])),
            path: surfacePath,
            previousContents: encodeInkSurfaceRecord(wrongIdentity),
          },
        ],
        filePath: surface.filePath,
        phase: 'committed',
        schemaVersion: 1,
      }),
    );

    await expect(repository.listSurfaces(surface.filePath)).rejects.toThrow(/journal is invalid/u);
  });

  it('rejects a journal whose previous or next canonical record cannot be decoded', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    const surfacePath = store.pathBySuffix(`/surfaces/${surface.id}.json`);
    if (surfacePath === null) throw new Error('Missing canonical surface fixture path.');
    const journalPath = `${surfacePath.slice(0, surfacePath.lastIndexOf('/surfaces/'))}/ink-batch-journal.json`;
    await store.write(
      journalPath,
      JSON.stringify({
        entries: [
          {
            nextContents: encodeInkSurfaceRecord(revision(surface, 2, [stroke('next')])),
            path: surfacePath,
            previousContents: '{',
          },
        ],
        filePath: surface.filePath,
        phase: 'committed',
        schemaVersion: 1,
      }),
    );

    await expect(repository.listSurfaces(surface.filePath)).rejects.toThrow(/journal is invalid/u);
  });

  it('rejects journal records whose file path differs from the journal note', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    const surfacePath = store.pathBySuffix(`/surfaces/${surface.id}.json`);
    if (surfacePath === null) throw new Error('Missing canonical surface fixture path.');
    const journalPath = `${surfacePath.slice(0, surfacePath.lastIndexOf('/surfaces/'))}/ink-batch-journal.json`;
    const wrongFile = { ...surface, filePath: 'Other.md' };
    await store.write(
      journalPath,
      JSON.stringify({
        entries: [
          {
            nextContents: encodeInkSurfaceRecord(revision(wrongFile, 2, [stroke('next')])),
            path: surfacePath,
            previousContents: encodeInkSurfaceRecord(wrongFile),
          },
        ],
        filePath: surface.filePath,
        phase: 'committed',
        schemaVersion: 1,
      }),
    );

    await expect(repository.listSurfaces(surface.filePath)).rejects.toThrow(/journal is invalid/u);
  });

  it('rejects a journal whose record revision chain does not advance exactly once', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    const surfacePath = store.pathBySuffix(`/surfaces/${surface.id}.json`);
    if (surfacePath === null) throw new Error('Missing canonical surface fixture path.');
    const journalPath = `${surfacePath.slice(0, surfacePath.lastIndexOf('/surfaces/'))}/ink-batch-journal.json`;
    await store.write(
      journalPath,
      JSON.stringify({
        entries: [
          {
            nextContents: encodeInkSurfaceRecord(revision(surface, 4, [stroke('leapfrog')])),
            path: surfacePath,
            previousContents: encodeInkSurfaceRecord(surface),
          },
        ],
        filePath: surface.filePath,
        phase: 'committed',
        schemaVersion: 1,
      }),
    );

    await expect(repository.listSurfaces(surface.filePath)).rejects.toThrow(/journal is invalid/u);
  });

  it('rejects a journal whose records do not match canonical note identity metadata', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    const surfacePath = store.pathBySuffix(`/surfaces/${surface.id}.json`);
    if (surfacePath === null) throw new Error('Missing canonical surface fixture path.');
    const journalPath = `${surfacePath.slice(0, surfacePath.lastIndexOf('/surfaces/'))}/ink-batch-journal.json`;
    const foreign = { ...surface, noteId: 'foreign-note' };
    await store.write(
      journalPath,
      JSON.stringify({
        entries: [
          {
            nextContents: encodeInkSurfaceRecord(revision(foreign, 2, [stroke('foreign')])),
            path: surfacePath,
            previousContents: encodeInkSurfaceRecord(foreign),
          },
        ],
        filePath: surface.filePath,
        phase: 'committed',
        schemaVersion: 1,
      }),
    );

    await expect(repository.listSurfaces(surface.filePath)).rejects.toThrow(/journal is invalid/u);
  });

  it('refuses to replay a stale journal over a newer canonical successor', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    const surfacePath = store.pathBySuffix(`/surfaces/${surface.id}.json`);
    if (surfacePath === null) throw new Error('Missing canonical surface fixture path.');
    const journalPath = `${surfacePath.slice(0, surfacePath.lastIndexOf('/surfaces/'))}/ink-batch-journal.json`;
    const journalNext = revision(surface, 2, [stroke('journal-next')]);
    const newer = revision(journalNext, 3, [stroke('newer-canonical')]);
    await store.write(surfacePath, encodeInkSurfaceRecord(newer));
    await store.write(
      journalPath,
      JSON.stringify({
        entries: [
          {
            nextContents: encodeInkSurfaceRecord(journalNext),
            path: surfacePath,
            previousContents: encodeInkSurfaceRecord(surface),
          },
        ],
        filePath: surface.filePath,
        phase: 'committed',
        schemaVersion: 1,
      }),
    );

    await expect(repository.listSurfaces(surface.filePath)).rejects.toThrow(
      /canonical bytes changed after the journal was prepared/u,
    );
    await expect(store.read(surfacePath)).resolves.toBe(encodeInkSurfaceRecord(newer));
  });

  it('rejects a journal target whose basename is not one canonical surface ID', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface(surface);
    const surfacePath = store.pathBySuffix(`/surfaces/${surface.id}.json`);
    if (surfacePath === null) throw new Error('Missing canonical surface fixture path.');
    const surfaceRoot = surfacePath.slice(0, surfacePath.lastIndexOf('/') + 1);
    const journalPath = `${surfacePath.slice(0, surfacePath.lastIndexOf('/surfaces/'))}/ink-batch-journal.json`;
    await store.write(
      journalPath,
      JSON.stringify({
        entries: [
          {
            nextContents: encodeInkSurfaceRecord(revision(surface, 2, [stroke('next')])),
            path: `${surfaceRoot}${surface.id} (conflicted copy).json`,
            previousContents: encodeInkSurfaceRecord(surface),
          },
        ],
        filePath: surface.filePath,
        phase: 'committed',
        schemaVersion: 1,
      }),
    );

    await expect(repository.listSurfaces(surface.filePath)).rejects.toThrow(/journal is invalid/u);
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

  it('rejects a delayed iCloud summary by rebuilding it from canonical surfaces', async () => {
    const { repository, surface, store } = await createFixture();
    await repository.writeSurface({ ...surface, strokes: [stroke('visible')] });
    const summaryPath = store.pathBySuffix('/ink-summaries.json');
    const staleSummary = store.readBySuffix('/ink-summaries.json');
    if (summaryPath === null || staleSummary === null) {
      throw new Error('Missing Ink summary fixture.');
    }
    await repository.tombstoneSurface(
      surface.filePath,
      surface.id,
      '2026-07-14T11:59:00.000Z',
      undefined,
      surface.revision,
    );
    store.replaceBySuffix('/ink-summaries.json', staleSummary);

    await expect(repository.rebuildSummariesForSidecarPath(summaryPath)).resolves.toBe(
      surface.filePath,
    );
    await expect(repository.listSurfaceSummaries(surface.filePath)).resolves.toMatchObject([
      { deletedAt: '2026-07-14T11:59:00.000Z', id: surface.id, revision: 2 },
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

    await expect(
      repository.restoreSurface(
        surface.filePath,
        surface.id,
        '2026-07-14T12:00:30.000Z',
        'desktop-device',
        1,
      ),
    ).rejects.toThrow('changed since it was deleted');
    await expect(repository.readSurface(surface.filePath, surface.id)).resolves.toMatchObject({
      deletedAt: '2026-07-14T12:00:00.000Z',
      revision: 2,
    });

    const restored = await repository.restoreSurface(
      surface.filePath,
      surface.id,
      '2026-07-14T12:01:00.000Z',
      'desktop-device',
      2,
    );
    expect(restored).toMatchObject({ revision: 3, strokes: [{ id: 'keep-me' }] });
    expect(restored.deletedAt).toBeUndefined();
  });

  it('refuses to tombstone an Ink surface after the selected revision changed', async () => {
    const { repository, surface } = await createFixture();
    await repository.writeSurface(surface);
    const updated = revision(surface, 2, [stroke('newer-stroke')]);
    await repository.updateSurface(updated);

    await expect(
      repository.tombstoneSurface(
        surface.filePath,
        surface.id,
        '2026-07-14T12:02:00.000Z',
        'desktop-device',
        surface.revision,
      ),
    ).rejects.toThrow('changed since it was selected');
    await expect(repository.readSurface(surface.filePath, surface.id)).resolves.toEqual(updated);
  });

  it('reclaims active zero-stroke surfaces as tombstones without touching visible Ink', async () => {
    const { repository, surface } = await createFixture();
    const visible = { ...surface, id: 'surface-visible', strokes: [stroke('keep')] };
    await repository.writeSurface(surface);
    await repository.writeSurface(visible);

    const reclaimed = await (
      repository as unknown as {
        reclaimEmptySurfaces: (
          filePath: string,
          now: string,
          deviceId: string,
        ) => Promise<readonly InkSurfaceRecord[]>;
      }
    ).reclaimEmptySurfaces('Ink.md', '2026-07-14T12:02:00.000Z', 'desktop-device');

    expect(reclaimed.map((record) => record.id)).toEqual([surface.id]);
    await expect(repository.readSurface(surface.filePath, surface.id)).resolves.toMatchObject({
      deletedAt: '2026-07-14T12:02:00.000Z',
      deviceId: 'desktop-device',
      revision: 2,
      strokes: [],
    });
    await expect(repository.readSurface(visible.filePath, visible.id)).resolves.toEqual(visible);
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
  private failJournalPromotion = false;
  private failSurfaceWriteCountdown: number | null = null;
  private heldSurfaceList:
    | {
        readonly entered: () => void;
        readonly release: Promise<void>;
      }
    | undefined;
  private heldSurfaceWrite:
    | {
        readonly entered: () => void;
        remaining: number;
        readonly release: Promise<void>;
      }
    | undefined;
  private readonly readCounts = new Map<string, number>();

  constructor(private readonly writeDelayMs = 0) {}

  async list(directory: string): Promise<readonly string[]> {
    if (directory.endsWith('/surfaces') && this.heldSurfaceList !== undefined) {
      const held = this.heldSurfaceList;
      this.heldSurfaceList = undefined;
      held.entered();
      await held.release;
    }
    const prefix = `${directory}/`;
    return [
      ...new Set(
        [...this.files.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length).split('/')[0])
          .filter((name): name is string => name !== undefined && name.length > 0),
      ),
    ].sort();
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
    if (path.includes('/surfaces/') && this.heldSurfaceWrite !== undefined) {
      const held = this.heldSurfaceWrite;
      held.remaining -= 1;
      if (held.remaining === 0) {
        this.heldSurfaceWrite = undefined;
        held.entered();
        await held.release;
      }
    }
    if (this.writeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
    }
    if (
      path.includes('/surfaces/') &&
      this.failSurfaceWriteCountdown !== null &&
      this.failSurfaceWriteCountdown > 0
    ) {
      this.failSurfaceWriteCountdown -= 1;
    }
    if (
      path.includes('/surfaces/') &&
      (this.failNextSurfaceWrite || this.failSurfaceWriteCountdown === 0)
    ) {
      this.failNextSurfaceWrite = false;
      this.failSurfaceWriteCountdown = null;
      this.files.set(path, '{');
      this.activeWrites.set(path, active - 1);
      throw new Error('Injected partial write');
    }
    if (
      this.failJournalPromotion &&
      path.endsWith('/ink-batch-journal.json') &&
      contents.includes('"phase":"committed"')
    ) {
      this.failJournalPromotion = false;
      this.activeWrites.set(path, active - 1);
      throw new Error('Injected journal promotion failure');
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

  failNthNextSurfaceWrite(count: number): void {
    this.failSurfaceWriteCountdown = count;
  }

  failNextJournalPromotion(): void {
    this.failJournalPromotion = true;
  }

  holdNextSurfaceWrite(): { readonly entered: Promise<void>; release(): void } {
    return this.holdNthNextSurfaceWrite(1);
  }

  holdNthNextSurfaceWrite(count: number): { readonly entered: Promise<void>; release(): void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.heldSurfaceWrite = { entered: markEntered, release: released, remaining: count };
    return { entered, release };
  }

  holdNextSurfaceList(): { readonly entered: Promise<void>; release(): void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.heldSurfaceList = { entered: markEntered, release: released };
    return { entered, release };
  }
}

class StoreWrapper implements TextFileStore {
  readonly coordinationScope: object;

  constructor(private readonly target: MemoryTextFileStore) {
    this.coordinationScope = target;
  }

  list(directory: string): Promise<readonly string[]> {
    return this.target.list(directory);
  }

  mkdir(): Promise<void> {
    return this.target.mkdir();
  }

  read(path: string): Promise<string | null> {
    return this.target.read(path);
  }

  remove(path: string): Promise<void> {
    return this.target.remove(path);
  }

  write(path: string, contents: string): Promise<void> {
    return this.target.write(path, contents);
  }
}

class NormalizingStoreWrapper implements TextFileStore {
  readonly coordinationScope: object;

  constructor(private readonly target: MemoryTextFileStore) {
    this.coordinationScope = target;
  }

  list(directory: string): Promise<readonly string[]> {
    return this.target.list(normalizeVaultPath(directory));
  }

  mkdir(path: string): Promise<void> {
    normalizeVaultPath(path);
    return this.target.mkdir();
  }

  read(path: string): Promise<string | null> {
    return this.target.read(normalizeVaultPath(path));
  }

  remove(path: string): Promise<void> {
    return this.target.remove(normalizeVaultPath(path));
  }

  write(path: string, contents: string): Promise<void> {
    return this.target.write(normalizeVaultPath(path), contents);
  }
}
