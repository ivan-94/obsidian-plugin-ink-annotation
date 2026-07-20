import { describe, expect, it, vi } from 'vitest';

import type { TextAnnotationRecord } from '../domain/text-annotation';
import type { InkSurfaceRecord } from '../domain/ink-surface';
import { summarizeInkSurface, type InkSurfaceSummary } from '../domain/ink-surface-summary';
import { VaultAnnotationIndex, textRecordToIndexEntry } from '../domain/vault-annotation-index';
import {
  CanonicalInkSurfaceProjectionCoordinator,
  applyCanonicalInkSurfaceSummaries,
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

  it('removes a live text projection that is multiple revisions behind its tombstone', () => {
    const index = new VaultAnnotationIndex();
    index.rebuild([textRecordToIndexEntry(record({ revision: 1 }))]);

    expect(
      applyCanonicalRecordChanged(
        index,
        record({ deletedAt: '2026-07-14T10:00:00.000Z', revision: 4 }),
      ),
    ).toBe('removed');
    expect(index.snapshot()).toEqual([]);
  });

  it.each([4, 5])(
    'preserves a live text projection at revision %s when a revision 4 tombstone arrives',
    (projectedRevision) => {
      const index = new VaultAnnotationIndex();
      index.rebuild([textRecordToIndexEntry(record({ revision: projectedRevision }))]);

      expect(
        applyCanonicalRecordChanged(
          index,
          record({ deletedAt: '2026-07-14T10:00:00.000Z', revision: 4 }),
        ),
      ).toBe('stale');
      expect(index.snapshot()).toMatchObject([{ revision: projectedRevision }]);
    },
  );

  it('removes physically deleted drafts only at the indexed revision', () => {
    const index = new VaultAnnotationIndex();
    const draft = record({ revision: 1 });
    index.rebuild([textRecordToIndexEntry(draft)]);

    expect(applyCanonicalRecordRemoved(index, draft)).toBe('removed');
    expect(applyCanonicalRecordRemoved(index, draft)).toBe('missing');
  });

  it('removes a draft projection that is multiple revisions behind a physically removed record', () => {
    const index = new VaultAnnotationIndex();
    index.rebuild([textRecordToIndexEntry(record({ revision: 1 }))]);

    expect(applyCanonicalRecordRemoved(index, record({ revision: 4 }))).toBe('removed');
    expect(index.snapshot()).toEqual([]);
  });

  it('projects one authoritative note-level Ink summary set without retaining points', () => {
    const index = new VaultAnnotationIndex();
    index.rebuild([]);
    const active = inkSurface({ revision: 1 });
    const summary = summarizeInkSurface(active);

    expect(
      applyCanonicalInkSurfaceSummaries(index, {
        filePath: active.filePath,
        noteId: active.noteId,
        summaries: [summary],
      }),
    ).toBe('applied');
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
      applyCanonicalInkSurfaceSummaries(index, {
        filePath: active.filePath,
        noteId: active.noteId,
        summaries: [
          {
            ...summary,
            deletedAt: '2026-07-14T10:00:00.000Z',
            revision: 2,
          },
        ],
      }),
    ).toBe('removed');
    expect(index.snapshot()).toEqual([]);
  });

  it('removes a live Ink projection that is multiple revisions behind its tombstone', () => {
    const index = new VaultAnnotationIndex();
    index.rebuild([]);
    const active = inkSurface({ revision: 1 });
    const summary = summarizeInkSurface(active);
    expect(
      applyCanonicalInkSurfaceSummaries(index, {
        filePath: active.filePath,
        noteId: active.noteId,
        summaries: [summary],
      }),
    ).toBe('applied');

    expect(
      applyCanonicalInkSurfaceSummaries(index, {
        filePath: active.filePath,
        noteId: active.noteId,
        summaries: [
          {
            ...summary,
            deletedAt: '2026-07-14T10:00:00.000Z',
            revision: 4,
          },
        ],
      }),
    ).toBe('removed');
    expect(index.snapshot()).toEqual([]);
  });

  it.each([4, 5])(
    'preserves a live Ink projection at revision %s when a revision 4 tombstone arrives',
    (projectedRevision) => {
      const index = new VaultAnnotationIndex();
      index.rebuild([]);
      const active = inkSurface({ revision: projectedRevision });
      expect(
        applyCanonicalInkSurfaceSummaries(index, {
          filePath: active.filePath,
          noteId: active.noteId,
          summaries: [summarizeInkSurface(active)],
        }),
      ).toBe('applied');

      expect(
        applyCanonicalInkSurfaceSummaries(index, {
          filePath: active.filePath,
          noteId: active.noteId,
          summaries: [
            {
              ...summarizeInkSurface(inkSurface({ revision: 4 })),
              deletedAt: '2026-07-14T10:00:00.000Z',
            },
          ],
        }),
      ).toBe('stale');
      expect(index.snapshot()).toMatchObject([{ revision: projectedRevision }]);
    },
  );

  it('removes an Ink index entry when its last visible stroke is erased', () => {
    const index = new VaultAnnotationIndex();
    index.rebuild([]);
    const active = inkSurface({ revision: 1 });
    expect(
      applyCanonicalInkSurfaceSummaries(index, {
        filePath: active.filePath,
        noteId: active.noteId,
        summaries: [summarizeInkSurface(active)],
      }),
    ).toBe('applied');

    expect(
      applyCanonicalInkSurfaceSummaries(index, {
        filePath: active.filePath,
        noteId: active.noteId,
        summaries: [summarizeInkSurface({ ...active, revision: 2, strokes: [] })],
      }),
    ).toBe('removed');
    expect(index.snapshot()).toEqual([]);
  });

  it('loads joined note summaries before updating the index and realtime summary consumer', async () => {
    const index = new VaultAnnotationIndex();
    index.rebuild([]);
    const changed = inkSurface({ revision: 2 });
    const top = {
      ...summarizeInkSurface(changed),
      thumbnailSvg: '<svg data-ink-geometry-digest="joined-geometry"></svg>',
    };
    const bottom: InkSurfaceSummary = {
      ...top,
      id: 'surface-2',
      position: 120,
    };
    const applied: (readonly InkSurfaceSummary[])[] = [];
    const coordinator = new CanonicalInkSurfaceProjectionCoordinator({
      applySummaries: (_filePath, summaries) => applied.push(summaries),
      index,
      listSurfaceSummaries: () => Promise.resolve([top, bottom]),
    });

    await expect(coordinator.refresh(changed)).resolves.toBe('applied');

    expect(applied).toEqual([[top, bottom]]);
    expect(applied[0]?.every(({ thumbnailSvg }) => thumbnailSvg.includes('joined-geometry'))).toBe(
      true,
    );
    expect(index.snapshot()).toMatchObject([
      { id: 'surface-1', revision: 2 },
      { id: 'surface-2', revision: 2 },
    ]);
  });

  it('drops an older note-summary read when a newer canonical mutation completes first', async () => {
    const index = new VaultAnnotationIndex();
    index.rebuild([]);
    const first = deferred<readonly InkSurfaceSummary[]>();
    const second = deferred<readonly InkSurfaceSummary[]>();
    const changed = inkSurface({ revision: 1 });
    const newest = {
      ...summarizeInkSurface({ ...changed, revision: 2 }),
      thumbnailSvg: '<svg data-ink-geometry-digest="newest"></svg>',
    };
    const applied: (readonly InkSurfaceSummary[])[] = [];
    const listSurfaceSummaries = vi
      .fn<() => Promise<readonly InkSurfaceSummary[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const coordinator = new CanonicalInkSurfaceProjectionCoordinator({
      applySummaries: (_filePath, summaries) => applied.push(summaries),
      index,
      listSurfaceSummaries,
    });

    const olderRefresh = coordinator.refresh(changed);
    await Promise.resolve();
    const newerChanged: InkSurfaceRecord = { ...changed, revision: 2 };
    const newerRefresh = coordinator.refresh(newerChanged);
    second.resolve([newest]);
    await expect(newerRefresh).resolves.toBe('applied');
    first.resolve([summarizeInkSurface(changed)]);

    await expect(olderRefresh).resolves.toBe('superseded');
    expect(applied).toEqual([[newest]]);
    expect(index.snapshot()).toMatchObject([{ id: 'surface-1', revision: 2 }]);
  });

  it('coalesces one synchronous multi-surface commit into one note-summary reload', async () => {
    const index = new VaultAnnotationIndex();
    index.rebuild([]);
    const changed = inkSurface({ revision: 2 });
    const summary = summarizeInkSurface(changed);
    const listSurfaceSummaries = vi.fn(() => Promise.resolve([summary]));
    const coordinator = new CanonicalInkSurfaceProjectionCoordinator({
      index,
      listSurfaceSummaries,
    });

    const results = await Promise.all(
      Array.from({ length: 30 }, () => coordinator.refresh(changed)),
    );

    expect(listSurfaceSummaries).toHaveBeenCalledOnce();
    expect(results.filter((result) => result === 'applied')).toHaveLength(1);
    expect(results.filter((result) => result === 'superseded')).toHaveLength(29);
  });

  it('keeps the previous projections when a joined-summary reload fails', async () => {
    const index = new VaultAnnotationIndex();
    const changed = inkSurface({ revision: 1 });
    const initial = summarizeInkSurface(changed);
    index.rebuild([]);
    applyCanonicalInkSurfaceSummaries(index, {
      filePath: changed.filePath,
      noteId: changed.noteId,
      summaries: [initial],
    });
    const applied: (readonly InkSurfaceSummary[])[] = [];
    const coordinator = new CanonicalInkSurfaceProjectionCoordinator({
      applySummaries: (_filePath, summaries) => applied.push(summaries),
      index,
      listSurfaceSummaries: () => Promise.reject(new Error('summary unavailable')),
    });

    const newerChanged: InkSurfaceRecord = { ...changed, revision: 2 };
    await expect(coordinator.refresh(newerChanged)).rejects.toThrow('summary unavailable');

    expect(applied).toEqual([]);
    expect(index.snapshot()).toMatchObject([{ id: 'surface-1', revision: 1 }]);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

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
