import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';

import type { ResolvedHighlight } from '../application/annotation-service';
import type { TextAnnotationRecord } from './text-annotation';
import {
  buildEditorAnnotationProjection,
  mapEditorAnnotationProjection,
} from './editor-annotation-projection';

describe('editor annotation projection', () => {
  it('projects canonical records into stable highlight, underline and note-only ranges', () => {
    const projection = buildEditorAnnotationProjection(
      [
        resolved(record('highlight', 3, 8, { kind: 'highlight', styleId: 'sun' })),
        resolved(record('underline', 10, 15, { kind: 'underline', styleId: 'mint' })),
        resolved(record('note-only', 18, 22, undefined, 'Remember this.')),
      ],
      [{ from: 0, to: 30 }],
      30,
    );

    expect(projection.marks).toEqual([
      {
        annotationId: 'highlight',
        annotationIds: ['highlight'],
        from: 3,
        kind: 'highlight',
        styleId: 'sun',
        to: 8,
      },
      {
        annotationId: 'underline',
        annotationIds: ['underline'],
        from: 10,
        kind: 'underline',
        styleId: 'mint',
        to: 15,
      },
    ]);
    expect(projection.noteAnchors).toEqual([
      { annotationId: 'note-only', offset: 18, quoteEnd: 22 },
    ]);
  });

  it('uses the same deterministic overlap semantics as Reading View', () => {
    const projection = buildEditorAnnotationProjection(
      [
        resolved(record('wide', 0, 10, { kind: 'highlight', styleId: 'sun' })),
        resolved(record('specific', 4, 8, { kind: 'highlight', styleId: 'mint' })),
        resolved(record('underline', 6, 12, { kind: 'underline', styleId: 'sky' })),
      ],
      [{ from: 0, to: 20 }],
      20,
    );

    expect(projection.marks).toEqual([
      expect.objectContaining({ annotationId: 'wide', annotationIds: ['wide'], from: 0, to: 4 }),
      expect.objectContaining({
        annotationId: 'specific',
        annotationIds: ['specific', 'wide'],
        from: 4,
        to: 6,
      }),
      expect.objectContaining({
        annotationId: 'specific',
        annotationIds: ['specific', 'underline', 'wide'],
        from: 6,
        to: 8,
        underlineStyleId: 'sky',
      }),
      expect.objectContaining({
        annotationId: 'wide',
        annotationIds: ['underline', 'wide'],
        from: 8,
        to: 10,
        underlineStyleId: 'sky',
      }),
      expect.objectContaining({
        annotationId: 'underline',
        annotationIds: ['underline'],
        from: 10,
        kind: 'underline',
        to: 12,
      }),
    ]);
  });

  it('keeps only annotations intersecting visible ranges in a large document', () => {
    const projection = buildEditorAnnotationProjection(
      [
        resolved(record('before', 100, 110, { kind: 'highlight', styleId: 'sun' })),
        resolved(record('crosses', 990, 1_010, { kind: 'highlight', styleId: 'sun' })),
        resolved(record('visible', 1_050, 1_060, { kind: 'underline', styleId: 'mint' })),
        resolved(record('after', 2_000, 2_010, { kind: 'highlight', styleId: 'sun' })),
      ],
      [{ from: 1_000, to: 1_100 }],
      200_000,
    );

    expect(projection.marks.map((mark) => mark.annotationId)).toEqual(['crosses', 'visible']);
    expect(projection.marks[0]).toMatchObject({ from: 990, to: 1_010 });
  });

  it('rebuilds from disjoint scroll/fold viewport ranges without decorating hidden records', () => {
    const resolvedRecords = [
      resolved(record('first', 10, 20, { kind: 'highlight', styleId: 'sun' })),
      resolved(record('folded', 250, 260, { kind: 'highlight', styleId: 'sun' })),
      resolved(record('second', 510, 520, { kind: 'highlight', styleId: 'sun' })),
    ];

    const beforeScroll = buildEditorAnnotationProjection(
      resolvedRecords,
      [
        { from: 0, to: 100 },
        { from: 500, to: 600 },
      ],
      1_000,
    );
    const afterScroll = buildEditorAnnotationProjection(
      resolvedRecords,
      [{ from: 200, to: 300 }],
      1_000,
    );

    expect(beforeScroll.marks.map((mark) => mark.annotationId)).toEqual(['first', 'second']);
    expect(afterScroll.marks.map((mark) => mark.annotationId)).toEqual(['folded']);
  });

  it('maps transient positions through insertions and deletions without mutating canonical data', () => {
    const canonical = record('stable-id', 5, 10, { kind: 'highlight', styleId: 'sun' });
    const projection = buildEditorAnnotationProjection(
      [resolved(canonical)],
      [{ from: 0, to: 20 }],
      20,
    );

    const inserted = mapEditorAnnotationProjection(projection, {
      mapPos(position) {
        return position >= 5 ? position + 3 : position;
      },
    });
    const deleted = mapEditorAnnotationProjection(inserted, {
      mapPos(position) {
        return position <= 6 ? position : Math.max(6, position - 5);
      },
    });

    expect(inserted.marks[0]).toMatchObject({ annotationId: 'stable-id', from: 8, to: 13 });
    expect(deleted.marks[0]).toMatchObject({ annotationId: 'stable-id', from: 6, to: 8 });
    expect(canonical.target.position).toEqual({ end: 10, start: 5, unit: 'utf16-code-unit' });
    expect(canonical.target.quote.exact).toBe('xxxxx');
  });

  it('drops a collapsed transient mark so deleted text is never rebound silently', () => {
    const projection = buildEditorAnnotationProjection(
      [resolved(record('deleted', 5, 10, { kind: 'highlight', styleId: 'sun' }))],
      [{ from: 0, to: 20 }],
      20,
    );

    const mapped = mapEditorAnnotationProjection(projection, { mapPos: () => 5 });

    expect(mapped.marks).toEqual([]);
  });

  it('maps replace, undo and redo transactions while canonical quote/context stays immutable', () => {
    const canonical = record('history', 6, 10, { kind: 'highlight', styleId: 'sun' });
    const initial = buildEditorAnnotationProjection(
      [resolved(canonical)],
      [{ from: 0, to: 20 }],
      20,
    );
    const state = EditorState.create({ doc: 'Hello mark and more' });
    const replacement = state.update({ changes: { from: 0, insert: 'Hi ' } });
    const afterReplace = mapEditorAnnotationProjection(initial, replacement.changes);
    const undoChanges = replacement.changes.invert(state.doc);
    const afterUndo = mapEditorAnnotationProjection(afterReplace, undoChanges);
    const redoChanges = undoChanges.invert(replacement.state.doc);
    const afterRedo = mapEditorAnnotationProjection(afterUndo, redoChanges);

    expect(afterReplace.marks[0]).toMatchObject({ from: 9, to: 13 });
    expect(afterUndo.marks[0]).toMatchObject({ from: 6, to: 10 });
    expect(afterRedo.marks[0]).toMatchObject({ from: 9, to: 13 });
    expect(canonical.target.quote).toEqual({ exact: 'xxxx', prefix: '', suffix: '' });
  });

  it('rejects invalid or out-of-bounds resolved ranges', () => {
    const invalid = resolved(record('invalid', 2, 9, { kind: 'highlight', styleId: 'sun' }));
    const result = buildEditorAnnotationProjection(
      [{ ...invalid, end: 90 }],
      [{ from: 0, to: 10 }],
      10,
    );

    expect(result).toEqual({ marks: [], noteAnchors: [] });
  });
});

function resolved(record: TextAnnotationRecord): ResolvedHighlight {
  return {
    end: record.target.position.end,
    record,
    start: record.target.position.start,
  };
}

function record(
  id: string,
  start: number,
  end: number,
  mark: TextAnnotationRecord['mark'],
  body?: string,
): TextAnnotationRecord {
  return {
    ...(body === undefined ? {} : { body }),
    createdAt: '2026-07-14T00:00:00.000Z',
    filePath: 'Live Preview.md',
    id,
    ...(mark === undefined ? {} : { mark }),
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    tags: [],
    target: {
      position: { end, start, unit: 'utf16-code-unit' },
      quote: { exact: 'x'.repeat(end - start), prefix: '', suffix: '' },
      scope: {},
    },
    updatedAt: '2026-07-14T00:00:00.000Z',
  };
}
