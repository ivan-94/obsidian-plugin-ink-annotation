import {
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  type InkSurfaceRecord,
} from '../domain/ink-surface';
import {
  planConcurrentInkAppendMerge,
  type InkConcurrentAppendConflictReason,
} from '../domain/ink-concurrent-append-merge';
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
  readonly kind: 'duplicate-artifact' | 'same-revision-divergence';
  readonly selectedPath: string;
  readonly surfaceId: string;
}

export interface InkSurfaceRepositoryIssue {
  readonly kind: 'conflict' | 'corrupt-record' | 'duplicate-artifact';
  readonly message: string;
  readonly path: string;
}

interface InkSurfaceBatchJournal {
  readonly entries: readonly {
    readonly nextContents: string;
    readonly path: string;
    readonly previousContents: string;
  }[];
  readonly filePath: string;
  readonly phase: 'committed' | 'prepared';
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
        const candidates = await this.readCandidates(record.filePath, record.id);
        if (candidates.length > 0) {
          throw new Error(`Cannot create existing ink surface ${record.id}.`);
        }
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
  ): Promise<InkSurfaceRecord | void> {
    const key = surfaceWriteKey(record.filePath, record.id);
    return this.withNoteBatchLock(record.filePath, () =>
      this.enqueueWrite(key, async () => {
        await this.assertNoteIdentity(record);
        const candidates = await this.readCandidates(record.filePath, record.id);
        if (candidates.length === 0) {
          throw new Error(`Cannot update missing ink surface ${record.id}.`);
        }
        const existing = selectLatestCandidate(candidates, record.id).record;
        if (sameSurfaceRecord(existing, record)) {
          await this.refreshSummaryIndex(record);
          this.onSurfaceChanged(record);
          return;
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
            await this.refreshSummaryIndex(plan.record);
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
        const previousContents = await this.store.read(path);
        try {
          await this.store.write(path, encodeInkSurfaceRecord(nextRecord));
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
        await this.refreshSummaryIndex(nextRecord);
        this.onSurfaceChanged(nextRecord);
        return rebased ? nextRecord : undefined;
      }),
    );
  }

  /** Commits a cross-surface document mutation as all-old or all-new canonical bytes. */
  async updateSurfacesAtomically(
    records: readonly InkSurfaceRecord[],
    expectedBases?: readonly InkSurfaceRecord[],
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
      const prepared: Array<{
        readonly path: string;
        readonly previousContents: string;
        readonly record: InkSurfaceRecord;
      }> = [];
      const committedRecords: InkSurfaceRecord[] = [];
      let rebased = false;
      for (const record of records) {
        await this.assertNoteIdentity(record);
        const candidates = await this.readCandidates(record.filePath, record.id);
        if (candidates.length === 0) {
          throw new Error(`Cannot update missing ink surface ${record.id}.`);
        }
        const existing = selectLatestCandidate(candidates, record.id).record;
        if (sameSurfaceRecord(existing, record)) {
          committedRecords.push(existing);
          continue;
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
        const previousContents = await this.store.read(path);
        if (previousContents === null) {
          throw new Error(`Canonical Ink surface ${record.id} disappeared during batch update.`);
        }
        prepared.push({ path, previousContents, record: nextRecord });
        committedRecords.push(nextRecord);
      }

      if (prepared.length === 0) {
        for (const record of committedRecords) await this.refreshSummaryIndex(record);
        for (const record of committedRecords) this.onSurfaceChanged(record);
        return rebased ? committedRecords : undefined;
      }
      if (prepared.length !== records.length) {
        throw new Error('Atomic Ink update cannot mix idempotent and advancing surfaces.');
      }

      const journalPath = await this.batchJournalPath(filePath);
      const journal: InkSurfaceBatchJournal = {
        entries: prepared.map((item) => ({
          nextContents: encodeInkSurfaceRecord(item.record),
          path: item.path,
          previousContents: item.previousContents,
        })),
        filePath,
        phase: 'prepared',
        schemaVersion: 1,
      };
      await this.store.write(journalPath, JSON.stringify(journal));
      try {
        for (const item of prepared) {
          await this.store.write(item.path, encodeInkSurfaceRecord(item.record));
        }
        await this.store.write(journalPath, JSON.stringify({ ...journal, phase: 'committed' }));
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
      for (const { record } of prepared) await this.refreshSummaryIndex(record);
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
        record.schemaVersion === 2 ||
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
      const updated: InkSurfaceRecord[] = [];
      for (const filename of (await this.store.list(root)).filter((name) =>
        name.endsWith('.json'),
      )) {
        const path = `${root}/${filename}`;
        const contents = await this.store.read(path);
        if (contents === null) continue;
        let record: InkSurfaceRecord;
        try {
          record = decodeInkSurfaceRecord(contents);
        } catch {
          // Preserve damaged/conflict artifacts byte-for-byte for explicit repair.
          continue;
        }
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

  private async listSurfacesNow(filePath: string): Promise<{
    readonly conflicts: readonly InkSurfaceConflict[];
    readonly issues: readonly InkSurfaceRepositoryIssue[];
    readonly records: readonly InkSurfaceRecord[];
  }> {
    const root = await this.surfaceRoot(filePath);
    const filenames = await this.store.list(root);
    const candidates: InkSurfaceCandidate[] = [];
    const issues: InkSurfaceRepositoryIssue[] = [];

    for (const filename of filenames.filter((name) => name.endsWith('.json')).sort()) {
      const path = `${root}/${filename}`;
      const contents = await this.store.read(path);
      if (contents === null) {
        continue;
      }
      try {
        const record = decodeInkSurfaceRecord(contents);
        if (normalizeVaultPath(record.filePath) !== normalizeVaultPath(filePath)) {
          throw new Error('Ink surface file path does not match its note directory.');
        }
        candidates.push({ path, record });
      } catch (error) {
        issues.push({
          kind: 'corrupt-record',
          message: error instanceof Error ? error.message : String(error),
          path,
        });
      }
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

  private async readCandidates(
    filePath: string,
    surfaceId: string,
  ): Promise<readonly InkSurfaceCandidate[]> {
    normalizeSurfaceId(surfaceId);
    const root = await this.surfaceRoot(filePath);
    const candidates: InkSurfaceCandidate[] = [];
    for (const filename of (await this.store.list(root)).filter((name) => name.endsWith('.json'))) {
      const path = `${root}/${filename}`;
      const contents = await this.store.read(path);
      if (contents === null) {
        continue;
      }
      try {
        const record = decodeInkSurfaceRecord(contents);
        if (
          record.id === surfaceId &&
          normalizeVaultPath(record.filePath) === normalizeVaultPath(filePath)
        ) {
          candidates.push({ path, record });
        }
      } catch {
        // listSurfaces reports damaged siblings; they cannot be a safe update base.
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

  private async refreshSummaryIndex(record: InkSurfaceRecord): Promise<void> {
    const key = summaryWriteKey(record.filePath);
    await this.enqueueWrite(key, async () => {
      const path = await this.summaryIndexPath(record.filePath);
      const contents = await this.store.read(path);
      let summaries: readonly InkSurfaceSummary[] = [];
      if (contents !== null) {
        try {
          summaries = decodeInkSurfaceSummaryIndex(contents).summaries;
        } catch {
          summaries = [];
        }
      }
      const next = [
        ...summaries.filter((summary) => summary.id !== record.id),
        summarizeInkSurface(record),
      ];
      try {
        await this.writeSummaryIndex(record.filePath, next);
      } catch (error) {
        await this.store.remove?.(path).catch(() => undefined);
        throw error;
      }
    }).catch(() => undefined);
  }

  private async writeSummaryIndex(
    filePath: string,
    summaries: readonly InkSurfaceSummary[],
  ): Promise<void> {
    const path = await this.summaryIndexPath(filePath);
    const index: InkSurfaceSummaryIndex = {
      filePath: normalizeVaultPath(filePath),
      schemaVersion: 1,
      summaries: sortSummaries(summaries),
    };
    await this.store.write(path, encodeInkSurfaceSummaryIndex(index));
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
    summarizeInkSurface(record, { conflict: conflicted.has(record.id) }),
  );
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

function sameSurfaceRecord(left: InkSurfaceRecord, right: InkSurfaceRecord): boolean {
  return encodeInkSurfaceRecord(left) === encodeInkSurfaceRecord(right);
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
  return value.entries.every((entry) =>
    isValidInkSurfaceBatchJournalEntry(entry, filePath, surfaceRoot),
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
