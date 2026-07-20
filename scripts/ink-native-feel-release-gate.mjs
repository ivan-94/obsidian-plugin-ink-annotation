/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- The CLI reads runtime-validated JSON evidence and supports injected JavaScript system-boundary functions for isolated tests. */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  advanceS27Condition,
  analyzeS27Evidence,
  initializeS27Evidence,
  inspectS27Readiness,
  listS27PhysicalSessions,
} from './ink-foundation-ipad-gate.mjs';
import { assertCurrentLocalObsidianPass } from './ink-local-obsidian-performance-gate.mjs';

const executeFile = promisify(execFile);
const S27_EVIDENCE_MARKER = '.inkstone-s27-evidence-owned';
const FIXTURE_OWNERSHIP_MARKERS = Object.freeze([
  '.inkstone-hat-owned',
  '.inkstone-s22-performance-hat.json',
]);
const REQUIRED_WORKER_CAPABILITIES = Object.freeze([
  'dedicatedWorkerConstruct',
  'offscreenCanvas2d',
  'offscreenCanvasTransfer',
]);
const PRODUCT_CONDITIONS = Object.freeze({
  'session-1-empty-pen-highlighter': Object.freeze([
    'In the blank Foundation session, use Pen for small writing, slow curves, fast diagonals, pressure ramps, turns, hairpins, pen-up, and rapid next strokes.',
    'In the same session, use Highlighter for tilt sweeps, upright lines, self-overlap, distinct-stroke crossings, seams, taps, and surface boundaries.',
    'Record the fixed Pen and Highlighter human ratings once; do not repeat the cards three times.',
  ]),
  'session-2-history-10k-30-surfaces': Object.freeze([
    'In the 10k-stroke / 30-surface Foundation session, repeat the Pen and Highlighter fixed cards once in the worst-case history.',
    'Judge only hardware, compositor, thermal, and visual behavior that local deterministic replay cannot prove.',
    'Stop immediately on obvious lag or noticeable heating; do not continue to fill a matrix.',
  ]),
  'session-3-navigation-layout': Object.freeze([
    'In the navigation Foundation session, scroll, zoom, rotate, enter Split View, and continue Pen and Highlighter drawing after every transition.',
    'Record native finger-navigation and layout continuity observations once.',
    'Compatibility, export, Legacy Recovery read-only migration, and data-safety checks remain automated local artifacts and are not repeated by the tester.',
  ]),
  'session-4-stability-reference': Object.freeze([
    'In the stability Foundation session, draw for 3–5 minutes and stop immediately on obvious lag or noticeable heating.',
    'After exporting the Inkstone capture, alternate the fixed card once across Inkstone, Apple Notes, and Freeform on the same iPad.',
    'Capture and index the required >=240 fps comparison artifacts, then record tester-authored relative and release-decision notes.',
  ]),
});

/** Returns the one shared four-session protocol used by Foundation and product acceptance. */
export function listUnifiedPhysicalSessions() {
  const foundationIds = listS27PhysicalSessions().map(({ conditionId }) => conditionId);
  const productIds = Object.keys(PRODUCT_CONDITIONS);
  if (
    foundationIds.length !== productIds.length ||
    foundationIds.some((conditionId, index) => conditionId !== productIds[index])
  ) {
    throw new Error('S27 Foundation and S34 product physical session plans diverged.');
  }
  return [...foundationIds];
}

const REQUIRED_HUMAN_CHECKPOINTS = Object.freeze([
  'Pen tip following',
  'Pen low-speed stability',
  'Pen pressure control',
  'Pen fast thinning',
  'Pen turn / hairpin behavior',
  'Pen jaggedness',
  'Pen-up continuity',
  'Rapid next-stroke readiness',
  'Highlighter tilt direction',
  'Highlighter upright stability',
  'Highlighter self-overlap density',
  'Highlighter distinct-stroke crossing',
  'Highlighter boundary seam / tap',
  'Native finger navigation',
  'Mixed legacy / physical appearance',
  'Eraser / Select / Move / Undo / Redo',
  'Layout / zoom / rotation / Split View',
  'Preview / Raw / summary / rebase',
  'SVG / PNG / HTML parity',
  'Recovery / data-safety UX',
  'Relative to Apple Notes',
  'Relative to Freeform',
  'Overall no obvious tier regression',
  'Tester / session metadata',
  'Unresolved limitations recorded',
  'Explicit release recommendation',
]);
const REQUIRED_AUTOMATED_CHECKS = Object.freeze([
  'adapterProvenance',
  'brushGoldens',
  'calibrationDiff',
  'consumerParity',
  'physicalHatBuild',
  'privacyAudit',
  'rasterOracle',
  'repositoryGate',
]);
const REQUIRED_COMPATIBILITY_CHECKS = Object.freeze([
  'canonicalFailureRetention',
  'iCloudSchemaConflict',
  'legacyV1V2NoWrite',
  'legacyRecoveryReadOnlyMigration',
  'mixedLegacyPhysical',
  'releasedOldBinaryFailClosed',
  'rollbackRehearsal',
  'schemaV3FirstCommandAtomic',
  'unknownVersionFailClosed',
]);
const REFERENCE_ARTIFACTS = Object.freeze(
  ['inkstone', 'notes', 'freeform'].map((application) => ({
    application,
    artifactId: `${application}-run-1`,
    runIndex: 1,
  })),
);

/** Returns the three videos captured inside physical session 4, not additional sessions. */
export function listRequiredReferenceArtifacts() {
  return REFERENCE_ARTIFACTS.map(({ artifactId }) => artifactId);
}

/**
 * Initializes separate S27R5 Adapter evidence and the S34 release-Gate envelope. Existing human
 * files are preserved, so re-running preparation cannot erase manual observations.
 */
export async function initializeUnifiedReleaseEvidence({
  environment,
  protocolDigest,
  s27MainEvidenceRoot,
  s27WorkerEvidenceRoot,
  s34EvidenceRoot,
}) {
  await Promise.all([
    initializeS27EvidenceIfMissing({
      environment,
      evidenceRoot: s27MainEvidenceRoot,
      protocolDigest,
    }),
    initializeS27EvidenceIfMissing({
      environment,
      evidenceRoot: s27WorkerEvidenceRoot,
      protocolDigest,
    }),
    mkdir(s34EvidenceRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFileIfMissing(
      `${s34EvidenceRoot}/automated-gate.json`,
      json({
        checks: {},
        evidenceManifestSha256: null,
        schemaVersion: 1,
        verdict: 'INCOMPLETE',
      }),
    ),
    writeFileIfMissing(
      `${s34EvidenceRoot}/automated-evidence-manifest.json`,
      json({ artifacts: [], schemaVersion: 1 }),
    ),
    writeFileIfMissing(
      `${s34EvidenceRoot}/compatibility-report.json`,
      json({
        checks: {},
        evidenceManifestSha256: null,
        releasedOldBinary: {
          binarySha256: null,
          resultArtifactSha256: null,
          verdict: 'INCOMPLETE',
          version: null,
        },
        schemaVersion: 1,
        verdict: 'INCOMPLETE',
      }),
    ),
    writeFileIfMissing(
      `${s34EvidenceRoot}/compatibility-evidence-manifest.json`,
      json({ artifacts: [], schemaVersion: 1 }),
    ),
    writeFileIfMissing(
      `${s34EvidenceRoot}/artifact-index.json`,
      json({ artifacts: [], schemaVersion: 1, verdict: 'INCOMPLETE' }),
    ),
    writeFileIfMissing(
      `${s34EvidenceRoot}/adapter-decision.json`,
      json({
        capabilityEvidenceDigest: null,
        diagnosticsOnOff: 'INCOMPLETE',
        diagnosticsEvidenceDigest: null,
        mainWorkerAb: 'INCOMPLETE',
        mainWorkerAbEvidenceDigest: null,
        schemaVersion: 1,
        selectedAdapter: null,
        verdict: 'INCOMPLETE',
        workerDisposition: 'INCOMPLETE',
        workerReasonCategories: [],
      }),
    ),
    writeFileIfMissing(`${s34EvidenceRoot}/human-report.md`, renderPendingHumanReport()),
    writeFileIfMissing(
      `${s34EvidenceRoot}/results.json`,
      json({ schemaVersion: 1, verdict: 'INCOMPLETE' }),
    ),
  ]);
}

/**
 * Builds the acceptance-only bundle and prepares a dedicated owned synthetic Vault. Existing Gate
 * evidence is resumable: a repeated prepare refreshes the build but never rewrites captured or
 * human-authored results.
 */
export async function prepareUnifiedPhysicalGate(input) {
  const buildPhysicalHat =
    input.buildPhysicalHat ??
    (async (env) => {
      await executeFile('npm', ['run', 'build:physical-hat'], {
        cwd: input.projectRoot,
        env,
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
  const inspectReadiness = input.inspectReadiness;
  if (typeof inspectReadiness !== 'function') {
    throw new Error('Unified physical Gate preparation requires a readiness inspector.');
  }

  const markerState = await fixtureMarkerState(input.fixtureRoot);
  if (markerState === 'partial') {
    throw new Error(
      'Refusing partially marked physical HAT fixture. Run cleanup after inspection.',
    );
  }
  if (markerState === 'absent' && (await directoryEntries(input.fixtureRoot)).length > 0) {
    throw new Error('Refusing a non-empty fixture directory without an ownership marker.');
  }
  await buildPhysicalHat({
    ...process.env,
    INKSTONE_UNPUBLISHED_PHYSICAL_INK_HAT: '1',
  });
  if (markerState === 'absent') await prepareFixture();
  if (markerState === 'owned') {
    const refreshFixture =
      input.refreshFixture ??
      (input.buildPhysicalHat === undefined
        ? async () => {
            const pluginRoot = join(
              input.fixtureRoot,
              '.obsidian',
              'plugins',
              'inkstone-annotations',
            );
            await mkdir(pluginRoot, { recursive: true });
            await Promise.all(
              ['main.js', 'manifest.json', 'styles.css'].map((name) =>
                cp(join(input.projectRoot, name), join(pluginRoot, name)),
              ),
            );
          }
        : async () => {});
    await refreshFixture();
  }
  if ((await fixtureMarkerState(input.fixtureRoot)) !== 'owned') {
    throw new Error('Physical HAT preparation did not produce an owned synthetic fixture.');
  }

  const readiness = await inspectReadiness();
  await initializeUnifiedReleaseEvidence({
    environment: readiness,
    protocolDigest: input.protocolDigest,
    s27MainEvidenceRoot: input.s27MainEvidenceRoot,
    s27WorkerEvidenceRoot: input.s27WorkerEvidenceRoot,
    s34EvidenceRoot: input.s34EvidenceRoot,
  });
  return {
    command: 'prepare',
    fixture: markerState === 'owned' ? 'reused-owned-synthetic' : 'prepared-owned-synthetic',
    gateStatus: isRecord(readiness) && readiness.status === 'READY' ? 'READY' : 'INCOMPLETE',
    mode: 'blank',
    publication: 'blocked',
    status: 'MANUAL_HANDOFF',
  };
}

/** Removes only the dedicated fixture. Gate evidence is intentionally outside cleanup scope. */
export async function cleanupUnifiedPhysicalGate(input) {
  if ((await readTextIfPresent(join(input.fixtureRoot, FIXTURE_OWNERSHIP_MARKERS[0]))) === null) {
    throw new Error('Refusing cleanup without the Inkstone HAT ownership marker.');
  }
  const cleanupFixture =
    input.cleanupFixture ??
    (async () => {
      await executeFile(
        process.execPath,
        [join(input.projectRoot, 'scripts', 'prepare-ink-performance-hat.mjs'), 'cleanup'],
        {
          cwd: input.projectRoot,
          env: { ...process.env, INKSTONE_S22_HAT_OUTPUT: input.fixtureRoot },
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    });
  await cleanupFixture();
  if ((await readTextIfPresent(join(input.fixtureRoot, FIXTURE_OWNERSHIP_MARKERS[0]))) !== null) {
    throw new Error('Owned physical HAT fixture still exists after cleanup.');
  }
  return {
    command: 'cleanup',
    fixture: 'removed-owned-synthetic',
    status: 'COMPLETE',
  };
}

/** Writes a privacy-safe checkpoint for one human-only S34 condition card. */
export async function selectProductCondition({ conditionId, fixtureRoot }) {
  const actions = PRODUCT_CONDITIONS[conditionId];
  if (actions === undefined)
    throw new Error(`Unknown S34 product condition: ${String(conditionId)}`);
  if ((await fixtureMarkerState(fixtureRoot)) !== 'owned') {
    throw new Error('S34 product condition requires the owned synthetic fixture.');
  }
  await writeFile(
    join(fixtureRoot, 'S34 Condition.json'),
    json({ conditionId, schemaVersion: 1 }),
    'utf8',
  );
  return {
    actionCard: [...actions],
    conditionId,
    status: 'AWAITING_HUMAN',
  };
}

/** Hashes the fixed unified protocol. Manual report edits and generated results are excluded. */
export async function computeUnifiedGateProtocolDigest(projectRoot) {
  const protocolPaths = [
    'scripts/ink-foundation-ipad-gate.mjs',
    'scripts/ink-native-feel-release-gate.mjs',
    'docs/specs/2026-07-17-ink-native-feel-execution-plan.md',
    'docs/specs/2026-07-17-ink-native-feel-performance-and-brush-fidelity.md',
    'docs/delivery/slices/S27R5-ink-foundation-ipad-regate/hat-guide.md',
    'docs/delivery/slices/S34-ink-native-feel-release-gate/hat-guide.md',
    ...Object.keys(PRODUCT_CONDITIONS).map(
      (conditionId) =>
        `docs/delivery/slices/S34-ink-native-feel-release-gate/condition-cards/${conditionId}.md`,
    ),
  ];
  const hash = createHash('sha256');
  for (const relativePath of protocolPaths) {
    const contents = await readFile(join(projectRoot, relativePath));
    hash.update(relativePath).update('\0').update(contents).update('\0');
  }
  return hash.digest('hex');
}

/** Reads the four mandatory evidence classes. Missing or pending evidence is always INCOMPLETE. */
export async function analyzeUnifiedReleaseGate({
  protocolDigest,
  s27MainEvidenceRoot,
  s27WorkerEvidenceRoot,
  s34EvidenceRoot,
}) {
  if (typeof protocolDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(protocolDigest)) {
    throw new Error('Unified release Gate requires the current protocol digest.');
  }
  const [
    foundation,
    workerFoundation,
    adapterDecision,
    automated,
    automatedManifest,
    compatibility,
    compatibilityManifest,
    artifactIndex,
    humanReport,
  ] = await Promise.all([
    readJsonIfPresent(`${s27MainEvidenceRoot}/results.json`),
    s27WorkerEvidenceRoot === undefined
      ? Promise.resolve(null)
      : readJsonIfPresent(`${s27WorkerEvidenceRoot}/results.json`),
    readJsonIfPresent(`${s34EvidenceRoot}/adapter-decision.json`),
    readJsonIfPresent(`${s34EvidenceRoot}/automated-gate.json`),
    readTextIfPresent(`${s34EvidenceRoot}/automated-evidence-manifest.json`),
    readJsonIfPresent(`${s34EvidenceRoot}/compatibility-report.json`),
    readTextIfPresent(`${s34EvidenceRoot}/compatibility-evidence-manifest.json`),
    readJsonIfPresent(`${s34EvidenceRoot}/artifact-index.json`),
    readTextIfPresent(`${s34EvidenceRoot}/human-report.md`),
  ]);
  const automatedEvidenceVerdict = evidenceGateVerdict(
    automated,
    REQUIRED_AUTOMATED_CHECKS,
    automatedManifest,
  );
  const referenceVerdict = referenceArtifactVerdict(artifactIndex);
  const compatibilityEvidenceVerdict = evidenceGateVerdict(
    compatibility,
    REQUIRED_COMPATIBILITY_CHECKS,
    compatibilityManifest,
    ['releasedOldBinary'],
  );
  const capabilityFoundation =
    isRecord(foundation) && Array.isArray(foundation.captures) && foundation.captures.length > 0
      ? foundation
      : workerFoundation;
  const adapter = adapterDecisionVerdict({
    adapterDecision,
    foundation: capabilityFoundation,
    protocolDigest,
    workerFoundation,
  });
  const selectedFoundationGate =
    adapter.selectedAdapter === 'worker-offscreen-2d'
      ? physicalFoundationVerdict(workerFoundation, 'worker-offscreen-2d', protocolDigest)
      : adapter.selectedAdapter === 'main-canvas-2d'
        ? physicalFoundationVerdict(foundation, 'main-canvas-2d', protocolDigest)
        : 'INCOMPLETE';
  const result = {
    adapterGate: adapter.verdict,
    automatedGate: combineVerdicts([automatedEvidenceVerdict, referenceVerdict]),
    compatibilityGate: combineVerdicts([
      compatibilityEvidenceVerdict,
      releasedOldBinaryVerdict(compatibility, compatibilityManifest),
    ]),
    foundationGate: combineVerdicts([selectedFoundationGate, adapter.verdict]),
    humanGate: humanVerdict(humanReport),
    referenceArtifacts: referenceVerdict,
    schemaVersion: 1,
    verdict: 'INCOMPLETE',
    workerCapability: adapter.workerCapability,
    workerGate: adapter.workerGate,
  };
  const gateValues = [
    result.foundationGate,
    result.automatedGate,
    result.compatibilityGate,
    result.humanGate,
  ];
  result.verdict = combineVerdicts(gateValues);
  await writeFile(`${s34EvidenceRoot}/results.json`, json(result), 'utf8');
  return result;
}

/**
 * Hashes one human-captured >=240 fps reference artifact. The source path is used only for this
 * call and is never persisted or returned.
 */
export async function recordReferenceArtifact({
  artifactId,
  frameRate,
  s34EvidenceRoot,
  sourcePath,
  strokeCount,
}) {
  const definition = REFERENCE_ARTIFACTS.find((candidate) => candidate.artifactId === artifactId);
  if (definition === undefined)
    throw new Error(`Unknown reference artifact ID: ${String(artifactId)}`);
  if (!Number.isFinite(frameRate) || frameRate < 240) {
    throw new Error('Reference artifact frame rate must be at least 240 fps.');
  }
  if (!Number.isSafeInteger(strokeCount) || strokeCount < 20) {
    throw new Error('Reference artifact must contain at least 20 strokes.');
  }
  const contents = await readFile(sourcePath);
  const recorded = {
    application: definition.application,
    artifactId: definition.artifactId,
    frameRate,
    runIndex: definition.runIndex,
    sha256: createHash('sha256').update(contents).digest('hex'),
    sizeBytes: contents.byteLength,
    strokeCount,
  };
  const path = `${s34EvidenceRoot}/artifact-index.json`;
  const current = await readJsonIfPresent(path);
  const existing = isRecord(current) && Array.isArray(current.artifacts) ? current.artifacts : [];
  if (existing.some((artifact) => !isSafeReferenceArtifactShape(artifact))) {
    throw new Error('Reference artifact index contains unsafe or malformed metadata.');
  }
  const artifacts = [
    ...existing.filter((artifact) => !isArtifactId(artifact, artifactId)),
    recorded,
  ].sort((left, right) => referenceArtifactOrder(left) - referenceArtifactOrder(right));
  await writeFile(
    path,
    json({
      artifacts,
      schemaVersion: 1,
      verdict: hasCompleteReferenceArtifacts(artifacts) ? 'PASS' : 'INCOMPLETE',
    }),
    'utf8',
  );
  return recorded;
}

/** Hashes one prerequisite result into a path-free per-report evidence manifest. */
export async function recordGateCheckArtifact({ checkId, gate, s34EvidenceRoot, sourcePath }) {
  const definitions =
    gate === 'automated'
      ? REQUIRED_AUTOMATED_CHECKS
      : gate === 'compatibility'
        ? REQUIRED_COMPATIBILITY_CHECKS
        : null;
  if (definitions === null)
    throw new Error('Gate check artifact must target automated or compatibility.');
  if (!definitions.includes(checkId)) {
    throw new Error(`Unknown ${gate} Gate check: ${String(checkId)}`);
  }
  const contents = await readFile(sourcePath);
  const recorded = {
    checkId,
    sha256: createHash('sha256').update(contents).digest('hex'),
    sizeBytes: contents.byteLength,
  };
  const manifestPath = join(s34EvidenceRoot, `${gate}-evidence-manifest.json`);
  const current = await readJsonIfPresent(manifestPath);
  const existing = isRecord(current) && Array.isArray(current.artifacts) ? current.artifacts : [];
  if (existing.some((artifact) => !isSafeGateCheckArtifactShape(artifact))) {
    throw new Error(`${gate} evidence manifest contains unsafe or malformed metadata.`);
  }
  const artifacts = [
    ...existing.filter((artifact) => !isCheckId(artifact, checkId)),
    recorded,
  ].sort((left, right) => definitions.indexOf(left.checkId) - definitions.indexOf(right.checkId));
  const manifestText = json({ artifacts, schemaVersion: 1 });
  await writeFile(manifestPath, manifestText, 'utf8');
  const reportPath = join(
    s34EvidenceRoot,
    gate === 'automated' ? 'automated-gate.json' : 'compatibility-report.json',
  );
  const report = await readJsonIfPresent(reportPath);
  if (!isRecord(report)) throw new Error(`Missing ${gate} Gate report.`);
  await writeFile(
    reportPath,
    json({
      ...report,
      evidenceManifestSha256: createHash('sha256').update(manifestText).digest('hex'),
    }),
    'utf8',
  );
  return recorded;
}

/** Audits only machine-readable Gate evidence and returns no source path or file name. */
export async function auditGateEvidencePrivacy({ evidenceRoots }) {
  if (!Array.isArray(evidenceRoots) || evidenceRoots.length === 0) {
    throw new Error('Gate privacy audit requires at least one evidence root.');
  }
  let filesScanned = 0;
  const forbiddenFields = new Set([
    'accountIdentifier',
    'color',
    'coordinate',
    'deviceId',
    'deviceName',
    'ecid',
    'fileContent',
    'filePath',
    'geometry',
    'hostname',
    'identifier',
    'noteContent',
    'path',
    'points',
    'pressure',
    'serialNumber',
    'sourcePath',
    'tilt',
    'udid',
    'userVaultPath',
    'x',
    'y',
  ]);
  const forbiddenStrings = [/\/Users\//u, /\/var\/folders\//u, /\/Volumes\//u, /PRIVATE-/u];
  const assertSafeValue = (value) => {
    if (Array.isArray(value)) {
      value.forEach(assertSafeValue);
      return;
    }
    if (typeof value === 'string') {
      if (forbiddenStrings.some((pattern) => pattern.test(value))) {
        throw new Error('Gate evidence contains a forbidden local path or private marker.');
      }
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (forbiddenFields.has(key)) {
        throw new Error(`Gate evidence contains forbidden field: ${key}`);
      }
      assertSafeValue(nested);
    }
  };
  const visitDirectory = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visitDirectory(path);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        assertSafeValue(JSON.parse(await readFile(path, 'utf8')));
        filesScanned += 1;
      }
    }
  };
  for (const root of evidenceRoots) await visitDirectory(root);
  return { filesScanned, schemaVersion: 1, status: 'PASS' };
}

function renderPendingHumanReport() {
  return [
    '# S34 human acceptance report',
    '',
    'The named tester must replace every `PENDING` with `PASS` or `FAIL` and add notes. Automation must not author ratings.',
    '',
    '<!-- HAT:MANUAL ratings -->',
    '',
    '| Checkpoint | Rating | Notes |',
    '| --- | --- | --- |',
    ...REQUIRED_HUMAN_CHECKPOINTS.map((checkpoint) => `| ${checkpoint} | PENDING | |`),
    '',
    '<!-- HAT:ENDMANUAL ratings -->',
    '',
    '## Tester and unresolved limitations',
    '',
    '<!-- HAT:MANUAL tester-notes -->',
    '',
    '- Tester: PENDING',
    '- Session date/time: PENDING',
    '- Unresolved limitations: PENDING',
    '- Explicit release recommendation: PENDING',
    '',
    '<!-- HAT:ENDMANUAL tester-notes -->',
    '',
  ].join('\n');
}

function humanVerdict(report) {
  if (report === null) return 'INCOMPLETE';
  const ratingsBlock = manualBlock(report, 'ratings');
  if (ratingsBlock === null) return 'INCOMPLETE';
  const rows = [...ratingsBlock.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$/gmu)]
    .map((match) => ({
      checkpoint: match[1].trim(),
      notes: match[3].trim(),
      rating: match[2].trim(),
    }))
    .filter(({ checkpoint }) => checkpoint !== 'Checkpoint' && !/^-+$/u.test(checkpoint));
  const fixedRows = rows.filter(({ checkpoint }) =>
    REQUIRED_HUMAN_CHECKPOINTS.includes(checkpoint),
  );
  const unexpectedRows = rows.filter(
    ({ checkpoint }) => !REQUIRED_HUMAN_CHECKPOINTS.includes(checkpoint),
  );
  const rowsByCheckpoint = new Map();
  for (const row of fixedRows) {
    const checkpointRows = rowsByCheckpoint.get(row.checkpoint) ?? [];
    checkpointRows.push(row);
    rowsByCheckpoint.set(row.checkpoint, checkpointRows);
  }
  const outcomes = REQUIRED_HUMAN_CHECKPOINTS.map(
    (checkpoint) => rowsByCheckpoint.get(checkpoint) ?? [],
  );
  if (outcomes.some((rows) => rows.some((row) => row.rating === 'FAIL'))) return 'FAIL';
  const testerNotesBlock = manualBlock(report, 'tester-notes');
  if (testerNotesBlock === null) return 'INCOMPLETE';
  const recommendations = manualFields(testerNotesBlock, 'Explicit release recommendation');
  if (recommendations.some((value) => value === 'HOLD' || value === 'STOP_AND_RESPEC')) {
    return 'FAIL';
  }
  // A release recommendation never overrides an unobserved row. Requiring exactly one row also
  // prevents a later duplicate PASS from shadowing an earlier PENDING checkpoint.
  if (
    unexpectedRows.length > 0 ||
    outcomes.some(
      (rows) =>
        rows.length !== 1 ||
        rows.some(
          (row) => row.rating !== 'PASS' && row.rating !== 'FAIL' && row.rating !== 'PENDING',
        ),
    ) ||
    outcomes.some((rows) => rows.some((row) => row.rating === 'PENDING'))
  ) {
    return 'INCOMPLETE';
  }
  const testers = manualFields(testerNotesBlock, 'Tester');
  const sessionTimes = manualFields(testerNotesBlock, 'Session date/time');
  const limitations = manualFields(testerNotesBlock, 'Unresolved limitations');
  const metadataComplete =
    testers.length === 1 &&
    manualFieldComplete(testers[0]) &&
    sessionTimes.length === 1 &&
    manualFieldComplete(sessionTimes[0]) &&
    limitations.length === 1 &&
    manualFieldComplete(limitations[0]) &&
    recommendations.length === 1 &&
    recommendations[0] === 'RELEASE';
  return outcomes.every(([outcome]) => outcome.rating === 'PASS' && outcome.notes.length > 0) &&
    metadataComplete
    ? 'PASS'
    : 'INCOMPLETE';
}

function manualBlock(report, name) {
  const startMarker = `<!-- HAT:MANUAL ${name} -->`;
  const endMarker = `<!-- HAT:ENDMANUAL ${name} -->`;
  const start = report.indexOf(startMarker);
  if (start < 0 || report.lastIndexOf(startMarker) !== start) return null;
  const contentsStart = start + startMarker.length;
  const end = report.indexOf(endMarker);
  if (end < contentsStart || report.lastIndexOf(endMarker) !== end) return null;
  return report.slice(contentsStart, end);
}

function manualFields(report, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return [...report.matchAll(new RegExp(`^- ${escapedLabel}:\\s*(.+?)\\s*$`, 'gmu'))].map((match) =>
    match[1].trim(),
  );
}

function manualFieldComplete(value) {
  return typeof value === 'string' && value.length > 0 && value !== 'PENDING';
}

function hasCompleteReferenceArtifacts(artifacts) {
  return REFERENCE_ARTIFACTS.every((definition) =>
    artifacts.some(
      (artifact) =>
        isRecord(artifact) &&
        hasExactKeys(artifact, [
          'application',
          'artifactId',
          'frameRate',
          'runIndex',
          'sha256',
          'sizeBytes',
          'strokeCount',
        ]) &&
        artifact.artifactId === definition.artifactId &&
        artifact.application === definition.application &&
        artifact.runIndex === definition.runIndex &&
        typeof artifact.sha256 === 'string' &&
        /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
        Number.isSafeInteger(artifact.sizeBytes) &&
        artifact.sizeBytes > 0 &&
        typeof artifact.frameRate === 'number' &&
        artifact.frameRate >= 240 &&
        Number.isSafeInteger(artifact.strokeCount) &&
        artifact.strokeCount >= 20,
    ),
  );
}

function isSafeReferenceArtifactShape(artifact) {
  return (
    isRecord(artifact) &&
    hasExactKeys(artifact, [
      'application',
      'artifactId',
      'frameRate',
      'runIndex',
      'sha256',
      'sizeBytes',
      'strokeCount',
    ])
  );
}

function isSafeGateCheckArtifactShape(artifact) {
  return isRecord(artifact) && hasExactKeys(artifact, ['checkId', 'sha256', 'sizeBytes']);
}

function referenceArtifactVerdict(value) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !hasExactKeys(value, ['artifacts', 'schemaVersion', 'verdict']) ||
    !Array.isArray(value.artifacts)
  ) {
    return 'INCOMPLETE';
  }
  if (value.verdict === 'FAIL') return 'FAIL';
  return hasCompleteReferenceArtifacts(value.artifacts) ? 'PASS' : 'INCOMPLETE';
}

function combineVerdicts(verdicts) {
  return verdicts.includes('FAIL')
    ? 'FAIL'
    : verdicts.every((value) => value === 'PASS')
      ? 'PASS'
      : 'INCOMPLETE';
}

function isArtifactId(value, artifactId) {
  return isRecord(value) && value.artifactId === artifactId;
}

function isCheckId(value, checkId) {
  return isRecord(value) && value.checkId === checkId;
}

function referenceArtifactOrder(value) {
  if (!isRecord(value)) return Number.MAX_SAFE_INTEGER;
  const index = REFERENCE_ARTIFACTS.findIndex(
    (candidate) => candidate.artifactId === value.artifactId,
  );
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function physicalFoundationVerdict(value, expectedAdapter, protocolDigest) {
  if (!isRecord(value) || value.protocolDigest !== protocolDigest) return 'INCOMPLETE';
  if (value.automatedVerdict === 'FAIL' || value.gateVerdict === 'FAIL') return 'FAIL';
  return value.automatedVerdict === 'PASS' &&
    value.gateVerdict === 'PASS' &&
    (value.presentationAdapter === expectedAdapter ||
      (expectedAdapter === 'main-canvas-2d' && value.presentationAdapter === undefined))
    ? 'PASS'
    : 'INCOMPLETE';
}

function adapterDecisionVerdict({ adapterDecision, foundation, protocolDigest, workerFoundation }) {
  const workerCapabilities = workerCapabilitySummary(foundation);
  const explicitFailure =
    isRecord(adapterDecision) &&
    (adapterDecision.verdict === 'FAIL' ||
      adapterDecision.diagnosticsOnOff === 'FAIL' ||
      adapterDecision.mainWorkerAb === 'FAIL');
  if (explicitFailure) {
    return {
      selectedAdapter: null,
      verdict: 'FAIL',
      workerCapability: workerCapabilities,
      workerGate: 'FAIL',
    };
  }
  if (
    !isRecord(adapterDecision) ||
    adapterDecision.verdict !== 'PASS' ||
    adapterDecision.diagnosticsOnOff !== 'PASS' ||
    adapterDecision.schemaVersion !== 1 ||
    !hasExactKeys(adapterDecision, [
      'capabilityEvidenceDigest',
      'diagnosticsEvidenceDigest',
      'diagnosticsOnOff',
      'mainWorkerAb',
      'mainWorkerAbEvidenceDigest',
      'schemaVersion',
      'selectedAdapter',
      'verdict',
      'workerDisposition',
      'workerReasonCategories',
    ]) ||
    workerCapabilities.status === 'INCOMPLETE' ||
    adapterDecision.capabilityEvidenceDigest !== workerCapabilities.digest
  ) {
    return {
      selectedAdapter: null,
      verdict: 'INCOMPLETE',
      workerCapability: workerCapabilities,
      workerGate: 'INCOMPLETE',
    };
  }
  const diagnosticsEvidenceValid =
    typeof adapterDecision.diagnosticsEvidenceDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(adapterDecision.diagnosticsEvidenceDigest);
  if (!diagnosticsEvidenceValid) {
    return {
      selectedAdapter: null,
      verdict: 'INCOMPLETE',
      workerCapability: workerCapabilities,
      workerGate: 'INCOMPLETE',
    };
  }
  if (workerCapabilities.status === 'supported') {
    const decisionMatches =
      adapterDecision.workerDisposition === 'supported' &&
      adapterDecision.mainWorkerAb === 'PASS' &&
      typeof adapterDecision.mainWorkerAbEvidenceDigest === 'string' &&
      /^[a-f0-9]{64}$/u.test(adapterDecision.mainWorkerAbEvidenceDigest) &&
      (adapterDecision.selectedAdapter === 'main-canvas-2d' ||
        adapterDecision.selectedAdapter === 'worker-offscreen-2d') &&
      Array.isArray(adapterDecision.workerReasonCategories) &&
      adapterDecision.workerReasonCategories.length === 0;
    if (adapterDecision.selectedAdapter === 'main-canvas-2d') {
      return {
        selectedAdapter: decisionMatches ? 'main-canvas-2d' : null,
        verdict: decisionMatches ? 'PASS' : 'INCOMPLETE',
        workerCapability: workerCapabilities,
        workerGate: decisionMatches ? 'NOT_SELECTED' : 'INCOMPLETE',
      };
    }
    const workerGate = physicalFoundationVerdict(
      workerFoundation,
      'worker-offscreen-2d',
      protocolDigest,
    );
    return {
      selectedAdapter: decisionMatches ? 'worker-offscreen-2d' : null,
      verdict: decisionMatches ? workerGate : 'INCOMPLETE',
      workerCapability: workerCapabilities,
      workerGate,
    };
  }
  const declaredReasons = Array.isArray(adapterDecision.workerReasonCategories)
    ? [...adapterDecision.workerReasonCategories].sort()
    : [];
  const reasonMatches =
    declaredReasons.length === workerCapabilities.reasonCategories.length &&
    declaredReasons.every((reason, index) => reason === workerCapabilities.reasonCategories[index]);
  const decisionMatches =
    adapterDecision.workerDisposition === 'proven-unsupported' &&
    adapterDecision.mainWorkerAb === 'NOT_APPLICABLE' &&
    adapterDecision.mainWorkerAbEvidenceDigest === null &&
    adapterDecision.selectedAdapter === 'main-canvas-2d' &&
    reasonMatches;
  return {
    selectedAdapter: decisionMatches ? 'main-canvas-2d' : null,
    verdict: decisionMatches ? 'PASS' : 'INCOMPLETE',
    workerCapability: workerCapabilities,
    workerGate: decisionMatches ? 'NOT_APPLICABLE' : 'INCOMPLETE',
  };
}

function workerCapabilitySummary(foundation) {
  if (
    !isRecord(foundation) ||
    !Array.isArray(foundation.captures) ||
    foundation.captures.length === 0
  ) {
    return { digest: null, reasonCategories: [], status: 'INCOMPLETE' };
  }
  const normalized = [];
  for (const capture of foundation.captures) {
    if (!isRecord(capture) || !isRecord(capture.runtimeCapabilities)) {
      return { digest: null, reasonCategories: [], status: 'INCOMPLETE' };
    }
    const capabilities = {};
    for (const name of REQUIRED_WORKER_CAPABILITIES) {
      const outcome = capture.runtimeCapabilities[name];
      if (
        !isRecord(outcome) ||
        typeof outcome.available !== 'boolean' ||
        typeof outcome.failureCategory !== 'string' ||
        (outcome.available
          ? outcome.failureCategory !== 'none'
          : outcome.failureCategory === 'none')
      ) {
        return { digest: null, reasonCategories: [], status: 'INCOMPLETE' };
      }
      capabilities[name] = {
        available: outcome.available,
        failureCategory: outcome.failureCategory,
      };
    }
    normalized.push(
      Object.fromEntries(
        Object.entries(capabilities).sort(([left], [right]) => left.localeCompare(right)),
      ),
    );
  }
  for (const name of REQUIRED_WORKER_CAPABILITIES) {
    const states = new Set(normalized.map((capture) => JSON.stringify(capture[name])));
    if (states.size !== 1) {
      return { digest: null, reasonCategories: [], status: 'INCOMPLETE' };
    }
  }
  const reasonCategories = [
    ...new Set(
      normalized.flatMap((capture) =>
        REQUIRED_WORKER_CAPABILITIES.flatMap((name) =>
          capture[name].available ? [] : [capture[name].failureCategory],
        ),
      ),
    ),
  ].sort();
  return {
    digest: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
    reasonCategories,
    status: reasonCategories.length === 0 ? 'supported' : 'proven-unsupported',
  };
}

function evidenceGateVerdict(value, requiredChecks, manifestText, allowedExtraKeys = []) {
  if (!isRecord(value)) return 'INCOMPLETE';
  const checks = isRecord(value.checks) ? value.checks : {};
  const ratings = requiredChecks.map((name) => checks[name]);
  if (value.verdict === 'FAIL' || ratings.some((rating) => rating === 'FAIL')) return 'FAIL';
  const manifest = parseEvidenceManifest(manifestText, requiredChecks);
  const manifestDigest =
    manifestText === null ? null : createHash('sha256').update(manifestText).digest('hex');
  return value.verdict === 'PASS' &&
    value.schemaVersion === 1 &&
    hasExactKeys(value, [
      'checks',
      'evidenceManifestSha256',
      'schemaVersion',
      'verdict',
      ...allowedExtraKeys,
    ]) &&
    hasExactKeys(checks, requiredChecks) &&
    ratings.every((rating) => rating === 'PASS') &&
    manifest !== null &&
    value.evidenceManifestSha256 === manifestDigest
    ? 'PASS'
    : 'INCOMPLETE';
}

function parseEvidenceManifest(manifestText, requiredChecks) {
  if (manifestText === null) return null;
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return null;
  }
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    !hasExactKeys(manifest, ['artifacts', 'schemaVersion']) ||
    !Array.isArray(manifest.artifacts)
  ) {
    return null;
  }
  const artifacts = manifest.artifacts;
  if (artifacts.length !== requiredChecks.length) return null;
  for (const checkId of requiredChecks) {
    const matches = artifacts.filter(
      (artifact) => isRecord(artifact) && artifact.checkId === checkId,
    );
    if (matches.length !== 1) return null;
    const artifact = matches[0];
    if (
      !hasExactKeys(artifact, ['checkId', 'sha256', 'sizeBytes']) ||
      typeof artifact.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes <= 0
    ) {
      return null;
    }
  }
  return manifest;
}

function releasedOldBinaryVerdict(value, manifestText) {
  if (!isRecord(value) || !isRecord(value.releasedOldBinary)) return 'INCOMPLETE';
  const evidence = value.releasedOldBinary;
  if (evidence.verdict === 'FAIL') return 'FAIL';
  const manifest = parseEvidenceManifest(manifestText, REQUIRED_COMPATIBILITY_CHECKS);
  const oldReaderArtifact =
    manifest === null
      ? null
      : manifest.artifacts.find(
          (artifact) => isRecord(artifact) && artifact.checkId === 'releasedOldBinaryFailClosed',
        );
  return evidence.verdict === 'PASS' &&
    hasExactKeys(evidence, ['binarySha256', 'resultArtifactSha256', 'verdict', 'version']) &&
    typeof evidence.binarySha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(evidence.binarySha256) &&
    typeof evidence.resultArtifactSha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(evidence.resultArtifactSha256) &&
    isRecord(oldReaderArtifact) &&
    evidence.resultArtifactSha256 === oldReaderArtifact.sha256 &&
    typeof evidence.version === 'string' &&
    /^[ A-Za-z0-9._+-]{1,80}$/u.test(evidence.version)
    ? 'PASS'
    : 'INCOMPLETE';
}

async function initializeS27EvidenceIfMissing(input) {
  if ((await readTextIfPresent(join(input.evidenceRoot, S27_EVIDENCE_MARKER))) !== null) return;
  await initializeS27Evidence(input);
}

async function fixtureMarkerState(fixtureRoot) {
  const markers = await Promise.all(
    FIXTURE_OWNERSHIP_MARKERS.map((name) => readTextIfPresent(join(fixtureRoot, name))),
  );
  const present = markers.filter((contents) => contents !== null).length;
  if (present === 0) return 'absent';
  return present === FIXTURE_OWNERSHIP_MARKERS.length ? 'owned' : 'partial';
}

async function directoryEntries(directory) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readJsonIfPresent(path) {
  const contents = await readTextIfPresent(path);
  if (contents === null) return null;
  try {
    return JSON.parse(contents);
  } catch {
    return null;
  }
}

async function readTextIfPresent(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeFileIfMissing(path, contents) {
  try {
    await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (!isRecord(error) || error.code !== 'EEXIST') throw error;
  }
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function hasExactKeys(value, expectedKeys) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function inspectUnifiedReadiness({ fixtureRoot, projectRoot }) {
  try {
    return await inspectS27Readiness({
      env: { ...process.env, INKSTONE_S27_HAT_OUTPUT: fixtureRoot },
      projectRoot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const failureCategory = /exactly one paired(?:, booted)? physical iPad/iu.test(message)
      ? 'physical-device-selection'
      : /devicectl|xcrun/iu.test(message)
        ? 'device-tooling-unavailable'
        : 'readiness-unavailable';
    return {
      command: 'info',
      failureCategory,
      missing: ['physicalReadiness'],
      schemaVersion: 1,
      status: 'INCOMPLETE',
    };
  }
}

function printPrepareSummary(result, fixtureRoot) {
  const status =
    isRecord(result) && typeof result.status === 'string' ? result.status : 'INCOMPLETE';
  process.stdout.write(
    [
      'HAT_PREPARE_SUMMARY',
      'mode=blank',
      `status=${status}`,
      `app_url=obsidian://open?vault=${encodeURIComponent(basename(fixtureRoot))}`,
      'database=not-applicable',
      'schema_version=ink-v3-candidate-unpublished',
      'seed_records=synthetic-fixed-cards',
      'cleanup=docs/delivery/slices/S34-ink-native-feel-release-gate/prepare.sh cleanup',
      'guide=docs/delivery/slices/S34-ink-native-feel-release-gate/hat-guide.md',
      'output=owned-synthetic-vault',
      'END_HAT_PREPARE_SUMMARY',
      '',
    ].join('\n'),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] ?? 'info';
  const projectRoot = resolve(process.env.INKSTONE_PROJECT_ROOT ?? process.cwd());
  const fixtureRoot = resolve(
    process.env.INKSTONE_UNIFIED_HAT_OUTPUT ??
      join(homedir(), 'Downloads', 'Inkstone-Native-Feel-Unified-Gate'),
  );
  const s27SliceRoot = resolve(
    process.env.INKSTONE_S27R5_EVIDENCE_ROOT ??
      join(projectRoot, 'docs', 'delivery', 'slices', 'S27R5-ink-foundation-ipad-regate'),
  );
  const s27MainEvidenceRoot = join(s27SliceRoot, 'evidence-main-canvas-2d');
  const s27WorkerEvidenceRoot = join(s27SliceRoot, 'evidence-worker-offscreen-2d');
  const s27R6EvidenceRoot = resolve(
    process.env.INKSTONE_S27R6_EVIDENCE_ROOT ??
      join(projectRoot, 'docs', 'delivery', 'slices', 'S27R6-local-obsidian-performance-gate'),
  );
  const s34EvidenceRoot = resolve(
    process.env.INKSTONE_S34_EVIDENCE_ROOT ??
      join(projectRoot, 'docs', 'delivery', 'slices', 'S34-ink-native-feel-release-gate'),
  );
  try {
    let result;
    if (command === 'info') {
      result = await inspectUnifiedReadiness({ fixtureRoot, projectRoot });
    } else if (command === 'prepare') {
      result = await prepareUnifiedPhysicalGate({
        fixtureRoot,
        inspectReadiness: () => inspectUnifiedReadiness({ fixtureRoot, projectRoot }),
        projectRoot,
        protocolDigest: await computeUnifiedGateProtocolDigest(projectRoot),
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      });
    } else if (command === 'cleanup') {
      result = await cleanupUnifiedPhysicalGate({ fixtureRoot, projectRoot });
    } else if (command === 'foundation') {
      const action = process.argv[3];
      const conditionId = action === 'run' ? process.argv[4] : undefined;
      const presentationAdapter =
        (action === 'run' ? process.argv[5] : process.argv[4]) ??
        process.env.INKSTONE_S27_PRESENTATION_ADAPTER ??
        'main-canvas-2d';
      const evidenceRoot =
        presentationAdapter === 'worker-offscreen-2d'
          ? s27WorkerEvidenceRoot
          : presentationAdapter === 'main-canvas-2d'
            ? s27MainEvidenceRoot
            : null;
      if (evidenceRoot === null) {
        throw new Error('Foundation Adapter must be main-canvas-2d or worker-offscreen-2d.');
      }
      if (action === 'analyze') {
        result = await analyzeS27Evidence({
          evidenceRoot,
          protocolDigest: await computeUnifiedGateProtocolDigest(projectRoot),
        });
      } else if (action === 'run' && conditionId !== undefined) {
        await assertCurrentLocalObsidianPass({ projectRoot });
        result = await advanceS27Condition({
          conditionId,
          evidenceRoot,
          fixtureRoot,
          presentationAdapter,
          protocolDigest: await computeUnifiedGateProtocolDigest(projectRoot),
          readiness: await inspectUnifiedReadiness({ fixtureRoot, projectRoot }),
        });
      } else {
        throw new Error(
          'Usage: prepare.sh foundation run <condition> [main-canvas-2d|worker-offscreen-2d] or foundation analyze [Adapter].',
        );
      }
    } else if (command === 'product') {
      await assertCurrentLocalObsidianPass({ projectRoot });
      result = await selectProductCondition({
        conditionId: process.argv[3],
        fixtureRoot,
      });
    } else if (command === 'artifact') {
      result = await recordReferenceArtifact({
        artifactId: process.argv[3],
        frameRate: Number(process.argv[5]),
        s34EvidenceRoot,
        sourcePath: process.argv[4],
        strokeCount: Number(process.argv[6]),
      });
    } else if (command === 'check-artifact') {
      result = await recordGateCheckArtifact({
        checkId: process.argv[4],
        gate: process.argv[3],
        s34EvidenceRoot,
        sourcePath: process.argv[5],
      });
    } else if (command === 'privacy-audit') {
      result = await auditGateEvidencePrivacy({
        evidenceRoots: [s27SliceRoot, s27R6EvidenceRoot, s34EvidenceRoot],
      });
    } else if (command === 'analyze') {
      const protocolDigest = await computeUnifiedGateProtocolDigest(projectRoot);
      await Promise.all([
        analyzeS27Evidence({ evidenceRoot: s27MainEvidenceRoot, protocolDigest }),
        analyzeS27Evidence({ evidenceRoot: s27WorkerEvidenceRoot, protocolDigest }),
      ]);
      result = await analyzeUnifiedReleaseGate({
        protocolDigest,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      });
    } else {
      throw new Error(`Unsupported unified physical Gate command: ${command}`);
    }
    if (command === 'info' || command === 'prepare' || command === 'cleanup') {
      printPrepareSummary(result, fixtureRoot);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
