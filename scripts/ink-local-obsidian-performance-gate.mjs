/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- This CLI runtime-validates JSON at the real Obsidian process boundary. */

import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

const FIXTURES = Object.freeze(['empty', 'history-1k', 'history-10k-30-surfaces']);
const TOOLS = Object.freeze(['pen', 'highlighter']);
const DRAWING_TRACES = Object.freeze(['mixed-drawing']);
const ACCEPTED_DRAWING_TRACES = Object.freeze([
  ...DRAWING_TRACES,
  'writing',
  'long-line',
  'rapid-lift',
]);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const LOCAL_GATE_COMMAND = 'npm run gate:ink-local-obsidian';
const MIB = 1024 * 1024;
const REQUIRED_AUDIT_GUARDS = Object.freeze([
  'canonical-cold-materialization',
  'physical-finalize-no-recompile',
]);

export const LOCAL_GATE_RESULT_RELATIVE_PATH = join(
  'docs',
  'delivery',
  'slices',
  'S27R6-local-obsidian-performance-gate',
  'results.json',
);

/** Stable fixture identity excludes the preparation timestamp but retains all protocol inputs. */
export function computePreparedFixtureDigest(marker) {
  if (!isRecord(marker)) throw new Error('Local Gate fixture marker must be an object.');
  return sha256(
    JSON.stringify({
      conditions: marker.conditions,
      localGateConditions: marker.localGateConditions,
      schemaVersion: marker.schemaVersion,
    }),
  );
}

/** Keeps the production host schedulable for the complete unattended capture. */
export function startLocalGateWakeLock({ pid = process.pid, spawnProcess = spawn } = {}) {
  const wakeLock = spawnProcess('/usr/bin/caffeinate', ['-di', '-w', String(pid)], {
    stdio: 'ignore',
  });
  wakeLock.unref();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    wakeLock.kill();
  };
}

/** Deterministically analyzes privacy-safe evidence captured inside the real Obsidian host. */
export function analyzeLocalObsidianCapture(capture) {
  assertCaptureEnvelope(capture);
  if (capture.captureStatus === 'PARTIAL') return analyzePartialCapture(capture);
  const conditions = capture.conditions;
  const allDiagnostics = conditions.map((condition) => condition.diagnostics);
  const auditedDiagnostics = [...allDiagnostics, capture.soak.diagnostics];
  const allSpans = allDiagnostics.flatMap((diagnostics) => diagnostics.recentSpans);
  const idleIntervals = allDiagnostics.flatMap((diagnostics) => diagnostics.frameIntervalsMs.idle);
  const refreshIntervalMs = percentile(idleIntervals, 0.5);
  const inputHandlers = acceptedSpans(allSpans, 'ink-input-handler', 'move');
  const frameWork = acceptedSpans(allSpans, 'ink-frame-work');
  const inputToSubmit = acceptedSpans(allSpans, 'ink-input-to-submit', 'move').filter(
    (span) =>
      span.presentationOutcome === 'submitted' &&
      span.requestedGeneration === span.submittedGeneration,
  );
  const commits = acceptedSpans(allSpans, 'ink-stroke-commit').filter(
    (span) => span.documentCommandProduced === true,
  );
  const canonicalPersistenceSubmits = acceptedSpans(allSpans, 'ink-canonical-persistence-submit');
  const viewports = acceptedSpans(allSpans, 'ink-viewport-redraw');
  const activeContactViewportRedrawCount = viewports.filter(
    (span) => span.contactSequence !== undefined,
  ).length;
  const forbiddenHotPathWork = forbiddenHotPathViolations(auditedDiagnostics);
  const armedAuditGuards = collectArmedAuditGuards(auditedDiagnostics);
  const pendingFrameIntervals = allDiagnostics.flatMap(
    (diagnostics) => diagnostics.frameIntervalsMs.activeWriting,
  );
  const missedFrames = missedFrameRatio(
    pendingFrameIntervals.map((durationMs) => ({ durationMs })),
    refreshIntervalMs,
  );
  const pendingGapCount = pendingFrameIntervals.filter((durationMs) => durationMs >= 50).length;
  const hostHeartbeat = hostHeartbeatSummary(conditions);
  const strokeWindows = buildStrokeWindows(capture.soak.diagnostics.recentSpans);
  const drawingRenderRuntime = conditions.filter((condition) =>
    DRAWING_TRACES.includes(condition.trace),
  );
  const hangingSpanCount = auditedDiagnostics.reduce(
    (total, diagnostics) => total + diagnostics.hangingSpanCount,
    0,
  );
  const openContactCount = auditedDiagnostics.reduce(
    (total, diagnostics) => total + diagnostics.openContactCount,
    0,
  );
  const droppedSpanCount = auditedDiagnostics.reduce(
    (total, diagnostics) => total + diagnostics.droppedSpanCount,
    0,
  );
  const acceptedZeroSampleMoveCount = allSpans.filter(
    (span) =>
      span.accepted !== false &&
      span.inputPhase === 'move' &&
      (span.name === 'ink-input-handler' || span.name === 'ink-input-to-submit') &&
      span.sampleCountBucket === '0',
  ).length;
  const minimumInitialFrameStringingCanaries = Math.min(
    ...conditions
      .filter((condition) => DRAWING_TRACES.includes(condition.trace))
      .map(
        (condition) =>
          condition.diagnostics.recentSpans.filter(
            (span) =>
              span.accepted !== false &&
              span.name === 'ink-input-handler' &&
              span.inputPhase === 'move' &&
              span.causalRepair === 'front-loaded-parent',
          ).length,
      ),
  );
  const budgets = [
    budget(
      'real-obsidian-production-canvas',
      capture.host.kind === 'obsidian-desktop' && capture.host.productionCanvas === true,
      {
        actual: `${capture.host.kind}/${String(capture.host.productionCanvas)}`,
        limit: 'obsidian-desktop/true',
      },
    ),
    budget('coverage', hasRequiredCoverage(conditions), {
      actual: conditions.length,
      limit: 10,
    }),
    budget('sample-minimums', hasSampleMinimums(conditions), {
      actual: minimumSamples(conditions),
      limit: { idle: 120, move: 1_000, strokeCommit: 100, viewport: 5 },
    }),
    budget('hanging-span-count', hangingSpanCount === 0, {
      actual: hangingSpanCount,
      limit: 0,
    }),
    budget('open-contact-count', openContactCount === 0, {
      actual: openContactCount,
      limit: 0,
    }),
    budget('dropped-span-count', droppedSpanCount === 0, {
      actual: droppedSpanCount,
      limit: 0,
    }),
    budget('accepted-zero-sample-move-count', acceptedZeroSampleMoveCount === 0, {
      actual: acceptedZeroSampleMoveCount,
      limit: 0,
    }),
    budget('initial-frame-stringing-canary', minimumInitialFrameStringingCanaries >= 100, {
      actual: { minimumPerCondition: minimumInitialFrameStringingCanaries },
      limit: { minimumPerCondition: 100 },
    }),
    budget('input-handler-p99-ms', distribution(inputHandlers).p99Ms <= 4, {
      actual: distribution(inputHandlers),
      limit: 4,
    }),
    budget('frame-work-p99-ms', distribution(frameWork).p99Ms <= 12, {
      actual: distribution(frameWork),
      limit: 12,
    }),
    budget('input-to-submit-p99-ms', distribution(inputToSubmit).p99Ms <= refreshIntervalMs * 2, {
      actual: distribution(inputToSubmit),
      limit: round(refreshIntervalMs * 2),
    }),
    budget('pending-work-missed-frame-ratio', missedFrames.ratio < 0.01, {
      actual: missedFrames,
      limit: 0.01,
    }),
    budget('pending-work-gaps-gte-50ms', pendingGapCount === 0, {
      actual: pendingGapCount,
      limit: 0,
    }),
    budget('stroke-commit-p99-ms', distribution(commits).p99Ms <= 4, {
      actual: distribution(commits),
      limit: 4,
    }),
    budget(
      'foreground-canonical-persistence-submit-count',
      canonicalPersistenceSubmits.length === 0,
      { actual: canonicalPersistenceSubmits.length, limit: 0 },
    ),
    budget('viewport-redraw-p95-ms', distribution(viewports).p95Ms < 16.7, {
      actual: distribution(viewports),
      limit: 16.7,
    }),
    budget('active-contact-viewport-redraw-count', activeContactViewportRedrawCount === 0, {
      actual: activeContactViewportRedrawCount,
      limit: 0,
    }),
    budget(
      'ordinary-drawing-visible-recovery-rebuild-count',
      drawingRenderRuntime.every(
        ({ renderRuntime }) =>
          renderRuntime.after.visibleRecoveryRebuildCount ===
          renderRuntime.before.visibleRecoveryRebuildCount,
      ),
      {
        actual: drawingRenderRuntime.map(({ id, renderRuntime }) => ({
          count:
            renderRuntime.after.visibleRecoveryRebuildCount -
            renderRuntime.before.visibleRecoveryRebuildCount,
          id,
        })),
        limit: 0,
      },
    ),
    budget(
      'ordinary-drawing-backing-dimension-mutation-count',
      drawingRenderRuntime.every(
        ({ renderRuntime }) =>
          renderRuntime.after.backingStoreDimensionMutationCount ===
          renderRuntime.before.backingStoreDimensionMutationCount,
      ),
      {
        actual: drawingRenderRuntime.map(({ id, renderRuntime }) => ({
          count:
            renderRuntime.after.backingStoreDimensionMutationCount -
            renderRuntime.before.backingStoreDimensionMutationCount,
          id,
        })),
        limit: 0,
      },
    ),
    budget(
      'unclassified-visible-recovery-rebuild-count',
      conditions.every(
        ({ renderRuntime }) =>
          renderRuntime.after.visibleRecoveryRebuildReason !== 'unclassified-document-change',
      ) &&
        capture.soak.renderRuntime.after.visibleRecoveryRebuildReason !==
          'unclassified-document-change',
      {
        actual: [...conditions, capture.soak].map(
          ({ renderRuntime }) => renderRuntime.after.visibleRecoveryRebuildReason,
        ),
        limit: 0,
      },
    ),
    budget(
      'committed-raster-tile-memory',
      [...conditions, capture.soak].every(({ renderRuntime }) =>
        renderRuntimeWithinBounds(renderRuntime.after),
      ),
      {
        actual: [...conditions, capture.soak].map(({ renderRuntime }) => ({
          backingStoreBytes: renderRuntime.after.backingStoreBytes,
          compositorLayerCount: renderRuntime.after.compositorLayerCount,
          rasterTileBytes: renderRuntime.after.rasterTileBytes,
          rasterTileCount: renderRuntime.after.rasterTileCount,
        })),
        limit: '3 compositor layers and min(32 MiB, 1.5 viewport RGBA areas)',
      },
    ),
    budget('viewport-redraw-coalescing', viewportRedrawsAreCoalesced(conditions), {
      actual: viewportRedrawCounts(conditions),
      limit: '5..8 redraws per 120-scroll viewport condition',
    }),
    budget('forbidden-hot-path-work', forbiddenHotPathWork.length === 0, {
      actual: forbiddenHotPathWork,
      limit: 0,
    }),
    budget('hot-path-audit-coverage', hasEvery(REQUIRED_AUDIT_GUARDS, armedAuditGuards), {
      actual: armedAuditGuards,
      limit: REQUIRED_AUDIT_GUARDS,
    }),
    budget('empty-vs-10k-history-delta', historyDeltaPasses(conditions), {
      actual: historyDeltas(conditions),
      limit: 'max(1 ms, 10%) for input and active frame p95',
    }),
    budget('growing-history-windows', windowsRemainBounded(strokeWindows), {
      actual: growingHistoryTrend(strokeWindows),
      limit:
        'no sustained early-to-late median cohort delta and whole-run regression rise above max(1 ms, 10%)',
    }),
    budget('memory-cache-bounds', memoryIsBounded(allDiagnostics, capture.soak.diagnostics), {
      actual: memorySummary([...allDiagnostics, capture.soak.diagnostics]),
      limit: { backingStoreBytes: 64 * MIB, disposableCacheBytes: 32 * MIB },
    }),
    budget(
      'five-minute-growing-history-soak',
      capture.soak.durationMs >= 300_000 &&
        capture.soak.tools.includes('pen') &&
        capture.soak.tools.includes('highlighter'),
      {
        actual: { durationMs: capture.soak.durationMs, tools: capture.soak.tools },
        limit: { durationMs: 300_000, tools: ['pen', 'highlighter'] },
      },
    ),
  ];

  return {
    automatedVerdict: budgets.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
    budgets,
    buildDigest: capture.buildDigest,
    command: LOCAL_GATE_COMMAND,
    fixtureDigest: capture.fixtureDigest,
    generatedAt: new Date().toISOString(),
    host: capture.host,
    hostHeartbeat,
    implementationDigest: capture.implementationDigest,
    protocolDigest: capture.protocolDigest,
    refreshIntervalMs: round(refreshIntervalMs),
    schemaVersion: 1,
    strokeWindows,
  };
}

function analyzePartialCapture(capture) {
  const diagnostics = capture.conditions.map((condition) => condition.diagnostics);
  const spans = diagnostics.flatMap((value) => value.recentSpans);
  const idleIntervals = diagnostics.flatMap((value) => value.frameIntervalsMs.idle);
  const refreshIntervalMs = percentile(idleIntervals, 0.5);
  const inputHandlers = acceptedSpans(spans, 'ink-input-handler', 'move');
  const frameWork = acceptedSpans(spans, 'ink-frame-work');
  const inputToSubmit = acceptedSpans(spans, 'ink-input-to-submit', 'move').filter(
    (span) =>
      span.presentationOutcome === 'submitted' &&
      span.requestedGeneration === span.submittedGeneration,
  );
  const commits = acceptedSpans(spans, 'ink-stroke-commit').filter(
    (span) => span.documentCommandProduced === true,
  );
  const canonicalPersistenceSubmits = acceptedSpans(spans, 'ink-canonical-persistence-submit');
  const forbiddenHotPathWork = forbiddenHotPathViolations(diagnostics);
  const armedAuditGuards = collectArmedAuditGuards(diagnostics);
  const memory = memorySummary(diagnostics);
  const budgets = [
    budget('condition-completion', false, {
      actual: capture.failure,
      limit: 'every condition completes within its fail-fast deadline',
    }),
    budget('real-obsidian-production-canvas', true, {
      actual: `${capture.host.kind}/${String(capture.host.productionCanvas)}`,
      limit: 'obsidian-desktop/true',
    }),
    budget('coverage', false, { actual: capture.conditions.length, limit: 10 }),
    budget('sample-minimums', hasSampleMinimums(capture.conditions), {
      actual: minimumSamples(capture.conditions),
      limit: { idle: 120, move: 1_000, strokeCommit: 100, viewport: 5 },
    }),
    budget('input-handler-p99-ms', distribution(inputHandlers).p99Ms <= 4, {
      actual: distribution(inputHandlers),
      limit: 4,
    }),
    budget('frame-work-p99-ms', distribution(frameWork).p99Ms <= 12, {
      actual: distribution(frameWork),
      limit: 12,
    }),
    budget(
      'input-to-submit-p99-ms',
      refreshIntervalMs > 0 && distribution(inputToSubmit).p99Ms <= refreshIntervalMs * 2,
      {
        actual: distribution(inputToSubmit),
        limit: round(refreshIntervalMs * 2),
      },
    ),
    budget('stroke-commit-p99-ms', distribution(commits).p99Ms <= 4, {
      actual: distribution(commits),
      limit: 4,
    }),
    budget(
      'foreground-canonical-persistence-submit-count',
      canonicalPersistenceSubmits.length === 0,
      { actual: canonicalPersistenceSubmits.length, limit: 0 },
    ),
    budget('forbidden-hot-path-work', forbiddenHotPathWork.length === 0, {
      actual: forbiddenHotPathWork,
      limit: 0,
    }),
    budget('hot-path-audit-coverage', hasEvery(REQUIRED_AUDIT_GUARDS, armedAuditGuards), {
      actual: armedAuditGuards,
      limit: REQUIRED_AUDIT_GUARDS,
    }),
    budget(
      'memory-cache-bounds',
      finiteNonNegative(memory.backingStoreBytes) &&
        finiteNonNegative(memory.disposableCacheBytes) &&
        memory.backingStoreBytes <= 64 * MIB &&
        memory.disposableCacheBytes <= 32 * MIB,
      {
        actual: memory,
        limit: { backingStoreBytes: 64 * MIB, disposableCacheBytes: 32 * MIB },
      },
    ),
    budget('five-minute-growing-history-soak', false, {
      actual: null,
      limit: { durationMs: 300_000, tools: ['pen', 'highlighter'] },
    }),
  ];
  return {
    automatedVerdict: 'FAIL',
    budgets,
    buildDigest: capture.buildDigest,
    captureStatus: 'PARTIAL',
    command: LOCAL_GATE_COMMAND,
    failure: capture.failure,
    fixtureDigest: capture.fixtureDigest,
    generatedAt: new Date().toISOString(),
    host: capture.host,
    hostHeartbeat: hostHeartbeatSummary(capture.conditions),
    implementationDigest: capture.implementationDigest,
    protocolDigest: capture.protocolDigest,
    refreshIntervalMs: round(refreshIntervalMs),
    schemaVersion: 1,
    strokeWindows: buildStrokeWindows(spans),
  };
}

/** Digest of the checked-in local Gate protocol and the source specification that freezes it. */
export async function computeLocalObsidianProtocolDigest(projectRoot) {
  const paths = [
    'scripts/ink-local-obsidian-performance-gate.mjs',
    'docs/specs/2026-07-17-ink-native-feel-execution-plan.md',
    'docs/specs/2026-07-17-ink-native-feel-performance-and-brush-fidelity.md',
  ];
  const hash = createHash('sha256');
  for (const path of paths) {
    hash
      .update(path)
      .update('\0')
      .update(await readFile(join(projectRoot, path)));
  }
  return hash.digest('hex');
}

/** Hashes the implementation inputs so a later physical marker cannot consume a stale local pass. */
export async function computeLocalImplementationDigest(projectRoot) {
  const paths = [
    'esbuild.config.mjs',
    'manifest.json',
    'package-lock.json',
    'package.json',
    ...(await sourceFiles(join(projectRoot, 'src'))).map((path) =>
      path.slice(projectRoot.length + 1),
    ),
  ].sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash
      .update(path)
      .update('\0')
      .update(await readFile(join(projectRoot, path)));
  }
  return hash.digest('hex');
}

/**
 * Prevents the real-host plugin from observing its request until the owned Vault is both loaded
 * and foreground. The armed reload then starts capture without the request/focus race.
 */
export async function armLocalObsidianCaptureAfterForeground(input) {
  await input.clearRequest();
  await input.launchUnarmedVault();
  await input.activateForeground();
  await input.writeRequest();
  await input.reloadArmedVault();
  await input.waitForActiveVault();
  await input.activateForeground();
}

/** Full one-command orchestration: build, owned Vault, real Obsidian, capture, analysis, evidence. */
export async function runLocalObsidianPerformanceGate(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const evidenceRoot = resolve(
    options.evidenceRoot ??
      join(projectRoot, 'docs', 'delivery', 'slices', 'S27R6-local-obsidian-performance-gate'),
  );
  const requestId =
    options.requestId ??
    `local-${new Date()
      .toISOString()
      .replaceAll(/[^0-9]/gu, '')
      .slice(0, 14)}`;
  const vaultRoot = resolve(options.vaultRoot ?? join(projectRoot, 'test-fixtures', 'vault'));
  await mkdir(evidenceRoot, { recursive: true });
  await executeFile('npm', ['run', 'build:local-performance-gate'], {
    cwd: projectRoot,
    maxBuffer: 32 * 1024 * 1024,
  });
  await executeFile(
    process.execPath,
    [join(projectRoot, 'scripts', 'prepare-ink-performance-hat.mjs'), 'prepare-in-place'],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        INKSTONE_PROJECT_ROOT: projectRoot,
        INKSTONE_S22_HAT_OUTPUT: vaultRoot,
      },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const pluginRoot = join(vaultRoot, '.obsidian', 'plugins', 'inkstone-annotations');
  const buildDigest = sha256(await readFile(join(pluginRoot, 'main.js')));
  const fixtureDigest = computePreparedFixtureDigest(
    JSON.parse(await readFile(join(vaultRoot, '.inkstone-s22-performance-hat.json'), 'utf8')),
  );
  const implementationDigest = await computeLocalImplementationDigest(projectRoot);
  const protocolDigest = await computeLocalObsidianProtocolDigest(projectRoot);
  const request = {
    buildDigest,
    fixtureDigest,
    implementationDigest,
    protocolDigest,
    requestId,
    schemaVersion: 1,
    soakDurationMs: 300_000,
  };
  await Promise.all([
    writeFile(
      join(vaultRoot, '.inkstone-s27-local-performance-owned'),
      'S27R6 owned local performance Vault\n',
      'utf8',
    ),
    rm(join(vaultRoot, 'S27 Local Performance Raw.json'), { force: true }),
    rm(join(vaultRoot, 'S27 Local Performance Partial Raw.json'), { force: true }),
    rm(join(vaultRoot, 'S27 Local Performance Status.json'), { force: true }),
  ]);
  const vaultName = basename(vaultRoot);
  await armLocalObsidianCaptureAfterForeground({
    activateForeground: () => activateObsidianForeground(10_000),
    clearRequest: () => rm(join(vaultRoot, 'S27 Local Performance Request.json'), { force: true }),
    launchUnarmedVault: () => launchObsidian(vaultRoot),
    reloadArmedVault: () => requestObsidianVaultReload(vaultName),
    waitForActiveVault: () => waitForActiveObsidianVault(vaultRoot, 30_000),
    writeRequest: () =>
      writeFile(
        join(vaultRoot, 'S27 Local Performance Request.json'),
        `${JSON.stringify(request, null, 2)}\n`,
        'utf8',
      ),
  });
  const rawPath = join(vaultRoot, 'S27 Local Performance Raw.json');
  const partialRawPath = join(vaultRoot, 'S27 Local Performance Partial Raw.json');
  const statusPath = join(vaultRoot, 'S27 Local Performance Status.json');
  const raw = await waitForLocalCapture({
    partialRawPath,
    rawPath,
    statusPath,
    timeoutMs: 30 * 60_000,
  });
  for (const [name, expected] of Object.entries(request)) {
    if (name === 'schemaVersion' || name === 'soakDurationMs') continue;
    if (raw[name] !== expected)
      throw new Error(`Local Obsidian raw ${name} does not match request.`);
  }
  const results = analyzeLocalObsidianCapture(raw);
  const storedRawPath = join(evidenceRoot, 'raw', `${requestId}.json`);
  await mkdir(join(evidenceRoot, 'raw'), { recursive: true });
  await Promise.all([
    writeFile(storedRawPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8'),
    writeFile(join(evidenceRoot, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8'),
    writeFile(
      join(evidenceRoot, 'performance.md'),
      performanceMarkdown(results, storedRawPath),
      'utf8',
    ),
    writeFile(
      join(evidenceRoot, 'source-manifest.md'),
      renderLocalObsidianSourceManifest({
        automatedVerdict: results.automatedVerdict,
        buildDigest,
        evidenceRoot,
        fixtureDigest,
        implementationDigest,
        protocolDigest,
        requestId,
        storedRawPath,
        vaultRoot,
      }),
      'utf8',
    ),
  ]);
  return { evidenceRoot, rawPath: storedRawPath, results, vaultRoot };
}

/** Fail-closed prerequisite consumed by both physical runners. */
export async function assertCurrentLocalObsidianPass({ projectRoot, resultPath = undefined }) {
  const path = resolve(resultPath ?? join(projectRoot, LOCAL_GATE_RESULT_RELATIVE_PATH));
  let result;
  try {
    result = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(
        'S27R6 Local Obsidian Performance Gate PASS is required before iPad capture.',
        { cause: error },
      );
    }
    throw error;
  }
  if (!isRecord(result) || result.automatedVerdict !== 'PASS') {
    throw new Error('S27R6 Local Obsidian Performance Gate is not PASS; iPad capture is blocked.');
  }
  const [protocolDigest, implementationDigest] = await Promise.all([
    computeLocalObsidianProtocolDigest(projectRoot),
    computeLocalImplementationDigest(projectRoot),
  ]);
  if (
    result.protocolDigest !== protocolDigest ||
    result.implementationDigest !== implementationDigest
  ) {
    throw new Error(
      'S27R6 Local Obsidian Performance Gate PASS is stale; iPad capture is blocked.',
    );
  }
  return result;
}

async function launchObsidian(vaultRoot) {
  const vaultName = basename(vaultRoot);
  const url = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent('S22 Ink Empty.md')}`;
  await executeFile('/usr/bin/open', [url]);
  await waitForActiveObsidianVault(vaultRoot, 30_000);
  // A plugin-only reload can leave the previous run's active Ink document alive long enough to
  // race freshly seeded v2 fixtures. Always reload the owned Vault, including when another Vault
  // was focused before launch, so the prepared build and fixtures become the only runtime state.
  await requestObsidianVaultReload(vaultName);
  await waitForActiveObsidianVault(vaultRoot, 30_000);
  await activateObsidianForeground(10_000);
}

/** The current Obsidian CLI can keep the reload client alive after the Vault has reloaded. */
export async function requestObsidianVaultReload(vaultName, { executeReload = executeFile } = {}) {
  try {
    await executeReload('/usr/local/bin/obsidian', ['reload', `vault=${vaultName}`], {
      killSignal: 'SIGKILL',
      timeout: 5_000,
    });
  } catch (error) {
    if (isRecord(error) && error.killed === true && error.signal === 'SIGKILL') return;
    throw error;
  }
}

async function activateObsidianForeground(timeoutMs) {
  await executeFile('/usr/bin/osascript', ['-e', 'tell application "Obsidian" to activate']);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await frontmostApplicationName()) === 'Obsidian') return;
    await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, 100));
  }
  throw new Error('Obsidian did not become the foreground host for the local performance Gate.');
}

async function frontmostApplicationName() {
  try {
    const result = await executeFile('/usr/bin/osascript', [
      '-e',
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ]);
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function activeObsidianVaultPath() {
  try {
    const result = await executeFile('/usr/local/bin/obsidian', ['vault']);
    const row = result.stdout.split('\n').find((line) => line.startsWith('path\t'));
    return row?.slice('path\t'.length) ?? null;
  } catch {
    return null;
  }
}

async function waitForActiveObsidianVault(vaultRoot, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await activeObsidianVaultPath()) === vaultRoot) return;
    await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, 500));
  }
  throw new Error(`Obsidian did not activate the owned local performance Vault: ${vaultRoot}`);
}

/** The renderer pauses and discards its condition before requesting OS-level focus recovery. */
export async function recoverLocalObsidianForegroundIfRequested(status, activateForeground) {
  if (!isRecord(status) || status.status !== 'FOCUS_REQUIRED') return false;
  await activateForeground();
  return true;
}

async function waitForLocalCapture({ partialRawPath, rawPath, statusPath, timeoutMs }) {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastFocusRecovery = null;
  while (Date.now() - startedAt < timeoutMs) {
    const raw = await readJsonIfExists(rawPath);
    if (raw !== null) return raw;
    const status = await readJsonIfExists(statusPath);
    if (isRecord(status) && status.status === 'FAIL') {
      const partial = await readJsonIfExists(partialRawPath);
      if (partial !== null) return partial;
      throw new Error(
        typeof status.error === 'string' ? status.error : 'Real Obsidian local capture failed.',
      );
    }
    if (
      isRecord(status) &&
      status.status === 'FOCUS_REQUIRED' &&
      status.updatedAt !== lastFocusRecovery
    ) {
      await recoverLocalObsidianForegroundIfRequested(status, () =>
        activateObsidianForeground(10_000),
      );
      lastFocusRecovery = status.updatedAt;
    }
    if (Date.now() - lastProgressAt >= 60_000) {
      process.stdout.write(
        `S27R6 real Obsidian capture running (${Math.floor((Date.now() - startedAt) / 60_000)} min)\n`,
      );
      lastProgressAt = Date.now();
    }
    await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, 1_000));
  }
  throw new Error('Timed out waiting for the real Obsidian local performance capture.');
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function performanceMarkdown(result, rawPath) {
  const lines = [
    '# S27R6 Local Obsidian Performance Gate',
    '',
    `- Verdict: **${result.automatedVerdict}**`,
    `- Command: \`${result.command}\``,
    `- Obsidian: ${result.host.version}`,
    `- Build digest: \`${result.buildDigest}\``,
    `- Implementation digest: \`${result.implementationDigest}\``,
    `- Protocol digest: \`${result.protocolDigest}\``,
    `- Raw: \`${rawPath}\``,
    `- Independent host heartbeat observation: \`${JSON.stringify(result.hostHeartbeat)}\``,
    '',
    '| Budget | Status | Actual | Limit |',
    '| --- | --- | --- | --- |',
  ];
  for (const budgetResult of result.budgets) {
    lines.push(
      `| ${budgetResult.name} | ${budgetResult.status} | \`${JSON.stringify(budgetResult.actual)}\` | \`${JSON.stringify(budgetResult.limit)}\` |`,
    );
  }
  lines.push(
    '',
    '## Growing-history windows',
    '',
    '```json',
    JSON.stringify(result.strokeWindows, null, 2),
    '```',
    '',
  );
  return `${lines.join('\n')}\n`;
}

export function renderLocalObsidianSourceManifest(input) {
  return `# S27R6 Source Manifest

## Sources

- User decision on 2026-07-18: stop iPad Run 2/3; require a real installed Obsidian performance Gate before any physical marker; automate Pen/Highlighter, empty/1k/10k-30, writing/long-line/rapid-lift/viewport/cache and a five-minute soak; compress physical acceptance to at most four sessions.
- \`AGENTS.md\`, \`CONTEXT.md\`, and both 2026-07-17 native-feel specifications.
- Preserved failed iPad Run 1 under \`docs/delivery/slices/S27R5-ink-foundation-ipad-regate/attempts/20260718-pre-history-independent-hotpath-fix/\`.
- \`scripts/ink-local-obsidian-performance-gate.mjs\` and \`src/adapters/obsidian/ink-local-performance-gate.ts\`.

## Produced artifacts

- Machine report: \`${join(input.evidenceRoot, 'results.json')}\`
- Performance report: \`${join(input.evidenceRoot, 'performance.md')}\`
- Raw evidence: \`${input.storedRawPath}\`
- Source Manifest: \`${join(input.evidenceRoot, 'source-manifest.md')}\`

## Run identity

- Request: \`${input.requestId}\`
- Build digest: \`${input.buildDigest}\`
- Implementation digest: \`${input.implementationDigest}\`
- Protocol digest: \`${input.protocolDigest}\`
- Fixture digest: \`${input.fixtureDigest}\`
- Owned Vault: \`${input.vaultRoot}\`
- Raw evidence: \`${input.storedRawPath}\`

## Key decisions

- Real Obsidian and the production Canvas are mandatory; jsdom/Node evidence cannot satisfy this Gate.
- Any local failure blocks iPad marker generation. S27R6 PASS still does not claim Pencil delivery, iPad thermal, tip-to-display, or subjective product quality.
- No telemetry, external service, personal Vault, authored note content, coordinates, pressure, tilt, or geometry are exported.

## Verification evidence

- Command: \`${LOCAL_GATE_COMMAND}\`
- Verdict: \`${input.automatedVerdict}\`
- The machine report contains the per-budget verdicts, sample minimums, five-minute soak, bounded-memory evidence, and growing-history windows for this exact digest fence.

## Open questions / risks

- Physical Pencil delivery, iPad compositor/thermal behavior, >=240 fps tip/tail evidence, and Notes/Freeform comparison remain outside this local Gate and require the bounded four-session physical protocol.
`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isMissingFile(error) {
  return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function assertCaptureEnvelope(capture) {
  if (!isRecord(capture) || capture.schemaVersion !== 1) {
    throw new Error('Local Obsidian capture requires schemaVersion 1.');
  }
  requiredDigest(capture.buildDigest, 'build');
  requiredDigest(capture.fixtureDigest, 'fixture');
  requiredDigest(capture.implementationDigest, 'implementation');
  requiredDigest(capture.protocolDigest, 'protocol');
  const partial = capture.captureStatus === 'PARTIAL';
  if (
    !Array.isArray(capture.conditions) ||
    !isRecord(capture.host) ||
    (!partial && !isRecord(capture.soak)) ||
    (partial && (!isRecord(capture.failure) || capture.soak !== null))
  ) {
    throw new Error('Local Obsidian capture is missing conditions, host, or soak evidence.');
  }
  if (
    capture.host.kind !== 'obsidian-desktop' ||
    typeof capture.host.version !== 'string' ||
    typeof capture.host.productionCanvas !== 'boolean'
  ) {
    throw new Error('Local Gate requires explicit real Obsidian host provenance.');
  }
  for (const condition of capture.conditions) assertCondition(condition);
  if (partial) return;
  if (
    typeof capture.soak.durationMs !== 'number' ||
    !Array.isArray(capture.soak.tools) ||
    !isRecord(capture.soak.diagnostics) ||
    !isRecord(capture.soak.renderRuntime) ||
    capture.persistenceArchitecture !== 'explicit-commit-memory-first-cold-canonical'
  ) {
    throw new Error('Local Obsidian capture has malformed soak evidence.');
  }
  assertDiagnostics(capture.soak.diagnostics);
  assertRenderRuntimeEvidence(capture.soak.renderRuntime);
}

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...(await sourceFiles(path)));
    else if (/\.(?:ts|tsx)$/u.test(entry.name) && !/\.test\.(?:ts|tsx)$/u.test(entry.name)) {
      paths.push(path);
    }
  }
  return paths;
}

function assertCondition(condition) {
  if (
    !isRecord(condition) ||
    typeof condition.id !== 'string' ||
    !FIXTURES.includes(condition.fixture) ||
    !TOOLS.includes(condition.tool) ||
    ![...ACCEPTED_DRAWING_TRACES, 'viewport', 'cache-lifecycle'].includes(condition.trace) ||
    !isRecord(condition.diagnostics) ||
    !isRecord(condition.renderRuntime)
  ) {
    throw new Error('Local Obsidian capture contains a malformed condition.');
  }
  assertDiagnostics(condition.diagnostics);
  assertRenderRuntimeEvidence(condition.renderRuntime);
}

function assertRenderRuntimeEvidence(evidence) {
  if (!isRecord(evidence) || !isRecord(evidence.before) || !isRecord(evidence.after)) {
    throw new Error('Local Obsidian capture is missing render runtime evidence.');
  }
  for (const stats of [evidence.before, evidence.after]) {
    for (const key of [
      'backingStoreBytes',
      'backingStoreCount',
      'backingStoreDimensionMutationCount',
      'committedCompileCount',
      'compositorLayerCount',
      'rasterTileBytes',
      'rasterTileCount',
      'rasterTileEvictions',
      'rasterTileHits',
      'rasterTileMisses',
      'rasterTileRebuildCount',
      'visibleRecoveryRebuildCount',
    ]) {
      if (!Number.isSafeInteger(stats[key]) || stats[key] < 0) {
        throw new Error(`Local Obsidian render runtime requires non-negative ${key}.`);
      }
    }
    if (
      stats.visibleRecoveryRebuildReason !== null &&
      ![
        'backing-replacement',
        'canvas-context-restoration',
        'initial-document-install',
        'settled-projection',
        'unclassified-document-change',
      ].includes(stats.visibleRecoveryRebuildReason)
    ) {
      throw new Error('Local Obsidian render runtime has an unknown rebuild reason.');
    }
  }
}

function renderRuntimeWithinBounds(stats) {
  const viewportBytes = stats.backingStoreBytes / 3;
  return (
    stats.backingStoreCount === 3 &&
    stats.compositorLayerCount === 3 &&
    stats.rasterTileBytes <= Math.min(32 * MIB, viewportBytes * 1.5)
  );
}

function assertDiagnostics(diagnostics) {
  if (
    !Array.isArray(diagnostics.armedAuditGuards) ||
    !Array.isArray(diagnostics.auditedWork) ||
    !Array.isArray(diagnostics.recentSpans) ||
    !Array.isArray(diagnostics.forbiddenWork) ||
    !isRecord(diagnostics.frameIntervalsMs) ||
    !isRecord(diagnostics.memory)
  ) {
    throw new Error('Local Obsidian diagnostics are malformed.');
  }
  if (!Number.isSafeInteger(diagnostics.hangingSpanCount) || diagnostics.hangingSpanCount < 0) {
    throw new Error('Local Obsidian diagnostics require a non-negative hanging span count.');
  }
  if (!Number.isSafeInteger(diagnostics.openContactCount) || diagnostics.openContactCount < 0) {
    throw new Error('Local Obsidian diagnostics require a non-negative open contact count.');
  }
  if (!Number.isSafeInteger(diagnostics.droppedSpanCount) || diagnostics.droppedSpanCount < 0) {
    throw new Error('Local Obsidian diagnostics require a non-negative dropped span count.');
  }
  for (const key of ['activeWriting', 'hostGaps', 'idle']) {
    if (!Array.isArray(diagnostics.frameIntervalsMs[key])) {
      throw new Error(`Local Obsidian diagnostics are missing ${key} intervals.`);
    }
    finiteNumbers(diagnostics.frameIntervalsMs[key], key);
  }
  finiteNumbers(
    diagnostics.recentSpans.map((span) => span?.durationMs),
    'span durations',
  );
}

function hasRequiredCoverage(conditions) {
  const keys = new Set(conditions.map((item) => `${item.fixture}/${item.tool}/${item.trace}`));
  for (const fixture of FIXTURES) {
    for (const tool of TOOLS) {
      for (const trace of DRAWING_TRACES) {
        if (!keys.has(`${fixture}/${tool}/${trace}`)) return false;
      }
    }
  }
  for (const tool of TOOLS) {
    if (!keys.has(`history-10k-30-surfaces/${tool}/viewport`)) return false;
    if (!keys.has(`history-10k-30-surfaces/${tool}/cache-lifecycle`)) return false;
  }
  return true;
}

function hasSampleMinimums(conditions) {
  return (
    conditions.length === 10 &&
    conditions.every((condition) => {
      const spans = condition.diagnostics.recentSpans;
      const moves = acceptedSpans(spans, 'ink-input-handler', 'move').length;
      const commits = acceptedSpans(spans, 'ink-stroke-commit').filter(
        (span) => span.documentCommandProduced === true,
      ).length;
      const idle = condition.diagnostics.frameIntervalsMs.idle.length;
      const viewport = acceptedSpans(spans, 'ink-viewport-redraw').length;
      if (idle < 120) return false;
      if (DRAWING_TRACES.includes(condition.trace)) return moves >= 1_000 && commits >= 100;
      if (condition.trace === 'viewport') return viewport >= 5;
      return moves >= 200 && commits >= 20;
    })
  );
}

function viewportRedrawCounts(conditions) {
  return conditions
    .filter((condition) => condition.trace === 'viewport')
    .map((condition) => ({
      count: acceptedSpans(condition.diagnostics.recentSpans, 'ink-viewport-redraw').length,
      id: condition.id,
    }));
}

function viewportRedrawsAreCoalesced(conditions) {
  const counts = viewportRedrawCounts(conditions);
  return counts.length === 2 && counts.every(({ count }) => count >= 5 && count <= 8);
}

function minimumSamples(conditions) {
  const drawing = conditions.filter((condition) => DRAWING_TRACES.includes(condition.trace));
  const viewportConditions = conditions.filter((condition) => condition.trace === 'viewport');
  const minimum = {
    idle: Math.min(
      ...conditions.map((condition) => condition.diagnostics.frameIntervalsMs.idle.length),
    ),
    move: Math.min(
      ...drawing.map(
        (condition) =>
          acceptedSpans(condition.diagnostics.recentSpans, 'ink-input-handler', 'move').length,
      ),
    ),
    strokeCommit: Math.min(
      ...drawing.map(
        (condition) =>
          acceptedSpans(condition.diagnostics.recentSpans, 'ink-stroke-commit').filter(
            (span) => span.documentCommandProduced === true,
          ).length,
      ),
    ),
    viewport: Math.min(
      ...viewportConditions.map(
        (condition) =>
          acceptedSpans(condition.diagnostics.recentSpans, 'ink-viewport-redraw').length,
      ),
    ),
  };
  return Object.fromEntries(
    Object.entries(minimum).map(([name, value]) => [name, Number.isFinite(value) ? value : 0]),
  );
}

function historyDeltas(conditions) {
  const summaries = [];
  for (const tool of TOOLS) {
    for (const trace of DRAWING_TRACES) {
      const empty = conditions.find(
        (item) => item.fixture === 'empty' && item.tool === tool && item.trace === trace,
      );
      const history = conditions.find(
        (item) =>
          item.fixture === 'history-10k-30-surfaces' && item.tool === tool && item.trace === trace,
      );
      if (empty === undefined || history === undefined) continue;
      const emptyInput = distribution(
        acceptedSpans(empty.diagnostics.recentSpans, 'ink-input-handler', 'move'),
      ).p95Ms;
      const historyInput = distribution(
        acceptedSpans(history.diagnostics.recentSpans, 'ink-input-handler', 'move'),
      ).p95Ms;
      const emptyFrame = distribution(
        acceptedSpans(empty.diagnostics.recentSpans, 'ink-frame-work'),
      ).p95Ms;
      const historyFrame = distribution(
        acceptedSpans(history.diagnostics.recentSpans, 'ink-frame-work'),
      ).p95Ms;
      summaries.push({ emptyFrame, emptyInput, historyFrame, historyInput, tool, trace });
    }
  }
  return summaries;
}

function historyDeltaPasses(conditions) {
  const deltas = historyDeltas(conditions);
  return (
    deltas.length === TOOLS.length * DRAWING_TRACES.length &&
    deltas.every(
      (item) =>
        item.historyInput - item.emptyInput <= Math.max(1, item.emptyInput * 0.1) &&
        item.historyFrame - item.emptyFrame <= Math.max(1, item.emptyFrame * 0.1),
    )
  );
}

function buildStrokeWindows(spans) {
  const contacts = [
    ...new Set(spans.map((span) => span.contactSequence).filter(Number.isSafeInteger)),
  ].sort((left, right) => left - right);
  const windows = [];
  for (let offset = 0; offset < contacts.length; offset += 10) {
    const selected = new Set(contacts.slice(offset, offset + 10));
    const windowSpans = spans.filter((span) => selected.has(span.contactSequence));
    windows.push({
      commitP95Ms: distribution(acceptedSpans(windowSpans, 'ink-stroke-commit')).p95Ms,
      endStroke: Math.min(offset + 10, contacts.length),
      frameP95Ms: distribution(acceptedSpans(windowSpans, 'ink-frame-work')).p95Ms,
      inputP95Ms: distribution(acceptedSpans(windowSpans, 'ink-input-handler', 'move')).p95Ms,
      startStroke: offset + 1,
      submitP95Ms: distribution(acceptedSpans(windowSpans, 'ink-input-to-submit', 'move')).p95Ms,
    });
  }
  return windows;
}

function windowsRemainBounded(windows) {
  const trend = growingHistoryTrend(windows);
  return (
    trend.windowCount >= trend.minimumWindowCount &&
    trend.metrics.every((metric) => !metric.sustainedGrowth)
  );
}

function growingHistoryTrend(windows) {
  const minimumWindowCount = 6;
  const cohortSize = Math.min(10, Math.floor(windows.length / 3));
  const metricNames = ['commitP95Ms', 'frameP95Ms', 'inputP95Ms', 'submitP95Ms'];
  const metrics =
    cohortSize === 0
      ? []
      : metricNames.map((name) => {
          const values = windows.map((window) => window[name]);
          const earlyMedianMs = percentile(values.slice(0, cohortSize), 0.5);
          const lateMedianMs = percentile(values.slice(-cohortSize), 0.5);
          const allowedRiseMs = Math.max(1, earlyMedianMs * 0.1);
          const cohortDeltaMs = lateMedianMs - earlyMedianMs;
          const regressionTotalRiseMs = linearRegressionTotalRise(values);
          return {
            allowedRiseMs: round(allowedRiseMs),
            cohortDeltaMs: round(cohortDeltaMs),
            earlyMedianMs: round(earlyMedianMs),
            lateMedianMs: round(lateMedianMs),
            name,
            regressionTotalRiseMs: round(regressionTotalRiseMs),
            sustainedGrowth: cohortDeltaMs > allowedRiseMs && regressionTotalRiseMs > allowedRiseMs,
          };
        });
  return { cohortSize, metrics, minimumWindowCount, windowCount: windows.length };
}

function linearRegressionTotalRise(values) {
  if (values.length < 2) return 0;
  const meanX = (values.length - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const centeredX = index - meanX;
    numerator += centeredX * (values[index] - meanY);
    denominator += centeredX * centeredX;
  }
  return denominator === 0 ? 0 : (numerator / denominator) * (values.length - 1);
}

function hostHeartbeatSummary(conditions) {
  const observations = conditions.flatMap((condition) =>
    condition.diagnostics.frameIntervalsMs.hostGaps
      .filter((durationMs) => durationMs >= 50)
      .map((durationMs) => ({ conditionId: condition.id, durationMs })),
  );
  return {
    gapCountGte50Ms: observations.length,
    maximumMs: round(Math.max(0, ...observations.map(({ durationMs }) => durationMs))),
    observations,
  };
}

function memoryIsBounded(conditions, soak) {
  const memories = [...conditions, soak].map((value) => value.memory);
  return memories.every(
    (memory) =>
      finiteNonNegative(memory.activeWorkingSetBytes) &&
      finiteNonNegative(memory.backingStoreBytes) &&
      finiteNonNegative(memory.disposableCacheBytes) &&
      memory.backingStoreBytes <= 64 * MIB &&
      memory.disposableCacheBytes <= 32 * MIB,
  );
}

function memorySummary(diagnostics) {
  return diagnostics.reduce(
    (peaks, item) => ({
      activeWorkingSetBytes: Math.max(
        peaks.activeWorkingSetBytes,
        item.memory.activeWorkingSetBytes,
      ),
      backingStoreBytes: Math.max(peaks.backingStoreBytes, item.memory.backingStoreBytes),
      disposableCacheBytes: Math.max(peaks.disposableCacheBytes, item.memory.disposableCacheBytes),
    }),
    { activeWorkingSetBytes: 0, backingStoreBytes: 0, disposableCacheBytes: 0 },
  );
}

function missedFrameRatio(spans, refreshIntervalMs) {
  let expectedSlots = 0;
  let missedSlots = 0;
  for (const span of spans) {
    // rAF phase and timer quantization routinely place one submitted frame slightly above R.
    // The nearest refresh slot distinguishes that jitter from a genuinely missed frame.
    const slots = Math.max(1, Math.round(span.durationMs / refreshIntervalMs));
    expectedSlots += slots;
    missedSlots += Math.max(0, slots - 1);
  }
  return {
    expectedSlots,
    missedSlots,
    ratio: expectedSlots === 0 ? 1 : missedSlots / expectedSlots,
  };
}

function acceptedSpans(spans, name, inputPhase) {
  return spans.filter(
    (span) =>
      isRecord(span) &&
      span.accepted !== false &&
      span.name === name &&
      (inputPhase === undefined || span.inputPhase === inputPhase),
  );
}

function forbiddenHotPathViolations(diagnostics) {
  return diagnostics.flatMap((value) => value.forbiddenWork);
}

function collectArmedAuditGuards(diagnostics) {
  return [...new Set(diagnostics.flatMap((value) => value.armedAuditGuards))].sort();
}

function hasEvery(required, actual) {
  const values = new Set(actual);
  return required.every((value) => values.has(value));
}

function distribution(spans) {
  const values = spans.map((span) => span.durationMs).sort((left, right) => left - right);
  return {
    maximumMs: round(values.at(-1) ?? 0),
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    p99Ms: round(percentile(values, 0.99)),
    sampleCount: values.length,
  };
}

function budget(name, passed, details) {
  return { ...details, name, status: passed ? 'PASS' : 'FAIL' };
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1] ?? 0;
}

function requiredDigest(value, name) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`Local Obsidian capture has invalid ${name} digest.`);
  }
  return value;
}

function finiteNumbers(values, name) {
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new Error(`Local Obsidian capture has invalid ${name}.`);
  }
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const releaseWakeLock = startLocalGateWakeLock();
  try {
    const output = await runLocalObsidianPerformanceGate();
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (output.results.automatedVerdict !== 'PASS') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  } finally {
    releaseWakeLock();
  }
}
