import type { TextAnnotationRecord } from '../domain/text-annotation';
import type { InkSurfaceRecord } from '../domain/ink-surface';
import { summarizeInkSurface } from '../domain/ink-surface-summary';
import {
  inkSummaryToIndexEntry,
  textRecordToIndexEntry,
  type VaultAnnotationIndex,
} from '../domain/vault-annotation-index';

type RecordChangedResult = 'applied' | 'missing' | 'not-ready' | 'removed' | 'stale' | 'unchanged';

export function applyCanonicalInkSurfaceChanged(
  index: VaultAnnotationIndex,
  record: InkSurfaceRecord,
): RecordChangedResult {
  if (!index.isReady()) return 'not-ready';
  if (
    record.deletedAt !== undefined ||
    !record.strokes.some((stroke) => stroke.tool !== 'eraser')
  ) {
    return index.removeAtOrBelow({
      id: record.id,
      maximumRevision: record.revision - 1,
      noteId: record.noteId,
    });
  }
  return index.upsert(inkSummaryToIndexEntry(summarizeInkSurface(record), record.noteId));
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
