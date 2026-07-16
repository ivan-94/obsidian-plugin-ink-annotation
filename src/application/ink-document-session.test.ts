import { describe, expect, it } from 'vitest';

import type { InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import { InkDocumentSession } from './ink-document-session';

describe('continuous Ink document session', () => {
  it('rejects a multi-chunk writer that cannot guarantee atomic persistence', () => {
    expect(
      () =>
        new InkDocumentSession({
          surfaces: [surface('a', 600), surface('b', 400)],
          writer: { updateSurface: () => Promise.resolve() },
        }),
    ).toThrow('atomic');
  });

  it('presents multiple bounded records as one continuous invisible-boundary surface', () => {
    const session = createSession([surface('a', 600), surface('b', 400)]).session;

    expect(session.snapshot().surface.layout).toMatchObject({
      logicalHeight: 1000,
      logicalWidth: 960,
    });
    expect(session.snapshot().surface.id).toBe('document:a:b');
  });

  it('exposes bounded base revisions for synchronous crash recovery while dirty', () => {
    const session = createSession([surface('a', 600), surface('b', 400)]).session;

    session.addStroke(stroke('crossing', 550, 650));

    expect(session.recoverySnapshot()).toMatchObject({
      expectedBases: [
        { id: 'a', revision: 1, strokes: [] },
        { id: 'b', revision: 1, strokes: [] },
      ],
      pendingAttempts: [
        { id: 'a', revision: 2, strokes: [{ linkedStrokeId: 'crossing' }] },
        { id: 'b', revision: 2, strokes: [{ linkedStrokeId: 'crossing' }] },
      ],
      records: [
        { id: 'a', revision: 1, strokes: [{ linkedStrokeId: 'crossing' }] },
        { id: 'b', revision: 1, strokes: [{ linkedStrokeId: 'crossing' }] },
      ],
      requiresRecovery: true,
    });
  });

  it('re-enters clean chunks after another bounded chunk failed during Preview exit', async () => {
    const writer = new RecordingWriter('a');
    const session = new InkDocumentSession({
      surfaces: [surface('a', 600), surface('b', 400)],
      writer,
    });
    session.addStroke(stroke('failed-top', 100, 200));

    await expect(session.exit()).rejects.toThrow('a unavailable');
    expect(session.snapshot()).toMatchObject({
      state: { dirty: true, kind: 'ink-mode', pendingIntent: 'exit' },
    });

    session.enter();
    session.addStroke(stroke('new-bottom', 700, 800));

    expect(session.snapshot().surface.strokes.map(({ id }) => id)).toEqual([
      'failed-top',
      'new-bottom',
    ]);
  });

  it('orders schema-v2 chunks by persisted note-global origin instead of caller or DOM order', () => {
    const later: InkSurfaceRecord = {
      ...surface('b', 400),
      layout: { ...surface('b', 400).layout, originY: 600 },
      schemaVersion: 2,
    };
    const earlier: InkSurfaceRecord = {
      ...surface('a', 600),
      layout: { ...surface('a', 600).layout, originY: 0 },
      schemaVersion: 2,
    };

    const session = createSession([later, earlier]).session;

    expect(session.snapshot().surface.id).toBe('document:a:b');
    expect(session.snapshot().surface.layout.logicalHeight).toBe(1000);
  });

  it('keeps lower persisted Ink reachable when current Markdown becomes shorter', () => {
    const lower: InkSurfaceRecord = {
      ...surface('lower', 400),
      layout: { ...surface('lower', 400).layout, originY: 600 },
      schemaVersion: 2,
      strokes: [{ ...stroke('lower-stroke', 50, 70), points: [point(100, 50), point(120, 70)] }],
    };
    const top: InkSurfaceRecord = {
      ...surface('top', 600),
      layout: { ...surface('top', 600).layout, originY: 0 },
      schemaVersion: 2,
    };
    const session = createSession([lower, top]).session;

    expect(session.snapshot().surface.layout.logicalHeight).toBe(1_000);
    expect(session.selectStrokeAt(point(100, 650), 8)).toEqual(['lower-stroke']);
  });

  it('extends the final chunk transiently and persists it only after an explicit edit', async () => {
    const top: InkSurfaceRecord = {
      ...surface('top', 600),
      layout: { ...surface('top', 600).layout, originY: 0 },
      schemaVersion: 2,
    };
    const bottom: InkSurfaceRecord = {
      ...surface('bottom', 400),
      layout: { ...surface('bottom', 400).layout, originY: 600 },
      schemaVersion: 2,
    };
    const { session, writer } = createSession([top, bottom]);

    expect(session.ensureMinimumHeight(1_600)).toBe(true);
    expect(session.snapshot().surface.layout.logicalHeight).toBe(1_600);
    await session.background();
    expect(writer.records).toEqual([]);

    session.addStroke(stroke('in-safe-margin', 1_500, 1_550));
    await session.background();

    expect(writer.records).toHaveLength(1);
    expect(writer.records[0]).toMatchObject({
      id: 'bottom',
      layout: { logicalHeight: 1_000, originY: 600 },
      revision: 2,
    });
  });

  it('splits one crossing user stroke into linked local fragments and persists both', async () => {
    const { session, writer } = createSession([surface('a', 600), surface('b', 400)]);

    session.addStroke(stroke('user-stroke', 550, 650));
    await session.background();

    expect(writer.records).toHaveLength(2);
    expect(writer.records.map((record) => record.id)).toEqual(['a', 'b']);
    expect(writer.records.map((record) => record.strokes[0]?.linkedStrokeId)).toEqual([
      'user-stroke',
      'user-stroke',
    ]);
    expect(writer.records[0]?.strokes[0]?.points.at(-1)).toMatchObject({ y: 600 });
    expect(writer.records[1]?.strokes[0]?.points[0]).toMatchObject({ y: 0 });
  });

  it('joins stored local fragments for rendering without a visible boundary seam', () => {
    const linkedA: InkStroke = {
      ...fragment('fragment-a', 'user-stroke', 550, 600),
      points: [
        { ...point(100, 550), time: 1 },
        { ...point(150, 600), time: 2 },
      ],
    };
    const linkedB: InkStroke = {
      ...fragment('fragment-b', 'user-stroke', 0, 50),
      points: [
        { ...point(150, 0), time: 2 },
        { ...point(200, 50), time: 3 },
      ],
    };
    const session = createSession([
      { ...surface('a', 600), strokes: [linkedA] },
      { ...surface('b', 400), strokes: [linkedB] },
    ]).session;

    const rendered = session.snapshot().surface.strokes;
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({
      id: 'user-stroke',
      points: [{ y: 550 }, { y: 600 }, { y: 650 }],
    });
  });

  it('keeps temporal path order when one stroke leaves and later re-enters the same chunk', () => {
    const session = createSession([surface('a', 100), surface('b', 100)]).session;
    session.addStroke({
      color: '#4f46d8',
      id: 'looping-stroke',
      points: [
        { ...point(10, 50), time: 1 },
        { ...point(20, 100), time: 2 },
        { ...point(30, 150), time: 3 },
        { ...point(40, 100), time: 4 },
        { ...point(50, 50), time: 5 },
      ],
      tool: 'pen',
      width: 4,
    });

    const points = session.snapshot().surface.strokes[0]?.points;

    expect(points?.map(({ time }) => time)).toEqual([1, 2, 3, 4, 5]);
    expect(points?.map(({ y }) => y)).toEqual([50, 100, 150, 100, 50]);
  });

  it('does not include needs-rebase or unanchored geometry in the composite render', () => {
    const session = createSession([
      { ...surface('a', 600), status: 'needs-rebase', strokes: [fragment('a-1', 'lost', 1, 2)] },
      { ...surface('b', 400), status: 'unanchored', strokes: [fragment('b-1', 'lost-2', 1, 2)] },
    ]).session;

    expect(session.snapshot().surface.strokes).toEqual([]);
  });

  it('renders migrated v2 recovery records at their persisted origins without automatic hiding', () => {
    const needsRebase: InkSurfaceRecord = {
      ...surface('a', 600),
      layout: { ...surface('a', 600).layout, originY: 0 },
      schemaVersion: 2,
      status: 'needs-rebase',
      strokes: [fragment('a-1', 'preserved-a', 10, 20)],
    };
    const unanchored: InkSurfaceRecord = {
      ...surface('b', 400),
      layout: { ...surface('b', 400).layout, originY: 600 },
      schemaVersion: 2,
      status: 'unanchored',
      strokes: [fragment('b-1', 'preserved-b', 10, 20)],
    };

    const rendered = createSession([needsRebase, unanchored]).session.snapshot().surface.strokes;

    expect(rendered.map((stroke) => stroke.id)).toEqual(['preserved-a', 'preserved-b']);
    expect(rendered[1]?.points[0]?.y).toBe(610);
  });

  it('keeps drawing intent and reports the failing bounded write on exit', async () => {
    const writer = new RecordingWriter('b');
    const session = new InkDocumentSession({
      onChange: () => undefined,
      surfaces: [surface('a', 600), surface('b', 400)],
      writer,
    });
    session.addStroke(stroke('user-stroke', 550, 650));

    await expect(session.exit()).rejects.toThrow('b unavailable');

    expect(session.snapshot().surface.strokes).toHaveLength(1);
    expect(session.snapshot().persistence).toMatchObject({ kind: 'error' });
  });

  it('retries one failed atomic exit without discarding the live cross-chunk move', async () => {
    const writer = new FailOnceAtomicWriter();
    const session = new InkDocumentSession({
      onChange: () => undefined,
      surfaces: [surface('a', 600), surface('b', 400)],
      writer,
    });
    session.addStroke(stroke('user-stroke', 550, 650));

    await expect(session.exit()).rejects.toThrow('batch unavailable');
    const liveAfterFailure = session.snapshot().surface.strokes;
    await session.retry();

    expect(writer.attempts).toBe(2);
    expect(writer.attemptedExpectedBases).toMatchObject([
      [
        { id: 'a', revision: 1 },
        { id: 'b', revision: 1 },
      ],
      [
        { id: 'a', revision: 1 },
        { id: 'b', revision: 1 },
      ],
    ]);
    expect(writer.attemptedRecords).toMatchObject([
      [
        { id: 'a', revision: 2 },
        { id: 'b', revision: 2 },
      ],
      [
        { id: 'a', revision: 2 },
        { id: 'b', revision: 2 },
      ],
    ]);
    expect(writer.records.map((record) => record.id).sort()).toEqual(['a', 'b']);
    expect(session.snapshot().surface.strokes).toEqual(liveAfterFailure);
    expect(session.snapshot().state).toEqual({ kind: 'reading' });
  });

  it('undoes and redoes a crossing user stroke as one command across all fragments', async () => {
    const { session, writer } = createSession([surface('a', 600), surface('b', 400)]);
    session.addStroke(stroke('user-stroke', 550, 650));

    expect(session.canUndo()).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.snapshot().surface.strokes).toEqual([]);
    expect(session.canRedo()).toBe(true);
    expect(session.redo()).toBe(true);
    expect(session.snapshot().surface.strokes).toHaveLength(1);
    await session.background();

    expect(writer.records.slice(-2).map((record) => record.strokes)).toMatchObject([
      [{ linkedStrokeId: 'user-stroke' }],
      [{ linkedStrokeId: 'user-stroke' }],
    ]);
  });

  it('hit-erases linked fragments as one command and undo restores them', () => {
    const linkedA: InkStroke = {
      ...fragment('fragment-a', 'user-stroke', 550, 600),
      points: [point(100, 550), point(150, 600)],
    };
    const linkedB: InkStroke = {
      ...fragment('fragment-b', 'user-stroke', 0, 50),
      points: [point(150, 0), point(200, 50)],
    };
    const session = createSession([
      { ...surface('a', 600), strokes: [linkedA] },
      { ...surface('b', 400), strokes: [linkedB] },
    ]).session;

    expect(session.eraseStrokeAt(point(151, 601), 8)).toBe('user-stroke');
    expect(session.snapshot().surface.strokes).toEqual([]);
    expect(session.undo()).toBe(true);
    expect(session.snapshot().surface.strokes).toHaveLength(1);
  });

  it('selects one linked logical stroke without persisting selection chrome', () => {
    const session = createSession([surface('a', 600), surface('b', 400)]).session;
    session.addStroke(stroke('user-stroke', 550, 650));

    expect(session.selectStrokeAt(point(151, 601), 8)).toEqual(['user-stroke']);
    expect(session.selectedStrokeIds()).toEqual(['user-stroke']);
    expect(JSON.stringify(session.snapshot().surface)).not.toContain('selected');
  });

  it('hit-tests transient hover without selecting or dirtying a stroke', async () => {
    const { session, writer } = createSession([surface('a', 600)]);
    session.addStroke(stroke('hovered', 100, 120));
    await session.background();
    writer.records.length = 0;

    expect(session.strokeIdAt(point(100, 100), 8)).toBe('hovered');
    expect(session.selectedStrokeIds()).toEqual([]);
    await session.background();
    expect(writer.records).toEqual([]);
  });

  it('supports additive toggle selection and clears it from empty workspace', () => {
    const session = createSession([surface('a', 600), surface('b', 400)]).session;
    session.addStroke(stroke('first', 100, 120));
    session.addStroke(stroke('second', 300, 320));

    session.selectStrokeAt(point(100, 100), 8);
    session.selectStrokeAt(point(100, 300), 8, true);
    expect(session.selectedStrokeIds()).toEqual(['first', 'second']);

    session.selectStrokeAt(point(100, 100), 8, true);
    expect(session.selectedStrokeIds()).toEqual(['second']);

    session.selectStrokeAt(point(900, 900), 8);
    expect(session.selectedStrokeIds()).toEqual([]);
  });

  it('clears transient selection without mutating or persisting strokes', () => {
    const { session, writer } = createSession([surface('a', 600)]);
    session.addStroke(stroke('selected', 100, 120));
    session.selectStrokeAt(point(100, 100), 8);

    expect(session.clearSelection()).toBe(true);
    expect(session.selectedStrokeIds()).toEqual([]);
    expect(session.clearSelection()).toBe(false);
    expect(writer.records).toEqual([]);
  });

  it('previews one shared selection translation in memory and cancel restores the snapshot', () => {
    const { session, writer } = createSession([surface('a', 600), surface('b', 400)]);
    session.addStroke(stroke('selected', 100, 120));
    session.selectStrokeAt(point(100, 100), 8);
    const before = session.snapshot().surface.strokes;

    expect(session.previewSelectionMove(25, 30)).toEqual({ dx: 25, dy: 30 });
    expect(session.snapshot().surface.strokes[0]?.points[0]).toMatchObject({ x: 125, y: 130 });
    expect(writer.records).toEqual([]);

    expect(session.cancelSelectionMove()).toBe(true);
    expect(session.snapshot().surface.strokes).toEqual(before);
  });

  it('commits a cross-chunk move as one undoable command and preserves logical identity', () => {
    const session = createSession([surface('a', 600), surface('b', 400)]).session;
    session.addStroke(stroke('selected', 550, 650));
    session.selectStrokeAt(point(151, 601), 8);
    session.previewSelectionMove(20, 100);

    expect(session.commitSelectionMove()).toBe(true);
    const moved = session.snapshot().surface.strokes[0];
    expect(moved?.id).toBe('selected');
    expect(moved?.points[0]).toMatchObject({ x: 120, y: 650 });
    expect(moved?.points.at(-1)).toMatchObject({ x: 220, y: 750 });

    expect(session.undo()).toBe(true);
    const restored = session.snapshot().surface.strokes[0];
    expect(restored?.id).toBe('selected');
    expect(restored?.points[0]).toMatchObject({ x: 100, y: 550 });
    expect(restored?.points.at(-1)).toMatchObject({ x: 200, y: 650 });
    expect(session.redo()).toBe(true);
    expect(session.snapshot().surface.strokes[0]?.id).toBe('selected');
  });

  it('flushes a cross-chunk move through one atomic writer operation', async () => {
    const { session, writer } = createSession([surface('a', 600), surface('b', 400)]);
    session.addStroke(stroke('selected', 550, 650));
    await session.background();
    writer.atomicBatches.length = 0;
    session.selectStrokeAt(point(151, 601), 8);
    session.previewSelectionMove(20, 100);
    session.commitSelectionMove();

    await session.background();

    expect(writer.atomicBatches).toHaveLength(1);
    expect(writer.atomicBatches[0]?.map((record) => record.id).sort()).toEqual(['a', 'b']);
  });

  it('keeps a crossing command atomic while an older single-chunk revision is in flight', async () => {
    const writer = new ControlledFirstWriter();
    const session = new InkDocumentSession({
      debounceMs: 10_000,
      surfaces: [surface('a', 600), surface('b', 400)],
      writer,
    });
    session.addStroke(stroke('older-top', 100, 150));
    const firstFlush = session.background();
    await writer.firstWriteStarted;

    session.addStroke(stroke('crossing-newer', 550, 650));
    const secondFlush = session.background();
    await new Promise((resolve) => setTimeout(resolve, 10));
    writer.releaseFirstWrite();
    await Promise.all([firstFlush, secondFlush]);

    expect(writer.atomicBatches).toHaveLength(1);
    expect(writer.atomicBatches[0]?.map((record) => record.id).sort()).toEqual(['a', 'b']);
    expect(new Map(writer.atomicBatches[0]?.map((record) => [record.id, record.revision]))).toEqual(
      new Map([
        ['a', 3],
        ['b', 2],
      ]),
    );
  });

  it('rejects every queued fragment instead of committing half a command after an older failure', async () => {
    const writer = new ControlledFirstWriter(true);
    const session = new InkDocumentSession({
      debounceMs: 10_000,
      surfaces: [surface('a', 600), surface('b', 400)],
      writer,
    });
    session.addStroke(stroke('older-top', 100, 150));
    const firstFlush = session.background();
    await writer.firstWriteStarted;

    session.addStroke(stroke('crossing-newer', 550, 650));
    const secondFlush = session.background();
    await new Promise((resolve) => setTimeout(resolve, 10));
    writer.releaseFirstWrite();
    const results = await Promise.allSettled([firstFlush, secondFlush]);

    expect(results.map(({ status }) => status)).toEqual(['rejected', 'rejected']);
    expect(writer.singleWriteAttempts).toBe(1);
    expect(writer.atomicBatches).toEqual([]);
    expect(session.recoverySnapshot()).toMatchObject({ requiresRecovery: true });
  });

  it('allows horizontal margin movement while clamping the shared vertical delta', () => {
    const session = createSession([surface('a', 600), surface('b', 400)]).session;
    session.addStroke(stroke('top', 10, 30));
    session.addStroke(stroke('lower', 300, 320));
    session.selectStrokeAt(point(100, 10), 8);
    session.selectStrokeAt(point(100, 300), 8, true);

    expect(session.previewSelectionMove(-500, -500)).toEqual({ dx: -500, dy: -10 });
    const [top, lower] = session.snapshot().surface.strokes;
    expect(top?.points[0]).toMatchObject({ x: -400, y: 0 });
    expect(lower?.points[0]).toMatchObject({ x: -400, y: 290 });
  });

  it('reloads to the same composite after persisted undo and redo boundaries', async () => {
    const { session, writer } = createSession([surface('a', 600), surface('b', 400)]);
    session.addStroke(stroke('user-stroke', 550, 650));
    await session.background();
    session.undo();
    await session.background();
    session.redo();
    await session.background();
    const latest = ['a', 'b'].map((id) =>
      [...writer.records].reverse().find((record) => record.id === id),
    );
    if (latest.some((record) => record === undefined))
      throw new Error('Missing persisted surface.');

    const reloaded = createSession(latest as InkSurfaceRecord[]).session;

    expect(reloaded.snapshot().surface.strokes).toEqual(session.snapshot().surface.strokes);
  });
});

function createSession(surfaces: readonly InkSurfaceRecord[]) {
  const writer = new RecordingWriter();
  return {
    session: new InkDocumentSession({ onChange: () => undefined, surfaces, writer }),
    writer,
  };
}

class RecordingWriter {
  readonly atomicBatches: InkSurfaceRecord[][] = [];
  readonly records: InkSurfaceRecord[] = [];

  constructor(private readonly failSurfaceId?: string) {}

  updateSurface(record: InkSurfaceRecord): Promise<void> {
    if (record.id === this.failSurfaceId) {
      return Promise.reject(new Error(`${record.id} unavailable`));
    }
    this.records.push(record);
    return Promise.resolve();
  }

  updateSurfacesAtomically(records: readonly InkSurfaceRecord[]): Promise<void> {
    const failed = records.find((record) => record.id === this.failSurfaceId);
    if (failed !== undefined) return Promise.reject(new Error(`${failed.id} unavailable`));
    this.atomicBatches.push([...records]);
    this.records.push(...records);
    return Promise.resolve();
  }
}

class FailOnceAtomicWriter {
  attempts = 0;
  readonly attemptedExpectedBases: Array<readonly InkSurfaceRecord[] | undefined> = [];
  readonly attemptedRecords: Array<readonly InkSurfaceRecord[]> = [];
  readonly records: InkSurfaceRecord[] = [];

  updateSurface(record: InkSurfaceRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }

  updateSurfacesAtomically(
    records: readonly InkSurfaceRecord[],
    expectedBases?: readonly InkSurfaceRecord[],
  ): Promise<void> {
    this.attempts += 1;
    this.attemptedRecords.push(records);
    this.attemptedExpectedBases.push(expectedBases);
    if (this.attempts === 1) return Promise.reject(new Error('batch unavailable'));
    this.records.push(...records);
    return Promise.resolve();
  }
}

class ControlledFirstWriter {
  readonly atomicBatches: InkSurfaceRecord[][] = [];
  readonly firstWriteStarted: Promise<void>;
  singleWriteAttempts = 0;
  private markFirstWriteStarted!: () => void;
  private releaseFirst!: () => void;
  private readonly released: Promise<void>;
  private writes = 0;

  constructor(private readonly failFirst = false) {
    this.firstWriteStarted = new Promise((resolve) => {
      this.markFirstWriteStarted = resolve;
    });
    this.released = new Promise((resolve) => {
      this.releaseFirst = resolve;
    });
  }

  async updateSurface(): Promise<void> {
    this.writes += 1;
    this.singleWriteAttempts += 1;
    if (this.writes !== 1) return;
    this.markFirstWriteStarted();
    await this.released;
    if (this.failFirst) throw new Error('first canonical write failed');
  }

  updateSurfacesAtomically(records: readonly InkSurfaceRecord[]): Promise<void> {
    this.atomicBatches.push([...records]);
    return Promise.resolve();
  }

  releaseFirstWrite(): void {
    this.releaseFirst();
  }
}

function surface(id: string, height: number): InkSurfaceRecord {
  return {
    binding: {
      blockFingerprints: [`block-${id}`],
      headingPath: [id],
      sectionFingerprint: `section-${id}`,
      sourceEnd: 100,
      sourceStart: 0,
    },
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Ink.md',
    id,
    layout: {
      blockFingerprints: [`block-${id}`],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: height,
      logicalWidth: 960,
      sourceRevision: 'source',
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

function stroke(id: string, startY: number, endY: number): InkStroke {
  return {
    color: '#4f46d8',
    id,
    points: [point(100, startY), point(200, endY)],
    tool: 'pen',
    width: 4,
  };
}

function fragment(id: string, linkedStrokeId: string, startY: number, endY: number): InkStroke {
  return { ...stroke(id, startY, endY), linkedStrokeId };
}

function point(x: number, y: number) {
  return { pressure: 0.5, time: x + y, x, y };
}
