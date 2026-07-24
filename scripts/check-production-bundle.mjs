import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const LARGE_BUNDLE_BYTES = 20_000;
const MAX_BUNDLE_BYTES = 1_000_000;
const MIN_BYTES_PER_NON_EMPTY_LINE = 500;

/** @param {string} bundle @returns {{ bytes: number, nonEmptyLines: number }} */
export function validateProductionBundle(bundle) {
  if (/sourceMappingURL=/u.test(bundle)) {
    throw new Error('Production bundle must not contain an embedded or external source map.');
  }
  if (bundle.includes('Snapshot acceptance:')) {
    throw new Error('Production bundle contains an acceptance-only command.');
  }
  const fetchCalls = bundle.match(/\bfetch\s*\(/gu)?.length ?? 0;
  if (fetchCalls > 1) {
    throw new Error(
      `Production bundle contains an unexpected network fetch path: ${fetchCalls} calls.`,
    );
  }
  const bytes = new TextEncoder().encode(bundle).byteLength;
  const nonEmptyLines = bundle.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
  if (bytes > MAX_BUNDLE_BYTES) {
    throw new Error(
      `Production bundle exceeds the ${MAX_BUNDLE_BYTES}-byte release budget: ${bytes} bytes.`,
    );
  }
  if (
    bytes >= LARGE_BUNDLE_BYTES &&
    bytes / Math.max(1, nonEmptyLines) < MIN_BYTES_PER_NON_EMPTY_LINE
  ) {
    throw new Error(
      `Production bundle is not minified: ${bytes} bytes across ${nonEmptyLines} non-empty lines.`,
    );
  }
  return { bytes, nonEmptyLines };
}

async function main() {
  const bundlePath = process.env.INKSTONE_BUNDLE ?? new URL('../main.js', import.meta.url);
  const bundle = await readFile(bundlePath, 'utf8');
  const result = validateProductionBundle(bundle);
  console.log(
    `Production bundle check passed: ${result.bytes} bytes across ${result.nonEmptyLines} non-empty lines.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
