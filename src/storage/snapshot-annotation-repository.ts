import {
  assertSnapshotAnnotationRecord,
  decodeSnapshotAnnotationRecord,
  encodeSnapshotAnnotationRecord,
  type SnapshotAnnotationRecord,
} from '../domain/snapshot-annotation';
import { hashText } from '../domain/text-anchor';
import {
  createSnapshotAnnotationIndexEntry,
  decodeSnapshotAnnotationIndexEntry,
  encodeSnapshotAnnotationIndexEntry,
  type SnapshotAnnotationIndexEntry,
} from '../domain/snapshot-annotation-summary';
import { normalizeVaultPath, type TextFileStore } from './sidecar-repository';
import { assertSnapshotAssetBytes } from './snapshot-annotation-asset-integrity';

const SIDECAR_ROOT = '.obsidian-annotations/v1/notes';

export interface SnapshotAnnotationFileStore extends TextFileStore {
  readBinary(path: string): Promise<ArrayBuffer | null>;
  writeBinary(path: string, contents: ArrayBuffer): Promise<void>;
}

export interface LoadedSnapshotAnnotation {
  readonly pngBytes: Uint8Array;
  readonly record: SnapshotAnnotationRecord;
}

export class SnapshotAnnotationRepository {
  private readonly now: () => string;
  private readonly onDerivedIssue: (error: unknown) => void;

  constructor(
    private readonly store: SnapshotAnnotationFileStore,
    input: { readonly now?: () => string; readonly onDerivedIssue?: (error: unknown) => void } = {},
  ) {
    this.now = input.now ?? (() => new Date().toISOString());
    this.onDerivedIssue = input.onDerivedIssue ?? (() => undefined);
  }

  async create(record: SnapshotAnnotationRecord, pngBytes: Uint8Array): Promise<void> {
    assertSnapshotAnnotationRecord(record);
    await assertSnapshotAssetBytes(record, pngBytes);
    const directory = await this.snapshotDirectory(record.filePath, record.id);
    await this.store.mkdir(directory);
    const assetPath = `${directory}/${record.asset.fileName}`;
    const existing = await this.store.readBinary(assetPath);
    if (existing === null) {
      await this.store.writeBinary(assetPath, Uint8Array.from(pngBytes).buffer);
    } else {
      await assertSnapshotAssetBytes(record, new Uint8Array(existing));
    }
    const verified = await this.store.readBinary(assetPath);
    if (verified === null) {
      throw new Error('Snapshot capture asset was not readable after its local write.');
    }
    await assertSnapshotAssetBytes(record, new Uint8Array(verified));
    const orphanMarkerPath = `${directory}/orphan-${record.asset.sha256}.json`;
    try {
      await this.store.write(`${directory}/record.json`, encodeSnapshotAnnotationRecord(record));
    } catch (error) {
      await this.store
        .write(
          orphanMarkerPath,
          `${JSON.stringify({ assetFileName: record.asset.fileName, createdAt: this.now(), sha256: record.asset.sha256 })}\n`,
        )
        .catch(this.onDerivedIssue);
      throw error;
    }
    if (this.store.remove !== undefined) {
      await this.store.remove(orphanMarkerPath).catch(this.onDerivedIssue);
    }
    try {
      await this.store.write(
        `${directory}/summary.json`,
        encodeSnapshotAnnotationIndexEntry(createSnapshotAnnotationIndexEntry(record)),
      );
    } catch (error) {
      this.onDerivedIssue(error);
    }
  }

  async read(filePath: string, snapshotId: string): Promise<LoadedSnapshotAnnotation | null> {
    const directory = await this.snapshotDirectory(filePath, snapshotId);
    const contents = await this.store.read(`${directory}/record.json`);
    if (contents === null) return null;
    const record = decodeSnapshotAnnotationRecord(contents);
    if (normalizeVaultPath(record.filePath) !== normalizeVaultPath(filePath)) {
      throw new Error('Snapshot Annotation record belongs to another note.');
    }
    if (record.id !== snapshotId) {
      throw new Error('Snapshot Annotation record identity does not match its directory.');
    }
    const buffer = await this.store.readBinary(`${directory}/${record.asset.fileName}`);
    if (buffer === null) throw new Error('Snapshot Annotation capture asset is missing.');
    const pngBytes = new Uint8Array(buffer);
    await assertSnapshotAssetBytes(record, pngBytes);
    return Object.freeze({ pngBytes, record });
  }

  async listRecords(filePath: string): Promise<readonly SnapshotAnnotationRecord[]> {
    const root = await this.snapshotRoot(filePath);
    const records: SnapshotAnnotationRecord[] = [];
    for (const snapshotId of await this.store.list(root)) {
      if (snapshotId.length === 0 || snapshotId.includes('/') || snapshotId.includes('\\'))
        continue;
      const contents = await this.store.read(`${root}/${snapshotId}/record.json`);
      if (contents === null) continue;
      const record = decodeSnapshotAnnotationRecord(contents);
      if (
        record.id !== snapshotId ||
        normalizeVaultPath(record.filePath) !== normalizeVaultPath(filePath)
      ) {
        throw new Error('Snapshot Annotation list contains a mismatched record.');
      }
      records.push(record);
    }
    return records.sort(
      (left, right) =>
        right.capturedAt.localeCompare(left.capturedAt) || right.id.localeCompare(left.id),
    );
  }

  async listIndexEntries(filePath: string): Promise<readonly SnapshotAnnotationIndexEntry[]> {
    const root = await this.snapshotRoot(filePath);
    const entries: SnapshotAnnotationIndexEntry[] = [];
    for (const snapshotId of await this.store.list(root)) {
      if (snapshotId.length === 0 || snapshotId.includes('/') || snapshotId.includes('\\'))
        continue;
      const directory = `${root}/${snapshotId}`;
      const summaryContents = await this.store.read(`${directory}/summary.json`);
      let entry: SnapshotAnnotationIndexEntry;
      if (summaryContents === null) {
        const recordContents = await this.store.read(`${directory}/record.json`);
        if (recordContents === null) continue;
        const record = decodeSnapshotAnnotationRecord(recordContents);
        entry = createSnapshotAnnotationIndexEntry(record);
        void this.store
          .write(`${directory}/summary.json`, encodeSnapshotAnnotationIndexEntry(entry))
          .catch(this.onDerivedIssue);
      } else {
        entry = decodeSnapshotAnnotationIndexEntry(summaryContents);
      }
      if (
        entry.id !== snapshotId ||
        normalizeVaultPath(entry.filePath) !== normalizeVaultPath(filePath)
      ) {
        throw new Error('Snapshot Annotation index contains a mismatched entry.');
      }
      entries.push(entry);
    }
    return entries.sort(
      (left, right) =>
        right.capturedAt.localeCompare(left.capturedAt) || right.id.localeCompare(left.id),
    );
  }

  async tombstone(
    filePath: string,
    snapshotId: string,
    expectedRevision: number,
    deletedAt: string,
  ): Promise<SnapshotAnnotationRecord> {
    return this.updateRecord(filePath, snapshotId, expectedRevision, (record) => ({
      ...record,
      deletedAt,
      revision: record.revision + 1,
      updatedAt: deletedAt,
    }));
  }

  async restore(
    filePath: string,
    snapshotId: string,
    expectedRevision: number,
    updatedAt: string,
  ): Promise<SnapshotAnnotationRecord> {
    return this.updateRecord(filePath, snapshotId, expectedRevision, (record) => {
      if (record.deletedAt === undefined) {
        throw new Error('Snapshot Annotation is not deleted.');
      }
      const { deletedAt: _deletedAt, ...active } = record;
      void _deletedAt;
      return { ...active, revision: record.revision + 1, updatedAt };
    });
  }

  async relink(
    filePath: string,
    snapshotId: string,
    expectedRevision: number,
    source: SnapshotAnnotationRecord['source'],
    updatedAt: string,
  ): Promise<SnapshotAnnotationRecord> {
    return this.updateRecord(filePath, snapshotId, expectedRevision, (record) => {
      const { anchorFailure: _anchorFailure, ...linked } = record;
      void _anchorFailure;
      return {
        ...linked,
        revision: record.revision + 1,
        source: structuredClone(source),
        status: 'active',
        updatedAt,
      };
    });
  }

  async reconcileFilePath(
    filePath: string,
    updatedAt: string,
  ): Promise<readonly SnapshotAnnotationRecord[]> {
    const root = await this.snapshotRoot(filePath);
    const reconciled: SnapshotAnnotationRecord[] = [];
    for (const snapshotId of await this.store.list(root)) {
      if (snapshotId.length === 0 || snapshotId.includes('/') || snapshotId.includes('\\'))
        continue;
      const directory = `${root}/${snapshotId}`;
      const contents = await this.store.read(`${directory}/record.json`);
      if (contents === null) continue;
      const record = decodeSnapshotAnnotationRecord(contents);
      if (record.id !== snapshotId) continue;
      const replacement =
        normalizeVaultPath(record.filePath) === normalizeVaultPath(filePath)
          ? record
          : {
              ...record,
              filePath: normalizeVaultPath(filePath),
              revision: record.revision + 1,
              updatedAt,
            };
      assertSnapshotAnnotationRecord(replacement);
      if (replacement !== record) {
        await this.store.write(
          `${directory}/record.json`,
          encodeSnapshotAnnotationRecord(replacement),
        );
        await this.store.write(
          `${directory}/summary.json`,
          encodeSnapshotAnnotationIndexEntry(createSnapshotAnnotationIndexEntry(replacement)),
        );
      }
      reconciled.push(replacement);
    }
    return reconciled;
  }

  async reconcileObservedRename(
    oldPath: string,
    newPath: string,
    updatedAt: string,
  ): Promise<readonly SnapshotAnnotationRecord[]> {
    const normalizedOldPath = normalizeVaultPath(oldPath);
    const normalizedNewPath = normalizeVaultPath(newPath);
    if (normalizedOldPath === normalizedNewPath) {
      return this.reconcileFilePath(normalizedNewPath, updatedAt);
    }

    const oldRoot = await this.snapshotRoot(normalizedOldPath);
    const newRoot = await this.snapshotRoot(normalizedNewPath);
    const oldEntries = await this.store.list(oldRoot);
    if (oldEntries.length > 0) {
      const newEntries = await this.store.list(newRoot);
      if (newEntries.length > 0) {
        throw new Error('Renamed Snapshot Annotation destination is not empty.');
      }
      if (this.store.rename === undefined) {
        throw new Error('The Snapshot Annotation store cannot rekey a renamed note.');
      }
      await this.store.mkdir(await this.noteRoot(normalizedNewPath));
      await this.store.rename(oldRoot, newRoot);
    }

    return this.reconcileFilePath(normalizedNewPath, updatedAt);
  }

  async cleanupColdOrphans(
    filePath: string,
    input: { readonly limit: number; readonly minimumAgeMs: number; readonly now: string },
  ): Promise<number> {
    if (
      this.store.remove === undefined ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      !Number.isFinite(input.minimumAgeMs) ||
      input.minimumAgeMs < 0
    ) {
      return 0;
    }
    const now = Date.parse(input.now);
    if (!Number.isFinite(now)) throw new Error('Snapshot orphan cleanup time is invalid.');
    const root = await this.snapshotRoot(filePath);
    let removed = 0;
    for (const snapshotId of await this.store.list(root)) {
      if (removed >= input.limit) break;
      const directory = `${root}/${snapshotId}`;
      for (const markerName of (await this.store.list(directory)).filter((name) =>
        /^orphan-[a-f0-9]{64}\.json$/u.test(name),
      )) {
        if (removed >= input.limit) break;
        const markerPath = `${directory}/${markerName}`;
        const markerContents = await this.store.read(markerPath);
        if (markerContents === null) continue;
        const marker = decodeOrphanMarker(markerContents);
        const recordContents = await this.store.read(`${directory}/record.json`);
        if (recordContents !== null) {
          const record = decodeSnapshotAnnotationRecord(recordContents);
          if (record.asset.fileName === marker.assetFileName) {
            await this.store.remove(markerPath);
            continue;
          }
        }
        const createdAt = Date.parse(marker.createdAt);
        if (!Number.isFinite(createdAt) || now - createdAt < input.minimumAgeMs) continue;
        await this.store.remove(`${directory}/${marker.assetFileName}`);
        await this.store.remove(markerPath);
        removed += 1;
      }
    }
    return removed;
  }

  private async updateRecord(
    filePath: string,
    snapshotId: string,
    expectedRevision: number,
    update: (record: SnapshotAnnotationRecord) => SnapshotAnnotationRecord,
  ): Promise<SnapshotAnnotationRecord> {
    const directory = await this.snapshotDirectory(filePath, snapshotId);
    const contents = await this.store.read(`${directory}/record.json`);
    if (contents === null) throw new Error('Snapshot Annotation record is missing.');
    const current = decodeSnapshotAnnotationRecord(contents);
    if (
      current.id !== snapshotId ||
      normalizeVaultPath(current.filePath) !== normalizeVaultPath(filePath)
    ) {
      throw new Error('Snapshot Annotation record identity does not match its directory.');
    }
    if (current.revision !== expectedRevision) {
      throw new Error(
        `Snapshot Annotation revision conflict: expected ${expectedRevision}, found ${current.revision}.`,
      );
    }
    const replacement = update(current);
    assertSnapshotAnnotationRecord(replacement);
    if (
      replacement.asset.sha256 !== current.asset.sha256 ||
      replacement.asset.fileName !== current.asset.fileName
    ) {
      throw new Error('Snapshot Annotation metadata update cannot replace its Capture Asset.');
    }
    await this.store.write(`${directory}/record.json`, encodeSnapshotAnnotationRecord(replacement));
    try {
      await this.store.write(
        `${directory}/summary.json`,
        encodeSnapshotAnnotationIndexEntry(createSnapshotAnnotationIndexEntry(replacement)),
      );
    } catch (error) {
      this.onDerivedIssue(error);
    }
    return replacement;
  }

  private async snapshotDirectory(filePath: string, snapshotId: string): Promise<string> {
    if (snapshotId.length === 0 || snapshotId.includes('/') || snapshotId.includes('\\')) {
      throw new Error('Snapshot Annotation ID cannot be used as a Vault path segment.');
    }
    return `${await this.snapshotRoot(filePath)}/${snapshotId}`;
  }

  private async snapshotRoot(filePath: string): Promise<string> {
    return `${await this.noteRoot(filePath)}/snapshot-annotations`;
  }

  private async noteRoot(filePath: string): Promise<string> {
    const normalizedPath = normalizeVaultPath(filePath);
    return `${SIDECAR_ROOT}/${await hashText(normalizedPath)}`;
  }
}

function decodeOrphanMarker(contents: string): {
  readonly assetFileName: string;
  readonly createdAt: string;
  readonly sha256: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (cause) {
    throw new Error('Snapshot orphan marker is not valid JSON.', { cause });
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('assetFileName' in value) ||
    !('createdAt' in value) ||
    !('sha256' in value) ||
    typeof value.assetFileName !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    value.assetFileName !== `capture-${value.sha256}.png`
  ) {
    throw new Error('Snapshot orphan marker is invalid.');
  }
  return {
    assetFileName: value.assetFileName,
    createdAt: value.createdAt,
    sha256: value.sha256,
  };
}
