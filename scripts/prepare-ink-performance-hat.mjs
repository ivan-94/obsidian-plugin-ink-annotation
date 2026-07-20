import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  cleanupDeviceHatVault,
  getDeviceHatVaultInfo,
  prepareDeviceHatVault,
} from './prepare-device-hat.mjs';

const MARKER = '.inkstone-s22-performance-hat.json';
const PLUGIN_ID = 'inkstone-annotations';

/**
 * @typedef {{ filePath: string, name: string, strokeCount: number, surfaceCount: number }} InkPerformanceCondition
 * @typedef {{ outputRoot: string, projectRoot: string }} PrepareOptions
 * @typedef {{ outputRoot: string, seededStrokes?: number, status: 'not-prepared' | 'prepared' }} InkPerformanceHatResult
 */

const CONDITIONS = /** @type {readonly InkPerformanceCondition[]} */ ([
  { filePath: 'S22 Ink Empty.md', name: 'empty', strokeCount: 0, surfaceCount: 1 },
  { filePath: 'S22 Ink 1k.md', name: 'history-1k', strokeCount: 1_000, surfaceCount: 3 },
  {
    filePath: 'S22 Ink 10k 30 surfaces.md',
    name: 'history-10k-30-surfaces',
    strokeCount: 10_000,
    surfaceCount: 30,
  },
]);
const LOCAL_GATE_TOOLS = ['pen', 'highlighter'];
const LOCAL_GATE_DRAWING_TRACES = ['mixed-drawing'];

/**
 * @param {PrepareOptions} options
 * @returns {Promise<InkPerformanceHatResult>}
 */
async function prepare({ outputRoot, projectRoot }) {
  await prepareDeviceHatVault({ outputRoot, projectRoot });
  await writeJson(join(outputRoot, '.obsidian', 'plugins', PLUGIN_ID, 'data.json'), {
    deviceId: 's22-performance-hat',
    diagnosticsEnabled: true,
    showInkPreviewByDefault: true,
  });
  for (const condition of CONDITIONS) await writeCondition(outputRoot, condition);
  const marker = {
    conditions: CONDITIONS,
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
  await writeJson(join(outputRoot, MARKER), marker);
  return {
    outputRoot,
    seededStrokes: CONDITIONS.reduce((total, condition) => total + condition.strokeCount, 0),
    status: 'prepared',
  };
}

/**
 * Refreshes only S22-owned fixtures inside the repository's already-registered local test Vault.
 * @param {PrepareOptions} options
 * @returns {Promise<InkPerformanceHatResult>}
 */
export async function prepareInPlace({ outputRoot, projectRoot }) {
  const expectedRoot = resolve(projectRoot, 'test-fixtures', 'vault');
  if (resolve(outputRoot) !== expectedRoot) {
    throw new Error('In-place S27R6 preparation is restricted to the repository test Vault.');
  }
  const pluginRoot = join(outputRoot, '.obsidian', 'plugins', PLUGIN_ID);
  await mkdir(pluginRoot, { recursive: true });
  for (const filename of ['main.js', 'manifest.json', 'styles.css']) {
    await cp(join(projectRoot, filename), join(pluginRoot, filename));
  }
  /** @type {string[]} */
  const enabledPlugins = [];
  try {
    /** @type {unknown} */
    const value = JSON.parse(
      await readFile(join(outputRoot, '.obsidian', 'community-plugins.json'), 'utf8'),
    );
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') enabledPlugins.push(item);
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  await writeJson(join(outputRoot, '.obsidian', 'community-plugins.json'), [
    ...new Set([...enabledPlugins, PLUGIN_ID]),
  ]);
  await writeJson(join(pluginRoot, 'data.json'), {
    deviceId: 's27r6-local-performance-gate',
    diagnosticsEnabled: true,
    showInkPreviewByDefault: true,
  });
  for (const condition of CONDITIONS) await writeCondition(outputRoot, condition);
  const localGateConditions = localPerformanceGateConditions();
  for (const condition of localGateConditions) await writeCondition(outputRoot, condition);
  await writeJson(join(outputRoot, MARKER), {
    conditions: CONDITIONS,
    generatedAt: new Date().toISOString(),
    localGateConditions,
    schemaVersion: 1,
  });
  return {
    outputRoot,
    seededStrokes: CONDITIONS.reduce((total, condition) => total + condition.strokeCount, 0),
    status: 'prepared',
  };
}

function localPerformanceGateConditions() {
  const conditions = [];
  for (const fixture of CONDITIONS) {
    for (const tool of LOCAL_GATE_TOOLS) {
      for (const trace of LOCAL_GATE_DRAWING_TRACES) {
        conditions.push({
          ...fixture,
          filePath: localGateFilePath(fixture.name, tool, trace),
          name: `local-${fixture.name}-${tool}-${trace}`,
        });
      }
    }
  }
  const worst = CONDITIONS[2];
  if (worst === undefined) throw new Error('Missing 10k/30 local Gate fixture.');
  for (const tool of LOCAL_GATE_TOOLS) {
    for (const trace of ['viewport', 'cache-lifecycle']) {
      conditions.push({
        ...worst,
        filePath: localGateFilePath(worst.name, tool, trace),
        name: `local-${worst.name}-${tool}-${trace}`,
      });
    }
  }
  const empty = CONDITIONS[0];
  if (empty === undefined) throw new Error('Missing empty local Gate fixture.');
  conditions.push({
    ...empty,
    filePath: localGateFilePath(empty.name, 'mixed', 'soak'),
    name: 'local-empty-mixed-soak',
  });
  return conditions;
}

function localGateFilePath(fixture, tool, trace) {
  return `S27R6 ${fixture} ${tool} ${trace}.md`;
}

/** @param {string} outputRoot @param {InkPerformanceCondition} condition */
async function writeCondition(outputRoot, condition) {
  const source = [
    `# ${condition.name}`,
    '',
    'Deterministic Ink performance fixture. Do not add personal note content.',
    '',
    'Use this note only for S22 input and viewport measurements.',
    '',
  ].join('\n');
  await writeFile(join(outputRoot, condition.filePath), source, 'utf8');
  const noteRoot = join(
    outputRoot,
    '.obsidian-annotations',
    'v1',
    'notes',
    sha256(condition.filePath),
  );
  await resetOwnedConditionSidecar(outputRoot, condition.filePath);
  const surfaceRoot = join(noteRoot, 'surfaces');
  await mkdir(surfaceRoot, { recursive: true });
  const timestamp = '2026-07-17T00:00:00.000Z';
  const noteId = `s22-${condition.name}`;
  await writeJson(join(noteRoot, 'meta.json'), {
    filePath: condition.filePath,
    lastReconciledAt: timestamp,
    noteId,
    pathHash: sha256(condition.filePath),
    schemaVersion: 1,
    sourceFingerprint: sha256(source),
  });
  let nextStroke = 0;
  for (let surfaceIndex = 0; surfaceIndex < condition.surfaceCount; surfaceIndex += 1) {
    const count =
      Math.floor(condition.strokeCount / condition.surfaceCount) +
      (surfaceIndex < condition.strokeCount % condition.surfaceCount ? 1 : 0);
    const strokes = Array.from({ length: count }, () => {
      const index = nextStroke;
      nextStroke += 1;
      const x = 16 + (index % 80) * 8;
      const y = 16 + (index % 300) * 3;
      return {
        color: '#111111',
        id: `stroke-${index}`,
        points: [
          { pressure: 0.5, time: index * 2, x, y },
          { pressure: 0.5, time: index * 2 + 1, x: x + 2, y: y + 2 },
        ],
        tool: 'pen',
        width: 2,
      };
    });
    await writeJson(join(surfaceRoot, `surface-${surfaceIndex}.json`), {
      createdAt: timestamp,
      deviceId: 's22-performance-hat',
      filePath: condition.filePath,
      id: `surface-${surfaceIndex}`,
      layout: {
        blockFingerprints: [`block-${surfaceIndex}`],
        fontFamily: 'system-ui',
        fontSize: 16,
        lineHeight: 24,
        logicalHeight: 1_000,
        logicalWidth: 704,
        originY: surfaceIndex * 1_000,
        sourceRevision: sha256(source),
        themeMode: 'light',
      },
      noteId,
      revision: 1,
      schemaVersion: 2,
      status: 'active',
      strokes,
      updatedAt: timestamp,
    });
  }
}

/**
 * Removes only the deterministic sidecar owned by one generated performance condition. A prior
 * interrupted real-host run may have landed schema v3, Recovery, and disposable summary files in
 * this directory; overlaying fresh v2 surfaces would leave those artifacts mixed together.
 *
 * @param {string} outputRoot
 * @param {string} filePath
 */
export async function resetOwnedConditionSidecar(outputRoot, filePath) {
  await rm(join(outputRoot, '.obsidian-annotations', 'v1', 'notes', sha256(filePath)), {
    force: true,
    recursive: true,
  });
}

/** @param {string} outputRoot @returns {Promise<InkPerformanceHatResult>} */
async function info(outputRoot) {
  const base = await getDeviceHatVaultInfo({ outputRoot });
  if (base.status !== 'prepared') return { outputRoot, status: 'not-prepared' };
  try {
    /** @type {unknown} */
    const marker = JSON.parse(await readFile(join(outputRoot, MARKER), 'utf8'));
    const conditions =
      isRecord(marker) && Array.isArray(marker.conditions) ? marker.conditions : [];
    let seededStrokes = 0;
    for (const condition of conditions) {
      if (isRecord(condition) && typeof condition.strokeCount === 'number') {
        seededStrokes += condition.strokeCount;
      }
    }
    return {
      outputRoot,
      seededStrokes,
      status: 'prepared',
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { outputRoot, status: 'not-prepared' };
    }
    throw error;
  }
}

async function runCli() {
  const command = process.argv[2] ?? 'info';
  const projectRoot = resolve(process.env.INKSTONE_PROJECT_ROOT ?? process.cwd());
  const outputRoot = resolve(
    process.env.INKSTONE_S22_HAT_OUTPUT ?? join(projectRoot, '.hat', 's22-ink-performance'),
  );
  /** @type {InkPerformanceHatResult} */
  let result;
  if (command === 'prepare') result = await prepare({ outputRoot, projectRoot });
  else if (command === 'prepare-in-place') {
    result = await prepareInPlace({ outputRoot, projectRoot });
  } else if (command === 'cleanup') {
    await cleanupDeviceHatVault({ outputRoot });
    result = await info(outputRoot);
  } else if (command === 'info') result = await info(outputRoot);
  else {
    throw new Error(`Unknown command: ${command}. Use prepare, prepare-in-place, info or cleanup.`);
  }
  printSummary(result);
}

/** @param {InkPerformanceHatResult} result */
function printSummary(result) {
  console.log('HAT_PREPARE_SUMMARY');
  console.log('mode=blank');
  console.log(`status=${result.status}`);
  console.log(`app_url=obsidian://open?vault=${encodeURIComponent(basename(result.outputRoot))}`);
  console.log('database=not-applicable');
  console.log('schema_version=ink-v2');
  console.log(`seed_records=ink_strokes:${result.seededStrokes ?? 0}`);
  console.log('cleanup=docs/delivery/slices/S22-ink-performance-baseline/prepare.sh cleanup');
  console.log('guide=docs/delivery/slices/S22-ink-performance-baseline/hat-guide.md');
  console.log(`output=${result.outputRoot}`);
  console.log('END_HAT_PREPARE_SUMMARY');
}

/** @param {string} path @param {unknown} value */
async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** @param {string} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
