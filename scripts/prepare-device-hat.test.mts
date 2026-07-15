import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { decodeInkSurfaceRecord } from '../src/domain/ink-surface';
import { decodeTextAnnotationRecord } from '../src/domain/text-annotation';

import {
  cleanupDeviceHatVault,
  getDeviceHatVaultInfo,
  prepareDeviceHatVault,
} from './prepare-device-hat.mjs';

const temporaryRoots: string[] = [];
const executeFile = promisify(execFile);
const scriptPath = fileURLToPath(new URL('./prepare-device-hat.mjs', import.meta.url));

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe('device HAT Vault', () => {
  it('packages a loadable plugin and representative notes into an isolated Vault', async () => {
    const projectRoot = await makeProjectFixture();
    const outputRoot = join(projectRoot, '.hat', 's00-device-vault');
    temporaryRoots.push(outputRoot);

    const result = await prepareDeviceHatVault({ outputRoot, projectRoot });

    expect(result).toMatchObject({
      noteCount: 3,
      outputRoot,
      pluginId: 'inkstone-annotations',
    });
    await expect(
      readFile(join(outputRoot, '.obsidian', 'plugins', 'inkstone-annotations', 'main.js'), 'utf8'),
    ).resolves.toBe('built plugin');
    await expect(
      readFile(join(outputRoot, '.obsidian', 'community-plugins.json'), 'utf8'),
    ).resolves.toBe('["inkstone-annotations"]\n');
    await expect(readFile(join(outputRoot, 'Unicode and Repeated Text.md'), 'utf8')).resolves.toBe(
      '# Unicode\n',
    );
    await expect(readFile(join(outputRoot, 'S00 Device HAT.md'), 'utf8')).resolves.toContain(
      'Inkstone Annotations',
    );
    await expect(readFile(join(outputRoot, 'S14 Qualification.md'), 'utf8')).resolves.toContain(
      'overlap target',
    );
    await expect(
      readFile(
        join(outputRoot, '.obsidian-annotations', 'v1', 'notes', 'demo', 'meta.json'),
        'utf8',
      ),
    ).resolves.toContain('fixture-note');
    await expect(
      readFile(join(outputRoot, '.obsidian-annotations', 'v1', 'index.json'), 'utf8'),
    ).rejects.toThrow();

    const qualificationHash = createHash('sha256').update('S14 Qualification.md').digest('hex');
    const qualificationRoot = join(
      outputRoot,
      '.obsidian-annotations',
      'v1',
      'notes',
      qualificationHash,
    );
    const annotationRoot = join(qualificationRoot, 'annotations');
    const annotationFiles = await readdir(annotationRoot);
    expect(annotationFiles).toHaveLength(6);
    const annotations = await Promise.all(
      annotationFiles.map(async (filename) =>
        decodeTextAnnotationRecord(await readFile(join(annotationRoot, filename), 'utf8')),
      ),
    );
    expect(
      annotations.filter(({ target }) => target.quote.exact === 'overlap target'),
    ).toHaveLength(2);
    expect(annotations.map(({ status }) => status)).toEqual(
      expect.arrayContaining(['active', 'draft', 'unanchored']),
    );
    expect(annotations.filter(({ id }) => id === 'annotation-conflict')).toMatchObject([
      { body: 'Edited on iPad.', revision: 2 },
      { body: 'Edited on Mac.', revision: 2 },
    ]);

    const surfaceRoot = join(qualificationRoot, 'surfaces');
    const surfaces = await Promise.all(
      (await readdir(surfaceRoot)).map(async (filename) =>
        decodeInkSurfaceRecord(await readFile(join(surfaceRoot, filename), 'utf8')),
      ),
    );
    expect(surfaces.map(({ status }) => status).sort()).toEqual([
      'active',
      'needs-rebase',
      'unanchored',
    ]);
    await expect(readFile(join(qualificationRoot, 'summary.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(qualificationRoot, 'ink-summaries.json'), 'utf8')).rejects.toThrow();
  });

  it('refuses to overwrite a directory it does not own', async () => {
    const projectRoot = await makeProjectFixture();
    const outputRoot = join(projectRoot, 'existing-vault');
    await mkdir(outputRoot, { recursive: true });
    await writeFile(join(outputRoot, 'Personal note.md'), '# Keep me\n', 'utf8');

    await expect(prepareDeviceHatVault({ outputRoot, projectRoot })).rejects.toThrow(
      'Refusing to overwrite an existing directory without an Inkstone HAT ownership marker',
    );
    await expect(readFile(join(outputRoot, 'Personal note.md'), 'utf8')).resolves.toBe(
      '# Keep me\n',
    );
  });

  it('reports preparation state before and after safe cleanup', async () => {
    const projectRoot = await makeProjectFixture();
    const outputRoot = join(projectRoot, '.hat', 's00-device-vault');

    await expect(getDeviceHatVaultInfo({ outputRoot })).resolves.toEqual({
      outputRoot,
      status: 'not-prepared',
    });
    await prepareDeviceHatVault({ outputRoot, projectRoot });
    await expect(getDeviceHatVaultInfo({ outputRoot })).resolves.toMatchObject({
      outputRoot,
      pluginId: 'inkstone-annotations',
      status: 'prepared',
    });

    await expect(cleanupDeviceHatVault({ outputRoot })).resolves.toBe(true);
    await expect(getDeviceHatVaultInfo({ outputRoot })).resolves.toEqual({
      outputRoot,
      status: 'not-prepared',
    });
  });

  it('exposes prepare, info and cleanup through a stable CLI summary', async () => {
    const projectRoot = await makeProjectFixture();
    const outputRoot = join(projectRoot, '.hat', 's00-device-vault');
    const env = {
      ...process.env,
      INKSTONE_HAT_OUTPUT: outputRoot,
      INKSTONE_PROJECT_ROOT: projectRoot,
    };

    const prepared = await executeFile(process.execPath, [scriptPath, 'prepare'], { env });
    expect(prepared.stdout).toContain('INKSTONE_DEVICE_HAT_SUMMARY');
    expect(prepared.stdout).toContain('status=prepared');
    expect(prepared.stdout).toContain('plugin_id=inkstone-annotations');

    const info = await executeFile(process.execPath, [scriptPath, 'info'], { env });
    expect(info.stdout).toContain('status=prepared');

    const cleaned = await executeFile(process.execPath, [scriptPath, 'cleanup'], { env });
    expect(cleaned.stdout).toContain('status=not-prepared');
  });

  it('can recover after a failed prepare leaves partial owned output', async () => {
    const projectRoot = await makeProjectFixture();
    const outputRoot = join(projectRoot, '.hat', 's00-device-vault');
    await rm(join(projectRoot, 'main.js'));

    await expect(prepareDeviceHatVault({ outputRoot, projectRoot })).rejects.toThrow();
    await writeFile(join(projectRoot, 'main.js'), 'rebuilt plugin', 'utf8');

    await expect(prepareDeviceHatVault({ outputRoot, projectRoot })).resolves.toMatchObject({
      outputRoot,
      pluginId: 'inkstone-annotations',
    });
    await expect(
      readFile(join(outputRoot, '.obsidian', 'plugins', 'inkstone-annotations', 'main.js'), 'utf8'),
    ).resolves.toBe('rebuilt plugin');
  });
});

async function makeProjectFixture(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'inkstone-device-hat-'));
  temporaryRoots.push(projectRoot);

  await mkdir(join(projectRoot, 'test-fixtures', 'vault'), { recursive: true });
  await mkdir(
    join(projectRoot, 'test-fixtures', 'vault', '.obsidian-annotations', 'v1', 'notes', 'demo'),
    { recursive: true },
  );
  await Promise.all([
    writeFile(join(projectRoot, 'main.js'), 'built plugin', 'utf8'),
    writeFile(join(projectRoot, 'manifest.json'), '{"id":"inkstone-annotations"}\n', 'utf8'),
    writeFile(join(projectRoot, 'styles.css'), '/* styles */\n', 'utf8'),
    writeFile(
      join(projectRoot, 'test-fixtures', 'vault', 'Supported Markdown.md'),
      '# Supported\n',
    ),
    writeFile(
      join(projectRoot, 'test-fixtures', 'vault', 'Unicode and Repeated Text.md'),
      '# Unicode\n',
    ),
    writeFile(
      join(
        projectRoot,
        'test-fixtures',
        'vault',
        '.obsidian-annotations',
        'v1',
        'notes',
        'demo',
        'meta.json',
      ),
      '{"noteId":"fixture-note"}\n',
    ),
    writeFile(
      join(projectRoot, 'test-fixtures', 'vault', '.obsidian-annotations', 'v1', 'index.json'),
      '{"derived":true}\n',
    ),
  ]);

  return projectRoot;
}
