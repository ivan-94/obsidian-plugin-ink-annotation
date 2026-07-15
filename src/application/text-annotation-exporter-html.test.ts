// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import type { TextAnnotationRecord } from '../domain/text-annotation';
import { collectTextAnnotationExport } from './text-annotation-exporter';

describe('HTML annotation export', () => {
  it('parses as a standalone document and escapes executable annotation text', async () => {
    const record: TextAnnotationRecord = {
      body: '<img src=x onerror=alert(1)>',
      createdAt: '2026-07-14T08:00:00.000Z',
      filePath: '安全/HTML.md',
      id: 'html-escape',
      mark: { kind: 'highlight', styleId: 'highlight-sun' },
      noteId: 'note-html',
      revision: 1,
      schemaVersion: 1,
      status: 'active',
      tags: ['<script>'],
      target: {
        position: { end: 25, start: 0, unit: 'utf16-code-unit' },
        quote: { exact: '<script>alert(1)</script>', prefix: '', suffix: '' },
        scope: {},
      },
      updatedAt: '2026-07-14T09:00:00.000Z',
    };
    const html = await collectTextAnnotationExport([{ record }], {
      format: 'html-mark',
      generatedAt: '2026-07-14T18:00:00.000Z',
    });
    const parsed = new DOMParser().parseFromString(html, 'text/html');

    expect(parsed.querySelectorAll('article')).toHaveLength(1);
    expect(parsed.querySelector('mark')?.textContent).toBe('<script>alert(1)</script>');
    expect(parsed.querySelector('script')).toBeNull();
    expect(parsed.querySelector('section img')).toBeNull();
    expect(parsed.querySelector('section')?.textContent).toContain('<img src=x');
  });
});
