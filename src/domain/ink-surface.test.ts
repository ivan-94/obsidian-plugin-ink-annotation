import { describe, expect, it } from 'vitest';

import {
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  inkSurfaceVisibleBounds,
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

  it('round-trips schema-v2 note-global chunk origins', () => {
    const legacy = fixture();
    const surface: InkSurfaceRecord = {
      ...legacy,
      layout: { ...legacy.layout, originY: 240 },
      schemaVersion: 2,
    };

    expect(decodeInkSurfaceRecord(encodeInkSurfaceRecord(surface))).toEqual(surface);
  });

  it('round-trips document-relative Ink in visible workspace margins', () => {
    const surface = mutateX(fixture(), -120);
    const acrossBothMargins = {
      ...surface,
      strokes: surface.strokes.map((stroke) => {
        const first = stroke.points[0];
        const second = stroke.points[1];
        if (first === undefined || second === undefined) throw new Error('Missing fixture points.');
        return { ...stroke, points: [first, { ...second, x: 1_080 }] };
      }),
    };

    expect(decodeInkSurfaceRecord(encodeInkSurfaceRecord(acrossBothMargins))).toEqual(
      acrossBothMargins,
    );
  });

  it('expands visible bounds to retain stroke width outside the document', () => {
    const surface = fixture();
    const stroke = surface.strokes[0];
    if (stroke === undefined) throw new Error('Missing fixture stroke.');

    expect(
      inkSurfaceVisibleBounds({
        ...surface,
        strokes: [
          {
            ...stroke,
            points: stroke.points.map((point, index) => ({
              ...point,
              x: index === 0 ? -20 : surface.layout.logicalWidth + 20,
            })),
            width: 4,
          },
        ],
      }),
    ).toEqual({ height: 1200, minX: -22, minY: 0, width: 1004 });
  });

  it.each([
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
    const encoded = JSON.stringify({ ...fixture(), schemaVersion: 3 });

    expect(() => decodeInkSurfaceRecord(encoded)).toThrow('does not match a supported schema');
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
