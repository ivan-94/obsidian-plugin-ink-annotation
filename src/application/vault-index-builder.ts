import {
  textRecordToIndexEntry,
  type AnnotationIndexEntry,
  type VaultAnnotationIndex,
} from '../domain/vault-annotation-index';
import type { NoteMeta, RepositoryConflict, RepositoryIssue } from '../storage/sidecar-repository';
import type { TextAnnotationRecord } from '../domain/text-annotation';
import type { InkSurfaceSummary } from '../domain/ink-surface-summary';
import type { SnapshotAnnotationSummary } from '../domain/snapshot-annotation-summary';
import {
  inkSummaryToIndexEntry,
  snapshotSummaryToIndexEntry,
} from '../domain/vault-annotation-index';

export interface CanonicalVaultAnnotationSource {
  isSourceAvailable?(filePath: string): boolean;
  listAnnotations(filePath: string): Promise<{
    readonly conflicts: readonly RepositoryConflict[];
    readonly issues: readonly RepositoryIssue[];
    readonly records: readonly TextAnnotationRecord[];
  }>;
  listNotes(): Promise<{
    readonly issues: readonly RepositoryIssue[];
    readonly notes: readonly NoteMeta[];
  }>;
  listSnapshotSummaries(filePath: string): Promise<readonly SnapshotAnnotationSummary[]>;
  listSurfaceSummaries(filePath: string): Promise<readonly InkSurfaceSummary[]>;
}

export interface VaultIndexCachePort {
  load(): Promise<{
    readonly entries: readonly AnnotationIndexEntry[];
    readonly generatedAt: string;
  } | null>;
  save(entries: readonly AnnotationIndexEntry[], generatedAt: string): Promise<void>;
}

export interface VaultIndexRebuildResult {
  readonly indexed: number;
  readonly issues: readonly RepositoryIssue[];
  readonly status: 'committed' | 'superseded';
}

const MAX_REBUILD_ATTEMPTS = 2;

export class VaultIndexBuilder {
  private readonly index: VaultAnnotationIndex;
  private readonly cache: VaultIndexCachePort | undefined;
  private readonly now: () => string;
  private readonly onCacheIssue: (error: unknown) => void;
  private readonly source: CanonicalVaultAnnotationSource;
  private readonly styleName: (styleId: string) => string | undefined;

  constructor(input: {
    readonly index: VaultAnnotationIndex;
    readonly cache?: VaultIndexCachePort;
    readonly now?: () => string;
    readonly onCacheIssue?: (error: unknown) => void;
    readonly source: CanonicalVaultAnnotationSource;
    readonly styleName?: (styleId: string) => string | undefined;
  }) {
    this.index = input.index;
    this.cache = input.cache;
    this.now = input.now ?? (() => new Date().toISOString());
    this.onCacheIssue = input.onCacheIssue ?? (() => undefined);
    this.source = input.source;
    this.styleName = input.styleName ?? (() => undefined);
  }

  async restoreCached(): Promise<number> {
    const cached = await this.cache?.load();
    if (cached === null || cached === undefined) {
      return 0;
    }
    this.index.rebuild(cached.entries);
    return cached.entries.length;
  }

  async rebuild(
    input: {
      readonly concurrency?: number;
      readonly onProgress?: (progress: {
        readonly completed: number;
        readonly total: number;
      }) => void;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<VaultIndexRebuildResult> {
    const concurrency = input.concurrency ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new Error('Vault index concurrency must be an integer between 1 and 32.');
    }
    for (let attempt = 0; attempt < MAX_REBUILD_ATTEMPTS; attempt += 1) {
      throwIfAborted(input.signal);
      const startVersion = this.index.isReady() ? this.index.version : null;
      const discovered = await this.source.listNotes();
      const notes = discovered.notes
        .filter(
          (note) =>
            note.sourceMissingAt === undefined &&
            (this.source.isSourceAvailable?.(note.filePath) ?? true),
        )
        .sort((left, right) => left.filePath.localeCompare(right.filePath));
      const entries: AnnotationIndexEntry[] = [];
      const issues: RepositoryIssue[] = [...discovered.issues];
      let completed = 0;
      let cursor = 0;
      input.onProgress?.({ completed, total: notes.length });

      const worker = async (): Promise<void> => {
        while (true) {
          throwIfAborted(input.signal);
          const noteIndex = cursor;
          cursor += 1;
          const note = notes[noteIndex];
          if (note === undefined) {
            return;
          }
          const [loaded, inkSummaries, snapshotSummaries] = await Promise.all([
            this.source.listAnnotations(note.filePath),
            this.source.listSurfaceSummaries(note.filePath),
            this.source.listSnapshotSummaries(note.filePath),
          ]);
          throwIfAborted(input.signal);
          issues.push(...loaded.issues);
          const divergentIds = new Set(
            loaded.conflicts
              .filter((conflict) => conflict.kind === 'same-revision-divergence')
              .map((conflict) => conflict.annotationId),
          );
          for (const record of loaded.records) {
            if (record.deletedAt !== undefined) {
              continue;
            }
            const styleId = record.mark?.styleId;
            const resolvedStyleName = styleId === undefined ? undefined : this.styleName(styleId);
            entries.push(
              textRecordToIndexEntry(record, {
                conflict: divergentIds.has(record.id),
                ...(resolvedStyleName === undefined ? {} : { styleName: resolvedStyleName }),
              }),
            );
          }
          for (const summary of inkSummaries) {
            if (summary.deletedAt === undefined && summary.strokeCount > 0) {
              entries.push(inkSummaryToIndexEntry(summary, note.noteId));
            }
          }
          for (const summary of snapshotSummaries) {
            if (summary.deletedAt === undefined) {
              entries.push(snapshotSummaryToIndexEntry(summary, note.noteId));
            }
          }
          completed += 1;
          input.onProgress?.({ completed, total: notes.length });
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, Math.max(1, notes.length)) }, () => worker()),
      );
      throwIfAborted(input.signal);
      if (startVersion !== null && this.index.version !== startVersion) {
        if (attempt + 1 < MAX_REBUILD_ATTEMPTS) continue;
        return { indexed: this.index.snapshot().length, issues, status: 'superseded' };
      }
      this.index.rebuild(entries);
      try {
        await this.cache?.save(this.index.snapshot(), this.now());
      } catch (error) {
        this.onCacheIssue(error);
      }
      return { indexed: entries.length, issues, status: 'committed' };
    }
    throw new Error('Vault index rebuild exhausted its retry budget.');
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('Vault index build was cancelled.', 'AbortError');
  }
}
