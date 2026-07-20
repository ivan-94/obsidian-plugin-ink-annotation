import { describe, expect, it } from 'vitest';

import {
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  type InkPhysicalPoint,
  type InkStroke,
  type InkSurfaceRecord,
} from './ink-surface';
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

  it('treats decoded legacy metadata and canonical layout key order as the same v2 ancestry', () => {
    const base = surface(1, []);
    const local = { ...base, revision: 2, strokes: [stroke('local')] };
    const remote = decodeInkSurfaceRecord(
      encodeInkSurfaceRecord({ ...base, revision: 2, strokes: [stroke('remote')] }),
    );

    const plan = planConcurrentInkAppendMerge({ base, local, remote });

    expect(plan).toMatchObject({
      kind: 'merge',
      record: { strokes: [{ id: 'remote' }, { id: 'local' }] },
    });
  });

  it('treats a v3 Brush Render Version or input-profile change as an existing-stroke edit', () => {
    const original = physicalStroke('base', 'measured');
    const base = { ...surface(1, []), schemaVersion: 3 as const, strokes: [original] };
    const local = {
      ...base,
      revision: 2,
      strokes: [...base.strokes, physicalStroke('local', 'measured')],
    };
    const remote = {
      ...base,
      revision: 2,
      strokes: [physicalStroke('base', 'unavailable'), physicalStroke('remote', 'measured')],
    };

    expect(planConcurrentInkAppendMerge({ base, local, remote })).toEqual({
      kind: 'conflict',
      reason: 'existing-strokes-changed',
    });
  });

  it('treats physical pressure provenance and orientation reliability as canonical stroke identity', () => {
    const original = physicalStroke('base', 'measured');
    const base = { ...surface(1, []), schemaVersion: 3 as const, strokes: [original] };
    const local = {
      ...base,
      revision: 2,
      strokes: [...base.strokes, physicalStroke('local', 'measured')],
    };
    const changedPoint = original.points[0];
    if (changedPoint === undefined) throw new Error('Missing physical merge fixture point.');
    const remote = {
      ...base,
      revision: 2,
      strokes: [
        {
          ...original,
          points: [
            {
              ...changedPoint,
              orientation: {
                altitude: 0.4,
                azimuth: 1.2,
                kind: 'measured' as const,
                reliable: false,
              },
            },
          ],
        },
        physicalStroke('remote', 'measured'),
      ],
    };

    expect(planConcurrentInkAppendMerge({ base, local, remote })).toEqual({
      kind: 'conflict',
      reason: 'existing-strokes-changed',
    });
  });

  it('treats physical fragment provenance as canonical stroke identity during stale merge', () => {
    const point = physicalStroke('base', 'measured').points[0];
    if (point === undefined) throw new Error('Missing physical provenance merge fixture point.');
    const original: InkStroke = {
      ...physicalStroke('base', 'measured'),
      id: 'base-fragment',
      linkedStrokeId: 'base',
      points: [{ ...point, fragmentGlobalY: point.y, fragmentTraceOrder: 0 } as InkPhysicalPoint],
    };
    const base = { ...surface(1, []), schemaVersion: 3 as const, strokes: [original] };
    const local = {
      ...base,
      revision: 2,
      strokes: [...base.strokes, physicalStroke('local', 'measured')],
    };
    const remote = {
      ...base,
      revision: 2,
      strokes: [
        {
          ...original,
          points: [
            { ...point, fragmentGlobalY: point.y, fragmentTraceOrder: 1 } as InkPhysicalPoint,
          ],
        },
        physicalStroke('remote', 'measured'),
      ],
    };

    expect(planConcurrentInkAppendMerge({ base, local, remote })).toEqual({
      kind: 'conflict',
      reason: 'existing-strokes-changed',
    });
  });

  it.each([
    {
      baseSchema: 2,
      localSchema: 2,
      remoteSchema: 3,
    },
    {
      baseSchema: 3,
      localSchema: 2,
      remoteSchema: 3,
    },
  ] as const)(
    'classifies a v$baseSchema→v$localSchema/v$remoteSchema branch as a schema semantic conflict',
    ({ baseSchema, localSchema, remoteSchema }) => {
      const base = withSchema(surface(1, []), baseSchema);
      const local = withSchema(surface(2, ['local']), localSchema);
      const remote = withSchema(surface(2, ['remote']), remoteSchema);

      expect(planConcurrentInkAppendMerge({ base, local, remote })).toEqual({
        kind: 'conflict',
        reason: 'schema-version-mismatch',
      });
    },
  );
});

function withSchema(record: InkSurfaceRecord, schemaVersion: 2 | 3): InkSurfaceRecord {
  return {
    ...record,
    schemaVersion,
    strokes:
      schemaVersion === 2
        ? record.strokes
        : record.strokes.map((candidate) => ({
            ...candidate,
            brushRenderVersion: 'pen-physical-v1' as const,
            color: '#112233',
            inputProfile: { pressure: 'measured' as const, tilt: 'measured' as const },
          })),
  };
}

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

function physicalStroke(id: string, tilt: 'measured' | 'unavailable'): InkStroke {
  return {
    ...stroke(id),
    brushRenderVersion: 'pen-physical-v1',
    inputProfile: { pressure: 'measured', tilt },
    points: [
      {
        orientation:
          tilt === 'measured'
            ? { altitude: 0.4, azimuth: 1.2, kind: 'measured', reliable: true }
            : { kind: 'unavailable' },
        pressure: 0.5,
        pressureKind: 'measured',
        time: 0,
        x: 10,
        y: 10,
      },
    ],
  };
}
