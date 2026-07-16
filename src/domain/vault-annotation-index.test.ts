import { describe, expect, it, vi } from 'vitest';

import type { TextAnnotationRecord } from './text-annotation';
import type { InkSurfaceSummary } from './ink-surface-summary';
import {
  VaultAnnotationIndex,
  inkSummaryToIndexEntry,
  textRecordToIndexEntry,
} from './vault-annotation-index';

describe('Vault annotation derived index', () => {
  it('becomes ready only after an explicit rebuild, including an empty rebuild', () => {
    const index = new VaultAnnotationIndex();

    expect(index.isReady()).toBe(false);
    index.rebuild([]);

    expect(index.isReady()).toBe(true);
  });

  it('indexes only list/search fields and performs stable CJK case-insensitive note grouping', () => {
    const index = new VaultAnnotationIndex();
    index.rebuild([
      textRecordToIndexEntry(
        record({
          body: 'Discuss RESILIENT anchors',
          exact: '可变 Markdown',
          filePath: '研究/锚点.md',
          id: 'b',
          position: 20,
          tags: ['架构'],
        }),
        { styleName: 'Focus' },
      ),
      textRecordToIndexEntry(
        record({
          exact: 'Another passage',
          filePath: 'Notes/English.md',
          id: 'a',
          position: 5,
        }),
      ),
    ]);

    const cjk = index.query({ text: '可变' });
    const english = index.query({ text: 'resilient' });

    expect(cjk).toMatchObject({
      groups: [{ filePath: '研究/锚点.md', rows: [{ id: 'b', quote: '可变 Markdown' }] }],
      state: 'ready',
      total: 1,
    });
    expect(english.groups[0]?.rows[0]?.id).toBe('b');
    expect(JSON.stringify(index.snapshot())).not.toContain('target');
    expect(index.snapshot().map((entry) => entry.filePath)).toEqual([
      'Notes/English.md',
      '研究/锚点.md',
    ]);
  });

  it('combines folder, tag, style, type, status, conflict and time filters', () => {
    const index = new VaultAnnotationIndex();
    const candidate = {
      ...textRecordToIndexEntry(
        record({
          exact: '需要修复的下划线',
          filePath: '研究/索引.md',
          id: 'match',
          position: 10,
          tags: ['架构', 'review'],
        }),
        { conflict: true, styleName: 'Focus' },
      ),
      status: 'unanchored' as const,
      type: 'underline' as const,
      updatedAt: '2026-07-14T10:00:00.000Z',
    };
    index.rebuild([
      candidate,
      {
        ...candidate,
        conflict: false,
        filePath: '研究/其他.md',
        id: 'wrong-status',
        status: 'active',
      },
      {
        ...candidate,
        filePath: 'Archive/旧.md',
        id: 'wrong-folder',
      },
    ]);

    const result = index.query({
      filters: {
        conflict: true,
        folders: ['研究'],
        statuses: ['unanchored'],
        styleIds: ['highlight-sun'],
        tags: ['架构', 'review'],
        types: ['underline'],
        updatedAfter: '2026-07-14T09:00:00.000Z',
        updatedBefore: '2026-07-14T11:00:00.000Z',
      },
    });

    expect(result.groups.flatMap((group) => group.rows).map((row) => row.id)).toEqual(['match']);
  });

  it('indexes visible selection text when the source quote contains presentation markers', () => {
    const index = new VaultAnnotationIndex();
    index.rebuild([
      textRecordToIndexEntry(
        record({
          displayText: 'Visible bold text',
          exact: '**Visible bold text**',
          filePath: 'Formatted.md',
          id: 'formatted',
          position: 0,
        }),
      ),
    ]);

    expect(index.query({ text: 'visible bold' })).toMatchObject({
      groups: [{ rows: [{ quote: 'Visible bold text' }] }],
      total: 1,
    });
  });

  it('applies create/update/rename/conflict events without stale overwrite or duplicate paths', () => {
    const index = new VaultAnnotationIndex();
    const original = textRecordToIndexEntry(
      record({ exact: 'Original', filePath: 'Old/Note.md', id: 'same-id', position: 1 }),
    );
    index.rebuild([original]);

    expect(
      index.upsert({
        ...original,
        conflict: true,
        filePath: 'New/Note.md',
        quote: 'Updated',
        revision: 2,
      }),
    ).toBe('applied');
    expect(index.upsert({ ...original, quote: 'Stale' })).toBe('stale');
    expect(index.remove({ expectedRevision: 1, id: original.id, noteId: original.noteId })).toBe(
      'stale',
    );

    expect(index.snapshot()).toMatchObject([
      { conflict: true, filePath: 'New/Note.md', quote: 'Updated', revision: 2 },
    ]);
    expect(index.remove({ expectedRevision: 2, id: original.id, noteId: original.noteId })).toBe(
      'removed',
    );
    expect(index.query()).toMatchObject({ state: 'no-annotations', total: 0 });
  });

  it('indexes searchable Ink metadata without thumbnail SVG or vector points', () => {
    const index = new VaultAnnotationIndex();
    index.rebuild([
      inkSummaryToIndexEntry(
        {
          conflict: true,
          filePath: 'Research/Sketch.md',
          headingPath: ['Architecture', 'Flow'],
          id: 'surface-1',
          logicalHeight: 800,
          logicalWidth: 960,
          position: 42,
          revision: 3,
          status: 'needs-rebase',
          strokeCount: 17,
          thumbnailSvg: '<svg><path data-private-points="true"/></svg>',
          updatedAt: '2026-07-14T11:00:00.000Z',
        } satisfies InkSurfaceSummary,
        'note-sketch',
      ),
    ]);

    expect(index.query({ text: 'architecture flow' })).toMatchObject({
      groups: [
        {
          rows: [
            {
              conflict: true,
              id: 'surface-1',
              ink: { headingPath: ['Architecture', 'Flow'], strokeCount: 17 },
              status: 'needs-rebase',
              type: 'ink',
            },
          ],
        },
      ],
      total: 1,
    });
    expect(index.query({ filters: { types: ['ink'] } }).total).toBe(1);
    expect(index.query({ filters: { statuses: ['needs-rebase'] } }).total).toBe(1);
    expect(JSON.stringify(index.snapshot())).not.toContain('svg');
    expect(JSON.stringify(index.snapshot())).not.toContain('points');
  });

  it('publishes one versioned change for applied mutations only', () => {
    const index = new VaultAnnotationIndex();
    const listener = vi.fn();
    const unsubscribe = index.subscribe(listener);
    const original = textRecordToIndexEntry(
      record({ exact: 'Original', filePath: 'Note.md', id: 'same-id', position: 1 }),
    );

    expect(index.version).toBe(0);
    index.rebuild([original]);
    expect(index.version).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(index.upsert(original)).toBe('unchanged');
    expect(index.remove({ expectedRevision: 99, id: original.id, noteId: original.noteId })).toBe(
      'stale',
    );
    expect(index.version).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(index.upsert({ ...original, quote: 'Updated', revision: 2 })).toBe('applied');
    expect(index.version).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(index.remove({ expectedRevision: 2, id: original.id, noteId: original.noteId })).toBe(
      'removed',
    );
    expect(index.version).toBe(3);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('reuses snapshots, query results and facets until an applied mutation invalidates them', () => {
    const index = new VaultAnnotationIndex();
    const original = textRecordToIndexEntry(
      record({ exact: 'Original', filePath: 'Folder/Note.md', id: 'same-id', position: 1 }),
    );
    index.rebuild([original]);

    const snapshot = index.snapshot();
    const query = index.query({ text: 'original' });
    const facets = index.facets();

    expect(index.snapshot()).toBe(snapshot);
    expect(index.query({ text: 'original' })).toBe(query);
    expect(index.facets()).toBe(facets);
    expect(facets).toMatchObject({
      folders: ['Folder'],
      notes: [{ filePath: 'Folder/Note.md', noteId: 'note-Folder/Note.md' }],
      statuses: ['active'],
      styleIds: ['highlight-sun'],
      styles: [{ id: 'highlight-sun', name: 'highlight-sun' }],
      tags: [],
      types: ['highlight'],
    });

    index.upsert({ ...original, filePath: 'Other/Note.md', revision: 2, tags: ['review'] });

    expect(index.snapshot()).not.toBe(snapshot);
    expect(index.query({ text: 'original' })).not.toBe(query);
    expect(index.facets()).not.toBe(facets);
    expect(index.facets()).toMatchObject({ folders: ['Other'], tags: ['review'] });
  });
});

function record(input: {
  readonly body?: string;
  readonly displayText?: string;
  readonly exact: string;
  readonly filePath: string;
  readonly id: string;
  readonly position: number;
  readonly tags?: readonly string[];
}): TextAnnotationRecord {
  return {
    ...(input.body === undefined ? {} : { body: input.body }),
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: input.filePath,
    id: input.id,
    mark: { kind: 'highlight', styleId: 'highlight-sun' },
    noteId: `note-${input.filePath}`,
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    tags: input.tags ?? [],
    target: {
      ...(input.displayText === undefined ? {} : { displayText: input.displayText }),
      position: {
        end: input.position + input.exact.length,
        start: input.position,
        unit: 'utf16-code-unit',
      },
      quote: { exact: input.exact, prefix: '', suffix: '' },
      scope: {},
    },
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}
