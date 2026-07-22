import type {
  SnapshotAnnotationDraft,
  SnapshotAnnotationDraftStore,
} from '../application/snapshot-annotation-draft-store';
import {
  decodeSnapshotAnnotationRecord,
  encodeSnapshotAnnotationRecord,
} from '../domain/snapshot-annotation';
import { assertSnapshotAssetBytes } from './snapshot-annotation-asset-integrity';

const DRAFTS_STORE = 'latest-snapshot-annotation-drafts';

interface StoredSnapshotAnnotationDraft {
  readonly draftKey: string;
  readonly isNew: boolean;
  readonly pngBytes: ArrayBuffer;
  readonly recordBytes: string;
  readonly savedAt: string;
}

export class IndexedDbSnapshotAnnotationDraftStore implements SnapshotAnnotationDraftStore {
  private database: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory,
    private readonly databaseName = 'inkstone-snapshot-annotation-drafts-v1',
  ) {}

  async replace(draft: SnapshotAnnotationDraft): Promise<void> {
    assertDraftKey(draft.draftKey);
    if (draft.savedAt.length === 0) throw new Error('Snapshot Draft savedAt must not be empty.');
    await assertSnapshotAssetBytes(draft.record, draft.pngBytes);
    const stored: StoredSnapshotAnnotationDraft = {
      draftKey: draft.draftKey,
      isNew: draft.isNew,
      pngBytes: Uint8Array.from(draft.pngBytes).buffer,
      recordBytes: encodeSnapshotAnnotationRecord(draft.record),
      savedAt: draft.savedAt,
    };
    const database = await this.open();
    const transaction = database.transaction(DRAFTS_STORE, 'readwrite');
    transaction.objectStore(DRAFTS_STORE).put(stored, draft.draftKey);
    await transactionComplete(transaction);
  }

  async load(draftKey: string): Promise<SnapshotAnnotationDraft | null> {
    assertDraftKey(draftKey);
    const database = await this.open();
    const transaction = database.transaction(DRAFTS_STORE, 'readonly');
    const request = transaction.objectStore(DRAFTS_STORE).get(draftKey);
    const [raw] = await Promise.all([
      requestResult(request as IDBRequest<unknown>),
      transactionComplete(transaction),
    ]);
    if (raw === undefined) return null;
    assertStoredDraft(raw);
    if (raw.draftKey !== draftKey) throw new Error('Snapshot Draft belongs to another key.');
    return materializeStoredDraft(raw);
  }

  async loadLatest(filePath: string): Promise<SnapshotAnnotationDraft | null> {
    if (filePath.length === 0) throw new Error('Snapshot Draft file path must not be empty.');
    const database = await this.open();
    const transaction = database.transaction(DRAFTS_STORE, 'readonly');
    const request = transaction.objectStore(DRAFTS_STORE).getAll();
    const [rawDrafts] = await Promise.all([
      requestResult(request as IDBRequest<unknown[]>),
      transactionComplete(transaction),
    ]);
    const drafts = rawDrafts.map((raw) => {
      assertStoredDraft(raw);
      return materializeStoredDraft(raw);
    });
    return (
      drafts
        .filter((draft) => draft.record.filePath === filePath)
        .sort(
          (left, right) =>
            right.savedAt.localeCompare(left.savedAt) ||
            right.draftKey.localeCompare(left.draftKey),
        )[0] ?? null
    );
  }

  async discard(draftKey: string): Promise<void> {
    assertDraftKey(draftKey);
    const database = await this.open();
    const transaction = database.transaction(DRAFTS_STORE, 'readwrite');
    transaction.objectStore(DRAFTS_STORE).delete(draftKey);
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
        () => reject(request.error ?? new Error('Snapshot Draft Store failed to open.')),
        { once: true },
      );
      request.addEventListener(
        'blocked',
        () => reject(new Error('Snapshot Draft Store upgrade is blocked.')),
        { once: true },
      );
    });
    return this.database;
  }
}

function materializeStoredDraft(raw: StoredSnapshotAnnotationDraft): SnapshotAnnotationDraft {
  return {
    draftKey: raw.draftKey,
    isNew: raw.isNew,
    pngBytes: new Uint8Array(raw.pngBytes.slice(0)),
    record: decodeSnapshotAnnotationRecord(raw.recordBytes),
    savedAt: raw.savedAt,
  };
}

function assertStoredDraft(value: unknown): asserts value is StoredSnapshotAnnotationDraft {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('draftKey' in value) ||
    !('isNew' in value) ||
    !('pngBytes' in value) ||
    !('recordBytes' in value) ||
    !('savedAt' in value) ||
    typeof value.draftKey !== 'string' ||
    typeof value.isNew !== 'boolean' ||
    !(value.pngBytes instanceof ArrayBuffer) ||
    typeof value.recordBytes !== 'string' ||
    typeof value.savedAt !== 'string' ||
    value.savedAt.length === 0
  ) {
    throw new Error('Snapshot Draft Store record is invalid.');
  }
}

function assertDraftKey(draftKey: string): void {
  if (draftKey.length === 0) throw new Error('Snapshot Draft key must not be empty.');
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('Snapshot Draft Store request failed.')),
      { once: true },
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new Error('Snapshot Draft Store transaction aborted.')),
      { once: true },
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new Error('Snapshot Draft Store transaction failed.')),
      { once: true },
    );
  });
}
