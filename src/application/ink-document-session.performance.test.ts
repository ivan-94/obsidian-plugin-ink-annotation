import { describe, expect, it } from 'vitest';

import { logicalStrokeIdsCoveredByPolygon } from '../domain/ink-closed-loop-erase';
import type { InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import { InkDocumentSession } from './ink-document-session';

describe('Ink document interaction performance', () => {
  it.each([
    { history: 0, surfaces: 1 },
    { history: 1_000, surfaces: 1 },
    { history: 10_000, surfaces: 1 },
    { history: 10_000, surfaces: 30 },
  ])(
    'keeps read() reference-stable and cold-work-free at $history strokes / $surfaces surfaces',
    ({ history, surfaces: surfaceCount }) => {
      const coldIntents: string[] = [];
      const records = Array.from({ length: surfaceCount }, (_value, surfaceIndex) => {
        const count =
          Math.floor(history / surfaceCount) + (surfaceIndex < history % surfaceCount ? 1 : 0);
        return {
          ...surface(),
          id: `surface-${surfaceIndex}`,
          layout: {
            ...surface().layout,
            logicalHeight: 1_000,
            originY: surfaceIndex * 1_000,
          },
          schemaVersion: 2 as const,
          strokes: Array.from({ length: count }, (_item, strokeIndex): InkStroke => ({
            color: '#111111',
            id: `stroke-${surfaceIndex}-${strokeIndex}`,
            points: [point(strokeIndex % 704, strokeIndex % 1_000)],
            tool: 'pen',
            width: 2,
          })),
        };
      });
      const session = new InkDocumentSession({
        instrumentation: {
          onColdMaterialization: ({ intent }) => coldIntents.push(intent),
        },
        surfaces: records,
        writer: {
          updateSurface: () => Promise.resolve(),
          updateSurfacesAtomically: () => Promise.resolve(),
        },
      });
      const first = session.read();
      const references = new Set<ReturnType<InkDocumentSession['read']>>();

      for (let call = 0; call < 10_000; call += 1) references.add(session.read());

      expect(references).toEqual(new Set([first]));
      expect(first.strokeCount).toBe(history);
      expect(first.indexBytes).toBeLessThan(32 * 1024 * 1024);
      expect(coldIntents).toEqual([]);
    },
  );

  it('hit-tests and removes one stroke among 10,000 within the desktop interaction budget', () => {
    const strokes = Array.from({ length: 10_000 }, (_value, index): InkStroke => ({
      color: '#111111',
      id: `stroke-${index}`,
      points: [
        point(index % 900, Math.floor(index / 900) * 4),
        point((index % 900) + 2, Math.floor(index / 900) * 4 + 2),
      ],
      tool: 'pen',
      width: 2,
    }));
    const session = new InkDocumentSession({
      surfaces: [{ ...surface(), strokes }],
      writer: { updateSurface: () => Promise.resolve() },
    });
    const startedAt = performance.now();

    const erased = session.eraseStrokeAt(point(450, 20), 4);
    const durationMs = performance.now() - startedAt;

    expect(erased).not.toBeNull();
    expect(durationMs).toBeLessThan(250);
  });

  it('hit-tests and previews a move across 30 chunks and 10,000 strokes within the desktop budget', () => {
    const surfaces = Array.from({ length: 30 }, (_value, chunkIndex): InkSurfaceRecord => ({
      ...surface(),
      id: `surface-${chunkIndex}`,
      layout: { ...surface().layout, logicalHeight: 1_000, originY: chunkIndex * 1_000 },
      schemaVersion: 2,
      strokes: Array.from({ length: 334 }, (_item, strokeIndex): InkStroke => ({
        color: '#111111',
        id: `stroke-${chunkIndex}-${strokeIndex}`,
        points: [
          point((strokeIndex % 100) * 8, (strokeIndex % 300) * 2),
          point((strokeIndex % 100) * 8 + 2, (strokeIndex % 300) * 2 + 2),
        ],
        tool: 'pen',
        width: 2,
      })),
    }));
    const session = new InkDocumentSession({
      surfaces,
      writer: {
        updateSurface: () => Promise.resolve(),
        updateSurfacesAtomically: () => Promise.resolve(),
      },
    });
    const startedAt = performance.now();

    session.selectStrokeAt(point(184, 15_246), 4);
    session.previewSelectionMove(12, 20);
    const durationMs = performance.now() - startedAt;

    expect(session.selectedStrokeIds()).toEqual(['stroke-15-123']);
    expect(durationMs).toBeLessThan(250);
  });

  it('classifies and batch-erases 10,000 strokes with a 128-point loop within the desktop budget', () => {
    const strokes = Array.from({ length: 10_000 }, (_value, index): InkStroke => ({
      color: '#111111',
      id: `stroke-${index}`,
      points: [point(index % 1_000, Math.floor(index / 1_000) * 20)],
      tool: 'pen',
      width: 2,
    }));
    const polygon = Array.from({ length: 128 }, (_value, index) => {
      const angle = (index / 128) * Math.PI * 2;
      return point(500 + Math.cos(angle) * 220, 90 + Math.sin(angle) * 220);
    });
    const session = new InkDocumentSession({
      surfaces: [{ ...surface(), strokes }],
      writer: { updateSurface: () => Promise.resolve() },
    });
    const startedAt = performance.now();

    const erased = session.eraseStrokesInPolygon(polygon);
    const durationMs = performance.now() - startedAt;

    expect(erased.length).toBeGreaterThan(0);
    expect(erased.length).toBeLessThan(strokes.length);
    expect(durationMs).toBeLessThan(250);
  });

  it('keeps every indexed closed-loop erase phase independently bounded at 10,000 strokes', () => {
    const strokes = Array.from({ length: 10_000 }, (_value, index): InkStroke => ({
      color: '#111111',
      id: `stroke-${index}`,
      points: [point(index % 1_000, Math.floor(index / 1_000) * 20)],
      tool: 'pen',
      width: 2,
    }));
    const polygon = Array.from({ length: 128 }, (_value, index) => {
      const angle = (index / 128) * Math.PI * 2;
      return point(500 + Math.cos(angle) * 220, 90 + Math.sin(angle) * 220);
    });
    const session = new InkDocumentSession({
      surfaces: [{ ...surface(), strokes }],
      writer: { updateSurface: () => Promise.resolve() },
    });

    const queryStartedAt = performance.now();
    const candidates = session.query({ height: 440, width: 440, x: 280, y: -130 });
    const queryDurationMs = performance.now() - queryStartedAt;
    const classificationStartedAt = performance.now();
    const ids = logicalStrokeIdsCoveredByPolygon(
      candidates.map(({ stroke }) => stroke),
      polygon,
    );
    const classificationDurationMs = performance.now() - classificationStartedAt;
    const mutationStartedAt = performance.now();
    const result = session.apply({ id: 'erase-loop', ids, kind: 'erase' });
    const mutationDurationMs = performance.now() - mutationStartedAt;

    expect(result.kind).toBe('committed');
    expect(queryDurationMs).toBeLessThan(250);
    expect(classificationDurationMs).toBeLessThan(250);
    expect(mutationDurationMs).toBeLessThan(250);
  });

  it('keeps 100 live-first pen-up appends cold-work-free with 10,000-stroke history', () => {
    const history = Array.from({ length: 10_000 }, (_value, index): InkStroke => ({
      color: '#111111',
      id: `history-${index}`,
      points: [point(index % 1_000, Math.floor(index / 1_000) * 20)],
      tool: 'pen',
      width: 2,
    }));
    const coldIntents: string[] = [];
    let canonicalWrites = 0;
    const session = new InkDocumentSession({
      debounceMs: 60_000,
      instrumentation: {
        onColdMaterialization: ({ intent }) => coldIntents.push(intent),
      },
      surfaces: [{ ...surface(), strokes: history }],
      writer: {
        updateSurface: () => {
          canonicalWrites += 1;
          return Promise.resolve();
        },
      },
    });
    const startedAt = performance.now();

    for (let index = 0; index < 100; index += 1) {
      session.apply({
        id: `new-command-${index}`,
        kind: 'add',
        stroke: stroke(`new-stroke-${index}`, 10 + index, 20 + index),
      });
    }
    const durationMs = performance.now() - startedAt;

    expect(session.read().strokeCount).toBe(10_100);
    expect(canonicalWrites).toBe(0);
    expect(coldIntents).toEqual([]);
    expect(durationMs).toBeLessThan(250);
  });

  it('reuses one append projection and keeps add undo history incremental', () => {
    const session = new InkDocumentSession({
      surfaces: [surface()],
      writer: { updateSurface: () => Promise.resolve() },
    });

    session.apply({ id: 'add-one', kind: 'add', stroke: stroke('one', 10, 20) });
    const appendProjection = session.read().strokes;
    for (let index = 2; index <= 100; index += 1) {
      session.apply({
        id: `add-${index}`,
        kind: 'add',
        stroke: stroke(String(index), index, index + 1),
      });
    }

    expect(session.read().strokes).toBe(appendProjection);
    expect(session.read().strokeCount).toBe(100);
    expect(session.undo()).toBe(true);
    expect(session.read().strokeCount).toBe(99);
    expect(session.redo()).toBe(true);
    expect(session.read().strokeCount).toBe(100);
    expect(session.read().strokes.at(-1)?.id).toBe('100');
  });
});

function surface(): InkSurfaceRecord {
  return {
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Ink.md',
    id: 'surface-a',
    layout: {
      blockFingerprints: ['a'],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1000,
      logicalWidth: 1000,
      sourceRevision: 'source',
      themeMode: 'light',
    },
    noteId: 'note',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: [],
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}

function point(x: number, y: number) {
  return { pressure: 0.5, time: x + y, x, y };
}

function stroke(id: string, start: number, end: number): InkStroke {
  return {
    color: '#111111',
    id,
    points: [point(start, start), point(end, end)],
    tool: 'pen',
    width: 2,
  };
}
