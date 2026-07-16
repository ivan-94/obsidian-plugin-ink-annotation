import { createTextAnchor, hashText } from '../domain/text-anchor';
import { resolveTextAnchor } from '../domain/text-anchor-resolver';
import { restoreTombstone, tombstoneAnnotation } from '../domain/annotation-lifecycle';
import {
  confirmReattachment as applyConfirmedReattachment,
  previewReattachment as createReattachmentPreview,
  type ReattachmentCandidate,
} from '../domain/annotation-reattachment';
import {
  buildCurrentFileAnnotationList,
  type CurrentFileAnnotationList,
} from '../domain/current-file-annotation-list';
import type { TextAnnotationRecord, TextStructuralScope } from '../domain/text-annotation';
import {
  normalizeVaultPath,
  type RepositoryConflict,
  type RepositoryIssue,
  type SidecarRepository,
} from '../storage/sidecar-repository';

const TEXT_RESTORE_WINDOW_MS = 5_000;

export interface CreateHighlightInput {
  readonly filePath: string;
  readonly selection: {
    readonly displayText?: string;
    readonly end: number;
    readonly scope: TextStructuralScope;
    readonly start: number;
  };
  readonly source: string;
  readonly styleId: string;
}

export interface PendingTextSelection {
  readonly filePath: string;
  readonly target: TextAnnotationRecord['target'];
}

export interface ResolvedHighlight {
  readonly end: number;
  readonly record: TextAnnotationRecord;
  readonly start: number;
}

export interface ResolveHighlightsResult {
  readonly issues: readonly RepositoryIssue[];
  readonly resolved: readonly ResolvedHighlight[];
  readonly unanchored: readonly UnanchoredHighlight[];
}

export interface UnanchoredHighlight {
  readonly reason: 'ambiguous' | 'not-found';
  readonly record: TextAnnotationRecord;
}

export interface AnnotationSelectionSnapshot {
  readonly expectedRevision: number;
  readonly filePath: string;
  readonly id: string;
}

export interface BulkAnnotationFailure extends AnnotationSelectionSnapshot {
  readonly reason: 'missing' | 'not-applicable' | 'stale' | 'write-failed';
}

export class AnnotationService {
  private readonly createId: () => string;
  private readonly deviceId: string | undefined;
  private readonly now: () => string;
  private readonly repository: SidecarRepository;

  constructor(input: {
    readonly createId?: () => string;
    readonly deviceId?: string;
    readonly now?: () => string;
    readonly repository: SidecarRepository;
  }) {
    this.createId = input.createId ?? (() => globalThis.crypto.randomUUID());
    if (input.deviceId !== undefined && input.deviceId.length === 0) {
      throw new Error('Device ID must not be empty.');
    }
    this.deviceId = input.deviceId;
    this.now = input.now ?? (() => new Date().toISOString());
    this.repository = input.repository;
  }

  async createHighlight(input: CreateHighlightInput): Promise<TextAnnotationRecord> {
    const pending = await this.prepareSelection(input);
    return this.commitHighlight(pending, input.styleId);
  }

  async prepareSelection(
    input: Omit<CreateHighlightInput, 'styleId'>,
  ): Promise<PendingTextSelection> {
    const filePath = normalizeVaultPath(input.filePath);
    const target = await createTextAnchor({
      ...(input.selection.displayText === undefined
        ? {}
        : { displayText: input.selection.displayText }),
      end: input.selection.end,
      scope: input.selection.scope,
      source: input.source,
      start: input.selection.start,
    });

    return { filePath, target };
  }

  async commitHighlight(
    pending: PendingTextSelection,
    styleId: string,
  ): Promise<TextAnnotationRecord> {
    return this.commitMark(pending, { kind: 'highlight', styleId });
  }

  async commitMark(
    pending: PendingTextSelection,
    mark: NonNullable<TextAnnotationRecord['mark']>,
  ): Promise<TextAnnotationRecord> {
    if (mark.styleId.length === 0) {
      throw new Error('Annotation style ID must not be empty.');
    }

    const now = this.now();
    const existing = await this.findRecordAtTarget(pending);
    if (existing !== null) {
      const updated = this.authored(
        withoutAnchorFailure({
          ...existing,
          mark,
          revision: existing.revision + 1,
          status: 'active',
          target: pending.target,
          updatedAt: now,
        }),
      );
      await this.repository.updateAnnotation(updated);
      return updated;
    }
    const note = await this.repository.getOrCreateNote({
      createId: this.createId,
      filePath: pending.filePath,
      now,
      sourceFingerprint: pending.target.sourceRevision ?? '',
    });
    const record: TextAnnotationRecord = this.authored({
      createdAt: now,
      filePath: pending.filePath,
      id: this.createId(),
      mark,
      noteId: note.noteId,
      revision: 1,
      schemaVersion: 1,
      status: 'active',
      tags: [],
      target: pending.target,
      updatedAt: now,
    });

    await this.repository.writeAnnotation(record);
    return record;
  }

  async beginNoteDraft(pending: PendingTextSelection): Promise<TextAnnotationRecord> {
    const existing = await this.findRecordAtTarget(pending);
    if (existing !== null) {
      return existing;
    }
    const now = this.now();
    const note = await this.repository.getOrCreateNote({
      createId: this.createId,
      filePath: pending.filePath,
      now,
      sourceFingerprint: pending.target.sourceRevision ?? '',
    });
    const record: TextAnnotationRecord = this.authored({
      createdAt: now,
      filePath: pending.filePath,
      id: this.createId(),
      noteId: note.noteId,
      revision: 1,
      schemaVersion: 1,
      status: 'draft',
      tags: [],
      target: pending.target,
      updatedAt: now,
    });
    await this.repository.writeAnnotation(record);
    return record;
  }

  async saveDraft(
    draft: TextAnnotationRecord,
    input: {
      readonly body: string;
      readonly mark?: TextAnnotationRecord['mark'];
      readonly tags: readonly string[];
    },
  ): Promise<TextAnnotationRecord> {
    const hasBody = input.body.trim().length > 0;
    const active = hasBody || input.mark !== undefined || input.tags.length > 0;
    const { body: _oldBody, mark: _oldMark, ...draftWithoutContents } = draft;
    void _oldBody;
    void _oldMark;
    const updated: TextAnnotationRecord = this.authored({
      ...draftWithoutContents,
      ...(hasBody ? { body: input.body } : {}),
      ...(input.mark === undefined ? {} : { mark: input.mark }),
      revision: draft.revision + 1,
      status: active ? 'active' : 'draft',
      tags: [...input.tags],
      updatedAt: this.now(),
    });
    await this.repository.updateAnnotation(updated);
    return updated;
  }

  async discardEmptyDraft(draft: TextAnnotationRecord): Promise<void> {
    const hasBody = typeof draft.body === 'string' && draft.body.trim().length > 0;
    if (draft.status !== 'draft' || draft.mark !== undefined || hasBody || draft.tags.length > 0) {
      throw new Error('Only an empty draft can be discarded.');
    }
    await this.repository.deleteAnnotation(draft.filePath, draft.id);
  }

  async deleteAnnotation(filePath: string, annotationId: string): Promise<TextAnnotationRecord> {
    const record = await this.repository.readAnnotation(filePath, annotationId);
    if (record === null) {
      throw new Error(`Cannot delete missing annotation ${annotationId}.`);
    }
    const deleted = this.authored(tombstoneAnnotation(record, this.now()));
    await this.repository.updateAnnotation(deleted);
    return deleted;
  }

  async undoDeletion(
    filePath: string,
    annotationId: string,
    expectedRevision: number,
  ): Promise<TextAnnotationRecord> {
    const record = await this.repository.readAnnotation(filePath, annotationId);
    if (record === null) {
      throw new Error(`Cannot restore missing annotation ${annotationId}.`);
    }
    const restored = this.authored(restoreTombstone(record, { expectedRevision, now: this.now() }));
    await this.repository.updateAnnotation(restored);
    return restored;
  }

  async listCurrentFile(filePath: string): Promise<{
    readonly conflicts: readonly RepositoryConflict[];
    readonly issues: readonly RepositoryIssue[];
    readonly model: CurrentFileAnnotationList;
  }> {
    const loaded = await this.repository.listAnnotations(filePath);
    return {
      conflicts: loaded.conflicts,
      issues: loaded.issues,
      model: buildCurrentFileAnnotationList(loaded.records, {
        deletedRestoreWindowMs: TEXT_RESTORE_WINDOW_MS,
        now: this.now(),
      }),
    };
  }

  async getAnnotationsById(
    filePath: string,
    annotationIds: readonly string[],
  ): Promise<readonly TextAnnotationRecord[]> {
    const loaded = await this.repository.listAnnotations(filePath);
    const byId = new Map(
      loaded.records
        .filter((record) => record.deletedAt === undefined)
        .map((record) => [record.id, record] as const),
    );
    return annotationIds.flatMap((id) => {
      const record = byId.get(id);
      return record === undefined ? [] : [record];
    });
  }

  async updateAnnotationContents(
    filePath: string,
    annotationId: string,
    input: {
      readonly body: string;
      readonly mark?: TextAnnotationRecord['mark'];
      readonly tags: readonly string[];
    },
  ): Promise<TextAnnotationRecord> {
    const record = await this.repository.readAnnotation(filePath, annotationId);
    if (record === null || record.deletedAt !== undefined) {
      throw new Error(`Cannot edit missing or deleted annotation ${annotationId}.`);
    }
    const hasBody = input.body.trim().length > 0;
    if (!hasBody && input.mark === undefined && input.tags.length === 0) {
      throw new Error('An annotation must keep a mark, note body or tag.');
    }
    if (input.mark !== undefined && input.mark.styleId.length === 0) {
      throw new Error('Annotation style ID must not be empty.');
    }
    const { body: _body, mark: _mark, ...unchanged } = record;
    void _body;
    void _mark;
    const updated: TextAnnotationRecord = this.authored({
      ...unchanged,
      ...(hasBody ? { body: input.body } : {}),
      ...(input.mark === undefined ? {} : { mark: input.mark }),
      revision: record.revision + 1,
      status: record.status === 'unanchored' ? 'unanchored' : 'active',
      tags: [...input.tags],
      updatedAt: this.now(),
    });
    await this.repository.updateAnnotation(updated);
    return updated;
  }

  async previewReattachment(
    filePath: string,
    annotationId: string,
    replacement: PendingTextSelection,
  ): Promise<ReattachmentCandidate> {
    const record = await this.repository.readAnnotation(filePath, annotationId);
    if (record === null) {
      throw new Error(`Cannot repair missing annotation ${annotationId}.`);
    }
    if (normalizeVaultPath(filePath) !== replacement.filePath) {
      throw new Error('Replacement selection belongs to a different file.');
    }
    return createReattachmentPreview(record, replacement.target);
  }

  async confirmReattachment(
    filePath: string,
    candidate: ReattachmentCandidate,
  ): Promise<TextAnnotationRecord> {
    const record = await this.repository.readAnnotation(filePath, candidate.annotationId);
    if (record === null) {
      throw new Error(`Cannot repair missing annotation ${candidate.annotationId}.`);
    }
    const repaired = this.authored(applyConfirmedReattachment(record, candidate, this.now()));
    await this.repository.updateAnnotation(repaired);
    return repaired;
  }

  async repairConflict(
    filePath: string,
    conflict: RepositoryConflict,
    candidatePath: string,
  ): Promise<TextAnnotationRecord> {
    if (conflict.kind !== 'same-revision-divergence') {
      throw new Error('Only a divergent same-revision conflict requires candidate selection.');
    }
    const candidate = conflict.candidates.find(({ path }) => path === candidatePath);
    if (candidate === undefined) {
      throw new Error('The selected conflict candidate is not part of this review.');
    }
    const expectedHighestRevision = Math.max(
      ...conflict.candidates.map(({ record }) => record.revision),
    );
    return this.repository.resolveConflict({
      candidate,
      ...(this.deviceId === undefined ? {} : { deviceId: this.deviceId }),
      expectedHighestRevision,
      filePath,
      now: this.now(),
    });
  }

  async resolveHighlights(input: {
    readonly filePath: string;
    readonly persistChanges?: boolean;
    readonly source: string;
  }): Promise<ResolveHighlightsResult> {
    const persistChanges = input.persistChanges ?? true;
    if (persistChanges) await this.reconcileNotePath(input.filePath, input.source);
    const loaded = await this.repository.listAnnotations(input.filePath);
    const issues: RepositoryIssue[] = [...loaded.issues];
    const resolved: ResolvedHighlight[] = [];
    const unanchored: UnanchoredHighlight[] = [];

    for (const record of loaded.records) {
      if (record.deletedAt !== undefined) {
        continue;
      }
      const resolution = resolveTextAnchor(input.source, record.target);
      if (resolution.kind === 'unanchored') {
        if (!persistChanges) {
          unanchored.push({ reason: resolution.reason, record });
          continue;
        }
        const unanchoredRecord =
          record.status === 'unanchored'
            ? record
            : this.authored({
                ...record,
                anchorFailure: {
                  candidateCount: resolution.candidates,
                  reason: resolution.reason,
                },
                revision: record.revision + 1,
                status: 'unanchored' as const,
                updatedAt: this.now(),
              });
        if (unanchoredRecord !== record) {
          await this.repository.updateAnnotation(unanchoredRecord);
        }
        unanchored.push({ reason: resolution.reason, record: unanchoredRecord });
        continue;
      }
      if (!persistChanges) {
        resolved.push({ end: resolution.end, record, start: resolution.start });
        continue;
      }
      const needsRebase = resolution.method !== 'position';
      const target = needsRebase
        ? await createTextAnchor({
            ...(record.target.displayText === undefined
              ? {}
              : { displayText: record.target.displayText }),
            end: resolution.end,
            scope: lineScopeAt(input.source, resolution.start),
            source: input.source,
            start: resolution.start,
          })
        : record.target;
      const needsRecordUpdate = needsRebase || record.status === 'unanchored';
      const resolvedRecord = needsRecordUpdate
        ? this.authored(
            withoutAnchorFailure({
              ...record,
              revision: record.revision + 1,
              status: record.status === 'unanchored' ? ('active' as const) : record.status,
              target,
              updatedAt: this.now(),
            }),
          )
        : record;
      if (resolvedRecord !== record) {
        await this.repository.updateAnnotation(resolvedRecord);
      }
      resolved.push({ end: resolution.end, record: resolvedRecord, start: resolution.start });
    }

    return { issues, resolved, unanchored };
  }

  async reconcileNotePath(filePath: string, source: string): Promise<boolean> {
    return (
      (await this.repository.reconcileNote({
        filePath,
        now: this.now(),
        sourceFingerprint: await hashText(source),
      })) !== null
    );
  }

  async markNoteSourceMissing(filePath: string): Promise<boolean> {
    return (await this.repository.markNoteSourceMissing(filePath, this.now())) !== null;
  }

  async bulkAddTags(
    selection: readonly AnnotationSelectionSnapshot[],
    tags: readonly string[],
  ): Promise<{
    readonly failed: readonly BulkAnnotationFailure[];
    readonly succeeded: readonly TextAnnotationRecord[];
  }> {
    const additions = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
    if (additions.length === 0) {
      throw new Error('Bulk tag change requires at least one non-empty tag.');
    }
    const failed: BulkAnnotationFailure[] = [];
    const succeeded: TextAnnotationRecord[] = [];
    for (const item of selection) {
      const record = await this.repository.readAnnotation(item.filePath, item.id);
      if (record === null || record.deletedAt !== undefined) {
        failed.push({ ...item, reason: 'missing' });
        continue;
      }
      if (record.revision !== item.expectedRevision) {
        failed.push({ ...item, reason: 'stale' });
        continue;
      }
      const updated = this.authored({
        ...record,
        revision: record.revision + 1,
        tags: [...new Set([...record.tags, ...additions])],
        updatedAt: this.now(),
      });
      try {
        await this.repository.updateAnnotation(updated);
        succeeded.push(updated);
      } catch {
        failed.push({ ...item, reason: 'write-failed' });
      }
    }
    return { failed, succeeded };
  }

  async bulkDelete(selection: readonly AnnotationSelectionSnapshot[]): Promise<{
    readonly failed: readonly BulkAnnotationFailure[];
    readonly succeeded: readonly TextAnnotationRecord[];
  }> {
    const failed: BulkAnnotationFailure[] = [];
    const succeeded: TextAnnotationRecord[] = [];
    for (const item of selection) {
      const record = await this.repository.readAnnotation(item.filePath, item.id);
      if (record === null || record.deletedAt !== undefined) {
        failed.push({ ...item, reason: 'missing' });
        continue;
      }
      if (record.revision !== item.expectedRevision) {
        failed.push({ ...item, reason: 'stale' });
        continue;
      }
      const deleted = this.authored(tombstoneAnnotation(record, this.now()));
      try {
        await this.repository.updateAnnotation(deleted);
        succeeded.push(deleted);
      } catch {
        failed.push({ ...item, reason: 'write-failed' });
      }
    }
    return { failed, succeeded };
  }

  async bulkChangeStyle(
    selection: readonly AnnotationSelectionSnapshot[],
    styleId: string,
  ): Promise<{
    readonly failed: readonly BulkAnnotationFailure[];
    readonly succeeded: readonly TextAnnotationRecord[];
  }> {
    if (styleId.length === 0) {
      throw new Error('Bulk style change requires a non-empty style ID.');
    }
    const failed: BulkAnnotationFailure[] = [];
    const succeeded: TextAnnotationRecord[] = [];
    for (const item of selection) {
      const record = await this.repository.readAnnotation(item.filePath, item.id);
      if (record === null || record.deletedAt !== undefined) {
        failed.push({ ...item, reason: 'missing' });
        continue;
      }
      if (record.revision !== item.expectedRevision) {
        failed.push({ ...item, reason: 'stale' });
        continue;
      }
      if (record.mark === undefined) {
        failed.push({ ...item, reason: 'not-applicable' });
        continue;
      }
      const updated = this.authored({
        ...record,
        mark: { ...record.mark, styleId },
        revision: record.revision + 1,
        updatedAt: this.now(),
      });
      try {
        await this.repository.updateAnnotation(updated);
        succeeded.push(updated);
      } catch {
        failed.push({ ...item, reason: 'write-failed' });
      }
    }
    return { failed, succeeded };
  }

  private async findRecordAtTarget(
    pending: PendingTextSelection,
  ): Promise<TextAnnotationRecord | null> {
    const loaded = await this.repository.listAnnotations(pending.filePath);
    return (
      loaded.records.find(
        (record) =>
          record.deletedAt === undefined &&
          record.target.position.start === pending.target.position.start &&
          record.target.position.end === pending.target.position.end &&
          record.target.quote.exact === pending.target.quote.exact,
      ) ?? null
    );
  }

  private authored(record: TextAnnotationRecord): TextAnnotationRecord {
    return this.deviceId === undefined ? record : { ...record, deviceId: this.deviceId };
  }
}

function withoutAnchorFailure(record: TextAnnotationRecord): TextAnnotationRecord {
  const { anchorFailure: _anchorFailure, ...resolved } = record;
  void _anchorFailure;
  return resolved;
}

function lineScopeAt(source: string, position: number): TextStructuralScope {
  let line = 0;
  for (let index = 0; index < position; index += 1) {
    if (source[index] === '\n') {
      line += 1;
    }
  }
  return { sectionEndLine: line, sectionStartLine: line };
}
