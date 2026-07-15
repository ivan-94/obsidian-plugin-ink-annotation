import { describe, expect, it } from 'vitest';

import type { TextAnnotationRecord, TextAnnotationTarget } from './text-annotation';
import { confirmReattachment, previewReattachment } from './annotation-reattachment';

describe('annotation reattachment', () => {
  it('requires an explicit preview before replacing the canonical target', () => {
    const record = unanchoredFixture();
    const replacement = target('replacement phrase', 50);

    const candidate = previewReattachment(record, replacement);

    expect(candidate).toEqual({
      annotationId: record.id,
      baseRevision: record.revision,
      contextPreview: 'before replacement phrase after',
      target: replacement,
    });
    expect(record.target.quote.exact).toBe('original phrase');

    const repaired = confirmReattachment(record, candidate, '2026-07-14T10:00:00.000Z');
    expect(repaired).toMatchObject({
      id: record.id,
      revision: record.revision + 1,
      status: 'active',
      target: { quote: { exact: 'replacement phrase' } },
    });
    expect(repaired.anchorFailure).toBeUndefined();
    expect(repaired.body).toBe(record.body);
    expect(repaired.tags).toEqual(record.tags);
  });

  it('rejects stale or cross-record confirmation and leaves the old target untouched', () => {
    const record = unanchoredFixture();
    const candidate = previewReattachment(record, target('replacement phrase', 50));

    expect(() =>
      confirmReattachment({ ...record, revision: record.revision + 1 }, candidate, 'later'),
    ).toThrow(/newer revision/u);
    expect(() =>
      confirmReattachment(record, { ...candidate, annotationId: 'another' }, 'later'),
    ).toThrow(/different annotation/u);
    expect(record.target.quote.exact).toBe('original phrase');
  });
});

function unanchoredFixture(): TextAnnotationRecord {
  return {
    anchorFailure: { candidateCount: 0, reason: 'not-found' },
    body: 'Keep note content.',
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Repair.md',
    id: 'annotation-1',
    mark: { kind: 'highlight', styleId: 'highlight-sun' },
    noteId: 'note-1',
    revision: 3,
    schemaVersion: 1,
    status: 'unanchored',
    tags: ['repair'],
    target: target('original phrase', 10),
    updatedAt: '2026-07-14T09:00:00.000Z',
  };
}

function target(exact: string, start: number): TextAnnotationTarget {
  return {
    position: { end: start + exact.length, start, unit: 'utf16-code-unit' },
    quote: { exact, prefix: 'before ', suffix: ' after' },
    scope: { headingPath: ['Repair'] },
  };
}
