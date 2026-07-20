import { describe, expect, it } from 'vitest';

import type { InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import { InkSurfaceRepository } from '../storage/ink-surface-repository';
import { SidecarRepository, type TextFileStore } from '../storage/sidecar-repository';
import { InkDocumentSession } from './ink-document-session';
import { InkSurfaceSession, type InkSurfaceWriter } from './ink-surface-session';

describe('Ink iCloud-resilient persistence', () => {
  it('merges independent strokes from two stale sessions and continues from the merged revision', async () => {
    const store = new MemoryTextFileStore();
    await new SidecarRepository(store).getOrCreateNote({
      createId: () => 'note-1',
      filePath: 'Ink.md',
      now: '2026-07-17T02:00:00.000Z',
      sourceFingerprint: 'source-1',
    });
    const repository = new InkSurfaceRepository(store);
    const base = surface();
    await repository.writeSurface(base);
    const remoteSession = new InkSurfaceSession({
      debounceMs: 10_000,
      now: () => '2026-07-17T02:01:00.000Z',
      repository,
      surface: structuredClone(base),
    });
    const localSession = new InkSurfaceSession({
      debounceMs: 10_000,
      now: () => '2026-07-17T02:02:00.000Z',
      repository,
      surface: structuredClone(base),
    });

    remoteSession.extendLogicalHeightTransiently(1_400);
    remoteSession.addStroke(stroke('z-remote'));
    await remoteSession.background();
    localSession.extendLogicalHeightTransiently(1_600);
    localSession.addStroke(stroke('a-local'));

    await expect(localSession.background()).resolves.toBeUndefined();
    expect(localSession.snapshot()).toMatchObject({
      persistence: { kind: 'saved-locally' },
      surface: {
        layout: { logicalHeight: 1_600 },
        revision: 3,
        strokes: [{ id: 'z-remote' }, { id: 'a-local' }],
      },
    });
    await expect(repository.readSurface('Ink.md', 'surface-1')).resolves.toMatchObject({
      layout: { logicalHeight: 1_600 },
      revision: 3,
      strokes: [{ id: 'z-remote' }, { id: 'a-local' }],
    });

    localSession.addStroke(stroke('next-local'));
    await localSession.background();

    await expect(repository.readSurface('Ink.md', 'surface-1')).resolves.toMatchObject({
      revision: 4,
      strokes: [{ id: 'z-remote' }, { id: 'a-local' }, { id: 'next-local' }],
    });
  });

  it('merges every stale chunk of one logical stroke as one atomic document commit', async () => {
    const store = new MemoryTextFileStore();
    await new SidecarRepository(store).getOrCreateNote({
      createId: () => 'note-1',
      filePath: 'Ink.md',
      now: '2026-07-17T03:00:00.000Z',
      sourceFingerprint: 'source-1',
    });
    const repository = new InkSurfaceRepository(store);
    const first = boundedSurface('surface-a', 0);
    const second = boundedSurface('surface-b', 600);
    await repository.writeSurface(first);
    await repository.writeSurface(second);
    const localSession = new InkDocumentSession({
      debounceMs: 10_000,
      now: () => '2026-07-17T03:02:00.000Z',
      surfaces: [structuredClone(first), structuredClone(second)],
      writer: repository,
    });
    await repository.updateSurfacesAtomically(
      [
        { ...first, revision: 2, strokes: [stroke('remote-a')] },
        { ...second, revision: 2, strokes: [stroke('remote-b')] },
      ],
      [first, second],
    );

    localSession.addStroke({
      ...stroke('local-crossing'),
      points: [
        { pressure: 0.5, time: 0, x: 10, y: 550 },
        { pressure: 0.5, time: 16, x: 20, y: 650 },
      ],
    });
    await expect(localSession.background()).resolves.toBeUndefined();

    const committed = await Promise.all([
      repository.readSurface('Ink.md', 'surface-a'),
      repository.readSurface('Ink.md', 'surface-b'),
    ]);
    expect(committed).toMatchObject([
      {
        revision: 3,
        strokes: [
          { id: 'remote-a' },
          { id: 'local-crossing-surface-a', linkedStrokeId: 'local-crossing' },
        ],
      },
      {
        revision: 3,
        strokes: [
          { id: 'remote-b' },
          { id: 'local-crossing-surface-b', linkedStrokeId: 'local-crossing' },
        ],
      },
    ]);
    expect(localSession.snapshot()).toMatchObject({
      persistence: { kind: 'saved-locally' },
      surface: {
        strokes: [{ id: 'remote-a' }, { id: 'local-crossing' }, { id: 'remote-b' }],
      },
    });
  });

  it('leaves every chunk untouched when one stale target changed an existing stroke', async () => {
    const store = new MemoryTextFileStore();
    await new SidecarRepository(store).getOrCreateNote({
      createId: () => 'note-1',
      filePath: 'Ink.md',
      now: '2026-07-17T04:00:00.000Z',
      sourceFingerprint: 'source-1',
    });
    const repository = new InkSurfaceRepository(store);
    const first = boundedSurface('surface-a', 0);
    const shared = stroke('shared');
    const second = { ...boundedSurface('surface-b', 600), strokes: [shared] };
    await repository.writeSurface(first);
    await repository.writeSurface(second);
    const localSession = new InkDocumentSession({
      debounceMs: 10_000,
      now: () => '2026-07-17T04:02:00.000Z',
      surfaces: [structuredClone(first), structuredClone(second)],
      writer: repository,
    });
    const movedShared = {
      ...shared,
      points: shared.points.map((point) => ({ ...point, x: point.x + 100 })),
    };
    await repository.updateSurfacesAtomically(
      [
        { ...first, revision: 2, strokes: [stroke('remote-a')] },
        { ...second, revision: 2, strokes: [movedShared] },
      ],
      [first, second],
    );
    localSession.addStroke({
      ...stroke('local-crossing'),
      points: [
        { pressure: 0.5, time: 0, x: 10, y: 550 },
        { pressure: 0.5, time: 16, x: 20, y: 650 },
      ],
    });

    await expect(localSession.background()).rejects.toThrow(/local Ink is retained/u);

    const committed = await Promise.all([
      repository.readSurface('Ink.md', 'surface-a'),
      repository.readSurface('Ink.md', 'surface-b'),
    ]);
    expect(committed).toMatchObject([
      { revision: 2, strokes: [{ id: 'remote-a' }] },
      { revision: 2, strokes: [{ id: 'shared', points: [{ x: 110 }, { x: 120 }] }] },
    ]);
    expect(localSession.snapshot()).toMatchObject({
      persistence: {
        kind: 'error',
        message: 'Another Ink version arrived. Your local strokes are safe.',
      },
      surface: { strokes: [{ id: 'shared' }, { id: 'local-crossing' }] },
    });
  });

  it('keeps drawing during a merged write and saves it after the returned canonical base', async () => {
    const store = new MemoryTextFileStore();
    await new SidecarRepository(store).getOrCreateNote({
      createId: () => 'note-1',
      filePath: 'Ink.md',
      now: '2026-07-17T05:00:00.000Z',
      sourceFingerprint: 'source-1',
    });
    const repository = new InkSurfaceRepository(store);
    const base = surface();
    await repository.writeSurface(base);
    await repository.updateSurface({ ...base, revision: 2, strokes: [stroke('z-remote')] }, base);
    const heldWriter = new HoldFirstCompletedWrite(repository);
    const localSession = new InkSurfaceSession({
      debounceMs: 10_000,
      now: () => '2026-07-17T05:02:00.000Z',
      repository: heldWriter,
      surface: structuredClone(base),
    });
    localSession.addStroke(stroke('a-local'));

    const saving = localSession.background();
    await heldWriter.completed;
    localSession.addStroke(stroke('zz-during-save'));
    heldWriter.release();
    await saving;

    await expect(repository.readSurface('Ink.md', 'surface-1')).resolves.toMatchObject({
      revision: 4,
      strokes: [{ id: 'z-remote' }, { id: 'a-local' }, { id: 'zz-during-save' }],
    });
    expect(localSession.snapshot()).toMatchObject({
      persistence: { kind: 'saved-locally' },
      surface: {
        revision: 4,
        strokes: [{ id: 'z-remote' }, { id: 'a-local' }, { id: 'zz-during-save' }],
      },
    });
  });

  it('keeps merging append-only descendants after an earlier merge changed stroke order', async () => {
    const store = new MemoryTextFileStore();
    await new SidecarRepository(store).getOrCreateNote({
      createId: () => 'note-1',
      filePath: 'Ink.md',
      now: '2026-07-17T06:00:00.000Z',
      sourceFingerprint: 'source-1',
    });
    const repository = new InkSurfaceRepository(store);
    const base = surface();
    await repository.writeSurface(base);
    const firstStaleSession = new InkSurfaceSession({
      debounceMs: 10_000,
      repository,
      surface: structuredClone(base),
    });
    const remoteSession = new InkSurfaceSession({
      debounceMs: 10_000,
      repository,
      surface: structuredClone(base),
    });
    remoteSession.addStroke(stroke('z-remote'));
    await remoteSession.background();
    const remoteRevision = await repository.readSurface('Ink.md', 'surface-1');
    if (remoteRevision === null) throw new Error('Missing remote Ink revision.');
    const secondStaleSession = new InkSurfaceSession({
      debounceMs: 10_000,
      repository,
      surface: structuredClone(remoteRevision),
    });

    firstStaleSession.addStroke(stroke('a-first-stale'));
    await firstStaleSession.background();
    secondStaleSession.addStroke(stroke('m-second-stale'));

    await expect(secondStaleSession.background()).resolves.toBeUndefined();
    await expect(repository.readSurface('Ink.md', 'surface-1')).resolves.toMatchObject({
      revision: 4,
      strokes: [{ id: 'z-remote' }, { id: 'a-first-stale' }, { id: 'm-second-stale' }],
    });
  });

  it('keeps a merged canonical write successful when a projection event fails', async () => {
    const store = new MemoryTextFileStore();
    await new SidecarRepository(store).getOrCreateNote({
      createId: () => 'note-1',
      filePath: 'Ink.md',
      now: '2026-07-17T07:00:00.000Z',
      sourceFingerprint: 'source-1',
    });
    let failMergedEvent = false;
    const eventIssues: unknown[] = [];
    const repository = new InkSurfaceRepository(store, {
      onEventIssue: (error) => eventIssues.push(error),
      onSurfaceChanged: (record) => {
        if (failMergedEvent && record.revision === 3) {
          failMergedEvent = false;
          throw new Error('subscriber failed after merged canonical write');
        }
      },
    });
    const base = surface();
    await repository.writeSurface(base);
    await repository.updateSurface({ ...base, revision: 2, strokes: [stroke('remote')] }, base);
    const localSession = new InkSurfaceSession({
      debounceMs: 10_000,
      repository,
      surface: structuredClone(base),
    });
    localSession.addStroke(stroke('local'));
    failMergedEvent = true;
    await expect(localSession.background()).resolves.toBeUndefined();
    expect(eventIssues).toEqual([
      expect.objectContaining({ message: 'subscriber failed after merged canonical write' }),
    ]);

    await expect(repository.readSurface('Ink.md', 'surface-1')).resolves.toMatchObject({
      revision: 3,
      strokes: [{ id: 'remote' }, { id: 'local' }],
    });
    expect(localSession.snapshot()).toMatchObject({
      persistence: { kind: 'saved-locally' },
      surface: { revision: 3, strokes: [{ id: 'remote' }, { id: 'local' }] },
    });
  });
});

function surface(): InkSurfaceRecord {
  return {
    createdAt: '2026-07-17T02:00:00.000Z',
    deviceId: 'device-origin',
    filePath: 'Ink.md',
    id: 'surface-1',
    layout: {
      blockFingerprints: [],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1_200,
      logicalWidth: 704,
      originY: 0,
      sourceRevision: 'source-1',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 2,
    status: 'active',
    strokes: [],
    updatedAt: '2026-07-17T02:00:00.000Z',
  };
}

function boundedSurface(id: string, originY: number): InkSurfaceRecord {
  return {
    ...surface(),
    id,
    layout: {
      ...surface().layout,
      logicalHeight: 600,
      originY,
    },
  };
}

function stroke(id: string): InkStroke {
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
    this.files.delete(path);
    return Promise.resolve();
  }

  write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
    return Promise.resolve();
  }
}

class HoldFirstCompletedWrite implements InkSurfaceWriter {
  readonly completed: Promise<void>;
  private complete: (() => void) | null = null;
  private held = true;
  private readonly released: Promise<void>;
  private resume: (() => void) | null = null;

  constructor(private readonly target: InkSurfaceWriter) {
    this.completed = new Promise((resolve) => {
      this.complete = resolve;
    });
    this.released = new Promise((resolve) => {
      this.resume = resolve;
    });
  }

  release(): void {
    this.resume?.();
    this.resume = null;
  }

  async updateSurface(
    record: InkSurfaceRecord,
    expectedBase?: InkSurfaceRecord,
  ): Promise<InkSurfaceRecord | void> {
    const committed = await this.target.updateSurface(record, expectedBase);
    if (this.held) {
      this.held = false;
      this.complete?.();
      this.complete = null;
      await this.released;
    }
    return committed;
  }
}
