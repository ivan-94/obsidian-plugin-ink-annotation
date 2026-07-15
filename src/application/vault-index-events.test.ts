import { describe, expect, it } from 'vitest';

import type { TextAnnotationRecord } from '../domain/text-annotation';
import type { InkSurfaceRecord } from '../domain/ink-surface';
import { VaultAnnotationIndex, textRecordToIndexEntry } from '../domain/vault-annotation-index';
import {
  applyCanonicalInkSurfaceChanged,
  applyCanonicalRecordChanged,
  applyCanonicalRecordRemoved,
} from './vault-index-events';

describe('Vault index canonical record events', () => {
  it('ignores changes before the lazy index has been initialized', () => {
    const index = new VaultAnnotationIndex();

    expect(applyCanonicalRecordChanged(index, record({ revision: 1 }))).toBe('not-ready');
    expect(index.snapshot()).toEqual([]);
  });

  it('upserts live records and removes tombstones by their previous revision', () => {
    const index = new VaultAnnotationIndex();
    const original = record({ revision: 1 });
    index.rebuild([textRecordToIndexEntry(original)]);

    expect(
      applyCanonicalRecordChanged(index, record({ quote: 'updated', revision: 2 }), () => 'Sun'),
    ).toBe('applied');
    expect(index.snapshot()).toMatchObject([{ quote: 'updated', revision: 2, styleName: 'Sun' }]);
    expect(
      applyCanonicalRecordChanged(
        index,
        record({ deletedAt: '2026-07-14T10:00:00.000Z', revision: 3 }),
      ),
    ).toBe('removed');
    expect(index.snapshot()).toEqual([]);
  });

  it('removes physically deleted drafts only at the indexed revision', () => {
    const index = new VaultAnnotationIndex();
    const draft = record({ revision: 1 });
    index.rebuild([textRecordToIndexEntry(draft)]);

    expect(applyCanonicalRecordRemoved(index, draft)).toBe('removed');
    expect(applyCanonicalRecordRemoved(index, draft)).toBe('missing');
  });

  it('incrementally indexes Ink metadata and removes a surface tombstone without retaining points', () => {
    const index = new VaultAnnotationIndex();
    index.rebuild([]);
    const active = inkSurface({ revision: 1 });

    expect(applyCanonicalInkSurfaceChanged(index, active)).toBe('applied');
    expect(index.snapshot()).toMatchObject([
      {
        id: 'surface-1',
        ink: { headingPath: ['Ink'], strokeCount: 1 },
        noteId: 'note-1',
        type: 'ink',
      },
    ]);
    expect(JSON.stringify(index.snapshot())).not.toContain('pressure');
    expect(
      applyCanonicalInkSurfaceChanged(index, {
        ...active,
        deletedAt: '2026-07-14T10:00:00.000Z',
        revision: 2,
      }),
    ).toBe('removed');
    expect(index.snapshot()).toEqual([]);
  });

  it('removes an Ink index entry when its last visible stroke is erased', () => {
    const index = new VaultAnnotationIndex();
    index.rebuild([]);
    const active = inkSurface({ revision: 1 });
    expect(applyCanonicalInkSurfaceChanged(index, active)).toBe('applied');

    expect(applyCanonicalInkSurfaceChanged(index, { ...active, revision: 2, strokes: [] })).toBe(
      'removed',
    );
    expect(index.snapshot()).toEqual([]);
  });
});

function record(input: {
  readonly deletedAt?: string;
  readonly quote?: string;
  readonly revision: number;
}): TextAnnotationRecord {
  const quote = input.quote ?? 'original';
  return {
    createdAt: '2026-07-14T08:00:00.000Z',
    ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
    filePath: 'Notes/Test.md',
    id: 'annotation-1',
    mark: { kind: 'highlight', styleId: 'highlight-sun' },
    noteId: 'note-1',
    revision: input.revision,
    schemaVersion: 1,
    status: 'active',
    tags: [],
    target: {
      position: { end: quote.length, start: 0, unit: 'utf16-code-unit' },
      quote: { exact: quote, prefix: '', suffix: '' },
      scope: {},
    },
    updatedAt: '2026-07-14T09:00:00.000Z',
  };
}

function inkSurface(input: { readonly revision: number }): InkSurfaceRecord {
  return {
    binding: {
      blockFingerprints: ['block-1'],
      headingPath: ['Ink'],
      sectionFingerprint: 'section-1',
      sourceEnd: 100,
      sourceStart: 20,
    },
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Notes/Test.md',
    id: 'surface-1',
    layout: {
      blockFingerprints: ['block-1'],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 800,
      logicalWidth: 960,
      sourceRevision: 'source-1',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: input.revision,
    schemaVersion: 1,
    status: 'active',
    strokes: [
      {
        color: '#111111',
        id: 'stroke-1',
        points: [
          { pressure: 0.5, time: 0, x: 10, y: 10 },
          { pressure: 0.5, time: 16, x: 20, y: 20 },
        ],
        tool: 'pen',
        width: 2,
      },
    ],
    updatedAt: '2026-07-14T09:00:00.000Z',
  };
}
