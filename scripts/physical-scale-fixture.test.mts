import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { decodeTextAnnotationRecord } from '../src/domain/text-annotation';
import { preparePhysicalScaleFixture } from './physical-scale-fixture';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('physical scale fixture', () => {
  it('writes position-valid records through the production codec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-physical-scale-test-'));
    roots.push(root);
    const longSource = `# HAT Long 200k\n\n${Array.from(
      { length: 8 },
      (_, index) =>
        `Paragraph ${index}: Inkstone long document selectable text 中文性能观察 stable markdown block.`,
    ).join('\n\n')}\n`;
    await writeFile(join(root, 'HAT Long 200k.md'), longSource, 'utf8');

    const result = await preparePhysicalScaleFixture({
      longTargetCount: 4,
      scaleNoteCount: 2,
      scaleRecordsPerNote: 3,
      vaultRoot: root,
    });

    expect(result).toMatchObject({
      canonicalFiles: 13,
      longDocument: { records: 4 },
      scaleVault: { notes: 2, records: 6 },
      totalRecords: 10,
    });
    const notesRoot = join(root, '.obsidian-annotations/v1/notes');
    const noteDirectories = await readdir(notesRoot);
    expect(noteDirectories).toHaveLength(3);
    for (const directory of noteDirectories) {
      const meta = JSON.parse(await readFile(join(notesRoot, directory, 'meta.json'), 'utf8')) as {
        filePath: string;
      };
      const source = await readFile(join(root, meta.filePath), 'utf8');
      const annotations = await readdir(join(notesRoot, directory, 'annotations'));
      for (const annotation of annotations) {
        const record = decodeTextAnnotationRecord(
          await readFile(join(notesRoot, directory, 'annotations', annotation), 'utf8'),
        );
        expect(source.slice(record.target.position.start, record.target.position.end)).toBe(
          record.target.quote.exact,
        );
      }
    }
  });

  it('refuses to overwrite existing canonical data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkstone-physical-scale-test-'));
    roots.push(root);
    await writeFile(join(root, 'HAT Long 200k.md'), '# HAT Long 200k\n', 'utf8');
    await mkdir(join(root, '.obsidian-annotations/v1/notes'), { recursive: true });
    await writeFile(join(root, '.obsidian-annotations/v1/notes/existing'), 'owned', 'utf8');

    await expect(
      preparePhysicalScaleFixture({ longTargetCount: 1, vaultRoot: root }),
    ).rejects.toThrow('requires an empty directory');
  });
});
