import { describe, expect, it, vi } from 'vitest';

import { SnapshotAnnotationSession } from './snapshot-annotation-session';
import type { SnapshotAnnotationDraft } from './snapshot-annotation-draft-store';
import { SnapshotAnnotationRepository } from '../storage/snapshot-annotation-repository';
import type { SnapshotAnnotationFileStore } from '../storage/snapshot-annotation-repository';
import { hashText } from '../domain/text-anchor';

describe('Snapshot Annotation session', () => {
  it('saves a complete device-local Draft without publishing a canonical record', async () => {
    const session = await createSession();
    session.addStroke(stroke());
    const replace = vi.fn<(draft: SnapshotAnnotationDraft) => Promise<void>>(() =>
      Promise.resolve(),
    );

    await session.saveDraft({
      discard: () => Promise.resolve(),
      load: () => Promise.resolve(null),
      loadLatest: () => Promise.resolve(null),
      replace,
    });

    const draft = replace.mock.calls[0]?.[0];
    expect(draft?.draftKey).toBe('Notes/Test.md:snapshot-a');
    expect(draft?.isNew).toBe(true);
    expect(draft?.pngBytes).toBeInstanceOf(Uint8Array);
    expect(draft?.record.ink.strokes).toMatchObject([{ id: 'stroke-a' }]);
    expect(session.snapshot().persistence).toEqual({ kind: 'draft-saved' });

    const resumed = SnapshotAnnotationSession.resumeDraft(draft as SnapshotAnnotationDraft);
    expect(resumed.hasUnsavedChanges()).toBe(true);
    expect(resumed.snapshot()).toMatchObject({
      persistence: { kind: 'editing' },
      record: { ink: { strokes: [{ id: 'stroke-a' }] } },
    });
  });

  it('lists compact Snapshot entries without reading capture bytes or canonical stroke arrays', async () => {
    const store = new MemorySnapshotFileStore();
    const repository = new SnapshotAnnotationRepository(store);
    const session = await createSession();
    session.addStroke(stroke());
    await session.done(repository);
    store.readPaths.length = 0;
    store.readBinaryPaths.length = 0;

    const entries = await repository.listIndexEntries('Notes/Test.md');

    expect(entries).toMatchObject([
      { id: 'snapshot-a', source: { headingPath: ['Test'] }, strokeCount: 1 },
    ]);
    expect(JSON.stringify(entries)).not.toContain('points');
    expect(store.readPaths).toHaveLength(1);
    expect(store.readPaths[0]).toMatch(/summary\.json$/u);
    expect(store.readBinaryPaths).toEqual([]);
  });

  it('retains unsaved Ink after a persistence failure and commits the same edit on retry', async () => {
    const store = new MemorySnapshotFileStore();
    const repository = new SnapshotAnnotationRepository(store);
    const session = await createSession();
    session.addStroke(stroke());
    let attempts = 0;
    const failOnceWriter = {
      create: async (...input: Parameters<SnapshotAnnotationRepository['create']>) => {
        attempts += 1;
        if (attempts === 1) throw new Error('fixture write failed');
        await repository.create(...input);
      },
    };

    await expect(session.done(failOnceWriter)).rejects.toThrow('fixture write failed');
    expect(session.snapshot()).toMatchObject({
      persistence: { kind: 'error' },
      record: { ink: { strokes: [{ id: 'stroke-a' }] }, revision: 1 },
    });

    const saved = await session.done(failOnceWriter);
    expect(attempts).toBe(2);
    expect(saved.ink.strokes).toHaveLength(1);
    expect(session.snapshot().persistence).toEqual({ kind: 'saved-locally' });
  });

  it('commits the immutable capture before its record and reopens one stroke at identical image coordinates', async () => {
    const store = new MemorySnapshotFileStore();
    const repository = new SnapshotAnnotationRepository(store);
    const pngBytes = pngHeader(600, 400);
    const session = await createSession();

    session.addStroke(stroke());

    const saved = await session.done(repository);
    const reopened = await repository.read('Notes/Test.md', saved.id);

    const assetWrite = store.publicationOrder.findIndex((path) =>
      /capture-[a-f0-9]{64}\.png$/u.test(path),
    );
    const recordWrite = store.publicationOrder.findIndex((path) => /record\.json$/u.test(path));
    expect(assetWrite).toBeGreaterThanOrEqual(0);
    expect(recordWrite).toBeGreaterThan(assetWrite);
    expect(reopened?.pngBytes).toEqual(pngBytes);
    expect(reopened?.record.ink).toEqual({
      logicalHeight: 200,
      logicalWidth: 300,
      strokes: [
        expect.objectContaining({
          id: 'stroke-a',
          points: [
            expect.objectContaining({ x: 25, y: 30 }),
            expect.objectContaining({ x: 125, y: 130 }),
          ],
        }),
      ],
    });
  });

  it('tombstones, restores, and manually relinks by publishing higher record revisions', async () => {
    const store = new MemorySnapshotFileStore();
    const repository = new SnapshotAnnotationRepository(store);
    const session = await createSession();
    session.addStroke(stroke());
    const created = await session.done(repository);
    const deleted = await repository.tombstone(
      created.filePath,
      created.id,
      created.revision,
      '2026-07-22T06:00:00.000Z',
    );
    const restored = await repository.restore(
      created.filePath,
      created.id,
      deleted.revision,
      '2026-07-22T06:01:00.000Z',
    );
    const replacementSource = {
      coverage: [
        { ...target(), position: { end: 14, start: 9, unit: 'utf16-code-unit' as const } },
      ],
      focus: { ...target(), position: { end: 14, start: 9, unit: 'utf16-code-unit' as const } },
      headingPath: ['Moved'],
      sourceRevision: 'source-b',
    };
    const relinked = await repository.relink(
      created.filePath,
      created.id,
      restored.revision,
      replacementSource,
      '2026-07-22T06:02:00.000Z',
    );

    expect(deleted).toMatchObject({ deletedAt: '2026-07-22T06:00:00.000Z', revision: 2 });
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.revision).toBe(3);
    expect(relinked).toMatchObject({
      asset: { sha256: created.asset.sha256 },
      ink: { strokes: [{ id: 'stroke-a' }] },
      revision: 4,
      source: { headingPath: ['Moved'], sourceRevision: 'source-b' },
      status: 'active',
    });
    await expect(
      repository.tombstone(created.filePath, created.id, 1, '2026-07-22T07:00:00.000Z'),
    ).rejects.toThrow('revision conflict');
  });

  it('removes only cold, marked, unreferenced capture assets with a bounded cleanup', async () => {
    const store = new MemorySnapshotFileStore();
    store.failRecordWrites = 1;
    const repository = new SnapshotAnnotationRepository(store, {
      now: () => '2026-07-20T00:00:00.000Z',
    });
    const session = await createSession();
    session.addStroke(stroke());

    await expect(session.done(repository)).rejects.toThrow('fixture record write failed');
    await expect(
      repository.cleanupColdOrphans('Notes/Test.md', {
        limit: 1,
        minimumAgeMs: 24 * 60 * 60 * 1_000,
        now: '2026-07-22T00:00:00.000Z',
      }),
    ).resolves.toBe(1);
    expect(store.removedPaths).toEqual([
      expect.stringMatching(/capture-[a-f0-9]{64}\.png$/u),
      expect.stringMatching(/orphan-[a-f0-9]{64}\.json$/u),
    ]);
  });

  it('publishes an edited record revision without rewriting or renaming its Capture Asset', async () => {
    const store = new MemorySnapshotFileStore();
    const repository = new SnapshotAnnotationRepository(store);
    const createdSession = await createSession();
    createdSession.addStroke(stroke());
    const created = await createdSession.done(repository);
    const loaded = await repository.read(created.filePath, created.id);
    if (loaded === null) throw new Error('fixture Snapshot was not saved');
    const reopened = SnapshotAnnotationSession.reopen(loaded.record, loaded.pngBytes, {
      now: () => '2026-07-22T08:00:00.000Z',
    });
    reopened.addStroke({ ...stroke(), id: 'stroke-b' });

    const edited = await reopened.done(repository);

    expect(edited).toMatchObject({
      asset: { fileName: created.asset.fileName, sha256: created.asset.sha256 },
      revision: 2,
    });
    expect(
      store.publicationOrder.filter((path) => /capture-[a-f0-9]{64}\.png$/u.test(path)),
    ).toHaveLength(1);
  });

  it('reconciles Snapshot record paths after the note sidecar root is rekeyed on rename', async () => {
    const store = new MemorySnapshotFileStore();
    const repository = new SnapshotAnnotationRepository(store);
    const session = await createSession('Notes/Old.md');
    session.addStroke(stroke());
    const created = await session.done(repository);
    const oldHash = await hashText('Notes/Old.md');
    const newHash = await hashText('Notes/Renamed.md');
    store.renamePrefix(
      `.obsidian-annotations/v1/notes/${oldHash}`,
      `.obsidian-annotations/v1/notes/${newHash}`,
    );

    const [reconciled] = await repository.reconcileFilePath(
      'Notes/Renamed.md',
      '2026-07-22T09:00:00.000Z',
    );
    const loaded = await repository.read('Notes/Renamed.md', created.id);

    expect(reconciled).toMatchObject({ filePath: 'Notes/Renamed.md', revision: 2 });
    expect(loaded?.record.asset.sha256).toBe(created.asset.sha256);
  });

  it('rekeys a Snapshot-only note when no legacy note metadata exists', async () => {
    const store = new MemorySnapshotFileStore();
    const repository = new SnapshotAnnotationRepository(store);
    const session = await createSession('Notes/Snapshot Only.md');
    session.addStroke(stroke());
    const created = await session.done(repository);

    const [reconciled] = await repository.reconcileObservedRename(
      'Notes/Snapshot Only.md',
      'Notes/Snapshot Renamed.md',
      '2026-07-22T09:30:00.000Z',
    );

    await expect(repository.read('Notes/Snapshot Only.md', created.id)).resolves.toBeNull();
    await expect(repository.read('Notes/Snapshot Renamed.md', created.id)).resolves.toMatchObject({
      record: {
        asset: { sha256: created.asset.sha256 },
        filePath: 'Notes/Snapshot Renamed.md',
        revision: 2,
      },
    });
    expect(reconciled).toMatchObject({
      filePath: 'Notes/Snapshot Renamed.md',
      revision: 2,
    });
  });
});

function createSession(filePath = 'Notes/Test.md'): Promise<SnapshotAnnotationSession> {
  return SnapshotAnnotationSession.create({
    backend: { id: 'electron-capture-page', version: '1' },
    capturedAt: '2026-07-22T05:00:00.000Z',
    deviceId: 'device-a',
    filePath,
    id: 'snapshot-a',
    logicalHeight: 200,
    logicalWidth: 300,
    noteId: 'note-a',
    pixelHeight: 400,
    pixelRatio: 2,
    pixelWidth: 600,
    pngBytes: pngHeader(600, 400),
    source: {
      coverage: [target()],
      focus: target(),
      headingPath: ['Test'],
      sourceRevision: 'source-a',
    },
  });
}

function stroke() {
  return {
    brushRenderVersion: 'legacy-round-v1' as const,
    color: '#d97777',
    id: 'stroke-a',
    inputProfile: { pressure: 'legacy-unknown' as const, tilt: 'legacy-unknown' as const },
    points: [
      { pressure: 0.5, time: 1, x: 25, y: 30 },
      { pressure: 0.5, time: 2, x: 125, y: 130 },
    ],
    tool: 'pen' as const,
    width: 4,
  };
}

function target() {
  return {
    position: { end: 6, start: 1, unit: 'utf16-code-unit' as const },
    quote: { exact: 'Test', prefix: '#', suffix: '\n' },
    scope: { headingPath: ['Test'] },
    sourceRevision: 'source-a',
  };
}

class MemorySnapshotFileStore implements SnapshotAnnotationFileStore {
  readonly coordinationScope = this;
  readonly publicationOrder: string[] = [];
  readonly readBinaryPaths: string[] = [];
  readonly readPaths: string[] = [];
  readonly removedPaths: string[] = [];
  failRecordWrites = 0;
  private readonly binary = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>();
  private readonly text = new Map<string, string>();

  exists(path: string): Promise<boolean> {
    return Promise.resolve(
      this.binary.has(path) || this.text.has(path) || this.directories.has(path),
    );
  }

  list(directory: string): Promise<readonly string[]> {
    const prefix = `${directory}/`;
    return Promise.resolve(
      [...this.directories, ...this.binary.keys(), ...this.text.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map((path) => path.slice(prefix.length)),
    );
  }

  mkdir(path: string): Promise<void> {
    this.directories.add(path);
    return Promise.resolve();
  }

  renamePrefix(from: string, to: string): void {
    for (const [path, contents] of [...this.text]) {
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      this.text.delete(path);
      this.text.set(`${to}${path.slice(from.length)}`, contents);
    }
    for (const [path, contents] of [...this.binary]) {
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      this.binary.delete(path);
      this.binary.set(`${to}${path.slice(from.length)}`, contents);
    }
    for (const path of [...this.directories]) {
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      this.directories.delete(path);
      this.directories.add(`${to}${path.slice(from.length)}`);
    }
  }

  rename(from: string, to: string): Promise<void> {
    this.renamePrefix(from, to);
    return Promise.resolve();
  }

  read(path: string): Promise<string | null> {
    this.readPaths.push(path);
    return Promise.resolve(this.text.get(path) ?? null);
  }

  readBinary(path: string): Promise<ArrayBuffer | null> {
    this.readBinaryPaths.push(path);
    const bytes = this.binary.get(path);
    return Promise.resolve(bytes === undefined ? null : Uint8Array.from(bytes).buffer);
  }

  remove(path: string): Promise<void> {
    this.binary.delete(path);
    this.text.delete(path);
    this.directories.delete(path);
    this.removedPaths.push(path);
    return Promise.resolve();
  }

  write(path: string, contents: string): Promise<void> {
    if (path.endsWith('/record.json') && this.failRecordWrites > 0) {
      this.failRecordWrites -= 1;
      return Promise.reject(new Error('fixture record write failed'));
    }
    this.text.set(path, contents);
    this.publicationOrder.push(path);
    return Promise.resolve();
  }

  writeBinary(path: string, contents: ArrayBuffer): Promise<void> {
    this.binary.set(path, new Uint8Array(contents.slice(0)));
    this.publicationOrder.push(path);
    return Promise.resolve();
  }
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
