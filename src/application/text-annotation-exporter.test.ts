import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { TextAnnotationRecord } from '../domain/text-annotation';
import {
  collectTextAnnotationExport,
  buildTextAnnotationExportPath,
  chooseUniqueExportPath,
  sortTextAnnotationExportItems,
  streamTextAnnotationExport,
  type TextAnnotationExportItem,
  type TextAnnotationExportFormat,
} from './text-annotation-exporter';

const formats: readonly TextAnnotationExportFormat[] = [
  'markdown-highlight',
  'html-mark',
  'markdown-footnote',
  'markdown-report',
];

describe('text annotation exporter', () => {
  for (const format of formats) {
    it(`matches the ${format} golden file`, async () => {
      const actual = await collectTextAnnotationExport(sortTextAnnotationExportItems(fixture()), {
        format,
        generatedAt: '2026-07-14T18:00:00.000Z',
        title: '研究 & Review',
      });
      const expected = readFileSync(
        new URL(`../../test-fixtures/exports/golden/${format}.golden`, import.meta.url),
        'utf8',
      );

      expect(actual).toBe(expected);
    });
  }

  it('sorts record, current-file, filtered and whole-Vault scopes deterministically', () => {
    const items = fixture();
    const reversed = [items[1] as TextAnnotationExportItem, items[0] as TextAnnotationExportItem];

    expect(sortTextAnnotationExportItems(reversed).map((item) => item.record.id)).toEqual([
      'highlight-1',
      'underline-1',
    ]);
    expect(sortTextAnnotationExportItems([items[1] as TextAnnotationExportItem])).toHaveLength(1);
  });

  it('exports visible selection text instead of raw presentation markers', async () => {
    const formatted = record({
      displayText: 'Visible formatted text',
      filePath: 'Formatted.md',
      id: 'formatted',
      position: 0,
      quote: '**Visible** ==formatted== text',
    });

    const report = await collectTextAnnotationExport([{ record: formatted }], {
      format: 'markdown-report',
      generatedAt: '2026-07-14T18:00:00.000Z',
    });

    expect(report).toContain('> Visible formatted text');
    expect(report).not.toContain('**Visible** ==formatted== text');
  });

  it('keeps note-only, conflict, unanchored context, overlap, CJK, emoji and special characters', async () => {
    const report = await collectTextAnnotationExport(
      sortTextAnnotationExportItems([
        ...fixture(),
        {
          record: record({
            body: 'Only a note',
            filePath: 'Notes/Note only.md',
            id: 'note-only',
            mark: undefined,
            position: 3,
            quote: 'note-only target',
          }),
        },
      ]),
      { format: 'markdown-report', generatedAt: '2026-07-14T18:00:00.000Z' },
    );

    expect(report).toContain('Note only');
    expect(report).toContain('unanchored');
    expect(report).toContain('Conflict: yes');
    expect(report).toContain('Overlap: yes');
    expect(report).toContain('Context before');
    expect(report).toContain('你好 <world> 😀');
    expect(report).not.toContain('```');
  });

  it('streams 20,000 pre-sorted records without buffering the whole export', async () => {
    let consumed = 0;
    function* records(): Generator<TextAnnotationExportItem> {
      for (let position = 0; position < 20_000; position += 1) {
        consumed += 1;
        yield {
          record: record({
            filePath: `Folder/Note-${String(Math.floor(position / 10)).padStart(4, '0')}.md`,
            id: `annotation-${position}`,
            position,
            quote: `quote-${position}`,
          }),
        };
      }
    }

    const stream = streamTextAnnotationExport(records(), {
      format: 'markdown-report',
      generatedAt: '2026-07-14T18:00:00.000Z',
    })[Symbol.asyncIterator]();
    const header = await stream.next();
    expect(header.value).toContain('Inkstone annotation report');
    expect(consumed).toBe(0);

    let chunks = 1;
    while (!(await stream.next()).done) {
      chunks += 1;
    }
    expect(consumed).toBe(20_000);
    expect(chunks).toBeGreaterThan(20_000);
  });

  it('chooses a deterministic unique filename without overwriting an existing export', async () => {
    const occupied = new Set(['Exports/Annotations.md', 'Exports/Annotations 2.md']);

    await expect(
      chooseUniqueExportPath('Exports/Annotations.md', (path) =>
        Promise.resolve(occupied.has(path)),
      ),
    ).resolves.toBe('Exports/Annotations 3.md');
  });

  it('creates a filesystem-safe CJK export name with the correct extension', () => {
    expect(
      buildTextAnnotationExportPath(
        '研究 / A:*? "Review"',
        'html-mark',
        '2026-07-14T18:00:00.000Z',
      ),
    ).toBe('Inkstone Exports/研究 A Review 2026-07-14T18-00-00Z.html');
  });
});

function fixture(): readonly TextAnnotationExportItem[] {
  return [
    {
      overlap: true,
      record: record({
        body: '想法 **保留**\n第二行',
        filePath: '研究/A & B.md',
        id: 'highlight-1',
        position: 4,
        quote: '你好 <world> 😀 `code`',
        tags: ['研究', 'review'],
      }),
      styleName: 'Sun',
    },
    {
      conflict: true,
      record: record({
        anchorFailure: { candidateCount: 0, reason: 'not-found' },
        body: 'Needs [repair](unsafe)',
        filePath: '研究/A & B.md',
        id: 'underline-1',
        mark: { kind: 'underline', styleId: 'highlight-violet' },
        position: 40,
        prefix: 'prefix *',
        quote: '可变 [Markdown] & sync',
        status: 'unanchored',
        suffix: ' suffix',
      }),
      styleName: 'Violet',
    },
  ];
}

function record(input: {
  readonly anchorFailure?: TextAnnotationRecord['anchorFailure'];
  readonly body?: string;
  readonly displayText?: string;
  readonly filePath: string;
  readonly id: string;
  readonly mark?: TextAnnotationRecord['mark'];
  readonly position: number;
  readonly prefix?: string;
  readonly quote: string;
  readonly status?: TextAnnotationRecord['status'];
  readonly suffix?: string;
  readonly tags?: readonly string[];
}): TextAnnotationRecord {
  return {
    ...(input.anchorFailure === undefined ? {} : { anchorFailure: input.anchorFailure }),
    ...(input.body === undefined ? {} : { body: input.body }),
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: input.filePath,
    id: input.id,
    ...(input.mark === undefined
      ? input.id === 'note-only'
        ? {}
        : { mark: { kind: 'highlight' as const, styleId: 'highlight-sun' } }
      : { mark: input.mark }),
    noteId: `note-${input.filePath}`,
    revision: 2,
    schemaVersion: 1,
    status: input.status ?? 'active',
    tags: input.tags ?? [],
    target: {
      ...(input.displayText === undefined ? {} : { displayText: input.displayText }),
      position: {
        end: input.position + input.quote.length,
        start: input.position,
        unit: 'utf16-code-unit',
      },
      quote: {
        exact: input.quote,
        prefix: input.prefix ?? '',
        suffix: input.suffix ?? '',
      },
      scope: { headingPath: ['Heading *one*'] },
    },
    updatedAt: '2026-07-14T09:00:00.000Z',
  };
}
