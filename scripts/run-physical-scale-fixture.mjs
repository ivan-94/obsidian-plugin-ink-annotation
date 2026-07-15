#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const vaultRoot = process.argv[2];
if (vaultRoot === undefined) {
  throw new Error('Usage: node scripts/run-physical-scale-fixture.mjs <vault-root>');
}

const projectRoot = resolve(import.meta.dirname, '..');
const bundleRoot = await mkdtemp(join(tmpdir(), 'inkstone-physical-scale-runner-'));
const bundlePath = join(bundleRoot, 'physical-scale-fixture.mjs');

try {
  await build({
    bundle: true,
    entryPoints: [join(projectRoot, 'scripts', 'physical-scale-fixture.ts')],
    format: 'esm',
    outfile: bundlePath,
    platform: 'node',
    target: 'node20',
  });
  // Dynamic import is the intentional runtime boundary for the temporary esbuild bundle.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const fixtureModule = /** @type {typeof import('./physical-scale-fixture.ts')} */ (
    await import(`${pathToFileURL(bundlePath).href}?run=${Date.now()}`)
  );
  if (typeof fixtureModule.preparePhysicalScaleFixture !== 'function') {
    throw new Error('Physical scale fixture bundle does not export its prepare function.');
  }
  const result = await fixtureModule.preparePhysicalScaleFixture({
    vaultRoot: resolve(vaultRoot),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await rm(bundleRoot, { force: true, recursive: true });
}
