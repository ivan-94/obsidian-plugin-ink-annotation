import { describe, expect, it } from 'vitest';

import {
  INK_SAMPLE_FLAGS,
  type InkContactSample,
  type InkSampleCursor,
  type InkSampleSequence,
} from './ink-contact';
import { createInkBrushLogicalStroke } from './ink-brush-geometry-contract';
import { InkPhysicalControlTraceBuilder } from './ink-physical-control-trace';

describe('physical Brush Control Trace', () => {
  it('seals the confirmed prefix without inventing a cross-frame endpoint', () => {
    const builder = readyBuilder();
    builder.update('down', sequence([sample(10, 10, 0, 'measured', 0.4)]));
    builder.update('move', sequence([sample(20, 18, 8, 'measured', 0.6)]));

    const sealed = builder.seal();

    expect(sealed.kind).toBe('completed');
    if (sealed.kind !== 'completed') throw new Error('expected a sealed physical trace');
    expect(sealed.points.at(-1)).toMatchObject({ time: 8, x: 20, y: 18 });
    expect(sealed.bounds).toEqual({ height: 8, width: 10, x: 10, y: 10 });
  });

  it('keeps pressure provenance and all-or-none orientation through contact completion', () => {
    const created = InkPhysicalControlTraceBuilder.create({
      pressure: 'measured',
      tilt: 'measured',
    });
    expect(created.kind).toBe('ready');
    if (created.kind !== 'ready') throw new Error('expected a physical trace builder');

    expect(created.builder.update('down', sequence([sample(0, 0, 0, 'unavailable')])).kind).toBe(
      'active',
    );
    expect(
      created.builder.update('move', sequence([sample(10, 0, 10, 'measured', 0, Math.PI / 3, 0)]))
        .kind,
    ).toBe('active');
    expect(
      created.builder.update('move', sequence([sample(20, 0, 20, 'measured', 0.8)])).kind,
    ).toBe('active');
    const finished = created.builder.update(
      'up',
      sequence([sample(25, 2, 30, 'measured', 0, Math.PI / 4, Math.PI / 2)]),
    );

    expect(finished.kind).toBe('completed');
    if (finished.kind !== 'completed') throw new Error('expected a completed physical trace');
    expect(finished.trace.points[0]).toMatchObject({
      orientation: { kind: 'unavailable' },
      pressure: { kind: 'unavailable', value: 0.5 },
    });
    expect(finished.trace.points).toContainEqual(
      expect.objectContaining({ pressure: { kind: 'measured', value: 0 }, x: 10 }),
    );
    expect(finished.trace.points).toContainEqual(
      expect.objectContaining({
        orientation: { altitude: Math.PI / 3, azimuth: 0, kind: 'measured', reliable: true },
        x: 10,
      }),
    );
    expect(finished.trace.points.at(-1)).toMatchObject({
      pressure: { kind: 'measured' },
      time: 30,
      x: 25,
      y: 2,
    });
    expect(finished.trace.points.at(-1)?.pressure.value).toBeGreaterThan(0);
    expect(finished.points[0]).toMatchObject({
      orientation: { kind: 'unavailable' },
      pressure: 0.5,
      pressureKind: 'unavailable',
    });
    expect(finished.points.at(-1)).toMatchObject({ time: 30, x: 25, y: 2 });
    expect(finished.bounds).toEqual({ height: 2, width: 25, x: 0, y: 0 });
    expect(created.builder.stats()).toMatchObject({
      fixtureReferenceSampleCount: 1,
      pressureReferenceFixture: 's30-unpublished-reference-pressure',
      terminationCarriedSampleCount: 1,
    });
    expect(finished.trace.kind).toBe('physical-control-trace');
    expect(JSON.stringify(finished.trace)).not.toContain('s30-kernel-r1');
  });

  it('produces one exact causal trace across batching while retaining sensor impulses and endpoint', () => {
    const samples = [
      sample(0, 0, 10, 'measured', 0.3, Math.PI / 3, Math.PI * 2 - 0.1),
      sample(1, 0, 10, 'measured', 0.3, Math.PI / 3, 0.1),
      sample(2, 0.1, 8, 'measured', 1, Math.PI / 6, 0.2),
      sample(3, 0, 20, 'measured', 0.3, Math.PI / 3, 0.3),
      sample(4.5, 1, 19, 'measured', 0, Math.PI / 3, 0.4),
    ];
    const individual = readyBuilder();
    const grouped = readyBuilder();

    individual.update('down', sequence(samples.slice(0, 1)));
    for (const next of samples.slice(1, -1)) individual.update('move', sequence([next]));
    const individualResult = individual.update('up', sequence(samples.slice(-1)));
    grouped.update('down', sequence(samples.slice(0, 1)));
    grouped.update('move', sequence(samples.slice(1, -1)));
    const groupedResult = grouped.update('up', sequence(samples.slice(-1)));

    expect(individualResult.kind).toBe('completed');
    expect(groupedResult.kind).toBe('completed');
    if (individualResult.kind !== 'completed' || groupedResult.kind !== 'completed') {
      throw new Error('expected completed physical traces');
    }
    expect(groupedResult.trace).toEqual(individualResult.trace);
    expect(groupedResult.points).toEqual(individualResult.points);
    expect(groupedResult.trace.points.map(({ time }) => time)).toEqual(
      [...groupedResult.trace.points.map(({ time }) => time)].sort((left, right) => left - right),
    );
    expect(
      Math.max(...groupedResult.trace.points.map(({ pressure }) => pressure.value)),
    ).toBeGreaterThan(0.7);
    expect(
      Math.min(
        ...groupedResult.trace.points.flatMap(({ orientation }) =>
          orientation.kind === 'measured' ? [orientation.altitude] : [],
        ),
      ),
    ).toBeLessThan(Math.PI / 3);
    expect(
      groupedResult.trace.points
        .flatMap(({ orientation }) =>
          orientation.kind === 'measured' ? [orientation.azimuth] : [],
        )
        .every((azimuth) => Math.cos(azimuth) > 0.8),
    ).toBe(true);
    expect(groupedResult.trace.points.at(-1)).toMatchObject({ time: 20, x: 4.5, y: 1 });
    expect(groupedResult.rawSampleCount).toBe(samples.length);
  });

  it('extends a 50k prefix through an append-only stable delta and hard-bounded mutable tail', () => {
    const builder = readyBuilder();
    const initial = builder.update('down', generatedSequence(0, 50_000));
    expect(initial.kind).toBe('active');
    if (initial.kind !== 'active') throw new Error('expected an active physical trace');
    const afterPrefix = builder.stats();
    expect(initial.presentationDelta.mutableTail.length).toBeLessThanOrEqual(
      afterPrefix.mutableTailLimit,
    );
    expect(initial.brushDelta.stableAppend).toMatchObject({ kind: 'physical-control-trace' });
    expect(initial.brushDelta.stableAppend.points.length).toBe(
      initial.presentationDelta.stablePrefixDelta.length,
    );
    expect(initial.brushDelta.mutableReplacement.points.length).toBe(
      initial.presentationDelta.mutableTail.length,
    );
    expect(afterPrefix.maximumObservedMutableTailSampleCount).toBeLessThanOrEqual(
      afterPrefix.mutableTailLimit,
    );

    const appended = builder.update('move', generatedSequence(50_000, 1));
    expect(appended.kind).toBe('active');
    if (appended.kind !== 'active') throw new Error('expected an active physical trace');
    const afterAppend = builder.stats();
    expect(afterAppend.inspectedSampleCount - afterPrefix.inspectedSampleCount).toBeLessThanOrEqual(
      64,
    );
    expect(appended.presentationDelta.mutableTail.length).toBeLessThanOrEqual(
      afterAppend.mutableTailLimit,
    );

    const finished = builder.update('up', sequence([sample(1_000.02, 0, 5_000.1, 'measured', 0)]));
    expect(finished.kind).toBe('completed');
    if (finished.kind !== 'completed') throw new Error('expected a completed physical trace');
    const afterFinish = builder.stats();
    expect(afterFinish.inspectedSampleCount - afterAppend.inspectedSampleCount).toBeLessThanOrEqual(
      64,
    );
    expect(finished.trace.points.length).toBeLessThan(finished.rawSampleCount / 4);
    expect(finished.trace.points.at(-1)).toMatchObject({ x: 1_000.02, y: 0 });
    expect(afterFinish).toMatchObject({
      candidateRevision: 's30-kernel-r1',
      mutableTailSampleCount: 0,
      profilePublication: 'unpublished-fixture',
      rawSampleCount: 50_002,
    });
  });

  it('suppresses slow hand jitter causally while letting a fast confirmed tip catch up', () => {
    const builder = readyBuilder();
    builder.update('down', sequence([sample(0, 0, 0, 'measured', 0.5)]));
    const jitter = Array.from({ length: 20 }, (_value, index) =>
      sample(index % 2 === 0 ? 0.2 : -0.2, 0, (index + 1) * 10, 'measured', 0.5),
    );
    const slow = builder.update('move', sequence(jitter));
    expect(slow.kind).toBe('active');
    if (slow.kind !== 'active') throw new Error('expected an active physical trace');
    const slowPoints = collect(slow.presentationDelta);
    expect(Math.max(...slowPoints.map(({ x }) => Math.abs(x)))).toBeLessThan(0.12);

    const fast = builder.update('move', sequence([sample(10, 0, 201, 'measured', 0.5)]));
    expect(fast.kind).toBe('active');
    if (fast.kind !== 'active') throw new Error('expected an active physical trace');
    expect(collect(fast.presentationDelta)).toContainEqual(expect.objectContaining({ x: 10 }));
  });

  it('preserves a curved extremum before emitting a later pressure-change endpoint', () => {
    const builder = readyBuilder();
    builder.update('down', sequence([sample(0, 0, 0, 'measured', 0.5)]));

    const update = builder.update(
      'move',
      sequence([sample(1, 1, 1, 'measured', 0.5), sample(2, 0, 2, 'measured', 0.7)]),
    );

    expect(update.kind).toBe('active');
    if (update.kind !== 'active') throw new Error('expected an active physical trace');
    expect(update.brushDelta.stableAppend.points).toEqual([
      expect.objectContaining({ x: 1, y: 1 }),
      expect.objectContaining({ x: 2, y: 0 }),
    ]);
  });

  it('finishes at the shared canonical trace Interface without leaking candidate metadata', () => {
    const builder = readyBuilder();
    builder.update('down', sequence([sample(0, 0, 0, 'measured', 0.4)]));
    const finished = builder.update('up', sequence([sample(4, 2, 10, 'measured', 0)]));
    expect(finished.kind).toBe('completed');
    if (finished.kind !== 'completed') throw new Error('expected a completed physical trace');

    const stroke = createInkBrushLogicalStroke({
      header: {
        color: '#112233',
        inputProfile: { pressure: 'measured', tilt: 'measured' },
        logicalStrokeId: 's30-shared-trace',
        nominalWidth: 4,
        tool: 'pen',
        version: 'pen-physical-v1',
      },
      trace: finished.trace,
    });

    expect(stroke.trace).toEqual(finished.trace);
    expect(Object.keys(finished.trace).sort()).toEqual(['kind', 'points']);
    expect(finished.brushDelta.mutableReplacement).toEqual({
      kind: 'physical-control-trace',
      points: [],
    });
    expect(JSON.stringify(stroke)).not.toMatch(/candidateRevision|s30-kernel-r1/u);
  });

  it('fails closed with typed results for hostile profiles and partial orientation', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('hostile profile');
        },
      },
    );
    expect(() => InkPhysicalControlTraceBuilder.create(hostile)).not.toThrow();
    expect(InkPhysicalControlTraceBuilder.create(hostile)).toEqual({
      kind: 'invalid-input-profile',
      reason: 'malformed-input-profile',
    });
    expect(
      InkPhysicalControlTraceBuilder.create({ pressure: 'legacy-unknown', tilt: 'legacy-unknown' }),
    ).toEqual({ kind: 'invalid-input-profile', reason: 'malformed-input-profile' });

    const builder = readyBuilder();
    const partialOrientation = generatedSequence(0, 1);
    const partial: InkSampleSequence = {
      ...partialOrientation,
      forEachSample(consumer): void {
        consumer({
          altitude: Math.PI / 4,
          azimuth: 0,
          flags: INK_SAMPLE_FLAGS.pressureMeasured | INK_SAMPLE_FLAGS.altitudeMeasured,
          pressure: 0.5,
          time: 0,
          x: 0,
          y: 0,
        });
      },
    };

    expect(builder.update('down', partial)).toEqual({
      kind: 'invalid-input',
      reason: 'invalid-orientation',
    });
    expect(builder.update('up', sequence([sample(1, 1, 1, 'measured', 0)]))).toEqual({
      kind: 'invalid-input',
      reason: 'builder-failed',
    });
  });
});

function collect(delta: {
  readonly mutableTail: { forEachSample(consumer: (sample: InkSampleCursor) => void): void };
  readonly stablePrefixDelta: {
    forEachSample(consumer: (sample: InkSampleCursor) => void): void;
  };
}): InkSampleCursor[] {
  const points: InkSampleCursor[] = [];
  const append = (sample: InkSampleCursor): void => {
    points.push({ ...sample });
  };
  delta.stablePrefixDelta.forEachSample(append);
  delta.mutableTail.forEachSample(append);
  return points;
}

function readyBuilder(): InkPhysicalControlTraceBuilder {
  const created = InkPhysicalControlTraceBuilder.create({ pressure: 'measured', tilt: 'measured' });
  if (created.kind !== 'ready') throw new Error('expected a physical trace builder');
  return created.builder;
}

function sample(
  x: number,
  y: number,
  time: number,
  pressureKind: 'measured' | 'unavailable',
  pressure = 0,
  altitude?: number,
  azimuth?: number,
): InkContactSample {
  return {
    orientation:
      altitude === undefined || azimuth === undefined
        ? { altitude: { kind: 'unavailable' }, azimuth: { kind: 'unavailable' } }
        : {
            altitude: { kind: 'measured', value: altitude },
            azimuth: { kind: 'measured', value: azimuth },
          },
    pressure:
      pressureKind === 'measured' ? { kind: 'measured', value: pressure } : { kind: 'unavailable' },
    time,
    x,
    y,
  };
}

function sequence(samples: readonly InkContactSample[]): InkSampleSequence {
  const cursor: InkSampleCursor = {
    altitude: 0,
    azimuth: 0,
    flags: 0,
    pressure: 0,
    time: 0,
    x: 0,
    y: 0,
  };
  return {
    copiedNativeSampleCount: 0,
    forEachSample(consumer): void {
      for (const next of samples) {
        cursor.x = next.x;
        cursor.y = next.y;
        cursor.time = next.time;
        cursor.flags = 0;
        cursor.pressure = 0;
        cursor.altitude = 0;
        cursor.azimuth = 0;
        if (next.pressure.kind === 'measured') {
          cursor.flags |= INK_SAMPLE_FLAGS.pressureMeasured;
          cursor.pressure = next.pressure.value;
        }
        if (
          next.orientation.altitude.kind === 'measured' &&
          next.orientation.azimuth.kind === 'measured'
        ) {
          cursor.flags |= INK_SAMPLE_FLAGS.altitudeMeasured | INK_SAMPLE_FLAGS.azimuthMeasured;
          cursor.altitude = next.orientation.altitude.value;
          cursor.azimuth = next.orientation.azimuth.value;
        }
        consumer(cursor);
      }
    },
    get length() {
      return samples.length;
    },
    materialize: () => samples,
    materializedSampleCount: 0,
  };
}

function generatedSequence(start: number, count: number): InkSampleSequence {
  const cursor: InkSampleCursor = {
    altitude: 0,
    azimuth: 0,
    flags: INK_SAMPLE_FLAGS.pressureMeasured,
    pressure: 0.5,
    time: 0,
    x: 0,
    y: 0,
  };
  return {
    copiedNativeSampleCount: 0,
    forEachSample(consumer): void {
      for (let offset = 0; offset < count; offset += 1) {
        const index = start + offset;
        cursor.x = index * 0.02;
        cursor.y = Math.sin(index / 40) * 0.005;
        cursor.time = index * 0.1;
        consumer(cursor);
      }
    },
    length: count,
    materialize: () => [],
    materializedSampleCount: 0,
  };
}
