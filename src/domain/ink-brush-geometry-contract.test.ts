import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createInkBrushCompiledGeometry,
  createInkBrushCompilationResult,
  createInkBrushActiveGeometryUpdate,
  createInkBrushLogicalStroke,
  decodeInkBrushLogicalStroke,
  decodeInkBrushCompiledGeometry,
  digestInkBrushControlTrace,
} from './ink-brush-geometry-contract';
import type {
  InkBrushControlTrace,
  InkBrushCoverage,
  InkBrushLogicalStroke,
  InkCompiledBrushGeometry,
  InkFilledContourCoverage,
  InkLegacyBrushControlTrace,
  InkLegacyRoundCoverage,
  InkPhysicalBrushControlTrace,
} from './ink-brush-geometry-contract';

describe('Ink Brush renderer-neutral geometry contract', () => {
  it('omits candidate build metadata from every canonical and renderer-neutral type', () => {
    expectTypeOf<InkBrushLogicalStroke>().not.toHaveProperty('candidateRevision');
    expectTypeOf<InkBrushControlTrace>().not.toHaveProperty('candidateRevision');
    expectTypeOf<InkBrushCoverage>().not.toHaveProperty('candidateRevision');
    expectTypeOf<InkCompiledBrushGeometry>().not.toHaveProperty('candidateRevision');
  });

  it('closes type-level trace and coverage choices by Brush Render Version', () => {
    type LegacyStroke = Extract<
      InkBrushLogicalStroke,
      { readonly header: { readonly version: 'legacy-round-v1' } }
    >;
    type PhysicalStroke = Extract<
      InkBrushLogicalStroke,
      { readonly header: { readonly version: 'pen-physical-v1' } }
    >;
    type LegacyGeometry = Extract<
      InkCompiledBrushGeometry,
      { readonly version: 'legacy-round-v1' }
    >;
    type PhysicalGeometry = Extract<
      InkCompiledBrushGeometry,
      { readonly version: 'pen-physical-v1' }
    >;

    expectTypeOf<LegacyStroke['trace']>().toEqualTypeOf<InkLegacyBrushControlTrace>();
    expectTypeOf<PhysicalStroke['trace']>().toEqualTypeOf<InkPhysicalBrushControlTrace>();
    expectTypeOf<LegacyGeometry['coverage']>().toEqualTypeOf<InkLegacyRoundCoverage>();
    expectTypeOf<PhysicalGeometry['coverage']>().toEqualTypeOf<InkFilledContourCoverage>();
  });

  it('constructs one frozen canonical legacy Logical Stroke and rejects non-canonical metadata', () => {
    const source = {
      header: {
        color: '#11223388',
        inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
        logicalStrokeId: 'legacy-stroke',
        nominalWidth: 4,
        tool: 'pen',
        version: 'legacy-round-v1',
      },
      trace: {
        kind: 'legacy-round-control-trace',
        points: [
          {
            orientation: { kind: 'legacy-unknown' },
            pressure: 0.5,
            time: 1,
            x: 2,
            y: 3,
          },
        ],
      },
    };

    const stroke = createInkBrushLogicalStroke(source);

    expect(stroke).toEqual(source);
    expect(Object.isFrozen(stroke)).toBe(true);
    expect(Object.isFrozen(stroke.header)).toBe(true);
    expect(Object.isFrozen(stroke.trace.points[0])).toBe(true);
    expect(
      decodeInkBrushLogicalStroke({
        ...source,
        candidateRevision: 'must-not-be-canonical',
      }),
    ).toEqual({ kind: 'invalid', reason: 'invalid-canonical-stroke' });
  });

  it('keeps physical orientation availability and reliability explicit and rejects tiltX/Y aliases', () => {
    const source = {
      header: {
        color: '#112233',
        inputProfile: { pressure: 'measured', tilt: 'measured' },
        logicalStrokeId: 'physical-pen',
        nominalWidth: 6,
        tool: 'pen',
        version: 'pen-physical-v1',
      },
      trace: {
        kind: 'physical-control-trace',
        points: [
          {
            orientation: {
              altitude: Math.PI / 4,
              azimuth: Math.PI,
              kind: 'measured',
              reliable: false,
            },
            pressure: { kind: 'measured', value: 0 },
            time: 1,
            x: 2,
            y: 3,
          },
          {
            orientation: { kind: 'unavailable' },
            pressure: { kind: 'measured', value: 0.8 },
            time: 2,
            x: 4,
            y: 5,
          },
        ],
      },
    };

    expect(createInkBrushLogicalStroke(source)).toEqual(source);
    expect(
      decodeInkBrushLogicalStroke({
        ...source,
        trace: {
          ...source.trace,
          points: [
            {
              orientation: { kind: 'measured', reliable: true, tiltX: 20, tiltY: 10 },
              pressure: { kind: 'measured', value: 0.5 },
              time: 1,
              x: 2,
              y: 3,
            },
          ],
        },
      }),
    ).toEqual({ kind: 'invalid', reason: 'invalid-canonical-stroke' });
    expect(
      decodeInkBrushLogicalStroke({
        ...source,
        header: { ...source.header, version: 'future-brush-v9' },
      }),
    ).toEqual({ kind: 'unsupported', reason: 'unknown-version', version: 'future-brush-v9' });
    expect(
      decodeInkBrushLogicalStroke({
        ...source,
        trace: {
          ...source.trace,
          points: [{ ...source.trace.points[0], x: Number.POSITIVE_INFINITY }],
        },
      }),
    ).toEqual({ kind: 'invalid', reason: 'invalid-canonical-stroke' });
  });

  it('digests only the frozen quantized trace contract', () => {
    const base = createInkBrushLogicalStroke({
      header: {
        color: '#11223388',
        inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
        logicalStrokeId: 'digest',
        nominalWidth: 4,
        tool: 'pen',
        version: 'legacy-round-v1',
      },
      trace: {
        kind: 'legacy-round-control-trace',
        points: [
          {
            orientation: { kind: 'legacy-unknown' },
            pressure: 0.503,
            time: 1.004,
            x: 2.001,
            y: 3.001,
          },
        ],
      },
    });
    const withinGrid = createInkBrushLogicalStroke({
      ...base,
      trace: {
        ...base.trace,
        points: [{ ...base.trace.points[0], pressure: 0.504, x: 2.004 }],
      },
    });
    const outsideGrid = createInkBrushLogicalStroke({
      ...base,
      trace: { ...base.trace, points: [{ ...base.trace.points[0], x: 2.02 }] },
    });
    const quantization = { coordinateGrid: 0.01, sensorGrid: 0.01, timeGridMs: 0.01 };

    expect(digestInkBrushControlTrace(base, quantization)).toBe(
      digestInkBrushControlTrace(withinGrid, quantization),
    );
    expect(digestInkBrushControlTrace(base, quantization)).not.toBe(
      digestInkBrushControlTrace(outsideGrid, quantization),
    );
    expect(() =>
      digestInkBrushControlTrace(base, { ...quantization, coordinateGrid: Number.NaN }),
    ).toThrow('Ink Brush trace quantization must be finite and positive.');
  });

  it('constructs renderer-neutral legacy coverage with conservative bounds and once-only blend', () => {
    const geometry = createInkBrushCompiledGeometry({
      blend: {
        alpha: { kind: 'from-canonical-color' },
        application: 'once-per-logical-stroke',
        colorSpace: 'srgb',
        composite: 'source-over',
      },
      bounds: { height: 4, width: 10, x: 0, y: 0 },
      color: '#11223388',
      coverage: {
        centerline: [
          { x: 2, y: 2 },
          { x: 8, y: 2 },
        ],
        diameterUnits: 4,
        kind: 'legacy-round-centerline',
      },
      hitShape: { kind: 'round-centerline-distance', radius: 2 },
      logicalStrokeId: 'legacy-geometry',
      quantization: { logicalGrid: 1 },
      tool: 'pen',
      traceDigest: '1234abcd',
      version: 'legacy-round-v1',
    });

    expect(geometry.geometryDigest).toMatch(/^[0-9a-f]{8}$/u);
    expect(geometry.coverage.kind).toBe('legacy-round-centerline');
    expect(geometry.blend.application).toBe('once-per-logical-stroke');
    expect(Object.isFrozen(geometry.coverage)).toBe(true);
    if (geometry.coverage.kind !== 'legacy-round-centerline') {
      throw new Error('Expected legacy round coverage.');
    }
    expect(Object.isFrozen(geometry.coverage.centerline)).toBe(true);
  });

  it('validates closed quantized physical coverage without accepting invented contract fields', () => {
    const source = physicalGeometryInput();
    const decoded = decodeInkBrushCompiledGeometry(source);

    expect(decoded).toMatchObject({
      geometry: {
        blend: { alpha: { kind: 'fixed', value: 1 } },
        coverage: { kind: 'quantized-filled-contours' },
        hitShape: { fillRule: 'nonzero', kind: 'filled-contour-distance' },
        version: 'pen-physical-v1',
      },
      kind: 'valid',
    });
    expect(
      decodeInkBrushCompiledGeometry({ ...source, candidateRevision: 'not-canonical' }),
    ).toEqual({ kind: 'invalid', reason: 'invalid-geometry' });
    expect(
      decodeInkBrushCompiledGeometry({
        ...source,
        coverage: {
          contours: [
            [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
            ],
          ],
          kind: 'quantized-filled-contours',
        },
      }),
    ).toEqual({ kind: 'invalid', reason: 'invalid-geometry' });
    expect(
      decodeInkBrushCompiledGeometry({
        ...source,
        bounds: { height: 4, width: 4, x: 0, y: 0 },
      }),
    ).toEqual({ kind: 'invalid', reason: 'invalid-geometry' });
    expect(
      decodeInkBrushCompiledGeometry({
        ...source,
        bounds: { height: 5, width: Number.NaN, x: 0, y: 0 },
      }),
    ).toEqual({ kind: 'invalid', reason: 'invalid-geometry' });
    expect(decodeInkBrushCompiledGeometry({ ...source, version: 'future-brush-v9' })).toEqual({
      kind: 'unsupported',
      reason: 'unknown-version',
      version: 'future-brush-v9',
    });
  });

  it('keeps exact, deterministic degradation, unpublished, and unsupported outcomes distinct', () => {
    const physical = createInkBrushCompiledGeometry(physicalGeometryInput());
    const legacy = createInkBrushCompiledGeometry({
      blend: {
        alpha: { kind: 'from-canonical-color' },
        application: 'once-per-logical-stroke',
        colorSpace: 'srgb',
        composite: 'source-over',
      },
      bounds: { height: 4, width: 10, x: 0, y: 0 },
      color: '#11223388',
      coverage: {
        centerline: [
          { x: 2, y: 2 },
          { x: 8, y: 2 },
        ],
        diameterUnits: 4,
        kind: 'legacy-round-centerline',
      },
      hitShape: { kind: 'round-centerline-distance', radius: 2 },
      logicalStrokeId: 'legacy-geometry',
      quantization: { logicalGrid: 1 },
      tool: 'pen',
      traceDigest: '1234abcd',
      version: 'legacy-round-v1',
    });

    expect(createInkBrushCompilationResult({ geometry: legacy, kind: 'exact' })).toMatchObject({
      kind: 'exact',
    });
    expect(
      createInkBrushCompilationResult({ geometry: physical, kind: 'unpublished' }),
    ).toMatchObject({ kind: 'unpublished' });
    expect(
      createInkBrushCompilationResult({
        diagnostic: 'known-version-geometry-failure',
        geometry: legacy,
        kind: 'degraded',
        requestedVersion: 'pen-physical-v1',
      }),
    ).toMatchObject({ kind: 'degraded', requestedVersion: 'pen-physical-v1' });
    expect(
      createInkBrushCompilationResult({
        kind: 'unsupported',
        reason: 'unknown-version',
        requestedVersion: 'future-brush-v9',
      }),
    ).toEqual({
      kind: 'unsupported',
      reason: 'unknown-version',
      requestedVersion: 'future-brush-v9',
    });
    expect(() =>
      createInkBrushCompilationResult({
        candidateRevision: 'not-a-geometry-field',
        geometry: physical,
        kind: 'unpublished',
      }),
    ).toThrow('Invalid Ink Brush compilation result.');
  });

  it('exposes append-only stable ownership and whole-tail replacement without a finish rescan seam', () => {
    const coverage = {
      centerline: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
      ],
      diameterUnits: 2,
      kind: 'legacy-round-centerline',
    };
    const input = {
      bounds: { height: 2, width: 4, x: 0, y: 0 },
      kind: 'active-finish',
      logicalStrokeId: 'active-legacy',
      mutable: {
        coverage: [coverage],
        generation: 3,
        kind: 'replace-bounded-mutable-tail',
      },
      ownershipTransfer: 'active-to-committed-without-blank-frame',
      quantization: { logicalGrid: 1 },
      stable: {
        coverage: [coverage],
        kind: 'append-only-stable',
      },
      version: 'legacy-round-v1',
      workScope: 'new-stable-plus-bounded-mutable-tail',
    };

    expect(createInkBrushActiveGeometryUpdate(input)).toMatchObject({
      kind: 'active-finish',
      mutable: { generation: 3, kind: 'replace-bounded-mutable-tail' },
      ownershipTransfer: 'active-to-committed-without-blank-frame',
      stable: { kind: 'append-only-stable' },
      workScope: 'new-stable-plus-bounded-mutable-tail',
    });
    expect(() =>
      createInkBrushActiveGeometryUpdate({
        ...input,
        fullPrefixRescan: true,
      }),
    ).toThrow('Invalid active Ink Brush geometry update.');
  });
});

function physicalGeometryInput(): Record<string, unknown> {
  return {
    blend: {
      alpha: { kind: 'fixed', value: 1 },
      application: 'once-per-logical-stroke',
      colorSpace: 'srgb',
      composite: 'source-over',
    },
    bounds: { height: 5, width: 5, x: 0, y: 0 },
    color: '#112233',
    coverage: {
      contours: [
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
          { x: 0, y: 0 },
        ],
      ],
      kind: 'quantized-filled-contours',
    },
    hitShape: { fillRule: 'nonzero', kind: 'filled-contour-distance' },
    logicalStrokeId: 'physical-geometry',
    quantization: { logicalGrid: 0.5 },
    tool: 'pen',
    traceDigest: '1234abcd',
    version: 'pen-physical-v1',
  };
}
