import { afterEach, describe, expect, it, vi } from 'vitest';

import { SharedInkStrokeGeometry } from '../domain/ink-shared-stroke-geometry';
import {
  encodeInkSurfaceRecord,
  type InkStroke,
  type InkSurfaceRecord,
} from '../domain/ink-surface';
import { splitInkStrokeIntoSurfaceFragments } from '../domain/ink-surface-layout';
import { InkDocumentSession } from './ink-document-session';

describe('continuous Ink document session', () => {
  afterEach(() => vi.useRealTimers());
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

  it('keeps one crossing Add live without touching bounded canonical storage synchronously', () => {
    const { session, writer } = createSession([surface('a', 600), surface('b', 400)]);

    session.addStroke(stroke('crossing', 550, 650));

    expect(session.read()).toMatchObject({ strokeCount: 1 });
    expect(session.read().strokes[0]?.stroke.id).toBe('crossing');
    expect(writer.records).toEqual([]);
    expect(writer.atomicBatches).toEqual([]);
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

  it('materializes an encodable schema-v3 cold snapshot with a document origin', () => {
    const session = createSession([
      v3Surface('bottom', 600, 400),
      v3Surface('top', 0, 600),
    ]).session;

    const cold = session.materializeColdSnapshot().surface;

    expect(cold.layout.originY).toBe(0);
    expect(() => encodeInkSurfaceRecord(cold)).not.toThrow();
  });

  it.each([1, 2] as const)(
    'fails closed instead of composing active schema-v%d and schema-v3 surfaces',
    (legacySchemaVersion) => {
      const legacy = surface('legacy', 600);
      const legacySurface: InkSurfaceRecord = {
        ...legacy,
        layout: {
          ...legacy.layout,
          ...(legacySchemaVersion === 1 ? {} : { originY: 0 }),
        },
        schemaVersion: legacySchemaVersion,
      };

      expect(() => createSession([legacySurface, v3Surface('physical', 600, 400)])).toThrow(
        /mixed Ink schema.*semantic conflict/iu,
      );
    },
  );

  it.each([1, 2] as const)(
    'keeps normalized legacy brush metadata through schema-v%d move, Undo, and Redo',
    (schemaVersion) => {
      const legacy: InkStroke = {
        ...stroke('normalized-legacy', 100, 120),
        brushRenderVersion: 'legacy-round-v1',
        inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
      };
      const base = surface('a', 600);
      const session = createSession([
        {
          ...base,
          layout: {
            ...base.layout,
            ...(schemaVersion === 1 ? {} : { originY: 0 }),
          },
          schemaVersion,
          strokes: [legacy],
        },
      ]).session;

      expect(
        session.apply({
          dx: 10,
          dy: 20,
          id: `move-normalized-v${schemaVersion}`,
          ids: ['normalized-legacy'],
          kind: 'move',
        }).kind,
      ).toBe('committed');
      expect(session.snapshot().surface.strokes[0]).toMatchObject({
        brushRenderVersion: 'legacy-round-v1',
        inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
      });
      expect(session.undo()).toBe(true);
      expect(session.snapshot().surface.strokes[0]).toMatchObject({
        brushRenderVersion: 'legacy-round-v1',
        inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
      });
      expect(session.redo()).toBe(true);
      expect(session.snapshot().surface.strokes[0]).toMatchObject({
        brushRenderVersion: 'legacy-round-v1',
        inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
      });
    },
  );

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
    const beforeExtension = session.read();

    expect(session.ensureMinimumHeight(1_600)).toBe(true);
    expect(session.read()).toMatchObject({
      generation: beforeExtension.generation + 1,
      logicalHeight: 1_600,
    });
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

  it('preserves one physical brush identity through cold split, Undo, Redo, and reconstruction', async () => {
    const { session, writer } = createSession([v3Surface('a', 0, 600), v3Surface('b', 600, 400)]);
    const authored = physicalStroke('physical-crossing', 550, 650);

    session.addStroke(authored);

    expect(session.snapshot().surface).toMatchObject({
      schemaVersion: 3,
      strokes: [physicalIdentity('physical-crossing')],
    });
    await session.background();
    expect(writer.records.flatMap(({ strokes }) => strokes)).toMatchObject([
      physicalIdentity('physical-crossing', 'physical-crossing-a'),
      physicalIdentity('physical-crossing', 'physical-crossing-b'),
    ]);

    expect(session.undo()).toBe(true);
    expect(session.snapshot().surface.strokes).toEqual([]);
    expect(session.redo()).toBe(true);
    expect(session.snapshot().surface.strokes).toMatchObject([
      physicalIdentity('physical-crossing'),
    ]);

    const reloaded = createSession(writer.records).session;
    expect(reloaded.snapshot().surface.strokes).toMatchObject([
      physicalIdentity('physical-crossing'),
    ]);
    const reloadedStroke = reloaded.snapshot().surface.strokes[0];
    expect(reloadedStroke?.points).toEqual(authored.points);
    if (reloadedStroke === undefined) throw new Error('Missing reloaded physical Logical Stroke.');
    const geometry = new SharedInkStrokeGeometry();
    const activeGeometry = geometry.compile(authored);
    const reloadedGeometry = geometry.compile(reloadedStroke);
    if (activeGeometry.kind !== 'unpublished' || reloadedGeometry.kind !== 'unpublished') {
      throw new Error('Expected unpublished physical geometry in the HAT-only lane.');
    }
    expect(reloadedGeometry.geometry.traceDigest).toBe(activeGeometry.geometry.traceDigest);
    expect(reloadedGeometry.geometry.geometryDigest).toBe(activeGeometry.geometry.geometryDigest);
  });

  it('fails closed when loaded schema-v3 fragments omit or disagree on complete brush identity', () => {
    const missing = {
      ...stroke('physical-crossing', 550, 600),
      id: 'physical-crossing-a',
      linkedStrokeId: 'physical-crossing',
    };
    expect(() => createSession([{ ...v3Surface('a', 0, 600), strokes: [missing] }])).toThrow(
      /brush metadata/u,
    );

    const fragments = splitInkStrokeIntoSurfaceFragments({
      stroke: physicalStroke('physical-crossing', 550, 650),
      surfaces: [
        { endY: 600, id: 'a', logicalHeight: 600, startY: 0 },
        { endY: 1_000, id: 'b', logicalHeight: 400, startY: 600 },
      ],
    });
    const first = fragments.find(({ surfaceId }) => surfaceId === 'a')?.stroke;
    const bottom = fragments.find(({ surfaceId }) => surfaceId === 'b')?.stroke;
    if (first === undefined || bottom === undefined) {
      throw new Error('Missing physical mismatch fixture fragment.');
    }
    const second = {
      ...bottom,
      color: '#445566',
    };
    expect(() =>
      createSession([
        { ...v3Surface('a', 0, 600), strokes: [first] },
        { ...v3Surface('b', 600, 400), strokes: [second] },
      ]),
    ).toThrow(/brush identity/u);
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

  it('erases every enclosed logical stroke as one undoable command', () => {
    const session = createSession([
      {
        ...surface('a', 600),
        strokes: [
          { ...stroke('inside-a', 20, 40), points: [point(20, 20), point(40, 40)] },
          { ...stroke('inside-b', 60, 80), points: [point(60, 60), point(80, 80)] },
          { ...stroke('crossing', 50, 50), points: [point(50, 50), point(150, 50)] },
          { ...stroke('outside', 140, 160), points: [point(140, 140), point(160, 160)] },
        ],
      },
    ]).session;
    const loop = [point(0, 0), point(100, 0), point(100, 100), point(0, 100)];

    expect(session.eraseStrokesInPolygon(loop)).toEqual(['inside-a', 'inside-b']);
    expect(session.snapshot().surface.strokes.map(({ id }) => id)).toEqual(['crossing', 'outside']);

    expect(session.undo()).toBe(true);
    expect(session.snapshot().surface.strokes.map(({ id }) => id)).toEqual([
      'inside-a',
      'inside-b',
      'crossing',
      'outside',
    ]);
    expect(session.redo()).toBe(true);
    expect(session.snapshot().surface.strokes.map(({ id }) => id)).toEqual(['crossing', 'outside']);
  });

  it('keeps history and persistence unchanged when a closed loop matches nothing', () => {
    const { session, writer } = createSession([
      {
        ...surface('a', 600),
        strokes: [{ ...stroke('saved', 20, 40), points: [point(20, 20), point(40, 40)] }],
      },
    ]);
    const emptyLoop = [point(200, 200), point(300, 200), point(300, 300), point(200, 300)];

    expect(session.eraseStrokesInPolygon(emptyLoop)).toEqual([]);
    expect(session.canUndo()).toBe(false);
    expect(session.canRedo()).toBe(false);
    expect(writer.records).toEqual([]);
    expect(session.snapshot().surface.strokes.map(({ id }) => id)).toEqual(['saved']);
  });

  it('preserves an available redo command when a closed loop matches nothing', () => {
    const session = createSession([
      {
        ...surface('a', 600),
        strokes: [{ ...stroke('saved', 20, 40), points: [point(20, 20), point(40, 40)] }],
      },
    ]).session;
    session.eraseStrokeAt(point(20, 20), 8);
    session.undo();
    const emptyLoop = [point(200, 200), point(300, 200), point(300, 300), point(200, 300)];

    expect(session.canRedo()).toBe(true);
    expect(session.eraseStrokesInPolygon(emptyLoop)).toEqual([]);
    expect(session.canRedo()).toBe(true);
  });

  it('atomically removes every linked fragment enclosed across chunks', async () => {
    const linkedA: InkStroke = {
      ...fragment('fragment-a', 'user-stroke', 550, 600),
      points: [point(100, 550), point(150, 600)],
    };
    const linkedB: InkStroke = {
      ...fragment('fragment-b', 'user-stroke', 0, 50),
      points: [point(150, 0), point(200, 50)],
    };
    const { session, writer } = createSession([
      { ...surface('a', 600), strokes: [linkedA] },
      { ...surface('b', 400), strokes: [linkedB] },
    ]);
    const loop = [point(50, 500), point(250, 500), point(250, 700), point(50, 700)];

    expect(session.eraseStrokesInPolygon(loop)).toEqual(['user-stroke']);
    expect(session.snapshot().surface.strokes).toEqual([]);
    await session.background();

    expect(writer.atomicBatches).toHaveLength(1);
    expect(writer.atomicBatches[0]?.map(({ strokes }) => strokes)).toEqual([[], []]);
  });

  it('retains a complete live circle erase when its atomic write fails and retries it', async () => {
    const linkedA: InkStroke = {
      ...fragment('fragment-a', 'user-stroke', 550, 600),
      points: [point(100, 550), point(150, 600)],
    };
    const linkedB: InkStroke = {
      ...fragment('fragment-b', 'user-stroke', 0, 50),
      points: [point(150, 0), point(200, 50)],
    };
    const writer = new FailOnceAtomicWriter();
    const session = new InkDocumentSession({
      surfaces: [
        { ...surface('a', 600), strokes: [linkedA] },
        { ...surface('b', 400), strokes: [linkedB] },
      ],
      writer,
    });
    const loop = [point(50, 500), point(250, 500), point(250, 700), point(50, 700)];

    expect(session.eraseStrokesInPolygon(loop)).toEqual(['user-stroke']);
    await expect(session.background()).rejects.toThrow('batch unavailable');
    expect(session.snapshot().surface.strokes).toEqual([]);
    expect(session.read().persistence).toMatchObject({ kind: 'error' });

    await session.retry();
    expect(session.snapshot().surface.strokes).toEqual([]);
    expect(writer.attempts).toBe(2);
    expect(writer.records.map(({ strokes }) => strokes)).toEqual([[], []]);
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

  it('uses physical nib coverage for viewport queries and point selection', () => {
    const pressureTap: InkStroke = {
      brushRenderVersion: 'pen-physical-v1',
      color: '#112233',
      id: 'pressure-tap',
      inputProfile: { pressure: 'measured', tilt: 'unavailable' },
      points: [
        {
          orientation: { kind: 'unavailable' },
          pressure: 1,
          pressureKind: 'measured',
          time: 0,
          x: 100,
          y: 100,
        },
      ],
      tool: 'pen',
      width: 4,
    };
    const session = createSession([v3Surface('physical', 0, 600, [pressureTap])]).session;

    expect(session.read().strokes[0]?.bounds.height).toBeGreaterThan(4);
    expect(
      session.query({ height: 0.2, width: 0.2, x: 99.9, y: 102.4 }).map(({ id }) => id),
    ).toEqual(['pressure-tap']);
    expect(session.strokeIdAt(point(100, 102.4), 0)).toBe('pressure-tap');
  });

  it('reuses trusted completed physical bounds during the add transaction', () => {
    const authored = physicalStroke('prepared-physical', 100, 120);
    const prepared = new SharedInkStrokeGeometry().compile(authored);
    if (!('geometry' in prepared)) throw new Error('Expected compiled physical geometry.');
    const compile = vi.spyOn(SharedInkStrokeGeometry.prototype, 'compile');
    const session = createSession([v3Surface('physical', 0, 600)]).session;

    expect(
      session.apply(
        { id: 'add-prepared-physical', kind: 'add', stroke: authored },
        prepared.geometry,
      ),
    ).toMatchObject({ kind: 'committed' });

    expect(compile).not.toHaveBeenCalled();
    expect(session.read().strokes[0]?.bounds).toEqual(prepared.geometry.bounds);
  });

  it('rejects mismatched prepared geometry before storage or live mutation', () => {
    const authored = physicalStroke('prepared-physical', 100, 120);
    const prepared = new SharedInkStrokeGeometry().compile(authored);
    if (!('geometry' in prepared)) throw new Error('Expected compiled physical geometry.');
    const writer = new RecordingWriter();
    const session = new InkDocumentSession({
      surfaces: [v3Surface('physical', 0, 600)],
      writer,
    });

    expect(() =>
      session.apply(
        { id: 'add-prepared-physical', kind: 'add', stroke: authored },
        { ...prepared.geometry, logicalStrokeId: 'forged-logical-stroke' },
      ),
    ).toThrow('Prepared Ink geometry does not match Logical Stroke prepared-physical.');
    expect(writer.records).toEqual([]);
    expect(session.read().strokeCount).toBe(0);
  });

  it('keeps an ordinary foreground pause memory-only until explicit exit', async () => {
    vi.useFakeTimers();
    const writer = new RecordingWriter();
    const session = new InkDocumentSession({
      surfaces: [v3Surface('physical', 0, 600)],
      writer,
    });

    session.addStroke(physicalStroke('done-save', 100, 120));
    expect(writer.records).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(writer.records).toEqual([]);

    const exit = session.exit();
    await vi.runAllTimersAsync();
    await exit;
    expect(writer.records).toMatchObject([{ strokes: [{ id: 'done-save' }] }]);
  });

  it('best-effort saves only after one complete sustained-inactivity window', async () => {
    vi.useFakeTimers();
    const writer = new RecordingWriter();
    const session = new InkDocumentSession({
      inactivityMs: 30_000,
      surfaces: [v3Surface('physical', 0, 600)],
      writer,
    });

    session.addStroke(physicalStroke('idle-save', 100, 120));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(writer.records).toEqual([]);

    session.noteUserInteraction();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(writer.records).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(writer.records).toMatchObject([{ strokes: [{ id: 'idle-save' }] }]);
  });

  it('restarts sustained inactivity when a new document command arrives', async () => {
    vi.useFakeTimers();
    const writer = new RecordingWriter();
    const session = new InkDocumentSession({
      inactivityMs: 30_000,
      surfaces: [v3Surface('physical', 0, 600)],
      writer,
    });

    session.addStroke(physicalStroke('idle-first', 100, 120));
    await vi.advanceTimersByTimeAsync(20_000);
    session.addStroke(physicalStroke('idle-second', 140, 160));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(writer.records).toEqual([]);

    await vi.advanceTimersByTimeAsync(20_000);
    await vi.runAllTimersAsync();
    expect(writer.records.at(-1)?.strokes.map(({ id }) => id)).toEqual([
      'idle-first',
      'idle-second',
    ]);
  });

  it('keeps historical Eraser records canonical but out of the visible read model', () => {
    const historicalEraser: InkStroke = {
      color: '#ffffff',
      id: 'historical-eraser',
      points: [point(100, 100), point(120, 120)],
      tool: 'eraser',
      width: 16,
    };
    const session = createSession([
      v3Surface('with-historical-eraser', 0, 600, [historicalEraser]),
    ]).session;

    expect(session.read()).toMatchObject({ strokeCount: 0, strokes: [] });
    expect(session.query({ height: 40, width: 40, x: 90, y: 90 })).toEqual([]);
    expect(session.strokeIdAt(point(110, 110), 20)).toBeNull();
    expect(session.materializeColdSnapshot().surface.strokes).toEqual([historicalEraser]);
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

  it('deletes the selected logical strokes as one undoable command and clears selection', () => {
    const session = createSession([surface('a', 600), surface('b', 400)]).session;
    session.addStroke(stroke('first', 100, 120));
    session.addStroke(stroke('crossing', 550, 650));
    session.addStroke(stroke('retained', 800, 820));
    session.selectStrokeAt(point(100, 100), 8);
    session.selectStrokeAt(point(151, 601), 8, true);

    expect(session.deleteSelectedStrokes()).toEqual(['first', 'crossing']);
    expect(session.selectedStrokeIds()).toEqual([]);
    expect(session.snapshot().surface.strokes.map(({ id }) => id)).toEqual(['retained']);

    expect(session.undo()).toBe(true);
    expect(session.snapshot().surface.strokes.map(({ id }) => id)).toEqual([
      'first',
      'crossing',
      'retained',
    ]);
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

  it('preserves physical version and input profile through move, restyle, Undo, and Redo', async () => {
    const authored: InkStroke = {
      ...physicalStroke('physical-crossing', 550, 650),
      points: [
        { ...physicalPoint(100, 550), time: 1 },
        { ...physicalPoint(150, 600), time: 2 },
        { ...physicalPoint(200, 650), time: 3 },
      ],
    };
    const fragments = splitInkStrokeIntoSurfaceFragments({
      stroke: authored,
      surfaces: [
        { endY: 600, id: 'a', logicalHeight: 600, startY: 0 },
        { endY: 1_000, id: 'b', logicalHeight: 400, startY: 600 },
      ],
    });
    const first = fragments.find(({ surfaceId }) => surfaceId === 'a')?.stroke;
    const second = fragments.find(({ surfaceId }) => surfaceId === 'b')?.stroke;
    if (first === undefined || second === undefined) {
      throw new Error('Missing physical move fixture fragment.');
    }
    const { session, writer } = createSession([
      { ...v3Surface('a', 0, 600), strokes: [first] },
      { ...v3Surface('b', 600, 400), strokes: [second] },
    ]);

    session.selectStrokeAt(point(151, 601), 8);
    session.previewSelectionMove(20, 20);
    expect(session.commitSelectionMove()).toBe(true);
    expect(session.snapshot().surface.strokes).toMatchObject([
      physicalIdentity('physical-crossing'),
    ]);
    await session.background();
    expect(writer.records.slice(-2).flatMap(({ strokes }) => strokes)).toMatchObject([
      physicalIdentity('physical-crossing', 'physical-crossing-a'),
      physicalIdentity('physical-crossing', 'physical-crossing-b'),
    ]);

    const restyled = session.apply({
      id: 'restyle-physical',
      ids: ['physical-crossing'],
      kind: 'restyle',
      style: { color: '#445566', width: 6 },
    });
    expect(restyled.kind).toBe('committed');
    expect(session.snapshot().surface.strokes).toMatchObject([
      {
        ...physicalIdentity('physical-crossing'),
        color: '#445566',
        width: 6,
      },
    ]);

    expect(session.undo()).toBe(true);
    expect(session.snapshot().surface.strokes).toMatchObject([
      physicalIdentity('physical-crossing'),
    ]);
    expect(session.redo()).toBe(true);
    expect(session.snapshot().surface.strokes).toMatchObject([
      {
        ...physicalIdentity('physical-crossing'),
        color: '#445566',
        width: 6,
      },
    ]);
  });

  it('rejects a physical restyle that would mismatch tool and immutable brush version', () => {
    const physical = physicalStroke('physical-pen', 100, 120);
    const session = createSession([{ ...v3Surface('a', 0, 600), strokes: [physical] }]).session;
    const before = session.snapshot().surface;

    expect(() =>
      session.apply({
        id: 'invalid-physical-restyle',
        ids: ['physical-pen'],
        kind: 'restyle',
        style: { tool: 'highlighter' },
      }),
    ).toThrow(/brush metadata/u);
    expect(session.snapshot().surface).toEqual(before);
    expect(session.canUndo()).toBe(false);
  });

  it('keeps legacy-round metadata valid when restyling between visible legacy tools', () => {
    const legacy: InkStroke = {
      ...stroke('legacy', 100, 120),
      brushRenderVersion: 'legacy-round-v1',
      inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
    };
    const session = createSession([{ ...v3Surface('a', 0, 600), strokes: [legacy] }]).session;

    expect(
      session.apply({
        id: 'legacy-tool-restyle',
        ids: ['legacy'],
        kind: 'restyle',
        style: { tool: 'highlighter' },
      }).kind,
    ).toBe('committed');
    expect(session.snapshot().surface.strokes[0]).toMatchObject({
      brushRenderVersion: 'legacy-round-v1',
      inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
      tool: 'highlighter',
    });
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
    expect(session.read().persistence).toMatchObject({ kind: 'error' });
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

    expect(reloaded.snapshot().surface.strokes).toMatchObject([
      {
        id: 'user-stroke',
        points: [
          { x: 100, y: 550 },
          { x: 150, y: 600 },
          { x: 200, y: 650 },
        ],
      },
    ]);
    expect(session.snapshot().surface.strokes[0]?.points).toHaveLength(2);
  });

  it.each(['pen', 'highlighter'] as const)(
    'normalizes an unversioned %s capture at the schema-v3 live boundary',
    async (tool) => {
      const writer = new RecordingWriter();
      const session = new InkDocumentSession({
        surfaces: [v3Surface('v3', 0, 600)],
        writer,
      });
      const authored: InkStroke = {
        ...stroke(`legacy-${tool}`, 100, 120),
        tool,
      };

      expect(session.apply({ id: `add-${tool}`, kind: 'add', stroke: authored })).toMatchObject({
        kind: 'committed',
      });

      expect(session.read().strokes[0]?.stroke).toMatchObject({
        brushRenderVersion: 'legacy-round-v1',
        inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
        tool,
      });
      await session.background();
      expect(writer.records.at(-1)?.strokes[0]).toMatchObject({
        brushRenderVersion: 'legacy-round-v1',
        inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
        tool,
      });
    },
  );
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

function v3Surface(
  id: string,
  originY: number,
  height: number,
  strokes: readonly InkStroke[] = [],
): InkSurfaceRecord {
  return {
    ...surface(id, height),
    layout: { ...surface(id, height).layout, originY },
    schemaVersion: 3,
    strokes,
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

function physicalStroke(id: string, startY: number, endY: number): InkStroke {
  return {
    brushRenderVersion: 'pen-physical-v1',
    color: '#112233',
    id,
    inputProfile: { pressure: 'measured', tilt: 'unavailable' },
    points: [physicalPoint(100, startY), physicalPoint(200, endY)],
    tool: 'pen',
    width: 4,
  };
}

function physicalIdentity(linkedId: string, fragmentId = linkedId) {
  return {
    brushRenderVersion: 'pen-physical-v1',
    color: '#112233',
    id: fragmentId,
    inputProfile: { pressure: 'measured', tilt: 'unavailable' },
    ...(fragmentId === linkedId ? {} : { linkedStrokeId: linkedId }),
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

function physicalPoint(x: number, y: number) {
  return {
    orientation: { kind: 'unavailable' as const },
    pressure: 0.5,
    pressureKind: 'measured' as const,
    time: x + y,
    x,
    y,
  };
}
