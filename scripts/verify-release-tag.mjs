import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DESCRIPTION =
  'Highlight and underline mutable Markdown, add notes, and draw on stable snapshots.';
const PLUGIN_ID = 'inkstone-annotations';
const PLUGIN_NAME = 'Inkstone Annotations';

/**
 * @param {{ projectRoot?: string, tag: string }} input
 * @returns {Promise<{ minAppVersion: string, tag: string, version: string }>}
 */
export async function verifyReleaseTag({ projectRoot = resolve('.'), tag }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag)) {
    throw new Error('Release tag must use exact SemVer x.y.z without a prefix or suffix.');
  }
  const [manifest, packageMetadata, packageLock, versions] = await Promise.all([
    readJson(join(projectRoot, 'manifest.json')),
    readJson(join(projectRoot, 'package.json')),
    readJson(join(projectRoot, 'package-lock.json')),
    readJson(join(projectRoot, 'versions.json')),
  ]);
  const version = manifest.version;
  const minAppVersion = manifest.minAppVersion;
  const lockedPackages = packageLock.packages;
  const rootLockedPackage =
    isRecord(lockedPackages) && isRecord(lockedPackages['']) ? lockedPackages[''] : null;
  if (
    manifest.id !== PLUGIN_ID ||
    manifest.name !== PLUGIN_NAME ||
    manifest.description !== PLUGIN_DESCRIPTION ||
    manifest.author !== 'Ivan' ||
    manifest.authorUrl !== 'https://github.com/ivan-94' ||
    packageMetadata.name !== PLUGIN_ID ||
    packageMetadata.description !== PLUGIN_DESCRIPTION ||
    packageMetadata.license !== 'MIT'
  ) {
    throw new Error('Release plugin identity does not match the adopted public metadata.');
  }
  if (
    typeof version !== 'string' ||
    typeof minAppVersion !== 'string' ||
    tag !== version ||
    packageMetadata.version !== version ||
    packageLock.version !== version ||
    rootLockedPackage?.version !== version ||
    versions[version] !== minAppVersion
  ) {
    throw new Error(
      'Release tag, manifest, package, lockfile, and versions metadata must agree exactly.',
    );
  }
  if (version.startsWith('0.1.') && manifest.isDesktopOnly !== false) {
    throw new Error('The 0.1 Beta release line must retain its adopted mobile-capable manifest.');
  }
  return { minAppVersion, tag, version };
}

/** @param {string} path @returns {Promise<Record<string, unknown>>} */
async function readJson(path) {
  /** @type {unknown} */
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Release metadata is not an object: ${path}`);
  }
  return parsed;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (tag === undefined) {
    throw new Error('Usage: node scripts/verify-release-tag.mjs <x.y.z>');
  }
  const result = await verifyReleaseTag({ tag });
  console.log(`Release tag verified: ${result.tag} (Obsidian ${result.minAppVersion}+)`);
}
