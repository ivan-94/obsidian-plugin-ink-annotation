import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import type { InkDraftOperation } from '../application/ink-draft-store';
import { IndexedDbInkDraftStore } from './indexeddb-ink-draft-store';

describe('IndexedDbInkDraftStore', () => {
  it('uses native transactions to order per-note drafts and discard only confirmed revisions', async () => {
    const store = new IndexedDbInkDraftStore(new IDBFactory(), IDBKeyRange, 'ink-draft-store-test');
    await store.enqueue(operation('Ink.md', 2, 'second'));
    await store.enqueue(operation('Ink.md', 1, 'first'));
    await store.enqueue(operation('Other.md', 1, 'other'));

    expect((await store.load('Ink.md')).map(({ revision }) => revision)).toEqual([1, 2]);

    await store.discardThrough('Ink.md', 1);

    expect((await store.load('Ink.md')).map(({ revision }) => revision)).toEqual([2]);
    expect((await store.load('Other.md')).map(({ revision }) => revision)).toEqual([1]);
    store.close();
  });

  it('rejects malformed revisions before opening a transaction', async () => {
    const store = new IndexedDbInkDraftStore(
      new IDBFactory(),
      IDBKeyRange,
      'ink-draft-store-validation-test',
    );

    await expect(
      store.enqueue({ ...operation('Ink.md', 1, 'valid'), revision: -1 }),
    ).rejects.toThrow('non-negative safe integer');
    await expect(store.discardThrough('Ink.md', Number.NaN)).rejects.toThrow(
      'non-negative safe integer',
    );
    store.close();
  });
});

function operation(noteKey: string, revision: number, strokeId: string): InkDraftOperation {
  return {
    command: {
      id: `add:${strokeId}`,
      kind: 'add',
      stroke: {
        color: '#112233',
        id: strokeId,
        points: [{ pressure: 0.5, time: revision, x: 10, y: 20 }],
        tool: 'pen',
        width: 4,
      },
    },
    noteKey,
    revision,
  };
}
