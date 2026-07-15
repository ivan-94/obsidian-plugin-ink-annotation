import type { TextAnnotationRecord, TextAnnotationTarget } from './text-annotation';

export interface ReattachmentCandidate {
  readonly annotationId: string;
  readonly baseRevision: number;
  readonly contextPreview: string;
  readonly target: TextAnnotationTarget;
}

export function previewReattachment(
  record: TextAnnotationRecord,
  target: TextAnnotationTarget,
): ReattachmentCandidate {
  if (record.deletedAt !== undefined) {
    throw new Error('A deleted annotation cannot be reattached.');
  }
  if (record.status !== 'unanchored') {
    throw new Error('Only an unanchored annotation requires reattachment.');
  }
  return {
    annotationId: record.id,
    baseRevision: record.revision,
    contextPreview: `${target.quote.prefix}${target.quote.exact}${target.quote.suffix}`,
    target,
  };
}

export function confirmReattachment(
  record: TextAnnotationRecord,
  candidate: ReattachmentCandidate,
  now: string,
): TextAnnotationRecord {
  if (record.id !== candidate.annotationId) {
    throw new Error('Reattachment preview belongs to a different annotation.');
  }
  if (record.revision !== candidate.baseRevision) {
    throw new Error('Cannot reattach after a newer revision was written.');
  }
  const { anchorFailure: _anchorFailure, ...repairable } = record;
  void _anchorFailure;
  return {
    ...repairable,
    revision: record.revision + 1,
    status: 'active',
    target: candidate.target,
    updatedAt: now,
  };
}
