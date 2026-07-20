export interface InkRecoveryArchiveReader {
  close?(): void;
  entries(): Promise<readonly (readonly [string, string])[]>;
}

export interface InkRecoveryStorageKeyspace {
  readonly frontPrefix: string;
  readonly journalPrefix: string;
  readonly legacyPrefix: string;
}

type FrontOperation =
  { readonly kind: 'remove' } | { readonly kind: 'set'; readonly value: string };

export function createInkRecoveryStorageKeyspace(
  vaultName: string,
  deviceId: string,
): InkRecoveryStorageKeyspace {
  const scope = `inkstone:${encodeURIComponent(vaultName)}:${encodeURIComponent(deviceId)}:`;
  return Object.freeze({
    frontPrefix: `${scope}ink-recovery-tiered-front-v1:`,
    journalPrefix: `${scope}ink-recovery-journal-v4:`,
    legacyPrefix: `${scope}ink-recovery-v1:`,
  });
}

/**
 * Read-only merged view of the retired synchronous front and IndexedDB archive. It reconstructs
 * the last crash state but never drains, copies, removes, or rewrites either source.
 */
export class LegacyInkRecoveryStorage implements Pick<Storage, 'getItem' | 'key' | 'length'> {
  private initialized = false;
  private readonly values = new Map<string, string>();

  constructor(
    private readonly input: {
      readonly archive: InkRecoveryArchiveReader;
      readonly front: Pick<Storage, 'getItem' | 'key' | 'length'>;
      readonly keyspace: InkRecoveryStorageKeyspace;
    },
  ) {}

  get length(): number {
    this.assertReady();
    return this.values.size;
  }

  async ready(): Promise<void> {
    if (this.initialized) return;
    const archiveValues = new Map<string, string>();
    for (const [key, value] of await this.input.archive.entries()) {
      if (!this.isScopedKey(key) || this.isLeaseKey(key)) continue;
      archiveValues.set(key, value);
      this.values.set(key, value);
    }

    const localKeys = this.frontKeys();
    for (const key of localKeys) {
      if (!this.isScopedKey(key) || this.isLeaseKey(key)) continue;
      const value = this.input.front.getItem(key);
      if (value === null) continue;
      const archived = archiveValues.get(key);
      if (archived !== undefined && archived !== value) {
        throw new Error(`Legacy Ink Recovery has divergent front and archive bytes for ${key}.`);
      }
      this.values.set(key, value);
    }

    for (const physicalKey of localKeys) {
      if (!physicalKey.startsWith(this.input.keyspace.frontPrefix)) continue;
      const logicalKey = decodeFrontLogicalKey(physicalKey, this.input.keyspace.frontPrefix);
      if (!this.isScopedKey(logicalKey) || this.isLeaseKey(logicalKey)) {
        throw new Error('Legacy Ink Recovery front operation is outside its owned keyspace.');
      }
      const bytes = this.input.front.getItem(physicalKey);
      if (bytes === null) continue;
      const operation = decodeFrontOperation(bytes);
      if (operation.kind === 'set') this.values.set(logicalKey, operation.value);
      else this.values.delete(logicalKey);
    }
    this.initialized = true;
  }

  getItem(key: string): string | null {
    this.assertReady();
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    this.assertReady();
    return [...this.values.keys()][index] ?? null;
  }

  close(): void {
    this.input.archive.close?.();
  }

  private assertReady(): void {
    if (!this.initialized) throw new Error('Legacy Ink Recovery storage is not ready.');
  }

  private frontKeys(): readonly string[] {
    return Array.from({ length: this.input.front.length }, (_unused, index) =>
      this.input.front.key(index),
    ).filter((key): key is string => key !== null);
  }

  private isLeaseKey(key: string): boolean {
    return key.startsWith(this.input.keyspace.legacyPrefix) && key.endsWith(':owner');
  }

  private isScopedKey(key: string): boolean {
    return (
      key.startsWith(this.input.keyspace.legacyPrefix) ||
      key.startsWith(this.input.keyspace.journalPrefix)
    );
  }
}

/** Opens the retired archive only if it already exists; no database or object store is created. */
export class IndexedDbInkRecoveryArchiveReader implements InkRecoveryArchiveReader {
  private database: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory,
    private readonly databaseName = 'inkstone-annotations-recovery-v1',
  ) {}

  async entries(): Promise<readonly (readonly [string, string])[]> {
    const database = await this.openExisting();
    if (!database.objectStoreNames.contains('entries')) {
      throw new Error('Legacy Ink Recovery archive has no entries store.');
    }
    const transaction = database.transaction('entries', 'readonly');
    const store = transaction.objectStore('entries');
    const completed = transactionComplete(transaction);
    const [keys, values] = await Promise.all([
      requestResult(store.getAllKeys()),
      requestResult<unknown[]>(store.getAll() as IDBRequest<unknown[]>),
    ]);
    await completed;
    return keys.map((key, index) => {
      const value = values[index];
      if (typeof key !== 'string' || typeof value !== 'string') {
        throw new Error('Legacy Ink Recovery archive contains an invalid key or value.');
      }
      return [key, value] as const;
    });
  }

  close(): void {
    void this.database?.then((database) => database.close()).catch(() => undefined);
    this.database = null;
  }

  private openExisting(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = this.factory.open(this.databaseName);
      request.addEventListener(
        'upgradeneeded',
        () => {
          request.transaction?.abort();
          reject(new Error('Legacy Ink Recovery archive does not exist.'));
        },
        { once: true },
      );
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener(
        'error',
        () => reject(request.error ?? new Error('Legacy Ink Recovery archive failed to open.')),
        { once: true },
      );
      request.addEventListener(
        'blocked',
        () => reject(new Error('Legacy Ink Recovery archive open is blocked.')),
        { once: true },
      );
    });
    return this.database;
  }
}

function decodeFrontLogicalKey(physicalKey: string, prefix: string): string {
  try {
    return decodeURIComponent(physicalKey.slice(prefix.length));
  } catch (error) {
    throw new Error('Legacy Ink Recovery front key is malformed.', { cause: error });
  }
}

function decodeFrontOperation(bytes: string): FrontOperation {
  try {
    const parsed: unknown = JSON.parse(bytes);
    if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) {
      throw new Error('invalid front operation');
    }
    if (parsed.kind === 'remove') return Object.freeze({ kind: 'remove' });
    if (parsed.kind === 'set' && 'value' in parsed && typeof parsed.value === 'string') {
      return Object.freeze({ kind: 'set', value: parsed.value });
    }
    throw new Error('invalid front operation');
  } catch (error) {
    throw new Error('Legacy Ink Recovery front operation is corrupt.', { cause: error });
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('Legacy Ink Recovery archive request failed.')),
      { once: true },
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new Error('Legacy Ink Recovery archive read aborted.')),
      { once: true },
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new Error('Legacy Ink Recovery archive read failed.')),
      { once: true },
    );
  });
}
