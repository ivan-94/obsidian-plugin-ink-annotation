import { readFile } from 'node:fs/promises';
import process from 'node:process';

const bundlePath = process.env.INKSTONE_BUNDLE ?? new URL('../main.js', import.meta.url);
const bundle = await readFile(bundlePath, 'utf8');
const forbiddenPatterns = [
  /require\(["'](?:node:)?(?:child_process|electron|fs|os|path|worker_threads)["']\)/u,
  /from ["']node:/u,
  /process\.platform/u,
];

const matches = forbiddenPatterns.filter((pattern) => pattern.test(bundle));

if (matches.length > 0) {
  throw new Error(`Mobile bundle contains forbidden desktop imports: ${matches.join(', ')}`);
}

console.log('Mobile bundle check passed.');
