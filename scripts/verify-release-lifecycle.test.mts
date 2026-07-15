import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { packageRelease } from './package-release.mjs';
import { verifyReleaseLifecycle } from './verify-release-lifecycle.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('release lifecycle verifier', () => {
  it('installs, upgrades, rolls back and uninstalls without changing canonical bytes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'inkstone-rc-project-'));
    const outputRoot = join(projectRoot, 'dist');
    const workRoot = join(projectRoot, 'lifecycle');
    roots.push(projectRoot);
    await Promise.all([
      writeFile(join(projectRoot, 'main.js'), 'current runtime\n'),
      writeFile(
        join(projectRoot, 'manifest.json'),
        `${JSON.stringify({ id: 'inkstone-annotations', version: '0.1.0' })}\n`,
      ),
      writeFile(
        join(projectRoot, 'package.json'),
        `${JSON.stringify({ name: 'inkstone-annotations', version: '0.1.0' })}\n`,
      ),
      writeFile(join(projectRoot, 'styles.css'), 'current styles\n'),
      writeFile(join(projectRoot, 'versions.json'), '{"0.1.0":"1.8.0"}\n'),
    ]);
    const packaged = await packageRelease({ outputRoot, projectRoot });

    const result = await verifyReleaseLifecycle({
      cleanup: false,
      packageDirectory: packaged.directory,
      workRoot,
    });

    expect(result).toMatchObject({
      pluginId: 'inkstone-annotations',
      status: 'passed',
      version: '0.1.0',
      workRoot,
    });
    await expect(
      readFile(
        join(
          workRoot,
          'vault',
          '.obsidian-annotations',
          'v1',
          'notes',
          'sentinel',
          'annotations',
          'sentinel-record.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('must survive plugin lifecycle');
    await expect(
      readFile(join(workRoot, 'vault', '.obsidian', 'plugins', 'inkstone-annotations', 'main.js')),
    ).rejects.toThrow();
    await expect(
      readFile(join(workRoot, 'backup', 'inkstone-annotations', 'main.js'), 'utf8'),
    ).resolves.toBe('/* previous Inkstone runtime */\n');
  });

  it('rejects a tampered candidate before touching the lifecycle Vault', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'inkstone-rc-tamper-'));
    const outputRoot = join(projectRoot, 'dist');
    const workRoot = join(projectRoot, 'lifecycle');
    roots.push(projectRoot);
    await mkdir(projectRoot, { recursive: true });
    await Promise.all([
      writeFile(join(projectRoot, 'main.js'), 'runtime\n'),
      writeFile(
        join(projectRoot, 'manifest.json'),
        `${JSON.stringify({ id: 'inkstone-annotations', version: '0.1.0' })}\n`,
      ),
      writeFile(
        join(projectRoot, 'package.json'),
        `${JSON.stringify({ name: 'inkstone-annotations', version: '0.1.0' })}\n`,
      ),
      writeFile(join(projectRoot, 'styles.css'), 'styles\n'),
      writeFile(join(projectRoot, 'versions.json'), '{"0.1.0":"1.8.0"}\n'),
    ]);
    const packaged = await packageRelease({ outputRoot, projectRoot });
    await writeFile(join(packaged.directory, 'main.js'), 'tampered\n');

    await expect(
      verifyReleaseLifecycle({ cleanup: false, packageDirectory: packaged.directory, workRoot }),
    ).rejects.toThrow(/checksum mismatch/u);
    await expect(readFile(join(workRoot, 'vault', '.obsidian-annotations'))).rejects.toThrow();
  });
});
