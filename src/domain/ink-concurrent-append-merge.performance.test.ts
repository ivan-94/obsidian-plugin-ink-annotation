import { describe, expect, it } from 'vitest';

import type { InkStroke, InkSurfaceRecord } from './ink-surface';
import { planConcurrentInkAppendMerge } from './ink-concurrent-append-merge';

describe('concurrent Ink append merge performance', () => {
  it('classifies a 10,000-stroke surface within the background-save budget', () => {
    const baseStrokes = Array.from({ length: 10_000 }, (_, index) => stroke(`base-${index}`));
    const base = surface(1, baseStrokes);
    const local = surface(2, [...baseStrokes, stroke('local')]);
    const remote = surface(2, [...baseStrokes, stroke('remote')]);

    const startedAt = performance.now();
    const plan = planConcurrentInkAppendMerge({ base, local, remote });
    const durationMs = performance.now() - startedAt;

    expect(plan.kind).toBe('merge');
    expect(durationMs).toBeLessThan(250);
  });
});

function surface(revision: number, strokes: readonly InkStroke[]): InkSurfaceRecord {
  return {
    createdAt: '2026-07-17T08:00:00.000Z',
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
    revision,
    schemaVersion: 2,
    status: 'active',
    strokes,
    updatedAt: '2026-07-17T08:00:00.000Z',
  };
}

function stroke(id: string): InkStroke {
  return {
    color: '#111111',
    id,
    points: [{ pressure: 0.5, time: 0, x: 10, y: 10 }],
    tool: 'pen',
    width: 2,
  };
}
