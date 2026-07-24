import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { verifyReleaseTag } from './verify-release-tag.mjs';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('release tag verifier', () => {
  it('accepts an exact SemVer tag when every release metadata surface agrees', async () => {
    const projectRoot = await releaseFixture('1.2.3');

    await expect(verifyReleaseTag({ projectRoot, tag: '1.2.3' })).resolves.toEqual({
      minAppVersion: '1.7.2',
      tag: '1.2.3',
      version: '1.2.3',
    });
  });

  it('rejects a v-prefixed release even when every metadata surface repeats it', async () => {
    const projectRoot = await releaseFixture('v1.2.3');

    await expect(verifyReleaseTag({ projectRoot, tag: 'v1.2.3' })).rejects.toThrow(
      /SemVer x\.y\.z/u,
    );
  });

  it('rejects a stale root package version in the npm lockfile', async () => {
    const projectRoot = await releaseFixture('1.2.3');
    const lockPath = join(projectRoot, 'package-lock.json');
    const lock: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (typeof lock !== 'object' || lock === null) throw new Error('Invalid lockfile fixture.');
    await writeFile(
      lockPath,
      `${JSON.stringify({ ...lock, packages: { '': { version: '1.2.2' } } })}\n`,
    );

    await expect(verifyReleaseTag({ projectRoot, tag: '1.2.3' })).rejects.toThrow(/lockfile/u);
  });

  it('rejects a package identity that differs from the public plugin manifest', async () => {
    const projectRoot = await releaseFixture('1.2.3');
    const packagePath = join(projectRoot, 'package.json');
    const packageMetadata: unknown = JSON.parse(await readFile(packagePath, 'utf8'));
    if (typeof packageMetadata !== 'object' || packageMetadata === null) {
      throw new Error('Invalid package fixture.');
    }
    await writeFile(
      packagePath,
      `${JSON.stringify({ ...packageMetadata, name: 'different-plugin' })}\n`,
    );

    await expect(verifyReleaseTag({ projectRoot, tag: '1.2.3' })).rejects.toThrow(
      /plugin identity/u,
    );
  });

  it('rejects a 0.1 release that contradicts the adopted mobile-capable manifest', async () => {
    const projectRoot = await releaseFixture('0.1.0');
    const manifestPath = join(projectRoot, 'manifest.json');
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof manifest !== 'object' || manifest === null) {
      throw new Error('Invalid manifest fixture.');
    }
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, isDesktopOnly: true })}\n`);

    await expect(verifyReleaseTag({ projectRoot, tag: '0.1.0' })).rejects.toThrow(
      /mobile-capable/u,
    );
  });
});

async function releaseFixture(version: string): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'inkstone-release-tag-'));
  roots.push(projectRoot);
  await Promise.all([
    writeFile(
      join(projectRoot, 'manifest.json'),
      `${JSON.stringify({
        author: 'Ivan',
        authorUrl: 'https://github.com/ivan-94',
        description:
          'Highlight and underline mutable Markdown, add notes, and draw on stable snapshots.',
        id: 'inkstone-annotations',
        isDesktopOnly: false,
        minAppVersion: '1.7.2',
        name: 'Inkstone Annotations',
        version,
      })}\n`,
    ),
    writeFile(
      join(projectRoot, 'package.json'),
      `${JSON.stringify({
        description:
          'Highlight and underline mutable Markdown, add notes, and draw on stable snapshots.',
        license: 'MIT',
        name: 'inkstone-annotations',
        version,
      })}\n`,
    ),
    writeFile(
      join(projectRoot, 'package-lock.json'),
      `${JSON.stringify({ packages: { '': { version } }, version })}\n`,
    ),
    writeFile(join(projectRoot, 'versions.json'), `${JSON.stringify({ [version]: '1.7.2' })}\n`),
  ]);
  return projectRoot;
}
