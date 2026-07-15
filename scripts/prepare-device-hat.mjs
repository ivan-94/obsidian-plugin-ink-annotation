import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const PLUGIN_ID = 'inkstone-annotations';
const OWNERSHIP_MARKER = '.inkstone-hat-owned';

/**
 * @typedef {{ outputRoot: string, projectRoot: string }} PrepareOptions
 * @typedef {{ outputRoot: string }} OutputOptions
 * @typedef {{ noteCount: number, outputRoot: string, pluginId: string }} PreparedResult
 * @typedef {{ noteCount?: number, outputRoot: string, pluginId?: string, status: string }} DeviceHatInfo
 */

/**
 * @param {PrepareOptions} options
 * @returns {Promise<PreparedResult>}
 */
export async function prepareDeviceHatVault({ outputRoot, projectRoot }) {
  await resetOwnedOutput(outputRoot);
  await writeFile(join(outputRoot, OWNERSHIP_MARKER), 'Inkstone S00 device HAT Vault\n', 'utf8');

  const pluginRoot = join(outputRoot, '.obsidian', 'plugins', PLUGIN_ID);
  await mkdir(pluginRoot, { recursive: true });

  for (const filename of ['main.js', 'manifest.json', 'styles.css']) {
    await cp(join(projectRoot, filename), join(pluginRoot, filename));
  }

  await writeFile(
    join(outputRoot, '.obsidian', 'community-plugins.json'),
    `${JSON.stringify([PLUGIN_ID])}\n`,
    'utf8',
  );

  const fixtureRoot = join(projectRoot, 'test-fixtures', 'vault');
  const fixtureEntries = await readdir(fixtureRoot, { withFileTypes: true });
  const noteNames = fixtureEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();

  for (const noteName of noteNames) {
    await cp(join(fixtureRoot, noteName), join(outputRoot, noteName));
  }

  await writeReleaseQualificationFixture(outputRoot);

  const canonicalNotesRoot = join(fixtureRoot, '.obsidian-annotations', 'v1', 'notes');
  try {
    await cp(canonicalNotesRoot, join(outputRoot, '.obsidian-annotations', 'v1', 'notes'), {
      recursive: true,
    });
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  await writeFile(
    join(outputRoot, 'S00 Device HAT.md'),
    [
      '# Inkstone Annotations — S00 Device HAT',
      '',
      'This isolated Vault contains the production plugin bundle and representative fixture notes.',
      'Open `S14 Qualification.md` for deterministic active, overlap, draft, unanchored, conflict, and Ink states.',
      'Use the command palette action `Inkstone Annotations: Show diagnostics` during acceptance.',
      '',
    ].join('\n'),
    'utf8',
  );

  return { noteCount: noteNames.length + 1, outputRoot, pluginId: PLUGIN_ID };
}

/**
 * Creates deterministic canonical states for the integrated S14 HAT. Derived indexes and summaries
 * are deliberately absent so opening the sidebar exercises canonical rebuild paths.
 * @param {string} outputRoot
 */
export async function writeReleaseQualificationFixture(outputRoot) {
  const filePath = 'S14 Qualification.md';
  const source = [
    '# S14 Qualification',
    '',
    'The overlap target is shared by two visible marks.',
    '',
    'The draft target keeps an unfinished local note.',
    '',
    'The conflict target has divergent Mac and iPad copies.',
    '',
    '## Ink states',
    '',
    'The three Ink surfaces exercise active, needs-rebase, and unanchored states.',
    '',
  ].join('\n');
  await writeFile(join(outputRoot, filePath), source, 'utf8');

  const pathHash = sha256(filePath);
  const noteId = 'note-s14-qualification';
  const noteRoot = join(outputRoot, '.obsidian-annotations', 'v1', 'notes', pathHash);
  const annotationRoot = join(noteRoot, 'annotations');
  const surfaceRoot = join(noteRoot, 'surfaces');
  await mkdir(annotationRoot, { recursive: true });
  await mkdir(surfaceRoot, { recursive: true });
  const timestamp = '2026-07-14T12:00:00.000Z';
  await writeJson(join(noteRoot, 'meta.json'), {
    filePath,
    lastReconciledAt: timestamp,
    noteId,
    pathHash,
    schemaVersion: 1,
    sourceFingerprint: sha256(source),
  });

  const overlapTarget = textTarget(source, 'overlap target');
  const draftTarget = textTarget(source, 'draft target');
  const conflictTarget = textTarget(source, 'conflict target');
  const baseRecord = {
    createdAt: timestamp,
    deviceId: 'fixture-mac',
    filePath,
    noteId,
    schemaVersion: 1,
    updatedAt: timestamp,
  };
  const records = [
    {
      ...baseRecord,
      id: 'annotation-overlap-highlight',
      mark: { kind: 'highlight', styleId: 'highlight-sun' },
      revision: 1,
      status: 'active',
      tags: ['overlap'],
      target: overlapTarget,
    },
    {
      ...baseRecord,
      body: 'Second record on the same target.',
      id: 'annotation-overlap-underline',
      mark: { kind: 'underline', styleId: 'highlight-mint' },
      revision: 1,
      status: 'active',
      tags: ['overlap', 'note'],
      target: overlapTarget,
    },
    {
      ...baseRecord,
      id: 'annotation-draft',
      revision: 1,
      status: 'draft',
      tags: [],
      target: draftTarget,
    },
    {
      ...baseRecord,
      anchorFailure: { candidateCount: 0, reason: 'not-found' },
      body: 'The original target was removed; repair must be explicit.',
      id: 'annotation-unanchored',
      revision: 2,
      status: 'unanchored',
      tags: ['repair'],
      target: {
        position: { end: 21, start: 7, unit: 'utf16-code-unit' },
        quote: { exact: 'removed target', prefix: 'Old ', suffix: ' no longer exists.' },
        scope: { headingPath: ['S14 Qualification'] },
        sourceRevision: sha256('Old removed target no longer exists.'),
      },
    },
  ];
  for (const record of records) {
    await writeJson(join(annotationRoot, `${record.id}.json`), record);
  }
  const conflictBase = {
    ...baseRecord,
    id: 'annotation-conflict',
    mark: { kind: 'highlight', styleId: 'highlight-violet' },
    revision: 2,
    status: 'active',
    tags: ['icloud', 'conflict'],
    target: conflictTarget,
  };
  await writeJson(join(annotationRoot, 'annotation-conflict.json'), {
    ...conflictBase,
    body: 'Edited on Mac.',
    deviceId: 'fixture-mac',
  });
  await writeJson(join(annotationRoot, 'annotation-conflict (iCloud copy).json'), {
    ...conflictBase,
    body: 'Edited on iPad.',
    deviceId: 'fixture-ipad',
  });

  const inkLayout = {
    blockFingerprints: ['s14-ink-block'],
    fontFamily: 'system-ui',
    fontSize: 16,
    lineHeight: 24,
    logicalHeight: 720,
    logicalWidth: 960,
    sourceRevision: sha256(source),
    themeMode: 'light',
  };
  const inkBinding = {
    blockFingerprints: ['s14-ink-block'],
    headingPath: ['S14 Qualification', 'Ink states'],
    sectionFingerprint: 's14-ink-section',
    sourceEnd: source.length,
    sourceStart: source.indexOf('## Ink states'),
  };
  const surfaceFixtures = /** @type {const} */ ([
    ['surface-active', 'active', inkBinding],
    ['surface-needs-rebase', 'needs-rebase', inkBinding],
    ['surface-unanchored', 'unanchored', undefined],
  ]);
  for (const [id, status, binding] of surfaceFixtures) {
    await writeJson(join(surfaceRoot, `${id}.json`), {
      ...(binding === undefined ? {} : { binding }),
      createdAt: timestamp,
      deviceId: 'fixture-mac',
      filePath,
      id,
      layout: inkLayout,
      noteId,
      revision: status === 'active' ? 1 : 2,
      schemaVersion: 1,
      status,
      strokes: [
        {
          color: status === 'needs-rebase' ? '#d97706' : '#2563eb',
          id: `stroke-${id}`,
          points: [
            { pressure: 0.4, time: 0, x: 40, y: 80 },
            { pressure: 0.6, time: 16, x: 180, y: 120 },
          ],
          tool: status === 'needs-rebase' ? 'highlighter' : 'pen',
          width: status === 'needs-rebase' ? 12 : 3,
        },
      ],
      updatedAt: timestamp,
    });
  }
}

/** @param {string} source @param {string} exact */
function textTarget(source, exact) {
  const start = source.indexOf(exact);
  if (start < 0) throw new Error(`Qualification fixture is missing target: ${exact}`);
  const end = start + exact.length;
  return {
    position: { end, start, unit: 'utf16-code-unit' },
    quote: {
      exact,
      prefix: source.slice(Math.max(0, start - 32), start),
      suffix: source.slice(end, Math.min(source.length, end + 32)),
    },
    scope: { headingPath: ['S14 Qualification'] },
    sourceRevision: sha256(source),
  };
}

/** @param {string} path @param {unknown} value */
async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** @param {string} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * @param {OutputOptions} options
 * @returns {Promise<boolean>}
 */
export async function cleanupDeviceHatVault({ outputRoot }) {
  if (!(await isOwnedOutput(outputRoot))) {
    return false;
  }

  await rm(outputRoot, { force: true, recursive: true });
  return true;
}

/**
 * @param {OutputOptions} options
 * @returns {Promise<DeviceHatInfo>}
 */
export async function getDeviceHatVaultInfo({ outputRoot }) {
  if (!(await isOwnedOutput(outputRoot))) {
    return { outputRoot, status: 'not-prepared' };
  }

  /** @type {unknown} */
  const manifest = JSON.parse(
    await readFile(join(outputRoot, '.obsidian', 'plugins', PLUGIN_ID, 'manifest.json'), 'utf8'),
  );

  return {
    outputRoot,
    pluginId: isRecord(manifest) && typeof manifest.id === 'string' ? manifest.id : PLUGIN_ID,
    status: 'prepared',
  };
}

/** @param {string} outputRoot */
async function resetOwnedOutput(outputRoot) {
  const exists = await directoryExists(outputRoot);

  if (exists && !(await isOwnedOutput(outputRoot))) {
    throw new Error(
      'Refusing to overwrite an existing directory without an Inkstone HAT ownership marker.',
    );
  }

  if (exists) {
    await rm(outputRoot, { force: true, recursive: true });
  }

  await mkdir(outputRoot, { recursive: true });
}

/** @param {string} directory */
async function directoryExists(directory) {
  try {
    await readdir(directory);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** @param {string} outputRoot */
async function isOwnedOutput(outputRoot) {
  try {
    await readFile(join(outputRoot, OWNERSHIP_MARKER), 'utf8');
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** @returns {Promise<void>} */
async function runCli() {
  const command = process.argv[2] ?? 'info';
  const projectRoot = resolve(process.env.INKSTONE_PROJECT_ROOT ?? process.cwd());
  const outputRoot = resolve(
    process.env.INKSTONE_HAT_OUTPUT ?? join(projectRoot, '.hat', 's00-device-vault'),
  );

  if (command === 'prepare') {
    const result = await prepareDeviceHatVault({ outputRoot, projectRoot });
    printSummary({ ...result, status: 'prepared' });
    return;
  }

  if (command === 'cleanup') {
    await cleanupDeviceHatVault({ outputRoot });
    printSummary(await getDeviceHatVaultInfo({ outputRoot }));
    return;
  }

  if (command === 'info') {
    printSummary(await getDeviceHatVaultInfo({ outputRoot }));
    return;
  }

  throw new Error(`Unknown command: ${command}. Use prepare, info or cleanup.`);
}

/** @param {DeviceHatInfo} info */
function printSummary(info) {
  console.log('INKSTONE_DEVICE_HAT_SUMMARY');
  console.log(`status=${info.status}`);
  console.log(`plugin_id=${info.pluginId ?? PLUGIN_ID}`);
  console.log(`output=${info.outputRoot}`);
  if (typeof info.noteCount === 'number') {
    console.log(`fixture_notes=${info.noteCount}`);
  }
  console.log('END_INKSTONE_DEVICE_HAT_SUMMARY');
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
