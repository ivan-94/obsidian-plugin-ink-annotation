export interface InkPreviewCacheKey {
  readonly alphaContract: 'premultiplied-transparent-v1';
  readonly colorSpace: 'srgb';
  readonly devicePixelRatio: number;
  readonly logicalTileSize: number;
  readonly noteIdentity: string;
  readonly rendererVersion: string;
  readonly scaleBucket: number;
  readonly surfaceSetDigest: string;
  readonly vaultIdentity: string;
}

export interface InkPreviewCacheTileInput {
  readonly bytes: ArrayBuffer;
  readonly x: number;
  readonly y: number;
}

export interface InkPreviewCacheTile extends InkPreviewCacheTileInput {
  readonly byteLength: number;
}

export interface InkPreviewCacheHit {
  readonly generation: string;
  readonly tiles: readonly InkPreviewCacheTile[];
}

interface InkPreviewTileRecord {
  readonly bytes: ArrayBuffer;
  readonly generation: string;
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

interface InkPreviewGenerationRecord {
  readonly byteLength: number;
  readonly generation: string;
  readonly id: string;
  readonly lastAccessedAt: number;
  readonly noteKey: string;
  readonly tileIds: readonly string[];
}

const TILE_STORE = 'tiles';
const GENERATION_STORE = 'generations';
const DEFAULT_PER_NOTE_BYTE_LIMIT = 32 * 1024 * 1024;
const DEFAULT_GLOBAL_BYTE_LIMIT = 128 * 1024 * 1024;
let nextFallbackGeneration = 0;

/** Disposable exact-revision Preview bytes. Every failure is deliberately reduced to a miss. */
export class IndexedDbInkPreviewCache {
  private database: Promise<IDBDatabase> | null = null;
  private readonly databaseName: string;
  private readonly beforePublishToken: () => void;
  private readonly beforeWriteBytes: () => void;
  private readonly globalByteLimit: number;
  private readonly perNoteByteLimit: number;

  constructor(
    private readonly factory: IDBFactory,
    options: {
      readonly beforePublishToken?: () => void;
      readonly beforeWriteBytes?: () => void;
      readonly databaseName?: string;
      readonly globalByteLimit?: number;
      readonly perNoteByteLimit?: number;
    } = {},
  ) {
    this.databaseName = options.databaseName ?? 'inkstone-ink-preview-cache-v1';
    this.beforePublishToken = options.beforePublishToken ?? (() => undefined);
    this.beforeWriteBytes = options.beforeWriteBytes ?? (() => undefined);
    this.globalByteLimit = options.globalByteLimit ?? DEFAULT_GLOBAL_BYTE_LIMIT;
    this.perNoteByteLimit = options.perNoteByteLimit ?? DEFAULT_PER_NOTE_BYTE_LIMIT;
  }

  async load(key: InkPreviewCacheKey): Promise<InkPreviewCacheHit | null> {
    try {
      const database = await this.open();
      const identity = exactIdentity(key);
      const generation = await requestResult<InkPreviewGenerationRecord | undefined>(
        database
          .transaction(GENERATION_STORE, 'readonly')
          .objectStore(GENERATION_STORE)
          .get(identity) as IDBRequest<InkPreviewGenerationRecord | undefined>,
      );
      if (generation === undefined || generation.tileIds.length === 0) return null;
      const transaction = database.transaction(TILE_STORE, 'readonly');
      const store = transaction.objectStore(TILE_STORE);
      const records = await Promise.all(
        generation.tileIds.map((id) =>
          requestResult<InkPreviewTileRecord | undefined>(
            store.get(id) as IDBRequest<InkPreviewTileRecord | undefined>,
          ),
        ),
      );
      await transactionDone(transaction);
      if (
        records.some(
          (record) => record === undefined || record.generation !== generation.generation,
        )
      ) {
        return null;
      }
      void this.touch(identity, generation).catch(() => undefined);
      return Object.freeze({
        generation: generation.generation,
        tiles: Object.freeze(
          records.map((record) => {
            const tile = record as InkPreviewTileRecord;
            return Object.freeze({
              byteLength: tile.bytes.byteLength,
              bytes: tile.bytes,
              x: tile.x,
              y: tile.y,
            });
          }),
        ),
      });
    } catch {
      return null;
    }
  }

  async publish(
    key: InkPreviewCacheKey,
    tiles: readonly InkPreviewCacheTileInput[],
  ): Promise<boolean> {
    if (tiles.length === 0 || tiles.some((tile) => !validTile(tile))) return false;
    const generation = createGeneration();
    const identity = exactIdentity(key);
    const tileRecords = tiles.map((tile): InkPreviewTileRecord => ({
      bytes: tile.bytes.slice(0),
      generation,
      id: `${generation}\u0000${tile.x}\u0000${tile.y}`,
      x: tile.x,
      y: tile.y,
    }));
    try {
      this.beforeWriteBytes();
      const database = await this.open();
      const bytesTransaction = database.transaction(TILE_STORE, 'readwrite');
      const tileStore = bytesTransaction.objectStore(TILE_STORE);
      for (const record of tileRecords) tileStore.put(record);
      await transactionDone(bytesTransaction);

      this.beforePublishToken();
      const publication = database.transaction([GENERATION_STORE, TILE_STORE], 'readwrite');
      const generationStore = publication.objectStore(GENERATION_STORE);
      const previous = await requestResult<InkPreviewGenerationRecord | undefined>(
        generationStore.get(identity) as IDBRequest<InkPreviewGenerationRecord | undefined>,
      );
      generationStore.put({
        byteLength: tileRecords.reduce((total, tile) => total + tile.bytes.byteLength, 0),
        generation,
        id: identity,
        lastAccessedAt: Date.now(),
        noteKey: noteIdentity(key),
        tileIds: tileRecords.map(({ id }) => id),
      } satisfies InkPreviewGenerationRecord);
      if (previous !== undefined) {
        const tileStore = publication.objectStore(TILE_STORE);
        for (const tileId of previous.tileIds) tileStore.delete(tileId);
      }
      await transactionDone(publication);
      return await this.enforceBudgets(identity);
    } catch {
      await this.discardTiles(tileRecords.map(({ id }) => id));
      return false;
    }
  }

  /** Deletes every disposable revision for one Vault/note without touching other Preview caches. */
  async discardNote(vaultIdentity: string, noteIdentityValue: string): Promise<boolean> {
    try {
      const database = await this.open();
      const records = await requestResult<InkPreviewGenerationRecord[]>(
        database
          .transaction(GENERATION_STORE, 'readonly')
          .objectStore(GENERATION_STORE)
          .getAll() as IDBRequest<InkPreviewGenerationRecord[]>,
      );
      await this.evictGenerations(
        records.filter(
          ({ noteKey }) => noteKey === JSON.stringify([vaultIdentity, noteIdentityValue]),
        ),
      );
      return true;
    } catch {
      return false;
    }
  }

  private async touch(identity: string, generation: InkPreviewGenerationRecord): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(GENERATION_STORE, 'readwrite');
    transaction.objectStore(GENERATION_STORE).put({
      ...generation,
      id: identity,
      lastAccessedAt: Date.now(),
    } satisfies InkPreviewGenerationRecord);
    await transactionDone(transaction);
  }

  private async enforceBudgets(currentIdentity: string): Promise<boolean> {
    const database = await this.open();
    const records = await requestResult<InkPreviewGenerationRecord[]>(
      database
        .transaction(GENERATION_STORE, 'readonly')
        .objectStore(GENERATION_STORE)
        .getAll() as IDBRequest<InkPreviewGenerationRecord[]>,
    );
    const current = records.find(({ id }) => id === currentIdentity);
    if (current === undefined) return false;
    if (current.byteLength > this.perNoteByteLimit || current.byteLength > this.globalByteLimit) {
      await this.evictGenerations([current]);
      return false;
    }
    let globalBytes = records.reduce((total, record) => total + record.byteLength, 0);
    const noteBytes = new Map<string, number>();
    for (const record of records) {
      noteBytes.set(record.noteKey, (noteBytes.get(record.noteKey) ?? 0) + record.byteLength);
    }
    const victims: InkPreviewGenerationRecord[] = [];
    for (const candidate of [...records].sort(
      (left, right) => left.lastAccessedAt - right.lastAccessedAt,
    )) {
      if (
        globalBytes <= this.globalByteLimit &&
        [...noteBytes.values()].every((bytes) => bytes <= this.perNoteByteLimit)
      ) {
        break;
      }
      if (candidate.id === currentIdentity) continue;
      const candidateNoteBytes = noteBytes.get(candidate.noteKey) ?? 0;
      if (globalBytes > this.globalByteLimit || candidateNoteBytes > this.perNoteByteLimit) {
        victims.push(candidate);
        globalBytes -= candidate.byteLength;
        noteBytes.set(candidate.noteKey, candidateNoteBytes - candidate.byteLength);
      }
    }
    await this.evictGenerations(victims);
    return true;
  }

  private async evictGenerations(records: readonly InkPreviewGenerationRecord[]): Promise<void> {
    if (records.length === 0) return;
    const database = await this.open();
    const transaction = database.transaction([GENERATION_STORE, TILE_STORE], 'readwrite');
    const generations = transaction.objectStore(GENERATION_STORE);
    const tiles = transaction.objectStore(TILE_STORE);
    for (const record of records) {
      generations.delete(record.id);
      for (const tileId of record.tileIds) tiles.delete(tileId);
    }
    await transactionDone(transaction);
  }

  private async discardTiles(ids: readonly string[]): Promise<void> {
    try {
      const database = await this.open();
      const transaction = database.transaction(TILE_STORE, 'readwrite');
      const store = transaction.objectStore(TILE_STORE);
      for (const id of ids) store.delete(id);
      await transactionDone(transaction);
    } catch {
      // Orphan bytes have no complete-generation token and therefore remain unreachable.
    }
  }

  private open(): Promise<IDBDatabase> {
    if (this.database !== null) return this.database;
    this.database = new Promise((resolve, reject) => {
      const request = this.factory.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(TILE_STORE)) {
          database.createObjectStore(TILE_STORE, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(GENERATION_STORE)) {
          database.createObjectStore(GENERATION_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Ink Preview cache open failed.'));
      request.onblocked = () => reject(new Error('Ink Preview cache upgrade was blocked.'));
    });
    void this.database.catch(() => {
      this.database = null;
    });
    return this.database;
  }
}

function exactIdentity(key: InkPreviewCacheKey): string {
  return JSON.stringify([
    key.vaultIdentity,
    key.noteIdentity,
    key.surfaceSetDigest,
    key.rendererVersion,
    key.logicalTileSize,
    key.scaleBucket,
    key.devicePixelRatio,
    key.colorSpace,
    key.alphaContract,
  ]);
}

function noteIdentity(key: InkPreviewCacheKey): string {
  return JSON.stringify([key.vaultIdentity, key.noteIdentity]);
}

function createGeneration(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  nextFallbackGeneration += 1;
  return `preview-generation-${nextFallbackGeneration}`;
}

function validTile(tile: InkPreviewCacheTileInput): boolean {
  return (
    tile.bytes.byteLength > 0 &&
    Number.isSafeInteger(tile.x) &&
    Number.isSafeInteger(tile.y) &&
    tile.x >= 0 &&
    tile.y >= 0
  );
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Ink Preview cache request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Ink Preview cache transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Ink Preview cache transaction aborted.'));
  });
}
