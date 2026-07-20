import type { TextAnnotationRecord } from '../domain/text-annotation';
import type { InkSurfaceRecord } from '../domain/ink-surface';
import type { InkSurfaceSummary } from '../domain/ink-surface-summary';
import {
  inkSummaryToIndexEntry,
  textRecordToIndexEntry,
  type VaultAnnotationIndex,
} from '../domain/vault-annotation-index';

type RecordChangedResult = 'applied' | 'missing' | 'not-ready' | 'removed' | 'stale' | 'unchanged';

export function applyCanonicalInkSurfaceSummaries(
  index: VaultAnnotationIndex,
  input: {
    readonly filePath: string;
    readonly noteId: string;
    readonly summaries: readonly InkSurfaceSummary[];
  },
): RecordChangedResult {
  assertAuthoritativeInkSummarySet(input.filePath, input.summaries);
  if (!index.isReady()) return 'not-ready';

  const results: RecordChangedResult[] = [];
  const summaryIds = new Set(input.summaries.map(({ id }) => id));
  for (const entry of index.snapshot()) {
    if (
      entry.type !== 'ink' ||
      entry.noteId !== input.noteId ||
      entry.filePath !== input.filePath ||
      summaryIds.has(entry.id)
    ) {
      continue;
    }
    results.push(
      index.remove({ expectedRevision: entry.revision, id: entry.id, noteId: input.noteId }),
    );
  }

  for (const summary of input.summaries) {
    if (summary.deletedAt !== undefined || summary.strokeCount === 0) {
      results.push(
        index.removeAtOrBelow({
          id: summary.id,
          maximumRevision: summary.revision - 1,
          noteId: input.noteId,
        }),
      );
      continue;
    }
    results.push(index.upsert(inkSummaryToIndexEntry(summary, input.noteId)));
  }
  return summarizeRecordChangedResults(results);
}

export class CanonicalInkSurfaceProjectionCoordinator {
  private disposed = false;
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly input: {
      readonly applySummaries?: (filePath: string, summaries: readonly InkSurfaceSummary[]) => void;
      readonly index: VaultAnnotationIndex;
      readonly listSurfaceSummaries: (filePath: string) => Promise<readonly InkSurfaceSummary[]>;
    },
  ) {}

  dispose(): void {
    this.disposed = true;
    this.generations.clear();
  }

  async refresh(
    record: Pick<InkSurfaceRecord, 'filePath' | 'noteId'>,
  ): Promise<RecordChangedResult | 'superseded'> {
    if (this.disposed) return 'superseded';
    const key = `${record.noteId}\u0000${record.filePath}`;
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    // One atomic multi-surface commit publishes one synchronous event per surface. Yield once so
    // all but the newest generation retire before starting an identical note-level summary read.
    await Promise.resolve();
    if (this.disposed || this.generations.get(key) !== generation) return 'superseded';
    const summaries = await this.input.listSurfaceSummaries(record.filePath);
    if (this.disposed || this.generations.get(key) !== generation) return 'superseded';

    assertAuthoritativeInkSummarySet(record.filePath, summaries);
    const result = applyCanonicalInkSurfaceSummaries(this.input.index, {
      filePath: record.filePath,
      noteId: record.noteId,
      summaries,
    });
    this.input.applySummaries?.(record.filePath, summaries);
    return result;
  }
}

export function applyCanonicalRecordChanged(
  index: VaultAnnotationIndex,
  record: TextAnnotationRecord,
  styleName: (styleId: string) => string | undefined = () => undefined,
): RecordChangedResult {
  if (!index.isReady()) {
    return 'not-ready';
  }
  if (record.deletedAt !== undefined) {
    return index.removeAtOrBelow({
      id: record.id,
      maximumRevision: record.revision - 1,
      noteId: record.noteId,
    });
  }
  const resolvedStyleName = record.mark === undefined ? undefined : styleName(record.mark.styleId);
  return index.upsert(
    textRecordToIndexEntry(record, {
      ...(resolvedStyleName === undefined ? {} : { styleName: resolvedStyleName }),
    }),
  );
}

export function applyCanonicalRecordRemoved(
  index: VaultAnnotationIndex,
  record: TextAnnotationRecord,
): 'missing' | 'not-ready' | 'removed' | 'stale' {
  if (!index.isReady()) {
    return 'not-ready';
  }
  return index.removeAtOrBelow({
    id: record.id,
    maximumRevision: record.revision,
    noteId: record.noteId,
  });
}

function assertAuthoritativeInkSummarySet(
  filePath: string,
  summaries: readonly InkSurfaceSummary[],
): void {
  const ids = new Set<string>();
  for (const summary of summaries) {
    if (summary.filePath !== filePath) {
      throw new Error(
        `Ink summary projection for ${filePath} included another note: ${summary.filePath}.`,
      );
    }
    if (ids.has(summary.id)) {
      throw new Error(`Ink summary projection for ${filePath} contains duplicate ${summary.id}.`);
    }
    ids.add(summary.id);
  }
}

function summarizeRecordChangedResults(
  results: readonly RecordChangedResult[],
): RecordChangedResult {
  if (results.includes('applied')) return 'applied';
  if (results.includes('removed')) return 'removed';
  if (results.includes('stale')) return 'stale';
  if (results.includes('unchanged')) return 'unchanged';
  return results.includes('missing') ? 'missing' : 'unchanged';
}
