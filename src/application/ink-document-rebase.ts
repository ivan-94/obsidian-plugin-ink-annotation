import type { InkSurfaceRecord } from '../domain/ink-surface';
import {
  confirmInkDocumentRebase,
  type InkDocumentRebasePreview,
} from '../domain/ink-surface-layout';
import type { InkSurfaceWriter } from './ink-surface-session';

/** Commits an explicit cold document rebase without exposing a per-surface partial-write path. */
export async function commitInkDocumentRebase(input: {
  readonly current: readonly InkSurfaceRecord[];
  readonly now: string;
  readonly preview: InkDocumentRebasePreview;
  readonly writer: InkSurfaceWriter;
}): Promise<readonly InkSurfaceRecord[]> {
  const confirmed = confirmInkDocumentRebase(input.current, input.preview, input.now);
  if (confirmed.length > 1) {
    if (input.writer.updateSurfacesAtomically === undefined) {
      throw new Error('Document-level Ink rebase requires an atomic multi-surface writer.');
    }
    const committed = await input.writer.updateSurfacesAtomically(confirmed, input.current);
    return alignCommittedDocumentRebase(confirmed, committed);
  }
  const record = confirmed[0] as InkSurfaceRecord;
  const committed = await input.writer.updateSurface(record, input.current[0]);
  return [committed ?? record];
}

function alignCommittedDocumentRebase(
  planned: readonly InkSurfaceRecord[],
  committed: readonly InkSurfaceRecord[] | void,
): readonly InkSurfaceRecord[] {
  if (committed === undefined) return planned;
  const byId = new Map(committed.map((record) => [record.id, record] as const));
  if (byId.size !== planned.length || planned.some(({ id }) => !byId.has(id))) {
    throw new Error('Atomic Ink rebase returned an incomplete committed surface set.');
  }
  return planned.map(({ id }) => byId.get(id) as InkSurfaceRecord);
}
