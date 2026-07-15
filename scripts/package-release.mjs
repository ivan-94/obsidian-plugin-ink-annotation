import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_FILES = Object.freeze(['main.js', 'manifest.json', 'styles.css']);

/**
 * @typedef {{ outputRoot?: string, projectRoot?: string }} PackageReleaseOptions
 * @typedef {{ directory: string, files: readonly string[], version: string }} PackageReleaseResult
 */

/**
 * @param {PackageReleaseOptions} [options]
 * @returns {Promise<PackageReleaseResult>}
 */
export async function packageRelease({
  outputRoot = resolve('dist'),
  projectRoot = resolve('.'),
} = {}) {
  const [manifest, packageMetadata, versions] = await Promise.all([
    readJson(join(projectRoot, 'manifest.json')),
    readJson(join(projectRoot, 'package.json')),
    readJson(join(projectRoot, 'versions.json')),
  ]);
  const version = manifest.version;
  if (
    typeof version !== 'string' ||
    packageMetadata.version !== version ||
    typeof versions[version] !== 'string'
  ) {
    throw new Error('Release version metadata must agree across manifest, package, and versions.');
  }
  const directory = join(outputRoot, `inkstone-annotations-${version}`);
  const temporaryDirectory = `${directory}.tmp-${process.pid}`;
  await rm(temporaryDirectory, { force: true, recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });

  /** @type {Record<string, string>} */
  const checksums = {};
  for (const filename of RUNTIME_FILES) {
    const source = join(projectRoot, filename);
    const destination = join(temporaryDirectory, filename);
    const contents = await readFile(source);
    checksums[filename] = createHash('sha256').update(contents).digest('hex');
    await copyFile(source, destination);
  }
  await writeFile(
    join(temporaryDirectory, 'checksums.json'),
    `${JSON.stringify({ algorithm: 'sha256', files: checksums, version }, null, 2)}\n`,
  );
  await mkdir(dirname(directory), { recursive: true });
  await rm(directory, { force: true, recursive: true });
  await rename(temporaryDirectory, directory);
  await verifyReleasePackage(directory);
  return { directory, files: RUNTIME_FILES, version };
}

/**
 * @param {string} directory
 * @returns {Promise<{ files: readonly string[], version: string }>}
 */
export async function verifyReleasePackage(directory) {
  const checksumManifest = await readJson(join(directory, 'checksums.json'));
  const version = checksumManifest.version;
  const algorithm = checksumManifest.algorithm;
  const files = checksumManifest.files;
  if (
    version === undefined ||
    typeof version !== 'string' ||
    algorithm !== 'sha256' ||
    !isStringRecord(files) ||
    RUNTIME_FILES.some((filename) => typeof files[filename] !== 'string')
  ) {
    throw new Error('Release checksum metadata is invalid.');
  }
  for (const filename of RUNTIME_FILES) {
    const actual = createHash('sha256')
      .update(await readFile(join(directory, filename)))
      .digest('hex');
    if (actual !== files[filename]) {
      throw new Error(`Release checksum mismatch for ${filename}.`);
    }
  }
  const manifest = await readJson(join(directory, 'manifest.json'));
  if (manifest.version !== version) {
    throw new Error('Packaged manifest version does not match its checksum metadata.');
  }
  return { files: RUNTIME_FILES, version };
}

/**
 * @param {string} path
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(path) {
  /** @type {unknown} */
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Release metadata is not an object: ${path}`);
  }
  return parsed;
}

/** @param {unknown} value @returns {value is Record<string, string>} */
function isStringRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await packageRelease();
  console.log(`Release candidate ${result.version}: ${result.directory}`);
}
