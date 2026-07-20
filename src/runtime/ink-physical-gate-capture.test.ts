import { describe, expect, it, vi } from 'vitest';

import { InkPerformanceDiagnostics } from './ink-performance-diagnostics';
import { decodeS27ConditionMarker, S27PhysicalGateCapture } from './ink-physical-gate-capture';

describe('S27PhysicalGateCapture', () => {
  it('resets diagnostics and records the frozen 120 idle rAF intervals before writing', async () => {
    const frames: FrameRequestCallback[] = [];
    const diagnostics = new InkPerformanceDiagnostics(true);
    diagnostics.beginSpan('ink-input-handler', { workPhase: 'input' }).finish();
    const capture = new S27PhysicalGateCapture({
      diagnostics,
      now: () => '2026-07-17T12:00:00.000Z',
      probeActiveWorkerCapabilities: () => Promise.resolve(activeWorkerCapabilities()),
      probeCapabilities: () =>
        Object.freeze({
          dedicatedWorkerConstruct: { available: false, failureCategory: 'needs-active-probe' },
          dedicatedWorkerModule: { available: false, failureCategory: 'needs-active-probe' },
          wasm: Object.freeze({ available: true, failureCategory: 'none' }),
          workerAnimationFrame: { available: false, failureCategory: 'needs-active-probe' },
        }) as never,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    const starting = capture.start({
      adapter: 'pointer',
      buildDigest: 'a'.repeat(64),
      conditionId: 'empty-writing',
      deviceDigest: 'd'.repeat(64),
      fixtureDigest: 'b'.repeat(64),
      presentationAdapter: 'main-canvas-2d',
      protocolDigest: 'c'.repeat(64),
      runIndex: 1,
      schemaVersion: 2,
      tester: 'Ivan',
    });
    for (let index = 0; index <= 120; index += 1) {
      frames.shift()?.(index * 16.7);
      await Promise.resolve();
    }
    await starting;
    frames.shift()?.(3_000);
    frames.shift()?.(3_055);

    const result = capture.finish();

    expect(result.diagnostics.frameIntervalsMs.idle).toHaveLength(120);
    expect(result.diagnostics.frameIntervalsMs.idle).toEqual(expect.arrayContaining([16.7]));
    expect(result.diagnostics.frameIntervalsMs.hostGaps).toEqual([55]);
    expect(result.diagnostics.recentSpans).toEqual([]);
    expect(result).toMatchObject({
      capturedAt: '2026-07-17T12:00:00.000Z',
      condition: {
        conditionId: 'empty-writing',
        presentationAdapter: 'main-canvas-2d',
        runIndex: 1,
      },
      longTasks: { available: false, durationsMs: [] },
      runtimeCapabilities: {
        dedicatedWorkerConstruct: { available: true, failureCategory: 'none' },
        dedicatedWorkerModule: { available: true, failureCategory: 'none' },
        wasm: { available: true, failureCategory: 'none' },
        workerAnimationFrame: { available: true, failureCategory: 'none' },
      },
      schemaVersion: 2,
    });
    expect(JSON.stringify(result)).not.toMatch(/path|coordinate|pressure|tilt|color/iu);
  });

  it('fails closed and disconnects capture resources when the active probe rejects', async () => {
    const frames: FrameRequestCallback[] = [];
    const disconnect = vi.fn();
    const capture = new S27PhysicalGateCapture({
      diagnostics: new InkPerformanceDiagnostics(true),
      observeLongTasks: () => ({ available: false, disconnect }),
      probeActiveWorkerCapabilities: () => Promise.reject(new Error('private Worker/CSP detail')),
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });

    await expect(capture.start(marker())).rejects.toThrow(
      'S27 active Worker capability probe failed.',
    );
    frames.shift()?.(0);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(() => capture.finish()).toThrow(
      'S27 capture has not completed idle refresh calibration.',
    );
    capture.cancel();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('does not let an active probe result arriving after cancel make the capture ready', async () => {
    const frames: FrameRequestCallback[] = [];
    const disconnect = vi.fn();
    let resolveActive!: (value: ReturnType<typeof activeWorkerCapabilities>) => void;
    const active = new Promise<ReturnType<typeof activeWorkerCapabilities>>((resolve) => {
      resolveActive = resolve;
    });
    const capture = new S27PhysicalGateCapture({
      diagnostics: new InkPerformanceDiagnostics(true),
      observeLongTasks: () => ({ available: false, disconnect }),
      probeActiveWorkerCapabilities: () => active,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    const starting = capture.start(marker());

    capture.cancel();
    resolveActive(activeWorkerCapabilities());
    frames.shift()?.(0);
    await starting;

    expect(disconnect).toHaveBeenCalledOnce();
    expect(() => capture.finish()).toThrow(
      'S27 capture has not completed idle refresh calibration.',
    );
  });

  it('rejects legacy schemaVersion 1 condition markers', () => {
    expect(() =>
      decodeS27ConditionMarker({
        adapter: 'pointer',
        buildDigest: 'a'.repeat(64),
        conditionId: 'empty-writing',
        deviceDigest: 'd'.repeat(64),
        fixtureDigest: 'b'.repeat(64),
        presentationAdapter: 'main-canvas-2d',
        protocolDigest: 'c'.repeat(64),
        runIndex: 1,
        schemaVersion: 1,
        tester: 'Ivan',
      }),
    ).toThrow('Invalid S27 condition marker.');
  });

  it('fails closed when the presentation Adapter evidence fence is missing or invalid', () => {
    const missing = marker() as Record<string, unknown>;
    Reflect.deleteProperty(missing, 'presentationAdapter');
    expect(() => decodeS27ConditionMarker(missing)).toThrow('Invalid S27 condition marker.');

    expect(() => decodeS27ConditionMarker({ ...marker(), presentationAdapter: 'webgpu' })).toThrow(
      'Invalid S27 condition marker.',
    );
  });

  it('refuses to capture when the condition does not match the selected production renderer', async () => {
    const probeCapabilities = vi.fn();
    const probeActiveWorkerCapabilities = vi.fn();
    const capture = new S27PhysicalGateCapture({
      diagnostics: new InkPerformanceDiagnostics(true),
      probeActiveWorkerCapabilities,
      probeCapabilities,
      selectedPresentationAdapterState: () => ({
        adapter: 'main-canvas-2d',
        epoch: 1,
        requestedAdapter: 'main-canvas-2d',
      }),
    });

    await expect(
      capture.start({ ...marker(), presentationAdapter: 'worker-offscreen-2d' }),
    ).rejects.toThrow('S27 condition renderer does not match the selected Ink renderer.');
    expect(probeCapabilities).not.toHaveBeenCalled();
    expect(probeActiveWorkerCapabilities).not.toHaveBeenCalled();
  });

  it('does not admit a requested Worker startup fallback into the main Canvas baseline', async () => {
    const probeCapabilities = vi.fn();
    const capture = new S27PhysicalGateCapture({
      diagnostics: new InkPerformanceDiagnostics(true),
      probeCapabilities,
      selectedPresentationAdapterState: () => ({
        adapter: 'main-canvas-2d',
        epoch: 1,
        requestedAdapter: 'worker-offscreen-2d',
      }),
    });

    await expect(capture.start(marker())).rejects.toThrow(
      'S27 condition renderer does not match the selected Ink renderer.',
    );
    expect(probeCapabilities).not.toHaveBeenCalled();
  });

  it('invalidates evidence after an away-and-back renderer transition changes the epoch', async () => {
    const frames: FrameRequestCallback[] = [];
    const disconnect = vi.fn();
    let actualRenderer: {
      adapter: 'main-canvas-2d' | 'worker-offscreen-2d';
      epoch: number;
      requestedAdapter: 'main-canvas-2d' | 'worker-offscreen-2d';
    } = { adapter: 'main-canvas-2d', epoch: 1, requestedAdapter: 'main-canvas-2d' };
    const capture = new S27PhysicalGateCapture({
      diagnostics: new InkPerformanceDiagnostics(true),
      observeLongTasks: () => ({ available: false, disconnect }),
      probeActiveWorkerCapabilities: () => Promise.resolve(activeWorkerCapabilities()),
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      selectedPresentationAdapterState: () => actualRenderer,
    });
    const starting = capture.start(marker());
    for (let index = 0; index <= 120; index += 1) {
      frames.shift()?.(index * 16.7);
      await Promise.resolve();
    }
    await starting;

    actualRenderer = {
      adapter: 'main-canvas-2d',
      epoch: 3,
      requestedAdapter: 'main-canvas-2d',
    };
    frames.shift()?.(3_000);

    expect(() => capture.finish()).toThrow(
      'S27 production renderer changed during physical Gate capture.',
    );
    expect(disconnect).toHaveBeenCalledOnce();
    expect(() => capture.finish()).toThrow(
      'S27 capture has not completed idle refresh calibration.',
    );
  });

  it('rejects a production renderer transition during idle calibration', async () => {
    const frames: FrameRequestCallback[] = [];
    const disconnect = vi.fn();
    let actualRenderer: {
      adapter: 'main-canvas-2d' | 'worker-offscreen-2d';
      epoch: number;
      requestedAdapter: 'main-canvas-2d' | 'worker-offscreen-2d';
    } = { adapter: 'main-canvas-2d', epoch: 1, requestedAdapter: 'main-canvas-2d' };
    const capture = new S27PhysicalGateCapture({
      diagnostics: new InkPerformanceDiagnostics(true),
      observeLongTasks: () => ({ available: false, disconnect }),
      probeActiveWorkerCapabilities: () => Promise.resolve(activeWorkerCapabilities()),
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      selectedPresentationAdapterState: () => actualRenderer,
    });
    const starting = capture.start(marker());
    for (let index = 0; index <= 120; index += 1) {
      if (index === 60) {
        actualRenderer = {
          adapter: 'worker-offscreen-2d',
          epoch: 2,
          requestedAdapter: 'worker-offscreen-2d',
        };
      }
      frames.shift()?.(index * 16.7);
      await Promise.resolve();
    }

    await expect(starting).rejects.toThrow(
      'S27 production renderer changed during physical Gate capture.',
    );
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

function activeWorkerCapabilities() {
  return Object.freeze({
    dedicatedWorkerConstruct: Object.freeze({
      available: true as const,
      failureCategory: 'none' as const,
    }),
    dedicatedWorkerModule: Object.freeze({
      available: true as const,
      failureCategory: 'none' as const,
    }),
    workerAnimationFrame: Object.freeze({
      available: true as const,
      failureCategory: 'none' as const,
    }),
  });
}

function marker() {
  return {
    adapter: 'pointer' as const,
    buildDigest: 'a'.repeat(64),
    conditionId: 'empty-writing',
    deviceDigest: 'd'.repeat(64),
    fixtureDigest: 'b'.repeat(64),
    presentationAdapter: 'main-canvas-2d' as const,
    protocolDigest: 'c'.repeat(64),
    runIndex: 1 as const,
    schemaVersion: 2 as const,
    tester: 'Ivan',
  };
}
