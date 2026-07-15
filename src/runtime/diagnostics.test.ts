import { describe, expect, it } from 'vitest';

import { Diagnostics } from './diagnostics';

describe('Diagnostics', () => {
  it('records only structured timing data while explicitly enabled', () => {
    const diagnostics = new Diagnostics(false, () => '2026-07-14T00:00:00.000Z');

    diagnostics.recordDuration('plugin-startup', 12.3456);
    expect(diagnostics.snapshot()).toEqual([]);

    diagnostics.setEnabled(true);
    diagnostics.recordDuration('plugin-startup', 12.3456);
    diagnostics.recordDuration('quick-toolbar-open', 18.994);
    diagnostics.recordMemory('manual-memory-checkpoint', {
      jsHeapSizeLimit: 512 * 1024 * 1024,
      totalJSHeapSize: 128 * 1024 * 1024,
      usedJSHeapSize: 64.126 * 1024 * 1024,
    });

    expect(diagnostics.snapshot()).toEqual([
      {
        durationMs: 12.35,
        name: 'plugin-startup',
        recordedAt: '2026-07-14T00:00:00.000Z',
      },
      {
        durationMs: 18.99,
        name: 'quick-toolbar-open',
        recordedAt: '2026-07-14T00:00:00.000Z',
      },
      {
        jsHeapLimitMb: 512,
        name: 'manual-memory-checkpoint',
        recordedAt: '2026-07-14T00:00:00.000Z',
        totalJsHeapMb: 128,
        usedJsHeapMb: 64.13,
      },
    ]);
  });

  it('reports a bounded latency distribution without retaining input geometry', () => {
    const diagnostics = new Diagnostics(true, () => '2026-07-14T00:00:00.000Z');

    for (const durationMs of [1, 2, 3, 4, 20]) {
      diagnostics.recordLatency('ink-input-to-paint', durationMs);
    }

    expect(diagnostics.snapshot()).toEqual([
      {
        maximumMs: 20,
        name: 'ink-input-to-paint',
        p50Ms: 3,
        p95Ms: 20,
        recordedAt: '2026-07-14T00:00:00.000Z',
        sampleCount: 5,
      },
    ]);
  });

  it('retains only the latest 240 latency samples', () => {
    const diagnostics = new Diagnostics(true);

    for (let durationMs = 1; durationMs <= 300; durationMs += 1) {
      diagnostics.recordLatency('ink-input-to-paint', durationMs);
    }

    expect(diagnostics.snapshot()[0]).toMatchObject({
      maximumMs: 300,
      p50Ms: 180,
      p95Ms: 288,
      sampleCount: 240,
    });
  });
});
