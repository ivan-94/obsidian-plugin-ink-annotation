import esbuild from 'esbuild';
import process from 'node:process';

const production = process.argv[2] === 'production';

const context = await esbuild.context({
  banner: {
    js: '/* Inkstone Annotations - generated bundle */',
  },
  bundle: true,
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
