import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  analyzeUnifiedReleaseGate,
  auditGateEvidencePrivacy,
  cleanupUnifiedPhysicalGate,
  initializeUnifiedReleaseEvidence,
  listRequiredReferenceArtifacts,
  listUnifiedPhysicalSessions,
  prepareUnifiedPhysicalGate,
  recordGateCheckArtifact,
  recordReferenceArtifact,
  selectProductCondition,
} from './ink-native-feel-release-gate.mjs';

const temporaryRoots: string[] = [];
const TEST_PROTOCOL_DIGEST = 'a'.repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('S27R5 + S34 unified physical acceptance package', () => {
  it('audits nested machine-readable Gate evidence without retaining its source paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-privacy-audit-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'nested'));
    await Promise.all([
      writeFile(join(root, 'environment.json'), '{"status":"READY"}\n', 'utf8'),
      writeFile(join(root, 'nested', 'result.json'), '{"verdict":"PASS"}\n', 'utf8'),
      writeFile(join(root, 'human-report.md'), '/Users/private/not-machine-evidence\n', 'utf8'),
    ]);

    await expect(auditGateEvidencePrivacy({ evidenceRoots: [root] })).resolves.toEqual({
      filesScanned: 2,
      schemaVersion: 1,
      status: 'PASS',
    });
  });

  it('fails the evidence privacy audit on a nested identifying field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-private-evidence-'));
    temporaryRoots.push(root);
    await writeFile(
      join(root, 'environment.json'),
      '{"device":{"serialNumber":"PRIVATE-SERIAL"}}\n',
      'utf8',
    );

    await expect(auditGateEvidencePrivacy({ evidenceRoots: [root] })).rejects.toThrow(
      'Gate evidence contains forbidden field: serialNumber',
    );
  });

  it('fails the evidence privacy audit before raw Pencil geometry can enter evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-raw-geometry-'));
    temporaryRoots.push(root);
    await writeFile(join(root, 'capture.json'), '{"points":[{"x":1,"y":2}]}\n', 'utf8');

    await expect(auditGateEvidencePrivacy({ evidenceRoots: [root] })).rejects.toThrow(
      'Gate evidence contains forbidden field: points',
    );
  });

  it('fails the evidence privacy audit when a local source path is hidden in a generic value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-path-value-'));
    temporaryRoots.push(root);
    await writeFile(
      join(root, 'artifact.json'),
      '{"note":"/Users/private/Vault/reference.mov"}\n',
      'utf8',
    );

    await expect(auditGateEvidencePrivacy({ evidenceRoots: [root] })).rejects.toThrow(
      'Gate evidence contains a forbidden local path or private marker.',
    );
  });

  it('shares exactly four physical session cards with the Foundation runner', async () => {
    expect(listUnifiedPhysicalSessions()).toEqual([
      'session-1-empty-pen-highlighter',
      'session-2-history-10k-30-surfaces',
      'session-3-navigation-layout',
      'session-4-stability-reference',
    ]);
    expect(listRequiredReferenceArtifacts()).toEqual([
      'inkstone-run-1',
      'notes-run-1',
      'freeform-run-1',
    ]);

    const fixtureRoot = await mkdtemp(join(tmpdir(), 'inkstone-four-session-product-card-'));
    temporaryRoots.push(fixtureRoot);
    await Promise.all([
      writeFile(join(fixtureRoot, '.inkstone-hat-owned'), 'owned\n', 'utf8'),
      writeFile(join(fixtureRoot, '.inkstone-s22-performance-hat.json'), '{}\n', 'utf8'),
    ]);

    await expect(
      selectProductCondition({
        conditionId: 'session-4-stability-reference',
        fixtureRoot,
      }),
    ).resolves.toMatchObject({
      conditionId: 'session-4-stability-reference',
      status: 'AWAITING_HUMAN',
    });
    await expect(selectProductCondition({ conditionId: 'pen', fixtureRoot })).rejects.toThrow(
      'Unknown S34 product condition: pen',
    );
  });

  it('initializes a deferred skeleton that missing evidence can never promote', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-gate-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');

    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: ['physicalDevice'], status: 'INCOMPLETE' },
      protocolDigest: 'a'.repeat(64),
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });
    const result = await analyzeUnifiedReleaseGate({
      protocolDigest: TEST_PROTOCOL_DIGEST,
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });

    expect(result).toMatchObject({
      automatedGate: 'INCOMPLETE',
      compatibilityGate: 'INCOMPLETE',
      foundationGate: 'INCOMPLETE',
      humanGate: 'INCOMPLETE',
      verdict: 'INCOMPLETE',
    });
    expect(JSON.parse(await readFile(join(s34EvidenceRoot, 'results.json'), 'utf8'))).toMatchObject(
      {
        schemaVersion: 1,
        verdict: 'INCOMPLETE',
      },
    );
    const human = await readFile(join(s34EvidenceRoot, 'human-report.md'), 'utf8');
    expect(human).toContain('| Pen tip following | PENDING |');
    expect(human).toContain('| Relative to Apple Notes | PENDING |');
    expect(human).not.toMatch(/calibration frozen|published/iu);
  });

  it('keeps an internally passing stale Foundation digest incomplete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-stale-protocol-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    const staleProtocolDigest = 'a'.repeat(64);
    const currentProtocolDigest = 'f'.repeat(64);
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: staleProtocolDigest,
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });
    const foundation = { ...passingFoundationResult(false), protocolDigest: staleProtocolDigest };
    await Promise.all([
      writeJson(join(s27MainEvidenceRoot, 'results.json'), foundation),
      writeJson(
        join(s34EvidenceRoot, 'adapter-decision.json'),
        passingAdapterDecision(foundation, false),
      ),
    ]);

    const result = await analyzeUnifiedReleaseGate({
      protocolDigest: currentProtocolDigest,
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });

    expect(result).toMatchObject({ foundationGate: 'INCOMPLETE', verdict: 'INCOMPLETE' });
    await expect(readFile(join(s34EvidenceRoot, 'results.json'), 'utf8')).resolves.toContain(
      '"foundationGate": "INCOMPLETE"',
    );
  });

  it('keeps an otherwise passing release Gate incomplete without exact released-old-binary evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-old-reader-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: 'a'.repeat(64),
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });
    await Promise.all([
      writeJson(join(s27MainEvidenceRoot, 'results.json'), {
        automatedVerdict: 'PASS',
        gateVerdict: 'PASS',
        protocolDigest: TEST_PROTOCOL_DIGEST,
        schemaVersion: 2,
      }),
      writeJson(join(s34EvidenceRoot, 'automated-gate.json'), {
        checks: passingAutomatedChecks(),
        schemaVersion: 1,
        verdict: 'PASS',
      }),
      writeJson(join(s34EvidenceRoot, 'compatibility-report.json'), {
        checks: passingCompatibilityChecks(),
        schemaVersion: 1,
        verdict: 'PASS',
      }),
    ]);
    const humanPath = join(s34EvidenceRoot, 'human-report.md');
    await writeFile(humanPath, completeHumanReport(await readFile(humanPath, 'utf8')), 'utf8');

    await expect(
      analyzeUnifiedReleaseGate({
        protocolDigest: TEST_PROTOCOL_DIGEST,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      }),
    ).resolves.toMatchObject({
      compatibilityGate: 'INCOMPLETE',
      verdict: 'INCOMPLETE',
    });
  });

  it('indexes reference video by hash and size without persisting its source path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-artifact-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: ['physicalDevice'], status: 'INCOMPLETE' },
      protocolDigest: 'a'.repeat(64),
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });
    const privateSource = join(root, 'PRIVATE-user-vault', 'inkstone-run-1.mov');
    await mkdir(join(root, 'PRIVATE-user-vault'), { recursive: true });
    await writeFile(privateSource, 'video bytes', 'utf8');

    const recorded: unknown = await recordReferenceArtifact({
      artifactId: 'inkstone-run-1',
      frameRate: 240,
      s34EvidenceRoot,
      sourcePath: privateSource,
      strokeCount: 20,
    });
    const stored = await readFile(join(s34EvidenceRoot, 'artifact-index.json'), 'utf8');

    expect(recorded).toMatchObject({
      application: 'inkstone',
      artifactId: 'inkstone-run-1',
      sizeBytes: 11,
    });
    expect(
      typeof recorded === 'object' && recorded !== null && 'sha256' in recorded
        ? recorded.sha256
        : null,
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored).not.toContain('PRIVATE-user-vault');
    expect(stored).not.toContain(privateSource);
    expect(stored).not.toMatch(/"(?:file)?path"/iu);
  });

  it('indexes automated evidence by hash and size without persisting its source path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-check-artifact-'));
    temporaryRoots.push(root);
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: 'a'.repeat(64),
      s27MainEvidenceRoot: join(root, 's27-main'),
      s27WorkerEvidenceRoot: join(root, 's27-worker'),
      s34EvidenceRoot,
    });
    const privateSource = join(root, 'PRIVATE-results', 'repository-gate.txt');
    await mkdir(join(root, 'PRIVATE-results'));
    await writeFile(privateSource, 'all checks passed\n', 'utf8');

    const recorded: unknown = await recordGateCheckArtifact({
      checkId: 'repositoryGate',
      gate: 'automated',
      s34EvidenceRoot,
      sourcePath: privateSource,
    });
    const stored = await Promise.all([
      readFile(join(s34EvidenceRoot, 'automated-evidence-manifest.json'), 'utf8'),
      readFile(join(s34EvidenceRoot, 'automated-gate.json'), 'utf8'),
    ]).then((files) => files.join('\n'));

    expect(recorded).toMatchObject({ checkId: 'repositoryGate', sizeBytes: 18 });
    expect(stored).not.toContain('PRIVATE-results');
    expect(stored).not.toContain(privateSource);
    expect(stored).not.toMatch(/"(?:file)?path"/iu);
    expect(stored).toMatch(/"evidenceManifestSha256": "[a-f0-9]{64}"/u);
  });

  it('requires legacy Recovery read-only migration evidence and rejects the retired writer Gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-legacy-recovery-check-'));
    temporaryRoots.push(root);
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: 'a'.repeat(64),
      s27MainEvidenceRoot: join(root, 's27-main'),
      s27WorkerEvidenceRoot: join(root, 's27-worker'),
      s34EvidenceRoot,
    });
    const sourcePath = join(root, 'legacy-recovery-read-only.txt');
    await writeFile(sourcePath, 'legacy bytes preserved; no writer calls\n', 'utf8');

    await expect(
      recordGateCheckArtifact({
        checkId: 'legacyRecoveryReadOnlyMigration',
        gate: 'compatibility',
        s34EvidenceRoot,
        sourcePath,
      }),
    ).resolves.toMatchObject({ checkId: 'legacyRecoveryReadOnlyMigration' });
    await expect(
      recordGateCheckArtifact({
        checkId: 'recoveryV3V4',
        gate: 'compatibility',
        s34EvidenceRoot,
        sourcePath,
      }),
    ).rejects.toThrow(/Unknown compatibility Gate check/u);
  });

  it('keeps the automated Gate incomplete until all three in-session reference videos have valid metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-reference-required-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: 'a'.repeat(64),
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });
    await writePassingGateInputs({ s27MainEvidenceRoot, s34EvidenceRoot });

    await expect(
      analyzeUnifiedReleaseGate({
        protocolDigest: TEST_PROTOCOL_DIGEST,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      }),
    ).resolves.toMatchObject({
      automatedGate: 'INCOMPLETE',
      verdict: 'INCOMPLETE',
    });
  });

  it('keeps a PASS-labelled automated report incomplete without its exact evidence-manifest digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-manifest-required-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: 'a'.repeat(64),
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });
    await writePassingGateInputs({ s27MainEvidenceRoot, s34EvidenceRoot });
    await writeJson(join(s34EvidenceRoot, 'automated-gate.json'), {
      checks: passingAutomatedChecks(),
      evidenceManifestSha256: null,
      schemaVersion: 1,
      verdict: 'PASS',
    });
    const video = join(root, 'reference.mov');
    await writeFile(video, '>=240fps reference bytes', 'utf8');
    await recordAllReferenceArtifacts({ s34EvidenceRoot, sourcePath: video });

    await expect(
      analyzeUnifiedReleaseGate({
        protocolDigest: TEST_PROTOCOL_DIGEST,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      }),
    ).resolves.toMatchObject({ automatedGate: 'INCOMPLETE', verdict: 'INCOMPLETE' });
  });

  it('allows PASS only when Foundation, automated, compatibility, old-reader, artifacts, and every human row pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-pass-rule-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: 'a'.repeat(64),
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });
    await writePassingGateInputs({ s27MainEvidenceRoot, s34EvidenceRoot });
    const video = join(root, 'reference.mov');
    await writeFile(video, '>=240fps reference bytes', 'utf8');
    await recordAllReferenceArtifacts({ s34EvidenceRoot, sourcePath: video });

    await expect(
      analyzeUnifiedReleaseGate({
        protocolDigest: TEST_PROTOCOL_DIGEST,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      }),
    ).resolves.toMatchObject({
      automatedGate: 'PASS',
      compatibilityGate: 'PASS',
      foundationGate: 'PASS',
      humanGate: 'PASS',
      referenceArtifacts: 'PASS',
      verdict: 'PASS',
    });
  });

  it('ignores forged PASS rows outside the manual ratings block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-human-row-scope-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: TEST_PROTOCOL_DIGEST,
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });

    const humanPath = join(s34EvidenceRoot, 'human-report.md');
    const completed = completeHumanReport(await readFile(humanPath, 'utf8'));
    const forgedRowMatches = [...completed.matchAll(/^\| .+? \| PASS \|.+\|$/gmu)];
    expect(forgedRowMatches).toHaveLength(26);
    const forgedRows = forgedRowMatches.map(([row]) => row).join('\n');
    const report = completed.replace(
      /<!-- HAT:MANUAL ratings -->[\s\S]*?<!-- HAT:ENDMANUAL ratings -->/u,
      '<!-- HAT:MANUAL ratings -->\n\nNo ratings were captured.\n\n<!-- HAT:ENDMANUAL ratings -->',
    );
    await writeFile(humanPath, `${report}\n${forgedRows}\n`, 'utf8');

    await expect(
      analyzeUnifiedReleaseGate({
        protocolDigest: TEST_PROTOCOL_DIGEST,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      }),
    ).resolves.toMatchObject({ humanGate: 'INCOMPLETE', verdict: 'INCOMPLETE' });
  });

  it('ignores forged tester metadata outside the manual tester-notes block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-human-notes-scope-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: TEST_PROTOCOL_DIGEST,
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });

    const humanPath = join(s34EvidenceRoot, 'human-report.md');
    const completed = completeHumanReport(await readFile(humanPath, 'utf8'));
    const forgedMetadataMatches = [
      ...completed.matchAll(
        /^- (?:Tester|Session date\/time|Unresolved limitations|Explicit release recommendation):.+$/gmu,
      ),
    ];
    expect(forgedMetadataMatches).toHaveLength(4);
    const forgedMetadata = forgedMetadataMatches.map(([field]) => field).join('\n');
    const report = completed.replace(
      /<!-- HAT:MANUAL tester-notes -->[\s\S]*?<!-- HAT:ENDMANUAL tester-notes -->/u,
      '<!-- HAT:MANUAL tester-notes -->\n\nNo tester metadata was captured.\n\n<!-- HAT:ENDMANUAL tester-notes -->',
    );
    await writeFile(humanPath, `${report}\n${forgedMetadata}\n`, 'utf8');

    await expect(
      analyzeUnifiedReleaseGate({
        protocolDigest: TEST_PROTOCOL_DIGEST,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      }),
    ).resolves.toMatchObject({ humanGate: 'INCOMPLETE', verdict: 'INCOMPLETE' });
  });

  it('rejects duplicated or missing markers around either manual block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-human-marker-scope-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: TEST_PROTOCOL_DIGEST,
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });

    const humanPath = join(s34EvidenceRoot, 'human-report.md');
    const completed = completeHumanReport(await readFile(humanPath, 'utf8'));
    const markers = [
      '<!-- HAT:MANUAL ratings -->',
      '<!-- HAT:ENDMANUAL ratings -->',
      '<!-- HAT:MANUAL tester-notes -->',
      '<!-- HAT:ENDMANUAL tester-notes -->',
    ];
    for (const marker of markers) {
      for (const [mutation, replacement] of [
        ['duplicated', `${marker}\n${marker}`],
        ['missing', ''],
      ] as const) {
        await writeFile(humanPath, completed.replace(marker, replacement), 'utf8');
        const result = await analyzeUnifiedReleaseGate({
          protocolDigest: TEST_PROTOCOL_DIGEST,
          s27MainEvidenceRoot,
          s27WorkerEvidenceRoot,
          s34EvidenceRoot,
        });
        expect(result.humanGate, `${mutation} ${marker}`).toBe('INCOMPLETE');
      }
    }
  });

  it('keeps an explicit FAIL inside the valid ratings block decisive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-human-fail-priority-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: TEST_PROTOCOL_DIGEST,
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });

    const humanPath = join(s34EvidenceRoot, 'human-report.md');
    const report = completeHumanReport(await readFile(humanPath, 'utf8'))
      .replace(
        '| Pen tip following | PASS | verified by tester |',
        '| Pen tip following | FAIL | visible lag remains |',
      )
      .replace('<!-- HAT:ENDMANUAL tester-notes -->', '');
    await writeFile(humanPath, report, 'utf8');

    await expect(
      analyzeUnifiedReleaseGate({
        protocolDigest: TEST_PROTOCOL_DIGEST,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      }),
    ).resolves.toMatchObject({ humanGate: 'FAIL', verdict: 'FAIL' });
  });

  it('refuses duplicate tester metadata inside the valid manual block', async () => {
    const result = await analyzeMutatedHumanReport((report) =>
      report.replace('- Tester: ivan', '- Tester: ivan\n- Tester: forged duplicate'),
    );

    expect(result).toMatchObject({ humanGate: 'INCOMPLETE', verdict: 'INCOMPLETE' });
  });

  it('keeps a duplicate HOLD recommendation decisive inside the valid manual block', async () => {
    const result = await analyzeMutatedHumanReport((report) =>
      report.replace(
        '- Explicit release recommendation: RELEASE',
        '- Explicit release recommendation: RELEASE\n- Explicit release recommendation: HOLD',
      ),
    );

    expect(result).toMatchObject({ humanGate: 'FAIL', verdict: 'FAIL' });
  });

  it('keeps a STOP_AND_RESPEC recommendation decisive inside the valid manual block', async () => {
    const result = await analyzeMutatedHumanReport((report) =>
      report.replace(
        '- Explicit release recommendation: RELEASE',
        '- Explicit release recommendation: STOP_AND_RESPEC',
      ),
    );

    expect(result).toMatchObject({ humanGate: 'FAIL', verdict: 'FAIL' });
  });

  it('keeps a duplicate STOP_AND_RESPEC decisive after an earlier RELEASE recommendation', async () => {
    const result = await analyzeMutatedHumanReport((report) =>
      report.replace(
        '- Explicit release recommendation: RELEASE',
        '- Explicit release recommendation: RELEASE\n- Explicit release recommendation: STOP_AND_RESPEC',
      ),
    );

    expect(result).toMatchObject({ humanGate: 'FAIL', verdict: 'FAIL' });
  });

  it('refuses duplicate Session date/time metadata inside the valid manual block', async () => {
    const result = await analyzeMutatedHumanReport((report) =>
      report.replace(
        '- Session date/time: 2026-07-18T12:00:00+08:00',
        '- Session date/time: 2026-07-18T12:00:00+08:00\n- Session date/time: forged duplicate',
      ),
    );

    expect(result).toMatchObject({ humanGate: 'INCOMPLETE', verdict: 'INCOMPLETE' });
  });

  it('refuses duplicate Unresolved limitations metadata inside the valid manual block', async () => {
    const result = await analyzeMutatedHumanReport((report) =>
      report.replace(
        '- Unresolved limitations: none observed',
        '- Unresolved limitations: none observed\n- Unresolved limitations: forged duplicate',
      ),
    );

    expect(result).toMatchObject({ humanGate: 'INCOMPLETE', verdict: 'INCOMPLETE' });
  });

  it('refuses a malformed duplicate rating row inside the valid manual block', async () => {
    const result = await analyzeMutatedHumanReport((report) =>
      report.replace(
        '| Pen tip following | PASS | verified by tester |',
        '| Pen tip following | PASS | verified by tester |\n| Pen tip following | MAYBE | forged duplicate |',
      ),
    );

    expect(result).toMatchObject({ humanGate: 'INCOMPLETE', verdict: 'INCOMPLETE' });
  });

  it('refuses release while any required human row remains PENDING, even beside a duplicate PASS row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-pending-human-row-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: 'a'.repeat(64),
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });
    await writePassingGateInputs({ s27MainEvidenceRoot, s34EvidenceRoot });
    const video = join(root, 'reference.mov');
    await writeFile(video, '>=240fps reference bytes', 'utf8');
    await recordAllReferenceArtifacts({ s34EvidenceRoot, sourcePath: video });

    const humanPath = join(s34EvidenceRoot, 'human-report.md');
    await writeFile(
      humanPath,
      (await readFile(humanPath, 'utf8')).replace(
        '| Pen tip following | PASS | verified by tester |',
        [
          '| Pen tip following | PENDING | awaiting physical observation |',
          '| Pen tip following | PASS | verified by tester |',
        ].join('\n'),
      ),
      'utf8',
    );

    const result = await analyzeUnifiedReleaseGate({
      protocolDigest: TEST_PROTOCOL_DIGEST,
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });

    expect(result).toMatchObject({
      automatedGate: 'PASS',
      compatibilityGate: 'PASS',
      foundationGate: 'PASS',
      humanGate: 'INCOMPLETE',
      verdict: 'INCOMPLETE',
    });
    const storedResult: unknown = JSON.parse(
      await readFile(join(s34EvidenceRoot, 'results.json'), 'utf8'),
    );
    expect(storedResult).toMatchObject({ humanGate: 'INCOMPLETE', verdict: 'INCOMPLETE' });
  });

  it('prepares only an owned blank fixture idempotently and preserves resumable evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-prepare-'));
    temporaryRoots.push(root);
    const fixtureRoot = join(root, 'fixture');
    const s27Root = join(root, 's27');
    const s34EvidenceRoot = join(root, 's34');
    const events: string[] = [];
    const input = {
      buildPhysicalHat: (env: NodeJS.ProcessEnv) => {
        expect(env.INKSTONE_UNPUBLISHED_PHYSICAL_INK_HAT).toBe('1');
        events.push('build');
        return Promise.resolve();
      },
      fixtureRoot,
      inspectReadiness: () => Promise.resolve({ command: 'info', missing: [], status: 'READY' }),
      prepareFixture: async () => {
        events.push('fixture');
        await mkdir(fixtureRoot, { recursive: true });
        await Promise.all([
          writeFile(join(fixtureRoot, '.inkstone-hat-owned'), 'owned\n', 'utf8'),
          writeFile(join(fixtureRoot, '.inkstone-s22-performance-hat.json'), '{}\n', 'utf8'),
        ]);
      },
      projectRoot: root,
      protocolDigest: 'a'.repeat(64),
      s27MainEvidenceRoot: join(s27Root, 'main'),
      s27WorkerEvidenceRoot: join(s27Root, 'worker'),
      s34EvidenceRoot,
    };

    const first = await prepareUnifiedPhysicalGate(input);
    await writeFile(join(s27Root, 'main', 'results.json'), '{"resume":"keep"}\n', 'utf8');
    const humanPath = join(s34EvidenceRoot, 'human-report.md');
    await writeFile(
      humanPath,
      (await readFile(humanPath, 'utf8')).replace(
        '| Pen tip following | PENDING |',
        '| Pen tip following | FAIL |',
      ),
      'utf8',
    );
    const second = await prepareUnifiedPhysicalGate(input);

    expect(first).toMatchObject({
      fixture: 'prepared-owned-synthetic',
      gateStatus: 'READY',
      mode: 'blank',
      publication: 'blocked',
      status: 'MANUAL_HANDOFF',
    });
    expect(second).toMatchObject({ fixture: 'reused-owned-synthetic' });
    expect(events).toEqual(['build', 'fixture', 'build']);
    await expect(readFile(join(s27Root, 'main', 'results.json'), 'utf8')).resolves.toBe(
      '{"resume":"keep"}\n',
    );
    await expect(readFile(humanPath, 'utf8')).resolves.toContain('| FAIL |');
    expect(JSON.stringify(first)).not.toContain(fixtureRoot);
  });

  it('cleanup is ownership-fenced and never removes release evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-cleanup-'));
    temporaryRoots.push(root);
    const fixtureRoot = join(root, 'fixture');
    const evidenceRoot = join(root, 'evidence');
    await Promise.all([mkdir(fixtureRoot, { recursive: true }), mkdir(evidenceRoot)]);
    await Promise.all([
      writeFile(join(fixtureRoot, '.inkstone-hat-owned'), 'owned\n', 'utf8'),
      writeFile(join(fixtureRoot, '.inkstone-s22-performance-hat.json'), '{}\n', 'utf8'),
      writeFile(join(evidenceRoot, 'resume.json'), '{"keep":true}\n', 'utf8'),
    ]);

    await expect(
      cleanupUnifiedPhysicalGate({
        cleanupFixture: async () => rm(fixtureRoot, { force: true, recursive: true }),
        fixtureRoot,
        projectRoot: root,
      }),
    ).resolves.toMatchObject({ command: 'cleanup', fixture: 'removed-owned-synthetic' });
    await expect(readFile(join(evidenceRoot, 'resume.json'), 'utf8')).resolves.toBe(
      '{"keep":true}\n',
    );

    await mkdir(fixtureRoot);
    await writeFile(join(fixtureRoot, 'personal.md'), 'do not delete\n', 'utf8');
    await expect(
      cleanupUnifiedPhysicalGate({
        cleanupFixture: async () => rm(fixtureRoot, { force: true, recursive: true }),
        fixtureRoot,
        projectRoot: root,
      }),
    ).rejects.toThrow(/ownership marker/iu);
    await expect(readFile(join(fixtureRoot, 'personal.md'), 'utf8')).resolves.toBe(
      'do not delete\n',
    );
  });

  it('refuses a non-empty unowned fixture before building or preparing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-unowned-'));
    temporaryRoots.push(root);
    const fixtureRoot = join(root, 'fixture');
    await mkdir(fixtureRoot);
    await writeFile(join(fixtureRoot, 'personal.md'), 'personal\n', 'utf8');
    const events: string[] = [];

    await expect(
      prepareUnifiedPhysicalGate({
        buildPhysicalHat: () => {
          events.push('build');
          return Promise.resolve();
        },
        fixtureRoot,
        inspectReadiness: () => Promise.resolve({ missing: [], status: 'READY' }),
        prepareFixture: () => {
          events.push('prepare');
          return Promise.resolve();
        },
        projectRoot: root,
        protocolDigest: 'a'.repeat(64),
        s27MainEvidenceRoot: join(root, 's27-main'),
        s27WorkerEvidenceRoot: join(root, 's27-worker'),
        s34EvidenceRoot: join(root, 's34'),
      }),
    ).rejects.toThrow(/non-empty.*ownership marker/iu);
    expect(events).toEqual([]);
    await expect(readFile(join(fixtureRoot, 'personal.md'), 'utf8')).resolves.toBe('personal\n');
  });

  it('treats path-bearing artifact metadata as incomplete even when every value otherwise passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-artifact-privacy-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: 'a'.repeat(64),
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });
    await writePassingGateInputs({ s27MainEvidenceRoot, s34EvidenceRoot });
    const artifacts = ['inkstone', 'notes', 'freeform'].flatMap((application) =>
      [1, 2, 3].map((runIndex) => ({
        application,
        artifactId: `${application}-run-${String(runIndex)}`,
        frameRate: 240,
        runIndex,
        sha256: 'b'.repeat(64),
        sizeBytes: 42,
        sourcePath: '/Users/tester/private.mov',
        strokeCount: 20,
      })),
    );
    await writeJson(join(s34EvidenceRoot, 'artifact-index.json'), {
      artifacts,
      schemaVersion: 1,
      verdict: 'PASS',
    });

    await expect(
      analyzeUnifiedReleaseGate({
        protocolDigest: TEST_PROTOCOL_DIGEST,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      }),
    ).resolves.toMatchObject({ automatedGate: 'INCOMPLETE', verdict: 'INCOMPLETE' });
  });

  it('does not duplicate the physical protocol for an unselected supported Worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-worker-required-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: 'a'.repeat(64),
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });
    const mainResult = passingFoundationResult(true);
    const validDecision = passingAdapterDecision(mainResult, true);
    await Promise.all([
      writeJson(join(s27MainEvidenceRoot, 'results.json'), mainResult),
      writeJson(join(s34EvidenceRoot, 'adapter-decision.json'), {
        ...validDecision,
        diagnosticsEvidenceDigest: null,
      }),
    ]);

    await expect(
      analyzeUnifiedReleaseGate({
        protocolDigest: TEST_PROTOCOL_DIGEST,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      }),
    ).resolves.toMatchObject({ adapterGate: 'INCOMPLETE', foundationGate: 'INCOMPLETE' });

    await writeJson(join(s34EvidenceRoot, 'adapter-decision.json'), validDecision);
    await expect(
      analyzeUnifiedReleaseGate({
        protocolDigest: TEST_PROTOCOL_DIGEST,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      }),
    ).resolves.toMatchObject({ foundationGate: 'PASS', workerGate: 'NOT_SELECTED' });
  });

  it('accepts four physical sessions on a selected Worker without a Main duplicate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-worker-selected-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: TEST_PROTOCOL_DIGEST,
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });
    const workerResult = {
      ...passingFoundationResult(true),
      presentationAdapter: 'worker-offscreen-2d',
    };
    await Promise.all([
      writeJson(join(s27WorkerEvidenceRoot, 'results.json'), workerResult),
      writeJson(join(s34EvidenceRoot, 'adapter-decision.json'), {
        ...passingAdapterDecision(workerResult, true),
        selectedAdapter: 'worker-offscreen-2d',
      }),
    ]);

    await expect(
      analyzeUnifiedReleaseGate({
        protocolDigest: TEST_PROTOCOL_DIGEST,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      }),
    ).resolves.toMatchObject({ foundationGate: 'PASS', workerGate: 'PASS' });
  });

  it('requires tester metadata, notes, limitations, and a RELEASE recommendation for human PASS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-human-metadata-'));
    temporaryRoots.push(root);
    const s27MainEvidenceRoot = join(root, 's27-main');
    const s27WorkerEvidenceRoot = join(root, 's27-worker');
    const s34EvidenceRoot = join(root, 's34');
    await initializeUnifiedReleaseEvidence({
      environment: { command: 'info', missing: [], status: 'READY' },
      protocolDigest: 'a'.repeat(64),
      s27MainEvidenceRoot,
      s27WorkerEvidenceRoot,
      s34EvidenceRoot,
    });
    const humanPath = join(s34EvidenceRoot, 'human-report.md');
    const ratingsOnly = (await readFile(humanPath, 'utf8')).replace(
      /^\| (.+?) \| PENDING \|.*\|$/gmu,
      (_row, checkpoint: string) => `| ${checkpoint} | PASS | verified by tester |`,
    );
    await writeFile(humanPath, ratingsOnly, 'utf8');
    await expect(
      analyzeUnifiedReleaseGate({
        protocolDigest: TEST_PROTOCOL_DIGEST,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      }),
    ).resolves.toMatchObject({ humanGate: 'INCOMPLETE' });

    await writeFile(
      humanPath,
      completeHumanReport(ratingsOnly).replace(
        '- Explicit release recommendation: RELEASE',
        '- Explicit release recommendation: HOLD',
      ),
      'utf8',
    );
    await expect(
      analyzeUnifiedReleaseGate({
        protocolDigest: TEST_PROTOCOL_DIGEST,
        s27MainEvidenceRoot,
        s27WorkerEvidenceRoot,
        s34EvidenceRoot,
      }),
    ).resolves.toMatchObject({ humanGate: 'FAIL', verdict: 'FAIL' });
  });
});

function passingAutomatedChecks() {
  return {
    adapterProvenance: 'PASS',
    brushGoldens: 'PASS',
    calibrationDiff: 'PASS',
    consumerParity: 'PASS',
    physicalHatBuild: 'PASS',
    privacyAudit: 'PASS',
    rasterOracle: 'PASS',
    repositoryGate: 'PASS',
  };
}

function passingCompatibilityChecks() {
  return {
    canonicalFailureRetention: 'PASS',
    iCloudSchemaConflict: 'PASS',
    legacyV1V2NoWrite: 'PASS',
    mixedLegacyPhysical: 'PASS',
    legacyRecoveryReadOnlyMigration: 'PASS',
    releasedOldBinaryFailClosed: 'PASS',
    rollbackRehearsal: 'PASS',
    schemaV3FirstCommandAtomic: 'PASS',
    unknownVersionFailClosed: 'PASS',
  };
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writePassingGateInputs({
  s27MainEvidenceRoot,
  s34EvidenceRoot,
}: {
  s27MainEvidenceRoot: string;
  s34EvidenceRoot: string;
}) {
  const automatedManifest = passingEvidenceManifest(Object.keys(passingAutomatedChecks()), 'a');
  const compatibilityManifest = passingEvidenceManifest(
    Object.keys(passingCompatibilityChecks()),
    'd',
  );
  const automatedManifestText = `${JSON.stringify(automatedManifest, null, 2)}\n`;
  const compatibilityManifestText = `${JSON.stringify(compatibilityManifest, null, 2)}\n`;
  await Promise.all([
    writeJson(join(s27MainEvidenceRoot, 'results.json'), passingFoundationResult(false)),
    writeJson(join(s34EvidenceRoot, 'automated-gate.json'), {
      checks: passingAutomatedChecks(),
      evidenceManifestSha256: createHash('sha256').update(automatedManifestText).digest('hex'),
      schemaVersion: 1,
      verdict: 'PASS',
    }),
    writeFile(
      join(s34EvidenceRoot, 'automated-evidence-manifest.json'),
      automatedManifestText,
      'utf8',
    ),
    writeJson(join(s34EvidenceRoot, 'compatibility-report.json'), {
      checks: passingCompatibilityChecks(),
      evidenceManifestSha256: createHash('sha256').update(compatibilityManifestText).digest('hex'),
      releasedOldBinary: {
        binarySha256: 'c'.repeat(64),
        resultArtifactSha256: 'd'.repeat(64),
        verdict: 'PASS',
        version: 'released-test-version',
      },
      schemaVersion: 1,
      verdict: 'PASS',
    }),
    writeFile(
      join(s34EvidenceRoot, 'compatibility-evidence-manifest.json'),
      compatibilityManifestText,
      'utf8',
    ),
    writeJson(
      join(s34EvidenceRoot, 'adapter-decision.json'),
      passingAdapterDecision(passingFoundationResult(false), false),
    ),
  ]);
  const humanPath = join(s34EvidenceRoot, 'human-report.md');
  await writeFile(humanPath, completeHumanReport(await readFile(humanPath, 'utf8')), 'utf8');
}

function passingEvidenceManifest(checkIds: string[], shaCharacter: string) {
  return {
    artifacts: checkIds.map((checkId) => ({
      checkId,
      sha256: shaCharacter.repeat(64),
      sizeBytes: 42,
    })),
    schemaVersion: 1,
  };
}

function completeHumanReport(report: string) {
  return report
    .replace(
      /^\| (.+?) \| PENDING \|.*\|$/gmu,
      (_row, checkpoint: string) => `| ${checkpoint} | PASS | verified by tester |`,
    )
    .replace('- Tester: PENDING', '- Tester: ivan')
    .replace('- Session date/time: PENDING', '- Session date/time: 2026-07-18T12:00:00+08:00')
    .replace('- Unresolved limitations: PENDING', '- Unresolved limitations: none observed')
    .replace(
      '- Explicit release recommendation: PENDING',
      '- Explicit release recommendation: RELEASE',
    );
}

async function analyzeMutatedHumanReport(mutate: (report: string) => string) {
  const root = await mkdtemp(join(tmpdir(), 'inkstone-native-feel-human-duplicate-'));
  temporaryRoots.push(root);
  const s27MainEvidenceRoot = join(root, 's27-main');
  const s27WorkerEvidenceRoot = join(root, 's27-worker');
  const s34EvidenceRoot = join(root, 's34');
  await initializeUnifiedReleaseEvidence({
    environment: { command: 'info', missing: [], status: 'READY' },
    protocolDigest: TEST_PROTOCOL_DIGEST,
    s27MainEvidenceRoot,
    s27WorkerEvidenceRoot,
    s34EvidenceRoot,
  });
  const humanPath = join(s34EvidenceRoot, 'human-report.md');
  const completed = completeHumanReport(await readFile(humanPath, 'utf8'));
  await writeFile(humanPath, mutate(completed), 'utf8');
  return analyzeUnifiedReleaseGate({
    protocolDigest: TEST_PROTOCOL_DIGEST,
    s27MainEvidenceRoot,
    s27WorkerEvidenceRoot,
    s34EvidenceRoot,
  });
}

async function recordAllReferenceArtifacts({
  s34EvidenceRoot,
  sourcePath,
}: {
  s34EvidenceRoot: string;
  sourcePath: string;
}) {
  for (const application of ['inkstone', 'notes', 'freeform']) {
    await recordReferenceArtifact({
      artifactId: `${application}-run-1`,
      frameRate: 240,
      s34EvidenceRoot,
      sourcePath,
      strokeCount: 20,
    });
  }
}

function passingFoundationResult(workerSupported: boolean) {
  const outcome = workerSupported
    ? { available: true, failureCategory: 'none' }
    : { available: false, failureCategory: 'api-unavailable' };
  return {
    automatedVerdict: 'PASS',
    captures: [
      {
        runtimeCapabilities: {
          dedicatedWorkerConstruct: outcome,
          offscreenCanvas2d: outcome,
          offscreenCanvasTransfer: outcome,
        },
      },
    ],
    gateVerdict: 'PASS',
    presentationAdapter: 'main-canvas-2d',
    protocolDigest: TEST_PROTOCOL_DIGEST,
    schemaVersion: 2,
  };
}

function passingAdapterDecision(
  foundation: ReturnType<typeof passingFoundationResult>,
  workerSupported: boolean,
) {
  const normalizedCapabilities = foundation.captures.map(({ runtimeCapabilities }) =>
    Object.fromEntries(
      Object.entries(runtimeCapabilities).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
  return {
    capabilityEvidenceDigest: createHash('sha256')
      .update(JSON.stringify(normalizedCapabilities))
      .digest('hex'),
    diagnosticsOnOff: 'PASS',
    diagnosticsEvidenceDigest: 'e'.repeat(64),
    mainWorkerAb: workerSupported ? 'PASS' : 'NOT_APPLICABLE',
    mainWorkerAbEvidenceDigest: workerSupported ? 'f'.repeat(64) : null,
    schemaVersion: 1,
    selectedAdapter: 'main-canvas-2d',
    verdict: 'PASS',
    workerDisposition: workerSupported ? 'supported' : 'proven-unsupported',
    workerReasonCategories: workerSupported ? [] : ['api-unavailable'],
  };
}
