import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { IndexedDbInkPreviewCache, type InkPreviewCacheKey } from './indexeddb-ink-preview-cache';

describe('IndexedDbInkPreviewCache', () => {
  it('loads only an atomically published exact projection identity', async () => {
    const cache = new IndexedDbInkPreviewCache(new IDBFactory(), { databaseName: 'preview-exact' });
    const key = cacheKey('digest-a');

    expect(await cache.publish(key, [{ bytes: bytes(1, 2, 3), x: 0, y: 0 }])).toBe(true);

    expect(await cache.load(key)).toMatchObject({
      tiles: [{ byteLength: 3, x: 0, y: 0 }],
    });
    expect(await cache.load(cacheKey('same-revision-different-content'))).toBeNull();
  });

  it('treats bytes without a published complete-generation token as a cache miss', async () => {
    const cache = new IndexedDbInkPreviewCache(new IDBFactory(), {
      beforePublishToken: () => {
        throw new Error('interrupted after bytes');
      },
      databaseName: 'preview-partial',
    });
    const key = cacheKey('digest-a');

    expect(await cache.publish(key, [{ bytes: bytes(1), x: 0, y: 0 }])).toBe(false);
    expect(await cache.load(key)).toBeNull();
  });

  it('turns quota and transaction failures into a non-blocking miss', async () => {
    const cache = new IndexedDbInkPreviewCache(new IDBFactory(), {
      beforeWriteBytes: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      databaseName: 'preview-quota',
    });

    expect(await cache.publish(cacheKey('digest-a'), [{ bytes: bytes(1), x: 0, y: 0 }])).toBe(
      false,
    );
    expect(await cache.load(cacheKey('digest-a'))).toBeNull();
  });

  it('evicts least-recent exact generations to keep per-note bytes bounded', async () => {
    const cache = new IndexedDbInkPreviewCache(new IDBFactory(), {
      databaseName: 'preview-budget',
      globalByteLimit: 10,
      perNoteByteLimit: 3,
    });
    const old = cacheKey('digest-old');
    const current = cacheKey('digest-current');

    await cache.publish(old, [{ bytes: bytes(1, 2), x: 0, y: 0 }]);
    await cache.publish(current, [{ bytes: bytes(3, 4), x: 0, y: 0 }]);

    expect(await cache.load(old)).toBeNull();
    expect(await cache.load(current)).not.toBeNull();
  });

  it('reclaims the replaced generation bytes when the same exact identity is republished', async () => {
    const factory = new IDBFactory();
    const databaseName = 'preview-replace';
    const cache = new IndexedDbInkPreviewCache(factory, { databaseName });
    const key = cacheKey('digest-current');

    await cache.publish(key, [{ bytes: bytes(1, 2), x: 0, y: 0 }]);
    await cache.publish(key, [{ bytes: bytes(3, 4, 5), x: 0, y: 0 }]);

    expect(await countRecords(factory, databaseName, 'tiles')).toBe(1);
    expect(await cache.load(key)).toMatchObject({ tiles: [{ byteLength: 3 }] });
  });

  it('discards only the owned Vault/note revisions for deterministic cold Preview', async () => {
    const cache = new IndexedDbInkPreviewCache(new IDBFactory(), {
      databaseName: 'preview-discard-note',
    });
    const first = cacheKey('digest-first');
    const second = cacheKey('digest-second');
    const other = { ...cacheKey('digest-other'), noteIdentity: 'note-b' };
    await cache.publish(first, [{ bytes: bytes(1), x: 0, y: 0 }]);
    await cache.publish(second, [{ bytes: bytes(2), x: 0, y: 0 }]);
    await cache.publish(other, [{ bytes: bytes(3), x: 0, y: 0 }]);

    await expect(cache.discardNote('vault-a', 'note-a')).resolves.toBe(true);

    expect(await cache.load(first)).toBeNull();
    expect(await cache.load(second)).toBeNull();
    expect(await cache.load(other)).not.toBeNull();
  });
});

function cacheKey(surfaceSetDigest: string): InkPreviewCacheKey {
  return {
    alphaContract: 'premultiplied-transparent-v1',
    colorSpace: 'srgb',
    devicePixelRatio: 2,
    logicalTileSize: 512,
    noteIdentity: 'note-a',
    rendererVersion: 'inkstone-brush-v1',
    scaleBucket: 1,
    surfaceSetDigest,
    vaultIdentity: 'vault-a',
  };
}

function bytes(...values: number[]): ArrayBuffer {
  return Uint8Array.from(values).buffer;
}

async function countRecords(
  factory: IDBFactory,
  databaseName: string,
  storeName: string,
): Promise<number> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Preview test database open failed.'));
  });
  return new Promise<number>((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Preview test count failed.'));
  });
}
