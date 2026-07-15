import { describe, expect, it } from 'vitest';

import {
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  type InkSurfaceRecord,
} from './ink-surface';

describe('Ink surface canonical schema', () => {
  it('round-trips a versioned surface with logical layout and vector strokes', () => {
    const surface = fixture();
    const encoded = encodeInkSurfaceRecord(surface);

    expect(encoded).toContain('"pointEncoding": "delta-v1"');
    expect(encoded).not.toContain('"points":');
    expect(decodeInkSurfaceRecord(encoded)).toEqual(surface);
  });

  it('round-trips section bindings and linked cross-surface stroke identity', () => {
    const surface: InkSurfaceRecord = {
      ...fixture(),
      binding: {
        blockFingerprints: ['block-a'],
        headingPath: ['Chapter A'],
        sectionFingerprint: 'section-a',
        sourceEnd: 200,
        sourceStart: 100,
      },
      strokes: fixture().strokes.map((stroke) => ({
        ...stroke,
        linkedStrokeId: 'stroke-user-1',
      })),
    };

    expect(decodeInkSurfaceRecord(encodeInkSurfaceRecord(surface))).toEqual(surface);
  });

  it('continues to read early schema-v1 files that stored absolute points', () => {
    const surface = fixture();

    expect(decodeInkSurfaceRecord(JSON.stringify(surface))).toEqual(surface);
  });

  it.each([
    ['point outside logical width', (surface: InkSurfaceRecord) => mutateX(surface, 961)],
    ['negative point', (surface: InkSurfaceRecord) => mutateX(surface, -1)],
    ['pressure above one', (surface: InkSurfaceRecord) => mutatePressure(surface, 1.1)],
    ['non-increasing revision', (surface: InkSurfaceRecord) => ({ ...surface, revision: 0 })],
    [
      'duplicate stroke IDs',
      (surface: InkSurfaceRecord) => {
        const stroke = surface.strokes[0] as (typeof surface.strokes)[number];
        return { ...surface, strokes: [stroke, stroke] };
      },
    ],
    [
      'invalid section binding range',
      (surface: InkSurfaceRecord) => ({
        ...surface,
        binding: {
          blockFingerprints: ['block-a'],
          headingPath: ['Chapter A'],
          sectionFingerprint: 'section-a',
          sourceEnd: 99,
          sourceStart: 100,
        },
      }),
    ],
    [
      'empty linked stroke identity',
      (surface: InkSurfaceRecord) => ({
        ...surface,
        strokes: surface.strokes.map((stroke) => ({ ...stroke, linkedStrokeId: '' })),
      }),
    ],
  ])('rejects %s', (_name, mutate) => {
    expect(() => encodeInkSurfaceRecord(mutate(fixture()))).toThrow();
  });

  it('rejects unknown schema versions without guessing a migration', () => {
    const encoded = JSON.stringify({ ...fixture(), schemaVersion: 2 });

    expect(() => decodeInkSurfaceRecord(encoded)).toThrow('does not match schema version 1');
  });
});

function fixture(): InkSurfaceRecord {
  return {
    createdAt: '2026-07-14T10:00:00.000Z',
    deviceId: 'device-mac',
    filePath: 'Notes/Ink.md',
    id: 'surface-1',
    layout: {
      blockFingerprints: ['block-a'],
      fontFamily: 'Inter',
      fontSize: 18,
      lineHeight: 28,
      logicalHeight: 1200,
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
        id: 'stroke-1',
        points: [
          { pressure: 0.5, time: 1, x: 10, y: 20 },
          { pressure: 0.7, tiltX: 12, tiltY: -8, time: 2, x: 30, y: 40 },
        ],
        tool: 'pen',
        width: 4,
      },
    ],
    updatedAt: '2026-07-14T10:00:00.000Z',
  };
}

function mutateX(surface: InkSurfaceRecord, x: number): InkSurfaceRecord {
  return {
    ...surface,
    strokes: surface.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point, index) => (index === 0 ? { ...point, x } : point)),
    })),
  };
}

function mutatePressure(surface: InkSurfaceRecord, pressure: number): InkSurfaceRecord {
  return {
    ...surface,
    strokes: surface.strokes.map((stroke) => ({
      ...stroke,
      points: stroke.points.map((point, index) => (index === 0 ? { ...point, pressure } : point)),
    })),
  };
}
