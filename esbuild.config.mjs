import esbuild from 'esbuild';
import process from 'node:process';

const production = process.argv[2] === 'production';
const localPerformanceGate =
  process.argv[3] === 'local-performance-gate' &&
  process.env.INKSTONE_LOCAL_PERFORMANCE_GATE === '1';
const unpublishedPhysicalInkHat =
  (process.argv[3] === 'physical-hat' &&
    process.env.INKSTONE_UNPUBLISHED_PHYSICAL_INK_HAT === '1') ||
  localPerformanceGate;

const context = await esbuild.context({
  banner: {
    js: `/* Inkstone Annotations - generated bundle; unpublished-physical-ink-hat=${String(unpublishedPhysicalInkHat)}; local-performance-gate=${String(localPerformanceGate)} */`,
  },
  bundle: true,
  define: {
    __INKSTONE_UNPUBLISHED_PHYSICAL_INK_HAT__: JSON.stringify(unpublishedPhysicalInkHat),
    __INKSTONE_LOCAL_PERFORMANCE_GATE__: JSON.stringify(localPerformanceGate),
  },
  entryPoints: ['src/main.ts'],
  // Obsidian supplies its own CodeMirror instance. Externalizing these packages avoids
  // creating incompatible duplicate StateField/Extension identities in the plugin bundle.
  external: ['obsidian', '@codemirror/state', '@codemirror/view'],
  format: 'cjs',
  logLevel: 'info',
  outfile: 'main.js',
  platform: 'browser',
  sourcemap: production ? false : 'inline',
  target: 'es2018',
  treeShaking: true,
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
