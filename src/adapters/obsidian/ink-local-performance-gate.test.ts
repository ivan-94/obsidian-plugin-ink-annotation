import { describe, expect, it } from 'vitest';

import {
  assertLocalPerformanceForeground,
  decodeLocalPerformanceGateRequest,
  LocalPerformanceForegroundError,
  localConditionSampleCounts,
  localDrawingConditionFailure,
  localDrawingSampleCounts,
  localDoneSampleCounts,
  localCacheLifecycleSampleCounts,
  localPerformanceSoakProgressText,
  localPreviewSampleCounts,
  localReplayDispatchMoveTarget,
  localResponsiveCommandSampleCounts,
  localViewportSampleCounts,
  prepareLocalPerformanceMeasurement,
  resetLocalPerformanceDrafts,
  restoreLocalPerformanceCheckpoint,
  runLocalPerformanceConditionWithForegroundRecovery,
  waitForLocalPerformanceFrame,
  waitForLocalPerformanceSpansToSettle,
  waitForLocalCommandPresentationFrames,
  waitForLocalResponsiveCommandScene,
  runLocalPerformanceHostHeartbeat,
  runLocalInitialFrameStringingCanary,
  runLocalReplayColdLaneYield,
  runLocalReplayFrameStep,
  runLocalSoakPace,
  runLocalViewportReplay,
} from './ink-local-performance-gate';

describe('local Obsidian performance Gate request', () => {
  it('restores only a complete digest-matched condition prefix', () => {
    const request = decodeLocalPerformanceGateRequest({
      buildDigest: 'a'.repeat(64),
      fixtureDigest: 'b'.repeat(64),
      implementationDigest: 'c'.repeat(64),
      protocolDigest: 'd'.repeat(64),
      requestId: 'resume-run',
      schemaVersion: 1,
      soakDurationMs: 300_000,
    });
    const first = {
      captureStatus: 'COMPLETE',
      diagnostics: {},
      durationMs: 1,
      fixture: 'history-10k-30-surfaces',
      id: 'history-10k-30-surfaces-pen-preview-lifecycle',
      renderRuntime: {},
      tool: 'pen',
      trace: 'preview-lifecycle',
    };
    const checkpoint = {
      buildDigest: request.buildDigest,
      conditions: [first],
      fixtureDigest: request.fixtureDigest,
      implementationDigest: request.implementationDigest,
      protocolDigest: request.protocolDigest,
      schemaVersion: 1,
    };

    expect(restoreLocalPerformanceCheckpoint(checkpoint, request)).toEqual([first]);
    expect(
      restoreLocalPerformanceCheckpoint({ ...checkpoint, buildDigest: 'e'.repeat(64) }, request),
    ).toEqual([]);
    expect(
      restoreLocalPerformanceCheckpoint(
        {
          ...checkpoint,
          conditions: [
            {
              ...first,
              id: 'history-1k-pen-mixed-drawing',
              fixture: 'history-1k',
            },
          ],
        },
        request,
      ),
    ).toEqual([]);
  });

  it('fails closed unless a full five-minute production-host request carries every digest', () => {
    expect(() =>
      decodeLocalPerformanceGateRequest({
        buildDigest: 'a'.repeat(64),
        fixtureDigest: 'b'.repeat(64),
        implementationDigest: 'd'.repeat(64),
        protocolDigest: 'c'.repeat(64),
        requestId: 'run-1',
        schemaVersion: 1,
        soakDurationMs: 299_999,
      }),
    ).toThrow('Local performance Gate soak must run for at least five minutes.');

    expect(
      decodeLocalPerformanceGateRequest({
        buildDigest: 'a'.repeat(64),
        fixtureDigest: 'b'.repeat(64),
        implementationDigest: 'd'.repeat(64),
        protocolDigest: 'c'.repeat(64),
        requestId: 'run-1',
        schemaVersion: 1,
        soakDurationMs: 300_000,
      }),
    ).toEqual({
      buildDigest: 'a'.repeat(64),
      fixtureDigest: 'b'.repeat(64),
      implementationDigest: 'd'.repeat(64),
      protocolDigest: 'c'.repeat(64),
      requestId: 'run-1',
      schemaVersion: 1,
      soakDurationMs: 300_000,
    });
  });

  it('clears legacy and current owned Draft keys before capture', async () => {
    const reset: string[] = [];

    await resetLocalPerformanceDrafts({
      discardThrough: (filePath) => {
        reset.push(filePath);
        return Promise.resolve();
      },
    });

    expect(reset).toHaveLength(35);
    expect(new Set(reset).size).toBe(35);
    expect(reset).toContain('S27R6 history-10k-30-surfaces pen writing.md');
    expect(reset).toContain('S27R6 history-10k-30-surfaces pen mixed-drawing.md');
    expect(reset).toContain('S27R6 empty mixed soak.md');
    expect(reset).toContain('S27R6 history-10k-30-surfaces pen responsive-commands.md');
    expect(reset).toContain('S27R6 empty pen done-save.md');
    expect(reset).toContain('S27R6 history-10k-30-surfaces pen preview-lifecycle.md');
  });

  it('fails the current condition immediately when replay misses the mounted Canvas', () => {
    const inputHandlers = Array.from({ length: 999 }, () => ({
      accepted: true,
      inputPhase: 'move',
      name: 'ink-input-handler',
    }));
    const commits = Array.from({ length: 100 }, () => ({
      accepted: true,
      documentCommandProduced: true,
      name: 'ink-stroke-commit',
    }));
    const idle = Array.from({ length: 120 }, () => 16.7);

    expect(
      localDrawingSampleCounts({
        frameIntervalsMs: { idle },
        recentSpans: [...inputHandlers, ...commits],
      }),
    ).toEqual({ commits: 100, idle: 120, moves: 999, passed: false });

    expect(
      localDrawingSampleCounts({
        frameIntervalsMs: { idle },
        recentSpans: [
          ...inputHandlers,
          { accepted: true, inputPhase: 'move', name: 'ink-input-handler' },
          ...commits,
        ],
      }),
    ).toEqual({ commits: 100, idle: 120, moves: 1_000, passed: true });
  });

  it('dispatches bounded headroom without lowering the accepted move sample minimum', () => {
    expect(localReplayDispatchMoveTarget(1_000)).toBe(1_020);
    expect(localReplayDispatchMoveTarget(200)).toBe(220);
  });

  it('waits for command application and its following presentation opportunity', async () => {
    let frameCount = 0;
    await waitForLocalCommandPresentationFrames(() => {
      frameCount += 1;
      return Promise.resolve();
    });
    expect(frameCount).toBe(2);
  });

  it('does not begin responsive command sampling before the first exact Edit scene', async () => {
    let frameCount = 0;
    await waitForLocalResponsiveCommandScene({
      readVisibleRecoveryCount: () => (frameCount >= 3 ? 1 : 0),
      waitForFrame: () => {
        frameCount += 1;
        return Promise.resolve();
      },
    });

    expect(frameCount).toBe(3);
  });

  it('uses the fixed replay size of each non-drawing condition', () => {
    const inputHandlers = Array.from({ length: 200 }, () => ({
      accepted: true,
      inputPhase: 'move',
      name: 'ink-input-handler',
    }));
    const commits = Array.from({ length: 20 }, () => ({
      accepted: true,
      documentCommandProduced: true,
      name: 'ink-stroke-commit',
    }));
    const viewport = Array.from({ length: 5 }, () => ({
      accepted: true,
      name: 'ink-viewport-redraw',
    }));
    const idle = Array.from({ length: 120 }, () => 16.7);
    const base = {
      frameIntervalsMs: { idle },
      recentSpans: [...inputHandlers, ...commits],
    };

    expect(localCacheLifecycleSampleCounts(base)).toEqual({
      commits: 20,
      idle: 120,
      moves: 200,
      passed: true,
    });
    expect(
      localViewportSampleCounts({
        ...base,
        recentSpans: [...base.recentSpans, ...viewport.slice(0, 1)],
      }),
    ).toEqual({ commits: 20, idle: 120, moves: 200, passed: true, viewport: 1 });
    expect(
      localViewportSampleCounts({
        ...base,
        recentSpans: base.recentSpans,
      }).passed,
    ).toBe(false);
    expect(
      localViewportSampleCounts({
        frameIntervalsMs: { idle },
        recentSpans: viewport,
      }).passed,
    ).toBe(true);
    expect(localConditionSampleCounts('cache-lifecycle', base).passed).toBe(true);
    expect(
      localConditionSampleCounts('viewport', {
        ...base,
        recentSpans: [...base.recentSpans, ...viewport],
      }).passed,
    ).toBe(true);
    expect(localConditionSampleCounts('mixed-drawing', base).passed).toBe(false);
  });

  it('requires complete command, Done, and Preview stage coverage', () => {
    const idle = Array.from({ length: 120 }, () => 16.7);
    const commandKinds = [
      'delete-selection',
      'erase',
      'move',
      'restyle',
      'selection',
      ...Array.from({ length: 50 }, () => ['undo', 'redo']).flat(),
    ];
    const commandSpans = commandKinds.flatMap((commandKind) => [
      { accepted: true, commandKind, name: 'ink-command-apply' },
      { accepted: true, commandKind, name: 'ink-command-to-submit' },
    ]);
    expect(
      localResponsiveCommandSampleCounts({
        frameIntervalsMs: { idle },
        recentSpans: commandSpans,
      }),
    ).toMatchObject({ passed: true, undoRedo: 100 });
    expect(
      localDoneSampleCounts({
        frameIntervalsMs: { idle },
        recentSpans: [
          { accepted: true, name: 'ink-done-first-feedback' },
          { accepted: true, name: 'ink-done-total' },
        ],
      }),
    ).toMatchObject({ passed: true });
    expect(
      localPreviewSampleCounts({
        frameIntervalsMs: { idle },
        recentSpans: [
          { accepted: false, name: 'ink-preview-cache-lookup' },
          { accepted: true, name: 'ink-preview-cache-publish' },
          { name: 'ink-preview-first-ink' },
          { name: 'ink-preview-viewport-complete' },
          { name: 'ink-preview-editable-hydration' },
          { name: 'ink-preview-to-edit' },
          { accepted: true, name: 'ink-preview-cache-lookup' },
          { name: 'ink-preview-first-ink' },
          { name: 'ink-preview-viewport-complete' },
        ],
      }),
    ).toMatchObject({ passed: true });
  });

  it('rejects background or hidden host samples before they contaminate performance budgets', () => {
    expect(() =>
      assertLocalPerformanceForeground({ hasFocus: () => false, hidden: false }),
    ).toThrow('foreground');
    expect(() => assertLocalPerformanceForeground({ hasFocus: () => true, hidden: true })).toThrow(
      'foreground',
    );
    expect(() =>
      assertLocalPerformanceForeground({ hasFocus: () => true, hidden: false }),
    ).not.toThrow();
  });

  it('discards an interrupted condition and reruns it only after foreground recovery', async () => {
    const calls: string[] = [];
    let attemptCount = 0;

    await expect(
      runLocalPerformanceConditionWithForegroundRecovery({
        maximumAttempts: 3,
        onFocusRequired: (attempt) => {
          calls.push(`focus-required:${attempt}`);
          return Promise.resolve();
        },
        run: () => {
          attemptCount += 1;
          calls.push(`run:${attemptCount}`);
          if (attemptCount === 1) {
            assertLocalPerformanceForeground({ hasFocus: () => false, hidden: false });
          }
          return Promise.resolve('clean-condition');
        },
        waitForForeground: () => {
          calls.push('wait-foreground');
          return Promise.resolve();
        },
      }),
    ).resolves.toBe('clean-condition');
    expect(calls).toEqual(['run:1', 'focus-required:1', 'wait-foreground', 'run:2']);
  });

  it('preserves the replay failure instead of relabeling it as a sample timeout', () => {
    expect(
      localDrawingConditionFailure({
        captureStatus: 'TIMEOUT',
        id: 'history-10k-30-surfaces-pen-rapid-lift',
        replay: { failure: 'Local Obsidian Performance Gate requires foreground.' },
      }),
    ).toBe(
      'history-10k-30-surfaces-pen-rapid-lift replay failed: Local Obsidian Performance Gate requires foreground.',
    );
  });

  it('delivers each deterministic replay batch once and waits for its presentation frame', async () => {
    const order: string[] = [];

    await runLocalReplayFrameStep({
      dispatch: () => order.push('dispatch'),
      waitForFrame: () => {
        order.push('frame');
        return Promise.resolve();
      },
    });

    expect(order).toEqual(['dispatch', 'frame']);
  });

  it('turns a suspended animation frame into a recoverable foreground interruption', async () => {
    const timeouts: Array<() => void> = [];
    const cancelled: number[] = [];
    const waiting = waitForLocalPerformanceFrame({
      cancelFrame: (handle) => cancelled.push(handle),
      clearTimeout: () => undefined,
      documentState: { hasFocus: () => false, hidden: false },
      requestFrame: () => 42,
      scheduleTimeout: (callback) => {
        timeouts.push(callback);
        return 7;
      },
      timeoutMs: 1_000,
    });

    timeouts[0]?.();

    await expect(waiting).rejects.toBeInstanceOf(LocalPerformanceForegroundError);
    expect(cancelled).toEqual([42]);
  });

  it('replays down and a front-loaded-parent curve before the delayed first frame', async () => {
    const order: string[] = [];

    await runLocalInitialFrameStringingCanary({
      dispatchDown: () => order.push('down'),
      dispatchMove: () => order.push('move'),
      waitForFrame: () => {
        order.push('frame');
        return Promise.resolve();
      },
      waitForPhase: (durationMs) => {
        order.push(`phase:${durationMs}`);
        return Promise.resolve();
      },
    });

    expect(order).toEqual(['frame', 'phase:2', 'down', 'move', 'frame']);
  });

  it('opens one former-debounce idle canary without repeating it in every cohort', async () => {
    const waits: number[] = [];

    await runLocalReplayColdLaneYield(9, (durationMs) => {
      waits.push(durationMs);
      return Promise.resolve();
    });
    await runLocalReplayColdLaneYield(10, (durationMs) => {
      waits.push(durationMs);
      return Promise.resolve();
    });
    await runLocalReplayColdLaneYield(50, (durationMs) => {
      waits.push(durationMs);
      return Promise.resolve();
    });

    expect(waits).toEqual([600]);
  });

  it('paces the five-minute soak below the bounded diagnostics capacity', async () => {
    const waits: number[] = [];

    await runLocalSoakPace((durationMs) => {
      waits.push(durationMs);
      return Promise.resolve();
    });

    expect(waits).toEqual([400]);
  });

  it('reports soak elapsed time and stroke progress without implying a visual hang', () => {
    expect(localPerformanceSoakProgressText(65_400, 237, 300_000)).toBe(
      'Local Gate soak 01:05 / 05:00 · 237 strokes · Pen/Highlighter switch every 10',
    );
  });

  it('waits for asynchronous Done spans to settle before taking the condition snapshot', async () => {
    const hangingCounts = [3, 1, 0];
    let yields = 0;

    await waitForLocalPerformanceSpansToSettle({
      snapshot: () => ({ hangingSpanCount: hangingCounts.shift() ?? 0 }),
      waitForSettlement: () => {
        yields += 1;
        return Promise.resolve();
      },
    });

    expect(yields).toBe(2);
  });

  it('does not make Done wait for an unrelated best-effort Preview span', async () => {
    let yields = 0;
    await waitForLocalPerformanceSpansToSettle({
      isSettled: (snapshot) => localDoneSampleCounts(snapshot).passed,
      snapshot: () => ({
        frameIntervalsMs: { idle: Array.from({ length: 120 }, () => 8.3) },
        hangingSpanCount: 1,
        recentSpans: [
          { accepted: true, name: 'ink-done-first-feedback' },
          { accepted: true, name: 'ink-done-total' },
        ],
      }),
      waitForSettlement: () => {
        yields += 1;
        return Promise.resolve();
      },
    });

    expect(yields).toBe(0);
  });

  it('fails a Done condition whose asynchronous spans never settle', async () => {
    await expect(
      waitForLocalPerformanceSpansToSettle({
        maximumAttempts: 2,
        snapshot: () => ({ hangingSpanCount: 1 }),
        waitForSettlement: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/did not settle/u);
  });

  it('records host heartbeat gaps during the real-host condition', () => {
    const callbacks: FrameRequestCallback[] = [];
    const cancelled: number[] = [];
    const intervals: Array<{ durationMs: number; phase: string }> = [];
    const stop = runLocalPerformanceHostHeartbeat({
      cancelFrame: (handle) => cancelled.push(handle),
      diagnostics: {
        recordFrameInterval: (durationMs, phase) => intervals.push({ durationMs, phase }),
      },
      requestFrame: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
    });

    callbacks[0]?.(100);
    callbacks[1]?.(116.7);
    expect(intervals).toEqual([{ durationMs: 16.7, phase: 'host-gap' }]);
    stop();
    expect(cancelled).toEqual([3]);
  });

  it('covers both scrolling and workspace zoom in the viewport replay', async () => {
    const scrolls: number[] = [];
    const zooms: string[] = [];
    const zoomFrames: number[] = [];
    const phases: string[] = [];

    await runLocalViewportReplay({
      cycleCount: 120,
      scroll: (index) => scrolls.push(index),
      waitForFrame: () => {
        phases.push('frame');
        return Promise.resolve();
      },
      waitForQuiescence: () => {
        phases.push('quiescent');
        return Promise.resolve();
      },
      waitForSettle: () => {
        phases.push('settle');
        return Promise.resolve();
      },
      zoomIn: () => {
        zooms.push('in');
        zoomFrames.push(phases.length);
      },
      zoomOut: () => {
        zooms.push('out');
        zoomFrames.push(phases.length);
      },
    });

    expect(scrolls).toHaveLength(120);
    expect(zooms).toEqual(['in', 'out', 'in', 'out']);
    expect(zoomFrames).toEqual([5, 5, 5, 5]);
    expect(phases).toEqual([
      'frame',
      'frame',
      'frame',
      'frame',
      'frame',
      'frame',
      'settle',
      'quiescent',
    ]);
  });

  it('finishes real cold-path warmup before resetting steady-state diagnostics', async () => {
    const order: string[] = [];

    await prepareLocalPerformanceMeasurement({
      calibrateIdleFrames: () => {
        order.push('calibrate');
        return Promise.resolve();
      },
      flushPersistence: () => {
        order.push('flush');
        return Promise.resolve();
      },
      resetDiagnostics: () => order.push('reset'),
      waitForPersistence: () => {
        order.push('persisted');
        return Promise.resolve();
      },
      waitForReady: () => {
        order.push('ready');
        return Promise.resolve();
      },
      warmup: () => {
        order.push('warmup');
        return Promise.resolve();
      },
    });

    expect(order).toEqual(['warmup', 'flush', 'persisted', 'ready', 'reset', 'calibrate', 'ready']);
  });
});
