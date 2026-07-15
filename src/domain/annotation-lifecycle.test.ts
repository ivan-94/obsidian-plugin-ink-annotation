import { describe, expect, it } from 'vitest';

import type { TextAnnotationRecord } from './text-annotation';
import { restoreTombstone, tombstoneAnnotation } from './annotation-lifecycle';

describe('annotation lifecycle', () => {
  it('writes a reversible tombstone while preserving recoverable annotation content', () => {
    const active = fixture();

    const deleted = tombstoneAnnotation(active, '2026-07-14T09:00:00.000Z');
    const restored = restoreTombstone(deleted, {
      expectedRevision: deleted.revision,
      now: '2026-07-14T09:01:00.000Z',
    });

    expect(deleted).toMatchObject({
      body: active.body,
      deletedAt: '2026-07-14T09:00:00.000Z',
      mark: active.mark,
      revision: 2,
      tags: active.tags,
      target: active.target,
    });
    expect(restored).toEqual({
      ...active,
      revision: 3,
      updatedAt: '2026-07-14T09:01:00.000Z',
    });
  });

  it('rejects stale undo and repeated deletion instead of overwriting a newer revision', () => {
    const deleted = tombstoneAnnotation(fixture(), '2026-07-14T09:00:00.000Z');

    expect(() => tombstoneAnnotation(deleted, '2026-07-14T09:00:01.000Z')).toThrow(
      /already deleted/u,
    );
    expect(() =>
      restoreTombstone(deleted, {
        expectedRevision: deleted.revision - 1,
        now: '2026-07-14T09:01:00.000Z',
      }),
    ).toThrow(/newer revision/u);
  });
});

function fixture(): TextAnnotationRecord {
  return {
    body: 'Preserve me.',
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Lifecycle.md',
    id: 'annotation-1',
    mark: { kind: 'highlight', styleId: 'highlight-sun' },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    tags: ['important'],
    target: {
      position: { end: 12, start: 0, unit: 'utf16-code-unit' },
      quote: { exact: 'Lifecycle me', prefix: '', suffix: '' },
      scope: { headingPath: ['Lifecycle'] },
    },
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}
