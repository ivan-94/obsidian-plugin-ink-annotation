import { describe, expect, it } from 'vitest';

import {
  INK_SAMPLE_FLAGS,
  type InkContactSample,
  type InkSampleCursor,
  type InkSampleSequence,
} from './ink-contact';
import {
  CausalLegacyInkReducer,
  ChunkedInkSampleBuffer,
  FOUNDATION_LEGACY_TRACE_LIMITS,
} from './ink-control-trace';

describe('Foundation causal legacy control trace', () => {
  it('is invariant to native event regrouping and preserves required endpoints', () => {
    const samples = Array.from({ length: 200 }, (_value, index) =>
      sample(index, Math.sin(index / 20) * 10, index === 80 ? 1 : 0.5),
    );
    const individual = new CausalLegacyInkReducer();
    const grouped = new CausalLegacyInkReducer();

    for (const next of samples) individual.extend([next]);
    for (let index = 0; index < samples.length; index += 17) {
      grouped.extend(samples.slice(index, index + 17));
    }

    const first = individual.finalize();
    const second = grouped.finalize();
    expect(second.points).toEqual(first.points);
    expect(first.points[0]).toMatchObject({ x: 0, y: 0 });
    expect(first.points.at(-1)).toMatchObject({ x: 199, y: samples.at(-1)?.y });
    expect(first.points).toContainEqual(expect.objectContaining({ pressure: 1, x: 80 }));
  });

  it('monotonizes time without rewriting earlier trace points', () => {
    const reducer = new CausalLegacyInkReducer();
    reducer.extend([sample(0, 0, 0.5, 20), sample(10, 0, 0.5, 10)]);
    const before = reducer.view().stablePrefix;

    reducer.extend([sample(20, 0, 0.5, 30)]);
    const trace = reducer.finalize();

    expect(trace.points.map(({ time }) => time)).toEqual(
      [...trace.points.map(({ time }) => time)].sort((left, right) => left - right),
    );
    expect(reducer.view().stablePrefix.slice(0, before.length)).toEqual(before);
  });

  it('retains a measured orientation impulse in both control samples and the legacy command trace', () => {
    const reducer = new CausalLegacyInkReducer();
    reducer.extend([
      orientedSample(0, Math.PI / 4),
      orientedSample(1, Math.PI / 3),
      orientedSample(2, Math.PI / 4),
    ]);

    const trace = reducer.finalize();

    const impulseSample = trace.samples.find(({ x }) => x === 1);
    const impulsePoint = trace.points.find(({ x }) => x === 1);
    expect(impulseSample?.orientation.altitude).toEqual({
      kind: 'measured',
      value: Math.PI / 3,
    });
    expect(typeof impulsePoint?.tiltX).toBe('number');
    expect(typeof impulsePoint?.tiltY).toBe('number');
  });

  it('keeps a bounded mutable tail and reduces 30 seconds by authored arc/time, not 240 Hz input count', () => {
    const reducer = new CausalLegacyInkReducer();
    const samples = Array.from({ length: 30 * 240 }, (_value, index) =>
      sample(index / 24, 100, 0.5, index * (1_000 / 240)),
    );

    for (const next of samples) {
      const delta = reducer.extend([next]);
      expect(delta.mutableTail.length).toBeLessThanOrEqual(
        FOUNDATION_LEGACY_TRACE_LIMITS.maximumMutableTailSamples,
      );
    }
    const trace = reducer.finalize();

    // Frozen S24 evidence: 7,200 native samples become 901 authored trace points.
    expect(trace.points.length).toBe(901);
    expect(trace.points.at(-1)).toMatchObject({ x: samples.at(-1)?.x, y: 100 });
  });

  it('does not retain native-rate raw sample objects after reducing them', () => {
    const reducer = new CausalLegacyInkReducer();
    const samples = Array.from({ length: 10_000 }, (_value, index) =>
      sample(index / 4, Math.sin(index / 100), 0.5, index),
    );

    for (let index = 0; index < samples.length; index += 64) {
      reducer.extend(samples.slice(index, index + 64));
    }

    const stats = reducer.stats();
    expect(stats.allocatedMutableSampleObjectCount).toBe(0);
    expect(stats.retainedMutableSampleObjectCount).toBe(0);
    expect(stats.rawSampleCount).toBe(10_000);
    expect(stats.retainedRawSampleCount).toBe(0);
    expect(stats.retainedStableSampleObjectCount).toBe(0);
    expect(stats.mutableTailStorageKind).toBe('float64-fixed-buffer');
    expect(stats.stableStorageKind).toBe('float64-chunks');
    expect(stats.mutableTailSampleCount).toBeLessThanOrEqual(
      FOUNDATION_LEGACY_TRACE_LIMITS.maximumMutableTailSamples,
    );
    expect(stats.stableChunkCount).toBe(Math.ceil(stats.stableSampleCount / 256));
  });

  it('keeps the numeric presentation path free of legacy point materialization', () => {
    const reducer = new CausalLegacyInkReducer();
    const update = reducer.extendSequence(numericSequence(10_000));

    let presentedSampleCount = 0;
    update.stablePrefixDelta.forEachSample(() => {
      presentedSampleCount += 1;
    });
    update.mutableTail.forEachSample(() => {
      presentedSampleCount += 1;
    });

    const stats = reducer.stats();
    expect(presentedSampleCount).toBeGreaterThan(0);
    expect(stats.materializedLegacyPointCount).toBe(0);
    expect(stats.allocatedMutableSampleObjectCount).toBe(0);
    expect(stats.retainedMutableSampleObjectCount).toBe(0);
    expect(stats.mutableTailStorageKind).toBe('float64-fixed-buffer');
    expect(stats.retainedStableSampleObjectCount).toBe(0);
  });

  it('materializes the immutable legacy trace only at numeric sequence finalization', () => {
    const reducer = new CausalLegacyInkReducer();
    reducer.extendSequence(numericSequence(200));
    expect(reducer.stats().materializedLegacyPointCount).toBe(0);

    const completed = reducer.finalizeSequence();

    expect(completed.trace.points.length).toBeGreaterThan(0);
    expect(reducer.stats().materializedLegacyPointCount).toBe(completed.trace.points.length);
    expect(completed.presentationDelta.mutableTail.length).toBe(0);
    expect(completed.presentationDelta.stablePrefixDelta.length).toBe(
      completed.delta.stablePrefixDelta.length,
    );
  });

  it('keeps exact legacy points when the fixed numeric tail compacts mixed sensor samples', () => {
    const samples = Array.from({ length: 96 }, (_value, index): InkContactSample => ({
      orientation:
        index % 5 === 0
          ? { altitude: { kind: 'unavailable' }, azimuth: { kind: 'unavailable' } }
          : {
              altitude: { kind: 'measured', value: index % 7 === 0 ? 0 : Math.PI / 3 },
              azimuth: { kind: 'measured', value: (index % 8) * (Math.PI / 4) },
            },
      pressure:
        index % 6 === 0
          ? { kind: 'unavailable' }
          : { kind: 'measured', value: index % 9 === 0 ? 0 : 0.25 + (index % 4) * 0.2 },
      time: index % 11 === 0 ? index - 4 : index,
      x: index / 8,
      y: Math.sin(index / 4),
    }));
    const objectReducer = new CausalLegacyInkReducer();
    const numericReducer = new CausalLegacyInkReducer();

    for (let index = 0; index < samples.length; index += 13) {
      objectReducer.extend(samples.slice(index, index + 13));
    }
    numericReducer.extendSequence(numericSequenceFromSamples(samples));

    const objectTrace = objectReducer.finalize();
    const numericTrace = numericReducer.finalizeSequence().trace;
    expect(numericTrace).toEqual(objectTrace);
    expect(numericReducer.stats()).toMatchObject({
      allocatedMutableSampleObjectCount: 0,
      mutableTailStorageKind: 'float64-fixed-buffer',
      retainedMutableSampleObjectCount: 0,
    });
  });
});

describe('Chunked Ink sample storage', () => {
  it('grows by fixed chunks without copying earlier sample objects', () => {
    const buffer = new ChunkedInkSampleBuffer(64);
    const samples = Array.from({ length: 10_000 }, (_value, index) => sample(index, 0));

    for (const next of samples) buffer.append(next);

    expect(buffer.length).toBe(10_000);
    expect(buffer.chunkCount).toBe(Math.ceil(10_000 / 64));
    expect(buffer.at(0)).toBe(samples[0]);
    expect(buffer.at(9_999)).toBe(samples[9_999]);
    expect(buffer.copiedSampleCount).toBe(0);
  });
});

function sample(x: number, y: number, pressure = 0.5, time = x): InkContactSample {
  return {
    orientation: {
      altitude: { kind: 'unavailable' },
      azimuth: { kind: 'unavailable' },
    },
    pressure: { kind: 'measured', value: pressure },
    time,
    x,
    y,
  };
}

function orientedSample(x: number, altitude: number): InkContactSample {
  return {
    ...sample(x, 0),
    orientation: {
      altitude: { kind: 'measured', value: altitude },
      azimuth: { kind: 'measured', value: Math.PI / 4 },
    },
  };
}

function numericSequence(length: number): InkSampleSequence {
  const cursor: InkSampleCursor = {
    altitude: 0,
    azimuth: 0,
    flags: 0,
    pressure: 0.5,
    time: 0,
    x: 0,
    y: 0,
  };
  return {
    copiedNativeSampleCount: 0,
    forEachSample(consumer) {
      for (let index = 0; index < length; index += 1) {
        cursor.time = index;
        cursor.x = index / 4;
        cursor.y = Math.sin(index / 100);
        consumer(cursor);
      }
    },
    length,
    materialize: () => {
      throw new Error('Numeric trace test must not materialize its source sequence.');
    },
    materializedSampleCount: 0,
  };
}

function numericSequenceFromSamples(samples: readonly InkContactSample[]): InkSampleSequence {
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
    forEachSample(consumer) {
      for (const sampleValue of samples) {
        cursor.x = sampleValue.x;
        cursor.y = sampleValue.y;
        cursor.time = sampleValue.time;
        cursor.flags = 0;
        cursor.pressure = 0;
        cursor.altitude = 0;
        cursor.azimuth = 0;
        if (sampleValue.pressure.kind === 'measured') {
          cursor.pressure = sampleValue.pressure.value;
          cursor.flags |= INK_SAMPLE_FLAGS.pressureMeasured;
        }
        if (sampleValue.orientation.altitude.kind === 'measured') {
          cursor.altitude = sampleValue.orientation.altitude.value;
          cursor.flags |= INK_SAMPLE_FLAGS.altitudeMeasured;
        }
        if (sampleValue.orientation.azimuth.kind === 'measured') {
          cursor.azimuth = sampleValue.orientation.azimuth.value;
          cursor.flags |= INK_SAMPLE_FLAGS.azimuthMeasured;
        }
        consumer(cursor);
      }
    },
    length: samples.length,
    materialize: () => samples,
    materializedSampleCount: 0,
  };
}
