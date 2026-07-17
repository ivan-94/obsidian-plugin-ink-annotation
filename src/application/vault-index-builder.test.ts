import { describe, expect, it } from 'vitest';

import type { TextAnnotationRecord } from '../domain/text-annotation';
import type { InkSurfaceSummary } from '../domain/ink-surface-summary';
import {
  textRecordToIndexEntry,
  VaultAnnotationIndex,
  type AnnotationIndexEntry,
} from '../domain/vault-annotation-index';
import type { NoteMeta, RepositoryConflict } from '../storage/sidecar-repository';
import { VaultIndexBuilder, type CanonicalVaultAnnotationSource } from './vault-index-builder';

describe('Vault index builder', () => {
  it('rebuilds from canonical notes with bounded concurrency and reports progress', async () => {
    const source = new DelayedCanonicalSource(['A.md', 'B.md', 'C.md']);
    const index = new VaultAnnotationIndex();
    const progress: number[] = [];
    const builder = new VaultIndexBuilder({ index, source });

    const result = await builder.rebuild({
      concurrency: 2,
      onProgress: (value) => progress.push(value.completed),
    });

    expect(result).toEqual({ indexed: 6, issues: [], status: 'committed' });
    expect(source.maximumConcurrentReads).toBe(2);
    expect(progress).toEqual([0, 1, 2, 3]);
    expect(index.snapshot().map((entry) => `${entry.filePath}:${entry.type}`)).toEqual([
      'A.md:highlight',
      'A.md:ink',
      'B.md:highlight',
      'B.md:ink',
      'C.md:highlight',
      'C.md:ink',
    ]);
  });

  it('cancels without replacing the last ready index with a partial build', async () => {
    const source = new DelayedCanonicalSource(['A.md', 'B.md', 'C.md']);
    const index = new VaultAnnotationIndex();
    index.rebuild([
      {
        conflict: false,
        filePath: 'Existing.md',
        id: 'existing',
        noteId: 'existing-note',
        position: 0,
        quote: 'Keep the ready index',
        revision: 1,
        status: 'active',
        tags: [],
        type: 'note',
        updatedAt: '2026-07-14T08:00:00.000Z',
      },
    ]);
    const abort = new AbortController();
    const builder = new VaultIndexBuilder({ index, source });

    await expect(
      builder.rebuild({
        concurrency: 2,
        onProgress: (progress) => {
          if (progress.completed === 1) {
            abort.abort();
          }
        },
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(index.snapshot().map((entry) => entry.filePath)).toEqual(['Existing.md']);
  });

  it('retries instead of replacing a canonical change with an older build snapshot', async () => {
    const original = record('Race.md');
    let current = original;
    let annotationReads = 0;
    let signalFirstReadStarted!: () => void;
    let releaseFirstRead!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => {
      signalFirstReadStarted = resolve;
    });
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const source: CanonicalVaultAnnotationSource = {
      listAnnotations: async () => {
        annotationReads += 1;
        const snapshot = current;
        if (annotationReads === 1) {
          signalFirstReadStarted();
          await firstReadGate;
        }
        return { conflicts: [], issues: [], records: [snapshot] };
      },
      listNotes: () =>
        Promise.resolve({
          issues: [],
          notes: [note('Race.md')],
        }),
      listSurfaceSummaries: () => Promise.resolve([]),
    };
    const index = new VaultAnnotationIndex();
    index.rebuild([textRecordToIndexEntry(original)]);
    const builder = new VaultIndexBuilder({ index, source });

    const rebuilding = builder.rebuild({ concurrency: 1 });
    await firstReadStarted;
    current = {
      ...original,
      revision: 2,
      updatedAt: '2026-07-14T09:00:00.000Z',
    };
    expect(index.upsert(textRecordToIndexEntry(current))).toBe('applied');
    releaseFirstRead();

    await expect(rebuilding).resolves.toEqual({ indexed: 1, issues: [], status: 'committed' });
    expect(annotationReads).toBe(2);
    expect(index.snapshot()).toMatchObject([
      { filePath: 'Race.md', id: 'annotation-Race.md', revision: 2 },
    ]);
  });

  it('keeps the incrementally updated index when every bounded build attempt is superseded', async () => {
    const original = record('Busy.md');
    let current = original;
    let annotationReads = 0;
    const firstReadStarted = deferred();
    const releaseFirstRead = deferred();
    const secondReadStarted = deferred();
    const releaseSecondRead = deferred();
    const starts = [firstReadStarted, secondReadStarted];
    const releases = [releaseFirstRead, releaseSecondRead];
    const source: CanonicalVaultAnnotationSource = {
      listAnnotations: async () => {
        const readIndex = annotationReads;
        annotationReads += 1;
        const snapshot = current;
        starts[readIndex]?.resolve();
        await releases[readIndex]?.promise;
        return { conflicts: [], issues: [], records: [snapshot] };
      },
      listNotes: () =>
        Promise.resolve({
          issues: [],
          notes: [note('Busy.md')],
        }),
      listSurfaceSummaries: () => Promise.resolve([]),
    };
    const index = new VaultAnnotationIndex();
    index.rebuild([textRecordToIndexEntry(original)]);
    const cache = new MemoryIndexCache();
    const builder = new VaultIndexBuilder({ cache, index, source });

    const rebuilding = builder.rebuild({ concurrency: 1 });
    await firstReadStarted.promise;
    current = revision(original, 2);
    expect(index.upsert(textRecordToIndexEntry(current))).toBe('applied');
    releaseFirstRead.resolve();
    await secondReadStarted.promise;
    current = revision(original, 3);
    expect(index.upsert(textRecordToIndexEntry(current))).toBe('applied');
    releaseSecondRead.resolve();

    await expect(rebuilding).resolves.toEqual({ indexed: 1, issues: [], status: 'superseded' });
    expect(annotationReads).toBe(2);
    expect(index.snapshot()).toMatchObject([
      { filePath: 'Busy.md', id: 'annotation-Busy.md', revision: 3 },
    ]);
    expect(cache.saved).toBeNull();
  });

  it('restores a disposable cache and refreshes it only after a complete rebuild', async () => {
    const source = new DelayedCanonicalSource(['Fresh.md']);
    const index = new VaultAnnotationIndex();
    const cache = new MemoryIndexCache();
    const builder = new VaultIndexBuilder({ cache, index, source });

    await expect(builder.restoreCached()).resolves.toBe(1);
    expect(index.snapshot().map((entry) => entry.filePath)).toEqual(['Cached.md']);
    await builder.rebuild();
    expect(cache.saved?.map((entry) => `${entry.filePath}:${entry.type}`)).toEqual([
      'Fresh.md:highlight',
      'Fresh.md:ink',
    ]);
  });

  it('does not index an active Ink surface with no visible strokes', async () => {
    const source = new DelayedCanonicalSource(['Empty.md'], 0);
    const index = new VaultAnnotationIndex();

    await new VaultIndexBuilder({ index, source }).rebuild();

    expect(index.snapshot().map((entry) => entry.type)).toEqual(['highlight']);
  });

  it('excludes missing-source notes from the active Vault index', async () => {
    const source = new DelayedCanonicalSource(
      ['Live.md', 'Deleted.md'],
      2,
      new Set(['Deleted.md']),
    );
    const index = new VaultAnnotationIndex();

    await new VaultIndexBuilder({ index, source }).rebuild();

    expect(index.snapshot().map((entry) => entry.filePath)).toEqual(['Live.md', 'Live.md']);
  });

  it('fails closed when the Markdown source is gone before missing metadata persists', async () => {
    const source = new DelayedCanonicalSource(
      ['Live.md', 'Unpersisted Missing.md'],
      2,
      new Set(),
      new Set(['Unpersisted Missing.md']),
    );
    const index = new VaultAnnotationIndex();

    await new VaultIndexBuilder({ index, source }).rebuild();

    expect(index.snapshot().map((entry) => entry.filePath)).toEqual(['Live.md', 'Live.md']);
  });
});

class MemoryIndexCache {
  saved: readonly AnnotationIndexEntry[] | null = null;

  load(): Promise<{
    readonly entries: readonly AnnotationIndexEntry[];
    readonly generatedAt: string;
  }> {
    return Promise.resolve({
      entries: [
        {
          conflict: false,
          filePath: 'Cached.md',
          id: 'cached',
          noteId: 'cached-note',
          position: 0,
          quote: 'Cached',
          revision: 1,
          status: 'active',
          tags: [],
          type: 'note',
          updatedAt: '2026-07-14T08:00:00.000Z',
        },
      ],
      generatedAt: '2026-07-14T08:00:00.000Z',
    });
  }

  save(entries: readonly AnnotationIndexEntry[]): Promise<void> {
    this.saved = entries;
    return Promise.resolve();
  }
}

class DelayedCanonicalSource implements CanonicalVaultAnnotationSource {
  private activeReads = 0;
  maximumConcurrentReads = 0;

  constructor(
    private readonly paths: readonly string[],
    private readonly inkStrokeCount = 2,
    private readonly missingPaths: ReadonlySet<string> = new Set(),
    private readonly unavailablePaths: ReadonlySet<string> = new Set(),
  ) {}

  isSourceAvailable(filePath: string): boolean {
    return !this.unavailablePaths.has(filePath);
  }

  listAnnotations(filePath: string): Promise<{
    readonly conflicts: readonly RepositoryConflict[];
    readonly issues: readonly [];
    readonly records: readonly TextAnnotationRecord[];
  }> {
    this.activeReads += 1;
    this.maximumConcurrentReads = Math.max(this.maximumConcurrentReads, this.activeReads);
    return new Promise((resolve) => {
      setTimeout(() => {
        this.activeReads -= 1;
        resolve({ conflicts: [], issues: [], records: [record(filePath)] });
      }, 5);
    });
  }

  listNotes(): Promise<{ readonly issues: readonly []; readonly notes: readonly NoteMeta[] }> {
    return Promise.resolve({
      issues: [],
      notes: this.paths.map((filePath, index) => ({
        filePath,
        lastReconciledAt: '2026-07-14T08:00:00.000Z',
        noteId: `note-${index}`,
        pathHash: `hash-${index}`,
        schemaVersion: 1,
        sourceFingerprint: `source-${index}`,
        ...(this.missingPaths.has(filePath) ? { sourceMissingAt: '2026-07-14T09:00:00.000Z' } : {}),
      })),
    });
  }

  listSurfaceSummaries(filePath: string): Promise<readonly InkSurfaceSummary[]> {
    return Promise.resolve([
      {
        conflict: false,
        filePath,
        headingPath: ['Ink'],
        id: `surface-${filePath}`,
        logicalHeight: 800,
        logicalWidth: 960,
        position: 20,
        revision: 1,
        status: 'active',
        strokeCount: this.inkStrokeCount,
        thumbnailSvg: '<svg/>',
        updatedAt: '2026-07-14T08:00:00.000Z',
      },
    ]);
  }
}

function record(filePath: string): TextAnnotationRecord {
  return {
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath,
    id: `annotation-${filePath}`,
    mark: { kind: 'highlight', styleId: 'highlight-sun' },
    noteId: `note-${filePath}`,
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    tags: [],
    target: {
      position: { end: 6, start: 0, unit: 'utf16-code-unit' },
      quote: { exact: 'Target', prefix: '', suffix: '' },
      scope: {},
    },
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}

function note(filePath: string): NoteMeta {
  return {
    filePath,
    lastReconciledAt: '2026-07-14T08:00:00.000Z',
    noteId: `note-${filePath}`,
    pathHash: `hash-${filePath}`,
    schemaVersion: 1,
    sourceFingerprint: `source-${filePath}`,
  };
}

function revision(record: TextAnnotationRecord, nextRevision: number): TextAnnotationRecord {
  return {
    ...record,
    revision: nextRevision,
    updatedAt: `2026-07-14T${String(8 + nextRevision).padStart(2, '0')}:00:00.000Z`,
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}
