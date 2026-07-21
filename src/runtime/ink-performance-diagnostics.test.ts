import { describe, expect, it, vi } from 'vitest';

import { InkPerformanceDiagnostics } from './ink-performance-diagnostics';

describe('InkPerformanceDiagnostics', () => {
  it('retains a complete S27 condition with at least 1,000 move batches', () => {
    let now = 0;
    const diagnostics = new InkPerformanceDiagnostics(true, () => now);

    for (let index = 0; index < 1_000; index += 1) {
      const span = diagnostics.beginSpan('ink-input-handler', {
        adapter: 'pointer',
        inputPhase: 'move',
        workPhase: 'input',
      });
      now += 0.1;
      span.finish({ sampleCount: 1 });
    }

    expect(diagnostics.snapshot().distributions).toContainEqual({
      adapter: 'pointer',
      inputPhase: 'move',
      maximumMs: 0.1,
      name: 'ink-input-handler',
      p50Ms: 0.1,
      p95Ms: 0.1,
      p99Ms: 0.1,
      sampleCount: 1_000,
      workPhase: 'input',
    });
  });

  it('keeps idle heartbeat, host gaps, and active generation debt in separate lanes', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    diagnostics.recordFrameInterval(16.7, 'idle');
    diagnostics.recordFrameInterval(33.4, 'active-writing');
    diagnostics.recordFrameInterval(50.1, 'host-gap');
    diagnostics.beginSpan('ink-input-handler', { workPhase: 'input' }).finish();

    expect(diagnostics.snapshot().frameIntervalsMs).toEqual({
      activeWriting: [33.4],
      hostGaps: [50.1],
      idle: [16.7],
    });

    diagnostics.reset();

    expect(diagnostics.snapshot()).toMatchObject({
      droppedSpanCount: 0,
      distributions: [],
      forbiddenWork: [],
      frameIntervalsMs: { activeWriting: [], hostGaps: [], idle: [] },
      recentSpans: [],
      schedulerUnitCount: 0,
      schedulerUnitOverruns: [],
    });
  });

  it('retains bounded scheduler unit overruns with their priority lane', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);

    diagnostics.recordSchedulerUnit();
    diagnostics.recordSchedulerUnit();
    diagnostics.recordSchedulerUnitOverrun({
      durationMs: 1.25,
      lane: 'visible',
      unitKind: 'preview-canvas-draw',
    });
    diagnostics.recordSchedulerUnitOverrun({ durationMs: 3.5, lane: 'cold' });

    expect(diagnostics.snapshot().schedulerUnitOverruns).toEqual([
      { durationMs: 1.25, lane: 'visible', unitKind: 'preview-canvas-draw' },
      { durationMs: 3.5, lane: 'cold' },
    ]);
    expect(diagnostics.snapshot().schedulerUnitCount).toBe(2);
    expect(() =>
      diagnostics.recordSchedulerUnitOverrun({ durationMs: Number.NaN, lane: 'cold' }),
    ).toThrow(/finite positive/u);
  });

  it('reports bounded Recovery v4 entry bytes and write/encode counts', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    diagnostics
      .beginSpan('ink-recovery-journal', { workPhase: 'completion' })
      .finish({ entryBytes: 1_024, entryWriteCount: 1, historicalEncodeCount: 0 });

    expect(diagnostics.snapshot().recentSpans).toContainEqual(
      expect.objectContaining({
        entryBytes: 1_024,
        entryWriteCount: 1,
        historicalEncodeCount: 0,
        name: 'ink-recovery-journal',
      }),
    );
  });

  it('records whether a completed contact produced a document command', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    diagnostics
      .beginSpan('ink-stroke-commit', { workPhase: 'completion' })
      .finish({ documentCommandProduced: false });

    expect(diagnostics.snapshot().recentSpans).toContainEqual(
      expect.objectContaining({
        documentCommandProduced: false,
        name: 'ink-stroke-commit',
      }),
    );
  });

  it('records privacy-safe command apply and presentation spans by command kind', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);

    diagnostics
      .beginSpan('ink-command-apply', { commandKind: 'undo', workPhase: 'command' })
      .finish();
    diagnostics
      .beginSpan('ink-command-to-submit', { commandKind: 'undo', workPhase: 'command' })
      .finish({ presentationOutcome: 'submitted' });

    expect(diagnostics.snapshot().recentSpans).toEqual([
      expect.objectContaining({
        commandKind: 'undo',
        name: 'ink-command-apply',
        workPhase: 'command',
      }),
      expect.objectContaining({
        commandKind: 'undo',
        name: 'ink-command-to-submit',
        presentationOutcome: 'submitted',
        workPhase: 'command',
      }),
    ]);
    expect(diagnostics.snapshot().distributions).toEqual([
      expect.objectContaining({ commandKind: 'undo', name: 'ink-command-apply' }),
      expect.objectContaining({ commandKind: 'undo', name: 'ink-command-to-submit' }),
    ]);
  });

  it('records Done first-feedback and total spans in the save lane', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);

    diagnostics.beginSpan('ink-done-first-feedback', { workPhase: 'save' }).finish();
    diagnostics.beginSpan('ink-done-total', { workPhase: 'save' }).finish({ accepted: true });

    expect(diagnostics.snapshot().recentSpans).toEqual([
      expect.objectContaining({ name: 'ink-done-first-feedback', workPhase: 'save' }),
      expect.objectContaining({ accepted: true, name: 'ink-done-total', workPhase: 'save' }),
    ]);
  });

  it('reports unfinished spans by privacy-safe name and work phase', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const firstInk = diagnostics.beginSpan('ink-preview-first-ink', {
      workPhase: 'preview',
    });
    diagnostics.beginSpan('ink-preview-viewport-complete', { workPhase: 'preview' });
    diagnostics.beginSpan('ink-preview-first-ink', { workPhase: 'preview' });

    expect(diagnostics.snapshot()).toMatchObject({
      hangingSpanCount: 3,
      hangingSpans: [
        { count: 2, name: 'ink-preview-first-ink', workPhase: 'preview' },
        { count: 1, name: 'ink-preview-viewport-complete', workPhase: 'preview' },
      ],
    });

    firstInk.cancel();
    expect(diagnostics.snapshot()).toMatchObject({
      hangingSpanCount: 2,
      hangingSpans: [
        { count: 1, name: 'ink-preview-first-ink', workPhase: 'preview' },
        { count: 1, name: 'ink-preview-viewport-complete', workPhase: 'preview' },
      ],
    });
  });

  it('keeps Preview canonical, cache, first-pixel, and viewport stages separate', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);

    for (const name of [
      'ink-preview-canonical-observation',
      'ink-preview-cache-lookup',
      'ink-preview-cache-publish',
      'ink-preview-first-ink',
      'ink-preview-viewport-complete',
      'ink-preview-editable-hydration',
      'ink-preview-to-edit',
    ] as const) {
      diagnostics.beginSpan(name, { workPhase: 'preview' }).finish();
    }

    expect(diagnostics.snapshot().recentSpans.map(({ name }) => name)).toEqual([
      'ink-preview-canonical-observation',
      'ink-preview-cache-lookup',
      'ink-preview-cache-publish',
      'ink-preview-first-ink',
      'ink-preview-viewport-complete',
      'ink-preview-editable-hydration',
      'ink-preview-to-edit',
    ]);
  });

  it('records and validates the active presentation outcome', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    diagnostics.beginSpan('ink-input-to-submit', { workPhase: 'input' }).finish({
      batchSequence: 1,
      presentationOutcome: 'submitted',
      requestedGeneration: 7,
      submittedGeneration: 7,
    });

    expect(diagnostics.snapshot().recentSpans).toContainEqual(
      expect.objectContaining({
        name: 'ink-input-to-submit',
        batchSequence: 1,
        presentationOutcome: 'submitted',
        requestedGeneration: 7,
        submittedGeneration: 7,
      }),
    );
    expect(() =>
      diagnostics
        .beginSpan('ink-input-to-submit', { workPhase: 'input' })
        .finish({ presentationOutcome: 'painted' as never }),
    ).toThrow('Ink presentation outcome is invalid.');
    expect(() =>
      diagnostics
        .beginSpan('ink-input-to-submit', { workPhase: 'input' })
        .finish({ requestedGeneration: 0 }),
    ).toThrow('requestedGeneration must be a positive safe integer.');
  });

  it('records the privacy-safe front-loaded-parent causal repair canary', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    diagnostics
      .beginSpan('ink-input-handler', {
        adapter: 'pointer',
        inputPhase: 'move',
        workPhase: 'input',
      })
      .finish({ causalRepair: 'front-loaded-parent', sampleCount: 12 });

    expect(diagnostics.snapshot().recentSpans).toContainEqual(
      expect.objectContaining({
        causalRepair: 'front-loaded-parent',
        name: 'ink-input-handler',
        sampleCountBucket: '9-16',
      }),
    );
  });

  it('rejects authored geometry and sensor data at the diagnostics boundary', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);

    expect(() =>
      diagnostics.beginSpan('ink-input-handler', {
        pressure: 0.7,
        workPhase: 'input',
        x: 42,
      } as never),
    ).toThrow('Ink performance diagnostics accept only privacy-safe fields.');
  });

  it('reports P50, P95, and P99 for each bounded local span', () => {
    let now = 0;
    const diagnostics = new InkPerformanceDiagnostics(true, () => now);

    for (let durationMs = 1; durationMs <= 100; durationMs += 1) {
      const span = diagnostics.beginSpan('ink-frame-work', { workPhase: 'active-frame' });
      now += durationMs;
      span.finish();
    }

    expect(diagnostics.snapshot().distributions).toEqual([
      {
        maximumMs: 100,
        name: 'ink-frame-work',
        p50Ms: 50,
        p95Ms: 95,
        p99Ms: 99,
        sampleCount: 100,
        workPhase: 'active-frame',
      },
    ]);
  });

  it('is opt-in and clears all local state when disabled', () => {
    const diagnostics = new InkPerformanceDiagnostics(false, () => 10);

    diagnostics.beginSpan('ink-input-handler', { workPhase: 'input' }).finish();
    expect(diagnostics.snapshot().recentSpans).toEqual([]);

    diagnostics.setEnabled(true);
    diagnostics.beginSpan('ink-input-handler', { workPhase: 'input' }).finish();
    expect(diagnostics.snapshot().recentSpans).toHaveLength(1);

    diagnostics.setEnabled(false);
    expect(diagnostics.snapshot()).toMatchObject({
      droppedSpanCount: 0,
      distributions: [],
      forbiddenWork: [],
      hangingSpanCount: 0,
      openContactCount: 0,
      recentSpans: [],
    });
  });

  it('uses shared sentinels and performs zero disabled hot-path inspection across 1,000 batches', () => {
    const now = vi.fn(() => 10);
    const ownKeys = vi.fn(() => ['workPhase']);
    const spanInput = new Proxy({ workPhase: 'input' as const }, { ownKeys });
    const diagnostics = new InkPerformanceDiagnostics(false, now);
    const firstSpan = diagnostics.beginSpan('ink-input-handler', spanInput);
    const firstPointerContact = diagnostics.openContact('pointer');
    const firstTouchContact = diagnostics.openContact('stylus-touch');
    let reusedSpan = true;
    let reusedPointerContact = true;
    let reusedTouchContact = true;

    for (let index = 0; index < 1_000; index += 1) {
      reusedSpan &&= diagnostics.beginSpan('ink-input-handler', spanInput) === firstSpan;
      reusedPointerContact &&= diagnostics.openContact('pointer') === firstPointerContact;
      reusedTouchContact &&= diagnostics.openContact('stylus-touch') === firstTouchContact;
    }

    expect({ reusedPointerContact, reusedSpan, reusedTouchContact }).toEqual({
      reusedPointerContact: true,
      reusedSpan: true,
      reusedTouchContact: true,
    });
    expect(ownKeys).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(diagnostics.snapshot()).toMatchObject({
      hangingSpanCount: 0,
      openContactCount: 0,
      recentSpans: [],
    });
  });

  it('keeps active, disposable cache, and mandatory Canvas backing bytes separate', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);

    diagnostics.recordMemory({
      activeWorkingSetBytes: 2_000_000,
      backingStoreBytes: 12_000_000,
      disposableCacheBytes: 4_000_000,
    });

    expect(diagnostics.snapshot().memory).toEqual({
      activeWorkingSetBytes: 2_000_000,
      backingStoreBytes: 12_000_000,
      disposableCacheBytes: 4_000_000,
    });
    expect(() =>
      diagnostics.recordMemory({
        activeWorkingSetBytes: 0,
        backingStoreBytes: -1,
        disposableCacheBytes: 0,
      }),
    ).toThrow('Ink performance memory requires finite non-negative byte counts.');
  });

  it('proves hot-path audit guards are armed and only flags work observed outside the cold lane', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);

    diagnostics.armAuditGuard('canonical-cold-materialization');
    diagnostics.recordAuditedWork('canonical-encode', 'cold');
    diagnostics.recordAuditedWork('historical-copy', 'completion');

    expect(diagnostics.snapshot()).toMatchObject({
      armedAuditGuards: ['canonical-cold-materialization'],
      auditedWork: [
        { count: 1, kind: 'canonical-encode', phase: 'cold' },
        { count: 1, kind: 'historical-copy', phase: 'completion' },
      ],
      forbiddenWork: [{ count: 1, kind: 'historical-copy', phase: 'completion' }],
    });
  });

  it('supports a larger but still bounded local-Gate span window', () => {
    let now = 0;
    const diagnostics = new InkPerformanceDiagnostics(true, () => now, 3);

    for (let index = 0; index < 5; index += 1) {
      const span = diagnostics.beginSpan('ink-frame-work', { workPhase: 'active-frame' });
      now += 1;
      span.finish();
    }

    expect(diagnostics.snapshot()).toMatchObject({
      droppedSpanCount: 2,
      recentSpans: [{ durationMs: 1 }, { durationMs: 1 }, { durationMs: 1 }],
    });

    diagnostics.reset();

    expect(diagnostics.snapshot()).toMatchObject({ droppedSpanCount: 0, recentSpans: [] });
  });
});
