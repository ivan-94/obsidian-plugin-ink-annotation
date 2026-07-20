import type { InkDraftOperation, InkDraftStore } from '../application/ink-draft-store';

const DRAFTS_STORE = 'drafts';

/** Thin native IndexedDB Adapter. IndexedDB owns transactions, ordering, and durability. */
export class IndexedDbInkDraftStore implements InkDraftStore {
  private database: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory,
    private readonly keyRange: typeof IDBKeyRange,
    private readonly databaseName = 'inkstone-annotations-drafts-v1',
  ) {}

  async enqueue(operation: InkDraftOperation): Promise<void> {
    assertDraftOperation(operation);
    const database = await this.open();
    const transaction = database.transaction(DRAFTS_STORE, 'readwrite');
    transaction
      .objectStore(DRAFTS_STORE)
      .put(operation, draftKey(operation.noteKey, operation.revision));
    await transactionComplete(transaction);
  }

  async load(noteKey: string): Promise<readonly InkDraftOperation[]> {
    assertNoteKey(noteKey);
    const database = await this.open();
    const transaction = database.transaction(DRAFTS_STORE, 'readonly');
    const request = transaction.objectStore(DRAFTS_STORE).getAll(this.revisionRange(noteKey));
    const [raw] = await Promise.all([
      requestResult(request as IDBRequest<unknown[]>),
      transactionComplete(transaction),
    ]);
    const operations = raw.map((operation) => {
      assertDraftOperation(operation);
      if (operation.noteKey !== noteKey) {
        throw new Error('Ink Draft Store returned an operation for another note.');
      }
      return operation;
    });
    operations.sort((left, right) => left.revision - right.revision);
    return Object.freeze(operations);
  }

  async discardThrough(noteKey: string, revision: number): Promise<void> {
    assertNoteKey(noteKey);
    assertRevision(revision);
    const database = await this.open();
    const transaction = database.transaction(DRAFTS_STORE, 'readwrite');
    const store = transaction.objectStore(DRAFTS_STORE);
    const completed = transactionComplete(transaction);
    const keys = await requestResult(store.getAllKeys(this.revisionRange(noteKey, revision)));
    for (const key of keys) store.delete(key);
    await completed;
  }

  close(): void {
    void this.database?.then((database) => database.close());
    this.database = null;
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = this.factory.open(this.databaseName, 1);
      request.addEventListener('upgradeneeded', () => {
        if (!request.result.objectStoreNames.contains(DRAFTS_STORE)) {
          request.result.createObjectStore(DRAFTS_STORE);
        }
      });
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener(
        'error',
        () => reject(request.error ?? new Error('Ink Draft Store failed to open.')),
        { once: true },
      );
      request.addEventListener(
        'blocked',
        () => reject(new Error('Ink Draft Store upgrade is blocked.')),
        { once: true },
      );
    });
    return this.database;
  }

  private revisionRange(noteKey: string, through = Number.MAX_SAFE_INTEGER): IDBKeyRange {
    return this.keyRange.bound(draftKey(noteKey, 0), draftKey(noteKey, through));
  }
}

function draftKey(noteKey: string, revision: number): [string, number] {
  return [noteKey, revision];
}

function assertDraftOperation(value: unknown): asserts value is InkDraftOperation {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('noteKey' in value) ||
    !('revision' in value) ||
    !('command' in value) ||
    typeof value.noteKey !== 'string' ||
    typeof value.command !== 'object' ||
    value.command === null
  ) {
    throw new Error('Ink Draft Store operation is invalid.');
  }
  assertNoteKey(value.noteKey);
  assertRevision(value.revision);
}

function assertNoteKey(noteKey: string): void {
  if (noteKey.length === 0) throw new Error('Ink Draft note key must not be empty.');
}

function assertRevision(revision: unknown): asserts revision is number {
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw new Error('Ink Draft revision must be a non-negative safe integer.');
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('Ink Draft Store request failed.')),
      { once: true },
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new Error('Ink Draft Store transaction aborted.')),
      { once: true },
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new Error('Ink Draft Store transaction failed.')),
      { once: true },
    );
  });
}
