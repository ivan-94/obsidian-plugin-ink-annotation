import { describe, expect, it } from 'vitest';

import type { InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import { InkDocumentSession } from './ink-document-session';

describe('Ink document interaction performance', () => {
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
