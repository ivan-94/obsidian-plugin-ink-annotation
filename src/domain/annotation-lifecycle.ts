import type { TextAnnotationRecord } from './text-annotation';

export function tombstoneAnnotation(
  record: TextAnnotationRecord,
  now: string,
): TextAnnotationRecord {
  if (record.deletedAt !== undefined) {
    throw new Error('Annotation is already deleted.');
  }
  return {
    ...record,
    deletedAt: now,
    revision: record.revision + 1,
    updatedAt: now,
  };
}

export function restoreTombstone(
  record: TextAnnotationRecord,
  input: { readonly expectedRevision: number; readonly now: string },
): TextAnnotationRecord {
  if (record.deletedAt === undefined) {
    throw new Error('Annotation is not deleted.');
  }
  if (record.revision !== input.expectedRevision) {
    throw new Error('Cannot undo deletion after a newer revision was written.');
  }
  const { deletedAt: _deletedAt, ...active } = record;
  void _deletedAt;
  return {
    ...active,
    revision: record.revision + 1,
    updatedAt: input.now,
  };
}
