import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  InkBrushActiveGeometryCompiler,
  InkBrushActiveTraceDelta,
  InkBrushCoverage,
  InkBrushLogicalStroke,
  InkPhysicalBrushControlPoint,
} from './ink-brush-geometry-contract';
import {
  compositeUnpublishedInkHighlighterStrokeAlpha,
  compileInkHighlighterPhysicalGeometry,
  createInkHighlighterPhysicalActiveGeometryCompiler,
  digestInkHighlighterPhysicalCoverage,
  UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE,
} from './ink-highlighter-physical-geometry';

describe('unpublished highlighter-chisel-v1 geometry candidate', () => {
  it('keeps candidate values default-off, unpublished, and owned by S34 calibration', () => {
    expect(UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE).toMatchObject({
      calibrationOwner: 'S34',
      candidateRevision: 's32-highlighter-geometry-r1',
      enabledByDefault: false,
      publication: 'unpublished-default-off',
    });
    expect(Object.isFrozen(UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE)).toBe(true);
    expect(Object.isFrozen(UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.orientation)).toBe(true);
    expect(UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.active.maximumMutableTailPoints).toBe(12);
    expect(
      UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.orientation.uprightEnterAltitude,
    ).toBeGreaterThan(UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.orientation.uprightExitAltitude);
    expect(UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.opticalDensity).toBeGreaterThan(0);
    expect(UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.opticalDensity).toBeLessThan(1);
  });

  it('consumes canonical logical azimuth directly and stamps one rounded chisel tap', () => {
    const alongX = compileInkHighlighterPhysicalGeometry(
      highlighterStroke('tap-x', [point(10, 12, 0, 0.5, measuredOrientation(0, 0.5, true))]),
    );
    const alongY = compileInkHighlighterPhysicalGeometry(
      highlighterStroke('tap-y', [
        point(10, 12, 0, 0.5, measuredOrientation(Math.PI / 2, 0.5, true)),
      ]),
    );

    expect(alongX.kind).toBe('unpublished');
    expect(alongY.kind).toBe('unpublished');
    if (alongX.kind !== 'unpublished' || alongY.kind !== 'unpublished') {
      throw new Error('expected unpublished Highlighter candidate geometry');
    }
    expect(alongX.geometry.coverage.contours).toHaveLength(1);
    expect(alongX.geometry.bounds.width).toBeGreaterThan(alongX.geometry.bounds.height);
    expect(alongY.geometry.bounds.height).toBeGreaterThan(alongY.geometry.bounds.width);
    expect(alongX.geometry.blend).toEqual({
      alpha: {
        kind: 'fixed',
        value: UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.opticalDensity,
      },
      application: 'once-per-logical-stroke',
      colorSpace: 'srgb',
      composite: 'source-over',
    });
    expect(JSON.stringify(alongX.geometry)).not.toMatch(
      /candidateRevision|s32-highlighter-geometry-r1|unpublished-default-off/u,
    );
  });

  it('holds the frozen no-tilt default across unavailable and unreliable orientation samples', () => {
    const unavailable = compileInkHighlighterPhysicalGeometry(
      highlighterStroke('fallback', [
        point(0, 0, 0, 0.5),
        point(12, 2, 4, 0.5),
        point(24, 1, 8, 0.5),
      ]),
    );
    const unreliableNoise = compileInkHighlighterPhysicalGeometry(
      highlighterStroke('fallback', [
        point(0, 0, 0, 0.5, measuredOrientation(0, 0.1, false)),
        point(12, 2, 4, 0.5, measuredOrientation(Math.PI / 2, 1.2, false)),
        point(24, 1, 8, 0.5, measuredOrientation(Math.PI * 1.9, 0.2, false)),
      ]),
    );

    expect(unavailable.kind).toBe('unpublished');
    expect(unreliableNoise.kind).toBe('unpublished');
    if (unavailable.kind !== 'unpublished' || unreliableNoise.kind !== 'unpublished') {
      throw new Error('expected unpublished Highlighter candidate geometry');
    }
    expect(unreliableNoise.geometry.coverage).toEqual(unavailable.geometry.coverage);
    expect(unreliableNoise.geometry.bounds).toEqual(unavailable.geometry.bounds);
  });

  it('uses upright enter/exit hysteresis and changes angle only after a reliable exit', () => {
    const orientation = UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.orientation;
    const beforeUpright = orientation.uprightExitAltitude - 0.1;
    const upright = orientation.uprightEnterAltitude + 0.01;
    const hysteresisBand = (orientation.uprightEnterAltitude + orientation.uprightExitAltitude) / 2;
    const held = compileInkHighlighterPhysicalGeometry(
      highlighterStroke('hysteresis', [
        point(0, 0, 0, 0.5, measuredOrientation(0, beforeUpright, true)),
        point(12, 0, 4, 0.5, measuredOrientation(0, upright, true)),
        point(24, 0, 8, 0.5, measuredOrientation(0, hysteresisBand, true)),
      ]),
    );
    const noisyUpright = compileInkHighlighterPhysicalGeometry(
      highlighterStroke('hysteresis', [
        point(0, 0, 0, 0.5, measuredOrientation(0, beforeUpright, true)),
        point(12, 0, 4, 0.5, measuredOrientation(Math.PI / 2, upright, true)),
        point(24, 0, 8, 0.5, measuredOrientation(Math.PI / 2, hysteresisBand, true)),
      ]),
    );
    const reliableExit = compileInkHighlighterPhysicalGeometry(
      highlighterStroke('hysteresis', [
        point(0, 0, 0, 0.5, measuredOrientation(0, beforeUpright, true)),
        point(12, 0, 4, 0.5, measuredOrientation(Math.PI / 2, upright, true)),
        point(
          24,
          0,
          8,
          0.5,
          measuredOrientation(Math.PI / 2, orientation.uprightExitAltitude - 0.01, true),
        ),
      ]),
    );

    expect(held.kind).toBe('unpublished');
    expect(noisyUpright.kind).toBe('unpublished');
    expect(reliableExit.kind).toBe('unpublished');
    if (
      held.kind !== 'unpublished' ||
      noisyUpright.kind !== 'unpublished' ||
      reliableExit.kind !== 'unpublished'
    ) {
      throw new Error('expected unpublished Highlighter candidate geometry');
    }
    expect(noisyUpright.geometry.coverage).toEqual(held.geometry.coverage);
    expect(reliableExit.geometry.coverage).not.toEqual(held.geometry.coverage);
  });

  it('applies fixed density once per Logical Stroke and source-over only across distinct strokes', () => {
    const alpha = UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.opticalDensity;
    const selfOverlapping = compileInkHighlighterPhysicalGeometry(
      highlighterStroke('self-overlap', [
        point(0, 0, 0, 0.5),
        point(16, 0, 4, 0.5),
        point(0, 0, 8, 0.5),
      ]),
    );

    expect(selfOverlapping.kind).toBe('unpublished');
    if (selfOverlapping.kind !== 'unpublished') {
      throw new Error('expected unpublished Highlighter candidate geometry');
    }
    expect(selfOverlapping.geometry.blend.application).toBe('once-per-logical-stroke');
    expect(compositeUnpublishedInkHighlighterStrokeAlpha(1)).toBe(alpha);
    expect(compositeUnpublishedInkHighlighterStrokeAlpha(2)).toBeCloseTo(1 - (1 - alpha) ** 2, 12);
    expect(
      Math.abs(
        Math.round(compositeUnpublishedInkHighlighterStrokeAlpha(2) * 255) / 255 -
          (1 - (1 - alpha) ** 2),
      ),
    ).toBeLessThanOrEqual(1 / 255);
  });

  it('appends stable coverage, replaces one bounded tail, and finishes with committed-identical coverage', () => {
    const orientation = UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.orientation;
    const points = [
      point(0, 0, 0, 0.4, measuredOrientation(0, orientation.uprightExitAltitude - 0.1, true)),
      point(
        6,
        1,
        4,
        0.5,
        measuredOrientation(Math.PI / 2, orientation.uprightEnterAltitude + 0.01, true),
      ),
      point(
        12,
        3,
        8,
        0.6,
        measuredOrientation(
          Math.PI / 2,
          (orientation.uprightEnterAltitude + orientation.uprightExitAltitude) / 2,
          true,
        ),
      ),
      point(
        18,
        2,
        12,
        0.7,
        measuredOrientation(Math.PI / 2, orientation.uprightExitAltitude - 0.01, true),
      ),
      point(24, 0, 16, 0.5),
    ];
    const stroke = highlighterStroke('active', points);
    const created = createInkHighlighterPhysicalActiveGeometryCompiler(stroke.header);
    expect(created.kind).toBe('ready');
    if (created.kind !== 'ready') throw new Error('expected ready active Highlighter compiler');
    expectTypeOf(created.compiler).toMatchTypeOf<InkBrushActiveGeometryCompiler>();

    const first = created.compiler.extend(delta(points.slice(0, 1), points.slice(1, 3)));
    const second = created.compiler.extend(delta(points.slice(1, 2), points.slice(2)));
    const finished = created.compiler.finish(delta(points.slice(2), []));
    const committed = compileInkHighlighterPhysicalGeometry(stroke);

    expect(first).toMatchObject({
      kind: 'active-delta',
      mutable: { generation: 1, kind: 'replace-bounded-mutable-tail' },
      stable: { kind: 'append-only-stable' },
      workScope: 'new-stable-plus-bounded-mutable-tail',
    });
    expect(second.mutable.generation).toBe(2);
    expect(finished).toMatchObject({
      kind: 'active-finish',
      mutable: { coverage: [], generation: 3, kind: 'replace-bounded-mutable-tail' },
      ownershipTransfer: 'active-to-committed-without-blank-frame',
    });
    expect(JSON.stringify([first, second, finished])).not.toMatch(
      /candidateRevision|s32-highlighter-geometry-r1|S34|unpublished-default-off/u,
    );
    expect(committed.kind).toBe('unpublished');
    if (committed.kind !== 'unpublished') {
      throw new Error('expected unpublished committed Highlighter geometry');
    }
    expect(finished.bounds).toEqual(committed.geometry.bounds);
    const activeContours = [first, second, finished]
      .flatMap(({ stable }) => stable.coverage)
      .flatMap(filledContours);
    expect(digestInkHighlighterPhysicalCoverage(activeContours)).toBe(
      digestInkHighlighterPhysicalCoverage(committed.geometry.coverage.contours),
    );
    expect(created.compiler.stats()).toMatchObject({
      inspectedPointCount: 10,
      maximumMutableTailPointCount: 3,
      publication: 'unpublished-default-off',
    });
  });

  it('fails closed for unknown identity and returns typed local degradation for known geometry failure', () => {
    const stroke = highlighterStroke('degradation', [point(2, 3, 0, 0.5)]);
    expect(
      compileInkHighlighterPhysicalGeometry({
        ...stroke,
        header: { ...stroke.header, version: 'future-highlighter-v9' },
      }),
    ).toEqual({
      kind: 'unsupported',
      reason: 'unknown-version',
      requestedVersion: 'future-highlighter-v9',
    });
    expect(
      compileInkHighlighterPhysicalGeometry({
        ...stroke,
        header: { ...stroke.header, tool: 'pen' },
      }),
    ).toEqual({
      kind: 'unsupported',
      reason: 'invalid-canonical-stroke',
      requestedVersion: 'highlighter-chisel-v1',
    });

    const extreme = highlighterStroke('degradation', [point(1e15, 0, 0, 0.5)]);
    const before = structuredClone(extreme.trace);
    const degraded = compileInkHighlighterPhysicalGeometry(extreme);
    expect(degraded.kind).toBe('degraded');
    if (degraded.kind !== 'degraded') {
      throw new Error('expected typed per-stroke Highlighter degradation');
    }
    expect(degraded).toMatchObject({
      diagnostic: 'known-version-geometry-failure',
      geometry: { color: '#fedcba59', tool: 'highlighter', version: 'legacy-round-v1' },
      requestedVersion: 'highlighter-chisel-v1',
    });
    expect(extreme.trace).toEqual(before);
  });

  it('bounds pressure sizing while speed and time never change geometry or optical density', () => {
    const pressures = [0, 0.25, 0.5, 0.75, 1];
    const tapSpans = pressures.map((pressure) => {
      const result = compileInkHighlighterPhysicalGeometry(
        highlighterStroke(`pressure-${pressure}`, [point(0, 0, 0, pressure)]),
      );
      if (result.kind !== 'unpublished') throw new Error('expected unpublished Highlighter tap');
      return Math.max(result.geometry.bounds.width, result.geometry.bounds.height);
    });
    expect(tapSpans).toEqual([...tapSpans].sort((left, right) => left - right));
    expect(tapSpans[0]).toBeGreaterThanOrEqual(
      (10 * UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.pressure.minimumScale) / Math.SQRT2 -
        UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.quantization.logicalGrid,
    );
    expect(tapSpans.at(-1)).toBeLessThanOrEqual(
      10 * UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.pressure.maximumScale * Math.SQRT2 +
        UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.quantization.logicalGrid,
    );

    const slow = compileInkHighlighterPhysicalGeometry(
      highlighterStroke('speed', [point(0, 0, 0, 0.5), point(20, 5, 1_000, 0.5)]),
    );
    const fast = compileInkHighlighterPhysicalGeometry(
      highlighterStroke('speed', [point(0, 0, 0, 0.5), point(20, 5, 1, 0.5)]),
    );
    if (slow.kind !== 'unpublished' || fast.kind !== 'unpublished') {
      throw new Error('expected unpublished Highlighter sweep');
    }
    expect(fast.geometry.coverage).toEqual(slow.geometry.coverage);
    expect(fast.geometry.blend).toEqual(slow.geometry.blend);
  });

  it('unions an already-joined Logical Stroke across a surface boundary without a cap or alpha seam', () => {
    const points = [point(0, 0, 0, 0.5), point(12, 2, 4, 0.5), point(24, 0, 8, 0.5)];
    const firstFragment = points.slice(0, 2);
    const secondFragment = points.slice(1);
    const rejoined = [...firstFragment, ...secondFragment.slice(1)];
    const whole = compileInkHighlighterPhysicalGeometry(highlighterStroke('surface', points));
    const joined = compileInkHighlighterPhysicalGeometry(highlighterStroke('surface', rejoined));

    expect(joined).toEqual(whole);
    if (joined.kind !== 'unpublished') throw new Error('expected joined Highlighter geometry');
    const boundary = points[1];
    if (boundary === undefined) throw new Error('missing boundary point');
    const coverageHits = joined.geometry.coverage.contours.filter((contour) =>
      pointInContour(
        boundary.x / UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.quantization.logicalGrid,
        boundary.y / UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.quantization.logicalGrid,
        contour,
      ),
    ).length;
    expect(coverageHits).toBeGreaterThanOrEqual(2);
    expect(joined.geometry.blend.application).toBe('once-per-logical-stroke');
    expect(compositeUnpublishedInkHighlighterStrokeAlpha(1)).toBe(
      UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.opticalDensity,
    );
  });

  it('rejects a mutable replacement above the hard S30 tail bound without advancing state', () => {
    const stroke = highlighterStroke('tail-bound', [point(0, 0, 0, 0.5)]);
    const created = createInkHighlighterPhysicalActiveGeometryCompiler(stroke.header);
    if (created.kind !== 'ready') throw new Error('expected ready Highlighter compiler');
    const oversized = Array.from(
      {
        length: UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.active.maximumMutableTailPoints + 1,
      },
      (_value, index) => point(index + 1, 0, index + 1, 0.5),
    );

    expect(() => created.compiler.extend(delta([], oversized))).toThrow(/hard bound/u);
    expect(created.compiler.stats().inspectedPointCount).toBe(0);
    expect(created.compiler.extend(delta([point(0, 0, 0, 0.5)], []))).toMatchObject({
      kind: 'active-delta',
      mutable: { generation: 1 },
    });
  });

  it('accepts only opaque canonical color and already-normalized logical orientation', () => {
    const stroke = highlighterStroke('canonical-input', [
      point(0, 0, 0, 0.5, measuredOrientation(0, 0.5, true)),
    ]);
    const uppercase = compileInkHighlighterPhysicalGeometry({
      ...stroke,
      header: { ...stroke.header, color: '#ABCDEF' },
    });
    expect(uppercase.kind).toBe('unpublished');
    if (uppercase.kind !== 'unpublished') throw new Error('expected canonical Highlighter input');
    expect(uppercase.geometry.color).toBe('#ABCDEF');

    expect(
      compileInkHighlighterPhysicalGeometry({
        ...stroke,
        header: { ...stroke.header, color: '#abcdef80' },
      }),
    ).toMatchObject({ kind: 'unsupported', reason: 'invalid-canonical-stroke' });
    expect(
      compileInkHighlighterPhysicalGeometry({
        ...stroke,
        trace: {
          ...stroke.trace,
          points: [
            {
              ...stroke.trace.points[0],
              orientation: {
                altitude: 0.5,
                azimuth: Math.PI * 2,
                kind: 'measured',
                reliable: true,
              },
            },
          ],
        },
      }),
    ).toMatchObject({ kind: 'unsupported', reason: 'invalid-canonical-stroke' });
  });
});

function highlighterStroke(
  logicalStrokeId: string,
  points: readonly InkPhysicalBrushControlPoint[],
): InkBrushLogicalStroke {
  return {
    header: {
      color: '#fedcba',
      inputProfile: { pressure: 'measured', tilt: 'measured' },
      logicalStrokeId,
      nominalWidth: 10,
      tool: 'highlighter',
      version: 'highlighter-chisel-v1',
    },
    trace: { kind: 'physical-control-trace', points },
  };
}

function point(
  x: number,
  y: number,
  time: number,
  pressure: number,
  orientation: InkPhysicalBrushControlPoint['orientation'] = { kind: 'unavailable' },
): InkPhysicalBrushControlPoint {
  return {
    orientation,
    pressure: { kind: 'measured', value: pressure },
    time,
    x,
    y,
  };
}

function measuredOrientation(
  azimuth: number,
  altitude: number,
  reliable: boolean,
): InkPhysicalBrushControlPoint['orientation'] {
  return { altitude, azimuth, kind: 'measured', reliable };
}

function delta(
  stable: readonly InkPhysicalBrushControlPoint[],
  mutable: readonly InkPhysicalBrushControlPoint[],
): InkBrushActiveTraceDelta {
  return {
    mutableReplacement: { kind: 'physical-control-trace', points: mutable },
    stableAppend: { kind: 'physical-control-trace', points: stable },
  };
}

function filledContours(
  coverage: InkBrushCoverage,
): readonly (readonly { x: number; y: number }[])[] {
  if (coverage.kind !== 'quantized-filled-contours') {
    throw new Error('expected filled Highlighter coverage');
  }
  return coverage.contours;
}

function pointInContour(
  x: number,
  y: number,
  contour: readonly { readonly x: number; readonly y: number }[],
): boolean {
  let inside = false;
  for (let index = 0, previousIndex = contour.length - 1; index < contour.length; index += 1) {
    const current = contour[index];
    const previous = contour[previousIndex];
    if (
      current !== undefined &&
      previous !== undefined &&
      current.y > y !== previous.y > y &&
      x < ((previous.x - current.x) * (y - current.y)) / (previous.y - current.y) + current.x
    ) {
      inside = !inside;
    }
    previousIndex = index;
  }
  return inside;
}
