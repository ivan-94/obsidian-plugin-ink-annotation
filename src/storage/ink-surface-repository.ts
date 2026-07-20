import {
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  safeDecodeInkSurfaceRecord,
  type InkSurfaceDecodeResult,
  type InkSurfaceRecord,
} from '../domain/ink-surface';
import { digestInkBrushGolden } from '../domain/ink-brush-contract';
import {
  planConcurrentInkAppendMerge,
  type InkConcurrentAppendConflictReason,
} from '../domain/ink-concurrent-append-merge';
import { upgradeInkSurfaceRecordsToV3 } from '../domain/ink-surface-migration';
import { hashText } from '../domain/text-anchor';
import {
  decodeInkSurfaceSummaryIndex,
  encodeInkSurfaceSummaryIndex,
  summarizeInkSurface,
  type InkSurfaceSummary,
  type InkSurfaceSummaryIndex,
} from '../domain/ink-surface-summary';
import { normalizeVaultPath, type TextFileStore } from './sidecar-repository';

const SIDECAR_ROOT = '.obsidian-annotations/v1/notes';
const SHARED_WRITE_COORDINATOR = Symbol.for(
  'inkstone.annotations.ink-surface-write-coordinator.v1',
);

export interface InkSurfaceCandidate {
  readonly path: string;
  readonly record: InkSurfaceRecord;
}

export interface InkSurfaceConflict {
  readonly candidates: readonly InkSurfaceCandidate[];
  readonly kind: 'duplicate-artifact' | 'same-revision-divergence' | 'schema-version-mismatch';
  readonly selectedPath: string;
  readonly surfaceId: string;
}

export interface InkSurfaceRepositoryIssue {
  readonly kind: 'conflict' | 'corrupt-record' | 'duplicate-artifact' | 'unsupported-record';
  readonly message: string;
  readonly path: string;
  readonly reason?: InkSurfaceUnsupportedReason;
}

interface LoadedInkSurfaces {
  readonly conflicts: readonly InkSurfaceConflict[];
  readonly issues: readonly InkSurfaceRepositoryIssue[];
  readonly records: readonly InkSurfaceRecord[];
}

type InkColdLaneCheckpoint = () => Promise<void>;

export type InkSurfaceCanonicalProjectionBlock =
  | {
      readonly conflict: InkSurfaceConflict;
      readonly kind: 'conflict';
    }
  | {
      readonly issue: InkSurfaceRepositoryIssue;
      readonly kind: 'corrupt-record' | 'unsupported-record';
    };

type InkSurfaceUnsupportedReason = Extract<
  InkSurfaceDecodeResult,
  { readonly kind: 'unsupported' }
>['reason'];

interface InkSurfaceBatchJournal {
  readonly entries: readonly {
    readonly nextContents: string;
    readonly path: string;
    readonly previousContents: string;
  }[];
  readonly filePath: string;
  readonly phase: 'committed' | 'prepared';
  readonly schemaActivation?: {
    readonly planDigest: string;
    readonly planReference: string;
    readonly sourceBaseDigest: string;
  };
  readonly schemaUpgrade?: {
    readonly kind: 'cold-v3-normalization';
    readonly sourceBaseDigest: string;
  };
  readonly schemaVersion: 1;
}

export class InkSurfaceConflictError extends Error {
  constructor(readonly conflict: InkSurfaceConflict) {
    super(`Ink surface ${conflict.surfaceId} has divergent candidates that require repair.`);
    this.name = 'InkSurfaceConflictError';
  }
}

export class InkSurfaceStaleBaseError extends Error {
  constructor(
    readonly surfaceId: string,
    readonly reason: InkConcurrentAppendConflictReason,
  ) {
    super(
      `Ink surface changed since the expected base was read and cannot be merged safely (${reason}); local Ink is retained.`,
    );
    this.name = 'InkSurfaceStaleBaseError';
  }
}

export class InkSurfaceUnsupportedError extends Error {
  constructor(
    readonly path: string,
    readonly reason: InkSurfaceUnsupportedReason,
  ) {
    super(
      `Ink at ${path} uses unsupported canonical data (${reason}); update Inkstone before editing this note.`,
    );
    this.name = 'InkSurfaceUnsupportedError';
  }
}

export class InkSurfaceCorruptError extends Error {
  constructor(readonly issue: InkSurfaceRepositoryIssue) {
    super(`Ink at ${issue.path} is corrupt; repair it before editing this note.`);
    this.name = 'InkSurfaceCorruptError';
  }
}

export function findInkSurfaceCanonicalProjectionBlock(input: {
  readonly conflicts: readonly InkSurfaceConflict[];
  readonly issues?: readonly InkSurfaceRepositoryIssue[];
}): InkSurfaceCanonicalProjectionBlock | null {
  const conflict = input.conflicts.find(
    ({ kind }) => kind === 'same-revision-divergence' || kind === 'schema-version-mismatch',
  );
  if (conflict !== undefined) return { conflict, kind: 'conflict' };
  const issue = input.issues?.find(
    ({ kind }) => kind === 'unsupported-record' || kind === 'corrupt-record',
  );
  if (issue?.kind === 'unsupported-record' || issue?.kind === 'corrupt-record') {
    return { issue, kind: issue.kind };
  }
  return null;
}

/** Finds the minimal summary set whose joined Logical Stroke inputs changed. */
export function affectedInkSummarySurfaceIds(input: {
  readonly current: readonly InkSurfaceRecord[];
  readonly previous: readonly InkSurfaceRecord[];
  readonly replacements: readonly InkSurfaceRecord[];
}): readonly string[] {
  const replacementIds = new Set(input.replacements.map(({ id }) => id));
  const linkedStrokeIds = new Set<string>();
  for (const record of [...input.previous, ...input.replacements]) {
    if (!replacementIds.has(record.id)) continue;
    for (const stroke of record.strokes) {
      if (stroke.linkedStrokeId !== undefined) linkedStrokeIds.add(stroke.linkedStrokeId);
    }
  }
  const affected = new Set(replacementIds);
  if (linkedStrokeIds.size > 0) {
    for (const record of input.current) {
      if (record.strokes.some((stroke) => linkedStrokeIds.has(stroke.linkedStrokeId ?? ''))) {
        affected.add(record.id);
      }
    }
  }
  return [...affected].sort();
}

/** Canonical per-surface persistence with the same conservative iCloud rules as text records. */
export class InkSurfaceRepository {
  private readonly onSurfaceChanged: (record: InkSurfaceRecord) => void;
  private readonly writes: Map<string, Promise<void>>;

  constructor(
    private readonly store: TextFileStore,
    events: {
      readonly onEventIssue?: (error: unknown) => void;
      readonly onSurfaceChanged?: (record: InkSurfaceRecord) => void;
    } = {},
  ) {
    const onEventIssue = events.onEventIssue ?? (() => undefined);
    const reportEventIssue = (error: unknown): void => {
      try {
        onEventIssue(error);
      } catch {
        // Canonical writes must not be reclassified by disposable projection diagnostics.
      }
    };
    const onSurfaceChanged = events.onSurfaceChanged ?? (() => undefined);
    this.onSurfaceChanged = (record) => {
      try {
        onSurfaceChanged(record);
      } catch (error) {
        reportEventIssue(error);
      }
    };
    this.writes = sharedVaultWrites(store.coordinationScope ?? store);
  }

  async writeSurface(record: InkSurfaceRecord): Promise<void> {
    const key = surfaceWriteKey(record.filePath, record.id);
    await this.withNoteBatchLock(record.filePath, () =>
      this.enqueueWrite(key, async () => {
        await this.assertNoteIdentity(record);
        await this.assertCanonicalProjectionWritable(record.filePath);
        const candidates = await this.readCandidates(record.filePath, record.id);
        if (candidates.length > 0) {
          throw new Error(`Cannot create existing ink surface ${record.id}.`);
        }
        await this.assertActiveSchemaCompatible(record);
        const path = await this.surfacePath(record.filePath, record.id);
        await this.store.mkdir(path.slice(0, path.lastIndexOf('/')));
        try {
          await this.store.write(path, encodeInkSurfaceRecord(record));
        } catch (error) {
          await this.store.remove?.(path).catch(() => undefined);
          throw error;
        }
        await this.refreshSummaryIndex(record);
        this.onSurfaceChanged(record);
      }),
    );
  }

  async readSurface(filePath: string, surfaceId: string): Promise<InkSurfaceRecord | null> {
    return this.withNoteBatchLock(filePath, async () => {
      const candidates = await this.readCandidates(filePath, surfaceId);
      return candidates.length === 0 ? null : selectLatestCandidate(candidates, surfaceId).record;
    });
  }

  async updateSurface(
    record: InkSurfaceRecord,
    expectedBase?: InkSurfaceRecord,
    checkpoint?: InkColdLaneCheckpoint,
  ): Promise<InkSurfaceRecord | void> {
    const key = surfaceWriteKey(record.filePath, record.id);
    return this.withNoteBatchLock(record.filePath, () =>
      this.enqueueWrite(key, async () => {
        await checkpoint?.();
        await this.assertNoteIdentity(record);
        await checkpoint?.();
        const loaded = await this.assertCanonicalProjectionWritable(record.filePath);
        await checkpoint?.();
        const existing = loaded.records.find(({ id }) => id === record.id);
        if (existing === undefined) {
          throw new Error(`Cannot update missing ink surface ${record.id}.`);
        }
        if (sameSurfaceRecord(existing, record)) {
          await this.refreshSummaryIndex(record, loaded, checkpoint);
          this.onSurfaceChanged(record);
          return;
        }
        if (crossesSchemaV3Boundary(existing, record)) {
          throw new Error(
            'Ink schema v3 can only be committed through the cold whole-document upgrade.',
          );
        }
        let nextRecord = record;
        let rebased = false;
        if (expectedBase !== undefined && !sameSurfaceRecord(existing, expectedBase)) {
          const plan = planConcurrentInkAppendMerge({
            base: expectedBase,
            local: record,
            remote: existing,
          });
          if (plan.kind === 'conflict') {
            throw new InkSurfaceStaleBaseError(record.id, plan.reason);
          }
          if (plan.kind === 'already-merged') {
            await this.refreshSummaryIndex(plan.record, loaded, checkpoint);
            this.onSurfaceChanged(plan.record);
            return plan.record;
          }
          nextRecord = plan.record;
          rebased = true;
        }
        const base = rebased ? existing : (expectedBase ?? existing);
        if (existing.noteId !== nextRecord.noteId || nextRecord.revision !== base.revision + 1) {
          throw new Error(
            'Ink surface update must preserve note identity and advance exactly one revision.',
          );
        }

        const path = await this.surfacePath(record.filePath, record.id);
        await checkpoint?.();
        const previousContents = await this.store.read(path);
        await checkpoint?.();
        const nextContents = encodeInkSurfaceRecord(nextRecord);
        try {
          await this.store.write(path, nextContents);
          await checkpoint?.();
        } catch (error) {
          try {
            if (previousContents === null) {
              if (this.store.remove === undefined) {
                throw new Error('The text file store cannot remove the partial surface file.', {
                  cause: error,
                });
              }
              await this.store.remove(path);
            } else {
              await this.store.write(path, previousContents);
            }
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              `Ink surface ${record.id} write and rollback both failed; repair is required.`,
              { cause: restoreError },
            );
          }
          throw error;
        }
        await this.refreshSummaryIndex(nextRecord, loaded, checkpoint);
        this.onSurfaceChanged(nextRecord);
        return rebased ? nextRecord : undefined;
      }),
    );
  }

  /** Commits a cross-surface document mutation as all-old or all-new canonical bytes. */
  async updateSurfacesAtomically(
    records: readonly InkSurfaceRecord[],
    expectedBases?: readonly InkSurfaceRecord[],
    checkpoint?: InkColdLaneCheckpoint,
  ): Promise<readonly InkSurfaceRecord[] | void> {
    return this.commitSurfacesAtomically(records, expectedBases, false, checkpoint);
  }

  /** One cold, exact whole-document migration; never called from pointer move/up. */
  async upgradeSurfacesToSchemaV3(
    records: readonly InkSurfaceRecord[],
    expectedBases: readonly InkSurfaceRecord[],
  ): Promise<readonly InkSurfaceRecord[] | void> {
    return this.commitSurfacesAtomically(records, expectedBases, true);
  }

  private async commitSurfacesAtomically(
    records: readonly InkSurfaceRecord[],
    expectedBases?: readonly InkSurfaceRecord[],
    coldSchemaUpgrade = false,
    checkpoint?: InkColdLaneCheckpoint,
  ): Promise<readonly InkSurfaceRecord[] | void> {
    if (records.length === 0) return;
    if (new Set(records.map((record) => record.id)).size !== records.length) {
      throw new Error('Atomic Ink update contains duplicate surface IDs.');
    }
    const expectedById = alignExpectedBases(records, expectedBases);
    const filePath = normalizeVaultPath(records[0]?.filePath ?? '');
    if (records.some((record) => normalizeVaultPath(record.filePath) !== filePath)) {
      throw new Error('Atomic Ink update must stay within one note.');
    }
    return this.withNoteBatchLock(filePath, async () => {
      await checkpoint?.();
      await this.assertCanonicalProjectionWritable(filePath);
      await checkpoint?.();
      if (coldSchemaUpgrade) {
        const loaded = await this.listSurfacesNow(filePath);
        await checkpoint?.();
        assertColdSchemaUpgrade({
          currentActive: loaded.records.filter(isActiveSurface),
          expectedBases: expectedBases ?? [],
          records,
        });
      }
      const prepared: Array<{
        readonly nextContents: string;
        readonly path: string;
        readonly previousContents: string;
        readonly record: InkSurfaceRecord;
      }> = [];
      const committedRecords: InkSurfaceRecord[] = [];
      let rebased = false;
      for (const record of records) {
        await this.assertNoteIdentity(record);
        await checkpoint?.();
        const candidates = await this.readCandidates(record.filePath, record.id);
        await checkpoint?.();
        if (candidates.length === 0) {
          throw new Error(`Cannot update missing ink surface ${record.id}.`);
        }
        const existing = selectLatestCandidate(candidates, record.id).record;
        if (sameSurfaceRecord(existing, record)) {
          committedRecords.push(existing);
          continue;
        }
        if (!coldSchemaUpgrade && crossesSchemaV3Boundary(existing, record)) {
          throw new Error(
            'Ink schema v3 can only be committed through the cold whole-document upgrade.',
          );
        }
        const expectedBase = expectedById?.get(record.id);
        let nextRecord = record;
        let recordRebased = false;
        if (expectedBase !== undefined && !sameSurfaceRecord(existing, expectedBase)) {
          const plan = planConcurrentInkAppendMerge({
            base: expectedBase,
            local: record,
            remote: existing,
          });
          if (plan.kind === 'conflict') {
            throw new InkSurfaceStaleBaseError(record.id, plan.reason);
          }
          if (plan.kind === 'already-merged') {
            committedRecords.push(plan.record);
            rebased = true;
            continue;
          }
          nextRecord = plan.record;
          recordRebased = true;
          rebased = true;
        }
        const base = recordRebased ? existing : (expectedBase ?? existing);
        if (existing.noteId !== nextRecord.noteId || nextRecord.revision !== base.revision + 1) {
          throw new Error(
            'Ink surface update must preserve note identity and advance exactly one revision.',
          );
        }
        const path = await this.surfacePath(record.filePath, record.id);
        await checkpoint?.();
        const previousContents = await this.store.read(path);
        await checkpoint?.();
        if (previousContents === null) {
          throw new Error(`Canonical Ink surface ${record.id} disappeared during batch update.`);
        }
        prepared.push({
          nextContents: encodeInkSurfaceRecord(nextRecord),
          path,
          previousContents,
          record: nextRecord,
        });
        committedRecords.push(nextRecord);
      }

      if (prepared.length === 0) {
        await this.refreshSummaryIndexes(committedRecords, undefined, checkpoint);
        for (const record of committedRecords) this.onSurfaceChanged(record);
        return rebased ? committedRecords : undefined;
      }
      if (prepared.length !== records.length) {
        throw new Error('Atomic Ink update cannot mix idempotent and advancing surfaces.');
      }

      const journalPath = await this.batchJournalPath(filePath);
      await checkpoint?.();
      const journal: InkSurfaceBatchJournal = {
        entries: prepared.map((item) => ({
          nextContents: item.nextContents,
          path: item.path,
          previousContents: item.previousContents,
        })),
        filePath,
        phase: 'prepared',
        ...(coldSchemaUpgrade
          ? {
              schemaUpgrade: {
                kind: 'cold-v3-normalization' as const,
                sourceBaseDigest: digestInkBrushGolden({
                  sourceSurfaceBytes: (expectedBases ?? []).map(encodeInkSurfaceRecord),
                }),
              },
            }
          : {}),
        schemaVersion: 1,
      };
      await this.store.write(journalPath, JSON.stringify(journal));
      await checkpoint?.();
      try {
        const writes = await Promise.allSettled(
          prepared.map((item) => this.store.write(item.path, item.nextContents)),
        );
        const writeFailure = writes.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (writeFailure !== undefined) {
          throw writeFailure.reason;
        }
        await checkpoint?.();
        await this.store.write(journalPath, JSON.stringify({ ...journal, phase: 'committed' }));
        await checkpoint?.();
      } catch (error) {
        const restoreResults = await Promise.allSettled(
          prepared.map((item) => this.store.write(item.path, item.previousContents)),
        );
        const restoreFailure = restoreResults.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (restoreFailure !== undefined) {
          throw new AggregateError(
            [error, restoreFailure.reason],
            'Atomic Ink update and rollback both failed; manual repair is required.',
            { cause: error },
          );
        }
        await this.clearBatchJournal(journalPath).catch(() => undefined);
        throw error;
      }

      await this.clearBatchJournal(journalPath).catch(() => undefined);
      await checkpoint?.();
      await this.refreshSummaryIndexes(
        prepared.map(({ record }) => record),
        undefined,
        checkpoint,
      );
      for (const { record } of prepared) this.onSurfaceChanged(record);
      return rebased ? committedRecords : undefined;
    });
  }

  /** Promotes only a reviewed divergent candidate; all iCloud sibling files remain untouched. */
  async resolveConflict(input: {
    readonly candidate: InkSurfaceCandidate;
    readonly deviceId?: string;
    readonly expectedHighestRevision: number;
    readonly filePath: string;
    readonly now: string;
  }): Promise<InkSurfaceRecord> {
    const surfaceId = input.candidate.record.id;
    const filePath = normalizeVaultPath(input.filePath);
    const key = surfaceWriteKey(filePath, surfaceId);
    return this.withNoteBatchLock(filePath, () =>
      this.enqueueWrite(key, async () => {
        const candidates = await this.readCandidates(filePath, surfaceId);
        const highestRevision = Math.max(...candidates.map(({ record }) => record.revision), 0);
        const reviewed = candidates.find(({ path }) => path === input.candidate.path);
        const latest = candidates.filter(({ record }) => record.revision === highestRevision);
        if (
          reviewed === undefined ||
          highestRevision !== input.expectedHighestRevision ||
          encodeInkSurfaceRecord(reviewed.record) !==
            encodeInkSurfaceRecord(input.candidate.record) ||
          !hasDivergentRecords(latest)
        ) {
          throw new Error('Ink conflict changed since review; reopen the repair dialog.');
        }
        const resolved: InkSurfaceRecord = {
          ...reviewed.record,
          ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
          revision: highestRevision + 1,
          updatedAt: input.now,
        };
        await this.assertNoteIdentity(resolved);
        const canonicalPath = await this.surfacePath(filePath, surfaceId);
        const previousContents = await this.store.read(canonicalPath);
        try {
          await this.store.write(canonicalPath, encodeInkSurfaceRecord(resolved));
        } catch (error) {
          try {
            if (previousContents === null) {
              if (this.store.remove === undefined) {
                throw new Error(
                  'The text file store cannot remove the partial Ink conflict repair.',
                  {
                    cause: error,
                  },
                );
              }
              await this.store.remove(canonicalPath);
            } else {
              await this.store.write(canonicalPath, previousContents);
            }
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              `Ink surface ${surfaceId} conflict repair and rollback both failed; manual repair is required.`,
              { cause: restoreError },
            );
          }
          throw error;
        }
        await this.refreshSummaryIndex(resolved);
        this.onSurfaceChanged(resolved);
        return resolved;
      }),
    );
  }

  async listSurfaceSummaries(filePath: string): Promise<readonly InkSurfaceSummary[]> {
    await this.recoverAtomicBatch(filePath);
    const path = await this.summaryIndexPath(filePath);
    const contents = await this.store.read(path);
    if (contents !== null) {
      try {
        const index = decodeInkSurfaceSummaryIndex(contents);
        if (normalizeVaultPath(index.filePath) === normalizeVaultPath(filePath)) {
          return sortSummaries(index.summaries);
        }
      } catch {
        // Derived summaries are rebuilt from canonical surfaces below.
      }
    }
    const loaded = await this.listSurfaces(filePath);
    const summaries = summarizeLoadedSurfaces(loaded);
    await this.writeSummaryIndex(filePath, summaries);
    return sortSummaries(summaries);
  }

  /** Rebuilds disposable Ink summaries after an external canonical or summary artifact event. */
  async rebuildSummariesForSidecarPath(sidecarPath: string): Promise<string | null> {
    const normalizedPath = sidecarPath.replaceAll('\\', '/');
    const match =
      /^\.obsidian-annotations\/v1\/notes\/([^/]+)\/(?:surfaces\/[^/]+\.json|ink-summaries\.json)$/u.exec(
        normalizedPath,
      );
    const pathHash = match?.[1];
    if (pathHash === undefined) return null;
    const metaContents = await this.store.read(`${SIDECAR_ROOT}/${pathHash}/meta.json`);
    if (metaContents === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(metaContents);
    } catch {
      return null;
    }
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 1 ||
      parsed.pathHash !== pathHash ||
      typeof parsed.filePath !== 'string'
    ) {
      return null;
    }
    const filePath = normalizeVaultPath(parsed.filePath);
    const key = summaryWriteKey(filePath);
    const loaded = await this.listSurfaces(filePath);
    await this.enqueueWrite(key, async () => {
      await this.writeSummaryIndex(filePath, summarizeLoadedSurfaces(loaded));
    });
    return filePath;
  }

  async tombstoneSurface(
    filePath: string,
    surfaceId: string,
    now: string,
    deviceId?: string,
    expectedRevision?: number,
  ): Promise<InkSurfaceRecord> {
    const current = await this.readSurface(filePath, surfaceId);
    if (current === null) throw new Error(`Ink surface ${surfaceId} does not exist.`);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new Error(`Ink surface ${surfaceId} changed since it was selected.`);
    }
    if (current.deletedAt !== undefined) return current;
    const deleted: InkSurfaceRecord = {
      ...current,
      deletedAt: now,
      ...(deviceId === undefined ? {} : { deviceId }),
      revision: current.revision + 1,
      updatedAt: now,
    };
    await this.updateSurface(deleted);
    return deleted;
  }

  /**
   * Reclaims persisted drawing sessions that contain no visible Ink.
   *
   * Empty surfaces are tombstoned instead of physically removed so an older iCloud artifact
   * cannot resurrect them on another device.
   */
  async reclaimEmptySurfaces(
    filePath: string,
    now: string,
    deviceId?: string,
  ): Promise<readonly InkSurfaceRecord[]> {
    const loaded = await this.listSurfaces(filePath);
    const reclaimed: InkSurfaceRecord[] = [];
    for (const record of loaded.records) {
      if (
        record.schemaVersion >= 2 ||
        record.deletedAt !== undefined ||
        record.strokes.some((stroke) => stroke.tool !== 'eraser')
      ) {
        continue;
      }
      reclaimed.push(await this.tombstoneSurface(filePath, record.id, now, deviceId));
    }
    return reclaimed;
  }

  async restoreSurface(
    filePath: string,
    surfaceId: string,
    now: string,
    deviceId?: string,
    expectedRevision?: number,
  ): Promise<InkSurfaceRecord> {
    const current = await this.readSurface(filePath, surfaceId);
    if (current === null) throw new Error(`Ink surface ${surfaceId} does not exist.`);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new Error(`Ink surface ${surfaceId} changed since it was deleted.`);
    }
    if (current.deletedAt === undefined) return current;
    const { deletedAt: _deletedAt, ...active } = current;
    void _deletedAt;
    const restored: InkSurfaceRecord = {
      ...active,
      ...(deviceId === undefined ? {} : { deviceId }),
      revision: current.revision + 1,
      updatedAt: now,
    };
    await this.updateSurface(restored);
    return restored;
  }

  async listSurfaces(filePath: string): Promise<{
    readonly conflicts: readonly InkSurfaceConflict[];
    readonly issues: readonly InkSurfaceRepositoryIssue[];
    readonly records: readonly InkSurfaceRecord[];
  }> {
    return this.withNoteBatchLock(filePath, () => this.listSurfacesNow(filePath));
  }

  async reconcileNotePath(filePath: string, now: string): Promise<readonly InkSurfaceRecord[]> {
    const normalizedPath = normalizeVaultPath(filePath);
    return this.withNoteBatchLock(normalizedPath, async () => {
      const root = await this.surfaceRoot(normalizedPath);
      const readable: Array<{ readonly path: string; readonly record: InkSurfaceRecord }> = [];
      const updated: InkSurfaceRecord[] = [];
      for (const filename of (await this.store.list(root)).filter((name) =>
        name.endsWith('.json'),
      )) {
        const path = `${root}/${filename}`;
        const contents = await this.store.read(path);
        if (contents === null) continue;
        const decoded = safeDecodeInkSurfaceRecord(contents);
        if (decoded.kind === 'unsupported') {
          throw new InkSurfaceUnsupportedError(path, decoded.reason);
        }
        if (decoded.kind === 'corrupt') {
          // Preserve damaged/conflict artifacts byte-for-byte for explicit repair.
          continue;
        }
        readable.push({ path, record: decoded.record });
      }
      for (const { path, record } of readable) {
        if (normalizeVaultPath(record.filePath) === normalizedPath) continue;
        const reconciled: InkSurfaceRecord = {
          ...record,
          filePath: normalizedPath,
          revision: record.revision + 1,
          updatedAt: now,
        };
        await this.store.write(path, encodeInkSurfaceRecord(reconciled));
        updated.push(reconciled);
      }
      const loaded = await this.listSurfacesNow(normalizedPath);
      await this.writeSummaryIndex(normalizedPath, summarizeLoadedSurfaces(loaded));
      for (const record of updated) this.onSurfaceChanged(record);
      return updated;
    });
  }

  private async listSurfacesNow(filePath: string): Promise<LoadedInkSurfaces> {
    const root = await this.surfaceRoot(filePath);
    const filenames = await this.store.list(root);
    const candidates: InkSurfaceCandidate[] = [];
    const issues: InkSurfaceRepositoryIssue[] = [];

    const files = await Promise.all(
      filenames
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map(async (filename) => {
          const path = `${root}/${filename}`;
          return { contents: await this.store.read(path), path };
        }),
    );
    for (const { contents, path } of files) {
      if (contents === null) {
        continue;
      }
      const decoded = safeDecodeInkSurfaceRecord(contents);
      if (decoded.kind === 'unsupported') {
        issues.push({
          kind: 'unsupported-record',
          message: unsupportedInkMessage(path, decoded.reason),
          path,
          reason: decoded.reason,
        });
        continue;
      }
      if (decoded.kind === 'corrupt') {
        issues.push({
          kind: 'corrupt-record',
          message:
            decoded.reason === 'invalid-json'
              ? 'Ink surface record is not valid JSON.'
              : 'Ink surface record does not match a supported schema version.',
          path,
        });
        continue;
      }
      if (normalizeVaultPath(decoded.record.filePath) !== normalizeVaultPath(filePath)) {
        issues.push({
          kind: 'corrupt-record',
          message: 'Ink surface file path does not match its note directory.',
          path,
        });
        continue;
      }
      candidates.push({ path, record: decoded.record });
    }

    const grouped = new Map<string, InkSurfaceCandidate[]>();
    for (const candidate of candidates) {
      const siblings = grouped.get(candidate.record.id) ?? [];
      siblings.push(candidate);
      grouped.set(candidate.record.id, siblings);
    }

    const conflicts: InkSurfaceConflict[] = [];
    const records: InkSurfaceRecord[] = [];
    for (const [surfaceId, siblings] of grouped) {
      const ordered = [...siblings].sort(compareCandidates);
      const highestRevision = ordered[0]?.record.revision;
      if (highestRevision === undefined) {
        continue;
      }
      const latest = ordered.filter((candidate) => candidate.record.revision === highestRevision);
      const selected = selectPreferredCandidate(latest, surfaceId);
      if (hasSchemaV3Mismatch(ordered)) {
        conflicts.push({
          candidates: ordered,
          kind: 'schema-version-mismatch',
          selectedPath: selected.path,
          surfaceId,
        });
        issues.push({
          kind: 'conflict',
          message: `Ink surface ${surfaceId} has a schema-version-mismatch across visible artifacts; no candidate is editable.`,
          path: selected.path,
        });
        continue;
      }
      records.push(selected.record);
      if (ordered.length > 1) {
        const divergent = hasDivergentRecords(latest);
        const conflict: InkSurfaceConflict = {
          candidates: ordered,
          kind: divergent ? 'same-revision-divergence' : 'duplicate-artifact',
          selectedPath: selected.path,
          surfaceId,
        };
        conflicts.push(conflict);
        issues.push({
          kind: divergent ? 'conflict' : 'duplicate-artifact',
          message: divergent
            ? `Ink surface ${surfaceId} has divergent candidates at revision ${highestRevision}.`
            : `Ink surface ${surfaceId} has ${ordered.length} visible artifacts; revision ${highestRevision} is selected without deleting any artifact.`,
          path: selected.path,
        });
      }
    }

    return {
      conflicts: conflicts.sort((left, right) => left.surfaceId.localeCompare(right.surfaceId)),
      issues,
      records: records.sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  private async assertNoteIdentity(record: InkSurfaceRecord): Promise<void> {
    const noteRoot = await this.noteRoot(record.filePath);
    const contents = await this.store.read(`${noteRoot}/meta.json`);
    if (contents === null) {
      throw new Error('Ink surface note identity is missing; reconcile the note before writing.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error('Ink surface note identity metadata is corrupt.', { cause: error });
    }
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== 1 ||
      parsed.noteId !== record.noteId ||
      parsed.filePath !== normalizeVaultPath(record.filePath)
    ) {
      throw new Error('Ink surface note identity does not match canonical note metadata.');
    }
  }

  private async assertCanonicalProjectionWritable(filePath: string): Promise<LoadedInkSurfaces> {
    const loaded = await this.listSurfacesNow(filePath);
    const block = findInkSurfaceCanonicalProjectionBlock(loaded);
    if (block?.kind === 'conflict') {
      throw new InkSurfaceConflictError(block.conflict);
    }
    if (block?.kind === 'unsupported-record') {
      if (block.issue.reason === undefined) {
        throw new Error(
          `Ink at ${block.issue.path} is unsupported; update Inkstone before editing this note.`,
        );
      }
      throw new InkSurfaceUnsupportedError(block.issue.path, block.issue.reason);
    }
    if (block?.kind === 'corrupt-record') {
      throw new InkSurfaceCorruptError(block.issue);
    }
    return loaded;
  }

  private async assertActiveSchemaCompatible(record: InkSurfaceRecord): Promise<void> {
    if (!isActiveSurface(record)) return;
    const loaded = await this.listSurfacesNow(record.filePath);
    if (
      loaded.records.some(
        (existing) =>
          existing.id !== record.id &&
          isActiveSurface(existing) &&
          crossesSchemaV3Boundary(existing, record),
      )
    ) {
      throw new Error('Ink note cannot contain mixed legacy and schema v3 active surfaces.');
    }
  }

  private async readCandidates(
    filePath: string,
    surfaceId: string,
  ): Promise<readonly InkSurfaceCandidate[]> {
    normalizeSurfaceId(surfaceId);
    const root = await this.surfaceRoot(filePath);
    const candidates: InkSurfaceCandidate[] = [];
    const files = await Promise.all(
      (await this.store.list(root))
        .filter((filename) => mayContainSurfaceCandidate(filename, surfaceId))
        .map(async (filename) => {
          const path = `${root}/${filename}`;
          return { contents: await this.store.read(path), path };
        }),
    );
    for (const { contents, path } of files) {
      if (contents === null) {
        continue;
      }
      const decoded = safeDecodeInkSurfaceRecord(contents);
      if (decoded.kind === 'unsupported') {
        throw new InkSurfaceUnsupportedError(path, decoded.reason);
      }
      if (decoded.kind === 'corrupt') {
        // listSurfaces reports damaged siblings; they cannot be a safe update base.
        continue;
      }
      const record = decoded.record;
      if (
        record.id === surfaceId &&
        normalizeVaultPath(record.filePath) === normalizeVaultPath(filePath)
      ) {
        candidates.push({ path, record });
      }
    }
    return candidates.sort(compareCandidates);
  }

  private async noteRoot(filePath: string): Promise<string> {
    return `${SIDECAR_ROOT}/${await hashText(normalizeVaultPath(filePath))}`;
  }

  private async surfaceRoot(filePath: string): Promise<string> {
    return `${await this.noteRoot(filePath)}/surfaces`;
  }

  private async surfacePath(filePath: string, surfaceId: string): Promise<string> {
    return `${await this.surfaceRoot(filePath)}/${normalizeSurfaceId(surfaceId)}.json`;
  }

  private async summaryIndexPath(filePath: string): Promise<string> {
    return `${await this.noteRoot(filePath)}/ink-summaries.json`;
  }

  private async batchJournalPath(filePath: string): Promise<string> {
    return `${await this.noteRoot(filePath)}/ink-batch-journal.json`;
  }

  private recoverAtomicBatch(filePath: string): Promise<void> {
    const normalized = normalizeVaultPath(filePath);
    return this.enqueueWrite(batchWriteKey(normalized), () =>
      this.recoverAtomicBatchNow(normalized),
    );
  }

  private withNoteBatchLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const normalized = normalizeVaultPath(filePath);
    return this.enqueueWrite(batchWriteKey(normalized), async () => {
      await this.recoverAtomicBatchNow(normalized);
      return operation();
    });
  }

  private async recoverAtomicBatchNow(filePath: string): Promise<void> {
    const journalPath = await this.batchJournalPath(filePath);
    const contents = await this.store.read(journalPath);
    if (contents === null || contents === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error('Ink batch recovery journal is corrupt; manual repair is required.', {
        cause: error,
      });
    }
    const root = `${await this.surfaceRoot(filePath)}/`;
    if (!isInkSurfaceBatchJournal(parsed, filePath, root)) {
      throw new Error('Ink batch recovery journal is invalid; manual repair is required.');
    }
    try {
      for (const entry of parsed.entries) {
        await this.assertNoteIdentity(decodeInkSurfaceRecord(entry.nextContents));
      }
    } catch (error) {
      throw new Error('Ink batch recovery journal is invalid; manual repair is required.', {
        cause: error,
      });
    }

    const canonicalEntries: Array<{
      readonly contents: string;
      readonly path: string;
    }> = [];
    for (const entry of parsed.entries) {
      const canonicalPath = normalizeVaultPath(entry.path);
      const canonicalContents = await this.store.read(canonicalPath);
      if (
        canonicalContents === null ||
        (canonicalContents !== entry.previousContents && canonicalContents !== entry.nextContents)
      ) {
        throw new Error(
          'Ink batch recovery journal canonical bytes changed after the journal was prepared; manual repair is required.',
        );
      }
      canonicalEntries.push({
        contents: parsed.phase === 'committed' ? entry.nextContents : entry.previousContents,
        path: canonicalPath,
      });
    }
    for (const entry of canonicalEntries) {
      await this.store.write(entry.path, entry.contents);
    }
    await this.invalidateSummaryIndex(filePath);
    await this.clearBatchJournal(journalPath);
  }

  private async invalidateSummaryIndex(filePath: string): Promise<void> {
    const path = await this.summaryIndexPath(filePath);
    if (this.store.remove !== undefined) {
      await this.store.remove(path);
      return;
    }
    await this.store.write(path, '');
  }

  private async clearBatchJournal(path: string): Promise<void> {
    if (this.store.remove !== undefined) {
      await this.store.remove(path);
      return;
    }
    await this.store.write(path, '');
  }

  private async refreshSummaryIndex(
    record: InkSurfaceRecord,
    loaded?: LoadedInkSurfaces,
    checkpoint?: InkColdLaneCheckpoint,
  ): Promise<void> {
    return this.refreshSummaryIndexes([record], loaded, checkpoint);
  }

  private async refreshSummaryIndexes(
    records: readonly InkSurfaceRecord[],
    loadedSnapshot?: LoadedInkSurfaces,
    checkpoint?: InkColdLaneCheckpoint,
  ): Promise<void> {
    const first = records[0];
    if (first === undefined) return;
    const normalizedFilePath = normalizeVaultPath(first.filePath);
    if (records.some(({ filePath }) => normalizeVaultPath(filePath) !== normalizedFilePath)) {
      throw new Error('Ink summary refresh batch must stay within one note.');
    }
    const key = summaryWriteKey(first.filePath);
    await this.enqueueWrite(key, async () => {
      await checkpoint?.();
      const path = await this.summaryIndexPath(first.filePath);
      await checkpoint?.();
      const linkedSummaryImpact =
        records.some((record) => record.strokes.some(hasLinkedLogicalStroke)) ||
        loadedSnapshot?.records.some(
          (record) =>
            records.some(({ id }) => id === record.id) &&
            record.strokes.some(hasLinkedLogicalStroke),
        ) === true;
      if (linkedSummaryImpact) {
        const previous = loadedSnapshot ?? (await this.listSurfacesNow(first.filePath));
        await checkpoint?.();
        const loaded = replaceLoadedInkSurfaces(previous, records);
        try {
          const contents = await this.store.read(path);
          await checkpoint?.();
          const existing = contents === null ? null : decodeSummaryIndexOrNull(contents);
          const next =
            existing === null || !summarySetMatchesRecords(existing.summaries, loaded.records)
              ? summarizeLoadedSurfaces(loaded)
              : rebuildAffectedInkSummaries({
                  affectedIds: affectedInkSummarySurfaceIds({
                    current: loaded.records,
                    previous: previous.records,
                    replacements: records,
                  }),
                  existing: existing.summaries,
                  loaded,
                });
          await this.writeSummaryIndex(first.filePath, next, checkpoint);
        } catch (error) {
          await this.store.remove?.(path).catch(() => undefined);
          throw error;
        }
        return;
      }
      const contents = await this.store.read(path);
      await checkpoint?.();
      let summaries: readonly InkSurfaceSummary[] = [];
      if (contents !== null) {
        try {
          summaries = decodeInkSurfaceSummaryIndex(contents).summaries;
        } catch {
          summaries = [];
        }
      }
      const next = [
        ...summaries.filter((summary) => !records.some(({ id }) => summary.id === id)),
        ...records.map((record) => summarizeInkSurface(record)),
      ];
      try {
        await this.writeSummaryIndex(first.filePath, next, checkpoint);
      } catch (error) {
        await this.store.remove?.(path).catch(() => undefined);
        throw error;
      }
    }).catch(() => undefined);
  }

  private async writeSummaryIndex(
    filePath: string,
    summaries: readonly InkSurfaceSummary[],
    checkpoint?: InkColdLaneCheckpoint,
  ): Promise<void> {
    const path = await this.summaryIndexPath(filePath);
    await checkpoint?.();
    const index: InkSurfaceSummaryIndex = {
      filePath: normalizeVaultPath(filePath),
      schemaVersion: 1,
      summaries: sortSummaries(summaries),
    };
    await this.store.write(path, encodeInkSurfaceSummaryIndex(index));
    await checkpoint?.();
  }

  private async enqueueWrite<T>(key: string, write: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(write);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.writes.set(key, tail);
    void tail.then(() => {
      if (this.writes.get(key) === tail) {
        this.writes.delete(key);
      }
    });
    return operation;
  }
}

function sharedVaultWrites(scope: object): Map<string, Promise<void>> {
  const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>;
  let registry = globalRecord[SHARED_WRITE_COORDINATOR] as
    WeakMap<object, Map<string, Promise<void>>> | undefined;
  if (registry === undefined) {
    registry = new WeakMap();
    globalRecord[SHARED_WRITE_COORDINATOR] = registry;
  }
  let writes = registry.get(scope);
  if (writes === undefined) {
    writes = new Map();
    registry.set(scope, writes);
  }
  return writes;
}

function sortSummaries(summaries: readonly InkSurfaceSummary[]): readonly InkSurfaceSummary[] {
  return [...summaries].sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

function summarizeLoadedSurfaces(loaded: {
  readonly conflicts: readonly InkSurfaceConflict[];
  readonly records: readonly InkSurfaceRecord[];
}): readonly InkSurfaceSummary[] {
  const conflicted = new Set(
    loaded.conflicts
      .filter(({ kind }) => kind === 'same-revision-divergence')
      .map(({ surfaceId }) => surfaceId),
  );
  return loaded.records.map((record) =>
    summarizeInkSurface(record, {
      conflict: conflicted.has(record.id),
      relatedRecords: loaded.records,
    }),
  );
}

function decodeSummaryIndexOrNull(contents: string): InkSurfaceSummaryIndex | null {
  try {
    return decodeInkSurfaceSummaryIndex(contents);
  } catch {
    return null;
  }
}

function summarySetMatchesRecords(
  summaries: readonly InkSurfaceSummary[],
  records: readonly InkSurfaceRecord[],
): boolean {
  if (summaries.length !== records.length) return false;
  const ids = new Set(summaries.map(({ id }) => id));
  return ids.size === records.length && records.every(({ id }) => ids.has(id));
}

function rebuildAffectedInkSummaries(input: {
  readonly affectedIds: readonly string[];
  readonly existing: readonly InkSurfaceSummary[];
  readonly loaded: LoadedInkSurfaces;
}): readonly InkSurfaceSummary[] {
  const affected = new Set(input.affectedIds);
  const conflicted = new Set(
    input.loaded.conflicts
      .filter(({ kind }) => kind === 'same-revision-divergence')
      .map(({ surfaceId }) => surfaceId),
  );
  const rebuilt = input.loaded.records
    .filter(({ id }) => affected.has(id))
    .map((record) => {
      const linkedIds = new Set(
        record.strokes
          .map(({ linkedStrokeId }) => linkedStrokeId)
          .filter((id): id is string => id !== undefined),
      );
      const relatedRecords = input.loaded.records.filter(
        (candidate) =>
          candidate.id === record.id ||
          candidate.strokes.some((stroke) => linkedIds.has(stroke.linkedStrokeId ?? '')),
      );
      return summarizeInkSurface(record, {
        conflict: conflicted.has(record.id),
        relatedRecords,
      });
    });
  return sortSummaries([...input.existing.filter(({ id }) => !affected.has(id)), ...rebuilt]);
}

function replaceLoadedInkSurfaces(
  loaded: LoadedInkSurfaces,
  replacements: readonly InkSurfaceRecord[],
): LoadedInkSurfaces {
  const byId = new Map(replacements.map((record) => [record.id, record]));
  const seen = new Set<string>();
  const records = loaded.records.map((record) => {
    const replacement = byId.get(record.id);
    if (replacement === undefined) return record;
    seen.add(record.id);
    return replacement;
  });
  for (const replacement of replacements) {
    if (!seen.has(replacement.id)) records.push(replacement);
  }
  return { ...loaded, records: records.sort((left, right) => left.id.localeCompare(right.id)) };
}

function compareCandidates(left: InkSurfaceCandidate, right: InkSurfaceCandidate): number {
  return right.record.revision - left.record.revision || left.path.localeCompare(right.path);
}

function selectPreferredCandidate(
  candidates: readonly InkSurfaceCandidate[],
  surfaceId: string,
): InkSurfaceCandidate {
  const canonicalSuffix = `/${surfaceId}.json`;
  const selected =
    candidates.find((candidate) => candidate.path.endsWith(canonicalSuffix)) ?? candidates[0];
  if (selected === undefined) {
    throw new Error(`Ink surface ${surfaceId} has no readable candidates.`);
  }
  return selected;
}

function selectLatestCandidate(
  candidates: readonly InkSurfaceCandidate[],
  surfaceId: string,
): InkSurfaceCandidate {
  const ordered = [...candidates].sort(compareCandidates);
  const highestRevision = ordered[0]?.record.revision;
  if (highestRevision === undefined) {
    throw new Error(`Ink surface ${surfaceId} has no readable candidates.`);
  }
  const latest = ordered.filter((candidate) => candidate.record.revision === highestRevision);
  const selected = selectPreferredCandidate(latest, surfaceId);
  if (hasSchemaV3Mismatch(ordered)) {
    throw new InkSurfaceConflictError({
      candidates: ordered,
      kind: 'schema-version-mismatch',
      selectedPath: selected.path,
      surfaceId,
    });
  }
  if (hasDivergentRecords(latest)) {
    throw new InkSurfaceConflictError({
      candidates: ordered,
      kind: 'same-revision-divergence',
      selectedPath: selected.path,
      surfaceId,
    });
  }
  return selected;
}

function hasDivergentRecords(candidates: readonly InkSurfaceCandidate[]): boolean {
  return new Set(candidates.map((candidate) => encodeInkSurfaceRecord(candidate.record))).size > 1;
}

function hasSchemaV3Mismatch(candidates: readonly InkSurfaceCandidate[]): boolean {
  return new Set(candidates.map(({ record }) => record.schemaVersion === 3)).size > 1;
}

function sameSurfaceRecord(left: InkSurfaceRecord, right: InkSurfaceRecord): boolean {
  return encodeInkSurfaceRecord(left) === encodeInkSurfaceRecord(right);
}

function crossesSchemaV3Boundary(left: InkSurfaceRecord, right: InkSurfaceRecord): boolean {
  return (left.schemaVersion === 3) !== (right.schemaVersion === 3);
}

function isActiveSurface(record: InkSurfaceRecord): boolean {
  return record.status === 'active' && record.deletedAt === undefined;
}

function hasLinkedLogicalStroke(stroke: InkSurfaceRecord['strokes'][number]): boolean {
  return stroke.linkedStrokeId !== undefined;
}

function mayContainSurfaceCandidate(filename: string, surfaceId: string): boolean {
  if (!filename.endsWith('.json')) return false;
  const stem = filename.slice(0, -'.json'.length);
  return stem === surfaceId || stem.startsWith(`${surfaceId} `);
}

function assertColdSchemaUpgrade(input: {
  readonly currentActive: readonly InkSurfaceRecord[];
  readonly expectedBases: readonly InkSurfaceRecord[];
  readonly records: readonly InkSurfaceRecord[];
}): void {
  const { currentActive, expectedBases, records } = input;
  const currentById = new Map(currentActive.map((record) => [record.id, record]));
  if (
    currentActive.length !== expectedBases.length ||
    expectedBases.length !== records.length ||
    expectedBases.some((expected) => {
      const current = currentById.get(expected.id);
      return current === undefined || !sameSurfaceRecord(current, expected);
    }) ||
    !expectedBases.some(({ schemaVersion }) => schemaVersion < 3)
  ) {
    throw new Error('Ink cold schema-v3 upgrade base is stale or incomplete.');
  }
  const updatedAt = records[0]?.updatedAt;
  if (updatedAt === undefined) {
    throw new Error('Ink cold schema-v3 upgrade is empty.');
  }
  const exact = upgradeInkSurfaceRecordsToV3(expectedBases, updatedAt);
  if (
    exact.length !== records.length ||
    exact.some((candidate, index) => {
      const record = records[index];
      return record === undefined || !sameSurfaceRecord(candidate, record);
    })
  ) {
    throw new Error('Ink cold schema-v3 upgrade is not the exact normalized document.');
  }
}

function alignExpectedBases(
  records: readonly InkSurfaceRecord[],
  expectedBases: readonly InkSurfaceRecord[] | undefined,
): ReadonlyMap<string, InkSurfaceRecord> | undefined {
  if (expectedBases === undefined) return undefined;
  const byId = new Map<string, InkSurfaceRecord>();
  for (const expectedBase of expectedBases) {
    if (byId.has(expectedBase.id)) {
      throw new Error('Atomic Ink expected bases contain duplicate surface IDs.');
    }
    byId.set(expectedBase.id, expectedBase);
  }
  if (byId.size !== records.length || records.some((record) => !byId.has(record.id))) {
    throw new Error('Atomic Ink expected bases must align exactly by surface ID.');
  }
  return byId;
}

function normalizeSurfaceId(surfaceId: string): string {
  if (!/^[a-zA-Z0-9-]+$/u.test(surfaceId)) {
    throw new Error('Ink surface ID contains unsupported path characters.');
  }
  return surfaceId;
}

function unsupportedInkMessage(path: string, reason: InkSurfaceUnsupportedReason): string {
  return `Ink at ${path} uses unsupported canonical data (${reason}); update Inkstone before editing this note.`;
}

function surfaceWriteKey(filePath: string, surfaceId: string): string {
  return `surface\u0000${normalizeVaultPath(filePath)}\u0000${normalizeSurfaceId(surfaceId)}`;
}

function batchWriteKey(filePath: string): string {
  return `batch\u0000${normalizeVaultPath(filePath)}`;
}

function summaryWriteKey(filePath: string): string {
  return `summary\u0000${normalizeVaultPath(filePath)}`;
}

function isInkSurfaceBatchJournal(
  value: unknown,
  filePath: string,
  surfaceRoot: string,
): value is InkSurfaceBatchJournal {
  let normalizedJournalFilePath: string;
  let normalizedRequestedFilePath: string;
  try {
    normalizedJournalFilePath =
      isRecord(value) && typeof value.filePath === 'string'
        ? normalizeVaultPath(value.filePath)
        : '';
    normalizedRequestedFilePath = normalizeVaultPath(filePath);
  } catch {
    return false;
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    (value.phase !== 'prepared' && value.phase !== 'committed') ||
    typeof value.filePath !== 'string' ||
    value.filePath !== normalizedJournalFilePath ||
    normalizedJournalFilePath !== normalizedRequestedFilePath ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  ) {
    return false;
  }
  const paths = value.entries.map((entry) =>
    isRecord(entry) && typeof entry.path === 'string' ? entry.path : null,
  );
  if (paths.some((path) => path === null) || new Set(paths).size !== paths.length) {
    return false;
  }
  if (
    !value.entries.every((entry) =>
      isValidInkSurfaceBatchJournalEntry(entry, filePath, surfaceRoot),
    )
  ) {
    return false;
  }
  const schemaActivation = value.schemaActivation;
  if (schemaActivation !== undefined && !isValidJournalSchemaActivation(schemaActivation)) {
    return false;
  }
  const schemaUpgrade = value.schemaUpgrade;
  if (schemaUpgrade !== undefined && !isValidJournalSchemaUpgrade(schemaUpgrade)) return false;
  if (schemaActivation !== undefined && schemaUpgrade !== undefined) return false;
  let crossesV3Boundary = false;
  const previousContents: string[] = [];
  for (const entry of value.entries) {
    if (!isRecord(entry)) return false;
    const previousBytes = entry.previousContents;
    const nextBytes = entry.nextContents;
    if (typeof previousBytes !== 'string' || typeof nextBytes !== 'string') return false;
    const previous = decodeInkSurfaceRecord(previousBytes);
    const next = decodeInkSurfaceRecord(nextBytes);
    previousContents.push(previousBytes);
    crossesV3Boundary ||= crossesSchemaV3Boundary(previous, next);
  }
  if (
    crossesV3Boundary &&
    !isValidJournalSchemaActivation(schemaActivation) &&
    !isValidJournalSchemaUpgrade(schemaUpgrade)
  ) {
    return false;
  }
  const sourceBaseDigest = schemaActivation?.sourceBaseDigest ?? schemaUpgrade?.sourceBaseDigest;
  return (
    sourceBaseDigest === undefined ||
    sourceBaseDigest === digestInkBrushGolden({ sourceSurfaceBytes: previousContents })
  );
}

function isValidJournalSchemaActivation(
  value: unknown,
): value is NonNullable<InkSurfaceBatchJournal['schemaActivation']> {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    typeof value.planDigest === 'string' &&
    /^[0-9a-f]{8}$/u.test(value.planDigest) &&
    value.planReference === `ink-schema-v3-plan:${value.planDigest}` &&
    typeof value.sourceBaseDigest === 'string' &&
    /^[0-9a-f]{8}$/u.test(value.sourceBaseDigest)
  );
}

function isValidJournalSchemaUpgrade(
  value: unknown,
): value is NonNullable<InkSurfaceBatchJournal['schemaUpgrade']> {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.kind === 'cold-v3-normalization' &&
    typeof value.sourceBaseDigest === 'string' &&
    /^[0-9a-f]{8}$/u.test(value.sourceBaseDigest)
  );
}

function isValidInkSurfaceBatchJournalEntry(
  entry: unknown,
  filePath: string,
  surfaceRoot: string,
): boolean {
  if (
    !isRecord(entry) ||
    typeof entry.path !== 'string' ||
    !isCanonicalJournalSurfacePath(entry.path, surfaceRoot) ||
    typeof entry.previousContents !== 'string' ||
    typeof entry.nextContents !== 'string'
  ) {
    return false;
  }
  const filename = entry.path.slice(surfaceRoot.length);
  const surfaceId = filename.slice(0, -'.json'.length);
  try {
    const previous = decodeInkSurfaceRecord(entry.previousContents);
    const next = decodeInkSurfaceRecord(entry.nextContents);
    const normalizedFilePath = normalizeVaultPath(filePath);
    return (
      previous.id === surfaceId &&
      next.id === surfaceId &&
      previous.filePath === normalizedFilePath &&
      next.filePath === normalizedFilePath &&
      previous.noteId === next.noteId &&
      next.revision === previous.revision + 1
    );
  } catch {
    return false;
  }
}

function isCanonicalJournalSurfacePath(path: string, surfaceRoot: string): boolean {
  try {
    const normalized = normalizeVaultPath(path);
    return (
      normalized === path &&
      normalized.startsWith(surfaceRoot) &&
      /^[a-zA-Z0-9-]+\.json$/u.test(normalized.slice(surfaceRoot.length))
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
