import type {
  InkDocumentDraft,
  InkDocumentDraftStore,
} from '../application/ink-document-draft-store';
import { decodeInkSurfaceRecord, encodeInkSurfaceRecord } from '../domain/ink-surface';

const DRAFTS_STORE = 'latest-document-drafts';

interface StoredInkDocumentDraft {
  readonly noteKey: string;
  readonly revision: number;
  readonly snapshotBytes: string;
}

/** Thin native IndexedDB adapter: one key, one value, one transaction. */
export class IndexedDbInkDocumentDraftStore implements InkDocumentDraftStore {
  private database: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory,
    private readonly databaseName = 'inkstone-annotations-document-drafts-v1',
  ) {}

  async replace(draft: InkDocumentDraft): Promise<void> {
    assertDraftIdentity(draft.noteKey, draft.revision);
    const stored: StoredInkDocumentDraft = {
      noteKey: draft.noteKey,
      revision: draft.revision,
      snapshotBytes: encodeInkSurfaceRecord(draft.snapshot),
    };
    const database = await this.open();
    const transaction = database.transaction(DRAFTS_STORE, 'readwrite');
    transaction.objectStore(DRAFTS_STORE).put(stored, draft.noteKey);
    await transactionComplete(transaction);
  }

  async load(noteKey: string): Promise<InkDocumentDraft | null> {
    assertNoteKey(noteKey);
    const database = await this.open();
    const transaction = database.transaction(DRAFTS_STORE, 'readonly');
    const request = transaction.objectStore(DRAFTS_STORE).get(noteKey);
    const [raw] = await Promise.all([
      requestResult(request as IDBRequest<unknown>),
      transactionComplete(transaction),
    ]);
    if (raw === undefined) return null;
    assertStoredDraft(raw);
    if (raw.noteKey !== noteKey) throw new Error('Ink Draft belongs to another note.');
    return {
      noteKey,
      revision: raw.revision,
      snapshot: decodeInkSurfaceRecord(raw.snapshotBytes),
    };
  }

  async discard(noteKey: string): Promise<void> {
    assertNoteKey(noteKey);
    const database = await this.open();
    const transaction = database.transaction(DRAFTS_STORE, 'readwrite');
    transaction.objectStore(DRAFTS_STORE).delete(noteKey);
    await transactionComplete(transaction);
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
}

function assertStoredDraft(value: unknown): asserts value is StoredInkDocumentDraft {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('noteKey' in value) ||
    !('revision' in value) ||
    !('snapshotBytes' in value) ||
    typeof value.noteKey !== 'string' ||
    typeof value.snapshotBytes !== 'string'
  ) {
    throw new Error('Ink Draft Store record is invalid.');
  }
  assertDraftIdentity(value.noteKey, value.revision);
}

function assertDraftIdentity(noteKey: string, revision: unknown): asserts revision is number {
  assertNoteKey(noteKey);
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw new Error('Ink Draft revision must be a non-negative safe integer.');
  }
}

function assertNoteKey(noteKey: string): void {
  if (noteKey.length === 0) throw new Error('Ink Draft note key must not be empty.');
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
