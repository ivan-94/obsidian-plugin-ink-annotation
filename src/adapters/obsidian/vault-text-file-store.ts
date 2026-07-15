import { normalizeVaultPath, type TextFileStore } from '../../storage/sidecar-repository';

interface ListedPaths {
  readonly files: readonly string[];
  readonly folders: readonly string[];
}

interface DataAdapterLike {
  append?(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<ListedPaths>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  write(path: string, contents: string): Promise<void>;
  writeBinary?(path: string, contents: ArrayBuffer): Promise<void>;
}

const JOURNAL_BACKUP_SUFFIX = '.inkstone-bak';
const JOURNAL_TEMP_SUFFIX = '.inkstone-tmp';

/** Uses Obsidian's mobile-safe DataAdapter because Vault intentionally does not index dot-folders. */
export class ObsidianVaultTextFileStore implements TextFileStore {
  constructor(
    private readonly adapter: DataAdapterLike,
    private readonly readTimeoutMs = 15_000,
  ) {}

  async list(directory: string): Promise<readonly string[]> {
    const normalized = normalizeVaultPath(directory);
    if (!(await this.adapter.exists(normalized))) {
      return [];
    }
    let listed = await withTimeout(
      this.adapter.list(normalized),
      this.readTimeoutMs,
      `list ${normalized}`,
    );
    const journalTargets = new Set(
      listed.files
        .map(basename)
        .filter(
          (name) => name.endsWith(JOURNAL_BACKUP_SUFFIX) || name.endsWith(JOURNAL_TEMP_SUFFIX),
        )
        .map((name) =>
          name.endsWith(JOURNAL_BACKUP_SUFFIX)
            ? name.slice(0, -JOURNAL_BACKUP_SUFFIX.length)
            : name.slice(0, -JOURNAL_TEMP_SUFFIX.length),
        ),
    );
    if (journalTargets.size > 0) {
      for (const target of journalTargets) {
        await this.recoverAtomicPath(`${normalized}/${target}`);
      }
      listed = await withTimeout(
        this.adapter.list(normalized),
        this.readTimeoutMs,
        `relist ${normalized}`,
      );
    }
    return [...listed.files, ...listed.folders].map(basename).sort();
  }

  async append(path: string, contents: string): Promise<void> {
    if (this.adapter.append === undefined) {
      throw new Error('The Obsidian data adapter does not support streamed append.');
    }
    await this.adapter.append(normalizeVaultPath(path), contents);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizeVaultPath(path);
    await this.recoverAtomicPath(normalized);
    return this.adapter.exists(normalized);
  }

  async mkdir(path: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    let current = '';

    for (const segment of normalized.split('/')) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      if (await this.adapter.exists(current)) {
        continue;
      }
      try {
        await this.adapter.mkdir(current);
      } catch (error) {
        if (!(await this.adapter.exists(current))) {
          throw error;
        }
      }
    }
  }

  async read(path: string): Promise<string | null> {
    const normalized = normalizeVaultPath(path);
    await this.recoverAtomicPath(normalized);
    return (await this.adapter.exists(normalized))
      ? withTimeout(this.adapter.read(normalized), this.readTimeoutMs, `read ${normalized}`)
      : null;
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    await this.removeIfPresent(normalized);
    await this.removeIfPresent(`${normalized}${JOURNAL_TEMP_SUFFIX}`);
    await this.removeIfPresent(`${normalized}${JOURNAL_BACKUP_SUFFIX}`);
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.adapter.rename === undefined) {
      throw new Error('The Obsidian data adapter does not support rename.');
    }
    const normalizedFrom = normalizeVaultPath(from);
    const normalizedTo = normalizeVaultPath(to);
    const separator = normalizedTo.lastIndexOf('/');
    if (separator > 0) {
      await this.mkdir(normalizedTo.slice(0, separator));
    }
    await this.adapter.rename(normalizedFrom, normalizedTo);
  }

  async write(path: string, contents: string): Promise<void> {
    const normalized = normalizeVaultPath(path);
    const separator = normalized.lastIndexOf('/');
    if (separator > 0) {
      await this.mkdir(normalized.slice(0, separator));
    }
    if (this.adapter.rename === undefined) {
      await this.adapter.write(normalized, contents);
      return;
    }
    await this.writeJournaled(normalized, contents);
  }

  async writeBinary(path: string, contents: ArrayBuffer): Promise<void> {
    if (this.adapter.writeBinary === undefined) {
      throw new Error('The Obsidian data adapter does not support binary Ink export.');
    }
    const normalized = normalizeVaultPath(path);
    const separator = normalized.lastIndexOf('/');
    if (separator > 0) await this.mkdir(normalized.slice(0, separator));
    await this.adapter.writeBinary(normalized, contents);
  }

  private async writeJournaled(path: string, contents: string): Promise<void> {
    const rename = this.adapter.rename?.bind(this.adapter);
    if (rename === undefined) {
      throw new Error('The Obsidian data adapter does not support journaled writes.');
    }
    const temporary = `${path}${JOURNAL_TEMP_SUFFIX}`;
    const backup = `${path}${JOURNAL_BACKUP_SUFFIX}`;
    await this.recoverAtomicPath(path);
    await this.adapter.write(temporary, contents);
    const verified = await withTimeout(
      this.adapter.read(temporary),
      this.readTimeoutMs,
      `verify temporary write ${path}`,
    );
    if (verified !== contents) {
      await this.removeIfPresent(temporary);
      throw new Error(
        `Annotation storage verification failed during write ${path}. Retry locally.`,
      );
    }

    let backedUp = false;
    try {
      if (await this.adapter.exists(path)) {
        await this.removeIfPresent(backup);
        await rename(path, backup);
        backedUp = true;
      }
      await rename(temporary, path);
      await this.removeIfPresent(backup);
    } catch (error) {
      if (backedUp && !(await this.adapter.exists(path)) && (await this.adapter.exists(backup))) {
        await rename(backup, path);
      }
      await this.removeIfPresent(temporary);
      throw error;
    }
  }

  private async recoverAtomicPath(path: string): Promise<void> {
    if (this.adapter.rename === undefined) return;
    const temporary = `${path}${JOURNAL_TEMP_SUFFIX}`;
    const backup = `${path}${JOURNAL_BACKUP_SUFFIX}`;
    if (await this.adapter.exists(path)) {
      await this.removeIfPresent(temporary);
      await this.removeIfPresent(backup);
      return;
    }
    if (await this.adapter.exists(backup)) {
      await this.adapter.rename(backup, path);
      await this.removeIfPresent(temporary);
      return;
    }
    await this.removeIfPresent(temporary);
  }

  private async removeIfPresent(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(new Error(`Annotation storage operation timed out during ${label}. Retry locally.`));
    }, timeoutMs);
    void operation.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
