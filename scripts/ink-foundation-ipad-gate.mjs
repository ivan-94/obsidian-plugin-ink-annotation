/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- CoreDevice and device-export JSON cross a runtime-validated system boundary. */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { assertCurrentLocalObsidianPass } from './ink-local-obsidian-performance-gate.mjs';

const executeFile = promisify(execFile);
const DEFAULT_FIXTURE_NAME = 's27-ink-foundation-ipad-gate';
const S27_CONDITIONS = Object.freeze({
  'session-1-empty-pen-highlighter': condition('S22 Ink Empty.md', [
    'Draw the fixed small-writing, slow-curve, fast-diagonal, long-line, rapid-lift, pressure-ramp, turn, and hairpin cards with Pen and Highlighter.',
    'Complete at least 100 strokes and 1,000 move batches while judging tip following, pressure/tilt response, jaggedness, pen-up continuity, and rapid next-stroke readiness.',
    'If drawing becomes obviously laggy or the iPad becomes noticeably hot, stop immediately and preserve this capture as FAIL.',
  ]),
  'session-2-history-10k-30-surfaces': condition('S22 Ink 10k 30 surfaces.md', [
    'Repeat the fixed Pen and Highlighter cards in the 10k-stroke / 30-surface worst case, including long lines and rapid lifts.',
    'Complete at least 100 strokes and 1,000 move batches; traverse enough surfaces to exercise bounded geometry and backing-store caches.',
    'If drawing becomes obviously laggy or the iPad becomes noticeably hot, stop immediately and preserve this capture as FAIL.',
  ]),
  'session-3-navigation-layout': condition('S22 Ink 10k 30 surfaces.md', [
    'Use one-finger scrolling and 50%, 100%, 150%, and Fit zoom, rotate portrait/landscape, enter and leave Split View, then continue drawing with Pen and Highlighter after every transition.',
    'Exercise cache create/evict/remount and background/foreground lifecycle without synthesizing Pencil or system navigation.',
    'If drawing becomes obviously laggy, navigation stops being native, or the iPad becomes noticeably hot, stop immediately and preserve this capture as FAIL.',
  ]),
  'session-4-stability-reference': condition(
    'S22 Ink 10k 30 surfaces.md',
    [
      'Draw continuously with alternating Pen and Highlighter fixed cards for 3–5 minutes while observing stability and temperature.',
      'Capture >=240 fps tip/tail video for the fixed comparison card; rAF timing must not be reported as display latency.',
      'If drawing becomes obviously laggy or the iPad becomes noticeably hot, stop immediately and preserve this capture as FAIL.',
    ],
    [
      'After exporting the Inkstone capture, alternate the same fixed card in Apple Notes and Freeform on the same iPad and record the required tester-authored comparison notes.',
    ],
  ),
});
const S27_HUMAN_CHECKPOINTS = Object.freeze([
  'Tip following',
  'Low-speed stability',
  'Pressure control',
  'Turn / hairpin behavior',
  'Legacy Highlighter behavior',
  'Jaggedness',
  'Pen-up continuity',
  'Rapid next-stroke readiness',
  'Native finger navigation',
  'Relative to Apple Notes',
  'Relative to Freeform',
]);
const S27_RUNTIME_CAPABILITY_NAMES = Object.freeze([
  'crossOriginIsolated',
  'dedicatedWorkerConstruct',
  'dedicatedWorkerModule',
  'navigatorGpu',
  'offscreenCanvas2d',
  'offscreenCanvasTransfer',
  'offscreenWebgl2',
  'pointerPredictedEvents',
  'sharedArrayBuffer',
  'wasm',
  'wasmSimd',
  'workerAnimationFrame',
]);
const S27_RUNTIME_CAPABILITY_FAILURES = new Set([
  'api-unavailable',
  'blob-module-unavailable',
  'construct-failed',
  'context-unavailable',
  'module-load-failed',
  'needs-active-probe',
  'not-isolated',
  'probe-failed',
  'probe-timeout',
  'transfer-failed',
  'validation-failed',
]);
const S27_LIVE_FIRST_AUDIT_GUARDS = Object.freeze([
  'canonical-cold-materialization',
  'draft-store-cold-write',
  'physical-finalize-no-recompile',
]);
const S27_LIVE_FIRST_AUDITED_WORK = new Set([
  'canonical-encode',
  'canonical-storage-write',
  'cold-snapshot',
  'draft-storage-write',
]);

function condition(note, actions, afterExportActions = []) {
  return Object.freeze({
    actions: Object.freeze([
      `Open ${note} and wait 10 seconds without touching the screen.`,
      'Run “Inkstone Annotations: Start S27 physical Gate capture” and wait for the ready notice.',
      ...actions,
      'Run “Inkstone Annotations: Export S27 physical Gate capture”.',
      ...afterExportActions,
    ]),
    runs: 1,
  });
}

/** Returns the bounded public physical protocol without exposing mutable runner internals. */
export function listS27PhysicalSessions() {
  return Object.entries(S27_CONDITIONS).map(([conditionId, definition]) => ({
    conditionId,
    runs: definition.runs,
  }));
}

/**
 * @typedef {{
 *   bootState: string,
 *   deviceDigest: string,
 *   iPadOS: string,
 *   model: string,
 *   pairingState: string,
 *   physical: true,
 *   productType: string,
 *   transport: string,
 *   tunnelState: string,
 * }} PhysicalIpadEvidence
 */

/**
 * Selects the one usable physical iPad while keeping the CoreDevice selector out of evidence.
 * @param {unknown} payload
 * @returns {{ evidence: PhysicalIpadEvidence, selector: string }}
 */
export function selectPhysicalIpad(payload) {
  const selected = selectPairedPhysicalIpad(payload);
  if (selected.evidence.bootState !== 'booted') {
    throw new Error('S27 requires the paired physical iPad to report bootState=booted.');
  }
  return selected;
}

/**
 * Selects the one paired physical iPad for read-only diagnostics. CoreDevice may omit bootState
 * while the device is paired; readiness reports that omission explicitly instead of losing all
 * safe device context behind a selection error.
 * @param {unknown} payload
 * @returns {{ evidence: PhysicalIpadEvidence, selector: string }}
 */
function selectPairedPhysicalIpad(payload) {
  const devices =
    isRecord(payload) && isRecord(payload.result) && Array.isArray(payload.result.devices)
      ? payload.result.devices
      : [];
  const candidates = devices.filter((candidate) => {
    if (!isRecord(candidate)) return false;
    const hardware = candidate.hardwareProperties;
    const device = candidate.deviceProperties;
    const connection = candidate.connectionProperties;
    return (
      isRecord(hardware) &&
      hardware.deviceType === 'iPad' &&
      hardware.platform === 'iOS' &&
      hardware.reality !== 'simulator' &&
      isRecord(device) &&
      isRecord(connection) &&
      connection.pairingState === 'paired' &&
      typeof candidate.identifier === 'string'
    );
  });
  if (candidates.length !== 1) {
    throw new Error(`S27 requires exactly one paired physical iPad; found ${candidates.length}.`);
  }
  const candidate = candidates[0];
  const hardware = /** @type {Record<string, unknown>} */ (candidate.hardwareProperties);
  const device = /** @type {Record<string, unknown>} */ (candidate.deviceProperties);
  const connection = /** @type {Record<string, unknown>} */ (candidate.connectionProperties);
  const productType = requiredString(hardware.productType, 'iPad product type');
  const model = optionalString(hardware.marketingName) ?? productType;
  const iPadOS = requiredString(device.osVersionNumber, 'iPadOS version');
  const digestInput = JSON.stringify({ iPadOS, model, productType });
  return {
    evidence: {
      bootState: optionalString(device.bootState) ?? 'unavailable',
      deviceDigest: sha256(digestInput),
      iPadOS,
      model,
      pairingState: requiredString(connection.pairingState, 'pairing state'),
      physical: true,
      productType,
      transport: optionalString(connection.transportType) ?? 'unknown',
      tunnelState: optionalString(connection.tunnelState) ?? 'unknown',
    },
    selector: /** @type {string} */ (candidate.identifier),
  };
}

/**
 * Runs the read-only S27 preflight. The CoreDevice selector stays in process memory and is never
 * returned in the JSON evidence.
 * @param {{ env?: NodeJS.ProcessEnv, projectRoot?: string }} [options]
 */
export async function inspectS27Readiness(options = {}) {
  const env = options.env ?? process.env;
  const projectRoot = resolve(options.projectRoot ?? env.INKSTONE_PROJECT_ROOT ?? process.cwd());
  const fixtureRoot = resolve(
    env.INKSTONE_S27_HAT_OUTPUT ?? join(projectRoot, '.hat', DEFAULT_FIXTURE_NAME),
  );
  const selected = selectPairedPhysicalIpad(await readDeviceList(env));
  const deviceEvidence = await enrichPhysicalIpadEvidence(
    selected.evidence,
    await readDeviceDetails(env, selected.selector),
  );
  const [plugin, fixture] = await Promise.all([
    inspectPluginBuild(projectRoot),
    inspectFixture(fixtureRoot),
  ]);
  const manual = {
    availableStorage: optionalString(env.INKSTONE_S27_AVAILABLE_STORAGE) ?? null,
    lowPowerMode: optionalString(env.INKSTONE_S27_LOW_POWER_MODE) ?? null,
    obsidianVersion: optionalString(env.INKSTONE_S27_OBSIDIAN_VERSION) ?? null,
    pencilModel: optionalString(env.INKSTONE_S27_PENCIL_MODEL) ?? null,
    refreshMode: optionalString(env.INKSTONE_S27_REFRESH_MODE) ?? null,
    tester: optionalString(env.INKSTONE_S27_TESTER) ?? null,
  };
  const missing = Object.entries(manual)
    .filter(([, value]) => value === null)
    .map(([name]) => name);
  if (deviceEvidence.bootState !== 'booted') missing.push('deviceBootState');
  if (plugin.status !== 'built') missing.push('pluginBuild');
  if (fixture.status !== 'prepared') missing.push('fixture');
  return {
    command: 'info',
    environment: {
      device: deviceEvidence,
      fixture,
      manual,
      plugin,
    },
    missing,
    schemaVersion: 1,
    status: missing.length === 0 ? 'READY' : 'INCOMPLETE',
  };
}

/**
 * Creates the checked-in S27 evidence skeleton. Human judgments are deliberately left pending and
 * are preserved when preparation is resumed.
 * @param {{ evidenceRoot: string, environment: unknown, protocolDigest: string }} input
 */
export async function initializeS27Evidence({ evidenceRoot, environment, protocolDigest }) {
  assertPrivacySafeEvidence(environment);
  await mkdir(join(evidenceRoot, 'raw'), { recursive: true });
  await Promise.all([
    writeFile(
      join(evidenceRoot, '.inkstone-s27-evidence-owned'),
      'Inkstone S27 generated evidence files\n',
      'utf8',
    ),
    writeJson(join(evidenceRoot, 'environment.json'), environment),
    writeJson(join(evidenceRoot, 'results.json'), {
      automatedVerdict: 'INCOMPLETE',
      conditions: [],
      protocolDigest,
      schemaVersion: 2,
    }),
    writeFile(
      join(evidenceRoot, 'performance.md'),
      [
        '# S27 physical-iPad performance evidence',
        '',
        'Automated verdict: **INCOMPLETE**.',
        '',
        'No physical condition has been analyzed yet.',
        '',
      ].join('\n'),
      'utf8',
    ),
    writeFile(
      join(evidenceRoot, 'risk-register.md'),
      [
        '# S27 risk register',
        '',
        '| Risk | Status | Evidence / next action |',
        '| --- | --- | --- |',
        '| Required physical samples or artifacts are missing | OPEN | Resume the assisted Gate; keep publication and production physical-v3 input blocked |',
        '',
      ].join('\n'),
      'utf8',
    ),
    writeFileIfMissing(
      join(evidenceRoot, 'human-report.md'),
      [
        '# S27 human acceptance report',
        '',
        'Tester must replace every `PENDING` with `PASS` or `FAIL` and add notes. Automation must not author these ratings.',
        '',
        '| Checkpoint | Rating | Notes |',
        '| --- | --- | --- |',
        ...S27_HUMAN_CHECKPOINTS.map((checkpoint) => `| ${checkpoint} | PENDING | |`),
        '',
      ].join('\n'),
    ),
  ]);
}

/**
 * Builds the production bundle, prepares only the owned synthetic fixture, and then writes the
 * resumable evidence skeleton. Installation/opening remains an explicit human handoff.
 * @param {{
 *   buildProduction?: () => Promise<void>,
 *   evidenceRoot: string,
 *   fixtureRoot: string,
 *   inspectReadiness?: () => Promise<unknown>,
 *   prepareFixture?: () => Promise<void>,
 *   projectRoot: string,
 *   protocolDigest: string,
 * }} input
 */
export async function prepareS27(input) {
  const buildProduction =
    input.buildProduction ??
    (async () => {
      await executeFile('npm', ['run', 'build'], {
        cwd: input.projectRoot,
        maxBuffer: 16 * 1024 * 1024,
      });
    });
  const prepareFixture =
    input.prepareFixture ??
    (async () => {
      await executeFile(
        process.execPath,
        [join(input.projectRoot, 'scripts', 'prepare-ink-performance-hat.mjs'), 'prepare'],
        {
          cwd: input.projectRoot,
          env: { ...process.env, INKSTONE_S22_HAT_OUTPUT: input.fixtureRoot },
          maxBuffer: 16 * 1024 * 1024,
        },
      );
    });
  const inspectReadiness =
    input.inspectReadiness ??
    (() =>
      inspectS27Readiness({
        env: { ...process.env, INKSTONE_S27_HAT_OUTPUT: input.fixtureRoot },
        projectRoot: input.projectRoot,
      }));

  await buildProduction();
  await prepareFixture();
  const readiness = await inspectReadiness();
  await initializeS27Evidence({
    environment: readiness,
    evidenceRoot: input.evidenceRoot,
    protocolDigest: input.protocolDigest,
  });
  return {
    command: 'prepare',
    gateStatus: isRecord(readiness) && readiness.status === 'READY' ? 'READY' : 'INCOMPLETE',
    handoff: {
      automaticInstall: false,
      vaultName: input.fixtureRoot.split('/').filter(Boolean).at(-1) ?? DEFAULT_FIXTURE_NAME,
    },
    status: 'MANUAL_HANDOFF',
  };
}

/** @param {string} projectRoot */
export async function computeS27ProtocolDigest(projectRoot) {
  const paths = [
    'scripts/ink-foundation-ipad-gate.mjs',
    'docs/specs/2026-07-17-ink-native-feel-execution-plan.md',
    'docs/specs/2026-07-17-ink-native-feel-performance-and-brush-fidelity.md',
    'docs/delivery/slices/S27-ink-foundation-ipad-gate/hat-guide.md',
  ];
  const hash = createHash('sha256');
  for (const path of paths) {
    const contents = await readFile(join(projectRoot, path));
    if (path.endsWith('/hat-guide.md')) {
      const text = contents.toString('utf8');
      const start = text.indexOf('<!-- HAT:BEGIN checklist -->');
      const endMarker = '<!-- HAT:END checklist -->';
      const end = text.indexOf(endMarker);
      if (start < 0 || end < start) throw new Error('S27 HAT guide is missing checklist markers.');
      hash
        .update(path)
        .update('\0')
        .update(text.slice(start, end + endMarker.length));
    } else {
      hash.update(path).update('\0').update(contents);
    }
  }
  return hash.digest('hex');
}

/**
 * Advances one resumable physical condition. This phase writes only the condition marker and human
 * action card; Pencil/system actions remain outside automation.
 * @param {{
 *   adapter?: 'pointer' | 'stylus-touch',
 *   conditionId: string,
 *   evidenceRoot: string,
 *   fixtureRoot: string,
 *   presentationAdapter?: 'main-canvas-2d' | 'worker-offscreen-2d',
 *   protocolDigest: string,
 *   readiness: unknown,
 * }} input
 */
export async function advanceS27Condition(input) {
  if (!isRecord(input.readiness) || input.readiness.status !== 'READY') {
    throw new Error('S27 run requires complete READY environment metadata.');
  }
  const conditionDefinition = S27_CONDITIONS[input.conditionId];
  if (conditionDefinition === undefined) {
    throw new Error(`Unknown S27 condition: ${input.conditionId}`);
  }
  const environment = input.readiness.environment;
  if (!isRecord(environment)) throw new Error('S27 readiness is missing environment metadata.');
  const fixture = environment.fixture;
  const device = environment.device;
  const plugin = environment.plugin;
  const manual = environment.manual;
  if (!isRecord(device) || !isRecord(fixture) || !isRecord(plugin) || !isRecord(manual)) {
    throw new Error('S27 readiness is missing build, fixture, or tester metadata.');
  }
  const [owned, fixtureManifest] = await Promise.all([
    fileExists(join(input.fixtureRoot, '.inkstone-hat-owned')),
    fileExists(join(input.fixtureRoot, '.inkstone-s22-performance-hat.json')),
  ]);
  if (!owned || !fixtureManifest) {
    throw new Error('S27 run refuses a fixture without both ownership markers.');
  }
  await mkdir(join(input.evidenceRoot, 'raw'), { recursive: true });
  assertPrivacySafeEvidence(input.readiness);
  const adapter = input.adapter ?? 'pointer';
  const presentationAdapter = requiredPresentationAdapter(
    input.presentationAdapter ?? 'main-canvas-2d',
  );
  const evidenceFence = {
    adapter,
    buildDigest: requiredDigest(plugin.buildDigest, 'plugin build'),
    conditionId: input.conditionId,
    deviceDigest: requiredDigest(device.deviceDigest, 'device'),
    fixtureDigest: requiredDigest(fixture.fixtureDigest, 'fixture'),
    presentationAdapter,
    protocolDigest: requiredDigest(input.protocolDigest, 'protocol'),
    schemaVersion: 2,
  };
  const completedRuns = await completedConditionRuns(
    join(input.evidenceRoot, 'raw'),
    evidenceFence,
    conditionDefinition.runs,
  );
  await writeJson(join(input.evidenceRoot, 'environment.json'), input.readiness);
  const runIndex = completedRuns.length + 1;
  if (runIndex > conditionDefinition.runs) {
    return {
      conditionId: input.conditionId,
      presentationAdapter,
      runCount: conditionDefinition.runs,
      status: 'COMPLETE',
    };
  }
  const marker = {
    ...evidenceFence,
    runIndex,
    tester: requiredString(manual.tester, 'tester'),
  };
  const capturePath = join(input.fixtureRoot, 'S27 Diagnostics.json');
  const captureContents = await readFileIfExists(capturePath);
  if (captureContents !== null) {
    const capture = JSON.parse(captureContents);
    assertPrivacySafeRawCapture(capture);
    if (isMatchingCapture(capture, marker)) {
      const artifactName = `${input.conditionId}-${adapter}-${presentationAdapter}-run-${runIndex}.json`;
      await writeFile(join(input.evidenceRoot, 'raw', artifactName), captureContents, 'utf8');
      return {
        artifactHash: sha256(captureContents),
        artifactName,
        conditionId: input.conditionId,
        presentationAdapter,
        runIndex,
        status: 'CAPTURED',
      };
    }
  }
  await writeJson(join(input.fixtureRoot, 'S27 Condition.json'), marker);
  return {
    actionCard: [...conditionDefinition.actions],
    conditionId: input.conditionId,
    presentationAdapter,
    runIndex,
    status: 'AWAITING_HUMAN',
  };
}

/** Deterministically evaluates one raw physical capture against the frozen S27 budgets. */
export function analyzeS27Capture(capture) {
  assertPrivacySafeRawCapture(capture);
  if (!isRecord(capture)) {
    throw new Error('Invalid S27 capture envelope.');
  }
  if (capture.schemaVersion !== 2) {
    throw new Error('S27 analyzer requires raw schemaVersion 2.');
  }
  if (!isRecord(capture.condition) || capture.condition.schemaVersion !== 2) {
    throw new Error('S27 analyzer requires condition schemaVersion 2.');
  }
  assertS27ConditionMarker(capture.condition);
  const runtimeCapabilities = assertS27RuntimeCapabilities(capture.runtimeCapabilities);
  if (
    capture.condition.presentationAdapter === 'worker-offscreen-2d' &&
    (!runtimeCapabilities.dedicatedWorkerConstruct.available ||
      !runtimeCapabilities.offscreenCanvas2d.available ||
      !runtimeCapabilities.offscreenCanvasTransfer.available)
  ) {
    throw new Error('S27 Worker presentation artifact lacks required runtime capabilities.');
  }
  const diagnostics = capture.diagnostics;
  const longTasks = capture.longTasks;
  if (!isRecord(diagnostics) || !isRecord(longTasks)) {
    throw new Error('S27 capture is missing diagnostics or Long Task evidence.');
  }
  const frameIntervals = diagnostics.frameIntervalsMs;
  const memory = diagnostics.memory;
  if (!isRecord(frameIntervals) || !isRecord(memory)) {
    throw new Error('S27 capture is missing frame or memory evidence.');
  }
  const idle = finiteNumbers(frameIntervals.idle, 'diagnostics.frameIntervalsMs.idle');
  const active = finiteNumbers(
    frameIntervals.activeWriting,
    'diagnostics.frameIntervalsMs.activeWriting',
  );
  const hostGaps = finiteNumbers(frameIntervals.hostGaps, 'diagnostics.frameIntervalsMs.hostGaps');
  const allSpans = Array.isArray(diagnostics.recentSpans)
    ? diagnostics.recentSpans.filter(isRecord)
    : [];
  const spans = allSpans.filter((sample) => sample.accepted !== false);
  const forbidden = Array.isArray(diagnostics.forbiddenWork)
    ? diagnostics.forbiddenWork.filter(isRecord)
    : [];
  const armedAuditGuards = Array.isArray(diagnostics.armedAuditGuards)
    ? diagnostics.armedAuditGuards.filter((guard) => typeof guard === 'string')
    : [];
  const auditedWork = Array.isArray(diagnostics.auditedWork)
    ? diagnostics.auditedWork.filter(isRecord)
    : [];
  const adapter = capture.condition.adapter;
  if (allSpans.some((sample) => sample.workPhase === 'input' && sample.adapter !== adapter)) {
    throw new Error('Malformed S27 input span adapter evidence.');
  }
  const named = (name, workPhase, inputPhase) =>
    spans.filter(
      (sample) =>
        sample.name === name &&
        sample.workPhase === workPhase &&
        (sample.adapter === adapter || (workPhase !== 'input' && sample.adapter === undefined)) &&
        (inputPhase === undefined || sample.inputPhase === inputPhase),
    );
  const namedIncludingTerminalOutcomes = (name, workPhase) =>
    allSpans.filter(
      (sample) =>
        sample.name === name &&
        sample.workPhase === workPhase &&
        (sample.adapter === adapter || (workPhase !== 'input' && sample.adapter === undefined)),
    );
  const inputHandlers = named('ink-input-handler', 'input', 'move');
  const frameWork = named('ink-frame-work', 'active-frame');
  const inputToSubmit = named('ink-input-to-submit', 'input');
  const inputToSubmitOutcomes = namedIncludingTerminalOutcomes('ink-input-to-submit', 'input');
  const commits = named('ink-stroke-commit', 'completion');
  const draftSubmits = named('ink-draft-persistence-submit', 'cold');
  const canonicalSubmits = named('ink-canonical-persistence-submit', 'cold');
  const persistenceSubmits = allSpans.filter(
    (sample) =>
      sample.name === 'ink-draft-persistence-submit' ||
      sample.name === 'ink-canonical-persistence-submit',
  );
  const recoveryJournals = allSpans.filter((sample) => sample.name === 'ink-recovery-journal');
  const viewports = named('ink-viewport-redraw', 'viewport');
  const distributions = {
    canonicalSubmit: durationDistribution(canonicalSubmits),
    draftSubmit: durationDistribution(draftSubmits),
    frameWork: durationDistribution(frameWork),
    inputHandler: durationDistribution(inputHandlers),
    inputToSubmit: durationDistribution(inputToSubmit),
    strokeCommit: durationDistribution(commits),
    viewport: durationDistribution(viewports),
  };
  const refresh = durationDistribution(idle);
  const frameLanes = {
    activeGenerationDebt: durationDistribution(active),
    hostGap: durationDistribution(hostGaps),
    idleHeartbeat: refresh,
  };
  const rMs = refresh.p50Ms;
  const failedBudgets = [];
  const fail = (condition, budget) => {
    if (condition) failedBudgets.push(budget);
  };

  fail(idle.length < 120, 'idle-rAF-samples>=120');
  fail(!Array.isArray(frameIntervals.hostGaps), 'host-gap-evidence-present');
  fail(inputHandlers.length < 1_000, 'move-batches>=1000');
  fail(commits.length < 100, 'completed-strokes>=100');
  fail(rMs <= 0, 'measured-R>0');
  fail(
    distributions.inputHandler.p95Ms > 2 || distributions.inputHandler.p99Ms > 4,
    'ink-input-handler:P95<=2ms,P99<=4ms',
  );
  fail(
    distributions.frameWork.p95Ms > 8 || distributions.frameWork.p99Ms > 12,
    'ink-frame-work:P95<=8ms,P99<=12ms',
  );
  fail(
    distributions.inputToSubmit.p50Ms > rMs ||
      distributions.inputToSubmit.p95Ms > rMs + 8 ||
      distributions.inputToSubmit.p99Ms > 2 * rMs,
    'ink-input-to-submit:P50<=R,P95<=R+8ms,P99<=2R',
  );
  fail(
    inputToSubmitOutcomes.some(
      (sample) =>
        sample.presentationOutcome !== 'cancelled' &&
        sample.presentationOutcome !== 'submitted' &&
        sample.presentationOutcome !== 'superseded' &&
        sample.presentationOutcome !== 'unpresented',
    ),
    'ink-input-to-submit:presentation-outcome-present',
  );
  fail(
    inputToSubmitOutcomes.some((sample) =>
      sample.presentationOutcome === 'submitted'
        ? sample.accepted !== true
        : sample.accepted !== false,
    ),
    'ink-input-to-submit:presentation-outcome-consistent',
  );
  fail(
    inputToSubmitOutcomes.some((sample) => sample.presentationOutcome === 'superseded'),
    'ink-input-to-submit:zero-superseded-batches',
  );
  fail(inputToSubmit.length < 1_000, 'ink-input-to-submit:submitted-batches>=1000');
  fail(
    inputToSubmitOutcomes.some(
      (sample) =>
        !Number.isSafeInteger(sample.contactSequence) ||
        sample.contactSequence <= 0 ||
        !Number.isSafeInteger(sample.batchSequence) ||
        sample.batchSequence <= 0 ||
        !Number.isSafeInteger(sample.requestedGeneration) ||
        sample.requestedGeneration <= 0 ||
        (sample.presentationOutcome === 'submitted'
          ? sample.submittedGeneration !== sample.requestedGeneration
          : sample.submittedGeneration !== null),
    ),
    'ink-input-to-submit:generation-ownership-valid',
  );
  const terminalBatchKeys = inputToSubmitOutcomes.map(
    (sample) => `${String(sample.contactSequence)}:${String(sample.batchSequence)}`,
  );
  fail(
    new Set(terminalBatchKeys).size !== terminalBatchKeys.length,
    'ink-input-to-submit:one-terminal-outcome-per-batch',
  );
  fail(
    !hasCompleteTerminalBatchSequences(inputToSubmitOutcomes),
    'ink-input-to-submit:terminal-sequence-complete',
  );
  fail(distributions.strokeCommit.p95Ms >= 16.7, 'ink-stroke-commit:P95<16.7ms');
  fail(
    viewports.length === 0 || distributions.viewport.p95Ms >= 16.7,
    'ink-viewport-redraw:P95<16.7ms',
  );
  fail(
    commits.some((sample) => typeof sample.documentCommandProduced !== 'boolean'),
    'ink-stroke-commit:document-command-outcome-present',
  );
  fail(
    !Number.isSafeInteger(diagnostics.droppedSpanCount) || diagnostics.droppedSpanCount !== 0,
    'diagnostics:dropped-span-count=0',
  );
  fail(
    S27_LIVE_FIRST_AUDIT_GUARDS.some((guard) => !armedAuditGuards.includes(guard)),
    'live-first:all-hot-path-audit-guards-armed',
  );
  fail(
    auditedWork.length === 0 ||
      auditedWork.some(
        (counter) =>
          counter.phase !== 'cold' ||
          !S27_LIVE_FIRST_AUDITED_WORK.has(counter.kind) ||
          !Number.isSafeInteger(counter.count) ||
          counter.count <= 0,
      ) ||
      persistenceSubmits.some((sample) => sample.workPhase !== 'cold'),
    'live-first:persistence-work-cold-only',
  );
  fail(recoveryJournals.length !== 0, 'live-first:zero-recovery-journal-writes');
  fail(
    forbidden.length !== 0 || persistenceSubmits.some((sample) => sample.workPhase !== 'cold'),
    'forbidden-active-work=0',
  );
  fail(
    draftSubmits.length === 0 ||
      persistenceSubmits.some(
        (sample) => sample.name === 'ink-draft-persistence-submit' && sample.accepted !== true,
      ) ||
      distributions.draftSubmit.p99Ms > 4,
    'ink-draft-persistence-submit:P99<=4ms',
  );
  fail(
    canonicalSubmits.length === 0 ||
      persistenceSubmits.some(
        (sample) => sample.name === 'ink-canonical-persistence-submit' && sample.accepted !== true,
      ) ||
      distributions.canonicalSubmit.p99Ms > 12,
    'ink-canonical-persistence-submit:P99<=12ms',
  );
  fail(
    finiteNumber(memory.disposableCacheBytes, Number.POSITIVE_INFINITY) > 32 * 1024 * 1024,
    'disposable-cache<=32MiB-per-mount',
  );
  fail(
    diagnostics.hangingSpanCount !== undefined && diagnostics.hangingSpanCount !== 0,
    'hanging-span-count=0',
  );
  fail(
    diagnostics.openContactCount !== undefined && diagnostics.openContactCount !== 0,
    'open-contact-count=0',
  );
  const longTaskDurations = finiteNumbers(longTasks.durationsMs, 'longTasks.durationsMs');
  const qualifyingHostGaps = hostGaps.filter((duration) => duration >= 50);
  fail(
    longTasks.available === true && longTaskDurations.some((duration) => duration >= 50),
    'zero->=50ms-long-tasks',
  );
  fail(longTasks.available !== true && qualifyingHostGaps.length > 0, 'zero->=50ms-host-gaps');
  const expectedFrames =
    rMs <= 0
      ? 0
      : active.reduce((total, interval) => total + Math.max(1, Math.ceil(interval / rMs)), 0);
  const missedFrames =
    rMs <= 0
      ? Number.POSITIVE_INFINITY
      : active.reduce((total, interval) => total + Math.max(0, Math.ceil(interval / rMs) - 1), 0);
  const missedFrameRatio =
    expectedFrames <= 0 ? Number.POSITIVE_INFINITY : missedFrames / expectedFrames;
  fail(missedFrameRatio >= 0.01, 'missed-frame-ratio<1%');

  return {
    condition: { ...capture.condition },
    failedBudgets,
    metrics: {
      distributions,
      frameLanes,
      hostGapCount: qualifyingHostGaps.length,
      longTaskApiAvailable: longTasks.available === true,
      longTaskCount: longTaskDurations.filter((duration) => duration >= 50).length,
      memory: { ...memory },
      missedFrameRatio: roundFinite(missedFrameRatio),
      refresh: {
        p10Ms: refresh.p10Ms,
        p50Ms: refresh.p50Ms,
        p90Ms: refresh.p90Ms,
        rMs,
      },
    },
    sampleCounts: {
      activeFrames: active.length,
      completedStrokes: commits.length,
      hostGapSamples: hostGaps.length,
      idleFrames: idle.length,
      moveBatches: inputHandlers.length,
      submittedBatches: inputToSubmit.length,
      cancelledBatches: inputToSubmitOutcomes.filter(
        (sample) => sample.presentationOutcome === 'cancelled',
      ).length,
      supersededBatches: inputToSubmitOutcomes.filter(
        (sample) => sample.presentationOutcome === 'superseded',
      ).length,
      unpresentedBatches: inputToSubmitOutcomes.filter(
        (sample) => sample.presentationOutcome === 'unpresented',
      ).length,
    },
    runtimeCapabilities,
    verdict: failedBudgets.length === 0 ? 'PASS' : 'FAIL',
  };
}

/**
 * Reads only captured raw artifacts and writes a deterministic aggregate verdict.
 * @param {{ evidenceRoot: string, protocolDigest: string }} input
 */
export async function analyzeS27Evidence({ evidenceRoot, protocolDigest }) {
  const currentProtocolDigest = requiredDigest(protocolDigest, 'current protocol');
  const rawRoot = join(evidenceRoot, 'raw');
  await mkdir(rawRoot, { recursive: true });
  const artifactNames = (await readdir(rawRoot)).filter((name) => name.endsWith('.json')).sort();
  const artifacts = [];
  for (const artifactName of artifactNames) {
    const contents = await readFile(join(rawRoot, artifactName), 'utf8');
    artifacts.push({ artifactName, capture: JSON.parse(contents), contents });
  }
  const rawSchemaVersions = [
    ...new Set(
      artifacts.map(({ capture }) => (isRecord(capture) ? capture.schemaVersion : undefined)),
    ),
  ];
  if (rawSchemaVersions.length > 1) {
    throw new Error(
      `S27 evidence mixes raw schema versions: ${rawSchemaVersions.map(String).sort().join(', ')}.`,
    );
  }
  const conditionSchemaVersions = [
    ...new Set(
      artifacts.map(({ capture }) =>
        isRecord(capture) && isRecord(capture.condition)
          ? capture.condition.schemaVersion
          : undefined,
      ),
    ),
  ];
  if (conditionSchemaVersions.length > 1) {
    throw new Error(
      `S27 evidence mixes condition schema versions: ${conditionSchemaVersions.map(String).sort().join(', ')}.`,
    );
  }
  const rawBuildDigest = uniformConditionField(artifacts, 'buildDigest', 'build');
  const rawDeviceDigest = uniformConditionField(artifacts, 'deviceDigest', 'device');
  const rawFixtureDigest = uniformConditionField(artifacts, 'fixtureDigest', 'fixture');
  const rawPresentationAdapter = uniformPresentationAdapter(artifacts);
  const rawProtocolDigest = uniformConditionField(artifacts, 'protocolDigest', 'protocol');
  const existingProtocolDigest = await readExistingProtocolDigest(
    join(evidenceRoot, 'results.json'),
  );
  if (
    rawProtocolDigest !== null &&
    existingProtocolDigest !== null &&
    rawProtocolDigest !== existingProtocolDigest
  ) {
    throw new Error('S27 raw protocol digest does not match results.json.');
  }
  if (rawProtocolDigest !== null && rawProtocolDigest !== currentProtocolDigest) {
    throw new Error('S27 raw protocol digest does not match the current protocol.');
  }
  if (existingProtocolDigest !== null && existingProtocolDigest !== currentProtocolDigest) {
    throw new Error('S27 results protocol digest does not match the current protocol.');
  }
  const captures = [];
  for (const { artifactName, capture, contents } of artifacts) {
    const analysis = analyzeS27Capture(capture);
    captures.push({ artifactHash: sha256(contents), artifactName, ...analysis });
  }
  const required = Object.entries(S27_CONDITIONS).flatMap(([conditionId, definition]) =>
    Array.from(
      { length: definition.runs },
      (_value, index) =>
        `${conditionId}:pointer:${rawPresentationAdapter ?? 'main-canvas-2d'}:${index + 1}`,
    ),
  );
  const captured = new Set(
    captures.map(
      ({ condition }) =>
        `${condition.conditionId}:${condition.adapter}:${condition.presentationAdapter}:${condition.runIndex}`,
    ),
  );
  const missing = required.filter((key) => !captured.has(key));
  const failed = captures.filter(({ verdict }) => verdict === 'FAIL');
  const automatedVerdict = failed.length > 0 ? 'FAIL' : missing.length > 0 ? 'INCOMPLETE' : 'PASS';
  const humanReport = await readFileIfExists(join(evidenceRoot, 'human-report.md'));
  const human = analyzeHumanReport(humanReport);
  const gateVerdict =
    automatedVerdict === 'FAIL' || human.failed > 0
      ? 'FAIL'
      : automatedVerdict === 'PASS' && human.complete
        ? 'PASS'
        : 'INCOMPLETE';
  const result = {
    automatedVerdict,
    buildDigest: rawBuildDigest,
    captures,
    deviceDigest: rawDeviceDigest,
    fixtureDigest: rawFixtureDigest,
    gateVerdict,
    human,
    missingConditions: missing,
    presentationAdapter: rawPresentationAdapter,
    protocolDigest: currentProtocolDigest,
    schemaVersion: 2,
  };
  await Promise.all([
    writeJson(join(evidenceRoot, 'results.json'), result),
    writeFile(join(evidenceRoot, 'performance.md'), renderPerformanceReport(result), 'utf8'),
  ]);
  return {
    automatedVerdict,
    capturedArtifactCount: captures.length,
    command: 'analyze',
    failedArtifactCount: failed.length,
    gateVerdict,
    missingConditionCount: missing.length,
    presentationAdapter: rawPresentationAdapter,
    status: 'COMPLETE',
  };
}

/** @param {{ fixtureRoot: string, projectRoot: string }} input */
export async function cleanupS27(input) {
  const result = await executeFile(
    process.execPath,
    [join(input.projectRoot, 'scripts', 'prepare-ink-performance-hat.mjs'), 'cleanup'],
    {
      cwd: input.projectRoot,
      env: { ...process.env, INKSTONE_S22_HAT_OUTPUT: input.fixtureRoot },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return {
    command: 'cleanup',
    fixtureRemoved: result.stdout.includes('status=not-prepared'),
    status: 'COMPLETE',
  };
}

/** @param {NodeJS.ProcessEnv} env */
async function readDeviceList(env) {
  const fixturePath = optionalString(env.INKSTONE_S27_DEVICE_LIST_JSON);
  if (fixturePath !== undefined) return JSON.parse(await readFile(fixturePath, 'utf8'));
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-devices-'));
  const outputPath = join(temporaryRoot, 'devices.json');
  try {
    await executeFile('xcrun', ['devicectl', 'list', 'devices', '--json-output', outputPath], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(await readFile(outputPath, 'utf8'));
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

/** @param {NodeJS.ProcessEnv} env @param {string} selector */
async function readDeviceDetails(env, selector) {
  const fixturePath = optionalString(env.INKSTONE_S27_DEVICE_DETAILS_JSON);
  if (fixturePath !== undefined) return JSON.parse(await readFile(fixturePath, 'utf8'));
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-device-'));
  const outputPath = join(temporaryRoot, 'device.json');
  try {
    await executeFile(
      'xcrun',
      ['devicectl', 'device', 'info', 'details', '--device', selector, '--json-output', outputPath],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return JSON.parse(await readFile(outputPath, 'utf8'));
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

/** @param {PhysicalIpadEvidence} evidence @param {unknown} payload */
async function enrichPhysicalIpadEvidence(evidence, payload) {
  if (!isRecord(payload) || !isRecord(payload.result)) return evidence;
  const hardware = payload.result.hardwareProperties;
  const device = payload.result.deviceProperties;
  const connection = payload.result.connectionProperties;
  if (isRecord(hardware) && hardware.reality === 'simulator') {
    throw new Error('S27 rejects Simulator device details.');
  }
  return {
    ...evidence,
    ...(isRecord(device) && optionalString(device.bootState) !== undefined
      ? { bootState: optionalString(device.bootState) }
      : {}),
    ...(isRecord(device) && optionalString(device.developerModeStatus) !== undefined
      ? { developerMode: optionalString(device.developerModeStatus) }
      : {}),
    ...(isRecord(device) && optionalString(device.releaseType) !== undefined
      ? { releaseType: optionalString(device.releaseType) }
      : {}),
    ...(isRecord(connection) && optionalString(connection.tunnelState) !== undefined
      ? { tunnelState: optionalString(connection.tunnelState) }
      : {}),
  };
}

/** @param {string} projectRoot */
async function inspectPluginBuild(projectRoot) {
  try {
    const files = await Promise.all(
      ['main.js', 'manifest.json', 'styles.css'].map(async (name) => ({
        contents: await readFile(join(projectRoot, name)),
        name,
      })),
    );
    const digest = createHash('sha256');
    for (const file of files) digest.update(file.name).update('\0').update(file.contents);
    return { buildDigest: digest.digest('hex'), status: 'built' };
  } catch (error) {
    if (isMissingFile(error)) return { buildDigest: null, status: 'not-built' };
    throw error;
  }
}

/** @param {string} fixtureRoot */
async function inspectFixture(fixtureRoot) {
  try {
    const [owner, manifest] = await Promise.all([
      readFile(join(fixtureRoot, '.inkstone-hat-owned')),
      readFile(join(fixtureRoot, '.inkstone-s22-performance-hat.json')),
    ]);
    const digest = createHash('sha256').update(owner).update('\0').update(manifest).digest('hex');
    return { fixtureDigest: digest, status: 'prepared' };
  } catch (error) {
    if (isMissingFile(error)) return { fixtureDigest: null, status: 'not-prepared' };
    throw error;
  }
}

/** @param {string} path @param {unknown} value */
async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** @param {string} path @param {string} contents */
async function writeFileIfMissing(path, contents) {
  try {
    await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (!isRecord(error) || error.code !== 'EEXIST') throw error;
  }
}

/** @param {unknown} value */
function assertPrivacySafeEvidence(value) {
  const forbiddenKeys = new Set([
    'accountIdentifier',
    'deviceName',
    'ecid',
    'hostname',
    'identifier',
    'serialNumber',
    'udid',
    'userVaultPath',
  ]);
  const visit = (candidate) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (forbiddenKeys.has(key)) throw new Error(`S27 evidence forbids identifying field: ${key}`);
      visit(nested);
    }
  };
  visit(value);
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {unknown} value */
function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** @param {unknown} value @param {string} label */
function requiredString(value, label) {
  const parsed = optionalString(value);
  if (parsed === undefined) throw new Error(`Missing ${label}.`);
  return parsed;
}

/** @param {string} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} error */
function isMissingFile(error) {
  return isRecord(error) && error.code === 'ENOENT';
}

/** @param {string} path */
async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

/** @param {string} path */
async function readFileIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/** @param {string | null} report */
function analyzeHumanReport(report) {
  if (report === null || report.trim().length === 0) {
    return {
      complete: false,
      failed: 0,
      passed: 0,
      pending: S27_HUMAN_CHECKPOINTS.length,
    };
  }
  const rows = [...report.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/gmu)]
    .map((match) => ({
      checkpoint: match[1].trim(),
      notes: match[3].trim(),
      rating: match[2].trim(),
    }))
    .filter(({ checkpoint }) => checkpoint !== 'Checkpoint' && !/^-+$/u.test(checkpoint));
  const fixedRows = rows.filter(({ checkpoint }) => S27_HUMAN_CHECKPOINTS.includes(checkpoint));
  const unexpectedRows = rows.filter(
    ({ checkpoint }) => !S27_HUMAN_CHECKPOINTS.includes(checkpoint),
  );
  const outcomes = S27_HUMAN_CHECKPOINTS.map((checkpoint) =>
    fixedRows.filter((row) => row.checkpoint === checkpoint),
  );
  const pending = outcomes.filter(
    (checkpointRows) =>
      checkpointRows.length !== 1 ||
      !['PASS', 'FAIL'].includes(checkpointRows[0].rating) ||
      checkpointRows[0].notes.length === 0,
  ).length;
  return {
    complete: unexpectedRows.length === 0 && pending === 0,
    failed: fixedRows.filter(({ rating }) => rating === 'FAIL').length,
    passed: outcomes.filter(
      (checkpointRows) =>
        checkpointRows.length === 1 &&
        checkpointRows[0].rating === 'PASS' &&
        checkpointRows[0].notes.length > 0,
    ).length,
    pending,
  };
}

/** @param {string} path */
async function readExistingProtocolDigest(path) {
  const contents = await readFileIfExists(path);
  if (contents === null) return null;
  try {
    const parsed = JSON.parse(contents);
    return isRecord(parsed) && typeof parsed.protocolDigest === 'string'
      ? parsed.protocolDigest
      : null;
  } catch {
    return null;
  }
}

/** @param {Record<string, unknown>} result */
function renderPerformanceReport(result) {
  const captures = Array.isArray(result.captures) ? result.captures : [];
  const lines = [
    '# S27 physical-iPad performance evidence',
    '',
    `Automated verdict: **${String(result.automatedVerdict)}**.`,
    `Gate verdict: **${String(result.gateVerdict)}**.`,
    '',
    '| Artifact | Condition | Run | Input Adapter | Presentation Adapter | Verdict | R | Host gaps | Missed frames | Failed budgets |',
    '| --- | --- | ---: | --- | --- | --- | ---: | ---: | ---: | --- |',
  ];
  for (const capture of captures) {
    if (!isRecord(capture) || !isRecord(capture.condition) || !isRecord(capture.metrics)) continue;
    const refresh = isRecord(capture.metrics.refresh) ? capture.metrics.refresh : {};
    lines.push(
      `| ${String(capture.artifactName)} | ${String(capture.condition.conditionId)} | ${String(capture.condition.runIndex)} | ${String(capture.condition.adapter)} | ${String(capture.condition.presentationAdapter)} | ${String(capture.verdict)} | ${String(refresh.rMs ?? '')} ms | ${String(capture.metrics.hostGapCount ?? '')} | ${String(capture.metrics.missedFrameRatio ?? '')} | ${Array.isArray(capture.failedBudgets) ? capture.failedBudgets.join(', ') : ''} |`,
    );
  }
  lines.push(
    '',
    'Missing required captures keep the Gate `INCOMPLETE`; thresholds are not editable.',
    '',
  );
  return lines.join('\n');
}

/**
 * @param {string} rawRoot
 * @param {Record<string, unknown>} evidenceFence
 * @param {number} maximumRuns
 */
async function completedConditionRuns(rawRoot, evidenceFence, maximumRuns) {
  const prefix = `${String(evidenceFence.conditionId)}-${String(evidenceFence.adapter)}-${String(evidenceFence.presentationAdapter)}-run-`;
  const rootFenceFields = [
    'adapter',
    'buildDigest',
    'deviceDigest',
    'fixtureDigest',
    'presentationAdapter',
    'protocolDigest',
    'schemaVersion',
  ];
  const candidates = [];
  for (const name of (await readdir(rawRoot)).filter((candidate) => candidate.endsWith('.json'))) {
    const capture = JSON.parse(await readFile(join(rawRoot, name), 'utf8'));
    if (!isRecord(capture) || capture.schemaVersion !== 2 || !isRecord(capture.condition)) {
      throw new Error('S27 existing condition runs do not match the current evidence fence.');
    }
    assertS27ConditionMarker(capture.condition);
    if (rootFenceFields.some((field) => capture.condition[field] !== evidenceFence[field])) {
      throw new Error('S27 existing condition runs do not match the current evidence fence.');
    }
    if (capture.condition.conditionId !== evidenceFence.conditionId) continue;
    const runIndex = Number(
      name.startsWith(prefix) ? name.slice(prefix.length, -'.json'.length) : 0,
    );
    if (
      !Number.isInteger(runIndex) ||
      runIndex < 1 ||
      runIndex > maximumRuns ||
      capture.condition.runIndex !== runIndex ||
      name !== `${prefix}${String(runIndex)}.json`
    ) {
      throw new Error('S27 existing condition runs do not match the current evidence fence.');
    }
    let analysis;
    try {
      analysis = analyzeS27Capture(capture);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`S27 captured run ${String(runIndex)} is invalid: ${message}`, {
        cause: error,
      });
    }
    if (analysis.verdict !== 'PASS') {
      throw new Error(
        `S27 captured run ${String(runIndex)} failed its frozen budgets: ${analysis.failedBudgets.join(', ')}.`,
      );
    }
    candidates.push({ name, runIndex });
  }
  candidates.sort((left, right) => left.runIndex - right.runIndex);
  const runs = candidates.map(({ runIndex }) => runIndex);
  if (runs.some((runIndex, index) => runIndex !== index + 1)) {
    throw new Error('S27 existing condition runs are not a complete prefix.');
  }
  return runs;
}

/** @param {unknown} capture @param {Record<string, unknown>} marker */
function isMatchingCapture(capture, marker) {
  if (!isRecord(capture) || capture.schemaVersion !== 2 || !isRecord(capture.condition)) {
    return false;
  }
  return Object.entries(marker).every(([key, value]) => capture.condition[key] === value);
}

/** @param {unknown} value */
function assertPrivacySafeRawCapture(value) {
  const forbidden = new Set([
    'color',
    'coordinate',
    'deviceId',
    'fileContent',
    'filePath',
    'geometry',
    'noteContent',
    'path',
    'points',
    'pressure',
    'tilt',
    'x',
    'y',
  ]);
  const visit = (candidate) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (forbidden.has(key))
        throw new Error(`S27 raw diagnostics contain forbidden field: ${key}`);
      visit(nested);
    }
  };
  visit(value);
}

/** @param {unknown} value @param {string} label */
function requiredDigest(value, label) {
  const parsed = requiredString(value, `${label} digest`);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) throw new Error(`Invalid ${label} digest.`);
  return parsed;
}

/**
 * @param {readonly { capture: unknown }[]} artifacts
 * @param {string} field
 * @param {string} label
 */
function uniformConditionField(artifacts, field, label) {
  const values = [
    ...new Set(
      artifacts.map(({ capture }) =>
        isRecord(capture) && isRecord(capture.condition) ? capture.condition[field] : undefined,
      ),
    ),
  ];
  if (values.length > 1) throw new Error(`S27 evidence mixes ${label} digests.`);
  return values.length === 1 && typeof values[0] === 'string' ? values[0] : null;
}

/** @param {readonly { capture: unknown }[]} artifacts */
function uniformPresentationAdapter(artifacts) {
  const values = [
    ...new Set(
      artifacts.map(({ capture }) =>
        isRecord(capture) && isRecord(capture.condition)
          ? requiredPresentationAdapter(capture.condition.presentationAdapter)
          : requiredPresentationAdapter(undefined),
      ),
    ),
  ];
  if (values.length > 1) throw new Error('S27 evidence mixes presentation Adapters.');
  return values[0] ?? null;
}

/** @param {Record<string, unknown>} marker */
function assertS27ConditionMarker(marker) {
  requiredDigest(marker.buildDigest, 'build');
  requiredDigest(marker.deviceDigest, 'device');
  requiredDigest(marker.fixtureDigest, 'fixture');
  requiredDigest(marker.protocolDigest, 'protocol');
  const conditionId = requiredString(marker.conditionId, 'condition ID');
  const definition = S27_CONDITIONS[conditionId];
  if (definition === undefined) throw new Error(`Unknown S27 condition: ${conditionId}`);
  if (marker.adapter !== 'pointer' && marker.adapter !== 'stylus-touch') {
    throw new Error('Invalid S27 condition adapter.');
  }
  requiredPresentationAdapter(marker.presentationAdapter);
  if (
    !Number.isSafeInteger(marker.runIndex) ||
    marker.runIndex < 1 ||
    marker.runIndex > definition.runs
  ) {
    throw new Error('Invalid S27 condition run index.');
  }
  requiredString(marker.tester, 'tester');
}

/** @param {unknown} value */
function assertS27RuntimeCapabilities(value) {
  if (!isRecord(value)) {
    throw new Error('S27 capture is missing complete runtime capability evidence.');
  }
  const normalized = {};
  for (const name of S27_RUNTIME_CAPABILITY_NAMES) {
    const outcome = value[name];
    if (!isRecord(outcome)) {
      throw new Error('S27 capture is missing complete runtime capability evidence.');
    }
    const available = outcome.available;
    const failureCategory = outcome.failureCategory;
    if (
      typeof available !== 'boolean' ||
      typeof failureCategory !== 'string' ||
      (available
        ? failureCategory !== 'none'
        : !S27_RUNTIME_CAPABILITY_FAILURES.has(failureCategory))
    ) {
      throw new Error(`Malformed S27 runtime capability evidence: ${name}.`);
    }
    normalized[name] = { available, failureCategory };
  }
  return normalized;
}

/** @param {unknown} value */
function requiredPresentationAdapter(value) {
  if (value === 'main-canvas-2d' || value === 'worker-offscreen-2d') return value;
  throw new Error('Invalid S27 condition presentation Adapter.');
}

/** @param {readonly Record<string, unknown>[]} samples */
function hasCompleteTerminalBatchSequences(samples) {
  const sequencesByContact = new Map();
  for (const sample of samples) {
    if (
      !Number.isSafeInteger(sample.contactSequence) ||
      sample.contactSequence <= 0 ||
      !Number.isSafeInteger(sample.batchSequence) ||
      sample.batchSequence <= 0
    ) {
      return false;
    }
    const adapter = typeof sample.adapter === 'string' ? sample.adapter : '';
    const key = `${adapter}:${String(sample.contactSequence)}`;
    const sequences = sequencesByContact.get(key) ?? new Set();
    sequences.add(sample.batchSequence);
    sequencesByContact.set(key, sequences);
  }
  for (const sequences of sequencesByContact.values()) {
    const maximum = Math.max(...sequences);
    if (sequences.size !== maximum) return false;
  }
  return true;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function finiteNumbers(value, label) {
  if (!Array.isArray(value)) return [];
  if (value.some((candidate) => typeof candidate !== 'number' || !Number.isFinite(candidate))) {
    throw new Error(`Malformed S27 numeric evidence: ${label}.`);
  }
  return [...value];
}

/** @param {readonly unknown[]} samples */
function durationDistribution(samples) {
  const values = samples
    .map((sample) =>
      typeof sample === 'number'
        ? sample
        : isRecord(sample) && typeof sample.durationMs === 'number'
          ? sample.durationMs
          : Number.NaN,
    )
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  return {
    maximumMs: roundFinite(values.at(-1) ?? 0),
    p10Ms: roundFinite(percentile(values, 0.1)),
    p50Ms: roundFinite(percentile(values, 0.5)),
    p90Ms: roundFinite(percentile(values, 0.9)),
    p95Ms: roundFinite(percentile(values, 0.95)),
    p99Ms: roundFinite(percentile(values, 0.99)),
    sampleCount: values.length,
  };
}

/** @param {readonly number[]} sorted @param {number} quantile */
function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? 0;
}

/** @param {unknown} value @param {number} fallback */
function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** @param {number} value */
function roundFinite(value) {
  return Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2] ?? 'info';
  try {
    const projectRoot = resolve(process.env.INKSTONE_PROJECT_ROOT ?? process.cwd());
    const fixtureRoot = resolve(
      process.env.INKSTONE_S27_HAT_OUTPUT ?? join(projectRoot, '.hat', DEFAULT_FIXTURE_NAME),
    );
    const evidenceRoot = resolve(
      process.env.INKSTONE_S27_EVIDENCE_ROOT ??
        join(projectRoot, 'docs', 'delivery', 'slices', 'S27-ink-foundation-ipad-gate'),
    );
    let result;
    if (command === 'info') {
      result = await inspectS27Readiness({ projectRoot });
    } else if (command === 'prepare') {
      result = await prepareS27({
        evidenceRoot,
        fixtureRoot,
        projectRoot,
        protocolDigest: await computeS27ProtocolDigest(projectRoot),
      });
    } else if (command === 'cleanup') {
      result = await cleanupS27({ fixtureRoot, projectRoot });
    } else if (command === 'run') {
      const conditionId = process.argv[3];
      if (conditionId === undefined) {
        throw new Error('Usage: prepare.sh run <condition> [main-canvas-2d|worker-offscreen-2d]');
      }
      await assertCurrentLocalObsidianPass({ projectRoot });
      result = await advanceS27Condition({
        conditionId,
        evidenceRoot,
        fixtureRoot,
        presentationAdapter:
          process.argv[4] ?? process.env.INKSTONE_S27_PRESENTATION_ADAPTER ?? undefined,
        protocolDigest: await computeS27ProtocolDigest(projectRoot),
        readiness: await inspectS27Readiness({ projectRoot }),
      });
    } else if (command === 'analyze') {
      result = await analyzeS27Evidence({
        evidenceRoot,
        protocolDigest: await computeS27ProtocolDigest(projectRoot),
      });
    } else {
      throw new Error(`Unsupported S27 command: ${command}`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
