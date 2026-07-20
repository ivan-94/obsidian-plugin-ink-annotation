/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- The public CLI module validates untyped device JSON at runtime. */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  advanceS27Condition,
  analyzeS27Capture,
  analyzeS27Evidence,
  computeS27ProtocolDigest,
  initializeS27Evidence,
  listS27PhysicalSessions,
  prepareS27,
  selectPhysicalIpad,
} from './ink-foundation-ipad-gate.mjs';
import {
  computeLocalImplementationDigest,
  computeLocalObsidianProtocolDigest,
} from './ink-local-obsidian-performance-gate.mjs';

const executeFile = promisify(execFile);
const scriptPath = fileURLToPath(new URL('./ink-foundation-ipad-gate.mjs', import.meta.url));
const temporaryRoots: string[] = [];
const TEST_PROTOCOL_DIGEST = 'c'.repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('S27 connected-device Gate runner', () => {
  it('exposes exactly four single-run physical sessions', () => {
    expect(listS27PhysicalSessions()).toEqual([
      { conditionId: 'session-1-empty-pen-highlighter', runs: 1 },
      { conditionId: 'session-2-history-10k-30-surfaces', runs: 1 },
      { conditionId: 'session-3-navigation-layout', runs: 1 },
      { conditionId: 'session-4-stability-reference', runs: 1 },
    ]);
  });

  it('selects one connected physical iPad and keeps identifiers out of evidence', () => {
    const selected = selectPhysicalIpad({
      result: {
        devices: [
          {
            connectionProperties: {
              pairingState: 'paired',
              potentialHostnames: ['private.coredevice.local'],
              transportType: 'wired',
              tunnelState: 'connected',
            },
            deviceProperties: {
              bootState: 'booted',
              name: 'Private iPad Name',
              osVersionNumber: '27.0',
            },
            hardwareProperties: {
              deviceType: 'iPad',
              marketingName: 'iPad mini (6th generation)',
              platform: 'iOS',
              productType: 'iPad14,1',
              reality: 'physical',
              serialNumber: 'PRIVATE-SERIAL',
            },
            identifier: 'PRIVATE-DEVICE-ID',
          },
          {
            connectionProperties: { pairingState: 'paired' },
            deviceProperties: { bootState: 'booted', name: 'Simulator' },
            hardwareProperties: {
              deviceType: 'iPad',
              platform: 'iOS',
              productType: 'iPad14,1',
              reality: 'simulator',
            },
            identifier: 'SIMULATOR-ID',
          },
        ],
      },
    });

    expect(selected.selector).toBe('PRIVATE-DEVICE-ID');
    expect(selected.evidence).toEqual({
      bootState: 'booted',
      deviceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      iPadOS: '27.0',
      model: 'iPad mini (6th generation)',
      pairingState: 'paired',
      physical: true,
      productType: 'iPad14,1',
      transport: 'wired',
      tunnelState: 'connected',
    });
    expect(JSON.stringify(selected.evidence)).not.toMatch(
      /PRIVATE|private\.coredevice|serial|identifier/iu,
    );
  });

  it('exposes a read-only info command with explicit incomplete readiness', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-info-'));
    temporaryRoots.push(projectRoot);
    const deviceListPath = join(projectRoot, 'devices.json');
    const deviceDetailsPath = join(projectRoot, 'device-details.json');
    await mkdir(join(projectRoot, '.hat'), { recursive: true });
    await Promise.all([
      writeFile(join(projectRoot, 'main.js'), 'production bundle', 'utf8'),
      writeFile(join(projectRoot, 'manifest.json'), '{"version":"0.1.0"}\n', 'utf8'),
      writeFile(join(projectRoot, 'styles.css'), '/* production */\n', 'utf8'),
      writeFile(join(projectRoot, '.hat', '.inkstone-hat-owned'), 'owned\n', 'utf8'),
      writeFile(join(projectRoot, '.hat', '.inkstone-s22-performance-hat.json'), '{}\n', 'utf8'),
      writeFile(
        deviceListPath,
        JSON.stringify({
          result: {
            devices: [
              {
                connectionProperties: {
                  pairingState: 'paired',
                  transportType: 'wired',
                  tunnelState: 'connected',
                },
                deviceProperties: { osVersionNumber: '27.0' },
                hardwareProperties: {
                  deviceType: 'iPad',
                  marketingName: 'iPad mini (6th generation)',
                  platform: 'iOS',
                  productType: 'iPad14,1',
                  reality: 'physical',
                },
                identifier: 'PRIVATE-DEVICE-ID',
              },
            ],
          },
        }),
        'utf8',
      ),
      writeFile(
        deviceDetailsPath,
        JSON.stringify({
          result: {
            connectionProperties: { tunnelState: 'connected' },
            deviceProperties: { developerModeStatus: 'disabled', releaseType: 'Beta' },
            hardwareProperties: { reality: 'physical' },
          },
        }),
        'utf8',
      ),
    ]);
    const before = await readdir(projectRoot);

    const result = await executeFile(process.execPath, [scriptPath, 'info'], {
      env: {
        ...process.env,
        INKSTONE_S27_AVAILABLE_STORAGE: '20 GB',
        INKSTONE_S27_DEVICE_DETAILS_JSON: deviceDetailsPath,
        INKSTONE_S27_HAT_OUTPUT: join(projectRoot, '.hat'),
        INKSTONE_S27_LOW_POWER_MODE: 'off',
        INKSTONE_S27_OBSIDIAN_VERSION: 'latest',
        INKSTONE_S27_PENCIL_MODEL: 'Apple Pencil 2',
        INKSTONE_S27_REFRESH_MODE: '60 Hz fixed',
        INKSTONE_S27_TESTER: 'Ivan',
        INKSTONE_PROJECT_ROOT: projectRoot,
        INKSTONE_S27_DEVICE_LIST_JSON: deviceListPath,
      },
    });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      command: 'info',
      environment: {
        device: {
          developerMode: 'disabled',
          bootState: 'unavailable',
          iPadOS: '27.0',
          model: 'iPad mini (6th generation)',
          physical: true,
          releaseType: 'Beta',
          tunnelState: 'connected',
        },
        fixture: { status: 'prepared' },
        plugin: { status: 'built' },
      },
      missing: ['deviceBootState'],
      status: 'INCOMPLETE',
    });
    expect(result.stdout).not.toContain('PRIVATE-DEVICE-ID');
    expect(await readdir(projectRoot)).toEqual(before);
    await expect(readFile(join(projectRoot, 'environment.json'), 'utf8')).rejects.toThrow();
  });

  it('initializes the required resumable evidence layout without inventing human ratings', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-evidence-'));
    temporaryRoots.push(evidenceRoot);

    await initializeS27Evidence({
      evidenceRoot,
      environment: {
        command: 'info',
        environment: { device: { physical: true } },
        missing: ['pencilModel'],
        schemaVersion: 1,
        status: 'INCOMPLETE',
      },
      protocolDigest: 'protocol-digest',
    });

    expect((await readdir(evidenceRoot)).sort()).toEqual([
      '.inkstone-s27-evidence-owned',
      'environment.json',
      'human-report.md',
      'performance.md',
      'raw',
      'results.json',
      'risk-register.md',
    ]);
    expect(JSON.parse(await readFile(join(evidenceRoot, 'results.json'), 'utf8'))).toMatchObject({
      automatedVerdict: 'INCOMPLETE',
      conditions: [],
      protocolDigest: 'protocol-digest',
      schemaVersion: 2,
    });
    const humanReport = await readFile(join(evidenceRoot, 'human-report.md'), 'utf8');
    expect(humanReport).toContain('| Tip following | PENDING |');
    expect(humanReport).not.toMatch(/\| (PASS|FAIL) \|/u);
  });

  it('prepares production artifacts before the owned fixture and stops at an explicit handoff', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-prepare-'));
    temporaryRoots.push(projectRoot);
    const evidenceRoot = join(projectRoot, 'evidence');
    const fixtureRoot = join(projectRoot, 'fixture');
    const events: string[] = [];
    const readiness = {
      command: 'info',
      environment: {
        device: { physical: true },
        fixture: { status: 'prepared' },
        manual: { pencilModel: null },
        plugin: { status: 'built' },
      },
      missing: ['pencilModel'],
      schemaVersion: 1,
      status: 'INCOMPLETE',
    };

    const result = await prepareS27({
      buildProduction: () => {
        events.push('build');
        return Promise.resolve();
      },
      evidenceRoot,
      fixtureRoot,
      inspectReadiness: () => Promise.resolve(readiness),
      prepareFixture: () => {
        events.push('fixture');
        return Promise.resolve();
      },
      projectRoot,
      protocolDigest: 'protocol-digest',
    });

    expect(events).toEqual(['build', 'fixture']);
    expect(result).toEqual({
      command: 'prepare',
      gateStatus: 'INCOMPLETE',
      handoff: {
        automaticInstall: false,
        vaultName: 'fixture',
      },
      status: 'MANUAL_HANDOFF',
    });
    expect(JSON.parse(await readFile(join(evidenceRoot, 'environment.json'), 'utf8'))).toEqual(
      readiness,
    );
  });

  it('starts a named condition by writing only a marker and an explicit human action card', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-run-'));
    temporaryRoots.push(projectRoot);
    const evidenceRoot = join(projectRoot, 'evidence');
    const fixtureRoot = join(projectRoot, 'fixture');
    await Promise.all([
      mkdir(join(evidenceRoot, 'raw'), { recursive: true }),
      mkdir(fixtureRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(fixtureRoot, '.inkstone-hat-owned'), 'owned\n', 'utf8'),
      writeFile(join(fixtureRoot, '.inkstone-s22-performance-hat.json'), '{}\n', 'utf8'),
    ]);

    const result = await advanceS27Condition({
      conditionId: 'session-1-empty-pen-highlighter',
      evidenceRoot,
      fixtureRoot,
      protocolDigest: 'c'.repeat(64),
      readiness: {
        environment: {
          device: { deviceDigest: 'd'.repeat(64), physical: true },
          fixture: { fixtureDigest: 'b'.repeat(64), status: 'prepared' },
          manual: { tester: 'Ivan' },
          plugin: { buildDigest: 'a'.repeat(64), status: 'built' },
        },
        missing: [],
        status: 'READY',
      },
    });

    expect(result).toMatchObject({
      actionCard: expect.arrayContaining([
        expect.stringContaining('Start S27 physical Gate capture'),
        expect.stringContaining('100 strokes'),
      ]),
      conditionId: 'session-1-empty-pen-highlighter',
      presentationAdapter: 'main-canvas-2d',
      runIndex: 1,
      status: 'AWAITING_HUMAN',
    });
    expect(JSON.parse(await readFile(join(fixtureRoot, 'S27 Condition.json'), 'utf8'))).toEqual({
      adapter: 'pointer',
      buildDigest: 'a'.repeat(64),
      conditionId: 'session-1-empty-pen-highlighter',
      deviceDigest: 'd'.repeat(64),
      fixtureDigest: 'b'.repeat(64),
      presentationAdapter: 'main-canvas-2d',
      protocolDigest: 'c'.repeat(64),
      runIndex: 1,
      schemaVersion: 2,
      tester: 'Ivan',
    });
    await expect(readFile(join(evidenceRoot, 'environment.json'), 'utf8')).resolves.toContain(
      'Ivan',
    );
    expect(JSON.stringify(result)).not.toMatch(/synthetic|dispatchEvent|XCTest/iu);

    await expect(
      advanceS27Condition({
        conditionId: 'session-1-empty-pen-highlighter',
        evidenceRoot,
        fixtureRoot,
        presentationAdapter: 'webgpu' as never,
        protocolDigest: 'c'.repeat(64),
        readiness: {
          environment: {
            device: { deviceDigest: 'd'.repeat(64), physical: true },
            fixture: { fixtureDigest: 'b'.repeat(64), status: 'prepared' },
            manual: { tester: 'Ivan' },
            plugin: { buildDigest: 'a'.repeat(64), status: 'built' },
          },
          missing: [],
          status: 'READY',
        },
      }),
    ).rejects.toThrow('Invalid S27 condition presentation Adapter.');
  });

  it.each([
    { argument: 'worker-offscreen-2d', environment: undefined, label: 'run argument' },
    { argument: undefined, environment: 'worker-offscreen-2d', label: 'environment fence' },
  ])('accepts the presentation Adapter from the CLI $label', async ({ argument, environment }) => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-cli-presentation-'));
    temporaryRoots.push(projectRoot);
    const cli = await createCliRunFixture(projectRoot);
    const selectedEvidenceRoot = join(projectRoot, 'selected-evidence');
    const args = [scriptPath, 'run', 'session-1-empty-pen-highlighter'];
    if (argument !== undefined) args.push(argument);

    const result = await executeFile(process.execPath, args, {
      env: {
        ...process.env,
        ...cli.environment,
        INKSTONE_S27_EVIDENCE_ROOT: selectedEvidenceRoot,
        ...(environment === undefined ? {} : { INKSTONE_S27_PRESENTATION_ADAPTER: environment }),
      },
    });

    expect(JSON.parse(result.stdout)).toMatchObject({
      conditionId: 'session-1-empty-pen-highlighter',
      runIndex: 1,
      status: 'AWAITING_HUMAN',
    });
    expect(
      JSON.parse(await readFile(join(cli.fixtureRoot, 'S27 Condition.json'), 'utf8')),
    ).toMatchObject({ presentationAdapter: 'worker-offscreen-2d', runIndex: 1 });
    await expect(
      readFile(join(selectedEvidenceRoot, 'environment.json'), 'utf8'),
    ).resolves.toContain('Apple Pencil 2');
  });

  it('blocks iPad marker generation before readiness when the current local Gate is absent', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-local-blocker-'));
    temporaryRoots.push(projectRoot);
    const cli = await createCliRunFixture(projectRoot);
    await rm(
      join(
        projectRoot,
        'docs',
        'delivery',
        'slices',
        'S27R6-local-obsidian-performance-gate',
        'results.json',
      ),
    );

    await expect(
      executeFile(process.execPath, [scriptPath, 'run', 'session-1-empty-pen-highlighter'], {
        env: { ...process.env, ...cli.environment },
      }),
    ).rejects.toThrow(
      'S27R6 Local Obsidian Performance Gate PASS is required before iPad capture.',
    );
    await expect(readFile(join(cli.fixtureRoot, 'S27 Condition.json'), 'utf8')).rejects.toThrow();
  });

  it('checkpoints a matching device export and completes the single-run session', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-resume-'));
    temporaryRoots.push(projectRoot);
    const evidenceRoot = join(projectRoot, 'evidence');
    const fixtureRoot = join(projectRoot, 'fixture');
    await Promise.all([
      mkdir(join(evidenceRoot, 'raw'), { recursive: true }),
      mkdir(fixtureRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(fixtureRoot, '.inkstone-hat-owned'), 'owned\n', 'utf8'),
      writeFile(join(fixtureRoot, '.inkstone-s22-performance-hat.json'), '{}\n', 'utf8'),
    ]);
    const readiness = {
      environment: {
        device: { deviceDigest: 'd'.repeat(64), physical: true },
        fixture: { fixtureDigest: 'b'.repeat(64), status: 'prepared' },
        manual: { tester: 'Ivan' },
        plugin: { buildDigest: 'a'.repeat(64), status: 'built' },
      },
      missing: [],
      status: 'READY',
    };
    const input = {
      conditionId: 'session-1-empty-pen-highlighter',
      evidenceRoot,
      fixtureRoot,
      protocolDigest: 'c'.repeat(64),
      readiness,
    };
    await advanceS27Condition(input);
    const condition = JSON.parse(await readFile(join(fixtureRoot, 'S27 Condition.json'), 'utf8'));
    const deviceCapture = validSyntheticCapture();
    deviceCapture.condition = condition;
    await writeFile(
      join(fixtureRoot, 'S27 Diagnostics.json'),
      `${JSON.stringify(deviceCapture)}\n`,
      'utf8',
    );

    const captured = await advanceS27Condition(input);

    expect(captured).toMatchObject({
      artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      conditionId: 'session-1-empty-pen-highlighter',
      runIndex: 1,
      status: 'CAPTURED',
    });
    await expect(
      readFile(
        join(
          evidenceRoot,
          'raw',
          'session-1-empty-pen-highlighter-pointer-main-canvas-2d-run-1.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('2026-07-17T12:00:00.000Z');

    const resumed = await advanceS27Condition(input);
    expect(resumed).toMatchObject({ runCount: 1, status: 'COMPLETE' });

    await expect(
      advanceS27Condition({
        ...input,
        presentationAdapter: 'worker-offscreen-2d',
      }),
    ).rejects.toThrow('S27 existing condition runs do not match the current evidence fence.');
    await expect(
      readFile(
        join(
          evidenceRoot,
          'raw',
          'session-1-empty-pen-highlighter-pointer-main-canvas-2d-run-1.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('2026-07-17T12:00:00.000Z');
  });

  it('fails closed before the next run when a captured run mixes input adapters', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-invalid-capture-'));
    temporaryRoots.push(projectRoot);
    const evidenceRoot = join(projectRoot, 'evidence');
    const fixtureRoot = join(projectRoot, 'fixture');
    await Promise.all([
      mkdir(join(evidenceRoot, 'raw'), { recursive: true }),
      mkdir(fixtureRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(fixtureRoot, '.inkstone-hat-owned'), 'owned\n', 'utf8'),
      writeFile(join(fixtureRoot, '.inkstone-s22-performance-hat.json'), '{}\n', 'utf8'),
    ]);
    const input = {
      conditionId: 'session-1-empty-pen-highlighter',
      evidenceRoot,
      fixtureRoot,
      protocolDigest: TEST_PROTOCOL_DIGEST,
      readiness: {
        environment: {
          device: { deviceDigest: 'd'.repeat(64), physical: true },
          fixture: { fixtureDigest: 'b'.repeat(64), status: 'prepared' },
          manual: { tester: 'Ivan' },
          plugin: { buildDigest: 'a'.repeat(64), status: 'built' },
        },
        missing: [],
        status: 'READY',
      },
    };
    await advanceS27Condition(input);
    const capture = validSyntheticCapture();
    const contradictory = capture.diagnostics.recentSpans.find(
      (sample) => sample.name === 'ink-input-to-submit',
    );
    if (contradictory === undefined) throw new Error('Missing synthetic input span.');
    contradictory.adapter = 'stylus-touch';
    await writeFile(
      join(fixtureRoot, 'S27 Diagnostics.json'),
      `${JSON.stringify(capture)}\n`,
      'utf8',
    );
    await expect(advanceS27Condition(input)).resolves.toMatchObject({
      runIndex: 1,
      status: 'CAPTURED',
    });

    await expect(advanceS27Condition(input)).rejects.toThrow(
      'S27 captured run 1 is invalid: Malformed S27 input span adapter evidence.',
    );
    expect(
      JSON.parse(await readFile(join(fixtureRoot, 'S27 Condition.json'), 'utf8')).runIndex,
    ).toBe(1);
  });

  it.each([
    ['buildDigest', 'e'.repeat(64)],
    ['deviceDigest', 'e'.repeat(64)],
    ['fixtureDigest', 'e'.repeat(64)],
    ['presentationAdapter', 'worker-offscreen-2d'],
    ['protocolDigest', 'e'.repeat(64)],
  ])(
    'refuses to resume condition runs across a different %s fence',
    async (field, conflictingValue) => {
      const projectRoot = await mkdtemp(join(tmpdir(), `inkstone-s27-resume-${field}-`));
      temporaryRoots.push(projectRoot);
      const evidenceRoot = join(projectRoot, 'evidence');
      const rawRoot = join(evidenceRoot, 'raw');
      const fixtureRoot = join(projectRoot, 'fixture');
      await Promise.all([
        mkdir(rawRoot, { recursive: true }),
        mkdir(fixtureRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(fixtureRoot, '.inkstone-hat-owned'), 'owned\n', 'utf8'),
        writeFile(join(fixtureRoot, '.inkstone-s22-performance-hat.json'), '{}\n', 'utf8'),
      ]);
      const oldCapture = validSyntheticCapture();
      (oldCapture.condition as Record<string, unknown>)[field] = conflictingValue;
      await writeFile(
        join(rawRoot, 'session-1-empty-pen-highlighter-pointer-main-canvas-2d-run-1.json'),
        `${JSON.stringify(oldCapture)}\n`,
        'utf8',
      );

      await expect(
        advanceS27Condition({
          conditionId: 'session-1-empty-pen-highlighter',
          evidenceRoot,
          fixtureRoot,
          protocolDigest: 'c'.repeat(64),
          readiness: {
            environment: {
              device: { deviceDigest: 'd'.repeat(64), physical: true },
              fixture: { fixtureDigest: 'b'.repeat(64), status: 'prepared' },
              manual: { tester: 'Ivan' },
              plugin: { buildDigest: 'a'.repeat(64), status: 'built' },
            },
            missing: [],
            status: 'READY',
          },
        }),
      ).rejects.toThrow('S27 existing condition runs do not match the current evidence fence.');
      await expect(readFile(join(fixtureRoot, 'S27 Condition.json'), 'utf8')).rejects.toThrow();
    },
  );

  it('analyzes fixed S27 budgets deterministically from raw device samples', () => {
    const result = analyzeS27Capture(validSyntheticCapture());

    expect(result).toMatchObject({
      metrics: {
        missedFrameRatio: 0.0099,
        refresh: { p10Ms: 16.7, p50Ms: 16.7, p90Ms: 16.7, rMs: 16.7 },
      },
      sampleCounts: { completedStrokes: 118, moveBatches: 1_000 },
      verdict: 'PASS',
    });
    expect(result.failedBudgets).toEqual([]);
  });

  it('requires the Live-first persistence guards and keeps persistence out of hot lanes', () => {
    const missingGuard = validSyntheticCapture();
    missingGuard.diagnostics.armedAuditGuards.pop();
    expect(analyzeS27Capture(missingGuard).failedBudgets).toContain(
      'live-first:all-hot-path-audit-guards-armed',
    );

    const hotPersistence = validSyntheticCapture();
    hotPersistence.diagnostics.auditedWork.push({
      count: 1,
      kind: 'draft-storage-write',
      phase: 'completion',
    });
    hotPersistence.diagnostics.forbiddenWork.push({
      count: 1,
      kind: 'draft-storage-write',
      phase: 'completion',
    });
    expect(analyzeS27Capture(hotPersistence).failedBudgets).toEqual(
      expect.arrayContaining(['live-first:persistence-work-cold-only', 'forbidden-active-work=0']),
    );

    const slowCanonicalSubmit = validSyntheticCapture();
    const canonicalSubmit = slowCanonicalSubmit.diagnostics.recentSpans.find(
      (sample) => sample.name === 'ink-canonical-persistence-submit',
    );
    if (canonicalSubmit === undefined) throw new Error('Missing synthetic canonical submit span.');
    canonicalSubmit.durationMs = 13;
    expect(analyzeS27Capture(slowCanonicalSubmit).failedBudgets).toContain(
      'ink-canonical-persistence-submit:P99<=12ms',
    );
  });

  it('fails closed when the bounded diagnostics capture dropped span evidence', () => {
    const capture = validSyntheticCapture();
    capture.diagnostics.droppedSpanCount = 1;

    expect(analyzeS27Capture(capture).failedBudgets).toContain('diagnostics:dropped-span-count=0');
  });

  it('rejects missing or internally inconsistent runtime capability evidence', () => {
    const missing = validSyntheticCapture();
    Reflect.deleteProperty(missing, 'runtimeCapabilities');
    expect(() => analyzeS27Capture(missing)).toThrow(
      'S27 capture is missing complete runtime capability evidence.',
    );

    const inconsistent = validSyntheticCapture();
    Object.assign(
      inconsistent.runtimeCapabilities.wasm as {
        available: boolean;
        failureCategory: string;
      },
      { available: true, failureCategory: 'probe-failed' },
    );
    expect(() => analyzeS27Capture(inconsistent)).toThrow(
      'Malformed S27 runtime capability evidence: wasm.',
    );
  });

  it('requires proved Worker and OffscreenCanvas transport for a Worker presentation artifact', () => {
    const capture = validSyntheticCapture();
    capture.condition.presentationAdapter = 'worker-offscreen-2d';
    Object.assign(
      capture.runtimeCapabilities.offscreenCanvasTransfer as {
        available: boolean;
        failureCategory: string;
      },
      { available: false, failureCategory: 'transfer-failed' },
    );

    expect(() => analyzeS27Capture(capture)).toThrow(
      'S27 Worker presentation artifact lacks required runtime capabilities.',
    );
  });

  it('rejects input spans that do not explicitly carry the condition adapter', () => {
    const capture = validSyntheticCapture();
    const inputSpan = capture.diagnostics.recentSpans.find(
      (sample) => sample.name === 'ink-input-handler',
    );
    if (inputSpan === undefined) throw new Error('Missing synthetic input span.');
    Reflect.deleteProperty(inputSpan, 'adapter');

    expect(() => analyzeS27Capture(capture)).toThrow('Malformed S27 input span adapter evidence.');
  });

  it('rejects input spans whose adapter contradicts the condition adapter', () => {
    const capture = validSyntheticCapture();
    const inputSpan = capture.diagnostics.recentSpans.find(
      (sample) => sample.name === 'ink-input-to-submit',
    );
    if (inputSpan === undefined) throw new Error('Missing synthetic input-to-submit span.');
    inputSpan.adapter = 'touch';

    expect(() => analyzeS27Capture(capture)).toThrow('Malformed S27 input span adapter evidence.');
  });

  it('rejects malformed members in every raw numeric evidence array', () => {
    const malformedArrays: Array<{
      corrupt: (capture: ReturnType<typeof validSyntheticCapture>) => void;
      label: string;
    }> = [
      {
        corrupt: (capture) => capture.diagnostics.frameIntervalsMs.idle.push(Number.NaN),
        label: 'diagnostics.frameIntervalsMs.idle',
      },
      {
        corrupt: (capture) =>
          capture.diagnostics.frameIntervalsMs.activeWriting.push(Number.POSITIVE_INFINITY),
        label: 'diagnostics.frameIntervalsMs.activeWriting',
      },
      {
        corrupt: (capture) =>
          (capture.diagnostics.frameIntervalsMs.hostGaps as unknown[]).push('50.1'),
        label: 'diagnostics.frameIntervalsMs.hostGaps',
      },
      {
        corrupt: (capture) => (capture.longTasks.durationsMs as unknown[]).push(null),
        label: 'longTasks.durationsMs',
      },
    ];

    for (const { corrupt, label } of malformedArrays) {
      const capture = validSyntheticCapture();
      corrupt(capture);

      expect(() => analyzeS27Capture(capture)).toThrow(`Malformed S27 numeric evidence: ${label}.`);
    }
  });

  it('keeps idle heartbeat, host gaps, and active generation debt out of each other', () => {
    const generationDebtCapture = validSyntheticCapture();
    generationDebtCapture.diagnostics.frameIntervalsMs.activeWriting = [50.1];
    generationDebtCapture.diagnostics.frameIntervalsMs.hostGaps = [];
    const generationDebt = analyzeS27Capture(generationDebtCapture);

    expect(generationDebt.metrics.hostGapCount).toBe(0);
    expect(generationDebt.failedBudgets).toContain('missed-frame-ratio<1%');
    expect(generationDebt.failedBudgets).not.toContain('zero->=50ms-host-gaps');

    const hostGapCapture = validSyntheticCapture();
    hostGapCapture.diagnostics.frameIntervalsMs.activeWriting = [16.7];
    hostGapCapture.diagnostics.frameIntervalsMs.hostGaps = [50.1];
    const hostGap = analyzeS27Capture(hostGapCapture);

    expect(hostGap.metrics.missedFrameRatio).toBe(0);
    expect(hostGap.metrics.hostGapCount).toBe(1);
    expect(hostGap.failedBudgets).toContain('zero->=50ms-host-gaps');
    expect(hostGap.failedBudgets).not.toContain('missed-frame-ratio<1%');
    expect(hostGap.metrics.frameLanes).toMatchObject({
      activeGenerationDebt: { maximumMs: 16.7, sampleCount: 1 },
      hostGap: { maximumMs: 50.1, sampleCount: 1 },
      idleHeartbeat: { maximumMs: 16.7, sampleCount: 120 },
    });

    const missingHostGapLane = validSyntheticCapture();
    Reflect.deleteProperty(missingHostGapLane.diagnostics.frameIntervalsMs, 'hostGaps');
    expect(analyzeS27Capture(missingHostGapLane).failedBudgets).toContain(
      'host-gap-evidence-present',
    );

    const longTaskCapture = validSyntheticCapture();
    longTaskCapture.longTasks = { available: true, durationsMs: [50.1] };
    const longTask = analyzeS27Capture(longTaskCapture);
    expect(longTask.failedBudgets).toContain('zero->=50ms-long-tasks');
    expect(longTask.failedBudgets).not.toContain('zero->=50ms-host-gaps');
  });

  it('replays the same frozen synthetic raw capture to byte-identical analysis', () => {
    const raw = deepFreeze(validSyntheticCapture());
    const rawBefore = JSON.stringify(raw);

    const first = analyzeS27Capture(raw);
    const second = analyzeS27Capture(raw);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(raw)).toBe(rawBefore);
  });

  it('writes byte-identical aggregate results for the same synthetic raw evidence', async () => {
    const roots = await Promise.all([
      mkdtemp(join(tmpdir(), 'inkstone-s27-replay-a-')),
      mkdtemp(join(tmpdir(), 'inkstone-s27-replay-b-')),
    ]);
    temporaryRoots.push(...roots);
    const raw = `${JSON.stringify(validSyntheticCapture())}\n`;
    for (const root of roots) {
      await mkdir(join(root, 'raw'), { recursive: true });
      await writeFile(
        join(root, 'raw', 'session-1-empty-pen-highlighter-pointer-run-1.json'),
        raw,
        'utf8',
      );
      await analyzeS27Evidence({ evidenceRoot: root, protocolDigest: TEST_PROTOCOL_DIGEST });
    }

    const [firstResults, secondResults, firstPerformance, secondPerformance] = await Promise.all([
      readFile(join(roots[0] ?? '', 'results.json'), 'utf8'),
      readFile(join(roots[1] ?? '', 'results.json'), 'utf8'),
      readFile(join(roots[0] ?? '', 'performance.md'), 'utf8'),
      readFile(join(roots[1] ?? '', 'performance.md'), 'utf8'),
    ]);

    expect(secondResults).toBe(firstResults);
    expect(secondPerformance).toBe(firstPerformance);
  });

  it('fails closed when presentation outcomes are missing or contradict acceptance', () => {
    const result = analyzeS27Capture({
      capturedAt: '2026-07-17T12:00:00.000Z',
      condition: {
        adapter: 'pointer',
        buildDigest: 'a'.repeat(64),
        conditionId: 'session-1-empty-pen-highlighter',
        deviceDigest: 'd'.repeat(64),
        fixtureDigest: 'b'.repeat(64),
        presentationAdapter: 'main-canvas-2d',
        protocolDigest: 'c'.repeat(64),
        runIndex: 1,
        schemaVersion: 2,
        tester: 'Ivan',
      },
      diagnostics: {
        forbiddenWork: [],
        frameIntervalsMs: { activeWriting: [], hostGaps: [], idle: [] },
        memory: {
          activeWorkingSetBytes: 0,
          backingStoreBytes: 0,
          disposableCacheBytes: 0,
        },
        recentSpans: [
          span('ink-input-to-submit', 8, 'input'),
          span('ink-input-to-submit', 8, 'input', {
            accepted: false,
            presentationOutcome: 'submitted',
          }),
        ],
      },
      longTasks: { available: false, durationsMs: [] },
      runtimeCapabilities: runtimeCapabilities(),
      schemaVersion: 2,
    });

    expect(result.failedBudgets).toContain('ink-input-to-submit:presentation-outcome-present');
    expect(result.failedBudgets).toContain('ink-input-to-submit:presentation-outcome-consistent');
    expect(result.failedBudgets).toContain('ink-input-to-submit:submitted-batches>=1000');
    expect(result.failedBudgets).toContain('ink-input-to-submit:generation-ownership-valid');
  });

  it('accepts the four terminal outcomes but fails the Gate closed on superseded batches', () => {
    const capture = validSyntheticCapture();
    const superseded = capture.diagnostics.recentSpans.find(
      (sample) =>
        sample.name === 'ink-input-to-submit' &&
        'batchSequence' in sample &&
        sample.batchSequence === 500,
    );
    if (superseded === undefined) throw new Error('Missing synthetic presentation batch.');
    Object.assign(superseded, {
      accepted: false,
      presentationOutcome: 'superseded',
      submittedGeneration: null,
    });

    const result = analyzeS27Capture(capture);

    expect(result.failedBudgets).toContain('ink-input-to-submit:zero-superseded-batches');
    expect(result.failedBudgets).not.toContain('ink-input-to-submit:presentation-outcome-present');
    expect(result.failedBudgets).not.toContain(
      'ink-input-to-submit:presentation-outcome-consistent',
    );
    expect(result.failedBudgets).not.toContain('ink-input-to-submit:generation-ownership-valid');
  });

  it('fails closed when a contact has a missing terminal batch sequence', () => {
    const capture = validSyntheticCapture();
    const missingIndex = capture.diagnostics.recentSpans.findIndex(
      (sample) =>
        sample.name === 'ink-input-to-submit' &&
        'batchSequence' in sample &&
        sample.batchSequence === 500,
    );
    if (missingIndex < 0) throw new Error('Missing synthetic presentation batch.');
    capture.diagnostics.recentSpans.splice(missingIndex, 1);

    expect(analyzeS27Capture(capture).failedBudgets).toContain(
      'ink-input-to-submit:terminal-sequence-complete',
    );
  });

  it('rejects a schema-v2 capture whose condition marker is missing its build fence', () => {
    const capture = validSyntheticCapture();
    Reflect.deleteProperty(capture.condition, 'buildDigest');

    expect(() => analyzeS27Capture(capture)).toThrow('Missing build digest.');
  });

  it.each([
    ['deviceDigest', 'Missing device digest.'],
    ['fixtureDigest', 'Missing fixture digest.'],
    ['presentationAdapter', 'Invalid S27 condition presentation Adapter.'],
    ['protocolDigest', 'Missing protocol digest.'],
    ['tester', 'Missing tester.'],
  ])('rejects a condition marker missing %s', (field, message) => {
    const capture = validSyntheticCapture();
    Reflect.deleteProperty(capture.condition, field);

    expect(() => analyzeS27Capture(capture)).toThrow(message);
  });

  it('rejects invalid condition identity, Adapter, and run ownership', () => {
    const unknownCondition = validSyntheticCapture();
    unknownCondition.condition.conditionId = 'unknown-condition';
    expect(() => analyzeS27Capture(unknownCondition)).toThrow(
      'Unknown S27 condition: unknown-condition',
    );

    const invalidAdapter = validSyntheticCapture();
    invalidAdapter.condition.adapter = 'mouse';
    expect(() => analyzeS27Capture(invalidAdapter)).toThrow('Invalid S27 condition adapter.');

    const invalidPresentationAdapter = validSyntheticCapture();
    invalidPresentationAdapter.condition.presentationAdapter = 'webgpu';
    expect(() => analyzeS27Capture(invalidPresentationAdapter)).toThrow(
      'Invalid S27 condition presentation Adapter.',
    );

    const invalidRun = validSyntheticCapture();
    invalidRun.condition.runIndex = 4;
    expect(() => analyzeS27Capture(invalidRun)).toThrow('Invalid S27 condition run index.');
  });

  it('explicitly rejects legacy schemaVersion 1 raw captures', () => {
    expect(() => analyzeS27Capture(minimalCapture(1, 'a'.repeat(64)))).toThrow(
      'S27 analyzer requires raw schemaVersion 2.',
    );
  });

  it('rejects a malformed protocol digest before budget evaluation', () => {
    expect(() => analyzeS27Capture(minimalCapture(2, 'not-a-digest'))).toThrow(
      'Invalid protocol digest.',
    );
  });

  it('writes aggregate S27 results with schemaVersion 2', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-analyze-'));
    temporaryRoots.push(evidenceRoot);
    await mkdir(join(evidenceRoot, 'raw'), { recursive: true });

    await analyzeS27Evidence({ evidenceRoot, protocolDigest: TEST_PROTOCOL_DIGEST });

    expect(JSON.parse(await readFile(join(evidenceRoot, 'results.json'), 'utf8'))).toMatchObject({
      automatedVerdict: 'INCOMPLETE',
      schemaVersion: 2,
    });
  });

  it('keeps a passing automated Gate incomplete when the human report is empty', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-empty-human-report-'));
    temporaryRoots.push(evidenceRoot);
    await writePassingS27RawEvidence(evidenceRoot);
    await writeFile(join(evidenceRoot, 'human-report.md'), '', 'utf8');

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: TEST_PROTOCOL_DIGEST }),
    ).resolves.toMatchObject({
      automatedVerdict: 'PASS',
      gateVerdict: 'INCOMPLETE',
    });
  });

  it('keeps a passing automated Gate incomplete when one fixed human checkpoint is missing', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-missing-human-row-'));
    temporaryRoots.push(evidenceRoot);
    await writePassingS27RawEvidence(evidenceRoot);
    await writeFile(
      join(evidenceRoot, 'human-report.md'),
      renderPassingS27HumanReport({ omit: 'Relative to Freeform' }),
      'utf8',
    );

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: 'c'.repeat(64) }),
    ).resolves.toMatchObject({
      automatedVerdict: 'PASS',
      gateVerdict: 'INCOMPLETE',
    });
  });

  it('keeps a passing automated Gate incomplete when a fixed human checkpoint is duplicated', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-duplicate-human-row-'));
    temporaryRoots.push(evidenceRoot);
    await writePassingS27RawEvidence(evidenceRoot);
    await writeFile(
      join(evidenceRoot, 'human-report.md'),
      `${renderPassingS27HumanReport()}| Tip following | PASS | duplicate observation |\n`,
      'utf8',
    );

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: 'c'.repeat(64) }),
    ).resolves.toMatchObject({
      automatedVerdict: 'PASS',
      gateVerdict: 'INCOMPLETE',
    });
  });

  it('keeps a passing automated Gate incomplete when a human checkpoint has empty notes', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-empty-human-notes-'));
    temporaryRoots.push(evidenceRoot);
    await writePassingS27RawEvidence(evidenceRoot);
    const report = renderPassingS27HumanReport().replace(
      '| Pressure control | PASS | observed Pressure control |',
      '| Pressure control | PASS | |',
    );
    await writeFile(join(evidenceRoot, 'human-report.md'), report, 'utf8');

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: 'c'.repeat(64) }),
    ).resolves.toMatchObject({
      automatedVerdict: 'PASS',
      gateVerdict: 'INCOMPLETE',
    });
  });

  it('keeps a passing automated Gate incomplete when the human report adds an unknown checkpoint', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-unknown-human-row-'));
    temporaryRoots.push(evidenceRoot);
    await writePassingS27RawEvidence(evidenceRoot);
    await writeFile(
      join(evidenceRoot, 'human-report.md'),
      `${renderPassingS27HumanReport()}| Unfrozen subjective check | PASS | observed |\n`,
      'utf8',
    );

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: 'c'.repeat(64) }),
    ).resolves.toMatchObject({
      automatedVerdict: 'PASS',
      gateVerdict: 'INCOMPLETE',
    });
  });

  it('passes only when automated evidence and the complete unique human checkpoint set pass', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-complete-human-report-'));
    temporaryRoots.push(evidenceRoot);
    await writePassingS27RawEvidence(evidenceRoot);
    await writeFile(join(evidenceRoot, 'human-report.md'), renderPassingS27HumanReport(), 'utf8');

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: 'c'.repeat(64) }),
    ).resolves.toMatchObject({
      automatedVerdict: 'PASS',
      gateVerdict: 'PASS',
    });
  });

  it('fails when a fixed human checkpoint explicitly fails even when its notes are empty', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-explicit-human-fail-'));
    temporaryRoots.push(evidenceRoot);
    await writePassingS27RawEvidence(evidenceRoot);
    const report = renderPassingS27HumanReport().replace(
      '| Pressure control | PASS | observed Pressure control |',
      '| Pressure control | FAIL | |',
    );
    await writeFile(join(evidenceRoot, 'human-report.md'), report, 'utf8');

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: 'c'.repeat(64) }),
    ).resolves.toMatchObject({
      automatedVerdict: 'PASS',
      gateVerdict: 'FAIL',
    });
  });

  it('fails when a duplicated fixed checkpoint contains an explicit human failure', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-duplicate-human-fail-'));
    temporaryRoots.push(evidenceRoot);
    await writePassingS27RawEvidence(evidenceRoot);
    await writeFile(
      join(evidenceRoot, 'human-report.md'),
      `${renderPassingS27HumanReport()}| Tip following | FAIL | |\n`,
      'utf8',
    );

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: 'c'.repeat(64) }),
    ).resolves.toMatchObject({
      automatedVerdict: 'PASS',
      gateVerdict: 'FAIL',
    });
  });

  it('keeps a passing automated Gate incomplete when a duplicate checkpoint has an invalid rating', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-invalid-human-rating-'));
    temporaryRoots.push(evidenceRoot);
    await writePassingS27RawEvidence(evidenceRoot);
    await writeFile(
      join(evidenceRoot, 'human-report.md'),
      `${renderPassingS27HumanReport()}| Tip following | MAYBE | duplicate observation |\n`,
      'utf8',
    );

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: 'c'.repeat(64) }),
    ).resolves.toMatchObject({
      automatedVerdict: 'PASS',
      gateVerdict: 'INCOMPLETE',
    });
  });

  it('computes missing-condition ownership inside one Worker presentation fence', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-worker-analyze-'));
    temporaryRoots.push(evidenceRoot);
    const rawRoot = join(evidenceRoot, 'raw');
    await mkdir(rawRoot, { recursive: true });
    const capture = validSyntheticCapture();
    capture.condition.presentationAdapter = 'worker-offscreen-2d';
    await writeFile(join(rawRoot, 'worker.json'), `${JSON.stringify(capture)}\n`, 'utf8');

    await analyzeS27Evidence({ evidenceRoot, protocolDigest: TEST_PROTOCOL_DIGEST });

    const result = JSON.parse(await readFile(join(evidenceRoot, 'results.json'), 'utf8'));
    expect(result.presentationAdapter).toBe('worker-offscreen-2d');
    expect(result.missingConditions).toContain(
      'session-2-history-10k-30-surfaces:pointer:worker-offscreen-2d:1',
    );
    expect(result.missingConditions).not.toContain(
      'session-2-history-10k-30-surfaces:pointer:main-canvas-2d:1',
    );
  });

  it('rejects mixed raw schema versions before aggregate evidence writeback', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-mixed-schema-'));
    temporaryRoots.push(evidenceRoot);
    const rawRoot = join(evidenceRoot, 'raw');
    await mkdir(rawRoot, { recursive: true });
    const previousResults = '{"legacyVerdict":"PASS"}\n';
    const previousPerformance = '# Legacy S27 performance\n';
    await Promise.all([
      writeFile(
        join(rawRoot, 'a-v1.json'),
        `${JSON.stringify(minimalCapture(1, 'a'.repeat(64)))}\n`,
        'utf8',
      ),
      writeFile(
        join(rawRoot, 'b-v2.json'),
        `${JSON.stringify(minimalCapture(2, 'a'.repeat(64)))}\n`,
        'utf8',
      ),
      writeFile(join(evidenceRoot, 'results.json'), previousResults, 'utf8'),
      writeFile(join(evidenceRoot, 'performance.md'), previousPerformance, 'utf8'),
    ]);

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: TEST_PROTOCOL_DIGEST }),
    ).rejects.toThrow('S27 evidence mixes raw schema versions: 1, 2.');
    await expect(readFile(join(evidenceRoot, 'results.json'), 'utf8')).resolves.toBe(
      previousResults,
    );
    await expect(readFile(join(evidenceRoot, 'performance.md'), 'utf8')).resolves.toBe(
      previousPerformance,
    );
  });

  it('rejects mixed protocol digests before aggregate evidence writeback', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-mixed-protocol-'));
    temporaryRoots.push(evidenceRoot);
    const rawRoot = join(evidenceRoot, 'raw');
    await mkdir(rawRoot, { recursive: true });
    const previousResults = '{"automatedVerdict":"PASS","schemaVersion":2}\n';
    const previousPerformance = '# Previous S27R1 performance\n';
    await Promise.all([
      writeFile(
        join(rawRoot, 'a-protocol.json'),
        `${JSON.stringify(minimalCapture(2, 'a'.repeat(64)))}\n`,
        'utf8',
      ),
      writeFile(
        join(rawRoot, 'b-protocol.json'),
        `${JSON.stringify(minimalCapture(2, 'b'.repeat(64)))}\n`,
        'utf8',
      ),
      writeFile(join(evidenceRoot, 'results.json'), previousResults, 'utf8'),
      writeFile(join(evidenceRoot, 'performance.md'), previousPerformance, 'utf8'),
    ]);

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: TEST_PROTOCOL_DIGEST }),
    ).rejects.toThrow('S27 evidence mixes protocol digests.');
    await expect(readFile(join(evidenceRoot, 'results.json'), 'utf8')).resolves.toBe(
      previousResults,
    );
    await expect(readFile(join(evidenceRoot, 'performance.md'), 'utf8')).resolves.toBe(
      previousPerformance,
    );
  });

  it('rejects mixed build digests before aggregate evidence writeback', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-mixed-build-'));
    temporaryRoots.push(evidenceRoot);
    const rawRoot = join(evidenceRoot, 'raw');
    await mkdir(rawRoot, { recursive: true });
    const first = minimalCapture(2, 'c'.repeat(64));
    const second = minimalCapture(2, 'c'.repeat(64));
    second.condition.buildDigest = 'e'.repeat(64);
    const previousResults = '{"automatedVerdict":"PASS","schemaVersion":2}\n';
    await Promise.all([
      writeFile(join(rawRoot, 'a-build.json'), `${JSON.stringify(first)}\n`, 'utf8'),
      writeFile(join(rawRoot, 'b-build.json'), `${JSON.stringify(second)}\n`, 'utf8'),
      writeFile(join(evidenceRoot, 'results.json'), previousResults, 'utf8'),
    ]);

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: TEST_PROTOCOL_DIGEST }),
    ).rejects.toThrow('S27 evidence mixes build digests.');
    await expect(readFile(join(evidenceRoot, 'results.json'), 'utf8')).resolves.toBe(
      previousResults,
    );
  });

  it('rejects mixed presentation Adapters before aggregate evidence writeback', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-mixed-presentation-'));
    temporaryRoots.push(evidenceRoot);
    const rawRoot = join(evidenceRoot, 'raw');
    await mkdir(rawRoot, { recursive: true });
    const main = minimalCapture(2, 'c'.repeat(64));
    const worker = minimalCapture(2, 'c'.repeat(64));
    worker.condition.presentationAdapter = 'worker-offscreen-2d';
    const previousResults = '{"automatedVerdict":"PASS","schemaVersion":2}\n';
    await Promise.all([
      writeFile(join(rawRoot, 'main.json'), `${JSON.stringify(main)}\n`, 'utf8'),
      writeFile(join(rawRoot, 'worker.json'), `${JSON.stringify(worker)}\n`, 'utf8'),
      writeFile(join(evidenceRoot, 'results.json'), previousResults, 'utf8'),
    ]);

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: TEST_PROTOCOL_DIGEST }),
    ).rejects.toThrow('S27 evidence mixes presentation Adapters.');
    await expect(readFile(join(evidenceRoot, 'results.json'), 'utf8')).resolves.toBe(
      previousResults,
    );
  });

  it('keeps main and Worker aggregates operable in independent evidence roots', async () => {
    const roots = await Promise.all([
      mkdtemp(join(tmpdir(), 'inkstone-s27-main-evidence-')),
      mkdtemp(join(tmpdir(), 'inkstone-s27-worker-evidence-')),
    ]);
    temporaryRoots.push(...roots);
    const presentations = ['main-canvas-2d', 'worker-offscreen-2d'] as const;
    for (const [index, evidenceRoot] of roots.entries()) {
      const presentationAdapter = presentations[index];
      if (presentationAdapter === undefined) throw new Error('Missing presentation fixture.');
      const rawRoot = join(evidenceRoot, 'raw');
      await mkdir(rawRoot, { recursive: true });
      const capture = validSyntheticCapture();
      capture.condition.presentationAdapter = presentationAdapter;
      await writeFile(
        join(rawRoot, `session-1-empty-pen-highlighter-pointer-${presentationAdapter}-run-1.json`),
        `${JSON.stringify(capture)}\n`,
        'utf8',
      );

      await expect(
        analyzeS27Evidence({ evidenceRoot, protocolDigest: TEST_PROTOCOL_DIGEST }),
      ).resolves.toMatchObject({
        automatedVerdict: 'INCOMPLETE',
        presentationAdapter,
        status: 'COMPLETE',
      });
      expect(
        JSON.parse(await readFile(join(evidenceRoot, 'results.json'), 'utf8')).presentationAdapter,
      ).toBe(presentationAdapter);
    }
  });

  it.each([undefined, 'webgpu'])(
    'rejects aggregate capture with missing or invalid presentation Adapter %s',
    async (presentationAdapter) => {
      const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-invalid-presentation-'));
      temporaryRoots.push(evidenceRoot);
      const rawRoot = join(evidenceRoot, 'raw');
      await mkdir(rawRoot, { recursive: true });
      const capture = minimalCapture(2, 'c'.repeat(64));
      if (presentationAdapter === undefined) {
        Reflect.deleteProperty(capture.condition, 'presentationAdapter');
      } else {
        capture.condition.presentationAdapter = presentationAdapter;
      }

      await writeFile(join(rawRoot, 'capture.json'), `${JSON.stringify(capture)}\n`, 'utf8');

      await expect(
        analyzeS27Evidence({ evidenceRoot, protocolDigest: TEST_PROTOCOL_DIGEST }),
      ).rejects.toThrow('Invalid S27 condition presentation Adapter.');
      await expect(readFile(join(evidenceRoot, 'results.json'), 'utf8')).rejects.toThrow();
    },
  );

  it.each([
    ['deviceDigest', 'device'],
    ['fixtureDigest', 'fixture'],
  ])('rejects mixed %s evidence fences', async (field, label) => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), `inkstone-s27-mixed-${label}-`));
    temporaryRoots.push(evidenceRoot);
    const rawRoot = join(evidenceRoot, 'raw');
    await mkdir(rawRoot, { recursive: true });
    const first = minimalCapture(2, 'c'.repeat(64));
    const second = minimalCapture(2, 'c'.repeat(64));
    (second.condition as Record<string, unknown>)[field] = 'e'.repeat(64);
    await Promise.all([
      writeFile(join(rawRoot, 'a.json'), `${JSON.stringify(first)}\n`, 'utf8'),
      writeFile(join(rawRoot, 'b.json'), `${JSON.stringify(second)}\n`, 'utf8'),
    ]);

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: TEST_PROTOCOL_DIGEST }),
    ).rejects.toThrow(`S27 evidence mixes ${label} digests.`);
  });

  it('rejects a raw protocol digest that differs from initialized results', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-results-protocol-'));
    temporaryRoots.push(evidenceRoot);
    const rawRoot = join(evidenceRoot, 'raw');
    await mkdir(rawRoot, { recursive: true });
    const previousResults = `${JSON.stringify({
      automatedVerdict: 'INCOMPLETE',
      protocolDigest: 'b'.repeat(64),
      schemaVersion: 2,
    })}\n`;
    const previousPerformance = '# Initialized S27R1 performance\n';
    await Promise.all([
      writeFile(
        join(rawRoot, 'capture.json'),
        `${JSON.stringify(minimalCapture(2, 'a'.repeat(64)))}\n`,
        'utf8',
      ),
      writeFile(join(evidenceRoot, 'results.json'), previousResults, 'utf8'),
      writeFile(join(evidenceRoot, 'performance.md'), previousPerformance, 'utf8'),
    ]);

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: TEST_PROTOCOL_DIGEST }),
    ).rejects.toThrow('S27 raw protocol digest does not match results.json.');
    await expect(readFile(join(evidenceRoot, 'results.json'), 'utf8')).resolves.toBe(
      previousResults,
    );
    await expect(readFile(join(evidenceRoot, 'performance.md'), 'utf8')).resolves.toBe(
      previousPerformance,
    );
  });

  it('rejects internally consistent stale protocol evidence before aggregate writeback', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-stale-protocol-'));
    temporaryRoots.push(evidenceRoot);
    const rawRoot = join(evidenceRoot, 'raw');
    await mkdir(rawRoot, { recursive: true });
    const staleProtocolDigest = 'c'.repeat(64);
    const currentProtocolDigest = 'f'.repeat(64);
    const previousResults = `${JSON.stringify({
      automatedVerdict: 'PASS',
      protocolDigest: staleProtocolDigest,
      schemaVersion: 2,
    })}\n`;
    const previousPerformance = '# Stale but internally consistent S27 performance\n';
    await Promise.all([
      writeFile(
        join(rawRoot, 'capture.json'),
        `${JSON.stringify(validSyntheticCapture())}\n`,
        'utf8',
      ),
      writeFile(join(evidenceRoot, 'results.json'), previousResults, 'utf8'),
      writeFile(join(evidenceRoot, 'performance.md'), previousPerformance, 'utf8'),
    ]);

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: currentProtocolDigest }),
    ).rejects.toThrow('S27 raw protocol digest does not match the current protocol.');
    await expect(readFile(join(evidenceRoot, 'results.json'), 'utf8')).resolves.toBe(
      previousResults,
    );
    await expect(readFile(join(evidenceRoot, 'performance.md'), 'utf8')).resolves.toBe(
      previousPerformance,
    );
  });

  it('rejects mixed condition-marker schema versions before aggregate writeback', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-mixed-marker-schema-'));
    temporaryRoots.push(evidenceRoot);
    const rawRoot = join(evidenceRoot, 'raw');
    await mkdir(rawRoot, { recursive: true });
    const previousResults = '{"legacyVerdict":"PASS"}\n';
    const previousPerformance = '# Legacy marker performance\n';
    await Promise.all([
      writeFile(
        join(rawRoot, 'a-marker-v1.json'),
        `${JSON.stringify(minimalCapture(2, 'a'.repeat(64), 1))}\n`,
        'utf8',
      ),
      writeFile(
        join(rawRoot, 'b-marker-v2.json'),
        `${JSON.stringify(minimalCapture(2, 'a'.repeat(64), 2))}\n`,
        'utf8',
      ),
      writeFile(join(evidenceRoot, 'results.json'), previousResults, 'utf8'),
      writeFile(join(evidenceRoot, 'performance.md'), previousPerformance, 'utf8'),
    ]);

    await expect(
      analyzeS27Evidence({ evidenceRoot, protocolDigest: TEST_PROTOCOL_DIGEST }),
    ).rejects.toThrow('S27 evidence mixes condition schema versions: 1, 2.');
    await expect(readFile(join(evidenceRoot, 'results.json'), 'utf8')).resolves.toBe(
      previousResults,
    );
    await expect(readFile(join(evidenceRoot, 'performance.md'), 'utf8')).resolves.toBe(
      previousPerformance,
    );
  });

  it('preserves legacy S27 raw and verdict files when v1 analysis is refused', async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-legacy-v1-'));
    temporaryRoots.push(evidenceRoot);
    const rawRoot = join(evidenceRoot, 'raw');
    await mkdir(rawRoot, { recursive: true });
    const legacyRaw = `${JSON.stringify(
      minimalCapture(1, '71331cb732c2cb34aa1be0921e863ce60af59405d00c922a21c53d4c90b07421'),
    )}\n`;
    const previousResults = '{"automatedVerdict":"FAIL","schemaVersion":1}\n';
    const previousPerformance = '# Original S27 FAIL evidence\n';
    const rawPath = join(rawRoot, 'session-1-empty-pen-highlighter-pointer-run-1.json');
    await Promise.all([
      writeFile(rawPath, legacyRaw, 'utf8'),
      writeFile(join(evidenceRoot, 'results.json'), previousResults, 'utf8'),
      writeFile(join(evidenceRoot, 'performance.md'), previousPerformance, 'utf8'),
    ]);

    await expect(
      analyzeS27Evidence({
        evidenceRoot,
        protocolDigest: '71331cb732c2cb34aa1be0921e863ce60af59405d00c922a21c53d4c90b07421',
      }),
    ).rejects.toThrow('S27 analyzer requires raw schemaVersion 2.');
    await expect(readFile(rawPath, 'utf8')).resolves.toBe(legacyRaw);
    await expect(readFile(join(evidenceRoot, 'results.json'), 'utf8')).resolves.toBe(
      previousResults,
    );
    await expect(readFile(join(evidenceRoot, 'performance.md'), 'utf8')).resolves.toBe(
      previousPerformance,
    );
  });

  it('keeps the protocol digest stable when only the latest-run record changes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'inkstone-s27-protocol-'));
    temporaryRoots.push(projectRoot);
    await Promise.all([
      mkdir(join(projectRoot, 'scripts'), { recursive: true }),
      mkdir(join(projectRoot, 'docs', 'specs'), { recursive: true }),
      mkdir(join(projectRoot, 'docs', 'delivery', 'slices', 'S27-ink-foundation-ipad-gate'), {
        recursive: true,
      }),
    ]);
    await Promise.all([
      writeFile(join(projectRoot, 'scripts', 'ink-foundation-ipad-gate.mjs'), 'runner', 'utf8'),
      writeFile(
        join(projectRoot, 'docs', 'specs', '2026-07-17-ink-native-feel-execution-plan.md'),
        'execution spec',
        'utf8',
      ),
      writeFile(
        join(
          projectRoot,
          'docs',
          'specs',
          '2026-07-17-ink-native-feel-performance-and-brush-fidelity.md',
        ),
        'product spec',
        'utf8',
      ),
    ]);
    const guidePath = join(
      projectRoot,
      'docs',
      'delivery',
      'slices',
      'S27-ink-foundation-ipad-gate',
      'hat-guide.md',
    );
    await writeFile(
      guidePath,
      '<!-- HAT:BEGIN checklist -->\nfrozen card\n<!-- HAT:END checklist -->\nLatest run: one\n',
      'utf8',
    );
    const first = await computeS27ProtocolDigest(projectRoot);
    await writeFile(
      guidePath,
      '<!-- HAT:BEGIN checklist -->\nfrozen card\n<!-- HAT:END checklist -->\nLatest run: two\n',
      'utf8',
    );
    const writebackOnly = await computeS27ProtocolDigest(projectRoot);
    await writeFile(
      guidePath,
      '<!-- HAT:BEGIN checklist -->\nchanged card\n<!-- HAT:END checklist -->\nLatest run: two\n',
      'utf8',
    );

    expect(writebackOnly).toBe(first);
    await expect(computeS27ProtocolDigest(projectRoot)).resolves.not.toBe(first);
  });
});

function span(
  name: string,
  durationMs: number,
  workPhase: string,
  extra: Record<string, unknown> = {},
) {
  return {
    accepted: true,
    adapter: 'pointer',
    durationMs,
    name,
    workPhase,
    ...extra,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function validSyntheticCapture() {
  const inputHandler = Array.from({ length: 1_000 }, () =>
    span('ink-input-handler', 1, 'input', { inputPhase: 'move' }),
  );
  const frameWork = Array.from({ length: 1_000 }, () => span('ink-frame-work', 4, 'active-frame'));
  const inputToSubmit = Array.from({ length: 1_000 }, (_value, index) =>
    span('ink-input-to-submit', 8, 'input', {
      batchSequence: index + 1,
      contactSequence: 1,
      presentationOutcome: 'submitted',
      requestedGeneration: index + 1,
      submittedGeneration: index + 1,
    }),
  );
  const commits = [
    ...Array.from({ length: 100 }, () => ({
      ...span('ink-stroke-commit', 8, 'completion'),
      documentCommandProduced: true,
    })),
    ...Array.from({ length: 18 }, () => ({
      ...span('ink-stroke-commit', 0, 'completion'),
      documentCommandProduced: false,
    })),
  ];
  const draftSubmits = Array.from({ length: 100 }, () =>
    span('ink-draft-persistence-submit', 1, 'cold'),
  );
  const canonicalSubmits = Array.from({ length: 4 }, () =>
    span('ink-canonical-persistence-submit', 8, 'cold'),
  );
  const viewports = Array.from({ length: 20 }, () => span('ink-viewport-redraw', 10, 'viewport'));

  return {
    capturedAt: '2026-07-17T12:00:00.000Z',
    condition: {
      adapter: 'pointer',
      buildDigest: 'a'.repeat(64),
      conditionId: 'session-1-empty-pen-highlighter',
      deviceDigest: 'd'.repeat(64),
      fixtureDigest: 'b'.repeat(64),
      presentationAdapter: 'main-canvas-2d',
      protocolDigest: 'c'.repeat(64),
      runIndex: 1,
      schemaVersion: 2,
      tester: 'Ivan',
    },
    diagnostics: {
      armedAuditGuards: [
        'canonical-cold-materialization',
        'draft-store-cold-write',
        'physical-finalize-no-recompile',
      ],
      auditedWork: [
        { count: 4, kind: 'canonical-encode', phase: 'cold' },
        { count: 4, kind: 'canonical-storage-write', phase: 'cold' },
        { count: 100, kind: 'draft-storage-write', phase: 'cold' },
      ],
      droppedSpanCount: 0,
      distributions: [],
      forbiddenWork: [] as Array<{ count: number; kind: string; phase: string }>,
      frameIntervalsMs: {
        activeWriting: [17.1, ...Array(99).fill(16.7)],
        hostGaps: [] as number[],
        idle: Array(120).fill(16.7),
      },
      memory: {
        activeWorkingSetBytes: 1_024,
        backingStoreBytes: 16 * 1024 * 1024,
        disposableCacheBytes: 4 * 1024 * 1024,
      },
      recentSpans: [
        ...inputHandler,
        ...frameWork,
        ...inputToSubmit,
        ...commits,
        ...draftSubmits,
        ...canonicalSubmits,
        ...viewports,
      ],
    },
    longTasks: { available: false, durationsMs: [] as number[] },
    runtimeCapabilities: runtimeCapabilities(),
    schemaVersion: 2,
  };
}

function runtimeCapabilities() {
  const available = () => ({ available: true as const, failureCategory: 'none' as const });
  const unavailable = (failureCategory: string) => ({ available: false as const, failureCategory });
  return {
    crossOriginIsolated: unavailable('not-isolated'),
    dedicatedWorkerConstruct: available(),
    dedicatedWorkerModule: available(),
    navigatorGpu: unavailable('api-unavailable'),
    offscreenCanvas2d: available(),
    offscreenCanvasTransfer: available(),
    offscreenWebgl2: unavailable('context-unavailable'),
    pointerPredictedEvents: available(),
    sharedArrayBuffer: unavailable('api-unavailable'),
    wasm: available(),
    wasmSimd: available(),
    workerAnimationFrame: available(),
  };
}

function minimalCapture(
  schemaVersion: number,
  protocolDigest: string,
  conditionSchemaVersion = schemaVersion,
) {
  return {
    condition: {
      adapter: 'pointer',
      buildDigest: 'a'.repeat(64),
      conditionId: 'session-1-empty-pen-highlighter',
      deviceDigest: 'd'.repeat(64),
      fixtureDigest: 'b'.repeat(64),
      presentationAdapter: 'main-canvas-2d',
      protocolDigest,
      runIndex: 1,
      schemaVersion: conditionSchemaVersion,
      tester: 'Ivan',
    },
    schemaVersion,
  };
}

const PASSING_S27_CONDITION_RUNS = [
  ['session-1-empty-pen-highlighter', 1],
  ['session-2-history-10k-30-surfaces', 1],
  ['session-3-navigation-layout', 1],
  ['session-4-stability-reference', 1],
] as const;

const S27_HUMAN_CHECKPOINTS = [
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
] as const;

function renderPassingS27HumanReport({ omit }: { omit?: string } = {}) {
  return [
    '| Checkpoint | Rating | Notes |',
    '| --- | --- | --- |',
    ...S27_HUMAN_CHECKPOINTS.filter((checkpoint) => checkpoint !== omit).map(
      (checkpoint) => `| ${checkpoint} | PASS | observed ${checkpoint} |`,
    ),
    '',
  ].join('\n');
}

async function writePassingS27RawEvidence(evidenceRoot: string) {
  const rawRoot = join(evidenceRoot, 'raw');
  await mkdir(rawRoot, { recursive: true });
  const capture = validSyntheticCapture();
  for (const [conditionId, runCount] of PASSING_S27_CONDITION_RUNS) {
    for (let runIndex = 1; runIndex <= runCount; runIndex += 1) {
      capture.condition.conditionId = conditionId;
      capture.condition.runIndex = runIndex;
      await writeFile(
        join(rawRoot, `${conditionId}-pointer-main-canvas-2d-run-${String(runIndex)}.json`),
        `${JSON.stringify(capture)}\n`,
        'utf8',
      );
    }
  }
}

async function createCliRunFixture(projectRoot: string) {
  const fixtureRoot = join(projectRoot, 'fixture');
  const deviceListPath = join(projectRoot, 'devices.json');
  const deviceDetailsPath = join(projectRoot, 'device-details.json');
  const evidenceRoot = join(
    projectRoot,
    'docs',
    'delivery',
    'slices',
    'S27-ink-foundation-ipad-gate',
  );
  await Promise.all([
    mkdir(fixtureRoot, { recursive: true }),
    mkdir(join(projectRoot, 'scripts'), { recursive: true }),
    mkdir(join(projectRoot, 'docs', 'specs'), { recursive: true }),
    mkdir(evidenceRoot, { recursive: true }),
    mkdir(join(projectRoot, 'src'), { recursive: true }),
    mkdir(
      join(projectRoot, 'docs', 'delivery', 'slices', 'S27R6-local-obsidian-performance-gate'),
      { recursive: true },
    ),
  ]);
  await Promise.all([
    writeFile(join(projectRoot, 'main.js'), 'production bundle', 'utf8'),
    writeFile(join(projectRoot, 'manifest.json'), '{"version":"0.1.0"}\n', 'utf8'),
    writeFile(join(projectRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8'),
    writeFile(join(projectRoot, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8'),
    writeFile(join(projectRoot, 'esbuild.config.mjs'), 'export {};\n', 'utf8'),
    writeFile(join(projectRoot, 'src', 'main.ts'), 'export const fixture = true;\n', 'utf8'),
    writeFile(join(projectRoot, 'styles.css'), '/* production */\n', 'utf8'),
    writeFile(join(fixtureRoot, '.inkstone-hat-owned'), 'owned\n', 'utf8'),
    writeFile(join(fixtureRoot, '.inkstone-s22-performance-hat.json'), '{}\n', 'utf8'),
    writeFile(join(projectRoot, 'scripts', 'ink-foundation-ipad-gate.mjs'), 'runner\n', 'utf8'),
    writeFile(
      join(projectRoot, 'scripts', 'ink-local-obsidian-performance-gate.mjs'),
      'local runner\n',
      'utf8',
    ),
    writeFile(
      join(projectRoot, 'docs', 'specs', '2026-07-17-ink-native-feel-execution-plan.md'),
      'execution spec\n',
      'utf8',
    ),
    writeFile(
      join(
        projectRoot,
        'docs',
        'specs',
        '2026-07-17-ink-native-feel-performance-and-brush-fidelity.md',
      ),
      'product spec\n',
      'utf8',
    ),
    writeFile(
      join(projectRoot, 'docs', 'specs', '2026-07-20-ink-responsive-commands-save-and-preview.md'),
      'responsive command and Preview spec\n',
      'utf8',
    ),
    writeFile(
      join(evidenceRoot, 'hat-guide.md'),
      '<!-- HAT:BEGIN checklist -->\nfrozen card\n<!-- HAT:END checklist -->\n',
      'utf8',
    ),
    writeFile(
      deviceListPath,
      JSON.stringify({
        result: {
          devices: [
            {
              connectionProperties: {
                pairingState: 'paired',
                transportType: 'wired',
                tunnelState: 'connected',
              },
              deviceProperties: { bootState: 'booted', osVersionNumber: '27.0' },
              hardwareProperties: {
                deviceType: 'iPad',
                platform: 'iOS',
                productType: 'iPad14,1',
                reality: 'physical',
              },
              identifier: 'PRIVATE-DEVICE-ID',
            },
          ],
        },
      }),
      'utf8',
    ),
    writeFile(deviceDetailsPath, '{"result":{}}\n', 'utf8'),
  ]);
  const [localProtocolDigest, implementationDigest] = await Promise.all([
    computeLocalObsidianProtocolDigest(projectRoot),
    computeLocalImplementationDigest(projectRoot),
  ]);
  await writeFile(
    join(
      projectRoot,
      'docs',
      'delivery',
      'slices',
      'S27R6-local-obsidian-performance-gate',
      'results.json',
    ),
    `${JSON.stringify({
      automatedVerdict: 'PASS',
      implementationDigest,
      protocolDigest: localProtocolDigest,
      schemaVersion: 1,
    })}\n`,
    'utf8',
  );
  return {
    environment: {
      INKSTONE_PROJECT_ROOT: projectRoot,
      INKSTONE_S27_AVAILABLE_STORAGE: '20 GB',
      INKSTONE_S27_DEVICE_DETAILS_JSON: deviceDetailsPath,
      INKSTONE_S27_DEVICE_LIST_JSON: deviceListPath,
      INKSTONE_S27_HAT_OUTPUT: fixtureRoot,
      INKSTONE_S27_LOW_POWER_MODE: 'off',
      INKSTONE_S27_OBSIDIAN_VERSION: 'latest',
      INKSTONE_S27_PENCIL_MODEL: 'Apple Pencil 2',
      INKSTONE_S27_REFRESH_MODE: '60 Hz fixed',
      INKSTONE_S27_TESTER: 'Ivan',
    },
    fixtureRoot,
  };
}
