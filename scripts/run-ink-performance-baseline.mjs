import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const projectRoot = resolve(process.env.INKSTONE_PROJECT_ROOT ?? process.cwd());
const outputPath = resolve(
  process.env.INKSTONE_INK_BASELINE_REPORT ??
    join(
      projectRoot,
      'docs',
      'delivery',
      'slices',
      'S22-ink-performance-baseline',
      'baseline-node.json',
    ),
);
const bundleRoot = await mkdtemp(join(tmpdir(), 'inkstone-ink-baseline-'));
const bundlePath = join(bundleRoot, 'ink-performance-baseline.mjs');

try {
  await build({
    bundle: true,
    entryPoints: [join(projectRoot, 'scripts', 'ink-performance-baseline.ts')],
    format: 'esm',
    logLevel: 'silent',
    outfile: bundlePath,
    platform: 'node',
    target: 'node20',
  });
  // Dynamic import is the intentional runtime boundary for the temporary esbuild bundle.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const harnessModule = /** @type {typeof import('./ink-performance-baseline.ts')} */ (
    await import(`${pathToFileURL(bundlePath).href}?run=${Date.now()}`)
  );
  if (typeof harnessModule.runInkPerformanceBaseline !== 'function') {
    throw new Error('Ink performance baseline bundle does not export its harness.');
  }
  const result = harnessModule.runInkPerformanceBaseline({
    sampleCount: integerFromEnvironment('INKSTONE_INK_BASELINE_SAMPLES', 100, false),
    warmupCount: integerFromEnvironment('INKSTONE_INK_BASELINE_WARMUPS', 25, true),
  });
  const evidence = {
    caveat:
      'Node production-session baseline only. It reproduces history-dependent snapshot work but does not replace production-build physical iPad Pointer/Touch, frame, or display evidence.',
    environment: { arch: process.arch, node: process.version, platform: process.platform },
    generatedAt: new Date().toISOString(),
    result,
    schemaVersion: 1,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log('INKSTONE_INK_PERFORMANCE_BASELINE');
  console.log('status=passed');
  for (const condition of result.conditions) {
    console.log(
      `${condition.name}:surfaces=${condition.surfaceCount}:strokes=${condition.strokeCount}:p50_ms=${condition.durationMs.p50}:p95_ms=${condition.durationMs.p95}:p99_ms=${condition.durationMs.p99}:max_ms=${condition.durationMs.maximum}`,
    );
  }
  console.log(`evidence=${outputPath}`);
  console.log('END_INKSTONE_INK_PERFORMANCE_BASELINE');
} finally {
  await rm(bundleRoot, { force: true, recursive: true });
}

/**
 * @param {string} name
 * @param {number} fallback
 * @param {boolean} allowZero
 * @returns {number}
 */
function integerFromEnvironment(name, fallback, allowZero) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'non-negative' : 'positive'}.`);
  }
  return parsed;
}
