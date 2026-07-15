import { describe, expect, it } from 'vitest';

import type { TextAnnotationRecord } from './text-annotation';
import { buildCurrentFileAnnotationList } from './current-file-annotation-list';

describe('current-file annotation list', () => {
  it('places problems first, then groups active rows by heading and document position', () => {
    const records = [
      record('later', 80, { body: 'Two-line note preview', heading: 'Details', tags: ['b'] }),
      record('problem', 20, { heading: 'Intro', status: 'unanchored' }),
      record('first', 5, { heading: 'Intro', kind: 'underline', tags: ['a'] }),
      record('middle', 40, { body: 'Note only', heading: 'Details', mark: false }),
    ];

    const model = buildCurrentFileAnnotationList(records);

    expect(model.groups.map((group) => group.title)).toEqual(['Problems', 'Intro', 'Details']);
    expect(model.groups.flatMap((group) => group.rows.map((row) => row.id))).toEqual([
      'problem',
      'first',
      'middle',
      'later',
    ]);
    expect(model.groups[1]?.rows[0]).toMatchObject({
      marker: { kind: 'underline', styleId: 'highlight-sun' },
      notePreview: null,
      quote: 'Quote first',
      status: 'active',
      tags: ['a'],
    });
    expect(model.groups[2]?.rows[0]).toMatchObject({
      marker: { kind: 'note' },
      notePreview: 'Note only',
    });
  });

  it('excludes tombstones and builds 500 compact rows without loading unrelated Vault state', () => {
    const records = Array.from({ length: 501 }, (_, index) =>
      record(`annotation-${index}`, 500 - index, {
        ...(index === 500 ? { deletedAt: '2026-07-14T09:00:00.000Z' } : {}),
        heading: `Section ${Math.floor(index / 100)}`,
      }),
    );

    const startedAt = performance.now();
    const model = buildCurrentFileAnnotationList(records);

    expect(model.total).toBe(500);
    expect(model.groups.flatMap((group) => group.rows)).toHaveLength(500);
    expect(performance.now() - startedAt).toBeLessThan(50);
  });

  it('includes a recent tombstone only inside an explicit Restore window', () => {
    const deleted = record('deleted', 10, {
      deletedAt: '2026-07-15T13:42:00.000Z',
      heading: 'Intro',
    });

    const recoverable = buildCurrentFileAnnotationList([deleted], {
      deletedRestoreWindowMs: 5_000,
      now: '2026-07-15T13:42:04.999Z',
    });
    const expired = buildCurrentFileAnnotationList([deleted], {
      deletedRestoreWindowMs: 5_000,
      now: '2026-07-15T13:42:05.000Z',
    });

    expect(recoverable.groups[0]?.rows[0]).toMatchObject({
      deletedAt: '2026-07-15T13:42:00.000Z',
      id: 'deleted',
      revision: 1,
    });
    expect(expired).toEqual({ groups: [], total: 0 });
  });
});

function record(
  id: string,
  start: number,
  options: {
    readonly body?: string;
    readonly deletedAt?: string;
    readonly heading?: string;
    readonly kind?: 'highlight' | 'underline';
    readonly mark?: boolean;
    readonly status?: TextAnnotationRecord['status'];
    readonly tags?: readonly string[];
  } = {},
): TextAnnotationRecord {
  return {
    ...(options.body === undefined ? {} : { body: options.body }),
    createdAt: '2026-07-14T08:00:00.000Z',
    ...(options.deletedAt === undefined ? {} : { deletedAt: options.deletedAt }),
    filePath: 'Current.md',
    id,
    ...(options.mark === false
      ? {}
      : { mark: { kind: options.kind ?? 'highlight', styleId: 'highlight-sun' } }),
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: options.status ?? 'active',
    tags: options.tags ?? [],
    target: {
      position: { end: start + id.length, start, unit: 'utf16-code-unit' },
      quote: { exact: `Quote ${id}`, prefix: '', suffix: '' },
      scope: { ...(options.heading === undefined ? {} : { headingPath: [options.heading] }) },
    },
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}
