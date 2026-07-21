import { apiVersion, MarkdownView, TFile } from 'obsidian';
import type { App, DataAdapter } from 'obsidian';

import type { ObsidianInkModeManager } from './ink-mode-manager';
import type { InkDraftStore } from '../../application/ink-draft-store';
import type { InkPerformanceDiagnostics } from '../../runtime/ink-performance-diagnostics';
import type { InkRenderRuntimeStats } from '../../ui/ink-render-runtime';

const OWNERSHIP_PATH = '.inkstone-s27-local-performance-owned';
const FIXTURE_MARKER_PATH = '.inkstone-s22-performance-hat.json';
const REQUEST_PATH = 'S27 Local Performance Request.json';
const RAW_PATH = 'S27 Local Performance Raw.json';
const PARTIAL_RAW_PATH = 'S27 Local Performance Partial Raw.json';
const CHECKPOINT_PATH = 'S27 Local Performance Checkpoint.json';
const STATUS_PATH = 'S27 Local Performance Status.json';
const CONDITION_MAX_DURATION_MS = 90_000;
const REPLAY_DISPATCH_HEADROOM_MOVES = 20;
const REPLAY_POST_FRAME_PHASE_MS = 2;
const REPLAY_COLD_LANE_IDLE_MS = 600;
const WARMUP_STROKE_COUNT = 3;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const FIXTURES = Object.freeze([
  { filePath: 'S22 Ink 10k 30 surfaces.md', name: 'history-10k-30-surfaces' },
  { filePath: 'S22 Ink 1k.md', name: 'history-1k' },
  { filePath: 'S22 Ink Empty.md', name: 'empty' },
] as const);
const TOOLS = Object.freeze(['pen', 'highlighter'] as const);
const DRAWING_TRACES = Object.freeze(['writing', 'long-line', 'rapid-lift'] as const);
const DRAWING_CONDITION_TRACE = 'mixed-drawing' as const;
const CONDITION_IDS = Object.freeze([
  'history-10k-30-surfaces-pen-preview-lifecycle',
  'history-10k-30-surfaces-pen-mixed-drawing',
  'history-10k-30-surfaces-highlighter-mixed-drawing',
  'history-1k-pen-mixed-drawing',
  'history-1k-highlighter-mixed-drawing',
  'empty-pen-mixed-drawing',
  'empty-highlighter-mixed-drawing',
  'history-10k-30-surfaces-pen-viewport',
  'history-10k-30-surfaces-pen-cache-lifecycle',
  'history-10k-30-surfaces-highlighter-viewport',
  'history-10k-30-surfaces-highlighter-cache-lifecycle',
  'history-10k-30-surfaces-pen-responsive-commands',
  'history-1k-pen-responsive-commands',
  'empty-pen-responsive-commands',
  'empty-pen-done-save',
  'history-10k-30-surfaces-pen-done-save',
] as const);

type ResponsiveConditionTrace = 'done-save' | 'preview-lifecycle' | 'responsive-commands';

type DrawingReplayTrace = (typeof DRAWING_TRACES)[number] | typeof DRAWING_CONDITION_TRACE;

type LocalPerformanceDraftResetPort = Pick<InkDraftStore, 'discardThrough'>;

export interface LocalPerformanceGateRequest {
  readonly buildDigest: string;
  readonly fixtureDigest: string;
  readonly implementationDigest: string;
  readonly protocolDigest: string;
  readonly requestId: string;
  readonly schemaVersion: 1;
  readonly soakDurationMs: number;
}

interface LocalPerformanceCondition {
  readonly captureStatus: 'COMPLETE' | 'TIMEOUT';
  readonly diagnostics: ReturnType<InkPerformanceDiagnostics['snapshot']>;
  readonly durationMs: number;
  readonly fixture: (typeof FIXTURES)[number]['name'];
  readonly id: string;
  readonly renderRuntime: {
    readonly after: InkRenderRuntimeStats;
    readonly before: InkRenderRuntimeStats;
  };
  readonly replay?: {
    readonly dispatched: { readonly down: number; readonly move: number; readonly up: number };
    readonly failure: string | null;
    readonly moveCount: number;
    readonly strokeCount: number;
  };
  readonly tool: (typeof TOOLS)[number];
  readonly trace:
    typeof DRAWING_CONDITION_TRACE | 'cache-lifecycle' | 'viewport' | ResponsiveConditionTrace;
}

/** Runtime decoder shared by on-load execution and unit tests. */
export function decodeLocalPerformanceGateRequest(value: unknown): LocalPerformanceGateRequest {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Local performance Gate request requires schemaVersion 1.');
  }
  const soakDurationMs = value.soakDurationMs;
  if (
    typeof soakDurationMs !== 'number' ||
    !Number.isFinite(soakDurationMs) ||
    soakDurationMs < 300_000
  ) {
    throw new Error('Local performance Gate soak must run for at least five minutes.');
  }
  const request: LocalPerformanceGateRequest = {
    buildDigest: requiredDigest(value.buildDigest, 'build'),
    fixtureDigest: requiredDigest(value.fixtureDigest, 'fixture'),
    implementationDigest: requiredDigest(value.implementationDigest, 'implementation'),
    protocolDigest: requiredDigest(value.protocolDigest, 'protocol'),
    requestId: requiredString(value.requestId, 'request ID'),
    schemaVersion: 1 as const,
    soakDurationMs,
  };
  return request;
}

/** Reuses only an ordered COMPLETE prefix produced by the exact same executable protocol. */
export function restoreLocalPerformanceCheckpoint(
  value: unknown,
  request: LocalPerformanceGateRequest,
): readonly LocalPerformanceCondition[] {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.buildDigest !== request.buildDigest ||
    value.fixtureDigest !== request.fixtureDigest ||
    value.implementationDigest !== request.implementationDigest ||
    value.protocolDigest !== request.protocolDigest ||
    !Array.isArray(value.conditions) ||
    value.conditions.length > CONDITION_IDS.length
  ) {
    return [];
  }
  const restored: LocalPerformanceCondition[] = [];
  for (const [index, condition] of value.conditions.entries()) {
    if (
      !isRecord(condition) ||
      condition.id !== CONDITION_IDS[index] ||
      condition.captureStatus !== 'COMPLETE' ||
      !FIXTURES.some(({ name }) => name === condition.fixture) ||
      !TOOLS.some((tool) => tool === condition.tool) ||
      ![
        DRAWING_CONDITION_TRACE,
        'viewport',
        'cache-lifecycle',
        'responsive-commands',
        'done-save',
        'preview-lifecycle',
      ].includes(condition.trace as typeof DRAWING_CONDITION_TRACE) ||
      typeof condition.durationMs !== 'number' ||
      !Number.isFinite(condition.durationMs) ||
      !isRecord(condition.diagnostics) ||
      !isRecord(condition.renderRuntime)
    ) {
      return [];
    }
    restored.push(condition as unknown as LocalPerformanceCondition);
  }
  return restored;
}

/** Runs only from the dedicated local-Gate build in the ownership-fenced synthetic Vault. */
export class ObsidianLocalPerformanceGate {
  private readonly adapter: DataAdapter;

  constructor(
    private readonly input: {
      readonly app: App;
      readonly diagnostics: InkPerformanceDiagnostics;
      readonly draftStore?: LocalPerformanceDraftResetPort;
      readonly inkMode: ObsidianInkModeManager;
    },
  ) {
    this.adapter = input.app.vault.adapter;
  }

  async runIfRequested(): Promise<boolean> {
    if (!(await this.adapter.exists(REQUEST_PATH))) return false;
    await this.assertOwnedFixture();
    const request = decodeLocalPerformanceGateRequest(
      JSON.parse(await this.adapter.read(REQUEST_PATH)) as unknown,
    );
    await this.input.inkMode.setPreviewByDefault(false);
    await this.input.inkMode.exit();
    await resetLocalPerformanceDrafts(this.input.draftStore);
    await this.writeStatus(request, 'RUNNING', null);
    const checkpoint = (await this.adapter.exists(CHECKPOINT_PATH))
      ? (JSON.parse(await this.adapter.read(CHECKPOINT_PATH)) as unknown)
      : null;
    const conditions = [...restoreLocalPerformanceCheckpoint(checkpoint, request)];
    await this.writeCheckpoint(request, conditions);
    if (conditions.length > 0) await this.writePartialCapture(request, conditions, null);
    const completedConditionIds = new Set(conditions.map(({ id }) => id));
    let activeConditionId = 'initialization';
    try {
      // Run the high-risk cache/Preview path first so an exact-cache regression fails in seconds,
      // before the broad drawing matrix and five-minute soak consume host time.
      activeConditionId = `${FIXTURES[0].name}-pen-preview-lifecycle`;
      if (!completedConditionIds.has(activeConditionId)) {
        const condition = await this.runConditionWithForegroundRecovery(
          request,
          activeConditionId,
          () => this.runPreviewLifecycleCondition(FIXTURES[0]),
        );
        conditions.push(condition);
        await this.writePartialCapture(request, conditions, null);
        if (condition.captureStatus !== 'COMPLETE') {
          throw new Error(`${condition.id} did not complete the Preview lifecycle.`);
        }
        completedConditionIds.add(condition.id);
        await this.writeCheckpoint(request, conditions);
      }
      for (const fixture of FIXTURES) {
        for (const tool of TOOLS) {
          activeConditionId = `${fixture.name}-${tool}-${DRAWING_CONDITION_TRACE}`;
          if (completedConditionIds.has(activeConditionId)) continue;
          const condition = await this.runConditionWithForegroundRecovery(
            request,
            activeConditionId,
            () => this.runDrawingCondition(fixture, tool),
          );
          conditions.push(condition);
          await this.writePartialCapture(request, conditions, null);
          const failure = localDrawingConditionFailure(condition);
          if (failure !== null) throw new Error(failure);
          completedConditionIds.add(condition.id);
          await this.writeCheckpoint(request, conditions);
        }
      }
      const worst = FIXTURES[0];
      for (const tool of TOOLS) {
        activeConditionId = `${worst.name}-${tool}-viewport`;
        if (!completedConditionIds.has(activeConditionId)) {
          const condition = await this.runConditionWithForegroundRecovery(
            request,
            activeConditionId,
            () => this.runViewportCondition(worst, tool),
          );
          conditions.push(condition);
          await this.writePartialCapture(request, conditions, null);
          if (condition.captureStatus !== 'COMPLETE') {
            throw new Error(`${condition.id} did not reach its fixed sample minimum.`);
          }
          completedConditionIds.add(condition.id);
          await this.writeCheckpoint(request, conditions);
        }
        activeConditionId = `${worst.name}-${tool}-cache-lifecycle`;
        if (!completedConditionIds.has(activeConditionId)) {
          const condition = await this.runConditionWithForegroundRecovery(
            request,
            activeConditionId,
            () => this.runCacheLifecycleCondition(worst, tool),
          );
          conditions.push(condition);
          await this.writePartialCapture(request, conditions, null);
          if (condition.captureStatus !== 'COMPLETE') {
            throw new Error(`${condition.id} did not reach its fixed sample minimum.`);
          }
          completedConditionIds.add(condition.id);
          await this.writeCheckpoint(request, conditions);
        }
      }
      for (const fixture of FIXTURES) {
        activeConditionId = `${fixture.name}-pen-responsive-commands`;
        if (completedConditionIds.has(activeConditionId)) continue;
        const condition = await this.runConditionWithForegroundRecovery(
          request,
          activeConditionId,
          () => this.runResponsiveCommandCondition(fixture),
        );
        conditions.push(condition);
        await this.writePartialCapture(request, conditions, null);
        if (condition.captureStatus !== 'COMPLETE') {
          throw new Error(`${condition.id} did not complete every command sample.`);
        }
        completedConditionIds.add(condition.id);
        await this.writeCheckpoint(request, conditions);
      }
      for (const fixture of [FIXTURES[2], FIXTURES[0]] as const) {
        activeConditionId = `${fixture.name}-pen-done-save`;
        if (completedConditionIds.has(activeConditionId)) continue;
        const condition = await this.runConditionWithForegroundRecovery(
          request,
          activeConditionId,
          () => this.runDoneCondition(fixture),
        );
        conditions.push(condition);
        await this.writePartialCapture(request, conditions, null);
        if (condition.captureStatus !== 'COMPLETE') {
          throw new Error(`${condition.id} did not complete the Done transaction.`);
        }
        completedConditionIds.add(condition.id);
        await this.writeCheckpoint(request, conditions);
      }
      activeConditionId = 'five-minute-growing-history-soak';
      const soak = await this.runConditionWithForegroundRecovery(request, activeConditionId, () =>
        this.runSoak(FIXTURES[2], request.soakDurationMs),
      );
      const raw = {
        buildDigest: request.buildDigest,
        conditions,
        fixtureDigest: request.fixtureDigest,
        generatedAt: new Date().toISOString(),
        host: { kind: 'obsidian-desktop', productionCanvas: true, version: apiVersion },
        implementationDigest: request.implementationDigest,
        persistenceArchitecture: 'explicit-commit-memory-first-cold-canonical',
        protocolDigest: request.protocolDigest,
        requestId: request.requestId,
        schemaVersion: 1,
        soak,
      };
      await this.adapter.write(RAW_PATH, `${JSON.stringify(raw, null, 2)}\n`);
      if (await this.adapter.exists(PARTIAL_RAW_PATH)) await this.adapter.remove(PARTIAL_RAW_PATH);
      if (await this.adapter.exists(CHECKPOINT_PATH)) await this.adapter.remove(CHECKPOINT_PATH);
      await this.writeStatus(request, 'CAPTURED', null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Local performance Gate failed.';
      await this.writePartialCapture(request, conditions, {
        conditionId: activeConditionId,
        message,
      });
      await this.writeStatus(request, 'FAIL', message);
      throw error;
    } finally {
      await this.input.inkMode.exit().catch(() => undefined);
    }
  }

  private runConditionWithForegroundRecovery<T>(
    request: LocalPerformanceGateRequest,
    conditionId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    return runLocalPerformanceConditionWithForegroundRecovery({
      maximumAttempts: 5,
      onFocusRequired: async (attempt) => {
        await this.input.inkMode.exit().catch(() => undefined);
        await this.writeStatus(
          request,
          'FOCUS_REQUIRED',
          `${conditionId} discarded after foreground interruption; retry ${attempt + 1}/5 requested.`,
        );
      },
      run,
      waitForForeground: async () => {
        await waitForLocalPerformanceForeground(document, { timeoutMs: 30_000 });
        await this.writeStatus(request, 'RUNNING', null);
      },
    });
  }

  private async runDrawingCondition(
    fixture: (typeof FIXTURES)[number],
    tool: (typeof TOOLS)[number],
  ): Promise<LocalPerformanceCondition> {
    const target = await this.openFixture(
      localGateFilePath(fixture.name, tool, DRAWING_CONDITION_TRACE),
      tool,
    );
    await prepareLocalPerformanceMeasurement({
      calibrateIdleFrames: () => this.calibrateIdleFrames(),
      flushPersistence: () => this.input.inkMode.background(),
      resetDiagnostics: () => this.input.diagnostics.reset(),
      waitForPersistence: () => waitForLocalPersistence(target.toolbar),
      waitForReady: () => waitForPhysicalCandidate(target.toolbar),
      warmup: async () => {
        await replayForDuration(
          target,
          tool,
          DRAWING_CONDITION_TRACE,
          0,
          WARMUP_STROKE_COUNT,
          WARMUP_STROKE_COUNT * 10,
        );
      },
    });
    const renderRuntimeBefore = this.requireActiveRenderRuntimeStats();
    const startedAt = performance.now();
    const stopHostHeartbeat = runLocalPerformanceHostHeartbeat({
      diagnostics: this.input.diagnostics,
    });
    let replay: Awaited<ReturnType<typeof replayForDuration>>;
    let replayFailure: string | null = null;
    try {
      try {
        replay = await replayForDuration(
          target,
          tool,
          DRAWING_CONDITION_TRACE,
          0,
          100,
          1_000,
          CONDITION_MAX_DURATION_MS,
        );
      } catch (error) {
        if (error instanceof LocalPerformanceForegroundError) throw error;
        replayFailure = error instanceof Error ? error.message : 'Deterministic replay failed.';
        replay = {
          moveCount: target.eventProbe.move,
          strokeCount: target.eventProbe.down,
          timedOut: true,
        };
      }
      await nextFrame();
    } finally {
      stopHostHeartbeat();
    }
    const diagnostics = this.input.diagnostics.snapshot();
    const sampleMinimumsMet = localConditionSampleCounts(
      DRAWING_CONDITION_TRACE,
      diagnostics,
    ).passed;
    return {
      captureStatus: replay.timedOut || !sampleMinimumsMet ? 'TIMEOUT' : 'COMPLETE',
      diagnostics,
      durationMs: performance.now() - startedAt,
      fixture: fixture.name,
      id: `${fixture.name}-${tool}-${DRAWING_CONDITION_TRACE}`,
      renderRuntime: {
        after: this.requireActiveRenderRuntimeStats(),
        before: renderRuntimeBefore,
      },
      replay: {
        dispatched: { ...target.eventProbe },
        failure: replayFailure,
        moveCount: replay.moveCount,
        strokeCount: replay.strokeCount,
      },
      tool,
      trace: DRAWING_CONDITION_TRACE,
    };
  }

  private async runViewportCondition(
    fixture: (typeof FIXTURES)[number],
    tool: (typeof TOOLS)[number],
  ): Promise<LocalPerformanceCondition> {
    const target = await this.openFixture(localGateFilePath(fixture.name, tool, 'viewport'), tool);
    await prepareLocalPerformanceMeasurement({
      calibrateIdleFrames: () => this.calibrateIdleFrames(),
      flushPersistence: () => this.input.inkMode.background(),
      resetDiagnostics: () => this.input.diagnostics.reset(),
      waitForPersistence: () => waitForLocalPersistence(target.toolbar),
      waitForReady: () => waitForPhysicalCandidate(target.toolbar),
      warmup: async () => {
        await replayForDuration(
          target,
          tool,
          'writing',
          0,
          WARMUP_STROKE_COUNT,
          WARMUP_STROKE_COUNT * 10,
        );
      },
    });
    await replayForDuration(target, tool, 'writing', 0, 20, 200);
    await waitForPhysicalCandidate(target.toolbar);
    this.input.diagnostics.reset();
    await this.calibrateIdleFrames();
    await waitForPhysicalCandidate(target.toolbar);
    const renderRuntimeBefore = this.requireActiveRenderRuntimeStats();
    const startedAt = performance.now();
    const stopHostHeartbeat = runLocalPerformanceHostHeartbeat({
      diagnostics: this.input.diagnostics,
    });
    try {
      const maximum = Math.max(1, target.scroller.scrollHeight - target.scroller.clientHeight);
      const zoomIn = requiredToolbarButton(target.toolbar, '[data-inkstone-ink-zoom-in]');
      const zoomOut = requiredToolbarButton(target.toolbar, '[data-inkstone-ink-zoom-out]');
      await runLocalViewportReplay({
        cycleCount: 120,
        scroll: (index) => {
          target.scroller.scrollTop = (maximum * (index % 30)) / 29;
          target.scroller.dispatchEvent(new Event('scroll'));
        },
        waitForFrame: async () => {
          await nextFrame();
        },
        waitForQuiescence: async () => {
          await waitUntil(
            () => this.requireActiveRenderRuntimeStats().queuedFrameCount === 0,
            5_000,
            () => 'Local Gate viewport renderer did not become quiescent after settling.',
          );
        },
        waitForSettle: async () => {
          await replayDelay(150);
          await nextFrame();
        },
        zoomIn: () => zoomIn.click(),
        zoomOut: () => zoomOut.click(),
      });
    } finally {
      stopHostHeartbeat();
    }
    const diagnostics = this.input.diagnostics.snapshot();
    const sampleMinimumsMet = localConditionSampleCounts('viewport', diagnostics).passed;
    return {
      captureStatus: sampleMinimumsMet ? 'COMPLETE' : 'TIMEOUT',
      diagnostics,
      durationMs: performance.now() - startedAt,
      fixture: fixture.name,
      id: `${fixture.name}-${tool}-viewport`,
      renderRuntime: {
        after: this.requireActiveRenderRuntimeStats(),
        before: renderRuntimeBefore,
      },
      tool,
      trace: 'viewport',
    };
  }

  private async runCacheLifecycleCondition(
    fixture: (typeof FIXTURES)[number],
    tool: (typeof TOOLS)[number],
  ): Promise<LocalPerformanceCondition> {
    let target = await this.openFixture(
      localGateFilePath(fixture.name, tool, 'cache-lifecycle'),
      tool,
    );
    await prepareLocalPerformanceMeasurement({
      calibrateIdleFrames: () => this.calibrateIdleFrames(),
      flushPersistence: () => this.input.inkMode.background(),
      resetDiagnostics: () => this.input.diagnostics.reset(),
      waitForPersistence: () => waitForLocalPersistence(target.toolbar),
      waitForReady: () => waitForPhysicalCandidate(target.toolbar),
      warmup: async () => {
        await replayForDuration(
          target,
          tool,
          'long-line',
          0,
          WARMUP_STROKE_COUNT,
          WARMUP_STROKE_COUNT * 10,
        );
      },
    });
    const renderRuntimeBefore = this.requireActiveRenderRuntimeStats();
    const startedAt = performance.now();
    const stopHostHeartbeat = runLocalPerformanceHostHeartbeat({
      diagnostics: this.input.diagnostics,
    });
    let diagnostics: ReturnType<InkPerformanceDiagnostics['snapshot']>;
    try {
      await replayForDuration(target, tool, 'long-line', 0, 20, 200);
      // The explicit exit below is the cache-lifecycle boundary, not foreground drawing work.
      // Freeze the hot-window diagnostics before the permitted cold canonical save begins.
      diagnostics = this.input.diagnostics.snapshot();
      await this.input.inkMode.exit();
      await nextFrame();
      target = await this.openFixture(
        localGateFilePath(fixture.name, tool, 'cache-lifecycle'),
        tool,
      );
      target.scroller.scrollTop = Math.max(
        0,
        target.scroller.scrollHeight - target.scroller.clientHeight,
      );
      target.scroller.dispatchEvent(new Event('scroll'));
      await nextFrame();
    } finally {
      stopHostHeartbeat();
    }
    const sampleMinimumsMet = localConditionSampleCounts('cache-lifecycle', diagnostics).passed;
    return {
      captureStatus: sampleMinimumsMet ? 'COMPLETE' : 'TIMEOUT',
      diagnostics,
      durationMs: performance.now() - startedAt,
      fixture: fixture.name,
      id: `${fixture.name}-${tool}-cache-lifecycle`,
      renderRuntime: {
        after: this.requireActiveRenderRuntimeStats(),
        before: renderRuntimeBefore,
      },
      tool,
      trace: 'cache-lifecycle',
    };
  }

  private async runResponsiveCommandCondition(
    fixture: (typeof FIXTURES)[number],
  ): Promise<LocalPerformanceCondition> {
    const target = await this.openFixture(
      localGateFilePath(fixture.name, 'pen', 'responsive-commands'),
      'pen',
    );
    await waitForLocalResponsiveCommandScene({
      readVisibleRecoveryCount: () =>
        this.requireActiveRenderRuntimeStats().visibleRecoveryRebuildCount,
      waitForFrame: nextFrame,
    });
    await replayForDuration(target, 'pen', 'writing', 0, WARMUP_STROKE_COUNT, 30);
    await this.input.inkMode.background();
    await waitForLocalPersistence(target.toolbar);
    this.input.diagnostics.reset();
    await this.calibrateIdleFrames();
    const before = this.requireActiveRenderRuntimeStats();
    const startedAt = performance.now();
    const run = async (
      kind: Parameters<ObsidianInkModeManager['runLocalPerformanceCommand']>[0],
    ): Promise<void> => {
      if (!this.input.inkMode.runLocalPerformanceCommand(kind)) {
        throw new Error(`Local Gate command ${kind} was not accepted.`);
      }
      await waitForLocalCommandPresentationFrames(nextFrame);
    };
    await run('restyle');
    for (let sample = 0; sample < 50; sample += 1) {
      await run('undo');
      await run('redo');
    }
    await run('selection');
    await run('move');
    await run('delete-selection');
    await run('undo');
    await run('erase');
    await run('undo');
    const diagnostics = this.input.diagnostics.snapshot();
    return {
      captureStatus: localResponsiveCommandSampleCounts(diagnostics).passed
        ? 'COMPLETE'
        : 'TIMEOUT',
      diagnostics,
      durationMs: performance.now() - startedAt,
      fixture: fixture.name,
      id: `${fixture.name}-pen-responsive-commands`,
      renderRuntime: { after: this.requireActiveRenderRuntimeStats(), before },
      tool: 'pen',
      trace: 'responsive-commands',
    };
  }

  private async runDoneCondition(
    fixture: (typeof FIXTURES)[number],
  ): Promise<LocalPerformanceCondition> {
    await this.input.inkMode.setPreviewByDefault(false);
    const target = await this.openFixture(
      localGateFilePath(fixture.name, 'pen', 'done-save'),
      'pen',
    );
    await replayForDuration(target, 'pen', 'writing', 0, 1, 10);
    await nextFrame();
    this.input.diagnostics.reset();
    await this.calibrateIdleFrames();
    const before = this.requireActiveRenderRuntimeStats();
    const startedAt = performance.now();
    await this.input.inkMode.exit();
    await nextFrame();
    await waitForLocalPerformanceSpansToSettle({
      isSettled: (snapshot) => {
        const { firstFeedback, total } = localDoneSampleCounts(snapshot);
        return firstFeedback === 1 && total === 1;
      },
      snapshot: () => this.input.diagnostics.snapshot(),
    });
    const diagnostics = this.input.diagnostics.snapshot();
    return {
      captureStatus: localDoneSampleCounts(diagnostics).passed ? 'COMPLETE' : 'TIMEOUT',
      diagnostics,
      durationMs: performance.now() - startedAt,
      fixture: fixture.name,
      id: `${fixture.name}-pen-done-save`,
      renderRuntime: { after: before, before },
      tool: 'pen',
      trace: 'done-save',
    };
  }

  private async runPreviewLifecycleCondition(
    fixture: (typeof FIXTURES)[number],
  ): Promise<LocalPerformanceCondition> {
    const filePath = localGateFilePath(fixture.name, 'pen', 'preview-lifecycle');
    await this.input.inkMode.exit();
    await this.input.inkMode.setPreviewByDefault(false);
    await this.input.inkMode.resetLocalPerformancePreviewCache(filePath);
    const file = this.input.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error(`Local Gate fixture is missing: ${filePath}`);
    const leaf = this.input.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: 'markdown', state: { file: file.path, mode: 'preview' } });
    this.input.app.workspace.setActiveLeaf(leaf, { focus: true });
    if (!(leaf.view instanceof MarkdownView))
      throw new Error('Local Gate Preview view is missing.');
    this.input.inkMode.registerView(leaf.view);
    await this.input.inkMode.synchronizeRegisteredView(leaf.view);
    this.input.diagnostics.reset();
    await this.calibrateIdleFrames();
    const startedAt = performance.now();
    await this.input.inkMode.setPreviewByDefault(true);
    await waitForElement(
      leaf.view.contentEl,
      '[data-inkstone-ink-preview-canvas]',
      (candidate) => candidate.isConnected,
    );
    await waitUntil(
      () => localPreviewSampleCounts(this.input.diagnostics.snapshot()).firstInk >= 1,
      10_000,
      () => 'Local Gate cold Preview did not present its first Ink pixels.',
    );
    await waitUntil(
      () => localPreviewSampleCounts(this.input.diagnostics.snapshot()).viewportComplete >= 1,
      10_000,
      () => 'Local Gate cold Preview did not complete its visible viewport.',
    );
    await waitUntil(
      () => localPreviewSampleCounts(this.input.diagnostics.snapshot()).cachePublish >= 1,
      15_000,
      () => 'Local Gate cold Preview did not publish its exact visible cache tiles.',
    );
    await this.input.inkMode.remountLocalPerformancePreview(leaf.view);
    await waitUntil(
      () => localPreviewSampleCounts(this.input.diagnostics.snapshot()).firstInk >= 2,
      10_000,
      () => 'Local Gate warm Preview did not present its first Ink pixels.',
    );
    await waitUntil(
      () => {
        const samples = localPreviewSampleCounts(this.input.diagnostics.snapshot());
        return samples.hit >= 1 && samples.viewportComplete >= 2;
      },
      10_000,
      () => 'Local Gate warm Preview did not present a complete exact cache hit.',
    );
    await this.input.inkMode.toggle(leaf.view);
    await waitUntil(
      () => {
        const samples = localPreviewSampleCounts(this.input.diagnostics.snapshot());
        return (
          this.input.inkMode.activeRenderRuntimeStats !== null &&
          samples.editableHydration >= 1 &&
          samples.toEdit >= 1
        );
      },
      10_000,
      () => 'Local Gate Preview-to-Edit hydration did not complete.',
    );
    const before = this.requireActiveRenderRuntimeStats();
    const diagnostics = this.input.diagnostics.snapshot();
    const durationMs = performance.now() - startedAt;
    await this.input.inkMode.exit();
    await this.input.inkMode.setPreviewByDefault(false);
    return {
      captureStatus: localPreviewSampleCounts(diagnostics).passed ? 'COMPLETE' : 'TIMEOUT',
      diagnostics,
      durationMs,
      fixture: fixture.name,
      id: `${fixture.name}-pen-preview-lifecycle`,
      renderRuntime: { after: before, before },
      tool: 'pen',
      trace: 'preview-lifecycle',
    };
  }

  private async runSoak(
    fixture: (typeof FIXTURES)[number],
    durationMs: number,
  ): Promise<{
    readonly diagnostics: ReturnType<InkPerformanceDiagnostics['snapshot']>;
    readonly durationMs: number;
    readonly renderRuntime: {
      readonly after: InkRenderRuntimeStats;
      readonly before: InkRenderRuntimeStats;
    };
    readonly strokeCount: number;
    readonly tools: readonly (typeof TOOLS)[number][];
  }> {
    const target = await this.openFixture(localGateFilePath(fixture.name, 'mixed', 'soak'), 'pen');
    await prepareLocalPerformanceMeasurement({
      calibrateIdleFrames: () => this.calibrateIdleFrames(),
      flushPersistence: () => this.input.inkMode.background(),
      resetDiagnostics: () => this.input.diagnostics.reset(),
      waitForPersistence: () => waitForLocalPersistence(target.toolbar),
      waitForReady: () => waitForPhysicalCandidate(target.toolbar),
      warmup: async () => {
        await replayForDuration(
          target,
          'pen',
          'writing',
          0,
          WARMUP_STROKE_COUNT,
          WARMUP_STROKE_COUNT * 10,
        );
      },
    });
    const renderRuntimeBefore = this.requireActiveRenderRuntimeStats();
    const startedAt = performance.now();
    let strokeCount = 0;
    const progress = createLocalPerformanceSoakProgress(target.surface.ownerDocument);
    const stopHostHeartbeat = runLocalPerformanceHostHeartbeat({
      diagnostics: this.input.diagnostics,
    });
    try {
      progress.textContent = localPerformanceSoakProgressText(0, 0, durationMs);
      while (performance.now() - startedAt < durationMs || strokeCount < 120) {
        const tool = TOOLS[Math.floor(strokeCount / 10) % TOOLS.length] ?? 'pen';
        if (strokeCount % 10 === 0) {
          selectTool(target.toolbar, tool);
          await waitForPhysicalCandidate(target.toolbar);
        }
        await replayStroke(target, strokeCount + 1, tool, 'writing');
        strokeCount += 1;
        if (strokeCount % 10 === 0) {
          progress.textContent = localPerformanceSoakProgressText(
            performance.now() - startedAt,
            strokeCount,
            durationMs,
          );
        }
        await runLocalReplayColdLaneYield(strokeCount, replayDelay);
        await runLocalSoakPace(replayDelay);
      }
      await nextFrame();
    } finally {
      stopHostHeartbeat();
      progress.remove();
    }
    return {
      diagnostics: this.input.diagnostics.snapshot(),
      durationMs: performance.now() - startedAt,
      renderRuntime: {
        after: this.requireActiveRenderRuntimeStats(),
        before: renderRuntimeBefore,
      },
      strokeCount,
      tools: [...TOOLS],
    };
  }

  private async openFixture(filePath: string, tool: (typeof TOOLS)[number]): Promise<ReplayTarget> {
    await this.input.inkMode.exit();
    const file = this.input.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error(`Local Gate fixture is missing: ${filePath}`);
    const leaf = this.input.app.workspace.getLeaf(false);
    const previousFilePath =
      leaf.view instanceof MarkdownView ? (leaf.view.file?.path ?? null) : null;
    const previousCanvases = new Set(
      leaf.view.containerEl.querySelectorAll<HTMLElement>('.inkstone-ink-surface'),
    );
    await leaf.setViewState({ type: 'markdown', state: { file: file.path, mode: 'preview' } });
    this.input.app.workspace.setActiveLeaf(leaf, { focus: true });
    if (!(leaf.view instanceof MarkdownView)) {
      throw new Error(`Local Gate could not open the Markdown fixture: ${filePath}`);
    }
    this.input.inkMode.registerView(leaf.view);
    await this.input.inkMode.synchronizeRegisteredView(leaf.view);
    await this.input.inkMode.toggle(leaf.view);
    const canvasSurface = await waitForLocalGateEditableSurface({
      previousFilePathMatches: previousFilePath === filePath,
      previousSurfaces: previousCanvases,
      root: leaf.view.contentEl,
    });
    const controllerInstance = canvasSurface.dataset.inkstoneInkController;
    if (controllerInstance === undefined) {
      throw new Error('Local Gate Canvas is missing its controller identity.');
    }
    const toolbar = await waitForElement<HTMLElement>(
      leaf.view.containerEl.ownerDocument,
      '[data-inkstone-ink-toolbar-host]',
      (candidate) =>
        candidate.isConnected && candidate.dataset.inkstoneInkController === controllerInstance,
    );
    const surface = canvasSurface.closest<HTMLElement>('.markdown-preview-view.is-ink-mode');
    if (surface === null) {
      throw new Error('Local Gate Canvas is not attached to the current Ink Mode scroller.');
    }
    selectTool(toolbar, tool);
    await waitForPhysicalCandidate(toolbar);
    const eventProbe = { down: 0, move: 0, up: 0 };
    surface.addEventListener('pointerdown', () => (eventProbe.down += 1), true);
    surface.addEventListener('pointermove', () => (eventProbe.move += 1), true);
    surface.addEventListener('pointerup', () => (eventProbe.up += 1), true);
    return { eventProbe, scroller: surface, surface: canvasSurface, toolbar };
  }

  private requireActiveRenderRuntimeStats(): InkRenderRuntimeStats {
    const stats = this.input.inkMode.activeRenderRuntimeStats;
    if (stats === null) throw new Error('Local Gate requires an active Ink render runtime.');
    return stats;
  }

  private async calibrateIdleFrames(): Promise<void> {
    let previous = await nextFrame();
    for (let index = 0; index < 120; index += 1) {
      const current = await nextFrame();
      this.input.diagnostics.recordFrameInterval(current - previous, 'idle');
      previous = current;
    }
  }

  private async assertOwnedFixture(): Promise<void> {
    const [owned, fixture] = await Promise.all([
      this.adapter.exists(OWNERSHIP_PATH),
      this.adapter.exists(FIXTURE_MARKER_PATH),
    ]);
    if (!owned || !fixture) {
      throw new Error('Local performance Gate is allowed only in the owned synthetic Vault.');
    }
  }

  private writeStatus(
    request: LocalPerformanceGateRequest,
    status: 'CAPTURED' | 'FAIL' | 'FOCUS_REQUIRED' | 'RUNNING',
    error: string | null,
  ): Promise<void> {
    return this.adapter.write(
      STATUS_PATH,
      `${JSON.stringify(
        {
          buildDigest: request.buildDigest,
          error,
          protocolDigest: request.protocolDigest,
          requestId: request.requestId,
          schemaVersion: 1,
          status,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }

  private writePartialCapture(
    request: LocalPerformanceGateRequest,
    conditions: readonly LocalPerformanceCondition[],
    failure: { readonly conditionId: string; readonly message: string } | null,
  ): Promise<void> {
    const latestCondition = conditions.at(-1);
    return this.adapter.write(
      PARTIAL_RAW_PATH,
      `${JSON.stringify(
        {
          buildDigest: request.buildDigest,
          captureStatus: 'PARTIAL',
          completedConditionIds: conditions.map(({ id }) => id),
          conditions: latestCondition === undefined ? [] : [latestCondition],
          failure,
          fixtureDigest: request.fixtureDigest,
          generatedAt: new Date().toISOString(),
          host: { kind: 'obsidian-desktop', productionCanvas: true, version: apiVersion },
          implementationDigest: request.implementationDigest,
          protocolDigest: request.protocolDigest,
          requestId: request.requestId,
          schemaVersion: 1,
          soak: null,
        },
        null,
        2,
      )}\n`,
    );
  }

  private writeCheckpoint(
    request: LocalPerformanceGateRequest,
    conditions: readonly LocalPerformanceCondition[],
  ): Promise<void> {
    return this.adapter.write(
      CHECKPOINT_PATH,
      `${JSON.stringify(
        {
          buildDigest: request.buildDigest,
          conditions,
          fixtureDigest: request.fixtureDigest,
          implementationDigest: request.implementationDigest,
          protocolDigest: request.protocolDigest,
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }
}

/** Preserves protocol failures instead of misreporting every incomplete replay as a timeout. */
export function localDrawingConditionFailure(condition: {
  readonly captureStatus: 'COMPLETE' | 'TIMEOUT';
  readonly id: string;
  readonly replay?: { readonly failure: string | null };
}): string | null {
  if (condition.replay?.failure !== null && condition.replay?.failure !== undefined) {
    return `${condition.id} replay failed: ${condition.replay.failure}`;
  }
  if (condition.captureStatus === 'TIMEOUT') {
    return `${condition.id} exceeded ${CONDITION_MAX_DURATION_MS} ms before reaching its fixed sample minimum.`;
  }
  return null;
}

/** Ownership-fenced reset of device-local state left by an interrupted prior Gate run. */
export async function resetLocalPerformanceDrafts(
  draftStore: LocalPerformanceDraftResetPort | undefined,
): Promise<void> {
  if (draftStore === undefined) return;
  const filePaths: string[] = [];
  for (const fixture of FIXTURES) {
    for (const tool of TOOLS) {
      for (const trace of [...DRAWING_TRACES, DRAWING_CONDITION_TRACE]) {
        filePaths.push(localGateFilePath(fixture.name, tool, trace));
      }
    }
  }
  const worst = FIXTURES[0];
  for (const tool of TOOLS) {
    filePaths.push(localGateFilePath(worst.name, tool, 'viewport'));
    filePaths.push(localGateFilePath(worst.name, tool, 'cache-lifecycle'));
  }
  for (const fixture of FIXTURES) {
    filePaths.push(localGateFilePath(fixture.name, 'pen', 'responsive-commands'));
  }
  filePaths.push(localGateFilePath(FIXTURES[2].name, 'pen', 'done-save'));
  filePaths.push(localGateFilePath(FIXTURES[0].name, 'pen', 'done-save'));
  filePaths.push(localGateFilePath(FIXTURES[0].name, 'pen', 'preview-lifecycle'));
  filePaths.push(localGateFilePath(FIXTURES[2].name, 'mixed', 'soak'));
  await Promise.all(
    filePaths.map((filePath) => draftStore.discardThrough(filePath, Number.MAX_SAFE_INTEGER)),
  );
}

interface ReplayTarget {
  readonly eventProbe: { down: number; move: number; up: number };
  readonly scroller: HTMLElement;
  readonly surface: HTMLElement;
  readonly toolbar: HTMLElement;
}

async function replayForDuration(
  target: ReplayTarget,
  tool: (typeof TOOLS)[number],
  trace: DrawingReplayTrace,
  durationMs: number,
  minimumStrokes: number,
  minimumMoves: number,
  maximumDurationMs = CONDITION_MAX_DURATION_MS,
): Promise<{
  readonly moveCount: number;
  readonly strokeCount: number;
  readonly timedOut: boolean;
}> {
  const startedAt = performance.now();
  let moveCount = 0;
  let strokeCount = 0;
  const dispatchMoveTarget = localReplayDispatchMoveTarget(minimumMoves);
  while (
    performance.now() - startedAt < durationMs ||
    strokeCount < minimumStrokes ||
    moveCount < dispatchMoveTarget
  ) {
    if (performance.now() - startedAt >= maximumDurationMs) break;
    const replayTrace =
      trace === DRAWING_CONDITION_TRACE
        ? (DRAWING_TRACES[strokeCount % DRAWING_TRACES.length] ?? 'writing')
        : trace;
    moveCount += await replayStroke(target, strokeCount + 1, tool, replayTrace);
    strokeCount += 1;
    await runLocalReplayColdLaneYield(strokeCount, replayDelay);
  }
  await nextFrame();
  return {
    moveCount,
    strokeCount,
    timedOut:
      performance.now() - startedAt < durationMs ||
      strokeCount < minimumStrokes ||
      moveCount < minimumMoves,
  };
}

/**
 * Synthetic Pointer Events can occasionally lose capture between frames even though the first
 * coalesced batch was accepted and safely committed. Dispatch headroom keeps the Gate's fixed
 * minimum based on accepted production spans instead of accidentally treating dispatch count as
 * acceptance. Analyzer budgets and accepted-sample minimums remain unchanged.
 */
export function localReplayDispatchMoveTarget(minimumMoves: number): number {
  return minimumMoves + REPLAY_DISPATCH_HEADROOM_MOVES;
}

async function replayStroke(
  target: ReplayTarget,
  strokeSequence: number,
  tool: (typeof TOOLS)[number],
  trace: (typeof DRAWING_TRACES)[number],
): Promise<number> {
  const { surface } = target;
  assertLocalPerformanceForeground(surface.ownerDocument);
  const bounds = surface.getBoundingClientRect();
  const pointerId = 10_000 + strokeSequence;
  const baseX = bounds.left + 32 + (strokeSequence % 12) * 24;
  const baseY = bounds.top + 48 + (strokeSequence % 18) * 22;
  const frameStep = (dispatch: () => void): Promise<void> =>
    runLocalReplayFrameStep({
      dispatch,
      waitForFrame: async () => {
        await nextFrame();
      },
    });
  const pointAt = (move: number): { readonly x: number; readonly y: number } => {
    const progress = move / 10;
    const x =
      trace === 'long-line'
        ? bounds.left + 24 + progress * Math.max(80, bounds.width - 48)
        : baseX + progress * (trace === 'rapid-lift' ? 8 : 36);
    const y =
      trace === 'long-line'
        ? baseY + Math.sin(progress * Math.PI) * 8
        : baseY + Math.sin(progress * Math.PI * 2) * (trace === 'rapid-lift' ? 2 : 6);
    return { x, y };
  };
  const first = pointAt(1);
  await runLocalInitialFrameStringingCanary({
    dispatchDown: () => {
      dispatchPen(surface, 'pointerdown', pointerId, baseX, baseY, tool === 'pen' ? 0.35 : 0.5);
      assertPhysicalReplayState(target.toolbar, 'active', 'pointerdown', strokeSequence);
    },
    dispatchMove: () =>
      dispatchFrontLoadedParentCurve(
        surface,
        pointerId,
        baseX,
        baseY,
        first.x,
        first.y,
        tool === 'pen' ? 0.31 : 0.5,
      ),
    waitForFrame: async () => {
      await nextFrame();
    },
    waitForPhase: replayDelay,
  });
  for (let move = 2; move <= 10; move += 1) {
    const progress = move / 10;
    const { x, y } = pointAt(move);
    await frameStep(() =>
      dispatchPen(
        surface,
        'pointermove',
        pointerId,
        x,
        y,
        tool === 'pen' ? 0.25 + progress * 0.6 : 0.5,
      ),
    );
    assertLocalPerformanceForeground(surface.ownerDocument);
  }
  assertLocalPerformanceForeground(surface.ownerDocument);
  await frameStep(() => {
    dispatchPen(
      surface,
      'pointerup',
      pointerId,
      baseX + (trace === 'rapid-lift' ? 8 : 36),
      baseY,
      0,
    );
  });
  await waitForPhysicalCandidate(target.toolbar);
  assertPhysicalReplayState(target.toolbar, 'ready', 'pointerup', strokeSequence);
  assertLocalPerformanceForeground(surface.ownerDocument);
  return 10;
}

/** Dispatches one normalized replay batch and waits for the host frame that presents it. */
export async function runLocalReplayFrameStep(input: {
  readonly dispatch: () => void;
  readonly waitForFrame: () => Promise<void>;
}): Promise<void> {
  input.dispatch();
  await input.waitForFrame();
}

/** Allows both command application and a following overlay/document presentation opportunity. */
export async function waitForLocalCommandPresentationFrames(
  waitForFrame: () => Promise<unknown>,
): Promise<void> {
  await waitForFrame();
  await waitForFrame();
}

/** Isolates command latency from the separately measured first Edit-scene materialization. */
export async function waitForLocalResponsiveCommandScene(input: {
  readonly readVisibleRecoveryCount: () => number;
  readonly waitForFrame: () => Promise<unknown>;
}): Promise<void> {
  for (let frame = 0; frame < 600; frame += 1) {
    if (input.readVisibleRecoveryCount() >= 1) return;
    await input.waitForFrame();
  }
  throw new Error('Local Gate responsive commands require the first exact Edit scene.');
}

/** Reproduces the iPad failure window: down and the first coalesced curve await one shared frame. */
export async function runLocalInitialFrameStringingCanary(input: {
  readonly dispatchDown: () => void;
  readonly dispatchMove: () => void;
  readonly waitForFrame: () => Promise<void>;
  readonly waitForPhase: (durationMs: number) => Promise<void>;
}): Promise<void> {
  await input.waitForFrame();
  await input.waitForPhase(REPLAY_POST_FRAME_PHASE_MS);
  input.dispatchDown();
  input.dispatchMove();
  await input.waitForFrame();
}

/** One contact-free former-debounce canary detects accidental 500 ms persistence regression. */
export async function runLocalReplayColdLaneYield(
  strokeCount: number,
  wait: (durationMs: number) => Promise<void>,
): Promise<void> {
  if (strokeCount !== 50) return;
  await wait(REPLAY_COLD_LANE_IDLE_MS);
}

/** Keeps the five-minute soak long-running without overflowing its bounded local span recorder. */
export async function runLocalSoakPace(wait: (durationMs: number) => Promise<void>): Promise<void> {
  await wait(400);
}

export function localPerformanceSoakProgressText(
  elapsedMs: number,
  strokeCount: number,
  durationMs: number,
): string {
  return `Local Gate soak ${clockText(elapsedMs)} / ${clockText(durationMs)} · ${strokeCount} strokes · Pen/Highlighter switch every 10`;
}

function createLocalPerformanceSoakProgress(documentState: Document): HTMLElement {
  const progress = documentState.createElement('div');
  progress.dataset.inkstoneLocalGateProgress = '';
  Object.assign(progress.style, {
    background: 'var(--background-primary)',
    border: '1px solid var(--background-modifier-border)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow-s)',
    color: 'var(--text-normal)',
    fontSize: '13px',
    left: '16px',
    padding: '8px 12px',
    pointerEvents: 'none',
    position: 'fixed',
    top: '16px',
    zIndex: '10000',
  });
  documentState.body.append(progress);
  return progress;
}

function clockText(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export class LocalPerformanceForegroundError extends Error {
  constructor(
    message = 'Local Obsidian Performance Gate requires the Obsidian window to remain foreground.',
  ) {
    super(message);
    this.name = 'LocalPerformanceForegroundError';
  }
}

/** A focus-interrupted condition is discarded; only a clean replay can produce measurements. */
export async function runLocalPerformanceConditionWithForegroundRecovery<T>(input: {
  readonly maximumAttempts: number;
  readonly onFocusRequired: (
    attempt: number,
    error: LocalPerformanceForegroundError,
  ) => Promise<void>;
  readonly run: () => Promise<T>;
  readonly waitForForeground: () => Promise<void>;
}): Promise<T> {
  for (let attempt = 1; attempt <= input.maximumAttempts; attempt += 1) {
    try {
      return await input.run();
    } catch (error) {
      if (
        !(error instanceof LocalPerformanceForegroundError) ||
        attempt === input.maximumAttempts
      ) {
        throw error;
      }
      await input.onFocusRequired(attempt, error);
      await input.waitForForeground();
    }
  }
  throw new Error('Local performance foreground recovery exhausted unexpectedly.');
}

export async function waitForLocalPerformanceForeground(
  documentState: { readonly hasFocus: () => boolean; readonly hidden: boolean },
  options: {
    readonly timeoutMs?: number;
    readonly wait?: (durationMs: number) => Promise<void>;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const wait = options.wait ?? replayDelay;
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (!documentState.hidden && documentState.hasFocus()) return;
    await wait(100);
  }
  throw new LocalPerformanceForegroundError(
    'Local Obsidian Performance Gate could not restore the foreground window.',
  );
}

/** Separates cold initialization from every frozen steady-state sample window. */
export async function prepareLocalPerformanceMeasurement(input: {
  readonly calibrateIdleFrames: () => Promise<void>;
  readonly flushPersistence: () => Promise<void>;
  readonly resetDiagnostics: () => void;
  readonly waitForPersistence: () => Promise<void>;
  readonly waitForReady: () => Promise<void>;
  readonly warmup: () => Promise<void>;
}): Promise<void> {
  await input.warmup();
  await input.flushPersistence();
  await input.waitForPersistence();
  await input.waitForReady();
  input.resetDiagnostics();
  await input.calibrateIdleFrames();
  await input.waitForReady();
}

/** Records real rAF heartbeat intervals independently of replay and frame-work diagnostics. */
export function runLocalPerformanceHostHeartbeat(input: {
  readonly cancelFrame?: (handle: number) => void;
  readonly diagnostics: Pick<InkPerformanceDiagnostics, 'recordFrameInterval'>;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
}): () => void {
  const requestFrame = input.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = input.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  let active = true;
  let handle: number | null = null;
  let previous: number | null = null;
  const schedule = (): void => {
    handle = requestFrame((timestamp) => {
      handle = null;
      if (!active) return;
      if (previous !== null) {
        input.diagnostics.recordFrameInterval(
          Math.round(Math.max(0, timestamp - previous) * 10) / 10,
          'host-gap',
        );
      }
      previous = timestamp;
      schedule();
    });
  };
  schedule();
  return () => {
    active = false;
    if (handle !== null) cancelFrame(handle);
    handle = null;
  };
}

/** Deterministic viewport coverage includes production scroll and toolbar zoom paths. */
export async function runLocalViewportReplay(input: {
  readonly cycleCount: number;
  readonly scroll: (index: number) => void;
  readonly waitForFrame: () => Promise<void>;
  readonly waitForQuiescence: () => Promise<void>;
  readonly waitForSettle: () => Promise<void>;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
}): Promise<void> {
  for (let index = 0; index < input.cycleCount; index += 1) {
    input.scroll(index);
    if ((index + 1) % 24 === 0 || index + 1 === input.cycleCount) {
      await input.waitForFrame();
    }
  }
  for (let index = 0; index < Math.floor(input.cycleCount / 30); index += 1) {
    (index % 2 === 0 ? input.zoomIn : input.zoomOut)();
  }
  await input.waitForFrame();
  await input.waitForSettle();
  await input.waitForQuiescence();
}

/** Rejects Electron background scheduling before it can be misreported as Ink work. */
export function assertLocalPerformanceForeground(documentState: {
  readonly hasFocus: () => boolean;
  readonly hidden: boolean;
}): void {
  if (documentState.hidden || !documentState.hasFocus()) {
    throw new LocalPerformanceForegroundError();
  }
}

function assertPhysicalReplayState(
  toolbar: HTMLElement,
  expected: 'active' | 'ready',
  phase: 'pointerdown' | 'pointerup',
  strokeSequence: number,
): void {
  const actual = toolbar.dataset.inkstonePhysicalCandidate ?? 'missing';
  if (actual !== expected) {
    const status = toolbar.querySelector<HTMLElement>('[data-inkstone-ink-status]');
    const error = status?.getAttribute('data-inkstone-ink-error');
    throw new Error(
      `Local Gate stroke ${strokeSequence} ${phase} expected physical candidate ${expected}, got ${actual}${error === null || error === undefined ? '' : `: ${error}`}.`,
    );
  }
}

function dispatchPen(
  target: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  pointerId: number,
  clientX: number,
  clientY: number,
  pressure: number,
): void {
  target.dispatchEvent(createPenPointerEvent(type, pointerId, clientX, clientY, pressure));
}

function dispatchFrontLoadedParentCurve(
  target: HTMLElement,
  pointerId: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  pressure: number,
): void {
  const raw = Array.from({ length: 11 }, (_value, index) => {
    const progress = (index + 1) / 11;
    return createPenPointerEvent(
      'pointermove',
      pointerId,
      startX + (endX - startX) * progress,
      startY + (endY - startY) * progress + Math.sin(progress * Math.PI * 2) * 5,
      pressure,
    );
  });
  const parent = createPenPointerEvent('pointermove', pointerId, endX, endY, pressure);
  Object.defineProperty(parent, 'getCoalescedEvents', {
    configurable: true,
    value: () => [parent, ...raw],
  });
  target.dispatchEvent(parent);
}

function createPenPointerEvent(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  pointerId: number,
  clientX: number,
  clientY: number,
  pressure: number,
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    button: type === 'pointerup' ? 0 : 0,
    buttons: type === 'pointerup' ? 0 : 1,
    cancelable: true,
    clientX,
    clientY,
    isPrimary: true,
    pointerId,
    pointerType: 'pen',
    pressure,
  });
}

function selectTool(toolbar: HTMLElement, tool: (typeof TOOLS)[number]): void {
  const button = toolbar.querySelector<HTMLButtonElement>(`[data-inkstone-ink-tool="${tool}"]`);
  if (button === null) throw new Error(`Local Gate cannot select ${tool}.`);
  button.click();
}

function requiredToolbarButton(toolbar: HTMLElement, selector: string): HTMLButtonElement {
  const button = toolbar.querySelector<HTMLButtonElement>(selector);
  if (button === null) throw new Error(`Local Gate toolbar is missing ${selector}.`);
  return button;
}

async function waitForPhysicalCandidate(toolbar: HTMLElement): Promise<void> {
  await waitUntil(
    () => {
      const status = toolbar.querySelector<HTMLElement>('[data-inkstone-ink-status]');
      const retry = toolbar.querySelector<HTMLButtonElement>('[data-inkstone-ink-retry]');
      if (retry?.hidden === false) {
        throw new Error(
          status?.getAttribute('data-inkstone-ink-error') ||
            status?.textContent?.trim() ||
            'Physical Ink candidate failed closed.',
        );
      }
      return (
        toolbar.dataset.inkstoneControllerActive === 'true' &&
        toolbar.dataset.inkstonePhysicalCandidate === 'ready'
      );
    },
    30_000,
    () => {
      const state = toolbar.dataset.inkstonePhysicalCandidate ?? 'missing';
      return `Local Gate timed out waiting for physical candidate ready; last state was ${state}.`;
    },
  );
}

async function waitForLocalPersistence(toolbar: HTMLElement): Promise<void> {
  await waitUntil(
    () => {
      const status = toolbar.querySelector<HTMLElement>('[data-inkstone-ink-status]');
      return (
        status?.getAttribute('data-inkstone-ink-error') === null &&
        status.textContent?.includes('Saved locally') === true
      );
    },
    CONDITION_MAX_DURATION_MS,
    () => {
      const status = toolbar.querySelector<HTMLElement>('[data-inkstone-ink-status]');
      return `Local Gate timed out waiting for cold persistence; last status was ${status?.textContent?.trim() || 'missing'}.`;
    },
  );
}

export function waitForLocalPerformanceFrame(
  input: {
    readonly cancelFrame?: (handle: number) => void;
    readonly clearTimeout?: (handle: unknown) => void;
    readonly documentState?: { readonly hasFocus: () => boolean; readonly hidden: boolean };
    readonly requestFrame?: (callback: FrameRequestCallback) => number;
    readonly scheduleTimeout?: (callback: () => void, durationMs: number) => unknown;
    readonly timeoutMs?: number;
  } = {},
): Promise<number> {
  const cancelFrame = input.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  const clearScheduledTimeout =
    input.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as number));
  const documentState = input.documentState ?? document;
  const requestFrame = input.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const scheduleTimeout =
    input.scheduleTimeout ??
    ((callback, durationMs) => globalThis.setTimeout(callback, durationMs));
  const timeoutMs = input.timeoutMs ?? 2_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle: unknown = null;
    const frameHandle = requestFrame((timestamp) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) clearScheduledTimeout(timeoutHandle);
      resolve(timestamp);
    });
    if (settled) return;
    timeoutHandle = scheduleTimeout(() => {
      if (settled) return;
      settled = true;
      cancelFrame(frameHandle);
      if (documentState.hidden || !documentState.hasFocus()) {
        reject(
          new LocalPerformanceForegroundError(
            'Local Obsidian Performance Gate animation frame was suspended outside the foreground.',
          ),
        );
        return;
      }
      reject(
        new Error(
          `Local Gate animation frame did not arrive within ${timeoutMs} ms while Obsidian remained foreground.`,
        ),
      );
    }, timeoutMs);
  });
}

function nextFrame(): Promise<number> {
  return waitForLocalPerformanceFrame();
}

function replayDelay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function localGateFilePath(fixture: string, tool: string, trace: string): string {
  return `S27R6 ${fixture} ${tool} ${trace}.md`;
}

export function waitForLocalGateEditableSurface(input: {
  readonly previousFilePathMatches: boolean;
  readonly previousSurfaces: ReadonlySet<HTMLElement>;
  readonly root: ParentNode;
}): Promise<HTMLElement> {
  return waitForElement<HTMLElement>(
    input.root,
    '.inkstone-ink-surface[data-inkstone-ink-controller]',
    (candidate) =>
      candidate.isConnected &&
      candidate.closest('.markdown-preview-view.is-ink-mode') !== null &&
      (input.previousFilePathMatches || !input.previousSurfaces.has(candidate)),
  );
}

async function waitForElement<T extends Element>(
  root: ParentNode,
  selector: string,
  predicate: (candidate: T) => boolean = () => true,
): Promise<T> {
  let result: T | null = null;
  await waitUntil(
    () => {
      result = [...root.querySelectorAll<T>(selector)].find(predicate) ?? null;
      return result !== null;
    },
    30_000,
    () => `Local Gate timed out waiting for ${selector}.`,
  );
  if (result === null) throw new Error(`Local Gate timed out waiting for ${selector}.`);
  return result;
}

type LocalConditionSampleInput = {
  readonly frameIntervalsMs: { readonly idle: readonly number[] };
  readonly recentSpans: readonly {
    readonly accepted?: boolean;
    readonly commandKind?: string;
    readonly documentCommandProduced?: boolean;
    readonly inputPhase?: string;
    readonly name: string;
  }[];
};

export function localResponsiveCommandSampleCounts(input: LocalConditionSampleInput): {
  readonly apply: number;
  readonly idle: number;
  readonly kinds: readonly string[];
  readonly passed: boolean;
  readonly submit: number;
  readonly undoRedo: number;
} {
  const accepted = input.recentSpans.filter((span) => span.accepted !== false);
  const apply = accepted.filter((span) => span.name === 'ink-command-apply');
  const submit = accepted.filter((span) => span.name === 'ink-command-to-submit');
  const kinds = [...new Set(apply.map(({ commandKind }) => commandKind).filter(isString))].sort();
  const required = ['delete-selection', 'erase', 'move', 'redo', 'restyle', 'selection', 'undo'];
  const undoRedo = apply.filter(
    ({ commandKind }) => commandKind === 'undo' || commandKind === 'redo',
  ).length;
  const idle = input.frameIntervalsMs.idle.length;
  return {
    apply: apply.length,
    idle,
    kinds,
    passed:
      idle >= 120 &&
      required.every((kind) => kinds.includes(kind)) &&
      undoRedo >= 100 &&
      submit.length === apply.length,
    submit: submit.length,
    undoRedo,
  };
}

export function localDoneSampleCounts(input: LocalConditionSampleInput): {
  readonly firstFeedback: number;
  readonly idle: number;
  readonly passed: boolean;
  readonly total: number;
} {
  const accepted = input.recentSpans.filter((span) => span.accepted !== false);
  const firstFeedback = accepted.filter(({ name }) => name === 'ink-done-first-feedback').length;
  const total = accepted.filter(({ name }) => name === 'ink-done-total').length;
  const idle = input.frameIntervalsMs.idle.length;
  return { firstFeedback, idle, passed: idle >= 120 && firstFeedback === 1 && total === 1, total };
}

export function localPreviewSampleCounts(input: LocalConditionSampleInput): {
  readonly cacheLookup: number;
  readonly cachePublish: number;
  readonly editableHydration: number;
  readonly firstInk: number;
  readonly hit: number;
  readonly miss: number;
  readonly passed: boolean;
  readonly toEdit: number;
  readonly viewportComplete: number;
} {
  const accepted = input.recentSpans.filter((span) => span.accepted !== false);
  const count = (name: string): number => accepted.filter((span) => span.name === name).length;
  const result = {
    cacheLookup: input.recentSpans.filter(({ name }) => name === 'ink-preview-cache-lookup').length,
    cachePublish: count('ink-preview-cache-publish'),
    editableHydration: count('ink-preview-editable-hydration'),
    firstInk: count('ink-preview-first-ink'),
    toEdit: count('ink-preview-to-edit'),
    viewportComplete: count('ink-preview-viewport-complete'),
    hit: input.recentSpans.filter(
      ({ accepted, name }) => name === 'ink-preview-cache-lookup' && accepted !== false,
    ).length,
    miss: input.recentSpans.filter(
      ({ accepted, name }) => name === 'ink-preview-cache-lookup' && accepted === false,
    ).length,
  };
  return {
    ...result,
    passed:
      result.cacheLookup >= 2 &&
      result.cachePublish >= 1 &&
      result.editableHydration >= 1 &&
      result.firstInk >= 2 &&
      result.hit >= 1 &&
      result.miss >= 1 &&
      result.toEdit >= 1 &&
      result.viewportComplete >= 2,
  };
}

export function localConditionSampleCounts(
  trace: typeof DRAWING_CONDITION_TRACE | 'viewport' | 'cache-lifecycle',
  input: LocalConditionSampleInput,
): {
  readonly commits: number;
  readonly idle: number;
  readonly moves: number;
  readonly passed: boolean;
  readonly viewport?: number;
} {
  if (trace === DRAWING_CONDITION_TRACE) return localDrawingSampleCounts(input);
  if (trace === 'viewport') return localViewportSampleCounts(input);
  return localCacheLifecycleSampleCounts(input);
}

export function localDrawingSampleCounts(input: LocalConditionSampleInput): {
  readonly commits: number;
  readonly idle: number;
  readonly moves: number;
  readonly passed: boolean;
} {
  return localReplaySampleCounts(input, { commits: 100, moves: 1_000 });
}

export function localCacheLifecycleSampleCounts(input: LocalConditionSampleInput): {
  readonly commits: number;
  readonly idle: number;
  readonly moves: number;
  readonly passed: boolean;
} {
  return localReplaySampleCounts(input, { commits: 20, moves: 200 });
}

export function localViewportSampleCounts(input: LocalConditionSampleInput): {
  readonly commits: number;
  readonly idle: number;
  readonly moves: number;
  readonly passed: boolean;
  readonly viewport: number;
} {
  const replay = localReplaySampleCounts(input, { commits: 20, moves: 200 });
  const viewport = input.recentSpans.filter(
    (span) => span.accepted !== false && span.name === 'ink-viewport-redraw',
  ).length;
  return {
    ...replay,
    passed: replay.idle >= 120 && viewport >= 1,
    viewport,
  };
}

function localReplaySampleCounts(
  input: LocalConditionSampleInput,
  minimums: { readonly commits: number; readonly moves: number },
): {
  readonly commits: number;
  readonly idle: number;
  readonly moves: number;
  readonly passed: boolean;
} {
  const moves = input.recentSpans.filter(
    (span) =>
      span.accepted !== false && span.name === 'ink-input-handler' && span.inputPhase === 'move',
  ).length;
  const commits = input.recentSpans.filter(
    (span) =>
      span.accepted !== false &&
      span.name === 'ink-stroke-commit' &&
      span.documentCommandProduced === true,
  ).length;
  const idle = input.frameIntervalsMs.idle.length;
  return {
    commits,
    idle,
    moves,
    passed: idle >= 120 && moves >= minimums.moves && commits >= minimums.commits,
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  timeoutMessage: () => string,
): Promise<void> {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error(timeoutMessage());
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function waitForLocalPerformanceSpansToSettle<
  Snapshot extends { readonly hangingSpanCount: number },
>(input: {
  readonly isSettled?: (snapshot: Snapshot) => boolean;
  readonly maximumAttempts?: number;
  readonly snapshot: () => Snapshot;
  readonly waitForSettlement?: () => Promise<void>;
}): Promise<void> {
  const maximumAttempts = input.maximumAttempts ?? 100;
  const waitForSettlement =
    input.waitForSettlement ??
    (() => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 50)));
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const snapshot = input.snapshot();
    if (
      input.isSettled === undefined ? snapshot.hangingSpanCount === 0 : input.isSettled(snapshot)
    ) {
      return;
    }
    await waitForSettlement();
  }
  throw new Error('Local Gate Done spans did not settle before the condition snapshot.');
}

function requiredDigest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`Local performance Gate request has invalid ${name} digest.`);
  }
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Local performance Gate request has invalid ${name}.`);
  }
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
