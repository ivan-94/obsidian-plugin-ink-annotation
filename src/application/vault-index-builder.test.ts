import { describe, expect, it } from 'vitest';

import type { TextAnnotationRecord } from '../domain/text-annotation';
import type { InkSurfaceSummary } from '../domain/ink-surface-summary';
import { VaultAnnotationIndex, type AnnotationIndexEntry } from '../domain/vault-annotation-index';
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

    expect(result).toEqual({ indexed: 6, issues: [] });
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
  ) {}

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
