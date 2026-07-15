import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const projectRoot = resolve(process.env.INKSTONE_PROJECT_ROOT ?? process.cwd());
const outputPath = resolve(
  process.env.INKSTONE_SCALE_REPORT ??
    join(projectRoot, 'docs', 'delivery', 'slices', 'S14-release-candidate', 'scale-report.json'),
);
const bundleRoot = await mkdtemp(join(tmpdir(), 'inkstone-scale-runner-'));
const bundlePath = join(bundleRoot, 'scale-harness.mjs');

try {
  await build({
    bundle: true,
    entryPoints: [join(projectRoot, 'scripts', 'scale-harness.ts')],
    format: 'esm',
    logLevel: 'silent',
    outfile: bundlePath,
    platform: 'node',
    target: 'node20',
  });
  // Dynamic import is the intentional runtime boundary for the temporary esbuild bundle.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const harnessModule = /** @type {typeof import('./scale-harness.ts')} */ (
    await import(`${pathToFileURL(bundlePath).href}?run=${Date.now()}`)
  );
  if (typeof harnessModule.runScaleHarness !== 'function') {
    throw new Error('Scale harness bundle does not export runScaleHarness.');
  }
  const result = await harnessModule.runScaleHarness({
    bulkSelectionSize: integerFromEnvironment('INKSTONE_SCALE_BULK', 100),
    cleanup: true,
    inkPerNote: integerFromEnvironment('INKSTONE_SCALE_INK_PER_NOTE', 100),
    noteCount: integerFromEnvironment('INKSTONE_SCALE_NOTES', 100),
    textPerNote: integerFromEnvironment('INKSTONE_SCALE_TEXT_PER_NOTE', 100),
  });
  const evidence = {
    ...result,
    caveat:
      'Local APFS/Node measurement only; it does not replace real Obsidian, iCloud hydration, browser frame, or device memory evidence.',
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log('INKSTONE_SCALE_HARNESS');
  console.log('status=passed');
  console.log(`canonical_files=${result.fixture.canonicalFiles}`);
  console.log(`index_entries=${result.fixture.indexEntries}`);
  console.log(`hydration_ms=${result.hydration.durationMs}`);
  console.log(`cache_restore_ms=${result.cache.durationMs}`);
  console.log(`search_ms=${result.search.durationMs}`);
  console.log(`heap_delta_mb=${result.memory.heapDeltaMb}`);
  console.log(`rss_delta_mb=${result.memory.rssDeltaMb}`);
  console.log(`evidence=${outputPath}`);
  console.log('END_INKSTONE_SCALE_HARNESS');
} finally {
  await rm(bundleRoot, { force: true, recursive: true });
}

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function integerFromEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}
