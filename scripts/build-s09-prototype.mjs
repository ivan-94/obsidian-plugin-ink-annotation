import { build } from 'esbuild';

await build({
  bundle: true,
  entryPoints: ['src/experiments/ink-spike-browser.ts'],
  format: 'esm',
  logLevel: 'info',
  outfile: 'prototypes/s09-ink-spike/bundle.js',
  platform: 'browser',
  sourcemap: 'inline',
  target: ['es2022'],
});
