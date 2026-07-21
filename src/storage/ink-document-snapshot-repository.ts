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
  constructor(private readonly store: TextFileStore) {}

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
}
