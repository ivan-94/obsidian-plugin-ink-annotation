import {
  decodeInkSurfaceRecord,
  encodeInkSurfaceRecord,
  type InkSurfaceRecord,
} from '../domain/ink-surface';
import { hashText } from '../domain/text-anchor';
import { normalizeVaultPath, type TextFileStore } from './sidecar-repository';

const SIDECAR_ROOT = '.obsidian-annotations/v1/notes';
const SNAPSHOT_BASENAME = 'ink.json';

/**
 * The deliberately small canonical Ink repository introduced by SP6/SP7.
 *
 * `replace` is blind: it never reads, compares, merges, or advances a concurrency token. The
 * TextFileStore owns the platform-specific atomic replacement detail.
 */
export class InkDocumentSnapshotRepository {
  private readonly onSnapshotChanged: (snapshot: InkSurfaceRecord) => void;

  constructor(
    private readonly store: TextFileStore,
    options: { readonly onSnapshotChanged?: (snapshot: InkSurfaceRecord) => void } = {},
  ) {
    this.onSnapshotChanged = options.onSnapshotChanged ?? (() => undefined);
  }

  async read(filePath: string): Promise<InkSurfaceRecord | null> {
    const normalizedPath = normalizeVaultPath(filePath);
    const bytes = await this.store.read(await this.snapshotPath(normalizedPath));
    if (bytes === null) return null;
    const record = decodeInkSurfaceRecord(bytes);
    if (normalizeVaultPath(record.filePath) !== normalizedPath) {
      throw new Error('Ink document snapshot belongs to another note.');
    }
    return record;
  }

  async replace(snapshot: InkSurfaceRecord): Promise<void> {
    const directory = await this.noteDirectory(snapshot.filePath);
    await this.store.mkdir(directory);
    await this.store.write(`${directory}/${SNAPSHOT_BASENAME}`, encodeInkSurfaceRecord(snapshot));
    this.onSnapshotChanged(snapshot);
  }

  /** Marks the one authoritative document snapshot deleted while retaining it for Undo. */
  async tombstone(filePath: string, deletedAt: string): Promise<InkSurfaceRecord> {
    const current = await this.requireSnapshot(filePath);
    const deleted: InkSurfaceRecord = {
      ...current,
      deletedAt,
      revision: current.revision + 1,
      updatedAt: deletedAt,
    };
    await this.replace(deleted);
    return deleted;
  }

  /** Restores a retained snapshot without consulting a legacy surface or revision chain. */
  async restore(filePath: string, restoredAt: string): Promise<InkSurfaceRecord> {
    const current = await this.requireSnapshot(filePath);
    const restored = {
      ...current,
      revision: current.revision + 1,
      updatedAt: restoredAt,
    };
    delete restored.deletedAt;
    await this.replace(restored);
    return restored;
  }

  async resolveFilePath(sidecarPath: string): Promise<string | null> {
    const normalized = sidecarPath.replaceAll('\\', '/');
    const match = /^\.obsidian-annotations\/v1\/notes\/([a-f0-9]{64})\/ink\.json$/u.exec(
      normalized,
    );
    const pathHash = match?.[1];
    if (pathHash === undefined) return null;
    try {
      const bytes = await this.store.read(normalized);
      if (bytes === null) return null;
      const record = decodeInkSurfaceRecord(bytes);
      const filePath = normalizeVaultPath(record.filePath);
      return (await hashText(filePath)) === pathHash ? filePath : null;
    } catch {
      return null;
    }
  }

  /** Cold rename repair after SidecarRepository has moved the whole note root to its new hash. */
  async reconcileFilePath(filePath: string, now: string): Promise<InkSurfaceRecord | null> {
    const normalizedPath = normalizeVaultPath(filePath);
    const path = await this.snapshotPath(normalizedPath);
    const bytes = await this.store.read(path);
    if (bytes === null) return null;
    const current = decodeInkSurfaceRecord(bytes);
    if (normalizeVaultPath(current.filePath) === normalizedPath) return current;
    const reconciled = { ...current, filePath: normalizedPath, updatedAt: now };
    await this.store.write(path, encodeInkSurfaceRecord(reconciled));
    return reconciled;
  }

  private async noteDirectory(filePath: string): Promise<string> {
    return `${SIDECAR_ROOT}/${await hashText(normalizeVaultPath(filePath))}`;
  }

  private async snapshotPath(filePath: string): Promise<string> {
    return `${await this.noteDirectory(filePath)}/${SNAPSHOT_BASENAME}`;
  }

  private async requireSnapshot(filePath: string): Promise<InkSurfaceRecord> {
    const current = await this.read(filePath);
    if (current === null) throw new Error(`Ink document snapshot no longer exists: ${filePath}`);
    return current;
  }
}
