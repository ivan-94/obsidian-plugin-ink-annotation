import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const vaultRoot = resolve(process.env.INKSTONE_VAULT ?? 'test-fixtures/vault');
const pluginDirectory = resolve(vaultRoot, '.obsidian', 'plugins', 'inkstone-annotations');

await mkdir(pluginDirectory, { recursive: true });

for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  await cp(resolve(file), resolve(pluginDirectory, file));
}

await mkdir(resolve(vaultRoot, '.obsidian'), { recursive: true });
await writeFile(
  resolve(vaultRoot, '.obsidian', 'community-plugins.json'),
  `${JSON.stringify(['inkstone-annotations'])}\n`,
  'utf8',
);

console.log(`Installed Inkstone Annotations into ${pluginDirectory}`);
