/* eslint-disable @typescript-eslint/no-unsafe-member-access -- The JavaScript analyzer validates its untyped capture boundary. */

import { createHash } from 'node:crypto';
import type { spawn as spawnChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  analyzeLocalObsidianCapture,
  armLocalObsidianCaptureAfterForeground,
  assertCurrentLocalObsidianPass,
  computePreparedFixtureDigest,
  renderLocalObsidianSourceManifest,
  recoverLocalObsidianForegroundIfRequested,
  requestObsidianVaultReload,
  startLocalGateWakeLock,
} from './ink-local-obsidian-performance-gate.mjs';
import { resetOwnedConditionSidecar } from './prepare-ink-performance-hat.mjs';

describe('S27R6 Local Obsidian Performance Gate', () => {
  it('keeps the prepared fixture digest stable across regenerated timestamps', () => {
    const first = {
      conditions: [{ name: 'empty', strokeCount: 0 }],
      generatedAt: '2026-07-20T00:00:00.000Z',
      localGateConditions: [{ name: 'local-empty' }],
      schemaVersion: 1,
    };

    expect(computePreparedFixtureDigest(first)).toBe(
      computePreparedFixtureDigest({ ...first, generatedAt: '2026-07-20T01:00:00.000Z' }),
    );
    expect(computePreparedFixtureDigest(first)).not.toBe(
      computePreparedFixtureDigest({
        ...first,
        conditions: [{ name: 'empty', strokeCount: 1 }],
      }),
    );
  });

  it('keeps the capture request absent until the owned Obsidian Vault is foreground', async () => {
    const calls: string[] = [];

    await armLocalObsidianCaptureAfterForeground({
      activateForeground: () => {
        calls.push('activate');
        return Promise.resolve();
      },
      clearRequest: () => {
        calls.push('clear-request');
        return Promise.resolve();
      },
      launchUnarmedVault: () => {
        calls.push('launch-unarmed');
        return Promise.resolve();
      },
      reloadArmedVault: () => {
        calls.push('reload-armed');
        return Promise.resolve();
      },
      waitForActiveVault: () => {
        calls.push('wait-active');
        return Promise.resolve();
      },
      writeRequest: () => {
        calls.push('write-request');
        return Promise.resolve();
      },
    });

    expect(calls).toEqual([
      'clear-request',
      'launch-unarmed',
      'activate',
      'write-request',
      'reload-armed',
      'wait-active',
      'activate',
    ]);
  });

  it('continues after a reload request is delivered even when the Obsidian CLI never exits', async () => {
    const calls: unknown[][] = [];
    await expect(
      requestObsidianVaultReload('vault', {
        executeReload: ((...args: unknown[]) => {
          calls.push(args);
          return Promise.reject(
            Object.assign(new Error('reload timed out'), {
              killed: true,
              signal: 'SIGKILL',
            }),
          );
        }) as never,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      [
        '/usr/local/bin/obsidian',
        ['reload', 'vault=vault'],
        { killSignal: 'SIGKILL', timeout: 5_000 },
      ],
    ]);
  });

  it('reactivates Obsidian when the renderer pauses an invalidated condition for focus', async () => {
    let activationCount = 0;

    await expect(
      recoverLocalObsidianForegroundIfRequested({ status: 'FOCUS_REQUIRED' }, () => {
        activationCount += 1;
        return Promise.resolve();
      }),
    ).resolves.toBe(true);
    await expect(
      recoverLocalObsidianForegroundIfRequested({ status: 'RUNNING' }, () => {
        activationCount += 1;
        return Promise.resolve();
      }),
    ).resolves.toBe(false);
    expect(activationCount).toBe(1);
  });

  it('holds display and idle-sleep assertions for the complete real-host command', () => {
    const calls: unknown[][] = [];
    let unrefCount = 0;
    let killCount = 0;

    const release = startLocalGateWakeLock({
      pid: 321,
      spawnProcess: ((...args: unknown[]) => {
        calls.push(args);
        return {
          kill: () => {
            killCount += 1;
          },
          unref: () => {
            unrefCount += 1;
          },
        };
      }) as unknown as typeof spawnChildProcess,
    });

    expect(calls).toEqual([['/usr/bin/caffeinate', ['-di', '-w', '321'], { stdio: 'ignore' }]]);
    expect(unrefCount).toBe(1);
    release();
    expect(killCount).toBe(1);
  });

  it('accepts a complete real-Obsidian capture only when every frozen local budget passes', () => {
    const result = analyzeLocalObsidianCapture(validCapture());

    expect(result).toMatchObject({
      automatedVerdict: 'PASS',
      buildDigest: 'a'.repeat(64),
      command: 'npm run gate:ink-local-obsidian',
      protocolDigest: 'b'.repeat(64),
      schemaVersion: 1,
    });
    expect(result.budgets.every((budget) => budget.status === 'PASS')).toBe(true);
    expect(result.strokeWindows[0]).toMatchObject({ endStroke: 10, startStroke: 1 });
  });

  it('fails closed when any measured condition retains an unfinished performance span', () => {
    const capture = validCapture();
    const first = capture.conditions[0];
    if (first === undefined) throw new Error('Missing local Gate condition fixture.');
    first.diagnostics.hangingSpanCount = 1;

    expect(
      analyzeLocalObsidianCapture(capture).budgets.find(
        (budget) => budget.name === 'hanging-span-count',
      ),
    ).toMatchObject({ actual: 1, limit: 0, status: 'FAIL' });
  });

  it('fails closed when a measured input contact remains open', () => {
    const capture = validCapture();
    capture.soak.diagnostics.openContactCount = 1;

    expect(
      analyzeLocalObsidianCapture(capture).budgets.find(
        (budget) => budget.name === 'open-contact-count',
      ),
    ).toMatchObject({ actual: 1, limit: 0, status: 'FAIL' });
  });

  it('fails closed when bounded diagnostics dropped any performance span', () => {
    const capture = validCapture();
    const first = capture.conditions[0];
    if (first === undefined) throw new Error('Missing local Gate condition fixture.');
    first.diagnostics.droppedSpanCount = 1;

    expect(
      analyzeLocalObsidianCapture(capture).budgets.find(
        (budget) => budget.name === 'dropped-span-count',
      ),
    ).toMatchObject({ actual: 1, limit: 0, status: 'FAIL' });
  });

  it('fails closed when an accepted move or submit contains zero new samples', () => {
    const capture = validCapture();
    const first = capture.conditions[0];
    if (first === undefined) throw new Error('Missing local Gate condition fixture.');
    first.diagnostics.recentSpans.push(
      {
        accepted: true,
        durationMs: 0,
        inputPhase: 'move',
        name: 'ink-input-handler',
        sampleCountBucket: '0',
        workPhase: 'input',
      } as never,
      {
        accepted: true,
        durationMs: 0,
        inputPhase: 'move',
        name: 'ink-input-to-submit',
        presentationOutcome: 'submitted',
        requestedGeneration: 1,
        sampleCountBucket: '0',
        submittedGeneration: 1,
        workPhase: 'input',
      } as never,
    );

    expect(
      analyzeLocalObsidianCapture(capture).budgets.find(
        (budget) => budget.name === 'accepted-zero-sample-move-count',
      ),
    ).toMatchObject({ actual: 2, limit: 0, status: 'FAIL' });
  });

  it('requires the delayed-first-frame front-loaded-parent stringing canary in every condition', () => {
    const capture = validCapture();
    const first = capture.conditions[0];
    if (first === undefined) throw new Error('Missing local Gate condition fixture.');
    for (const span of first.diagnostics.recentSpans) {
      delete (span as { causalRepair?: string }).causalRepair;
    }

    expect(
      analyzeLocalObsidianCapture(capture).budgets.find(
        (budget) => budget.name === 'initial-frame-stringing-canary',
      ),
    ).toMatchObject({ status: 'FAIL' });
  });

  it('fails when ordinary drawing triggers a visible recovery rebuild or backing mutation', () => {
    const capture = validCapture();
    const first = capture.conditions[0];
    if (first === undefined) throw new Error('Missing local Gate condition fixture.');
    first.renderRuntime.after.visibleRecoveryRebuildCount += 1;
    first.renderRuntime.after.backingStoreDimensionMutationCount += 1;

    const budgets = analyzeLocalObsidianCapture(capture).budgets;
    expect(
      budgets.find((budget) => budget.name === 'ordinary-drawing-visible-recovery-rebuild-count'),
    ).toMatchObject({ status: 'FAIL' });
    expect(
      budgets.find((budget) => budget.name === 'ordinary-drawing-backing-dimension-mutation-count'),
    ).toMatchObject({ status: 'FAIL' });
  });

  it('fails on unclassified recovery or committed raster memory beyond 1.5 viewport areas', () => {
    const capture = validCapture();
    const first = capture.conditions[0];
    if (first === undefined) throw new Error('Missing local Gate condition fixture.');
    first.renderRuntime.after.visibleRecoveryRebuildReason = 'unclassified-document-change';
    first.renderRuntime.after.rasterTileBytes = 5_000_000;

    const budgets = analyzeLocalObsidianCapture(capture).budgets;
    expect(
      budgets.find((budget) => budget.name === 'unclassified-visible-recovery-rebuild-count'),
    ).toMatchObject({ status: 'FAIL' });
    expect(budgets.find((budget) => budget.name === 'committed-raster-tile-memory')).toMatchObject({
      status: 'FAIL',
    });
  });

  it('renders a reproducible Source Manifest with command, artifacts, verdict, and open boundary', () => {
    const manifest = renderLocalObsidianSourceManifest({
      automatedVerdict: 'PASS',
      buildDigest: 'a'.repeat(64),
      evidenceRoot: '/owned/evidence',
      fixtureDigest: 'b'.repeat(64),
      implementationDigest: 'c'.repeat(64),
      protocolDigest: 'd'.repeat(64),
      requestId: 'local-test',
      storedRawPath: '/owned/evidence/raw/local-test.json',
      vaultRoot: '/owned/vault',
    });

    expect(manifest).toContain('## Produced artifacts');
    expect(manifest).toContain('## Verification evidence');
    expect(manifest).toContain('## Open questions / risks');
    expect(manifest).toContain('`npm run gate:ink-local-obsidian`');
    expect(manifest).toContain('Verdict: `PASS`');
  });

  it('turns a timed-out incremental real-host capture into durable FAIL evidence', () => {
    const complete = validCapture();
    const partial = {
      ...complete,
      captureStatus: 'PARTIAL',
      conditions: [
        {
          ...condition(
            'history-10k-30-surfaces-pen-writing',
            'history-10k-30-surfaces',
            'pen',
            'writing',
          ),
          captureStatus: 'TIMEOUT',
          durationMs: 90_000,
        },
      ],
      failure: {
        conditionId: 'history-10k-30-surfaces-pen-writing',
        message: 'Condition exceeded 90000 ms.',
      },
      soak: null,
    };

    const result = analyzeLocalObsidianCapture(partial);

    expect(result.automatedVerdict).toBe('FAIL');
    expect(result.budgets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'condition-completion', status: 'FAIL' }),
        expect.objectContaining({ name: 'coverage', status: 'FAIL' }),
        expect.objectContaining({ name: 'sample-minimums', status: 'FAIL' }),
        expect.objectContaining({ name: 'five-minute-growing-history-soak', status: 'FAIL' }),
      ]),
    );
  });

  it('rejects storage work in both input and completion hot paths', () => {
    const completionCapture = validCapture();
    for (const condition of completionCapture.conditions) {
      condition.diagnostics.forbiddenWork = [
        { count: 100, kind: 'recovery-storage-write', phase: 'completion' } as never,
      ];
    }
    expect(
      analyzeLocalObsidianCapture(completionCapture).budgets.find(
        (budget) => budget.name === 'forbidden-hot-path-work',
      ),
    ).toMatchObject({ status: 'FAIL' });

    const first = completionCapture.conditions[0];
    if (first === undefined) throw new Error('Missing local Gate condition fixture.');
    first.diagnostics.forbiddenWork = [
      { count: 1, kind: 'recovery-storage-write', phase: 'input' } as never,
    ];
    expect(
      analyzeLocalObsidianCapture(completionCapture).budgets.find(
        (budget) => budget.name === 'forbidden-hot-path-work',
      ),
    ).toMatchObject({ status: 'FAIL' });
  });

  it('fails closed when the production hot-path guards are not observed', () => {
    const missingGuard = validCapture();
    for (const condition of missingGuard.conditions) {
      condition.diagnostics.armedAuditGuards = ['canonical-cold-materialization'];
    }
    missingGuard.soak.diagnostics.armedAuditGuards = ['canonical-cold-materialization'];
    expect(
      analyzeLocalObsidianCapture(missingGuard).budgets.find(
        (budget) => budget.name === 'hot-path-audit-coverage',
      ),
    ).toMatchObject({ status: 'FAIL' });
  });

  it('rejects canonical persistence submission during a foreground measurement window', () => {
    const capture = validCapture();
    capture.conditions[0]?.diagnostics.recentSpans.push({
      accepted: true,
      durationMs: 1,
      name: 'ink-canonical-persistence-submit',
      workPhase: 'cold',
    } as never);

    expect(analyzeLocalObsidianCapture(capture).budgets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'foreground-canonical-persistence-submit-count',
          status: 'FAIL',
        }),
      ]),
    );
  });

  it('rejects a viewport rebuild attributed to an active Pencil contact', () => {
    const capture = validCapture();
    const viewport = capture.conditions.find((condition) => condition.trace === 'viewport');
    if (viewport === undefined) throw new Error('Missing viewport condition fixture.');
    viewport.diagnostics.recentSpans.push({
      accepted: true,
      contactSequence: 1,
      durationMs: 4,
      name: 'ink-viewport-redraw',
      viewportResultCount: 100,
      workPhase: 'viewport',
    } as never);

    expect(
      analyzeLocalObsidianCapture(capture).budgets.find(
        (budget) => budget.name === 'active-contact-viewport-redraw-count',
      ),
    ).toMatchObject({ actual: 1, status: 'FAIL' });
  });

  it('fails closed when capture provenance does not declare the explicit-commit architecture', () => {
    const capture = validCapture();
    capture.persistenceArchitecture = 'retired-recovery-journal';

    expect(() => analyzeLocalObsidianCapture(capture)).toThrow('malformed soak evidence');
  });

  it('computes missed frames from pending active-frame debt rather than input span duration', () => {
    const capture = validCapture();
    for (const condition of capture.conditions) {
      condition.diagnostics.recentSpans = condition.diagnostics.recentSpans.map((span) =>
        span.name === 'ink-input-to-submit' ? { ...span, durationMs: 20 } : span,
      );
      condition.diagnostics.frameIntervalsMs.activeWriting = Array.from(
        { length: 1_000 },
        () => 16,
      );
    }

    expect(
      analyzeLocalObsidianCapture(capture).budgets.find(
        (budget) => budget.name === 'pending-work-missed-frame-ratio',
      ),
    ).toMatchObject({ status: 'PASS' });
  });

  it('does not count normal rAF phase jitter as a missed pending-work frame', () => {
    const capture = validCapture();
    for (const condition of capture.conditions) {
      condition.diagnostics.frameIntervalsMs.idle = Array.from({ length: 120 }, () => 8.3);
      condition.diagnostics.frameIntervalsMs.activeWriting = Array.from(
        { length: 1_000 },
        () => 9.9,
      );
    }

    expect(
      analyzeLocalObsidianCapture(capture).budgets.find(
        (budget) => budget.name === 'pending-work-missed-frame-ratio',
      ),
    ).toMatchObject({
      actual: { expectedSlots: 10_000, missedSlots: 0, ratio: 0 },
      status: 'PASS',
    });
  });

  it('fails a fifty-millisecond pending-work gap but only reports an idle host heartbeat gap', () => {
    const idleGapCapture = validCapture();
    const idleGapCondition = idleGapCapture.conditions[0];
    if (idleGapCondition === undefined) throw new Error('Missing local Gate condition fixture.');
    idleGapCondition.diagnostics.frameIntervalsMs.hostGaps = [8.3, 66.8, 8.3] as never[];
    const idleGapResult = analyzeLocalObsidianCapture(idleGapCapture);
    expect(
      idleGapResult.budgets.find((budget) => budget.name === 'pending-work-gaps-gte-50ms'),
    ).toMatchObject({ actual: 0, status: 'PASS' });
    expect(idleGapResult.hostHeartbeat).toMatchObject({
      gapCountGte50Ms: 1,
      maximumMs: 66.8,
    });

    const pendingGapCapture = validCapture();
    const pendingGapCondition = pendingGapCapture.conditions[0];
    if (pendingGapCondition === undefined) throw new Error('Missing local Gate condition fixture.');
    pendingGapCondition.diagnostics.frameIntervalsMs.activeWriting = [8.3, 50, 8.3];
    expect(
      analyzeLocalObsidianCapture(pendingGapCapture).budgets.find(
        (budget) => budget.name === 'pending-work-gaps-gte-50ms',
      ),
    ).toMatchObject({ actual: 1, status: 'FAIL' });
  });

  it('does not call one isolated ten-stroke tail spike a growing-history regression', () => {
    const capture = validCapture();
    const lastContact = capture.soak.strokeCount;
    capture.soak.diagnostics.recentSpans = capture.soak.diagnostics.recentSpans.map((span) =>
      span.name === 'ink-input-to-submit' && span.contactSequence === lastContact
        ? { ...span, durationMs: 12 }
        : span,
    );

    expect(
      analyzeLocalObsidianCapture(capture).budgets.find(
        (budget) => budget.name === 'growing-history-windows',
      ),
    ).toMatchObject({ status: 'PASS' });
  });

  it('rejects a sustained early-to-late growing-history slope', () => {
    const capture = validCapture();
    capture.soak.diagnostics.recentSpans = capture.soak.diagnostics.recentSpans.map((span) =>
      span.name === 'ink-input-to-submit' && span.contactSequence !== undefined
        ? { ...span, durationMs: 8 + span.contactSequence / 20 }
        : span,
    );

    expect(
      analyzeLocalObsidianCapture(capture).budgets.find(
        (budget) => budget.name === 'growing-history-windows',
      ),
    ).toMatchObject({ status: 'FAIL' });
  });

  it('blocks every iPad marker when the current local PASS artifact is missing', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27r6-missing-'));

    await expect(assertCurrentLocalObsidianPass({ projectRoot })).rejects.toThrow(
      'S27R6 Local Obsidian Performance Gate PASS is required before iPad capture.',
    );
  });

  it('removes every stale artifact for an owned condition without touching another note', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27r6-reset-'));
    const filePath = 'S27R6 history-10k-30-surfaces pen writing.md';
    const noteRoot = join(
      vaultRoot,
      '.obsidian-annotations',
      'v1',
      'notes',
      createHash('sha256').update(filePath).digest('hex'),
    );
    const unrelatedRoot = join(vaultRoot, '.obsidian-annotations', 'v1', 'notes', 'unrelated');
    await Promise.all([
      mkdir(join(noteRoot, 'recovery'), { recursive: true }),
      mkdir(unrelatedRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(noteRoot, 'ink-summaries.json'), '{"stale":true}\n'),
      writeFile(join(noteRoot, 'recovery', 'base.json'), '{"schemaVersion":3}\n'),
      writeFile(join(unrelatedRoot, 'meta.json'), '{"owned":false}\n'),
    ]);

    await resetOwnedConditionSidecar(vaultRoot, filePath);

    await expect(readFile(join(noteRoot, 'ink-summaries.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(noteRoot, 'recovery', 'base.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(unrelatedRoot, 'meta.json'), 'utf8')).resolves.toContain(
      '"owned":false',
    );
  });
});

function validCapture() {
  const conditions = [];
  for (const fixture of ['empty', 'history-1k', 'history-10k-30-surfaces']) {
    for (const tool of ['pen', 'highlighter']) {
      conditions.push(
        condition(`${fixture}-${tool}-mixed-drawing`, fixture, tool, 'mixed-drawing'),
      );
    }
  }
  for (const tool of ['pen', 'highlighter']) {
    conditions.push(
      condition(`history-10k-${tool}-viewport`, 'history-10k-30-surfaces', tool, 'viewport'),
      condition(
        `history-10k-${tool}-cache-lifecycle`,
        'history-10k-30-surfaces',
        tool,
        'cache-lifecycle',
      ),
    );
  }
  return {
    buildDigest: 'a'.repeat(64),
    conditions,
    fixtureDigest: 'c'.repeat(64),
    generatedAt: '2026-07-18T00:00:00.000Z',
    host: {
      kind: 'obsidian-desktop',
      productionCanvas: true,
      version: '1.9.12',
    },
    implementationDigest: 'd'.repeat(64),
    persistenceArchitecture: 'explicit-commit-memory-first-cold-canonical',
    protocolDigest: 'b'.repeat(64),
    schemaVersion: 1,
    soak: {
      durationMs: 300_000,
      diagnostics: diagnostics(120, 1_000),
      renderRuntime: renderRuntimeEvidence('soak'),
      strokeCount: 120,
      tools: ['pen', 'highlighter'],
    },
  };
}

function condition(id: string, fixture: string, tool: string, trace: string) {
  const drawing = trace === 'mixed-drawing';
  return {
    diagnostics: diagnostics(drawing ? 100 : 20, drawing ? 1_000 : 200, trace === 'viewport'),
    durationMs: 30_000,
    fixture,
    id,
    renderRuntime: renderRuntimeEvidence(trace),
    tool,
    trace,
  };
}

function renderRuntimeEvidence(trace: string) {
  const before = renderRuntimeStats();
  return {
    after: {
      ...before,
      committedCompileCount: before.committedCompileCount + 100,
      rasterTileMisses: before.rasterTileMisses + 10,
      rasterTileRebuildCount: before.rasterTileRebuildCount + 10,
      visibleRecoveryRebuildCount:
        before.visibleRecoveryRebuildCount + (trace === 'viewport' ? 5 : 0),
      visibleRecoveryRebuildReason:
        trace === 'viewport' ? 'settled-projection' : before.visibleRecoveryRebuildReason,
    },
    before,
  };
}

function renderRuntimeStats() {
  return {
    backingStoreBytes: 8_000_000,
    backingStoreCount: 3,
    backingStoreDimensionMutationCount: 6,
    committedCompileCount: 100,
    compositorLayerCount: 3,
    rasterTileBytes: 2_000_000,
    rasterTileCount: 12,
    rasterTileEvictions: 0,
    rasterTileHits: 100,
    rasterTileMisses: 12,
    rasterTileRebuildCount: 12,
    visibleRecoveryRebuildCount: 1,
    visibleRecoveryRebuildReason: 'initial-document-install',
  };
}

function diagnostics(strokeCount: number, moveCount: number, viewport = false) {
  const recentSpans = [];
  let generation = 1;
  for (let stroke = 1; stroke <= strokeCount; stroke += 1) {
    const moves = Math.ceil(moveCount / strokeCount);
    for (let move = 1; move <= moves; move += 1) {
      recentSpans.push(
        {
          accepted: true,
          adapter: 'pointer',
          batchSequence: move,
          ...(move === 1 ? { causalRepair: 'front-loaded-parent' } : {}),
          contactSequence: stroke,
          durationMs: 1,
          inputPhase: 'move',
          name: 'ink-input-handler',
          workPhase: 'input',
        },
        {
          accepted: true,
          adapter: 'pointer',
          batchSequence: move,
          contactSequence: stroke,
          durationMs: 8,
          inputPhase: 'move',
          name: 'ink-input-to-submit',
          presentationOutcome: 'submitted',
          requestedGeneration: generation,
          submittedGeneration: generation,
          workPhase: 'input',
        },
        {
          accepted: true,
          contactSequence: stroke,
          durationMs: 4,
          name: 'ink-frame-work',
          workPhase: 'active-frame',
        },
      );
      generation += 1;
    }
    recentSpans.push({
      accepted: true,
      contactSequence: stroke,
      documentCommandProduced: true,
      durationMs: 3,
      name: 'ink-stroke-commit',
      workPhase: 'completion',
    });
  }
  if (viewport) {
    for (let index = 0; index < 5; index += 1) {
      recentSpans.push({
        accepted: true,
        durationMs: 8,
        name: 'ink-viewport-redraw',
        viewportResultCount: 100,
        workPhase: 'viewport',
      });
    }
  }
  return {
    armedAuditGuards: ['canonical-cold-materialization', 'physical-finalize-no-recompile'],
    auditedWork: [
      { count: 1, kind: 'canonical-encode', phase: 'cold' },
      { count: 1, kind: 'canonical-storage-write', phase: 'cold' },
      { count: 1, kind: 'cold-snapshot', phase: 'cold' },
    ],
    forbiddenWork: [],
    droppedSpanCount: 0,
    frameIntervalsMs: {
      activeWriting: Array.from({ length: 1_000 }, () => 16),
      hostGaps: [],
      idle: Array.from({ length: 120 }, () => 16.67),
    },
    hangingSpanCount: 0,
    memory: {
      activeWorkingSetBytes: 1_000_000,
      backingStoreBytes: 8_000_000,
      disposableCacheBytes: 2_000_000,
    },
    openContactCount: 0,
    recentSpans,
  };
}
