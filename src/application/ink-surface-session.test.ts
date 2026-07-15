import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import { InkSurfaceSession } from './ink-surface-session';

describe('ink surface session', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps completed strokes in memory and persists them after the debounce', async () => {
    vi.useFakeTimers();
    const repository = new RecordingRepository();
    const session = createSession(repository, 300);

    session.addStroke(stroke('one'));
    expect(session.snapshot().surface.strokes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(repository.records).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(session.snapshot().state).toMatchObject({ dirty: false }));
    expect(repository.records).toMatchObject([{ revision: 2, strokes: [{ id: 'one' }] }]);
    expect(session.snapshot().persistence).toEqual({ kind: 'saved-locally' });
  });

  it('forces the latest strokes to disk before exit and background completion', async () => {
    vi.useFakeTimers();
    const repository = new RecordingRepository();
    const session = createSession(repository, 10_000);
    session.addStroke(stroke('exit'));

    await session.exit();

    expect(session.snapshot().state).toEqual({ kind: 'reading' });
    expect(repository.records.at(-1)).toMatchObject({ revision: 2, strokes: [{ id: 'exit' }] });

    const second = createSession(repository, 10_000, repository.records.at(-1));
    second.addStroke(stroke('background'));
    await second.background();
    expect(second.snapshot().state).toEqual({ dirty: false, kind: 'ink-mode', saveError: null });
    expect(repository.records.at(-1)).toMatchObject({
      revision: 3,
      strokes: [{ id: 'exit' }, { id: 'background' }],
    });
  });

  it('serializes rapid changes and follows a save with another revision when drawing continues', async () => {
    const repository = new RecordingRepository(true);
    const session = createSession(repository, 10_000);
    session.addStroke(stroke('first'));
    const flush = session.background();
    await repository.waitUntilWriteStarts();
    session.addStroke(stroke('during-save'));
    const secondFlush = session.background();

    repository.releaseWrite();
    await repository.waitUntilWriteStarts(2);
    repository.releaseWrite();
    await Promise.all([flush, secondFlush]);

    expect(repository.maximumConcurrentWrites).toBe(1);
    expect(repository.records).toMatchObject([
      { revision: 2, strokes: [{ id: 'first' }] },
      { revision: 3, strokes: [{ id: 'first' }, { id: 'during-save' }] },
    ]);
  });

  it('retains all in-memory strokes after failure and retries with the correct revision', async () => {
    const repository = new RecordingRepository();
    repository.failNextWrite = true;
    const session = createSession(repository, 10_000);
    session.addStroke(stroke('recover-me'));

    await expect(session.exit()).rejects.toThrow('disk unavailable');
    expect(session.snapshot()).toMatchObject({
      persistence: { kind: 'error', message: "Couldn't save Ink locally. Retry." },
      state: { dirty: true, kind: 'ink-mode', pendingIntent: 'exit' },
      surface: { revision: 1, strokes: [{ id: 'recover-me' }] },
    });

    await session.retry();

    expect(session.snapshot().state).toEqual({ kind: 'reading' });
    expect(repository.records).toMatchObject([{ revision: 2, strokes: [{ id: 'recover-me' }] }]);
  });

  it('replaces the live stroke set as one dirty mutation for undo and erasing', async () => {
    const repository = new RecordingRepository();
    const session = createSession(repository, 10_000, {
      ...surfaceFixture(),
      strokes: [stroke('one'), stroke('two')],
    });

    session.replaceStrokes([stroke('one')]);
    await session.background();

    expect(repository.records.at(-1)).toMatchObject({
      revision: 2,
      strokes: [{ id: 'one' }],
    });
  });
});

function createSession(
  repository: RecordingRepository,
  debounceMs: number,
  surface = surfaceFixture(),
): InkSurfaceSession {
  return new InkSurfaceSession({
    debounceMs,
    now: () => '2026-07-14T09:00:00.000Z',
    repository,
    surface: surface ?? surfaceFixture(),
  });
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

function stroke(id: string): InkStroke {
  return {
    color: '#111111',
    id,
    points: [
      { pressure: 0.5, time: 0, x: 1, y: 1 },
      { pressure: 0.5, time: 16, x: 2, y: 2 },
    ],
    tool: 'pen',
    width: 2,
  };
}

class RecordingRepository {
  activeWrites = 0;
  failNextWrite = false;
  maximumConcurrentWrites = 0;
  readonly records: InkSurfaceRecord[] = [];
  private release: (() => void) | null = null;
  private startedWrites = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly controlled = false) {}

  async updateSurface(record: InkSurfaceRecord): Promise<void> {
    this.activeWrites += 1;
    this.maximumConcurrentWrites = Math.max(this.maximumConcurrentWrites, this.activeWrites);
    this.startedWrites += 1;
    for (const waiter of this.waiters.splice(0)) {
      waiter();
    }
    if (this.controlled) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    if (this.failNextWrite) {
      this.failNextWrite = false;
      this.activeWrites -= 1;
      throw new Error('disk unavailable');
    }
    this.records.push(structuredClone(record));
    this.activeWrites -= 1;
  }

  releaseWrite(): void {
    this.release?.();
    this.release = null;
  }

  async waitUntilWriteStarts(expected = 1): Promise<void> {
    while (this.startedWrites < expected) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}
