import { describe, expect, it } from 'vitest';

import type { InkSurfaceRecord } from './ink-surface';
import {
  migrateInkSurfaceRecordsToV2,
  orderInkSurfaceRecordsForLegacyRead,
  orderPositionedInkSurfaceRecords,
  upgradeInkSurfaceRecordsToV3,
} from './ink-surface-migration';

describe('Ink surface schema migration', () => {
  it('orders positioned records by origin instead of lexicographic surface ID', () => {
    const zero = positionedSurface('surface-0', 0);
    const two = positionedSurface('surface-2', 2_000);
    const ten = positionedSurface('surface-10', 10_000);

    expect(orderPositionedInkSurfaceRecords([zero, ten, two]).map(({ id }) => id)).toEqual([
      'surface-0',
      'surface-2',
      'surface-10',
    ]);
  });

  it('orders historical v1 surfaces for reading without changing schema, revision, or bytes', () => {
    const later = surface('later', 300, 200);
    const earlier = surface('earlier', 200, 0);

    const result = orderInkSurfaceRecordsForLegacyRead([later, earlier]);

    expect(result).toEqual({ kind: 'ordered', records: [earlier, later] });
    expect(result.records[0]).toBe(earlier);
    expect(result.records[1]).toBe(later);
    expect(result.records.every((record) => record.schemaVersion === 1)).toBe(true);
    expect(result.records.map((record) => record.revision)).toEqual([1, 1]);
  });

  it('allows one unbound historical v1 surface but fails closed for ambiguous or mixed sets', () => {
    const { binding, ...only } = surface('only', 200, 0);
    const duplicate = surface('duplicate', 300, 0);

    expect(binding).toBeDefined();
    expect(orderInkSurfaceRecordsForLegacyRead([only])).toEqual({
      kind: 'ordered',
      records: [only],
    });
    expect(
      orderInkSurfaceRecordsForLegacyRead([surface('first', 200, 0), duplicate]),
    ).toMatchObject({ kind: 'manual-placement-required' });
    expect(
      orderInkSurfaceRecordsForLegacyRead([
        surface('legacy', 200, 0),
        {
          ...surface('modern', 300, 200),
          schemaVersion: 2,
          layout: { ...surface('modern', 300, 200).layout, originY: 200 },
        },
      ]),
    ).toMatchObject({ kind: 'manual-placement-required' });
  });

  it('derives stable note-global origins only from uniquely ordered canonical v1 bindings', () => {
    const later = surface('later', 300, 200);
    const earlier = surface('earlier', 200, 0);

    const result = migrateInkSurfaceRecordsToV2([later, earlier], '2026-07-15T12:00:00.000Z');

    expect(result).toMatchObject({ kind: 'migrated' });
    if (result.kind !== 'migrated') throw new Error('Expected a unique migration.');
    expect(result.records.map((record) => [record.id, record.layout.originY])).toEqual([
      ['earlier', 0],
      ['later', 200],
    ]);
    expect(result.records.every((record) => record.schemaVersion === 2)).toBe(true);
    expect(result.records.map((record) => record.revision)).toEqual([2, 2]);
    expect(result.records.flatMap((record) => record.strokes.map((stroke) => stroke.id))).toEqual([
      'stroke-earlier',
      'stroke-later',
    ]);
  });

  it('requires manual placement when canonical v1 ordering is ambiguous', () => {
    const first = surface('first', 200, 0);
    const duplicate = surface('duplicate', 300, 0);

    const result = migrateInkSurfaceRecordsToV2([first, duplicate], '2026-07-15T12:00:00.000Z');

    expect(result).toEqual({
      kind: 'manual-placement-required',
      reason: 'Ink v1 surfaces do not have a unique canonical order.',
      records: [first, duplicate],
    });
  });

  it('fails closed for mixed versions, overlapping bindings, or inconsistent widths', () => {
    const first = surface('first', 200, 0);
    const second = surface('second', 300, 100);
    const cases = [
      [first, { ...second, schemaVersion: 2 as const, layout: { ...second.layout, originY: 200 } }],
      [
        first,
        {
          ...second,
          binding: { ...(second.binding as NonNullable<typeof second.binding>), sourceStart: 50 },
        },
      ],
      [first, { ...second, layout: { ...second.layout, logicalWidth: 800 } }],
    ];

    for (const records of cases) {
      expect(migrateInkSurfaceRecordsToV2(records, '2026-07-15T12:00:00.000Z')).toMatchObject({
        kind: 'manual-placement-required',
      });
    }
  });

  it('preserves recovery status, tombstones, vectors, and identity during migration', () => {
    const legacy = {
      ...surface('legacy', 200, 0),
      deletedAt: '2026-07-15T09:00:00.000Z',
      status: 'unanchored' as const,
    };

    const result = migrateInkSurfaceRecordsToV2([legacy], '2026-07-15T12:00:00.000Z');

    expect(result).toMatchObject({
      kind: 'migrated',
      records: [
        {
          deletedAt: legacy.deletedAt,
          id: legacy.id,
          status: 'unanchored',
          strokes: legacy.strokes,
        },
      ],
    });
  });

  it('upgrades legacy visible strokes to schema v3 on the cold path', () => {
    const legacy = positionedSurface('legacy', 0);

    const records = upgradeInkSurfaceRecordsToV3([legacy], '2026-07-19T10:00:00.000Z');

    expect(records).toMatchObject([
      {
        id: 'legacy',
        revision: 2,
        schemaVersion: 3,
        strokes: [
          {
            brushRenderVersion: 'legacy-round-v1',
            id: 'stroke-legacy',
            inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
          },
        ],
        updatedAt: '2026-07-19T10:00:00.000Z',
      },
    ]);
    expect(records[0]?.strokes[0]?.points).toBe(legacy.strokes[0]?.points);
  });
});

function surface(id: string, logicalHeight: number, sourceStart: number): InkSurfaceRecord {
  return {
    binding: {
      blockFingerprints: [`block-${id}`],
      headingPath: [id],
      sectionFingerprint: `section-${id}`,
      sourceEnd: sourceStart + 100,
      sourceStart,
    },
    createdAt: '2026-07-14T10:00:00.000Z',
    filePath: 'Notes/Ink.md',
    id,
    layout: {
      blockFingerprints: [`block-${id}`],
      fontFamily: 'Inter',
      fontSize: 18,
      lineHeight: 28,
      logicalHeight,
      logicalWidth: 960,
      sourceRevision: 'source-1',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: [
      {
        color: '#4f46d8',
        id: `stroke-${id}`,
        points: [{ pressure: 0.5, time: 1, x: 10, y: 20 }],
        tool: 'pen',
        width: 4,
      },
    ],
    updatedAt: '2026-07-14T10:00:00.000Z',
  };
}

function positionedSurface(id: string, originY: number): InkSurfaceRecord {
  const legacy = surface(id, 1_000, originY);
  return {
    ...legacy,
    layout: { ...legacy.layout, originY },
    schemaVersion: 2,
  };
}
