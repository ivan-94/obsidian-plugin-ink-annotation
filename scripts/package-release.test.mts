import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { packageRelease, verifyReleasePackage } from './package-release.mjs';

describe('release candidate packager', () => {
  const created: string[] = [];

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(created.splice(0).map((path) => rm(path, { force: true, recursive: true })));
  });

  it('copies only Obsidian runtime artifacts and emits reproducible checksums', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-package-'));
    created.push(root);
    await Promise.all([
      writeFile(join(root, 'manifest.json'), JSON.stringify({ id: 'inkstone', version: '1.2.3' })),
      writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' })),
      writeFile(join(root, 'versions.json'), JSON.stringify({ '1.2.3': '1.7.2' })),
      writeFile(join(root, 'main.js'), 'module.exports = {};\n'),
      writeFile(join(root, 'styles.css'), '.inkstone {}\n'),
    ]);

    const result = await packageRelease({ outputRoot: join(root, 'dist'), projectRoot: root });

    expect(result.version).toBe('1.2.3');
    expect(result.files).toEqual(['main.js', 'manifest.json', 'styles.css']);
    const checksums: unknown = JSON.parse(
      await readFile(join(result.directory, 'checksums.json'), 'utf8'),
    );
    if (!isChecksumManifest(checksums)) throw new Error('Invalid checksum manifest fixture.');
    expect(checksums.algorithm).toBe('sha256');
    expect(checksums.version).toBe('1.2.3');
    for (const filename of ['main.js', 'manifest.json', 'styles.css']) {
      expect(checksums.files[filename]).toMatch(/^[a-f0-9]{64}$/u);
    }
    await expect(verifyReleasePackage(result.directory)).resolves.toEqual({
      files: ['main.js', 'manifest.json', 'styles.css'],
      version: '1.2.3',
    });
    await writeFile(join(result.directory, 'main.js'), 'tampered');
    await expect(verifyReleasePackage(result.directory)).rejects.toThrow(/checksum/u);
  });

  it('fails closed when release metadata versions diverge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-package-'));
    created.push(root);
    await Promise.all([
      writeFile(join(root, 'manifest.json'), JSON.stringify({ id: 'inkstone', version: '1.2.3' })),
      writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.4' })),
      writeFile(join(root, 'versions.json'), JSON.stringify({ '1.2.3': '1.7.2' })),
      writeFile(join(root, 'main.js'), ''),
      writeFile(join(root, 'styles.css'), ''),
    ]);

    await expect(
      packageRelease({ outputRoot: join(root, 'dist'), projectRoot: root }),
    ).rejects.toThrow(/version metadata/u);
  });
});

function isChecksumManifest(value: unknown): value is {
  algorithm: string;
  files: Record<string, string>;
  version: string;
} {
  if (typeof value !== 'object' || value === null || !('files' in value)) return false;
  const files = value.files;
  return (
    'algorithm' in value &&
    typeof value.algorithm === 'string' &&
    'version' in value &&
    typeof value.version === 'string' &&
    typeof files === 'object' &&
    files !== null &&
    Object.values(files).every((checksum) => typeof checksum === 'string')
  );
}
