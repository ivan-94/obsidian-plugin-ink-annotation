import { describe, expect, it } from 'vitest';

import type { InkStroke, InkSurfaceRecord } from './ink-surface';
import { planConcurrentInkAppendMerge } from './ink-concurrent-append-merge';

describe('concurrent Ink append merge', () => {
  it('preserves every unique stroke across reordered append-only descendants', () => {
    const base = surface(1, ['base-a', 'base-b']);
    for (let localCount = 1; localCount <= 12; localCount += 1) {
      for (let remoteCount = 1; remoteCount <= 12; remoteCount += 1) {
        const localIds = Array.from({ length: localCount }, (_, index) => `local-${index}`);
        const remoteIds = Array.from({ length: remoteCount }, (_, index) => `remote-${index}`);
        const local = surface(2, ['base-b', 'base-a', ...localIds]);
        const remote = surface(2 + remoteCount, ['base-a', ...remoteIds, 'base-b']);

        const plan = planConcurrentInkAppendMerge({ base, local, remote });

        expect(plan.kind).toBe('merge');
        if (plan.kind !== 'merge') continue;
        expect(plan.record.revision).toBe(remote.revision + 1);
        expect(new Set(plan.record.strokes.map(({ id }) => id))).toEqual(
          new Set(['base-a', 'base-b', ...localIds, ...remoteIds]),
        );
        expect(plan.record.strokes).toHaveLength(2 + localCount + remoteCount);
      }
    }
  });

  it('rejects a changed existing stroke, a tombstone, and a colliding append ID', () => {
    const base = surface(1, ['base']);
    const local = surface(2, ['base', 'local']);
    const movedBase = {
      ...stroke('base'),
      points: [{ pressure: 0.5, time: 0, x: 99, y: 10 }],
    };
    expect(
      planConcurrentInkAppendMerge({
        base,
        local,
        remote: { ...surface(2, []), strokes: [movedBase, stroke('remote')] },
      }),
    ).toEqual({ kind: 'conflict', reason: 'existing-strokes-changed' });
    expect(
      planConcurrentInkAppendMerge({
        base,
        local,
        remote: { ...surface(2, ['base', 'remote']), deletedAt: '2026-07-17T08:00:00.000Z' },
      }),
    ).toEqual({ kind: 'conflict', reason: 'surface-is-not-active' });
    expect(
      planConcurrentInkAppendMerge({
        base: surface(1, []),
        local: surface(2, ['collision']),
        remote: {
          ...surface(2, []),
          strokes: [
            {
              ...stroke('collision'),
              points: [{ pressure: 0.5, time: 0, x: 42, y: 10 }],
            },
          ],
        },
      }),
    ).toEqual({ kind: 'conflict', reason: 'stroke-id-collision' });
  });

  it('recognizes a previously merged local append without advancing another revision', () => {
    const base = surface(1, []);
    const local = surface(2, ['local']);
    const remote = surface(3, ['remote', 'local']);

    expect(planConcurrentInkAppendMerge({ base, local, remote })).toEqual({
      kind: 'already-merged',
      record: remote,
    });
  });
});

function surface(revision: number, strokeIds: readonly string[]): InkSurfaceRecord {
  return {
    createdAt: '2026-07-17T08:00:00.000Z',
    deviceId: `device-${revision}`,
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
    strokes: strokeIds.map(stroke),
    updatedAt: `2026-07-17T08:0${Math.min(revision, 9)}:00.000Z`,
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
