import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createInkBrushActiveGeometryUpdate,
  createInkBrushLogicalStroke,
  type InkBrushActiveGeometryCompiler,
  type InkBrushActiveTraceDelta,
  type InkBrushCoverage,
  type InkBrushLogicalStroke,
  type InkFilledContourCoverage,
  type InkPhysicalBrushControlPoint,
} from './ink-brush-geometry-contract';
import {
  compileInkPenPhysicalGeometry,
  createInkPenPhysicalActiveGeometryCompiler,
  digestInkPenPhysicalCoverage,
  resolveUnpublishedInkPenPhysicalDiameter,
  UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE,
} from './ink-pen-physical-geometry';

describe('unpublished pen-physical-v1 geometry candidate', () => {
  it('keeps every candidate number default-off and owned by S34 calibration', () => {
    expect(UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE).toMatchObject({
      calibrationOwner: 'S34',
      candidateRevision: 's31-pen-geometry-r1',
      enabledByDefault: false,
      publication: 'unpublished-default-off',
    });
    expect(UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.pressure.minimumScale).toBeGreaterThan(0);
    expect(UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.velocity.minimumScale).toBeGreaterThan(0);
    expect(UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.velocity.maximumScale).toBe(1);
    expect(Object.isFrozen(UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE)).toBe(true);
    expect(Object.isFrozen(UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.pressure)).toBe(true);
  });

  it('uses pressure as the monotonic bounded primary width signal and restrained bounded speed thinning', () => {
    const nominalWidth = 10;
    const pressures = [0, 0.1, 0.25, 0.5, 0.75, 1];
    const pressureDiameters = pressures.map((pressure) =>
      resolveUnpublishedInkPenPhysicalDiameter({
        nominalWidth,
        pressure,
        speed: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.velocity.referenceSpeed,
      }),
    );
    const slow = resolveUnpublishedInkPenPhysicalDiameter({
      nominalWidth,
      pressure: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.pressure.referencePressure,
      speed: 0,
    });
    const reference = resolveUnpublishedInkPenPhysicalDiameter({
      nominalWidth,
      pressure: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.pressure.referencePressure,
      speed: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.velocity.referenceSpeed,
    });
    const fast = resolveUnpublishedInkPenPhysicalDiameter({
      nominalWidth,
      pressure: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.pressure.referencePressure,
      speed: Number.POSITIVE_INFINITY,
    });

    expect(pressureDiameters).toEqual([...pressureDiameters].sort((left, right) => left - right));
    expect(pressureDiameters[0]).toBeGreaterThan(0);
    expect(pressureDiameters.at(-1)).toBeLessThanOrEqual(
      nominalWidth * UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.pressure.maximumScale,
    );
    expect(reference).toBe(nominalWidth);
    expect(slow).toBe(reference);
    expect(fast).toBeLessThan(reference);
    expect(fast).toBeGreaterThanOrEqual(
      nominalWidth * UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.velocity.minimumScale,
    );
    expect((pressureDiameters.at(-1) ?? 0) - (pressureDiameters[0] ?? 0)).toBeGreaterThan(
      slow - fast,
    );
  });

  it('renders a tap as one solid pressure circle and keeps tilt out of circular coverage', () => {
    const upright = penStroke('tap', [point(5, 7, 0, 0.75, measuredOrientation(true, 0, 1.2))]);
    const tilted = penStroke('tap', [
      point(5, 7, 0, 0.75, measuredOrientation(true, Math.PI / 3, 0.1)),
    ]);
    const uprightResult = compileInkPenPhysicalGeometry(upright);
    const tiltedResult = compileInkPenPhysicalGeometry(tilted);

    expect(uprightResult.kind).toBe('unpublished');
    expect(tiltedResult.kind).toBe('unpublished');
    if (uprightResult.kind !== 'unpublished' || tiltedResult.kind !== 'unpublished') {
      throw new Error('expected unpublished Pen candidate geometry');
    }
    expect(uprightResult.geometry.coverage).toEqual(tiltedResult.geometry.coverage);
    expect(uprightResult.geometry.bounds).toEqual(tiltedResult.geometry.bounds);
    expect(uprightResult.geometry.coverage.contours).toHaveLength(1);
    expect(uprightResult.geometry.blend).toEqual({
      alpha: { kind: 'fixed', value: 1 },
      application: 'once-per-logical-stroke',
      colorSpace: 'srgb',
      composite: 'source-over',
    });
    expect(uprightResult.geometry.hitShape).toEqual({
      fillRule: 'nonzero',
      kind: 'filled-contour-distance',
    });
    expect(signedArea(uprightResult.geometry.coverage.contours[0] ?? [])).toBeGreaterThan(0);
    expect(pointInCoverage(5, 7, uprightResult.geometry.coverage)).toBe(true);
    expect(JSON.stringify(uprightResult.geometry)).not.toMatch(
      /candidateRevision|s31-pen-geometry-r1|S34|unpublished-default-off/u,
    );
  });

  it.each([
    ['right angle', [point(0, 0, 0, 0.4), point(8, 0, 10, 0.6), point(8, 8, 20, 0.8)]],
    ['hairpin', [point(0, 0, 0, 0.5), point(10, 0, 10, 0.5), point(0.2, 0.1, 20, 0.5)]],
    [
      'self crossing',
      [point(0, 0, 0, 0.5), point(10, 10, 10, 0.5), point(0, 10, 20, 0.5), point(10, 0, 30, 0.5)],
    ],
    [
      'repeated and zero-length',
      [point(2, 2, 0, 0), point(2, 2, 0, 0.2), point(2, 2, 0, 1), point(4, 2, 0, 0.01)],
    ],
  ])('keeps %s union coverage finite, bounded, positive-winding, and gap-free', (_name, points) => {
    const stroke = penStroke('stress', points);
    const result = compileInkPenPhysicalGeometry(stroke);

    expect(result.kind).toBe('unpublished');
    if (result.kind !== 'unpublished') throw new Error('expected unpublished Pen geometry');
    expect(result.geometry.coverage.contours.length).toBeGreaterThan(0);
    expect(result.geometry.coverage.contours.every((contour) => signedArea(contour) > 0)).toBe(
      true,
    );
    expect(
      result.geometry.coverage.contours
        .flat()
        .every(({ x, y }) => Number.isSafeInteger(x) && Number.isSafeInteger(y)),
    ).toBe(true);
    for (const current of points) {
      expect(pointInCoverage(current.x, current.y, result.geometry.coverage)).toBe(true);
    }
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      if (previous === undefined || current === undefined) continue;
      expect(
        pointInCoverage(
          (previous.x + current.x) / 2,
          (previous.y + current.y) / 2,
          result.geometry.coverage,
        ),
      ).toBe(true);
    }
    const maximumRadius =
      (stroke.header.nominalWidth * UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.pressure.maximumScale) /
        2 +
      UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.quantization.logicalGrid;
    expect(result.geometry.bounds.x).toBeGreaterThanOrEqual(
      Math.min(...points.map(({ x }) => x)) - maximumRadius,
    );
    expect(result.geometry.bounds.x + result.geometry.bounds.width).toBeLessThanOrEqual(
      Math.max(...points.map(({ x }) => x)) + maximumRadius,
    );
    expect(result.geometry.bounds.y).toBeGreaterThanOrEqual(
      Math.min(...points.map(({ y }) => y)) - maximumRadius,
    );
    expect(result.geometry.bounds.y + result.geometry.bounds.height).toBeLessThanOrEqual(
      Math.max(...points.map(({ y }) => y)) + maximumRadius,
    );
  });

  it('retains a one-point pressure impulse even on a straight, equal-time trace', () => {
    const impulse = compileInkPenPhysicalGeometry(
      penStroke('pressure-impulse', [point(0, 0, 0, 0.1), point(4, 0, 0, 1), point(8, 0, 0, 0.1)]),
    );
    const low = compileInkPenPhysicalGeometry(
      penStroke('pressure-impulse-low', [
        point(0, 0, 0, 0.1),
        point(4, 0, 0, 0.1),
        point(8, 0, 0, 0.1),
      ]),
    );

    expect(impulse.kind).toBe('unpublished');
    expect(low.kind).toBe('unpublished');
    if (impulse.kind !== 'unpublished' || low.kind !== 'unpublished') {
      throw new Error('expected unpublished Pen geometry');
    }
    expect(impulse.geometry.bounds.height).toBeGreaterThan(low.geometry.bounds.height * 2);
    expect(pointInCoverage(4, 0, impulse.geometry.coverage)).toBe(true);
  });

  it('is deterministic and returns typed unsupported/degraded outcomes without mutating the trace', () => {
    const stroke = penStroke('deterministic', [
      point(0, 0, 0, 0.2),
      point(3, 2, 4, 0.9),
      point(8, 1, 10, 0.4),
    ]);
    const first = compileInkPenPhysicalGeometry(stroke);
    const second = compileInkPenPhysicalGeometry(structuredClone(stroke));

    expect(second).toEqual(first);
    expect(
      compileInkPenPhysicalGeometry({
        ...stroke,
        header: { ...stroke.header, version: 'future-pen-v9' },
      }),
    ).toEqual({
      kind: 'unsupported',
      reason: 'unknown-version',
      requestedVersion: 'future-pen-v9',
    });
    expect(
      compileInkPenPhysicalGeometry({
        ...stroke,
        header: { ...stroke.header, tool: 'highlighter' },
      }),
    ).toEqual({
      kind: 'unsupported',
      reason: 'invalid-canonical-stroke',
      requestedVersion: 'pen-physical-v1',
    });

    const extreme = penStroke('extreme', [point(Number.MAX_VALUE, 0, 0, 0.5)]);
    const before = structuredClone(extreme.trace);
    const failed = compileInkPenPhysicalGeometry(extreme);
    expect(['degraded', 'unsupported']).toContain(failed.kind);
    expect(extreme.trace).toEqual(before);
  });

  it('keeps active stable append-only, replaces the whole bounded tail, and finishes without blank ownership transfer', () => {
    const points = [
      point(0, 0, 0, 0.25),
      point(3, 0, 5, 0.5),
      point(6, 2, 10, 0.8),
      point(8, 5, 15, 1),
      point(12, 5, 20, 0.4),
    ];
    const created = createInkPenPhysicalActiveGeometryCompiler(penStroke('active', points).header);
    expect(created.kind).toBe('ready');
    if (created.kind !== 'ready') throw new Error('expected ready active Pen compiler');
    expectTypeOf(created.compiler).toMatchTypeOf<InkBrushActiveGeometryCompiler>();

    const first = created.compiler.extend(delta(points.slice(0, 1), points.slice(1, 3)));
    const second = created.compiler.extend(delta(points.slice(1, 2), points.slice(2)));
    const beforeFinish = created.compiler.stats();
    const finished = created.compiler.finish(delta(points.slice(2), []));
    const afterFinish = created.compiler.stats();

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
      workScope: 'new-stable-plus-bounded-mutable-tail',
    });
    expect(finished.stable.coverage.length).toBeGreaterThan(0);
    expect(afterFinish.inspectedPointCount - beforeFinish.inspectedPointCount).toBe(
      points.length - 2,
    );

    const activeCoverage = filledCoverages([
      ...first.stable.coverage,
      ...second.stable.coverage,
      ...finished.stable.coverage,
      ...finished.mutable.coverage,
    ]);
    const committed = compileInkPenPhysicalGeometry(penStroke('active', points));
    expect(committed.kind).toBe('unpublished');
    if (committed.kind !== 'unpublished') throw new Error('expected committed Pen geometry');
    expect(finished.bounds).toEqual(committed.geometry.bounds);
    expect(activeCoverage.flatMap(({ contours }) => contours)).toEqual(
      committed.geometry.coverage.contours,
    );
    expect(digestInkPenPhysicalCoverage(activeCoverage)).toBe(
      digestInkPenPhysicalCoverage([committed.geometry.coverage]),
    );
    expect(JSON.stringify(finished)).not.toMatch(/candidateRevision|s31-pen-geometry-r1/u);
    expect(() => created.compiler.finish(delta([], []))).toThrow('already finished');
    expect(() => createInkBrushActiveGeometryUpdate(finished)).not.toThrow();
  });

  it('rejects an oversized mutable replacement transactionally', () => {
    const created = createInkPenPhysicalActiveGeometryCompiler(
      penStroke('bounded-tail', [point(0, 0, 0, 0.5)]).header,
    );
    if (created.kind !== 'ready') throw new Error('expected ready active Pen compiler');
    const oversized = Array.from(
      { length: UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.active.maximumMutableTailPoints + 1 },
      (_value, index) => point(index, 0, index, 0.5),
    );

    expect(() => created.compiler.extend(delta([], oversized))).toThrow('hard bound');
    expect(created.compiler.stats()).toMatchObject({
      emittedContourCount: 0,
      inspectedPointCount: 0,
      maximumMutableTailPointCount: 0,
    });
    expect(() => created.compiler.finish(delta([], []))).toThrow('blank active ownership');
  });

  it('inspects only new points plus the bounded replacement tail after a 50k-point prefix', () => {
    const created = createInkPenPhysicalActiveGeometryCompiler(
      penStroke('long', [point(0, 0, 0, 0.5)], 0.5).header,
    );
    if (created.kind !== 'ready') throw new Error('expected ready active Pen compiler');
    const prefix = Array.from({ length: 50_000 }, (_value, index) =>
      point(index * 0.001, 0, index, 0.5),
    );

    created.compiler.extend(delta(prefix, []));
    const afterPrefix = created.compiler.stats();
    const lateTail = [point(50.001, 0, 50_001, 0.5), point(50.002, 0, 50_002, 0.5)];
    const late = created.compiler.extend(delta([point(50, 0, 50_000, 0.5)], lateTail));
    const afterLate = created.compiler.stats();

    expect(afterPrefix.inspectedPointCount).toBe(50_000);
    expect(afterLate.inspectedPointCount - afterPrefix.inspectedPointCount).toBe(3);
    expect(afterLate.maximumMutableTailPointCount).toBeLessThanOrEqual(
      UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.active.maximumMutableTailPoints,
    );
    expect(late.workScope).toBe('new-stable-plus-bounded-mutable-tail');
    expect(afterLate).toMatchObject({
      calibrationOwner: 'S34',
      candidateRevision: 's31-pen-geometry-r1',
      publication: 'unpublished-default-off',
    });
  }, 20_000);
});

function penStroke(
  logicalStrokeId: string,
  points: readonly InkPhysicalBrushControlPoint[],
  nominalWidth = 4,
): Extract<InkBrushLogicalStroke, { readonly header: { readonly version: 'pen-physical-v1' } }> {
  const stroke = createInkBrushLogicalStroke({
    header: {
      color: '#123456',
      inputProfile: { pressure: 'measured', tilt: 'measured' },
      logicalStrokeId,
      nominalWidth,
      tool: 'pen',
      version: 'pen-physical-v1',
    },
    trace: { kind: 'physical-control-trace', points },
  });
  if (stroke.header.version !== 'pen-physical-v1' || stroke.header.tool !== 'pen') {
    throw new Error('expected physical Pen stroke');
  }
  return stroke as Extract<
    InkBrushLogicalStroke,
    { readonly header: { readonly version: 'pen-physical-v1' } }
  >;
}

function filledCoverages(coverage: readonly InkBrushCoverage[]): InkFilledContourCoverage[] {
  return coverage.map((entry) => {
    if (entry.kind !== 'quantized-filled-contours') {
      throw new Error('expected filled Pen coverage');
    }
    return entry;
  });
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
  reliable: boolean,
  altitude: number,
  azimuth: number,
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

function signedArea(contour: readonly { readonly x: number; readonly y: number }[]): number {
  let area = 0;
  for (let index = 0; index + 1 < contour.length; index += 1) {
    const current = contour[index];
    const next = contour[index + 1];
    if (current !== undefined && next !== undefined)
      area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function pointInCoverage(x: number, y: number, coverage: InkFilledContourCoverage): boolean {
  const grid = UNPUBLISHED_INK_PEN_PHYSICAL_PROFILE.quantization.logicalGrid;
  return coverage.contours.some((contour) => pointInPolygon(x / grid, y / grid, contour));
}

function pointInPolygon(
  x: number,
  y: number,
  contour: readonly { readonly x: number; readonly y: number }[],
): boolean {
  let inside = false;
  for (let index = 0, previousIndex = contour.length - 1; index < contour.length; index += 1) {
    const current = contour[index];
    const previous = contour[previousIndex];
    if (current === undefined || previous === undefined) continue;
    if (pointOnSegment(x, y, previous.x, previous.y, current.x, current.y)) return true;
    if (
      current.y > y !== previous.y > y &&
      x < ((previous.x - current.x) * (y - current.y)) / (previous.y - current.y) + current.x
    ) {
      inside = !inside;
    }
    previousIndex = index;
  }
  return inside;
}

function pointOnSegment(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  const cross = (x - x0) * (y1 - y0) - (y - y0) * (x1 - x0);
  return (
    Math.abs(cross) < 1e-7 &&
    x >= Math.min(x0, x1) &&
    x <= Math.max(x0, x1) &&
    y >= Math.min(y0, y1) &&
    y <= Math.max(y0, y1)
  );
}
