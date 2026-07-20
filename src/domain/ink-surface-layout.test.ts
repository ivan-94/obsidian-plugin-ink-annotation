import { describe, expect, it } from 'vitest';

import { SharedInkStrokeGeometry } from './ink-shared-stroke-geometry';
import {
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  type InkPhysicalPoint,
  type InkPoint,
  type InkStroke,
  type InkSurfaceRecord,
} from './ink-surface';
import {
  confirmInkDocumentRebase,
  confirmInkRebase,
  joinInkStrokeSurfaceFragments,
  partitionInkBlocks,
  previewInkDocumentRebase,
  previewInkRebase,
  reconcileInkSurface,
  splitInkStrokeIntoSurfaceFragments,
  type InkSurfaceSection,
} from './ink-surface-layout';

describe('bounded Ink surface layout', () => {
  it('partitions by heading section and bounded block groups without defaulting to full note', () => {
    const partitions = partitionInkBlocks(
      [
        block('h-a', 0, 5, ['A'], 'heading'),
        block('a-1', 6, 20, ['A']),
        block('a-2', 21, 35, ['A']),
        block('a-3', 36, 50, ['A']),
        block('h-b', 51, 56, ['B'], 'heading'),
        block('b-1', 57, 70, ['B']),
      ],
      { maxBlocks: 3 },
    );

    expect(partitions.map((surface) => [surface.headingPath, surface.blockFingerprints])).toEqual([
      [['A'], ['h-a', 'a-1', 'a-2']],
      [['A'], ['a-3']],
      [['B'], ['h-b', 'b-1']],
    ]);
    expect(partitions.every((surface) => !surface.fullNoteFallback)).toBe(true);
  });

  it('splits a crossing stroke into local linked fragments with a shared boundary point', () => {
    const fragments = splitInkStrokeIntoSurfaceFragments({
      stroke: {
        color: '#4f46d8',
        id: 'stroke-user-1',
        points: [point(100, 550), point(200, 650)],
        tool: 'pen',
        width: 4,
      },
      surfaces: [
        { endY: 600, id: 'surface-a', logicalHeight: 600, startY: 0 },
        { endY: 1200, id: 'surface-b', logicalHeight: 600, startY: 600 },
      ],
    });

    expect(fragments).toHaveLength(2);
    expect(fragments.map((fragment) => fragment.stroke.linkedStrokeId)).toEqual([
      'stroke-user-1',
      'stroke-user-1',
    ]);
    expect(fragments[0]?.stroke.points.at(-1)).toMatchObject({ x: 150, y: 600 });
    expect(fragments[1]?.stroke.points[0]).toMatchObject({ x: 150, y: 0 });
  });

  it('preserves drawing direction when a stroke crosses surfaces from bottom to top', () => {
    const fragments = splitInkStrokeIntoSurfaceFragments({
      stroke: {
        color: '#4f46d8',
        id: 'stroke-upward',
        points: [point(200, 650), point(100, 550)],
        tool: 'pen',
        width: 4,
      },
      surfaces: [
        { endY: 600, id: 'surface-a', logicalHeight: 600, startY: 0 },
        { endY: 1200, id: 'surface-b', logicalHeight: 600, startY: 600 },
      ],
    });

    expect(fragments[0]?.stroke.points).toMatchObject([
      { x: 150, y: 600 },
      { x: 100, y: 550 },
    ]);
    expect(fragments[1]?.stroke.points).toMatchObject([
      { x: 200, y: 50 },
      { x: 150, y: 0 },
    ]);
  });

  it('round-trips a stroke across multiple surfaces below the visual error threshold', () => {
    const bounds = [
      { endY: 400, id: 'a', logicalHeight: 400, startY: 0 },
      { endY: 800, id: 'b', logicalHeight: 400, startY: 400 },
      { endY: 1200, id: 'c', logicalHeight: 400, startY: 800 },
    ];
    const original = [point(20, 350), point(220, 650), point(420, 950)];
    const fragments = splitInkStrokeIntoSurfaceFragments({
      stroke: {
        color: '#4f46d8',
        id: 'long-stroke',
        points: original,
        tool: 'pen',
        width: 4,
      },
      surfaces: bounds,
    });
    const reloaded = fragments.map((fragment) => {
      const bound = bounds.find((candidate) => candidate.id === fragment.surfaceId);
      if (bound === undefined) throw new Error('Missing test bound.');
      const record = {
        ...surfaceFixture(),
        id: fragment.surfaceId,
        layout: { ...surfaceFixture().layout, logicalHeight: bound.logicalHeight },
        strokes: [fragment.stroke],
      };
      return {
        startY: bound.startY,
        stroke: decodeInkSurfaceRecord(encodeInkSurfaceRecord(record)).strokes[0],
      };
    });
    const joined = reloaded.flatMap(({ startY, stroke }, index) =>
      (stroke?.points ?? []).slice(index === 0 ? 0 : 1).map((candidate) => ({
        ...candidate,
        y: candidate.y + startY,
      })),
    );

    expect(maximumPolylineError(original, joined)).toBeLessThanOrEqual(1e-9);
  });

  it('preserves the complete physical brush identity through split and fences per-surface rebase', () => {
    const physicalStroke: InkStroke = {
      brushRenderVersion: 'pen-physical-v1',
      color: '#112233',
      id: 'physical-crossing',
      inputProfile: { pressure: 'measured', tilt: 'unavailable' },
      points: [physicalPoint(100, 550), physicalPoint(200, 650)],
      tool: 'pen',
      width: 4,
    };

    const fragments = splitInkStrokeIntoSurfaceFragments({
      stroke: physicalStroke,
      surfaces: [
        { endY: 600, id: 'surface-a', logicalHeight: 600, startY: 0 },
        { endY: 1200, id: 'surface-b', logicalHeight: 600, startY: 600 },
      ],
    });

    expect(fragments.map(({ stroke }) => stroke)).toMatchObject([
      {
        brushRenderVersion: 'pen-physical-v1',
        color: '#112233',
        inputProfile: { pressure: 'measured', tilt: 'unavailable' },
        linkedStrokeId: 'physical-crossing',
        tool: 'pen',
        width: 4,
      },
      {
        brushRenderVersion: 'pen-physical-v1',
        color: '#112233',
        inputProfile: { pressure: 'measured', tilt: 'unavailable' },
        linkedStrokeId: 'physical-crossing',
        tool: 'pen',
        width: 4,
      },
    ]);

    const record = {
      ...surfaceFixture(),
      layout: { ...surfaceFixture().layout, logicalHeight: 600, originY: 0 },
      schemaVersion: 3 as const,
      strokes: [fragments[0]?.stroke as InkStroke],
    };
    expect(() =>
      previewInkRebase(record, section('section-b', 300, 500, ['block-b']), {
        ...layout(),
        logicalHeight: 700,
        logicalWidth: 480,
      }),
    ).toThrow(/document-level rebase/u);
    const stalePreview = {
      baseRevision: record.revision,
      record: { ...record, layout: { ...record.layout, logicalHeight: 700 } },
      surfaceId: record.id,
    };
    expect(() => confirmInkRebase(record, stalePreview, '2026-07-14T12:00:00.000Z')).toThrow(
      /document-level rebase/u,
    );
    expect(record.strokes).toEqual([fragments[0]?.stroke]);
  });

  it('joins schema-v3 fragments only when every complete brush identity field matches', () => {
    const fragments = splitInkStrokeIntoSurfaceFragments({
      stroke: {
        brushRenderVersion: 'pen-physical-v1',
        color: '#112233',
        id: 'physical-crossing',
        inputProfile: { pressure: 'measured', tilt: 'unavailable' },
        points: [physicalPoint(100, 550), physicalPoint(200, 650)],
        tool: 'pen',
        width: 4,
      },
      surfaces: [
        { endY: 600, id: 'surface-a', logicalHeight: 600, startY: 0 },
        { endY: 1200, id: 'surface-b', logicalHeight: 600, startY: 600 },
      ],
    });

    const joined = joinInkStrokeSurfaceFragments(
      boundedPhysicalJoinFragments(fragments, [
        { endY: 600, id: 'surface-a', logicalHeight: 600, startY: 0 },
        { endY: 1200, id: 'surface-b', logicalHeight: 600, startY: 600 },
      ]),
    );

    expect(joined).toMatchObject([
      {
        brushRenderVersion: 'pen-physical-v1',
        color: '#112233',
        id: 'physical-crossing',
        inputProfile: { pressure: 'measured', tilt: 'unavailable' },
        points: [{ y: 550 }, { y: 650 }],
        tool: 'pen',
        width: 4,
      },
    ]);

    const second = fragments[1]?.stroke;
    if (second === undefined) throw new Error('Missing physical test fragment.');
    const { linkedStrokeId: _linkedStrokeId, ...withoutLinkedIdentity } = second;
    void _linkedStrokeId;
    for (const mismatched of [
      {
        ...second,
        brushRenderVersion: 'highlighter-chisel-v1' as const,
        tool: 'highlighter' as const,
      },
      { ...second, color: '#445566' },
      {
        ...second,
        inputProfile: { pressure: 'unavailable' as const, tilt: 'unavailable' as const },
      },
      { ...withoutLinkedIdentity, id: 'physical-crossing' },
      { ...second, width: 5 },
    ]) {
      expect(() =>
        joinInkStrokeSurfaceFragments([
          {
            endY: 600,
            logicalHeight: 600,
            schemaVersion: 3,
            startY: 0,
            stroke: fragments[0]?.stroke as InkStroke,
            surfaceId: 'surface-a',
          },
          {
            endY: 1200,
            logicalHeight: 600,
            schemaVersion: 3,
            startY: 600,
            stroke: mismatched,
            surfaceId: 'surface-b',
          },
        ]),
      ).toThrow(/brush identity|unlinked fragment provenance/u);
    }
  });

  it('round-trips a crossing physical trace without promoting synthetic clip samples to canonical input', () => {
    const original: InkStroke = {
      brushRenderVersion: 'pen-physical-v1',
      color: '#112233',
      id: 'physical-no-boundary-sample',
      inputProfile: { pressure: 'measured', tilt: 'measured' },
      points: [
        physicalPoint(100, 550, 10, 0.2, {
          altitude: 0.4,
          azimuth: 6.1,
          kind: 'measured',
          reliable: true,
        }),
        physicalPoint(200, 650, 20, 0.8, {
          altitude: 0.7,
          azimuth: 0.2,
          kind: 'measured',
          reliable: true,
        }),
      ],
      tool: 'pen',
      width: 4,
    };
    const bounds = [
      { endY: 600, id: 'surface-a', logicalHeight: 600, startY: 0 },
      { endY: 1200, id: 'surface-b', logicalHeight: 600, startY: 600 },
    ];
    const persisted = splitInkStrokeIntoSurfaceFragments({
      stroke: original,
      surfaces: bounds,
    }).map((fragment) => {
      const bound = bounds.find(({ id }) => id === fragment.surfaceId);
      if (bound === undefined) throw new Error('Missing physical test surface bound.');
      const fixture = surfaceFixture();
      const record: InkSurfaceRecord = {
        ...fixture,
        id: fragment.surfaceId,
        layout: {
          ...fixture.layout,
          logicalHeight: bound.logicalHeight,
          originY: bound.startY,
        },
        schemaVersion: 3,
        strokes: [fragment.stroke],
      };
      const reloaded = decodeInkSurfaceRecord(encodeInkSurfaceRecord(record));
      return {
        endY: bound.endY,
        logicalHeight: bound.logicalHeight,
        schemaVersion: reloaded.schemaVersion,
        startY: bound.startY,
        stroke: reloaded.strokes[0] as InkStroke,
        surfaceId: bound.id,
      };
    });

    expect(() => joinInkStrokeSurfaceFragments(persisted.slice(0, 1))).toThrow(
      /incomplete physical fragment boundary/u,
    );

    const joined = joinInkStrokeSurfaceFragments(persisted)[0];
    expect(joined?.points).toEqual(original.points);

    const geometry = new SharedInkStrokeGeometry();
    const active = geometry.compile(original);
    const reloaded = joined === undefined ? undefined : geometry.compile(joined);
    expect(active.kind).toBe('unpublished');
    expect(reloaded?.kind).toBe('unpublished');
    if (active.kind !== 'unpublished' || reloaded?.kind !== 'unpublished') {
      throw new Error('Expected unpublished physical geometry in the HAT-only lane.');
    }
    expect(reloaded.geometry.traceDigest).toBe(active.geometry.traceDigest);
    expect(reloaded.geometry.geometryDigest).toBe(active.geometry.geometryDigest);
  });

  it('rejects a synthetic physical clip sample that is not owned by a linked surface fragment', () => {
    const fixture = surfaceFixture();
    const syntheticPoint: InkPhysicalPoint = {
      ...physicalPoint(10, 0),
      fragmentBoundary: 'synthetic-clip',
      fragmentBoundaryEdge: 'start',
      fragmentBoundaryId: 'orphan-boundary',
      fragmentTraceOrder: 0.5,
    };
    expect(() =>
      encodeInkSurfaceRecord({
        ...fixture,
        layout: { ...fixture.layout, originY: 0 },
        schemaVersion: 3,
        strokes: [
          {
            brushRenderVersion: 'pen-physical-v1',
            color: '#112233',
            id: 'unlinked-synthetic',
            inputProfile: { pressure: 'measured', tilt: 'unavailable' },
            points: [syntheticPoint],
            tool: 'pen',
            width: 4,
          },
        ],
      }),
    ).toThrow(/unlinked fragment provenance/u);
  });

  it('recovers an exact physical trace when an interior surface contains only paired clip samples', () => {
    const firstHeight = 38.47056495976742;
    const secondHeight = 798.581941134064;
    const thirdHeight = 162.9474939061686;
    const firstBoundary = firstHeight;
    const secondBoundary = firstBoundary + secondHeight;
    const finalBoundary = secondBoundary + thirdHeight;
    const stroke: InkStroke = {
      brushRenderVersion: 'pen-physical-v1',
      color: '#112233',
      id: 'physical-three-surfaces',
      inputProfile: { pressure: 'measured', tilt: 'unavailable' },
      points: [
        physicalPoint(125.61794581918201, 0, 0, 0.2),
        physicalPoint(447.5428689098781, finalBoundary, 1_000, 0.8),
      ],
      tool: 'pen',
      width: 4,
    };
    const surfaces = [
      { endY: firstBoundary, id: 'a', logicalHeight: firstHeight, startY: 0 },
      {
        endY: secondBoundary,
        id: 'b',
        logicalHeight: secondHeight,
        startY: firstBoundary,
      },
      {
        endY: finalBoundary,
        id: 'c',
        logicalHeight: thirdHeight,
        startY: secondBoundary,
      },
    ];
    const fragments = splitInkStrokeIntoSurfaceFragments({
      stroke,
      surfaces,
    });
    const persisted = fragments.map((fragment) => {
      const bound = surfaces.find(({ id }) => id === fragment.surfaceId);
      if (bound === undefined) throw new Error('Missing three-surface physical bound.');
      const fixture = surfaceFixture();
      const reloaded = decodeInkSurfaceRecord(
        encodeInkSurfaceRecord({
          ...fixture,
          id: fragment.surfaceId,
          layout: {
            ...fixture.layout,
            logicalHeight: bound.logicalHeight,
            originY: bound.startY,
          },
          schemaVersion: 3,
          strokes: [fragment.stroke],
        }),
      );
      return {
        endY: bound.endY,
        logicalHeight: bound.logicalHeight,
        schemaVersion: 3 as const,
        startY: bound.startY,
        stroke: reloaded.strokes[0] as InkStroke,
        surfaceId: bound.id,
      };
    });

    expect(fragments).toHaveLength(3);
    expect(fragments[1]?.stroke.points).toMatchObject([
      { fragmentBoundary: 'synthetic-clip', y: 0 },
      { fragmentBoundary: 'synthetic-clip', y: secondHeight },
    ]);
    expect(joinInkStrokeSurfaceFragments(persisted)[0]?.points).toEqual(stroke.points);
  });

  it('uses persisted fragment trace order for equal-time multi-surface leave and re-entry', () => {
    const points = [50, 850, 250, 1_050, 350].map((y, index) =>
      physicalPoint(20 + index * 10, y, 10, 0.2 + index * 0.1),
    );
    const stroke: InkStroke = {
      brushRenderVersion: 'pen-physical-v1',
      color: '#112233',
      id: 'physical-equal-time-reentry',
      inputProfile: { pressure: 'measured', tilt: 'unavailable' },
      points,
      tool: 'pen',
      width: 4,
    };
    const surfaces = [
      { endY: 400, id: 'a', logicalHeight: 400, startY: 0 },
      { endY: 800, id: 'b', logicalHeight: 400, startY: 400 },
      { endY: 1_200, id: 'c', logicalHeight: 400, startY: 800 },
    ];
    const fragments = splitInkStrokeIntoSurfaceFragments({ stroke, surfaces });
    const joinedInput = fragments.map((fragment) => {
      const surface = surfaces.find(({ id }) => id === fragment.surfaceId);
      if (surface === undefined) throw new Error('Missing equal-time test surface.');
      return {
        endY: surface.endY,
        logicalHeight: surface.logicalHeight,
        schemaVersion: 3 as const,
        startY: surface.startY,
        stroke: fragment.stroke,
        surfaceId: surface.id,
      };
    });

    expect(joinInkStrokeSurfaceFragments([...joinedInput].reverse())[0]?.points).toEqual(points);
  });

  it('snaps fractional clip coordinates to the exact shared surface boundary', () => {
    const origin = 56.970881592869134;
    const topHeight = 183.53055948968995;
    const bottomHeight = 400;
    const boundary = origin + topHeight;
    const points = [
      physicalPoint(10, boundary - 100, 1, 0.2),
      physicalPoint(30, boundary + 100, 3, 0.8),
    ];
    const stroke: InkStroke = {
      brushRenderVersion: 'pen-physical-v1',
      color: '#112233',
      id: 'physical-fractional-boundary',
      inputProfile: { pressure: 'measured', tilt: 'unavailable' },
      points,
      tool: 'pen',
      width: 4,
    };
    const surfaces = [
      { endY: boundary, id: 'top', logicalHeight: topHeight, startY: origin },
      {
        endY: boundary + bottomHeight,
        id: 'bottom',
        logicalHeight: bottomHeight,
        startY: boundary,
      },
    ];
    const fragments = splitInkStrokeIntoSurfaceFragments({ stroke, surfaces });
    const persisted = fragments.map((fragment) => {
      const bound = surfaces.find(({ id }) => id === fragment.surfaceId);
      if (bound === undefined) throw new Error('Missing fractional physical test bound.');
      const fixture = surfaceFixture();
      const reloaded = decodeInkSurfaceRecord(
        encodeInkSurfaceRecord({
          ...fixture,
          id: fragment.surfaceId,
          layout: {
            ...fixture.layout,
            logicalHeight: bound.logicalHeight,
            originY: bound.startY,
          },
          schemaVersion: 3,
          strokes: [fragment.stroke],
        }),
      );
      return {
        endY: bound.endY,
        logicalHeight: bound.logicalHeight,
        schemaVersion: 3 as const,
        startY: bound.startY,
        stroke: reloaded.strokes[0] as InkStroke,
        surfaceId: bound.id,
      };
    });

    expect(fragments[0]?.stroke.points.at(-1)?.y).toBe(topHeight);
    expect(fragments[1]?.stroke.points[0]?.y).toBe(0);
    expect(joinInkStrokeSurfaceFragments(persisted)[0]?.points).toEqual(points);
  });

  it('rejects a persisted physical run whose provenance order contradicts point order', () => {
    const stroke: InkStroke = {
      brushRenderVersion: 'pen-physical-v1',
      color: '#112233',
      id: 'physical-order-fragment',
      inputProfile: { pressure: 'measured', tilt: 'unavailable' },
      linkedStrokeId: 'physical-order',
      points: [
        {
          ...physicalPoint(10, 10, 1),
          fragmentGlobalY: 10,
          fragmentTraceOrder: 1,
        } as InkPhysicalPoint,
        {
          ...physicalPoint(20, 20, 2),
          fragmentGlobalY: 20,
          fragmentTraceOrder: 0,
        } as InkPhysicalPoint,
      ],
      tool: 'pen',
      width: 4,
    };

    expect(() =>
      joinInkStrokeSurfaceFragments([
        {
          endY: 100,
          logicalHeight: 100,
          schemaVersion: 3,
          startY: 0,
          stroke,
          surfaceId: 'only',
        },
      ]),
    ).toThrow(/non-monotonic physical fragment trace order/u);
  });

  it('requires both sides of an authored physical boundary copy before canonical join', () => {
    const stroke: InkStroke = {
      brushRenderVersion: 'pen-physical-v1',
      color: '#112233',
      id: 'physical-authored-boundary',
      inputProfile: { pressure: 'measured', tilt: 'unavailable' },
      points: [
        physicalPoint(10, 550, 1, 0.2),
        physicalPoint(20, 600, 2, 0.6),
        physicalPoint(30, 650, 3, 0.8),
      ],
      tool: 'pen',
      width: 4,
    };
    const surfaces = [
      { endY: 600, id: 'top', logicalHeight: 600, startY: 0 },
      { endY: 1_200, id: 'bottom', logicalHeight: 600, startY: 600 },
    ];
    const fragments = splitInkStrokeIntoSurfaceFragments({ stroke, surfaces });
    const canonical = fragments.map((fragment) => {
      const surface = surfaces.find(({ id }) => id === fragment.surfaceId) as (typeof surfaces)[0];
      return {
        endY: surface.endY,
        logicalHeight: surface.logicalHeight,
        schemaVersion: 3 as const,
        startY: surface.startY,
        stroke: fragment.stroke,
        surfaceId: surface.id,
      };
    });

    expect(() => joinInkStrokeSurfaceFragments(canonical.slice(0, 1))).toThrow(
      /incomplete physical fragment boundary/u,
    );
    expect(joinInkStrokeSurfaceFragments(canonical)[0]?.points).toEqual(stroke.points);
  });

  it('rejects two same-side copies that try to impersonate a complete physical boundary pair', () => {
    const surfaces = [
      { endY: 600, id: 'top', logicalHeight: 600, startY: 0 },
      { endY: 1_200, id: 'bottom', logicalHeight: 600, startY: 600 },
    ];
    const fragments = splitInkStrokeIntoSurfaceFragments({
      stroke: {
        brushRenderVersion: 'pen-physical-v1',
        color: '#112233',
        id: 'physical-same-side-forgery',
        inputProfile: { pressure: 'measured', tilt: 'unavailable' },
        points: [physicalPoint(10, 550, 1, 0.2), physicalPoint(30, 650, 3, 0.8)],
        tool: 'pen',
        width: 4,
      },
      surfaces,
    });
    const top = boundedPhysicalJoinFragments(fragments, surfaces)[0];
    if (top === undefined) throw new Error('Missing top physical forgery fixture.');
    const forged = {
      ...top,
      stroke: { ...top.stroke, id: `${top.stroke.id}-forged` },
      surfaceId: 'forged-top',
    };

    expect(() => joinInkStrokeSurfaceFragments([top, forged])).toThrow(
      /duplicate physical trace order|invalid physical fragment boundary/u,
    );
  });

  it('fails closed when a schema-v3 visible fragment is missing or mismatches brush metadata', () => {
    const legacyShape = {
      color: '#112233',
      id: 'missing-metadata',
      points: [point(10, 10), point(20, 20)],
      tool: 'pen' as const,
      width: 4,
    };

    expect(() =>
      joinInkStrokeSurfaceFragments([
        {
          endY: 100,
          logicalHeight: 100,
          schemaVersion: 3,
          startY: 0,
          stroke: legacyShape,
          surfaceId: 'only',
        },
      ]),
    ).toThrow(/brush metadata/u);
    expect(() =>
      joinInkStrokeSurfaceFragments([
        {
          logicalHeight: 100,
          schemaVersion: 3,
          startY: 0,
          stroke: {
            ...legacyShape,
            brushRenderVersion: 'pen-physical-v1',
            inputProfile: { pressure: 'measured', tilt: 'measured' },
            tool: 'highlighter',
          },
          surfaceId: 'only',
          endY: 100,
        },
      ]),
    ).toThrow(/brush metadata/u);
  });

  it('preserves stationary pressure impulses and never invents a physical orientation at a surface boundary', () => {
    const stationary = splitInkStrokeIntoSurfaceFragments({
      stroke: {
        brushRenderVersion: 'pen-physical-v1',
        color: '#112233',
        id: 'stationary-pressure',
        inputProfile: { pressure: 'measured', tilt: 'measured' },
        points: [physicalPoint(20, 20, 1, 0.1), physicalPoint(20, 20, 2, 0.9)],
        tool: 'pen',
        width: 4,
      },
      surfaces: [{ endY: 100, id: 'only', logicalHeight: 100, startY: 0 }],
    });

    expect(stationary[0]?.stroke.points).toMatchObject([
      { pressure: 0.1, pressureKind: 'measured', time: 1 },
      { pressure: 0.9, pressureKind: 'measured', time: 2 },
    ]);

    const crossing = splitInkStrokeIntoSurfaceFragments({
      stroke: {
        brushRenderVersion: 'highlighter-chisel-v1',
        color: '#ffcc00',
        id: 'orientation-loss',
        inputProfile: { pressure: 'measured', tilt: 'measured' },
        points: [
          physicalPoint(10, 550, 1, 0.4, {
            altitude: 0.4,
            azimuth: 6.1,
            kind: 'measured',
            reliable: true,
          }),
          physicalPoint(20, 650, 2, 0.6, { kind: 'unavailable' }),
        ],
        tool: 'highlighter',
        width: 12,
      },
      surfaces: [
        { endY: 600, id: 'top', logicalHeight: 600, startY: 0 },
        { endY: 1200, id: 'bottom', logicalHeight: 600, startY: 600 },
      ],
    });

    expect(crossing[0]?.stroke.points.at(-1)).toMatchObject({
      orientation: { kind: 'unavailable' },
      pressure: 0.5,
      pressureKind: 'measured',
    });
    expect(crossing[1]?.stroke.points[0]).toMatchObject({
      orientation: { kind: 'unavailable' },
      pressure: 0.5,
      pressureKind: 'measured',
      time: 1.5,
      x: 15,
      y: 0,
    });
  });

  it('does not synthesize legacy tilt when only one interpolation endpoint measured it', () => {
    const fragments = splitInkStrokeIntoSurfaceFragments({
      stroke: {
        color: '#112233',
        id: 'partial-legacy-tilt',
        points: [{ ...point(10, 550), tiltX: 12, tiltY: -6 }, point(20, 650)],
        tool: 'pen',
        width: 4,
      },
      surfaces: [
        { endY: 600, id: 'top', logicalHeight: 600, startY: 0 },
        { endY: 1200, id: 'bottom', logicalHeight: 600, startY: 600 },
      ],
    });

    expect(fragments[0]?.stroke.points.at(-1)).not.toHaveProperty('tiltX');
    expect(fragments[0]?.stroke.points.at(-1)).not.toHaveProperty('tiltY');
  });

  it('joins equal-time physical fragments deterministically from trace topology, not input order', () => {
    const stroke: InkStroke = {
      brushRenderVersion: 'pen-physical-v1',
      color: '#112233',
      id: 'logical',
      inputProfile: { pressure: 'measured', tilt: 'unavailable' },
      points: [
        physicalPoint(10, 550, 10, 0.1),
        physicalPoint(15, 600, 10, 0.5),
        physicalPoint(20, 650, 10, 0.9),
      ],
      tool: 'pen',
      width: 4,
    };
    const bounds = [
      { endY: 600, id: 'top', logicalHeight: 600, startY: 0 },
      { endY: 1_200, id: 'bottom', logicalHeight: 600, startY: 600 },
    ];
    const canonical = boundedPhysicalJoinFragments(
      splitInkStrokeIntoSurfaceFragments({ stroke, surfaces: bounds }),
      bounds,
    );

    const forward = joinInkStrokeSurfaceFragments(canonical);
    const reversed = joinInkStrokeSurfaceFragments([...canonical].reverse());

    expect(reversed).toEqual(forward);
    expect(forward[0]?.points).toMatchObject([
      { pressure: 0.1, x: 10, y: 550 },
      { pressure: 0.5, x: 15, y: 600 },
      { pressure: 0.9, x: 20, y: 650 },
    ]);
  });

  it('keeps exact sections active, relocates intact moves, and isolates changed/missing targets', () => {
    const record = surfaceFixture();
    const exact = section('section-a', 100, 200, ['block-a']);
    expect(reconcileInkSurface(record, [exact], layout())).toMatchObject({ kind: 'active' });

    const moved = section('section-a', 500, 600, ['block-a']);
    expect(reconcileInkSurface(record, [moved], layout())).toMatchObject({
      kind: 'relocated',
      record: { binding: { sourceStart: 500 }, revision: 2, status: 'active' },
    });

    const changed = section('section-a-v2', 100, 210, ['block-edited']);
    expect(reconcileInkSurface(record, [changed], layout())).toMatchObject({
      kind: 'needs-rebase',
      record: { status: 'needs-rebase', strokes: record.strokes },
    });
    expect(reconcileInkSurface(record, [], layout())).toMatchObject({
      kind: 'unanchored',
      record: { status: 'unanchored', strokes: record.strokes },
    });
  });

  it('allows viewport scaling but blocks font, theme, and logical-layout drift', () => {
    const record = surfaceFixture();
    const target = section('section-a', 100, 200, ['block-a']);

    expect(
      reconcileInkSurface(record, [target], { ...layout(), viewportWidth: 480 }),
    ).toMatchObject({
      kind: 'active',
    });
    for (const changed of [
      { ...layout(), fontAvailable: false },
      { ...layout(), fontFamily: 'Arial' },
      { ...layout(), themeMode: 'dark' as const },
      { ...layout(), logicalWidth: 800 },
    ]) {
      expect(reconcileInkSurface(record, [target], changed)).toMatchObject({
        kind: 'needs-rebase',
      });
    }
  });

  it('refreshes an empty surface layout automatically because no user strokes can be distorted', () => {
    const record = { ...surfaceFixture(), strokes: [] };
    const target = section('section-a', 100, 200, ['block-a']);

    expect(
      reconcileInkSurface(record, [target], { ...layout(), logicalHeight: 2400 }),
    ).toMatchObject({
      kind: 'active',
      record: { layout: { logicalHeight: 2400 }, revision: 2, status: 'active', strokes: [] },
    });
  });

  it('returns a transient needs-rebase record to active when the exact layout matches again', () => {
    const record = { ...surfaceFixture(), revision: 2, status: 'needs-rebase' as const };
    const target = section('section-a', 100, 200, ['block-a']);

    expect(reconcileInkSurface(record, [target], layout())).toMatchObject({
      kind: 'active',
      record: { revision: 3, status: 'active', strokes: record.strokes },
    });
  });

  it('previews rebase without mutation and confirms one revision with transformed points', () => {
    const record = surfaceFixture();
    const original = structuredClone(record);
    const target = section('section-b', 300, 500, ['block-b']);
    const preview = previewInkRebase(record, target, {
      ...layout(),
      logicalHeight: 600,
      logicalWidth: 480,
    });

    expect(record).toEqual(original);
    expect(preview.record).toMatchObject({
      binding: { sectionFingerprint: 'section-b' },
      revision: 1,
      status: 'active',
      strokes: [
        {
          points: [
            { x: 50, y: 50 },
            { x: 100, y: 100 },
          ],
        },
      ],
    });

    const confirmed = confirmInkRebase(record, preview, '2026-07-14T12:00:00.000Z');
    expect(confirmed).toMatchObject({ revision: 2, updatedAt: '2026-07-14T12:00:00.000Z' });
    expect(() => confirmInkRebase({ ...record, revision: 2 }, preview, 'later')).toThrow(
      /changed after the preview/u,
    );
  });

  it('rebases a complete linked physical stroke by join, document transform, and resplit', () => {
    const sourceBounds = [
      { endY: 600, id: 'surface-a', logicalHeight: 600, startY: 0 },
      { endY: 1_200, id: 'surface-b', logicalHeight: 600, startY: 600 },
    ];
    const logicalStroke: InkStroke = {
      brushRenderVersion: 'pen-physical-v1',
      color: '#112233',
      id: 'physical-rebase',
      inputProfile: { pressure: 'measured', tilt: 'measured' },
      points: [
        physicalPoint(100, 550, 1, 0.2),
        physicalPoint(150, 600, 2, 0.5),
        physicalPoint(200, 650, 3, 0.8),
      ],
      tool: 'pen',
      width: 4,
    };
    const fragments = splitInkStrokeIntoSurfaceFragments({
      stroke: logicalStroke,
      surfaces: sourceBounds,
    });
    const records = sourceBounds.map((bound, index): InkSurfaceRecord => {
      const fragment = fragments.find(({ surfaceId }) => surfaceId === bound.id);
      if (fragment === undefined) throw new Error(`Missing ${bound.id} rebase fixture.`);
      const fixture = surfaceFixture();
      return {
        ...fixture,
        id: bound.id,
        layout: {
          ...fixture.layout,
          logicalHeight: bound.logicalHeight,
          originY: bound.startY,
        },
        revision: index + 3,
        schemaVersion: 3,
        status: 'needs-rebase',
        strokes: [fragment.stroke],
      };
    });
    const original = structuredClone(records);

    const targets = [
      {
        endY: 300,
        layout: { ...layout(), logicalHeight: 300, logicalWidth: 480 },
        section: section('target-a', 300, 400, ['target-a'], 'Target A'),
        startY: 0,
        surfaceId: 'surface-a',
      },
      {
        endY: 600,
        layout: { ...layout(), logicalHeight: 300, logicalWidth: 480 },
        section: section('target-b', 401, 500, ['target-b'], 'Target B'),
        startY: 300,
        surfaceId: 'surface-b',
      },
    ] as const;
    const preview = previewInkDocumentRebase(records, targets);

    expect(records).toEqual(original);
    expect(preview.records).toMatchObject([
      {
        binding: { sectionFingerprint: 'target-a' },
        layout: { logicalHeight: 300, logicalWidth: 480, originY: 0 },
        revision: 3,
        status: 'active',
      },
      {
        binding: { sectionFingerprint: 'target-b' },
        layout: { logicalHeight: 300, logicalWidth: 480, originY: 300 },
        revision: 4,
        status: 'active',
      },
    ]);
    expect(
      joinInkStrokeSurfaceFragments(
        preview.records.flatMap((record) =>
          record.strokes.map((stroke) => ({
            endY: (record.layout.originY as number) + record.layout.logicalHeight,
            logicalHeight: record.layout.logicalHeight,
            schemaVersion: record.schemaVersion,
            startY: record.layout.originY as number,
            stroke,
            surfaceId: record.id,
          })),
        ),
      ),
    ).toEqual([
      {
        ...logicalStroke,
        points: logicalStroke.points.map((point) => ({
          ...point,
          x: point.x * 0.5,
          y: point.y * 0.5,
        })),
      },
    ]);

    const incomplete = preview.records.slice(0, 1);
    const incompleteOriginal = structuredClone(incomplete);
    expect(() => previewInkDocumentRebase(incomplete, targets.slice(0, 1))).toThrow(
      /incomplete physical fragment boundary/u,
    );
    expect(incomplete).toEqual(incompleteOriginal);
  });

  it('confirms every document-rebase surface exactly once or rejects the whole stale preview', () => {
    const records = [0, 600].map((originY, index): InkSurfaceRecord => {
      const fixture = surfaceFixture();
      return {
        ...fixture,
        id: `surface-${index}`,
        layout: { ...fixture.layout, logicalHeight: 600, originY },
        revision: index + 7,
        schemaVersion: 2,
        strokes: [],
      };
    });
    const preview = previewInkDocumentRebase(
      records,
      records.map((record, index) => ({
        endY: index * 400 + 400,
        layout: { ...layout(), logicalHeight: 400 },
        section: section(`target-${index}`, index * 100, index * 100 + 80, [`target-${index}`]),
        startY: index * 400,
        surfaceId: record.id,
      })),
    );
    const confirmed = confirmInkDocumentRebase(records, preview, '2026-07-19T06:00:00.000Z');

    expect(confirmed).toMatchObject([
      { revision: 8, updatedAt: '2026-07-19T06:00:00.000Z' },
      { revision: 9, updatedAt: '2026-07-19T06:00:00.000Z' },
    ]);
    const stale: InkSurfaceRecord[] = [
      { ...(records[0] as InkSurfaceRecord), revision: 8 },
      records[1] as InkSurfaceRecord,
    ];
    const unchanged = structuredClone(stale);
    expect(() => confirmInkDocumentRebase(stale, preview, 'later')).toThrow(
      /document changed after the preview/u,
    );
    expect(stale).toEqual(unchanged);
  });

  it('preserves a schema-v3 structural origin through rebase and canonical encoding', () => {
    const legacy = surfaceFixture();
    const record: InkSurfaceRecord = {
      ...legacy,
      layout: { ...legacy.layout, originY: 600 },
      schemaVersion: 3,
      strokes: legacy.strokes.map((stroke) => ({
        ...stroke,
        brushRenderVersion: 'legacy-round-v1',
        inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
      })),
    };
    const preview = previewInkRebase(record, section('section-b', 300, 500, ['block-b']), layout());

    const confirmed = confirmInkRebase(record, preview, '2026-07-14T12:00:00.000Z');
    const reloaded = decodeInkSurfaceRecord(encodeInkSurfaceRecord(confirmed));

    expect(reloaded.layout.originY).toBe(600);
  });

  it('keeps intact siblings active through deterministic section reorder/edit cases', () => {
    const records = ['A', 'B', 'C'].map((name, index) =>
      surfaceForSection(name, index * 100, index * 100 + 80),
    );
    let seed = 0x5eed1234;
    for (let iteration = 0; iteration < 50; iteration += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const edited = seed % records.length;
      const deleted = iteration % 5 === 0 ? (seed >>> 8) % records.length : -1;
      const order = [...records.keys()]
        .filter((recordIndex) => recordIndex !== deleted)
        .sort((left, right) =>
          ((seed >>> left) & 1) === ((seed >>> right) & 1)
            ? left - right
            : ((seed >>> left) & 1) - ((seed >>> right) & 1),
        );
      const sections = order.map((recordIndex, position) => {
        const name = ['A', 'B', 'C'][recordIndex] as string;
        return section(
          recordIndex === edited ? `section-${name}-edited` : `section-${name}`,
          position * 100,
          position * 100 + 80,
          [recordIndex === edited ? `block-${name}-edited` : `block-${name}`],
          name,
        );
      });
      sections.splice(
        seed % (sections.length + 1),
        0,
        section('section-inserted', 900, 980, ['block-inserted'], 'Inserted'),
      );
      records.forEach((record, recordIndex) => {
        const result = reconcileInkSurface(record, sections, layout());
        if (recordIndex === deleted) {
          expect(result.kind).toBe('unanchored');
        } else if (recordIndex === edited) {
          expect(result.kind).toBe('needs-rebase');
        } else {
          expect(['active', 'relocated']).toContain(result.kind);
        }
        expect(result.record.strokes).toEqual(record.strokes);
      });
    }
  });
});

function block(
  fingerprint: string,
  sourceStart: number,
  sourceEnd: number,
  headingPath: readonly string[],
  kind: 'block' | 'heading' = 'block',
) {
  return { fingerprint, headingPath, kind, sourceEnd, sourceStart } as const;
}

function section(
  sectionFingerprint: string,
  sourceStart: number,
  sourceEnd: number,
  blockFingerprints: readonly string[],
  heading = 'A',
): InkSurfaceSection {
  return { blockFingerprints, headingPath: [heading], sectionFingerprint, sourceEnd, sourceStart };
}

function layout() {
  return {
    fontAvailable: true,
    fontFamily: 'Inter',
    fontSize: 16,
    lineHeight: 24,
    logicalHeight: 1200,
    logicalWidth: 960,
    sourceRevision: 'source-2',
    themeMode: 'light' as const,
    viewportWidth: 960,
  };
}

function surfaceFixture(): InkSurfaceRecord {
  return {
    binding: {
      blockFingerprints: ['block-a'],
      headingPath: ['A'],
      sectionFingerprint: 'section-a',
      sourceEnd: 200,
      sourceStart: 100,
    },
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Ink.md',
    id: 'surface-a',
    layout: {
      blockFingerprints: ['block-a'],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
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
        id: 'fragment-1',
        linkedStrokeId: 'stroke-user-1',
        points: [point(100, 100), point(200, 200)],
        tool: 'pen',
        width: 4,
      },
    ],
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}

function point(x: number, y: number) {
  return { pressure: 0.5, time: x + y, x, y };
}

function physicalPoint(
  x: number,
  y: number,
  time = x + y,
  pressure = 0.5,
  orientation:
    | { readonly kind: 'unavailable' }
    | {
        readonly altitude: number;
        readonly azimuth: number;
        readonly kind: 'measured';
        readonly reliable: boolean;
      } = { kind: 'unavailable' },
) {
  return { orientation, pressure, pressureKind: 'measured' as const, time, x, y };
}

function boundedPhysicalJoinFragments(
  fragments: readonly { readonly stroke: InkStroke; readonly surfaceId: string }[],
  bounds: readonly {
    readonly endY: number;
    readonly id: string;
    readonly logicalHeight: number;
    readonly startY: number;
  }[],
) {
  return fragments.map((fragment) => {
    const bound = bounds.find(({ id }) => id === fragment.surfaceId);
    if (bound === undefined) throw new Error(`Missing physical bound ${fragment.surfaceId}.`);
    return {
      endY: bound.endY,
      logicalHeight: bound.logicalHeight,
      schemaVersion: 3 as const,
      startY: bound.startY,
      stroke: fragment.stroke,
      surfaceId: bound.id,
    };
  });
}

function surfaceForSection(name: string, sourceStart: number, sourceEnd: number): InkSurfaceRecord {
  return {
    ...surfaceFixture(),
    binding: {
      blockFingerprints: [`block-${name}`],
      headingPath: [name],
      sectionFingerprint: `section-${name}`,
      sourceEnd,
      sourceStart,
    },
    id: `surface-${name}`,
    layout: { ...surfaceFixture().layout, blockFingerprints: [`block-${name}`] },
  };
}

function maximumPolylineError(original: readonly InkPoint[], joined: readonly InkPoint[]): number {
  return Math.max(
    ...joined.map((candidate) =>
      Math.min(
        ...lineSegments(original).map(([start, end]) => distanceToSegment(candidate, start, end)),
      ),
    ),
  );
}

function lineSegments(points: readonly InkPoint[]): readonly (readonly [InkPoint, InkPoint])[] {
  return points.slice(1).map((point, index) => [points[index] as InkPoint, point] as const);
}

function distanceToSegment(pointValue: InkPoint, start: InkPoint, end: InkPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const ratio =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((pointValue.x - start.x) * dx + (pointValue.y - start.y) * dy) / lengthSquared,
          ),
        );
  return Math.hypot(pointValue.x - (start.x + dx * ratio), pointValue.y - (start.y + dy * ratio));
}
