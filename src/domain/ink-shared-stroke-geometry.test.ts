import { describe, expect, it } from 'vitest';

import type { InkPhysicalHighlighterStroke, InkPhysicalPenStroke } from './ink-surface';
import { LegacyRoundInkStrokeGeometry } from './ink-stroke-geometry';
import { SharedInkStrokeGeometry } from './ink-shared-stroke-geometry';

describe('shared Ink Brush Geometry consumer seam', () => {
  it('projects canonical physical points into the exact Brush Control Trace without inventing sensors', () => {
    const source: InkPhysicalPenStroke = {
      brushRenderVersion: 'pen-physical-v1',
      color: '#112233',
      id: 'physical-provenance',
      inputProfile: { pressure: 'measured', tilt: 'measured' },
      linkedStrokeId: 'joined-physical-provenance',
      points: [
        {
          orientation: {
            altitude: 0.4,
            azimuth: Math.PI * 1.75,
            kind: 'measured',
            reliable: false,
          },
          pressure: 0,
          pressureKind: 'measured',
          time: 1,
          x: 10,
          y: 20,
        },
        {
          orientation: { kind: 'unavailable' },
          pressure: 0.5,
          pressureKind: 'unavailable',
          time: 2,
          x: 12,
          y: 24,
        },
      ],
      tool: 'pen',
      width: 4,
    };

    expect(new SharedInkStrokeGeometry().toLogicalStroke(source)).toEqual({
      header: {
        color: '#112233',
        inputProfile: { pressure: 'measured', tilt: 'measured' },
        logicalStrokeId: 'joined-physical-provenance',
        nominalWidth: 4,
        tool: 'pen',
        version: 'pen-physical-v1',
      },
      trace: {
        kind: 'physical-control-trace',
        points: [
          {
            orientation: {
              altitude: 0.4,
              azimuth: Math.PI * 1.75,
              kind: 'measured',
              reliable: false,
            },
            pressure: { kind: 'measured', value: 0 },
            time: 1,
            x: 10,
            y: 20,
          },
          {
            orientation: { kind: 'unavailable' },
            pressure: { kind: 'unavailable', value: 0.5 },
            time: 2,
            x: 12,
            y: 24,
          },
        ],
      },
    });
  });

  it('dispatches Pen physical geometry and owns its conservative bounds and contour hit shape', () => {
    const compiler = new SharedInkStrokeGeometry();
    const source = physicalPenStroke();
    const result = compiler.compile(source);

    expect(result).toMatchObject({
      geometry: {
        hitShape: { fillRule: 'nonzero', kind: 'filled-contour-distance' },
        tool: 'pen',
        version: 'pen-physical-v1',
      },
      kind: 'unpublished',
    });
    if (!('geometry' in result)) throw new Error('Expected compiled physical Pen geometry.');
    expect(compiler.bounds(source)).toEqual(result.geometry.bounds);
    expect(compiler.hitTestCompiled(result.geometry, { x: 10, y: 20 }, 0)).toBe(true);
    expect(compiler.hitTest(source, { x: 10, y: 20 }, 0)).toBe(true);
    expect(compiler.hitTest(source, { x: 10, y: 22.3 }, 0.2)).toBe(false);
  });

  it('dispatches Highlighter chisel geometry for bounds and filled-contour hit testing', () => {
    const compiler = new SharedInkStrokeGeometry();
    const source = physicalHighlighterStroke();
    const result = compiler.compile(source);

    expect(result).toMatchObject({
      geometry: {
        blend: {
          alpha: { kind: 'fixed' },
          application: 'once-per-logical-stroke',
        },
        tool: 'highlighter',
        version: 'highlighter-chisel-v1',
      },
      kind: 'unpublished',
    });
    if (!('geometry' in result))
      throw new Error('Expected compiled physical Highlighter geometry.');
    expect(compiler.bounds(source)).toEqual(result.geometry.bounds);
    expect(compiler.hitTest(source, { x: 10, y: 20.8 }, 0)).toBe(true);
    expect(compiler.hitTest(source, { x: 10, y: 22 }, 0.2)).toBe(false);
  });

  it.each([
    ['#ffd54f', 0.45],
    ['#ffd54f88', 0x88 / 255],
  ] as const)(
    'adapts legacy Highlighter %s without changing its historical paint semantics',
    (color, opacity) => {
      const source = {
        color,
        id: 'legacy-highlighter',
        points: [
          { pressure: 0.5, time: 0, x: 10, y: 20 },
          { pressure: 0.5, time: 10, x: 20, y: 20 },
        ],
        tool: 'highlighter' as const,
        width: 8,
      };
      const historical = new LegacyRoundInkStrokeGeometry().compile(source);
      const compiler = new SharedInkStrokeGeometry();
      const result = compiler.compile(source);

      expect(historical.paint).toEqual({
        color: '#ffd54f',
        composite: 'source-over',
        lineCap: 'round',
        lineJoin: 'round',
        opacity,
      });
      expect(result).toMatchObject({
        geometry: {
          color,
          coverage: { kind: 'legacy-round-centerline' },
          logicalStrokeId: 'legacy-highlighter',
          tool: 'highlighter',
          version: 'legacy-round-v1',
        },
        kind: 'exact',
      });
      if (!('geometry' in result)) throw new Error('Expected compiled legacy geometry.');
      expect(compiler.bounds(source)).toEqual(result.geometry.bounds);
      expect(compiler.hitTest(source, { x: 15, y: 24.5 }, 0.5)).toBe(true);
      expect(compiler.compile(structuredClone(source))).toEqual(result);
    },
  );

  it('accepts iPad-scaled legacy bounds whose reconstructed edge differs only by machine rounding', () => {
    const source = {
      color: '#4f46d888',
      id: 'ipad-scaled-highlighter',
      points: [
        {
          pressure: 0.017540378496050835,
          time: 220_918,
          x: 88.50574554794136,
          y: 293.24137825801455,
        },
        {
          pressure: 0.012122961692512035,
          time: 221_422,
          x: 249.8390788812747,
          y: 289.70114837295705,
        },
      ],
      tool: 'highlighter' as const,
      width: 16,
    };

    expect(new SharedInkStrokeGeometry().compile(source)).toMatchObject({
      geometry: { logicalStrokeId: source.id, version: 'legacy-round-v1' },
      kind: 'exact',
    });
  });

  it('fails closed for an unknown Brush Render Version without manufacturing legacy geometry', () => {
    const compiler = new SharedInkStrokeGeometry();
    const unknown = {
      ...physicalPenStroke(),
      brushRenderVersion: 'future-brush-v9',
    } as unknown as InkPhysicalPenStroke;

    expect(compiler.compile(unknown)).toEqual({
      kind: 'unsupported',
      reason: 'unknown-version',
      requestedVersion: 'future-brush-v9',
    });
    expect(() => compiler.bounds(unknown)).toThrow(/future-brush-v9.*unknown-version/u);
    expect(() => compiler.toLogicalStroke(unknown)).toThrow(/future-brush-v9/u);
  });

  it('fails closed when canonical tool, version, input profile, or Eraser semantics mismatch', () => {
    const compiler = new SharedInkStrokeGeometry();
    const pen = physicalPenStroke();
    const mismatches = [
      { ...pen, tool: 'highlighter' as const },
      {
        ...pen,
        inputProfile: { pressure: 'legacy-unknown' as const, tilt: 'legacy-unknown' as const },
      },
      {
        ...pen,
        brushRenderVersion: 'legacy-round-v1' as const,
        inputProfile: { pressure: 'legacy-unknown' as const, tilt: 'legacy-unknown' as const },
      },
      {
        color: '#ffffff',
        id: 'eraser',
        points: [{ pressure: 0.5, time: 0, x: 10, y: 10 }],
        tool: 'eraser' as const,
        width: 8,
      },
    ];

    for (const mismatch of mismatches) {
      expect(compiler.compile(mismatch)).toEqual({
        kind: 'unsupported',
        reason: 'invalid-canonical-stroke',
        requestedVersion:
          'brushRenderVersion' in mismatch
            ? (mismatch.brushRenderVersion ?? 'legacy-round-v1')
            : 'legacy-round-v1',
      });
      expect(() => compiler.toLogicalStroke(mismatch)).toThrow();
    }
  });

  it('keeps logical geometry digest and bounds invariant while zoom and DPR change projection', () => {
    const compiler = new SharedInkStrokeGeometry();
    const source = physicalHighlighterStroke();
    const first = compiler.compile(source);
    const replay = compiler.compile(structuredClone(source));
    if (!('geometry' in first) || !('geometry' in replay)) {
      throw new Error('Expected shared physical geometry.');
    }

    const projectFirstContour = (zoom: number, dpr: number) => {
      if (first.geometry.coverage.kind !== 'quantized-filled-contours') return [];
      const grid = first.geometry.quantization.logicalGrid;
      return first.geometry.coverage.contours[0]?.map((point) => ({
        x: point.x * grid * zoom * dpr,
        y: point.y * grid * zoom * dpr,
      }));
    };

    expect(projectFirstContour(0.5, 1)).not.toEqual(projectFirstContour(2, 3));
    expect(replay.geometry.geometryDigest).toBe(first.geometry.geometryDigest);
    expect(replay.geometry.bounds).toEqual(first.geometry.bounds);
    expect(first.geometry).not.toHaveProperty('dpr');
    expect(first.geometry).not.toHaveProperty('zoom');
  });

  it('includes sensor provenance and orientation reliability in the deterministic digest', () => {
    const compiler = new SharedInkStrokeGeometry();
    const pen = physicalPenStroke();
    const measured = {
      ...pen,
      inputProfile: { pressure: 'measured' as const, tilt: 'measured' as const },
      points: pen.points.map((point) => ({
        ...point,
        orientation: {
          altitude: 0.5,
          azimuth: 1,
          kind: 'measured' as const,
          reliable: true,
        },
      })),
    };
    const unavailable = {
      ...measured,
      points: measured.points.map((point, index) =>
        index === 0
          ? {
              ...point,
              orientation: {
                altitude: 0.5,
                azimuth: 1,
                kind: 'measured' as const,
                reliable: false,
              },
              pressureKind: 'unavailable' as const,
            }
          : point,
      ),
    };
    const first = compiler.compile(measured);
    const second = compiler.compile(unavailable);
    if (!('geometry' in first) || !('geometry' in second)) {
      throw new Error('Expected physical Pen geometry.');
    }

    expect(second.geometry.bounds).toEqual(first.geometry.bounds);
    expect(second.geometry.traceDigest).not.toBe(first.geometry.traceDigest);
    expect(second.geometry.geometryDigest).not.toBe(first.geometry.geometryDigest);
  });
});

function physicalPenStroke(): InkPhysicalPenStroke {
  return {
    brushRenderVersion: 'pen-physical-v1',
    color: '#112233',
    id: 'physical-pen',
    inputProfile: { pressure: 'measured', tilt: 'unavailable' },
    points: [
      {
        orientation: { kind: 'unavailable' },
        pressure: 0.5,
        pressureKind: 'measured',
        time: 0,
        x: 10,
        y: 20,
      },
      {
        orientation: { kind: 'unavailable' },
        pressure: 0.5,
        pressureKind: 'measured',
        time: 10,
        x: 20,
        y: 20,
      },
    ],
    tool: 'pen',
    width: 4,
  };
}

function physicalHighlighterStroke(): InkPhysicalHighlighterStroke {
  return {
    brushRenderVersion: 'highlighter-chisel-v1',
    color: '#ffd54f',
    id: 'physical-highlighter',
    inputProfile: { pressure: 'measured', tilt: 'measured' },
    points: [
      {
        orientation: {
          altitude: 0.2,
          azimuth: 0,
          kind: 'measured',
          reliable: true,
        },
        pressure: 0.5,
        pressureKind: 'measured',
        time: 0,
        x: 10,
        y: 20,
      },
      {
        orientation: {
          altitude: 0.2,
          azimuth: 0,
          kind: 'measured',
          reliable: true,
        },
        pressure: 0.5,
        pressureKind: 'measured',
        time: 10,
        x: 20,
        y: 20,
      },
    ],
    tool: 'highlighter',
    width: 8,
  };
}
