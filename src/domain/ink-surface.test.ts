import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  inkPointsToPhysicalTrace,
  inkSurfaceVisibleBounds,
  physicalTraceToInkPoints,
  safeDecodeInkSurfaceRecord,
  type InkPhysicalPenStroke,
  type InkPhysicalPoint,
  type InkPoint,
  type InkSurfaceRecord,
} from './ink-surface';

describe('Ink surface canonical schema', () => {
  it.each([1, 2] as const)(
    'normalizes visible schema-v%s Ink to explicit legacy brush metadata without writing it back',
    (schemaVersion) => {
      const source = fixtureForSchema(schemaVersion);
      const decoded = decodeInkSurfaceRecord(JSON.stringify(source));

      expect(decoded.strokes).toMatchObject([
        {
          brushRenderVersion: 'legacy-round-v1',
          inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
          tool: 'pen',
        },
      ]);
      const reencoded = encodeInkSurfaceRecord(decoded);
      expect(reencoded).not.toContain('brushRenderVersion');
      expect(reencoded).not.toContain('inputProfile');
      expect(reencoded).toBe(encodeInkSurfaceRecord(source));
    },
  );

  it('round-trips a versioned surface with logical layout and vector strokes', () => {
    const surface = fixture();
    const encoded = encodeInkSurfaceRecord(surface);

    expect(encoded).toContain('"pointEncoding": "delta-v1"');
    expect(encoded).not.toContain('"points":');
    expect(decodeInkSurfaceRecord(encoded)).toEqual(normalizedLegacy(surface));
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

    expect(decodeInkSurfaceRecord(encodeInkSurfaceRecord(surface))).toEqual(
      normalizedLegacy(surface),
    );
  });

  it('continues to read early schema-v1 files that stored absolute points', () => {
    const surface = fixture();

    expect(decodeInkSurfaceRecord(JSON.stringify(surface))).toEqual(normalizedLegacy(surface));
  });

  it('round-trips schema-v2 note-global chunk origins', () => {
    const legacy = fixture();
    const surface: InkSurfaceRecord = {
      ...legacy,
      layout: { ...legacy.layout, originY: 240 },
      schemaVersion: 2,
    };

    expect(decodeInkSurfaceRecord(encodeInkSurfaceRecord(surface))).toEqual(
      normalizedLegacy(surface),
    );
  });

  it('round-trips mixed schema-v3 brush contracts without adding metadata to historical erasers', () => {
    const surface = mixedV3Fixture();

    const encoded = encodeInkSurfaceRecord(surface);
    const decoded = decodeInkSurfaceRecord(encoded);

    expect(decoded).toEqual(surface);
    expect(encodeInkSurfaceRecord(decoded)).toBe(encoded);
    const stored = JSON.parse(encoded) as { strokes: Record<string, unknown>[] };
    expect(stored.strokes[0]).toMatchObject({
      brushRenderVersion: 'legacy-round-v1',
      inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
    });
    expect(stored.strokes[1]).toMatchObject({
      brushRenderVersion: 'pen-physical-v1',
      inputProfile: { pressure: 'measured', tilt: 'unavailable' },
    });
    expect(stored.strokes[2]).toMatchObject({
      brushRenderVersion: 'highlighter-chisel-v1',
      inputProfile: { pressure: 'measured', tilt: 'measured' },
    });
    expect(stored.strokes[3]).not.toHaveProperty('brushRenderVersion');
    expect(stored.strokes[3]).not.toHaveProperty('inputProfile');
  });

  it('round-trips the exact physical Brush Control Trace including sensor provenance and orientation reliability', () => {
    const legacy = normalizedLegacy(fixture());
    const trace = {
      kind: 'physical-control-trace' as const,
      points: [
        {
          orientation: {
            altitude: 0.2,
            azimuth: Math.PI * 1.9,
            kind: 'measured' as const,
            reliable: true,
          },
          pressure: { kind: 'measured' as const, value: 0 },
          time: 125.61794581918201,
          x: 203.52239712556852,
          y: 56.970881592869134,
        },
        {
          orientation: { kind: 'unavailable' as const },
          pressure: { kind: 'unavailable' as const, value: 0.5 },
          time: 447.5428689098781,
          x: 486.0759235826461,
          y: 240.50144108255907,
        },
      ],
    };
    const physical = {
      ...legacy,
      layout: { ...legacy.layout, originY: 0 },
      schemaVersion: 3,
      strokes: [
        {
          brushRenderVersion: 'pen-physical-v1',
          color: '#112233',
          id: 'physical-trace',
          inputProfile: { pressure: 'measured', tilt: 'measured' },
          points: physicalTraceToInkPoints(trace),
          tool: 'pen',
          width: 4,
        },
      ],
    } as unknown as InkSurfaceRecord;

    const encoded = encodeInkSurfaceRecord(physical);
    const stored = JSON.parse(encoded) as {
      strokes: Array<{ pointEncoding?: string; points?: readonly unknown[] }>;
    };

    expect(stored.strokes[0]?.pointEncoding).toBeUndefined();
    expect(stored.strokes[0]?.points).toHaveLength(2);
    const decoded = decodeInkSurfaceRecord(encoded);
    expect(decoded).toEqual(physical);
    const decodedStroke = decoded.strokes[0];
    if (decodedStroke?.brushRenderVersion !== 'pen-physical-v1') {
      throw new Error('Expected a physical Pen trace.');
    }
    expect(inkPointsToPhysicalTrace(decodedStroke.points)).toEqual(trace);
    expect(encodeInkSurfaceRecord(decoded)).toBe(encoded);
    expectTypeOf(decodedStroke.points).toMatchTypeOf<readonly InkPhysicalPoint[]>();
    expectTypeOf<InkPhysicalPenStroke['points'][number]>().toEqualTypeOf<InkPhysicalPoint>();
    expectTypeOf<InkPoint extends InkPhysicalPoint ? true : false>().toEqualTypeOf<false>();
  });

  it('reads unlinked physical-delta-v1 bytes but rewrites them as raw absolute points', () => {
    const source = mixedV3Fixture();
    const physical = source.strokes[1];
    if (physical === undefined) throw new Error('Missing physical delta compatibility fixture.');
    const stored = JSON.parse(
      encodeInkSurfaceRecord({ ...source, strokes: [{ ...physical, points: physical.points }] }),
    ) as { strokes: Record<string, unknown>[] };
    stored.strokes[0] = {
      brushRenderVersion: 'pen-physical-v1',
      color: '#112233',
      deltas: [
        {
          dt: 1.25,
          dx: 2.5,
          dy: 3.75,
          orientation: { kind: 'unavailable' },
          pressure: { kind: 'unavailable', value: 0.75 },
        },
      ],
      id: 'physical-delta-v1',
      inputProfile: { pressure: 'measured', tilt: 'unavailable' },
      origin: {
        orientation: { kind: 'unavailable' },
        pressure: { kind: 'measured', value: 0.25 },
        time: 10.5,
        x: 20.25,
        y: 30.125,
      },
      pointEncoding: 'physical-delta-v1',
      tool: 'pen',
      width: 4,
    };

    const decoded = decodeInkSurfaceRecord(JSON.stringify(stored));
    expect(decoded.strokes[0]?.points).toEqual([
      {
        orientation: { kind: 'unavailable' },
        pressure: 0.25,
        pressureKind: 'measured',
        time: 10.5,
        x: 20.25,
        y: 30.125,
      },
      {
        orientation: { kind: 'unavailable' },
        pressure: 0.75,
        pressureKind: 'unavailable',
        time: 11.75,
        x: 22.75,
        y: 33.875,
      },
    ]);
    const rewritten = JSON.parse(encodeInkSurfaceRecord(decoded)) as {
      strokes: Array<{ pointEncoding?: string; points?: readonly unknown[] }>;
    };
    expect(rewritten.strokes[0]?.pointEncoding).toBeUndefined();
    expect(rewritten.strokes[0]?.points).toHaveLength(2);
  });

  it('fails closed on linked physical-delta-v1 bytes even with otherwise complete provenance', () => {
    const source = mixedV3Fixture();
    const stored = JSON.parse(encodeInkSurfaceRecord({ ...source, strokes: [] })) as {
      strokes: Record<string, unknown>[];
    };
    stored.strokes = [
      {
        brushRenderVersion: 'pen-physical-v1',
        color: '#112233',
        deltas: [
          {
            dt: 1,
            dx: 1,
            dy: 1,
            fragmentGlobalY: 21,
            fragmentTraceOrder: 1,
            orientation: { kind: 'unavailable' },
            pressure: { kind: 'measured', value: 0.5 },
          },
        ],
        id: 'linked-physical-delta-v1',
        inputProfile: { pressure: 'measured', tilt: 'unavailable' },
        linkedStrokeId: 'linked-physical',
        origin: {
          fragmentGlobalY: 20,
          fragmentTraceOrder: 0,
          orientation: { kind: 'unavailable' },
          pressure: { kind: 'measured', value: 0.5 },
          time: 1,
          x: 10,
          y: 20,
        },
        pointEncoding: 'physical-delta-v1',
        tool: 'pen',
        width: 4,
      },
    ];

    expect(safeDecodeInkSurfaceRecord(JSON.stringify(stored))).toMatchObject({
      kind: 'corrupt',
      reason: 'invalid-record',
    });
  });

  it('fails closed on raw linked points missing global or boundary-edge provenance', () => {
    const source = mixedV3Fixture();
    const physical = source.strokes[1];
    const point = physical?.points[0];
    if (physical === undefined || point === undefined) {
      throw new Error('Missing raw linked provenance fixture.');
    }
    const linked: InkSurfaceRecord = {
      ...source,
      strokes: [
        {
          ...physical,
          id: 'raw-linked',
          linkedStrokeId: 'raw-logical',
          points: [
            {
              ...point,
              fragmentBoundary: 'authored-copy',
              fragmentBoundaryEdge: 'start',
              fragmentBoundaryId: 'raw-logical:boundary:0',
              fragmentGlobalY: 0,
              fragmentTraceOrder: 0,
              y: 0,
            } as InkPhysicalPoint,
          ],
        },
      ],
    };
    const missingGlobal = JSON.parse(encodeInkSurfaceRecord(linked)) as {
      strokes: Array<{ points: Array<Record<string, unknown>> }>;
    };
    delete missingGlobal.strokes[0]?.points[0]?.fragmentGlobalY;
    expect(safeDecodeInkSurfaceRecord(JSON.stringify(missingGlobal))).toMatchObject({
      kind: 'corrupt',
      reason: 'invalid-record',
    });

    const missingEdge = JSON.parse(encodeInkSurfaceRecord(linked)) as typeof missingGlobal;
    delete missingEdge.strokes[0]?.points[0]?.fragmentBoundaryEdge;
    expect(safeDecodeInkSurfaceRecord(JSON.stringify(missingEdge))).toMatchObject({
      kind: 'corrupt',
      reason: 'invalid-record',
    });
  });

  it('rejects a persisted physical boundary edge that no longer matches local layout', () => {
    const source = mixedV3Fixture();
    const physical = source.strokes[1];
    if (physical === undefined) throw new Error('Missing physical boundary validation fixture.');
    const point = physical.points[0];
    if (point === undefined) throw new Error('Missing physical boundary point fixture.');
    const malformed: InkSurfaceRecord = {
      ...source,
      layout: { ...source.layout, logicalHeight: 700 },
      strokes: [
        {
          ...physical,
          id: 'physical-boundary-fragment',
          linkedStrokeId: 'physical-boundary',
          points: [
            {
              ...point,
              fragmentBoundary: 'synthetic-clip',
              fragmentBoundaryEdge: 'end',
              fragmentBoundaryId: 'physical-boundary:boundary:0.5',
              fragmentGlobalY: 600,
              fragmentTraceOrder: 0.5,
              y: 600,
            } as InkPhysicalPoint,
          ],
        },
      ],
    };

    expect(() => encodeInkSurfaceRecord(malformed)).toThrow(/invalid point/u);
    const wrongStart: InkSurfaceRecord = {
      ...malformed,
      strokes: malformed.strokes.map((stroke) => ({
        ...stroke,
        points: stroke.points.map(
          (candidate) =>
            ({ ...candidate, fragmentBoundaryEdge: 'start', y: 1 }) as InkPhysicalPoint,
        ),
      })),
    };
    expect(() => encodeInkSurfaceRecord(wrongStart)).toThrow(/invalid point/u);
  });

  it('rejects non-monotonic physical fragment order at the canonical write boundary', () => {
    const source = mixedV3Fixture();
    const physical = source.strokes[1];
    if (physical === undefined || physical.points.length < 2) {
      throw new Error('Missing physical order validation fixture.');
    }
    const malformed: InkSurfaceRecord = {
      ...source,
      strokes: [
        {
          ...physical,
          id: 'physical-order-fragment',
          linkedStrokeId: 'physical-order',
          points: physical.points.map(
            (point, index) =>
              ({
                ...point,
                fragmentGlobalY: point.y,
                fragmentTraceOrder: index === 0 ? 1 : 0,
              }) as InkPhysicalPoint,
          ),
        },
      ],
    };

    expect(() => encodeInkSurfaceRecord(malformed)).toThrow(/invalid physical fragment order/u);
  });

  it('rejects a forged physical boundary identity at the canonical write boundary', () => {
    const source = mixedV3Fixture();
    const physical = source.strokes[1];
    const point = physical?.points[0];
    if (physical === undefined || point === undefined) {
      throw new Error('Missing physical boundary identity fixture.');
    }
    const malformed: InkSurfaceRecord = {
      ...source,
      strokes: [
        {
          ...physical,
          id: 'physical-forged-boundary',
          linkedStrokeId: 'physical-logical',
          points: [
            {
              ...point,
              fragmentBoundary: 'synthetic-clip',
              fragmentBoundaryEdge: 'start',
              fragmentBoundaryId: 'forged',
              fragmentGlobalY: 0,
              fragmentTraceOrder: 0.5,
              y: 0,
            } as InkPhysicalPoint,
          ],
        },
      ],
    };

    expect(() => encodeInkSurfaceRecord(malformed)).toThrow(/invalid physical boundary identity/u);
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
      normalizedLegacy(acrossBothMargins),
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

  it('unions compiled legacy and physical bounds while retaining historical Eraser semantics', () => {
    const mixed = mixedV3Fixture();
    const outside = {
      ...mixed,
      strokes: mixed.strokes.map((stroke) =>
        stroke.id === 'stroke-historical-eraser'
          ? {
              ...stroke,
              points: stroke.points.map((point) => ({ ...point, x: -200 })),
            }
          : stroke.id === 'stroke-physical-highlighter'
            ? {
                ...stroke,
                points: stroke.points.map((point, index) => ({
                  ...point,
                  orientation: {
                    altitude: 0.2,
                    azimuth: 0,
                    kind: 'measured' as const,
                    reliable: true,
                  },
                  pressure: 1,
                  pressureKind: 'measured' as const,
                  x: index === 0 ? -20 : -10,
                })),
              }
            : stroke,
      ),
    };

    const bounds = inkSurfaceVisibleBounds(outside);

    expect(bounds.minX).toBeLessThan(-26);
    expect(bounds.minX).toBeGreaterThan(-27);
    expect(bounds.minY).toBe(0);
    expect(bounds.height).toBe(1200);
    expect(bounds.width).toBe(960 - bounds.minX);
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

  it('preserves unsupported schema bytes without guessing a migration', () => {
    const encoded = JSON.stringify({ ...fixture(), schemaVersion: 4 });
    const unknownRecord = {
      ...normalizedLegacy(fixture()),
      layout: { ...fixture().layout, originY: 0 },
      schemaVersion: 4,
    } as unknown as InkSurfaceRecord;

    expect(safeDecodeInkSurfaceRecord(encoded)).toEqual({
      kind: 'unsupported',
      rawBytes: encoded,
      reason: 'unsupported-schema-version',
    });
    expect(() => decodeInkSurfaceRecord(encoded)).toThrow('does not match a supported schema');
    expect(() => encodeInkSurfaceRecord(unknownRecord)).toThrow('unsupported schema version');
  });

  it('preserves unknown schema-v3 brush-version bytes and fails closed', () => {
    const stored = JSON.parse(encodeInkSurfaceRecord(mixedV3Fixture())) as {
      strokes: Record<string, unknown>[];
    };
    const physicalPen = stored.strokes[1];
    if (physicalPen === undefined) throw new Error('Missing physical Pen fixture.');
    physicalPen.brushRenderVersion = 'future-pen-v9';
    const encoded = JSON.stringify(stored);

    expect(safeDecodeInkSurfaceRecord(encoded)).toEqual({
      kind: 'unsupported',
      rawBytes: encoded,
      reason: 'unsupported-brush-version',
    });
    expect(() => decodeInkSurfaceRecord(encoded)).toThrow('unsupported brush metadata');
  });

  it.each(['candidateRevision', 'futureBrushMetadata'])(
    'fails closed instead of persisting unknown stroke metadata key %s',
    (unknownKey) => {
      const surface = mixedV3Fixture();
      const physicalPen = surface.strokes[1];
      if (physicalPen === undefined) throw new Error('Missing physical Pen fixture.');
      const contaminated: InkSurfaceRecord = {
        ...surface,
        strokes: [
          surface.strokes[0] as InkSurfaceRecord['strokes'][number],
          { ...physicalPen, [unknownKey]: 'not-canonical' },
          ...surface.strokes.slice(2),
        ],
      };

      expect(() => encodeInkSurfaceRecord(contaminated)).toThrow('unsupported brush metadata');

      const stored = JSON.parse(encodeInkSurfaceRecord(surface)) as {
        strokes: Record<string, unknown>[];
      };
      const storedPhysicalPen = stored.strokes[1];
      if (storedPhysicalPen === undefined) throw new Error('Missing stored physical Pen fixture.');
      storedPhysicalPen[unknownKey] = 'not-canonical';
      const encoded = JSON.stringify(stored);
      expect(safeDecodeInkSurfaceRecord(encoded)).toEqual({
        kind: 'unsupported',
        rawBytes: encoded,
        reason: 'unsupported-brush-metadata',
      });
    },
  );

  it.each([1, 2] as const)(
    'does not permit physical brush metadata in schema-v%s',
    (schemaVersion) => {
      const legacy = normalizedLegacy(fixtureForSchema(schemaVersion));
      const stroke = legacy.strokes[0];
      if (stroke === undefined) throw new Error('Missing fixture stroke.');
      const physical: InkSurfaceRecord = {
        ...legacy,
        strokes: [
          {
            ...stroke,
            brushRenderVersion: 'pen-physical-v1',
            color: '#112233',
            inputProfile: { pressure: 'measured', tilt: 'unavailable' },
          },
        ],
      };
      const encoded = JSON.stringify(physical);

      expect(() => encodeInkSurfaceRecord(physical)).toThrow('unsupported brush metadata');
      expect(safeDecodeInkSurfaceRecord(encoded)).toEqual({
        kind: 'unsupported',
        rawBytes: encoded,
        reason: 'unsupported-brush-metadata',
      });
    },
  );

  it.each([
    [
      'known version on the wrong tool',
      (stroke: Record<string, unknown>) => {
        stroke.brushRenderVersion = 'highlighter-chisel-v1';
      },
    ],
    [
      'mixed legacy and physical profile',
      (stroke: Record<string, unknown>) => {
        stroke.inputProfile = { pressure: 'legacy-unknown', tilt: 'measured' };
      },
    ],
    [
      'missing input profile',
      (stroke: Record<string, unknown>) => {
        delete stroke.inputProfile;
      },
    ],
    [
      'non-opaque physical Highlighter color',
      (_stroke: Record<string, unknown>, stored: { strokes: Record<string, unknown>[] }) => {
        const highlighter = stored.strokes[2];
        if (highlighter === undefined) throw new Error('Missing physical Highlighter fixture.');
        highlighter.color = '#ffe08280';
      },
    ],
    [
      'brush metadata on a historical Eraser',
      (_stroke: Record<string, unknown>, stored: { strokes: Record<string, unknown>[] }) => {
        const eraser = stored.strokes[3];
        if (eraser === undefined) throw new Error('Missing historical Eraser fixture.');
        eraser.brushRenderVersion = 'legacy-round-v1';
        eraser.inputProfile = { pressure: 'legacy-unknown', tilt: 'legacy-unknown' };
      },
    ],
  ] as const)('classifies %s as unsupported brush metadata', (_name, mutate) => {
    const stored = JSON.parse(encodeInkSurfaceRecord(mixedV3Fixture())) as {
      strokes: Record<string, unknown>[];
    };
    const physicalPen = stored.strokes[1];
    if (physicalPen === undefined) throw new Error('Missing physical Pen fixture.');
    mutate(physicalPen, stored);
    const encoded = JSON.stringify(stored);

    expect(safeDecodeInkSurfaceRecord(encoded)).toEqual({
      kind: 'unsupported',
      rawBytes: encoded,
      reason: 'unsupported-brush-metadata',
    });
    expect(() => decodeInkSurfaceRecord(encoded)).toThrow('unsupported brush metadata');
  });

  it.each([
    ['invalid JSON', '{not-json', 'invalid-json'],
    [
      'invalid record shape',
      JSON.stringify({ ...fixture(), strokes: [{ ...fixture().strokes[0], points: [] }] }),
      'invalid-record',
    ],
  ] as const)('classifies %s as corrupt while retaining bytes', (_name, encoded, reason) => {
    expect(safeDecodeInkSurfaceRecord(encoded)).toEqual({
      kind: 'corrupt',
      rawBytes: encoded,
      reason,
    });
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

function fixtureForSchema(schemaVersion: 1 | 2): InkSurfaceRecord {
  const surface = fixture();
  return schemaVersion === 1
    ? surface
    : {
        ...surface,
        layout: { ...surface.layout, originY: 240 },
        schemaVersion,
      };
}

function mixedV3Fixture(): InkSurfaceRecord {
  const legacy = normalizedLegacy(fixture());
  const legacyStroke = legacy.strokes[0];
  if (legacyStroke === undefined) throw new Error('Missing fixture stroke.');
  return {
    ...legacy,
    layout: { ...legacy.layout, originY: 0 },
    schemaVersion: 3,
    strokes: [
      legacyStroke,
      {
        ...legacyStroke,
        brushRenderVersion: 'pen-physical-v1',
        color: '#112233',
        id: 'stroke-physical-pen',
        inputProfile: { pressure: 'measured', tilt: 'unavailable' },
        points: physicalPoints(legacyStroke.points, 'unavailable'),
      },
      {
        ...legacyStroke,
        brushRenderVersion: 'highlighter-chisel-v1',
        color: '#ffe082',
        id: 'stroke-physical-highlighter',
        inputProfile: { pressure: 'measured', tilt: 'measured' },
        points: physicalPoints(legacyStroke.points, 'measured'),
        tool: 'highlighter',
        width: 12,
      },
      {
        color: '#000000',
        id: 'stroke-historical-eraser',
        points: legacyStroke.points,
        tool: 'eraser',
        width: 12,
      },
    ],
  };
}

function physicalPoints(points: readonly InkPoint[], tilt: 'measured' | 'unavailable') {
  return points.map((point) => ({
    orientation:
      tilt === 'measured'
        ? ({ altitude: 0.4, azimuth: 0.8, kind: 'measured', reliable: true } as const)
        : ({ kind: 'unavailable' } as const),
    pressure: point.pressure,
    pressureKind: 'measured' as const,
    time: point.time,
    x: point.x,
    y: point.y,
  }));
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

function normalizedLegacy(surface: InkSurfaceRecord): InkSurfaceRecord {
  return {
    ...surface,
    strokes: surface.strokes.map((stroke) =>
      stroke.tool === 'eraser'
        ? stroke
        : {
            ...stroke,
            brushRenderVersion: 'legacy-round-v1',
            inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
          },
    ),
  };
}
