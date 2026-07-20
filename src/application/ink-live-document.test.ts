import { describe, expect, it, vi } from 'vitest';

import { InkBoundsIndex } from '../domain/ink-bounds-index';
import type { InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import {
  InkDocumentSession,
  type InkDocumentChange,
  type InkLogicalRect,
} from './ink-document-session';

describe('Ink Live Document', () => {
  it('keeps bounds-index byte accounting exact across incremental set/delete operations', () => {
    const index = new InkBoundsIndex<string>();

    index.set('a', { height: 1, width: 1, x: 0, y: 0 }, 'one');
    index.set('long-id', { height: 1, width: 1, x: 0, y: 2 }, 'two');
    expect(index.byteSizeEstimate).toBe(128 + 2 + 128 + 'long-id'.length * 2);

    index.set('a', { height: 2, width: 2, x: 1, y: 1 }, 'replacement');
    expect(index.byteSizeEstimate).toBe(128 + 2 + 128 + 'long-id'.length * 2);
    expect(index.delete('long-id')).toBe(true);
    expect(index.byteSizeEstimate).toBe(130);
    expect(index.deleteMany(['a', 'missing'])).toBe(1);
    expect(index.byteSizeEstimate).toBe(0);
  });

  it('batch-removes bounds entries while preserving the remaining query set', () => {
    const index = new InkBoundsIndex<string>();
    for (let item = 0; item < 1_000; item += 1) {
      index.set(`stroke-${item}`, { height: 2, width: 2, x: 0, y: item * 4 }, `stroke-${item}`);
    }

    expect(index.deleteMany(Array.from({ length: 600 }, (_value, item) => `stroke-${item}`))).toBe(
      600,
    );
    expect(index.query({ height: 4_000, width: 10, x: 0, y: 0 }).values).toHaveLength(400);
    expect(index.deleteMany(['missing', 'stroke-999'])).toBe(1);
    expect(index.query({ height: 4_000, width: 10, x: 0, y: 0 }).values).toHaveLength(399);
  });

  it('returns one stable read view with joined logical stroke references until the document changes', () => {
    const document = new InkDocumentSession({
      surfaces: [
        surface('top', 0, [fragment('top-fragment', 'crossing', 10, 550, 20, 600, 0)]),
        surface('bottom', 600, [fragment('bottom-fragment', 'crossing', 20, 0, 30, 50, 600)]),
      ],
      writer: {
        updateSurface: () => Promise.resolve(),
        updateSurfacesAtomically: () => Promise.resolve(),
      },
    });

    const first = document.read();
    const second = document.read();

    expect(second).toBe(first);
    expect(first).toMatchObject({
      generation: 0,
      logicalHeight: 1_200,
      logicalWidth: 704,
      strokeCount: 1,
    });
    expect([...first.strokes].map(({ stroke }) => stroke)).toMatchObject([
      {
        id: 'crossing',
        points: [{ y: 550 }, { y: 600 }, { y: 650 }],
      },
    ]);
    expect([...first.strokes][0]).toBe([...second.strokes][0]);
  });

  it('applies one crossing add as one logical change without rebuilding existing stroke refs', () => {
    const document = new InkDocumentSession({
      surfaces: [
        surface('top', 0, [fragment('saved-top', 'saved', 10, 100, 20, 120, 0)]),
        surface('bottom', 600, []),
      ],
      writer: {
        updateSurface: () => Promise.resolve(),
        updateSurfacesAtomically: () => Promise.resolve(),
      },
    });
    const before = document.read();
    const savedRef = [...before.strokes][0];

    const result = document.apply({
      id: 'add-crossing',
      kind: 'add',
      stroke: logicalStroke('crossing', 580, 620),
    });

    expect(result).toMatchObject({
      change: {
        addedIds: ['crossing'],
        bounds: [
          {
            id: 'crossing',
            newBounds: { height: 42, width: 12, x: 9, y: 579 },
            oldBounds: null,
          },
        ],
        commandId: 'add-crossing',
        generation: 1,
        removedIds: [],
        updatedIds: [],
      },
      kind: 'committed',
    });
    const after = document.read();
    expect(after).not.toBe(before);
    expect(document.read()).toBe(after);
    expect(after).toMatchObject({ generation: 1, strokeCount: 2 });
    expect([...after.strokes][0]).toBe(savedRef);
    expect([...after.strokes].map(({ id }) => id)).toEqual(['saved', 'crossing']);
  });

  it('keeps cold restyle, move, undo, redo, and erase materialization identical to the Live Document', () => {
    const initial = [
      surface('top', 0, [fragment('crossing-top', 'crossing', 10, 580, 15, 600, 0)]),
      surface('bottom', 600, [fragment('crossing-bottom', 'crossing', 15, 0, 20, 20, 600)]),
    ];
    const document = new InkDocumentSession({
      debounceMs: 60_000,
      surfaces: initial,
      writer: {
        updateSurface: () => Promise.resolve(),
        updateSurfacesAtomically: () => Promise.resolve(),
      },
    });
    const expectColdEqualsLive = (): void => {
      expect(document.materializeColdSnapshot().surface.strokes).toEqual(
        document.read().strokes.map(({ stroke }) => stroke),
      );
    };

    document.apply({
      id: 'restyle',
      ids: ['crossing'],
      kind: 'restyle',
      style: { color: '#ff0000', width: 8 },
    });
    expectColdEqualsLive();
    document.apply({ dx: 5, dy: -100, id: 'move', ids: ['crossing'], kind: 'move' });
    expectColdEqualsLive();
    document.apply({ id: 'undo-move', kind: 'undo' });
    expectColdEqualsLive();
    document.apply({ id: 'redo-move', kind: 'redo' });
    expectColdEqualsLive();
    document.apply({ id: 'erase', ids: ['crossing'], kind: 'erase' });
    expectColdEqualsLive();
  });

  it('queries an 800px viewport through bounded index work instead of scanning 10k strokes', () => {
    const strokes = Array.from({ length: 10_000 }, (_value, index): InkStroke => ({
      color: '#111111',
      id: `stroke-${index}`,
      points: [{ pressure: 0.5, time: index, x: 100, y: index * 10 + 5 }],
      tool: 'pen',
      width: 2,
    }));
    const measurements: Array<{ readonly resultCount: number; readonly visitedNodeCount: number }> =
      [];
    const document = new InkDocumentSession({
      instrumentation: {
        onQuery: (next) => {
          measurements.push(next);
        },
      },
      surfaces: [
        {
          ...surface('large', 0, strokes),
          layout: { ...surface('large', 0, strokes).layout, logicalHeight: 100_000 },
        },
      ],
      writer: { updateSurface: () => Promise.resolve() },
    });

    const visible = document.query({ height: 800, width: 704, x: 0, y: 50_000 });

    expect(visible).toHaveLength(80);
    expect(new Set(visible.map(({ id }) => id))).toEqual(
      new Set(Array.from({ length: 80 }, (_value, index) => `stroke-${5_000 + index}`)),
    );
    expect(measurements).toHaveLength(1);
    expect(measurements[0]?.resultCount).toBe(visible.length);
    expect(measurements[0]?.visitedNodeCount).toBeLessThanOrEqual(visible.length + 64);
    expect(document.read().indexBytes).toBeGreaterThan(0);
  });

  it('matches a brute-force conservative-bounds oracle across viewport positions', () => {
    const strokes = Array.from({ length: 1_000 }, (_value, index): InkStroke => ({
      color: '#111111',
      id: `oracle-${index}`,
      points: [
        {
          pressure: 0.5,
          time: index,
          x: (index * 47) % 704,
          y: (index * 193) % 20_000,
        },
      ],
      tool: 'pen',
      width: 2 + (index % 8),
    }));
    const document = new InkDocumentSession({
      surfaces: [
        {
          ...surface('oracle', 0, strokes),
          layout: { ...surface('oracle', 0, strokes).layout, logicalHeight: 20_000 },
        },
      ],
      writer: { updateSurface: () => Promise.resolve() },
    });

    for (let viewportIndex = 0; viewportIndex < 40; viewportIndex += 1) {
      const viewport: InkLogicalRect = {
        height: 800,
        width: 320,
        x: (viewportIndex * 83) % 384,
        y: (viewportIndex * 487) % 19_200,
      };
      const expected = document
        .read()
        .strokes.filter(({ bounds }) => testBoundsIntersect(bounds, viewport))
        .map(({ id }) => id);
      expect(new Set(document.query(viewport).map(({ id }) => id))).toEqual(new Set(expected));
    }
  });

  it('erases one logical ID from every fragment, the bounds index, and cold materialization', () => {
    const document = new InkDocumentSession({
      surfaces: [
        surface('top', 0, [fragment('top-fragment', 'crossing', 10, 550, 20, 600, 0)]),
        surface('bottom', 600, [fragment('bottom-fragment', 'crossing', 20, 0, 30, 50, 600)]),
      ],
      writer: {
        updateSurface: () => Promise.resolve(),
        updateSurfacesAtomically: () => Promise.resolve(),
      },
    });
    const before = document.read();

    const result = document.apply({ id: 'erase-crossing', ids: ['crossing'], kind: 'erase' });

    expect(result).toMatchObject({
      change: {
        addedIds: [],
        bounds: [
          {
            id: 'crossing',
            newBounds: null,
            oldBounds: { height: 102, width: 22, x: 9, y: 549 },
          },
        ],
        commandId: 'erase-crossing',
        generation: 1,
        removedIds: ['crossing'],
        updatedIds: [],
      },
      kind: 'committed',
    });
    expect(document.read()).not.toBe(before);
    expect(document.read()).toMatchObject({ generation: 1, strokeCount: 0 });
    expect(document.query({ height: 200, width: 704, x: 0, y: 500 })).toEqual([]);
    expect(document.materializeColdSnapshot().surface.strokes).toEqual([]);
  });

  it('moves selected logical IDs through one incremental command and relocates their index bounds', () => {
    const document = new InkDocumentSession({
      surfaces: [surface('only', 0, [fragment('saved-fragment', 'saved', 10, 100, 20, 120, 0)])],
      writer: { updateSurface: () => Promise.resolve() },
    });
    const beforeRef = [...document.read().strokes][0];

    const result = document.apply({
      dx: 30,
      dy: 40,
      id: 'move-saved',
      ids: ['saved'],
      kind: 'move',
    });

    expect(result).toMatchObject({
      change: {
        addedIds: [],
        bounds: [
          {
            id: 'saved',
            newBounds: { height: 22, width: 12, x: 39, y: 139 },
            oldBounds: { height: 22, width: 12, x: 9, y: 99 },
          },
        ],
        commandId: 'move-saved',
        generation: 1,
        removedIds: [],
        updatedIds: ['saved'],
      },
      kind: 'committed',
    });
    const afterRef = [...document.read().strokes][0];
    expect(afterRef).not.toBe(beforeRef);
    expect(afterRef?.id).toBe(beforeRef?.id);
    expect(document.query({ height: 30, width: 30, x: 0, y: 90 })).toEqual([]);
    expect(document.query({ height: 30, width: 30, x: 30, y: 130 })).toEqual([afterRef]);
    expect(document.materializeColdSnapshot().surface.strokes[0]?.points).toMatchObject([
      { x: 40, y: 140 },
      { x: 50, y: 160 },
    ]);
  });

  it('restyles every fragment of one logical stroke and keeps undo/redo atomic', () => {
    const document = new InkDocumentSession({
      surfaces: [
        surface('top', 0, [fragment('top-fragment', 'crossing', 10, 550, 20, 600, 0)]),
        surface('bottom', 600, [fragment('bottom-fragment', 'crossing', 20, 0, 30, 50, 600)]),
      ],
      writer: {
        updateSurface: () => Promise.resolve(),
        updateSurfacesAtomically: () => Promise.resolve(),
      },
    });

    const result = document.apply({
      id: 'restyle-crossing',
      ids: ['crossing'],
      kind: 'restyle',
      style: { color: '#ff0000', width: 8 },
    });

    expect(result).toMatchObject({
      change: {
        addedIds: [],
        commandId: 'restyle-crossing',
        removedIds: [],
        updatedIds: ['crossing'],
      },
      kind: 'committed',
    });
    expect([...document.read().strokes][0]?.stroke).toMatchObject({
      color: '#ff0000',
      id: 'crossing',
      width: 8,
    });
    expect(document.materializeColdSnapshot().surface.strokes).toMatchObject([
      { color: '#ff0000', id: 'crossing', width: 8 },
    ]);

    document.apply({ id: 'undo-restyle', kind: 'undo' });
    expect([...document.read().strokes][0]?.stroke).toMatchObject({ color: '#111111', width: 2 });
    document.apply({ id: 'redo-restyle', kind: 'redo' });
    expect([...document.read().strokes][0]?.stroke).toMatchObject({ color: '#ff0000', width: 8 });
  });

  it('never materializes a composite snapshot for ordinary commands or read callbacks', () => {
    const coldIntents: string[] = [];
    const document = new InkDocumentSession({
      instrumentation: {
        onColdMaterialization: ({ intent }) => coldIntents.push(intent),
      },
      onChange: () => undefined,
      surfaces: [surface('only', 0, [])],
      writer: { updateSurface: () => Promise.resolve() },
    });

    document.apply({ id: 'add', kind: 'add', stroke: logicalStroke('new', 100, 120) });
    document.apply({ dx: 5, dy: 5, id: 'move', ids: ['new'], kind: 'move' });
    document.apply({ id: 'erase', ids: ['new'], kind: 'erase' });

    expect(coldIntents).toEqual([]);
    document.materializeColdSnapshot();
    expect(coldIntents).toEqual(['explicit-cold']);
  });

  it('commits an Add to the Live Document without invoking canonical storage synchronously', () => {
    const updateSurface = vi.fn(() => Promise.resolve());
    const document = new InkDocumentSession({
      debounceMs: 60_000,
      surfaces: [surface('only', 0, [])],
      writer: { updateSurface },
    });

    const result = document.apply({
      id: 'live-first-add',
      kind: 'add',
      stroke: logicalStroke('live-first', 100, 120),
    });

    expect(result).toMatchObject({
      change: { addedIds: ['live-first'], commandId: 'live-first-add', generation: 1 },
      kind: 'committed',
    });
    expect(document.read()).toMatchObject({ generation: 1, strokeCount: 1 });
    expect(updateSurface).not.toHaveBeenCalled();
  });

  it('defers bounded-surface fragmentation until the cold persistence lane', async () => {
    const writes: Array<readonly InkSurfaceRecord[]> = [];
    const document = new InkDocumentSession({
      surfaces: [surface('top', 0, []), surface('bottom', 600, [])],
      writer: {
        updateSurface: () => Promise.resolve(),
        updateSurfacesAtomically: (records) => {
          writes.push(records);
          return Promise.resolve();
        },
      },
    });

    expect(
      document.apply({
        id: 'cold-fragment-add',
        kind: 'add',
        stroke: logicalStroke('cold-fragment', 580, 620),
      }),
    ).toMatchObject({ kind: 'committed' });
    expect(document.read()).toMatchObject({ strokeCount: 1 });
    expect(writes).toEqual([]);

    await document.background();

    expect(writes).toHaveLength(1);
    expect(
      writes[0]?.map(({ strokes }) =>
        strokes.map(({ linkedStrokeId, id }) => ({ id, linkedStrokeId })),
      ),
    ).toEqual([
      [{ id: 'cold-fragment-top', linkedStrokeId: 'cold-fragment' }],
      [{ id: 'cold-fragment-bottom', linkedStrokeId: 'cold-fragment' }],
    ]);
  });

  it('cold-fragments only changed Logical Strokes and leaves unrelated surfaces unwritten', async () => {
    const writes: InkSurfaceRecord[][] = [];
    const document = new InkDocumentSession({
      surfaces: [
        surface('top', 0, [fragment('saved-top', 'saved-top', 10, 100, 20, 120, 0)]),
        surface('middle', 600, [fragment('saved-middle', 'saved-middle', 10, 100, 20, 120, 600)]),
        surface('bottom', 1_200, [
          fragment('saved-bottom', 'saved-bottom', 10, 100, 20, 120, 1_200),
        ]),
      ],
      writer: {
        updateSurface: (record) => {
          writes.push([record]);
          return Promise.resolve();
        },
        updateSurfacesAtomically: (records) => {
          writes.push([...records]);
          return Promise.resolve();
        },
      },
    });

    document.apply({
      id: 'add-only-top',
      kind: 'add',
      stroke: logicalStroke('new-top', 200, 240),
    });
    await document.background();

    expect(writes.flat().map(({ id }) => id)).toEqual(['top']);
  });

  it('keeps new Add commands in memory without writing the legacy Draft Store', async () => {
    vi.useFakeTimers();
    const document = new InkDocumentSession({
      onPersistenceIssue: () => undefined,
      surfaces: [surface('only', 0, [])],
      writer: { updateSurface: () => Promise.resolve() },
    });

    expect(
      document.apply({ id: 'draft-a', kind: 'add', stroke: logicalStroke('draft-a', 100, 120) }),
    ).toMatchObject({ kind: 'committed' });
    expect(
      document.apply({ id: 'draft-b', kind: 'add', stroke: logicalStroke('draft-b', 140, 160) }),
    ).toMatchObject({ kind: 'committed' });
    expect(document.read().strokeCount).toBe(2);

    await vi.runAllTimersAsync();
    expect(document.read().strokeCount).toBe(2);
    expect(document.read().persistence).not.toMatchObject({ kind: 'error' });
  });

  it('holds an explicit background save behind the active contact fence without Draft work', async () => {
    vi.useFakeTimers();
    try {
      const auditGuards: string[] = [];
      const auditedWork: Array<{ kind: string; phase: string }> = [];
      const persistenceSpans: Array<{ accepted: boolean; kind: string }> = [];
      const updateSurface = vi.fn(() => Promise.resolve());
      const document = new InkDocumentSession({
        debounceMs: 10,
        instrumentation: {
          beginPersistenceSpan: (kind) => (accepted) => persistenceSpans.push({ accepted, kind }),
          onAuditGuard: (guard) => auditGuards.push(guard),
          onPersistenceWork: (work) => auditedWork.push(work),
        },
        surfaces: [surface('only', 0, [])],
        writer: { updateSurface },
      });

      expect(auditGuards).toEqual(['canonical-cold-materialization']);

      document.setInteractionActive(true);
      expect(
        document.apply({
          id: 'blocked-cold-lane',
          kind: 'add',
          stroke: logicalStroke('blocked-cold-lane', 100, 120),
        }),
      ).toMatchObject({ kind: 'committed' });
      const background = document.background();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(updateSurface).not.toHaveBeenCalled();
      expect(auditedWork).toEqual([]);
      expect(persistenceSpans).toEqual([]);

      document.setInteractionActive(false);
      await vi.runAllTimersAsync();
      await background;

      expect(updateSurface).toHaveBeenCalledTimes(1);
      expect(auditedWork).toEqual(
        expect.arrayContaining([
          { kind: 'canonical-encode', phase: 'cold' },
          { kind: 'cold-snapshot', phase: 'cold' },
        ]),
      );
      expect(persistenceSpans).toEqual([{ accepted: true, kind: 'canonical-submit' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a submitted canonical batch behind the fence when a new contact starts before writer drain', async () => {
    vi.useFakeTimers();
    try {
      let markCanonicalSubmitted!: () => void;
      const canonicalSubmitted = new Promise<void>((resolve) => {
        markCanonicalSubmitted = resolve;
      });
      const updateSurface = vi.fn(() => Promise.resolve());
      const owner: { document: InkDocumentSession | null } = { document: null };
      const document = new InkDocumentSession({
        instrumentation: {
          beginPersistenceSpan: (kind) => (accepted) => {
            if (kind !== 'canonical-submit' || !accepted) return;
            owner.document?.setInteractionActive(true);
            markCanonicalSubmitted();
          },
        },
        surfaces: [surface('only', 0, [])],
        writer: { updateSurface },
      });
      owner.document = document;
      document.apply({
        id: 'queued-before-contact',
        kind: 'add',
        stroke: logicalStroke('queued-before-contact', 100, 120),
      });

      const background = document.background();
      await canonicalSubmitted;
      await vi.runAllTimersAsync();

      expect(updateSurface).not.toHaveBeenCalled();

      document.setInteractionActive(false);
      await vi.runAllTimersAsync();
      await background;
      expect(updateSurface).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks the contact fence after the coalescing commit barrier yields to the host', async () => {
    vi.useFakeTimers();
    try {
      const updateSurface = vi.fn(() => Promise.resolve());
      const document = new InkDocumentSession({
        surfaces: [surface('only', 0, [])],
        writer: { updateSurface },
      });
      document.apply({
        id: 'barrier-before-contact',
        kind: 'add',
        stroke: logicalStroke('barrier-before-contact', 100, 120),
      });

      const background = document.background();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
      for (let attempt = 0; attempt < 8 && vi.getTimerCount() === 0; attempt += 1) {
        await Promise.resolve();
      }
      expect(vi.getTimerCount()).toBe(1);

      await vi.runOnlyPendingTimersAsync();
      expect(updateSurface).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      document.setInteractionActive(true);
      await vi.runOnlyPendingTimersAsync();
      expect(updateSurface).not.toHaveBeenCalled();

      document.setInteractionActive(false);
      await vi.runAllTimersAsync();
      await background;
      expect(updateSurface).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the contact checkpoint through to repository continuations already in flight', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseIo!: () => void;
    const io = new Promise<void>((resolve) => {
      releaseIo = resolve;
    });
    let continuedAfterIo = false;
    const document = new InkDocumentSession({
      surfaces: [surface('only', 0, [])],
      writer: {
        updateSurface: async (_record, _expectedBase, checkpoint?: () => Promise<void>) => {
          markStarted();
          await io;
          await checkpoint?.();
          continuedAfterIo = true;
        },
      },
    });
    document.apply({
      id: 'repository-continuation',
      kind: 'add',
      stroke: logicalStroke('repository-continuation', 100, 120),
    });

    const background = document.background();
    await started;
    document.setInteractionActive(true);
    releaseIo();
    await Promise.resolve();
    await Promise.resolve();

    expect(continuedAfterIo).toBe(false);

    document.setInteractionActive(false);
    await background;
    expect(continuedAfterIo).toBe(true);
  });

  it('yields cold surface materialization when its cooperative chunk budget is exhausted', async () => {
    let now = 0;
    const yieldToHost = vi.fn(() => Promise.resolve());
    const document = new InkDocumentSession({
      coldWorkScheduler: {
        now: () => {
          now += 2;
          return now;
        },
        yieldToHost,
      },
      surfaces: [surface('only', 0, [])],
      writer: { updateSurface: () => Promise.resolve() },
    });
    document.apply({
      id: 'cold-chunk-first',
      kind: 'add',
      stroke: logicalStroke('cold-chunk-first', 100, 120),
    });
    document.apply({
      id: 'cold-chunk-second',
      kind: 'add',
      stroke: logicalStroke('cold-chunk-second', 140, 160),
    });

    await document.background();

    expect(yieldToHost).toHaveBeenCalled();
  });

  it('abandons cooperative idle materialization until a new qualifying save signal', async () => {
    let now = 0;
    let announceYield = (): void => undefined;
    const yielded = new Promise<void>((resolve) => {
      announceYield = resolve;
    });
    const updateSurface = vi.fn(() => Promise.resolve());
    let interrupted = false;
    const document = new InkDocumentSession({
      coldWorkScheduler: {
        now: () => {
          now += 2;
          return now;
        },
        yieldToHost: () => {
          if (!interrupted) {
            interrupted = true;
            document.setInteractionActive(true);
            announceYield();
          }
          return Promise.resolve();
        },
      },
      surfaces: [surface('only', 0, [])],
      writer: { updateSurface },
    });
    for (const id of ['cold-contact-first', 'cold-contact-second']) {
      document.apply({ id, kind: 'add', stroke: logicalStroke(id, 100, 120) });
    }

    const background = document.background();
    await yielded;
    await Promise.resolve();

    expect(updateSurface).not.toHaveBeenCalled();

    document.setInteractionActive(false);
    await background;
    expect(updateSurface).not.toHaveBeenCalled();

    await document.background();
    expect(updateSurface).toHaveBeenCalledOnce();
  });

  it('does not auto-retry canonical work after cold preparation aborts', async () => {
    vi.useFakeTimers();
    try {
      let abortPreparation = true;
      const updateSurface = vi.fn(() => Promise.resolve());
      const document = new InkDocumentSession({
        debounceMs: 10,
        instrumentation: {
          onPersistenceWork: ({ kind }) => {
            if (kind === 'canonical-encode' && abortPreparation) {
              abortPreparation = false;
              throw new Error('cold-preparation-aborted');
            }
          },
        },
        surfaces: [surface('only', 0, [])],
        writer: { updateSurface },
      });
      document.apply({
        id: 'aborted-cold-preparation',
        kind: 'add',
        stroke: logicalStroke('aborted-cold-preparation', 100, 120),
      });

      await expect(document.background()).rejects.toThrow('cold-preparation-aborted');
      document.setInteractionActive(true);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(document.read().persistence.kind).toBe('idle');
      expect(updateSurface).not.toHaveBeenCalled();

      document.setInteractionActive(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(updateSurface).not.toHaveBeenCalled();

      const retry = document.background();
      await vi.runAllTimersAsync();
      await retry;
      expect(updateSurface).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not publish a render callback when a bounded persistence emission changes no read state', async () => {
    const changes: Array<InkDocumentChange | null> = [];
    const document = new InkDocumentSession({
      onChange: (_read, change) => changes.push(change),
      surfaces: [surface('only', 0, [])],
      writer: { updateSurface: () => Promise.resolve() },
    });

    document.apply({
      id: 'add-before-persistence',
      kind: 'add',
      stroke: logicalStroke('add-before-persistence', 100, 120),
    });
    await document.background();

    expect(changes.length).toBeGreaterThan(1);
    expect(changes).not.toContain(null);
  });

  it('never writes new legacy Draft operations across contact transitions', async () => {
    vi.useFakeTimers();
    try {
      const document = new InkDocumentSession({
        surfaces: [surface('only', 0, [])],
        writer: { updateSurface: () => Promise.resolve() },
      });
      document.setInteractionActive(true);
      document.apply({ id: 'queued-a', kind: 'add', stroke: logicalStroke('queued-a', 100, 120) });
      document.apply({ id: 'queued-b', kind: 'add', stroke: logicalStroke('queued-b', 140, 160) });
      document.setInteractionActive(false);
      await vi.runAllTimersAsync();

      document.setInteractionActive(true);
      document.setInteractionActive(false);
      await vi.runAllTimersAsync();
      expect(document.read().strokeCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays startup Add drafts read-only without writing or retiring them', async () => {
    const document = new InkDocumentSession({
      draftOperations: [
        {
          command: {
            id: 'restored-draft-add',
            kind: 'add',
            stroke: logicalStroke('restored-draft', 100, 120),
          },
          noteKey: 'Ink.md',
          revision: 7,
        },
      ],
      surfaces: [surface('only', 0, [])],
      writer: { updateSurface: () => Promise.resolve() },
    });

    expect(document.read()).toMatchObject({ strokeCount: 1 });
    expect(document.read().strokes.map(({ id }) => id)).toEqual(['restored-draft']);
    await document.background();

    expect(document.read().persistence).toMatchObject({ kind: 'saved-locally' });
  });

  it('hit-tests through the logical bounds index without cold materialization', () => {
    const coldIntents: string[] = [];
    const document = new InkDocumentSession({
      instrumentation: {
        onColdMaterialization: ({ intent }) => coldIntents.push(intent),
      },
      surfaces: [surface('only', 0, [fragment('saved-fragment', 'saved', 10, 100, 20, 120, 0)])],
      writer: { updateSurface: () => Promise.resolve() },
    });

    expect(document.strokeIdAt({ pressure: 0.5, time: 0, x: 15, y: 110 }, 4)).toBe('saved');
    expect(document.strokeIdAt({ pressure: 0.5, time: 0, x: 300, y: 300 }, 4)).toBeNull();
    expect(document.eraseStrokeAt({ pressure: 0.5, time: 0, x: 15, y: 110 }, 4)).toBe('saved');
    expect(coldIntents).toEqual([]);
  });

  it('previews and cancels selection movement through transient refs without cold materialization', () => {
    const coldIntents: string[] = [];
    const document = new InkDocumentSession({
      instrumentation: {
        onColdMaterialization: ({ intent }) => coldIntents.push(intent),
      },
      surfaces: [surface('only', 0, [fragment('saved-fragment', 'saved', 10, 100, 20, 120, 0)])],
      writer: { updateSurface: () => Promise.resolve() },
    });
    document.selectStrokeAt({ pressure: 0.5, time: 0, x: 15, y: 110 }, 4);
    const selected = document.read();
    const baseRef = [...selected.strokes][0];

    expect(document.previewSelectionMove(30, 40)).toEqual({ dx: 30, dy: 40 });
    const preview = document.read();
    expect(preview.selection).toEqual(['saved']);
    expect([...preview.strokes][0]?.bounds).toMatchObject({ x: 39, y: 139 });
    expect(document.query({ height: 30, width: 30, x: 30, y: 130 })[0]).toBe(
      [...preview.strokes][0],
    );
    expect(document.materializeColdSnapshot().surface.strokes[0]?.points).toMatchObject([
      { x: 10, y: 100 },
      { x: 20, y: 120 },
    ]);

    expect(document.cancelSelectionMove()).toBe(true);
    const restored = document.read();
    expect([...restored.strokes][0]).toBe(baseRef);
    expect(document.query({ height: 30, width: 30, x: 0, y: 90 })[0]).toBe(baseRef);
    expect(coldIntents).toEqual(['explicit-cold']);
  });

  it('clears or deletes a selection preview from its committed base state', () => {
    const document = new InkDocumentSession({
      surfaces: [surface('only', 0, [fragment('saved-fragment', 'saved', 10, 100, 20, 120, 0)])],
      writer: { updateSurface: () => Promise.resolve() },
    });
    document.selectStrokeAt({ pressure: 0.5, time: 0, x: 15, y: 110 }, 4);
    const baseRef = [...document.read().strokes][0];
    document.previewSelectionMove(30, 40);

    expect(document.clearSelection()).toBe(true);
    expect([...document.read().strokes][0]).toBe(baseRef);
    expect(document.query({ height: 30, width: 30, x: 0, y: 90 })).toEqual([baseRef]);

    document.selectStrokeAt({ pressure: 0.5, time: 0, x: 15, y: 110 }, 4);
    document.previewSelectionMove(30, 40);
    expect(document.deleteSelectedStrokes()).toEqual(['saved']);
    expect(document.read().strokeCount).toBe(0);
    expect(document.undo()).toBe(true);
    expect([...document.read().strokes][0]).toBe(baseRef);
    expect(document.materializeColdSnapshot().surface.strokes[0]?.points).toMatchObject([
      { x: 10, y: 100 },
      { x: 20, y: 120 },
    ]);
  });

  it('commits the exact transient selection delta without a cold read or logical ID change', () => {
    const coldIntents: string[] = [];
    const document = new InkDocumentSession({
      instrumentation: {
        onColdMaterialization: ({ intent }) => coldIntents.push(intent),
      },
      surfaces: [surface('only', 0, [fragment('saved-fragment', 'saved', 10, 100, 20, 120, 0)])],
      writer: { updateSurface: () => Promise.resolve() },
    });
    document.selectStrokeAt({ pressure: 0.5, time: 0, x: 15, y: 110 }, 4);
    document.previewSelectionMove(30, 40);
    const previewRef = [...document.read().strokes][0];

    expect(document.commitSelectionMove()).toBe(true);

    const committedRef = [...document.read().strokes][0];
    expect(committedRef?.id).toBe('saved');
    expect(committedRef?.stroke.points).toEqual(previewRef?.stroke.points);
    expect(coldIntents).toEqual([]);
    expect(document.materializeColdSnapshot().surface.strokes[0]?.points).toMatchObject([
      { x: 40, y: 140 },
      { x: 50, y: 160 },
    ]);
    expect(coldIntents).toEqual(['explicit-cold']);
  });

  it('circle-erases only indexed candidates without materializing unrelated history', () => {
    const coldIntents: string[] = [];
    const document = new InkDocumentSession({
      instrumentation: {
        onColdMaterialization: ({ intent }) => coldIntents.push(intent),
      },
      surfaces: [
        surface('only', 0, [
          fragment('inside-fragment', 'inside', 20, 20, 40, 40, 0),
          fragment('outside-fragment', 'outside', 200, 200, 220, 220, 0),
        ]),
      ],
      writer: { updateSurface: () => Promise.resolve() },
    });

    expect(
      document.eraseStrokesInPolygon([
        { pressure: 0.5, time: 0, x: 0, y: 0 },
        { pressure: 0.5, time: 1, x: 100, y: 0 },
        { pressure: 0.5, time: 2, x: 100, y: 100 },
        { pressure: 0.5, time: 3, x: 0, y: 100 },
      ]),
    ).toEqual(['inside']);
    expect([...document.read().strokes].map(({ id }) => id)).toEqual(['outside']);
    expect(coldIntents).toEqual([]);
  });

  it('undoes and redoes one logical patch without rebuilding a composite snapshot', () => {
    const coldIntents: string[] = [];
    const document = new InkDocumentSession({
      instrumentation: {
        onColdMaterialization: ({ intent }) => coldIntents.push(intent),
      },
      surfaces: [surface('only', 0, [])],
      writer: { updateSurface: () => Promise.resolve() },
    });
    document.apply({ id: 'add-saved', kind: 'add', stroke: logicalStroke('saved', 100, 120) });
    const addedRef = [...document.read().strokes][0];

    const undone = document.apply({ id: 'undo-add', kind: 'undo' });
    expect(undone).toMatchObject({
      change: {
        addedIds: [],
        commandId: 'undo-add',
        removedIds: ['saved'],
        updatedIds: [],
      },
      kind: 'committed',
    });
    expect(document.read().strokeCount).toBe(0);
    expect(document.query({ height: 40, width: 40, x: 0, y: 90 })).toEqual([]);

    const redone = document.apply({ id: 'redo-add', kind: 'redo' });
    expect(redone).toMatchObject({
      change: {
        addedIds: ['saved'],
        commandId: 'redo-add',
        removedIds: [],
        updatedIds: [],
      },
      kind: 'committed',
    });
    expect([...document.read().strokes][0]).toBe(addedRef);
    expect(document.query({ height: 40, width: 40, x: 0, y: 90 })).toEqual([addedRef]);
    expect(coldIntents).toEqual([]);
  });
});

function surface(id: string, originY: number, strokes: readonly InkStroke[]): InkSurfaceRecord {
  return {
    createdAt: '2026-07-17T00:00:00.000Z',
    filePath: 'Ink.md',
    id,
    layout: {
      blockFingerprints: [id],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 600,
      logicalWidth: 704,
      originY,
      sourceRevision: 'source',
      themeMode: 'light',
    },
    noteId: 'note',
    revision: 1,
    schemaVersion: 2,
    status: 'active',
    strokes,
    updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

function fragment(
  id: string,
  linkedStrokeId: string,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  timeOffset: number,
): InkStroke {
  return {
    color: '#111111',
    id,
    linkedStrokeId,
    points: [
      { pressure: 0.5, time: startY + timeOffset, x: startX, y: startY },
      { pressure: 0.5, time: endY + timeOffset, x: endX, y: endY },
    ],
    tool: 'pen',
    width: 2,
  };
}

function logicalStroke(id: string, startY: number, endY: number): InkStroke {
  return {
    color: '#111111',
    id,
    points: [
      { pressure: 0.5, time: startY, x: 10, y: startY },
      { pressure: 0.5, time: endY, x: 20, y: endY },
    ],
    tool: 'pen',
    width: 2,
  };
}

function testBoundsIntersect(left: InkLogicalRect, right: InkLogicalRect): boolean {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
  );
}
