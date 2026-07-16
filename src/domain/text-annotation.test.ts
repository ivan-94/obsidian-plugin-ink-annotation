import { describe, expect, it } from 'vitest';

import {
  annotationTargetText,
  decodeTextAnnotationRecord,
  encodeTextAnnotationRecord,
  type TextAnnotationRecord,
} from './text-annotation';

describe('text annotation schema v1', () => {
  it('round-trips a compound UTF-16 record and rejects an empty active annotation', () => {
    const record: TextAnnotationRecord = {
      createdAt: '2026-07-14T08:00:00.000Z',
      filePath: '研究/Anchor.md',
      id: 'annotation-1',
      mark: { kind: 'highlight', styleId: 'highlight-yellow' },
      noteId: 'note-1',
      revision: 1,
      schemaVersion: 1,
      status: 'active',
      tags: [],
      target: {
        displayText: '😀 compound',
        position: { end: 13, start: 2, unit: 'utf16-code-unit' },
        quote: { exact: '😀 compound', prefix: 'A ', suffix: ' anchor' },
        scope: { headingPath: ['Anchor'], sectionEndLine: 3, sectionStartLine: 2 },
        sourceRevision: 'a'.repeat(64),
      },
      updatedAt: '2026-07-14T08:00:00.000Z',
    };

    expect(decodeTextAnnotationRecord(encodeTextAnnotationRecord(record))).toEqual(record);
    expect(annotationTargetText(record.target)).toBe('😀 compound');
    const { mark: _mark, ...withoutMark } = record;
    void _mark;
    expect(() => encodeTextAnnotationRecord({ ...withoutMark, tags: [] })).toThrow(
      /active annotation/u,
    );
  });

  it.each([
    {
      body: undefined,
      mark: { kind: 'highlight' as const, styleId: 'highlight-sun' },
      name: 'highlight-only',
    },
    {
      body: undefined,
      mark: { kind: 'underline' as const, styleId: 'highlight-sun' },
      name: 'underline-only',
    },
    { body: 'A note.', mark: undefined, name: 'note-only' },
    {
      body: 'A note.',
      mark: { kind: 'highlight' as const, styleId: 'highlight-mint' },
      name: 'highlight+note',
    },
    {
      body: 'A note.',
      mark: { kind: 'underline' as const, styleId: 'highlight-rose' },
      name: 'underline+note',
    },
  ])('round-trips $name without changing the compound target', ({ body, mark }) => {
    const record: TextAnnotationRecord = {
      ...(body === undefined ? {} : { body }),
      createdAt: '2026-07-14T08:00:00.000Z',
      filePath: 'Combinations.md',
      id: 'annotation-combination',
      ...(mark === undefined ? {} : { mark }),
      noteId: 'note-1',
      revision: 1,
      schemaVersion: 1,
      status: 'active',
      tags: ['independent-tag'],
      target: {
        position: { end: 9, start: 0, unit: 'utf16-code-unit' },
        quote: { exact: 'selection', prefix: '', suffix: '' },
        scope: {},
      },
      updatedAt: '2026-07-14T08:00:00.000Z',
    };

    expect(decodeTextAnnotationRecord(encodeTextAnnotationRecord(record))).toEqual(record);
  });

  it('fails closed for corrupt and unknown newer records without guessing a migration', () => {
    expect(() => decodeTextAnnotationRecord('{')).toThrow(/valid JSON/u);
    expect(() =>
      decodeTextAnnotationRecord(
        JSON.stringify({
          createdAt: '2026-07-14T08:00:00.000Z',
          filePath: 'Future.md',
          id: 'future',
          noteId: 'note',
          revision: 1,
          schemaVersion: 2,
          status: 'active',
          tags: [],
          target: {
            position: { end: 6, start: 0, unit: 'utf16-code-unit' },
            quote: { exact: 'future', prefix: '', suffix: '' },
            scope: {},
          },
          updatedAt: '2026-07-14T08:00:00.000Z',
        }),
      ),
    ).toThrow('does not match schema version 1');
  });
});
