import esbuild from 'esbuild';
import process from 'node:process';

const buildMode = process.argv[2] ?? 'development';
const production = buildMode === 'production';
const webHat = buildMode === 'web-hat';
const releaseLike = production || webHat;

const context = await esbuild.context({
  banner: {
    js: '/* Inkstone Annotations - generated Snapshot Annotation bundle */',
  },
  bundle: true,
  define: {
    __INKSTONE_ACCEPTANCE_COMMANDS__: JSON.stringify(webHat),
    __INKSTONE_WEB_CAPTURE_BACKENDS__: 'true',
  },
  entryPoints: ['src/main.ts'],
  // Obsidian supplies its own CodeMirror instance. Externalizing these packages avoids
  // creating incompatible duplicate StateField/Extension identities in the plugin bundle.
  external: ['obsidian', '@codemirror/state', '@codemirror/view'],
  format: 'cjs',
  logLevel: 'info',
  minify: releaseLike,
  outfile: 'main.js',
  platform: 'browser',
  sourcemap: releaseLike ? false : 'inline',
  target: 'es2018',
  treeShaking: true,
});

if (releaseLike) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
