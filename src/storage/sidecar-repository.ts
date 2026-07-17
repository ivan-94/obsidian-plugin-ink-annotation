import {
  decodeTextAnnotationRecord,
  encodeTextAnnotationRecord,
  type TextAnnotationRecord,
} from '../domain/text-annotation';
import { hashText } from '../domain/text-anchor';

const SIDECAR_ROOT = '.obsidian-annotations/v1/notes';

export interface TextFileStore {
  /** Stable vault-scoped object used to serialize writes across plugin/repository instances. */
  readonly coordinationScope?: object;
  /** Returns direct child basenames, never absolute or directory-prefixed paths. */
  list(directory: string): Promise<readonly string[]>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string | null>;
  rename?(from: string, to: string): Promise<void>;
  remove?(path: string): Promise<void>;
  write(path: string, contents: string): Promise<void>;
}

export interface NoteMeta {
  readonly filePath: string;
  readonly lastReconciledAt: string;
  readonly noteId: string;
  readonly pathHash: string;
  readonly schemaVersion: 1;
  readonly sourceFingerprint: string;
  readonly sourceMissingAt?: string;
}

export interface NoteSummary {
  readonly conflicts: readonly {
    readonly annotationId: string;
    readonly candidateCount: number;
    readonly kind: RepositoryConflict['kind'];
  }[];
  readonly derived: true;
  readonly filePath: string;
  readonly generatedAt: string;
  readonly records: readonly {
    readonly deletedAt?: string;
    readonly deviceId?: string;
    readonly id: string;
    readonly revision: number;
    readonly status: TextAnnotationRecord['status'];
    readonly updatedAt: string;
  }[];
  readonly schemaVersion: 1;
}

export interface RepositoryIssue {
  readonly kind: 'conflict' | 'corrupt-record' | 'duplicate-artifact';
  readonly message: string;
  readonly path: string;
}

export interface RepositoryRecordCandidate {
  readonly path: string;
  readonly record: TextAnnotationRecord;
}

export interface RepositoryConflict {
  readonly annotationId: string;
  readonly candidates: readonly RepositoryRecordCandidate[];
  readonly kind: 'duplicate-artifact' | 'same-revision-divergence';
  readonly selectedPath: string;
}

export class RepositoryConflictError extends Error {
  constructor(readonly conflict: RepositoryConflict) {
    super(`Annotation ${conflict.annotationId} has divergent candidates that require repair.`);
    this.name = 'RepositoryConflictError';
  }
}

export class SidecarRepository {
  private readonly onRecordChanged: (record: TextAnnotationRecord) => void;
  private readonly onRecordRemoved: (record: TextAnnotationRecord) => void;
  private readonly recordWrites = new Map<string, Promise<void>>();

  constructor(
    private readonly store: TextFileStore,
    events: {
      readonly onEventIssue?: (error: unknown) => void;
      readonly onRecordChanged?: (record: TextAnnotationRecord) => void;
      readonly onRecordRemoved?: (record: TextAnnotationRecord) => void;
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
    const onRecordChanged = events.onRecordChanged ?? (() => undefined);
    const onRecordRemoved = events.onRecordRemoved ?? (() => undefined);
    this.onRecordChanged = (record) => {
      try {
        onRecordChanged(record);
      } catch (error) {
        reportEventIssue(error);
      }
    };
    this.onRecordRemoved = (record) => {
      try {
        onRecordRemoved(record);
      } catch (error) {
        reportEventIssue(error);
      }
    };
  }

  async getOrCreateNote(input: {
    readonly createId: () => string;
    readonly filePath: string;
    readonly now: string;
    readonly sourceFingerprint: string;
  }): Promise<NoteMeta> {
    const reconciled = await this.reconcileNote(input);
    if (reconciled !== null) {
      return reconciled;
    }
    const filePath = normalizeVaultPath(input.filePath);
    const pathHash = await hashText(filePath);
    const noteRoot = `${SIDECAR_ROOT}/${pathHash}`;
    const metaPath = `${noteRoot}/meta.json`;

    const meta: NoteMeta = {
      filePath,
      lastReconciledAt: input.now,
      noteId: input.createId(),
      pathHash,
      schemaVersion: 1,
      sourceFingerprint: input.sourceFingerprint,
    };
    await this.store.mkdir(`${noteRoot}/annotations`);
    await this.store.write(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  }

  async reconcileNote(input: {
    readonly filePath: string;
    readonly now: string;
    readonly sourceFingerprint: string;
  }): Promise<NoteMeta | null> {
    const filePath = normalizeVaultPath(input.filePath);
    const pathHash = await hashText(filePath);
    const noteRoot = `${SIDECAR_ROOT}/${pathHash}`;
    const metaPath = `${noteRoot}/meta.json`;
    const existing = await this.store.read(metaPath);
    if (existing !== null) {
      const decoded = decodeNoteMeta(existing, filePath, pathHash);
      if (
        decoded.sourceMissingAt !== undefined &&
        decoded.sourceFingerprint !== input.sourceFingerprint
      ) {
        throw new Error(
          `Source path ${filePath} contains different content; manual sidecar relinking is required.`,
        );
      }
      if (
        decoded.sourceMissingAt !== undefined ||
        decoded.sourceFingerprint !== input.sourceFingerprint
      ) {
        const { sourceMissingAt: _missing, ...available } = decoded;
        void _missing;
        const refreshed: NoteMeta = {
          ...available,
          lastReconciledAt: input.now,
          sourceFingerprint: input.sourceFingerprint,
        };
        await this.store.write(metaPath, `${JSON.stringify(refreshed, null, 2)}\n`);
        return refreshed;
      }
      return decoded;
    }
    if (input.sourceFingerprint.length === 0) {
      return null;
    }
    const matches = await this.findNotesByFingerprint(input.sourceFingerprint);
    if (matches.length > 1) {
      throw new Error(
        `Multiple note sidecars match ${filePath}; manual rename reconciliation is required.`,
      );
    }
    const match = matches[0];
    if (match === undefined) {
      return null;
    }
    if (this.store.rename === undefined) {
      throw new Error('The text file store cannot rekey a renamed note sidecar.');
    }
    await this.store.rename(match.root, noteRoot);
    const reconciled: NoteMeta = {
      ...match.meta,
      filePath,
      lastReconciledAt: input.now,
      pathHash,
    };
    await this.store.write(metaPath, `${JSON.stringify(reconciled, null, 2)}\n`);
    await this.rewriteReconciledRecordPaths(noteRoot, filePath, input.now);
    return reconciled;
  }

  async reconcileObservedRename(input: {
    readonly newPath: string;
    readonly now: string;
    readonly oldPath: string;
  }): Promise<NoteMeta | null> {
    const oldPath = normalizeVaultPath(input.oldPath);
    const newPath = normalizeVaultPath(input.newPath);
    const oldPathHash = await hashText(oldPath);
    const newPathHash = await hashText(newPath);
    const oldRoot = `${SIDECAR_ROOT}/${oldPathHash}`;
    const newRoot = `${SIDECAR_ROOT}/${newPathHash}`;
    const oldMetaContents = await this.store.read(`${oldRoot}/meta.json`);

    if (oldMetaContents === null) {
      const newMetaContents = await this.store.read(`${newRoot}/meta.json`);
      return newMetaContents === null
        ? null
        : decodeNoteMeta(newMetaContents, newPath, newPathHash);
    }

    const oldMeta = decodeNoteMeta(oldMetaContents, oldPath, oldPathHash);
    const destinationContents = await this.store.read(`${newRoot}/meta.json`);
    if (destinationContents !== null && oldRoot !== newRoot) {
      const destination = decodeNoteMeta(destinationContents, newPath, newPathHash);
      if (destination.noteId !== oldMeta.noteId) {
        throw new Error(`Renamed note destination ${newPath} belongs to a different note.`);
      }
    }
    if (oldRoot !== newRoot) {
      if (this.store.rename === undefined) {
        throw new Error('The text file store cannot rekey a renamed note sidecar.');
      }
      await this.store.rename(oldRoot, newRoot);
    }

    const { sourceMissingAt: _missing, ...available } = oldMeta;
    void _missing;
    const reconciled: NoteMeta = {
      ...available,
      filePath: newPath,
      lastReconciledAt: input.now,
      pathHash: newPathHash,
    };
    await this.store.write(`${newRoot}/meta.json`, `${JSON.stringify(reconciled, null, 2)}\n`);
    await this.rewriteReconciledRecordPaths(newRoot, newPath, input.now);
    return reconciled;
  }

  async markNoteSourceMissing(filePath: string, now: string): Promise<NoteMeta | null> {
    const normalizedPath = normalizeVaultPath(filePath);
    const pathHash = await hashText(normalizedPath);
    const metaPath = `${SIDECAR_ROOT}/${pathHash}/meta.json`;
    const contents = await this.store.read(metaPath);
    if (contents === null) {
      return null;
    }
    const existing = decodeNoteMeta(contents, normalizedPath, pathHash);
    const missing: NoteMeta = {
      ...existing,
      lastReconciledAt: now,
      sourceMissingAt: existing.sourceMissingAt ?? now,
    };
    await this.store.write(metaPath, `${JSON.stringify(missing, null, 2)}\n`);
    return missing;
  }

  async writeAnnotation(record: TextAnnotationRecord): Promise<void> {
    const writeKey = recordWriteKey(record.filePath, record.id);
    await this.enqueueRecordWrite(writeKey, async () => {
      const path = await this.annotationPath(record.filePath, record.id);
      if ((await this.readRecordCandidates(record.filePath, record.id)).length > 0) {
        throw new Error(`Cannot create existing annotation ${record.id}.`);
      }
      await this.store.mkdir(path.slice(0, path.lastIndexOf('/')));
      try {
        await this.store.write(path, encodeTextAnnotationRecord(record));
      } catch (error) {
        await this.store.remove?.(path).catch(() => undefined);
        throw error;
      }
      this.onRecordChanged(record);
    });
  }

  async readAnnotation(
    filePath: string,
    annotationId: string,
  ): Promise<TextAnnotationRecord | null> {
    const candidates = await this.readRecordCandidates(filePath, annotationId);
    return candidates.length === 0
      ? null
      : selectLatestVisibleCandidate(candidates, annotationId).record;
  }

  async updateAnnotation(record: TextAnnotationRecord): Promise<void> {
    const writeKey = recordWriteKey(record.filePath, record.id);
    await this.enqueueRecordWrite(writeKey, async () => {
      const path = await this.annotationPath(record.filePath, record.id);
      const candidates = await this.readRecordCandidates(record.filePath, record.id);
      if (candidates.length === 0) {
        throw new Error(`Cannot update missing annotation ${record.id}.`);
      }
      const existing = selectLatestVisibleCandidate(candidates, record.id).record;
      if (existing.noteId !== record.noteId || record.revision <= existing.revision) {
        throw new Error('Annotation update must preserve note identity and increase revision.');
      }
      const previousContents = await this.store.read(path);
      try {
        await this.store.write(path, encodeTextAnnotationRecord(record));
      } catch (error) {
        try {
          if (previousContents === null) {
            if (this.store.remove === undefined) {
              throw new Error('The text file store cannot remove the partial canonical file.', {
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
            `Annotation ${record.id} write and rollback both failed; repair is required.`,
            { cause: restoreError },
          );
        }
        throw error;
      }
      this.onRecordChanged(record);
    });
  }

  /**
   * Resolves a same-revision divergence only after a user has selected one reviewed candidate.
   * Bounced siblings are retained; the selected contents become a new, higher canonical revision.
   */
  async resolveConflict(input: {
    readonly candidate: RepositoryRecordCandidate;
    readonly deviceId?: string;
    readonly expectedHighestRevision: number;
    readonly filePath: string;
    readonly now: string;
  }): Promise<TextAnnotationRecord> {
    const annotationId = input.candidate.record.id;
    const normalizedPath = normalizeVaultPath(input.filePath);
    const writeKey = recordWriteKey(normalizedPath, annotationId);
    return this.enqueueRecordWrite(writeKey, async () => {
      const candidates = await this.readRecordCandidates(normalizedPath, annotationId);
      const highestRevision = Math.max(...candidates.map(({ record }) => record.revision), 0);
      const reviewed = candidates.find(({ path }) => path === input.candidate.path);
      const latest = candidates.filter(({ record }) => record.revision === highestRevision);
      const stillDivergent =
        new Set(latest.map(({ record }) => encodeTextAnnotationRecord(record))).size > 1;
      if (
        reviewed === undefined ||
        highestRevision !== input.expectedHighestRevision ||
        encodeTextAnnotationRecord(reviewed.record) !==
          encodeTextAnnotationRecord(input.candidate.record) ||
        !stillDivergent
      ) {
        throw new Error('Annotation conflict changed since review; reopen the repair dialog.');
      }
      if (normalizeVaultPath(reviewed.record.filePath) !== normalizedPath) {
        throw new Error('Annotation conflict candidate belongs to a different file.');
      }
      const resolved: TextAnnotationRecord = {
        ...reviewed.record,
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
        revision: highestRevision + 1,
        updatedAt: input.now,
      };
      const canonicalPath = await this.annotationPath(normalizedPath, annotationId);
      const previousContents = await this.store.read(canonicalPath);
      try {
        await this.store.write(canonicalPath, encodeTextAnnotationRecord(resolved));
      } catch (error) {
        try {
          if (previousContents === null) {
            if (this.store.remove === undefined) {
              throw new Error('The text file store cannot remove the partial conflict repair.', {
                cause: error,
              });
            }
            await this.store.remove(canonicalPath);
          } else {
            await this.store.write(canonicalPath, previousContents);
          }
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Annotation ${annotationId} conflict repair and rollback both failed; manual repair is required.`,
            { cause: restoreError },
          );
        }
        throw error;
      }
      this.onRecordChanged(resolved);
      return resolved;
    });
  }

  async deleteAnnotation(filePath: string, annotationId: string): Promise<void> {
    if (this.store.remove === undefined) {
      throw new Error('The text file store does not support draft cleanup.');
    }
    const writeKey = recordWriteKey(filePath, annotationId);
    await this.enqueueRecordWrite(writeKey, async () => {
      const path = await this.annotationPath(filePath, annotationId);
      const record = await this.readAnnotation(filePath, annotationId);
      await this.store.remove?.(path);
      if (record !== null) {
        this.onRecordRemoved(record);
      }
    });
  }

  async listAnnotations(filePath: string): Promise<{
    readonly conflicts: readonly RepositoryConflict[];
    readonly issues: readonly RepositoryIssue[];
    readonly records: readonly TextAnnotationRecord[];
  }> {
    const annotationRoot = await this.annotationRoot(filePath);
    const filenames = await this.store.list(annotationRoot);
    const issues: RepositoryIssue[] = [];
    const candidates: RepositoryRecordCandidate[] = [];

    for (const filename of filenames.filter((name) => name.endsWith('.json')).sort()) {
      const path = `${annotationRoot}/${filename}`;
      const contents = await this.store.read(path);
      if (contents === null) {
        continue;
      }

      try {
        candidates.push({ path, record: decodeTextAnnotationRecord(contents) });
      } catch (error) {
        issues.push({
          kind: 'corrupt-record',
          message: error instanceof Error ? error.message : String(error),
          path,
        });
      }
    }

    const conflicts: RepositoryConflict[] = [];
    const records: TextAnnotationRecord[] = [];
    const candidatesById = new Map<string, RepositoryRecordCandidate[]>();
    for (const candidate of candidates) {
      const grouped = candidatesById.get(candidate.record.id) ?? [];
      grouped.push(candidate);
      candidatesById.set(candidate.record.id, grouped);
    }
    for (const [annotationId, grouped] of candidatesById) {
      const ordered = [...grouped].sort(compareRecordCandidates);
      const highestRevision = ordered[0]?.record.revision;
      if (highestRevision === undefined) {
        continue;
      }
      const latest = ordered.filter((candidate) => candidate.record.revision === highestRevision);
      const selected = selectPreferredCandidate(latest, annotationId);
      records.push(selected.record);

      if (ordered.length > 1) {
        const divergentLatest =
          new Set(latest.map((candidate) => encodeTextAnnotationRecord(candidate.record))).size > 1;
        conflicts.push({
          annotationId,
          candidates: ordered,
          kind: divergentLatest ? 'same-revision-divergence' : 'duplicate-artifact',
          selectedPath: selected.path,
        });
        issues.push({
          kind: divergentLatest ? 'conflict' : 'duplicate-artifact',
          message: divergentLatest
            ? `Annotation ${annotationId} has divergent candidates at revision ${highestRevision}.`
            : `Annotation ${annotationId} has ${ordered.length} visible file artifacts; revision ${highestRevision} is selected without deleting any artifact.`,
          path: selected.path,
        });
      }
    }

    return {
      conflicts: conflicts.sort((left, right) =>
        left.annotationId.localeCompare(right.annotationId),
      ),
      issues,
      records: records.sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  /** Resolves a text candidate sidecar event without treating its hash as source identity. */
  async resolveFilePathForAnnotationSidecar(sidecarPath: string): Promise<string | null> {
    const normalizedSidecarPath = sidecarPath.replaceAll('\\', '/');
    const match =
      /^\.obsidian-annotations\/v1\/notes\/([a-f0-9]{64})\/annotations\/[^/]+\.json$/u.exec(
        normalizedSidecarPath,
      );
    const pathHash = match?.[1];
    if (pathHash === undefined) {
      return null;
    }

    try {
      const contents = await this.store.read(`${SIDECAR_ROOT}/${pathHash}/meta.json`);
      if (contents === null) {
        return null;
      }
      const meta = decodeStoredNoteMeta(contents);
      const filePath = normalizeVaultPath(meta.filePath);
      if (
        filePath !== meta.filePath ||
        meta.pathHash !== pathHash ||
        (await hashText(filePath)) !== pathHash
      ) {
        return null;
      }
      return filePath;
    } catch {
      return null;
    }
  }

  async listNotes(): Promise<{
    readonly issues: readonly RepositoryIssue[];
    readonly notes: readonly NoteMeta[];
  }> {
    const roots = await this.store.list(SIDECAR_ROOT);
    const issues: RepositoryIssue[] = [];
    const notes: NoteMeta[] = [];
    for (const basename of roots) {
      const path = `${SIDECAR_ROOT}/${basename}/meta.json`;
      const contents = await this.store.read(path);
      if (contents === null) {
        continue;
      }
      try {
        notes.push(decodeStoredNoteMeta(contents));
      } catch (error) {
        issues.push({
          kind: 'corrupt-record',
          message: error instanceof Error ? error.message : String(error),
          path,
        });
      }
    }
    return {
      issues,
      notes: notes.sort((left, right) => left.filePath.localeCompare(right.filePath)),
    };
  }

  async rebuildSummary(filePath: string, generatedAt: string): Promise<NoteSummary> {
    const normalizedPath = normalizeVaultPath(filePath);
    const loaded = await this.listAnnotations(normalizedPath);
    const summary: NoteSummary = {
      conflicts: loaded.conflicts.map((conflict) => ({
        annotationId: conflict.annotationId,
        candidateCount: conflict.candidates.length,
        kind: conflict.kind,
      })),
      derived: true,
      filePath: normalizedPath,
      generatedAt,
      records: loaded.records.map((record) => ({
        ...(record.deletedAt === undefined ? {} : { deletedAt: record.deletedAt }),
        ...(record.deviceId === undefined ? {} : { deviceId: record.deviceId }),
        id: record.id,
        revision: record.revision,
        status: record.status,
        updatedAt: record.updatedAt,
      })),
      schemaVersion: 1,
    };
    const noteRoot = (await this.annotationRoot(normalizedPath)).slice(0, -'/annotations'.length);
    await this.store.write(`${noteRoot}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }

  private async annotationRoot(filePath: string): Promise<string> {
    const pathHash = await hashText(normalizeVaultPath(filePath));
    return `${SIDECAR_ROOT}/${pathHash}/annotations`;
  }

  private async findNotesByFingerprint(
    sourceFingerprint: string,
  ): Promise<readonly { readonly meta: NoteMeta; readonly root: string }[]> {
    const roots = await this.store.list(SIDECAR_ROOT);
    const matches: Array<{ readonly meta: NoteMeta; readonly root: string }> = [];
    for (const basename of roots) {
      const root = `${SIDECAR_ROOT}/${basename}`;
      const contents = await this.store.read(`${root}/meta.json`);
      if (contents === null) {
        continue;
      }
      try {
        const meta = decodeStoredNoteMeta(contents);
        if (meta.sourceFingerprint === sourceFingerprint) {
          matches.push({ meta, root });
        }
      } catch {
        // A damaged note meta cannot be used as an automatic rename candidate.
      }
    }
    return matches;
  }

  private async rewriteReconciledRecordPaths(
    noteRoot: string,
    filePath: string,
    now: string,
  ): Promise<void> {
    const annotationRoot = `${noteRoot}/annotations`;
    const filenames = await this.store.list(annotationRoot);
    for (const filename of filenames.filter((name) => name.endsWith('.json'))) {
      const path = `${annotationRoot}/${filename}`;
      const contents = await this.store.read(path);
      if (contents === null) {
        continue;
      }
      let record: TextAnnotationRecord;
      try {
        record = decodeTextAnnotationRecord(contents);
      } catch {
        // Preserve damaged/conflict artifacts byte-for-byte for explicit repair.
        continue;
      }
      if (record.filePath !== filePath) {
        const reconciled: TextAnnotationRecord = {
          ...record,
          filePath,
          revision: record.revision + 1,
          updatedAt: now,
        };
        await this.store.write(path, encodeTextAnnotationRecord(reconciled));
        this.onRecordChanged(reconciled);
      }
    }
  }

  private async annotationPath(filePath: string, annotationId: string): Promise<string> {
    return `${await this.annotationRoot(filePath)}/${normalizeRecordId(annotationId)}.json`;
  }

  private async readRecordCandidates(
    filePath: string,
    annotationId: string,
  ): Promise<readonly RepositoryRecordCandidate[]> {
    normalizeRecordId(annotationId);
    const root = await this.annotationRoot(filePath);
    const filenames = await this.store.list(root);
    const candidates: RepositoryRecordCandidate[] = [];
    for (const filename of filenames.filter((name) => name.endsWith('.json'))) {
      const path = `${root}/${filename}`;
      const contents = await this.store.read(path);
      if (contents === null) {
        continue;
      }
      try {
        const record = decodeTextAnnotationRecord(contents);
        if (record.id === annotationId) {
          candidates.push({ path, record });
        }
      } catch {
        // Damaged siblings are reported by listAnnotations and cannot be an update base.
      }
    }
    return candidates.sort(compareRecordCandidates);
  }

  private async enqueueRecordWrite<T>(path: string, write: () => Promise<T>): Promise<T> {
    const previous = this.recordWrites.get(path) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(write);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.recordWrites.set(path, tail);
    void tail.then(() => {
      if (this.recordWrites.get(path) === tail) {
        this.recordWrites.delete(path);
      }
    });
    return operation;
  }
}

function compareRecordCandidates(
  left: RepositoryRecordCandidate,
  right: RepositoryRecordCandidate,
): number {
  return right.record.revision - left.record.revision || left.path.localeCompare(right.path);
}

function selectPreferredCandidate(
  candidates: readonly RepositoryRecordCandidate[],
  annotationId: string,
): RepositoryRecordCandidate {
  const canonicalSuffix = `/${annotationId}.json`;
  return (
    candidates.find((candidate) => candidate.path.endsWith(canonicalSuffix)) ??
    candidates[0] ??
    (() => {
      throw new Error(`Annotation ${annotationId} has no readable candidates.`);
    })()
  );
}

function selectLatestVisibleCandidate(
  candidates: readonly RepositoryRecordCandidate[],
  annotationId: string,
): RepositoryRecordCandidate {
  const ordered = [...candidates].sort(compareRecordCandidates);
  const highestRevision = ordered[0]?.record.revision;
  if (highestRevision === undefined) {
    throw new Error(`Annotation ${annotationId} has no readable candidates.`);
  }
  const latest = ordered.filter((candidate) => candidate.record.revision === highestRevision);
  const divergent =
    new Set(latest.map((candidate) => encodeTextAnnotationRecord(candidate.record))).size > 1;
  const selected = selectPreferredCandidate(latest, annotationId);
  if (divergent) {
    throw new RepositoryConflictError({
      annotationId,
      candidates: ordered,
      kind: 'same-revision-divergence',
      selectedPath: selected.path,
    });
  }
  return selected;
}

export function normalizeVaultPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.length === 0) {
        throw new Error('Vault path escapes the Vault root.');
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  if (parts.length === 0) {
    throw new Error('Vault path must identify a file.');
  }
  return parts.join('/');
}

function decodeNoteMeta(value: string, expectedPath: string, expectedHash: string): NoteMeta {
  const parsed = decodeStoredNoteMeta(value);
  if (parsed.filePath !== expectedPath || parsed.pathHash !== expectedHash) {
    throw new Error('Note metadata does not match the requested note.');
  }
  return parsed;
}

function decodeStoredNoteMeta(value: string): NoteMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Note metadata is not valid JSON.', { cause: error });
  }

  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.noteId !== 'string' ||
    parsed.noteId.length === 0 ||
    typeof parsed.filePath !== 'string' ||
    parsed.filePath.length === 0 ||
    typeof parsed.pathHash !== 'string' ||
    parsed.pathHash.length === 0 ||
    typeof parsed.sourceFingerprint !== 'string' ||
    typeof parsed.lastReconciledAt !== 'string' ||
    (parsed.sourceMissingAt !== undefined && typeof parsed.sourceMissingAt !== 'string')
  ) {
    throw new Error('Note metadata does not match schema version 1.');
  }

  return {
    filePath: parsed.filePath,
    lastReconciledAt: parsed.lastReconciledAt,
    noteId: parsed.noteId,
    pathHash: parsed.pathHash,
    schemaVersion: 1,
    sourceFingerprint: parsed.sourceFingerprint,
    ...(parsed.sourceMissingAt === undefined ? {} : { sourceMissingAt: parsed.sourceMissingAt }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeRecordId(recordId: string): string {
  if (!/^[a-zA-Z0-9-]+$/u.test(recordId)) {
    throw new Error('Annotation ID contains unsupported path characters.');
  }
  return recordId;
}

function recordWriteKey(filePath: string, annotationId: string): string {
  return `${normalizeVaultPath(filePath)}\u0000${normalizeRecordId(annotationId)}`;
}
