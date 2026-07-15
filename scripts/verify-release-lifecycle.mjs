import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { verifyReleasePackage } from './package-release.mjs';

const PLUGIN_ID = 'inkstone-annotations';
const RUNTIME_FILES = /** @type {const} */ (['main.js', 'manifest.json', 'styles.css']);

/**
 * Performs a filesystem-level fresh install, upgrade, rollback, and uninstall against a sentinel
 * canonical sidecar. It never launches Obsidian and therefore complements, rather than replaces,
 * the release HAT.
 * @param {{ cleanup?: boolean, packageDirectory: string, workRoot?: string }} input
 */
export async function verifyReleaseLifecycle(input) {
  const verified = await verifyReleasePackage(input.packageDirectory);
  const ownsWorkRoot = input.workRoot === undefined;
  const workRoot = input.workRoot ?? (await mkdtemp(join(tmpdir(), 'inkstone-rc-lifecycle-')));
  const vaultRoot = join(workRoot, 'vault');
  const pluginRoot = join(vaultRoot, '.obsidian', 'plugins', PLUGIN_ID);
  const backupRoot = join(workRoot, 'backup', PLUGIN_ID);
  const canonicalPath = join(
    vaultRoot,
    '.obsidian-annotations',
    'v1',
    'notes',
    'sentinel',
    'annotations',
    'sentinel-record.json',
  );
  const canonicalBytes = '{"canonical":"must survive plugin lifecycle"}\n';
  await mkdir(dirname(canonicalPath), { recursive: true });
  await writeFile(canonicalPath, canonicalBytes, 'utf8');
  const canonicalHash = sha256(canonicalBytes);

  try {
    await installRuntime(input.packageDirectory, pluginRoot);
    await assertRuntimeMatches(input.packageDirectory, pluginRoot);

    await rm(pluginRoot, { force: true, recursive: true });
    const legacy = {
      'main.js': '/* previous Inkstone runtime */\n',
      'manifest.json': `${JSON.stringify({ id: PLUGIN_ID, version: '0.0.9' })}\n`,
      'styles.css': '/* previous Inkstone styles */\n',
    };
    await mkdir(pluginRoot, { recursive: true });
    for (const filename of RUNTIME_FILES) {
      await writeFile(join(pluginRoot, filename), legacy[filename], 'utf8');
    }
    await cp(pluginRoot, backupRoot, { recursive: true });

    await installRuntime(input.packageDirectory, pluginRoot);
    await assertRuntimeMatches(input.packageDirectory, pluginRoot);
    await assertCanonical(canonicalPath, canonicalHash);

    await rm(pluginRoot, { force: true, recursive: true });
    await cp(backupRoot, pluginRoot, { recursive: true });
    for (const filename of RUNTIME_FILES) {
      const restored = await readFile(join(pluginRoot, filename), 'utf8');
      if (restored !== legacy[filename]) {
        throw new Error(`Rollback did not restore ${filename} byte-for-byte.`);
      }
    }
    await assertCanonical(canonicalPath, canonicalHash);

    await rm(pluginRoot, { force: true, recursive: true });
    await assertCanonical(canonicalPath, canonicalHash);

    return {
      canonicalHash,
      packageDirectory: input.packageDirectory,
      pluginId: PLUGIN_ID,
      runtimeFiles: [...RUNTIME_FILES],
      status: 'passed',
      version: verified.version,
      workRoot,
    };
  } finally {
    if (ownsWorkRoot && input.cleanup !== false) {
      await rm(workRoot, { force: true, recursive: true });
    }
  }
}

/** @param {string} packageDirectory @param {string} pluginRoot */
async function installRuntime(packageDirectory, pluginRoot) {
  await mkdir(pluginRoot, { recursive: true });
  for (const filename of RUNTIME_FILES) {
    await cp(join(packageDirectory, filename), join(pluginRoot, filename));
  }
}

/** @param {string} packageDirectory @param {string} pluginRoot */
async function assertRuntimeMatches(packageDirectory, pluginRoot) {
  for (const filename of RUNTIME_FILES) {
    const [packaged, installed] = await Promise.all([
      readFile(join(packageDirectory, filename)),
      readFile(join(pluginRoot, filename)),
    ]);
    if (!packaged.equals(installed)) {
      throw new Error(`Installed runtime does not match the release package: ${filename}.`);
    }
  }
}

/** @param {string} canonicalPath @param {string} expectedHash */
async function assertCanonical(canonicalPath, expectedHash) {
  const actualHash = sha256(await readFile(canonicalPath));
  if (actualHash !== expectedHash) {
    throw new Error('Plugin lifecycle operation changed canonical annotation bytes.');
  }
}

/** @param {string | Uint8Array} value */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function runCli() {
  const projectRoot = resolve(process.env.INKSTONE_PROJECT_ROOT ?? process.cwd());
  /** @type {unknown} */
  const manifest = JSON.parse(await readFile(join(projectRoot, 'manifest.json'), 'utf8'));
  if (!isRecord(manifest) || typeof manifest.version !== 'string') {
    throw new Error('Project manifest is missing a release version.');
  }
  const packageDirectory = resolve(
    process.env.INKSTONE_RC_PACKAGE ??
      join(projectRoot, 'dist', `${PLUGIN_ID}-${String(manifest.version)}`),
  );
  const result = await verifyReleaseLifecycle({ packageDirectory });
  const evidencePath = join(
    dirname(packageDirectory),
    `${basename(packageDirectory)}.lifecycle.json`,
  );
  await writeFile(
    evidencePath,
    `${JSON.stringify({ ...result, evidencePath }, null, 2)}\n`,
    'utf8',
  );
  console.log('INKSTONE_RELEASE_LIFECYCLE');
  console.log(`status=${result.status}`);
  console.log(`version=${result.version}`);
  console.log(`canonical_sha256=${result.canonicalHash}`);
  console.log(`evidence=${evidencePath}`);
  console.log('END_INKSTONE_RELEASE_LIFECYCLE');
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
