import { describe, expect, it } from 'vitest';

import {
  LegacyInkRecoveryStorage,
  createInkRecoveryStorageKeyspace,
  type InkRecoveryArchiveReader,
} from './tiered-ink-recovery-storage';

describe('retired tiered Ink Recovery read-only view', () => {
  it('reconstructs an archived value overridden by a pending front set without draining either source', async () => {
    const keyspace = createInkRecoveryStorageKeyspace('Vault', 'device-a');
    const logicalKey = `${keyspace.legacyPrefix}${encodeURIComponent('Ink.md')}`;
    const frontKey = `${keyspace.frontPrefix}${encodeURIComponent(logicalKey)}`;
    const front = new MemoryStorage([[frontKey, JSON.stringify({ kind: 'set', value: 'new' })]]);
    const archive = new MemoryArchive([[logicalKey, 'old']]);
    const storage = new LegacyInkRecoveryStorage({ archive, front, keyspace });
    const frontBefore = front.snapshot();
    const archiveBefore = await archive.entries();

    await storage.ready();

    expect(storage.getItem(logicalKey)).toBe('new');
    expect(front.snapshot()).toEqual(frontBefore);
    expect(await archive.entries()).toEqual(archiveBefore);
  });

  it('honors a pending front tombstone without deleting archived bytes', async () => {
    const keyspace = createInkRecoveryStorageKeyspace('Vault', 'device-a');
    const logicalKey = `${keyspace.journalPrefix}${encodeURIComponent('Ink.md')}:head`;
    const frontKey = `${keyspace.frontPrefix}${encodeURIComponent(logicalKey)}`;
    const front = new MemoryStorage([[frontKey, JSON.stringify({ kind: 'remove' })]]);
    const archive = new MemoryArchive([[logicalKey, 'legacy-head']]);
    const storage = new LegacyInkRecoveryStorage({ archive, front, keyspace });

    await storage.ready();

    expect(storage.getItem(logicalKey)).toBeNull();
    expect(await archive.entries()).toEqual([[logicalKey, 'legacy-head']]);
  });

  it('fails closed without changing divergent raw front and archive bytes', async () => {
    const keyspace = createInkRecoveryStorageKeyspace('Vault', 'device-a');
    const logicalKey = `${keyspace.legacyPrefix}${encodeURIComponent('Ink.md')}`;
    const front = new MemoryStorage([[logicalKey, 'front-bytes']]);
    const archive = new MemoryArchive([[logicalKey, 'archive-bytes']]);
    const storage = new LegacyInkRecoveryStorage({ archive, front, keyspace });

    await expect(storage.ready()).rejects.toThrow('divergent front and archive bytes');
    expect(front.getItem(logicalKey)).toBe('front-bytes');
    expect(await archive.entries()).toEqual([[logicalKey, 'archive-bytes']]);
  });
});

class MemoryStorage implements Pick<Storage, 'getItem' | 'key' | 'length'> {
  private readonly values: Map<string, string>;

  constructor(entries: readonly (readonly [string, string])[] = []) {
    this.values = new Map(entries);
  }

  get length(): number {
    return this.values.size;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  snapshot(): readonly (readonly [string, string])[] {
    return [...this.values.entries()];
  }
}

class MemoryArchive implements InkRecoveryArchiveReader {
  private readonly values: Map<string, string>;

  constructor(entries: readonly (readonly [string, string])[] = []) {
    this.values = new Map(entries);
  }

  entries(): Promise<readonly (readonly [string, string])[]> {
    return Promise.resolve([...this.values.entries()]);
  }
}
