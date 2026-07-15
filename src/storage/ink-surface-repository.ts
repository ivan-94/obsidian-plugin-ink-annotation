import {
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  type InkSurfaceRecord,
} from '../domain/ink-surface';
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

export class InkSurfaceConflictError extends Error {
  constructor(readonly conflict: InkSurfaceConflict) {
    super(`Ink surface ${conflict.surfaceId} has divergent candidates that require repair.`);
    this.name = 'InkSurfaceConflictError';
  }
}

/** Canonical per-surface persistence with the same conservative iCloud rules as text records. */
export class InkSurfaceRepository {
  private readonly onSurfaceChanged: (record: InkSurfaceRecord) => void;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    private readonly store: TextFileStore,
    events: {
      readonly onSurfaceChanged?: (record: InkSurfaceRecord) => void;
    } = {},
  ) {
    this.onSurfaceChanged = events.onSurfaceChanged ?? (() => undefined);
  }

  async writeSurface(record: InkSurfaceRecord): Promise<void> {
    const key = surfaceWriteKey(record.filePath, record.id);
    await this.enqueueWrite(key, async () => {
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
    });
  }

  async readSurface(filePath: string, surfaceId: string): Promise<InkSurfaceRecord | null> {
    const candidates = await this.readCandidates(filePath, surfaceId);
    return candidates.length === 0 ? null : selectLatestCandidate(candidates, surfaceId).record;
  }

  async updateSurface(record: InkSurfaceRecord): Promise<void> {
    const key = surfaceWriteKey(record.filePath, record.id);
    await this.enqueueWrite(key, async () => {
      await this.assertNoteIdentity(record);
      const candidates = await this.readCandidates(record.filePath, record.id);
      if (candidates.length === 0) {
        throw new Error(`Cannot update missing ink surface ${record.id}.`);
      }
      const existing = selectLatestCandidate(candidates, record.id).record;
      if (existing.noteId !== record.noteId || record.revision <= existing.revision) {
        throw new Error('Ink surface update must preserve note identity and increase revision.');
      }

      const path = await this.surfacePath(record.filePath, record.id);
      const previousContents = await this.store.read(path);
      try {
        await this.store.write(path, encodeInkSurfaceRecord(record));
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
      await this.refreshSummaryIndex(record);
      this.onSurfaceChanged(record);
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
    return this.enqueueWrite(key, async () => {
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
    });
  }

  async listSurfaceSummaries(filePath: string): Promise<readonly InkSurfaceSummary[]> {
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

  /** Rebuilds disposable Ink summaries after Obsidian reports an external surface artifact event. */
  async rebuildSummariesForSidecarPath(sidecarPath: string): Promise<string | null> {
    const normalizedPath = sidecarPath.replaceAll('\\', '/');
    const match = /^\.obsidian-annotations\/v1\/notes\/([^/]+)\/surfaces\/[^/]+\.json$/u.exec(
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
    const key = `${filePath}\u0000summary`;
    await this.enqueueWrite(key, async () => {
      const loaded = await this.listSurfaces(filePath);
      await this.writeSummaryIndex(filePath, summarizeLoadedSurfaces(loaded));
    });
    return filePath;
  }

  async tombstoneSurface(
    filePath: string,
    surfaceId: string,
    now: string,
    deviceId?: string,
  ): Promise<InkSurfaceRecord> {
    const current = await this.readSurface(filePath, surfaceId);
    if (current === null) throw new Error(`Ink surface ${surfaceId} does not exist.`);
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

  async restoreSurface(
    filePath: string,
    surfaceId: string,
    now: string,
    deviceId?: string,
  ): Promise<InkSurfaceRecord> {
    const current = await this.readSurface(filePath, surfaceId);
    if (current === null) throw new Error(`Ink surface ${surfaceId} does not exist.`);
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

  private async refreshSummaryIndex(record: InkSurfaceRecord): Promise<void> {
    const key = `${normalizeVaultPath(record.filePath)}\u0000summary`;
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

function normalizeSurfaceId(surfaceId: string): string {
  if (!/^[a-zA-Z0-9-]+$/u.test(surfaceId)) {
    throw new Error('Ink surface ID contains unsupported path characters.');
  }
  return surfaceId;
}

function surfaceWriteKey(filePath: string, surfaceId: string): string {
  return `${normalizeVaultPath(filePath)}\u0000${normalizeSurfaceId(surfaceId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
