import { describe, expect, it } from 'vitest';

import type { InkContactSample } from './ink-contact';
import { CausalLegacyInkReducer } from './ink-control-trace';

describe('Foundation causal trace performance', () => {
  it('reduces a 30-second 240 Hz contact within the desktop completion budget', () => {
    const reducer = new CausalLegacyInkReducer();
    const samples = Array.from({ length: 30 * 240 }, (_value, index): InkContactSample => ({
      orientation: {
        altitude: { kind: 'measured', value: Math.PI / 3 },
        azimuth: { kind: 'measured', value: (index / 240) % (Math.PI * 2) },
      },
      pressure: { kind: 'measured', value: 0.5 + Math.sin(index / 30) * 0.1 },
      time: index * (1_000 / 240),
      x: index / 12,
      y: 100 + Math.sin(index / 100) * 20,
    }));
    const startedAt = performance.now();

    for (const sample of samples) reducer.extend([sample]);
    const trace = reducer.finalize();
    const durationMs = performance.now() - startedAt;

    expect(trace.rawSampleCount).toBe(samples.length);
    expect(trace.points.length).toBeLessThan(samples.length / 2);
    expect(reducer.stats()).toMatchObject({
      allocatedMutableSampleObjectCount: 0,
      mutableTailStorageKind: 'float64-fixed-buffer',
      retainedMutableSampleObjectCount: 0,
    });
    expect(durationMs).toBeLessThan(250);
  });
});
