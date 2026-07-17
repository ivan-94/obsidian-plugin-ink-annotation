import { describe, expect, it } from 'vitest';

import { ObsidianVaultTextFileStore } from './vault-text-file-store';

describe('Obsidian DataAdapter text-file store', () => {
  it('exposes the stable adapter identity as the cross-reload write coordination scope', () => {
    const adapter = new MemoryDataAdapter();

    const first = new ObsidianVaultTextFileStore(adapter);
    const reloaded = new ObsidianVaultTextFileStore(adapter);

    expect(first).not.toBe(reloaded);
    expect(first.coordinationScope).toBe(adapter);
    expect(reloaded.coordinationScope).toBe(first.coordinationScope);
  });

  it('creates hidden nested folders and supports read, update and direct-child listing', async () => {
    const adapter = new MemoryDataAdapter();
    const store = new ObsidianVaultTextFileStore(adapter);
    const directory = '.obsidian-annotations/v1/notes/hash';
    const path = `${directory}/meta.json`;

    await store.mkdir(`${directory}/annotations`);
    await store.write(path, 'version 1');
    await expect(store.read(path)).resolves.toBe('version 1');
    await expect(store.list(directory)).resolves.toEqual(['annotations', 'meta.json']);

    await store.write(path, 'version 2');
    await expect(store.read(path)).resolves.toBe('version 2');
    await store.append(path, ' plus');
    await expect(store.read(path)).resolves.toBe('version 2 plus');
    await expect(store.exists(path)).resolves.toBe(true);
  });

  it('merges a renamed sidecar into a destination folder created by a rename race', async () => {
    const adapter = new MemoryDataAdapter();
    const store = new ObsidianVaultTextFileStore(adapter);
    const source = '.obsidian-annotations/v1/notes/old-hash';
    const destination = '.obsidian-annotations/v1/notes/new-hash';

    await store.mkdir(`${source}/annotations`);
    await store.write(`${source}/meta.json`, 'old note identity');
    await store.write(`${source}/annotations/annotation-1.json`, 'annotation');
    await store.mkdir(`${destination}/annotations`);
    await store.write(`${destination}/meta.json`, 'concurrent destination identity');

    await store.rename(source, destination);

    await expect(store.read(`${destination}/meta.json`)).resolves.toBe('old note identity');
    await expect(store.read(`${destination}/annotations/annotation-1.json`)).resolves.toBe(
      'annotation',
    );
    await expect(store.read(`${destination}/meta rename-conflict-1.json`)).resolves.toBe(
      'concurrent destination identity',
    );
    await expect(store.exists(source)).resolves.toBe(false);
  });

  it('turns a stalled hydrated-file read into a retryable timeout', async () => {
    const adapter = new MemoryDataAdapter(true);
    await adapter.write('.obsidian-annotations/stalled.json', 'visible but not hydrated');
    const store = new ObsidianVaultTextFileStore(adapter, 5);

    await expect(store.read('.obsidian-annotations/stalled.json')).rejects.toThrow(
      /timed out.*read/u,
    );
  });

  it('recovers process interruption states without exposing partial canonical bytes', async () => {
    const adapter = new MemoryDataAdapter();
    const directory = '.obsidian-annotations/v1/notes/hash/annotations';
    const target = `${directory}/record.json`;
    await adapter.mkdir(directory);
    await adapter.write(`${target}.inkstone-bak`, 'complete revision 1');
    await adapter.write(`${target}.inkstone-tmp`, 'partial revision 2');
    const store = new ObsidianVaultTextFileStore(adapter);

    await expect(store.list(directory)).resolves.toEqual(['record.json']);
    await expect(store.read(target)).resolves.toBe('complete revision 1');
    await expect(adapter.exists(`${target}.inkstone-bak`)).resolves.toBe(false);
    await expect(adapter.exists(`${target}.inkstone-tmp`)).resolves.toBe(false);

    await adapter.write(target, 'complete revision 2');
    await adapter.write(`${target}.inkstone-bak`, 'complete revision 1');
    await expect(store.read(target)).resolves.toBe('complete revision 2');
    await expect(adapter.exists(`${target}.inkstone-bak`)).resolves.toBe(false);

    await adapter.write(`${directory}/new.json.inkstone-tmp`, 'interrupted create');
    await expect(store.list(directory)).resolves.toEqual(['record.json']);
    await expect(store.read(`${directory}/new.json`)).resolves.toBeNull();
  });

  it('rolls back a failed journal promotion and later writes the complete replacement', async () => {
    const adapter = new MemoryDataAdapter();
    const target = '.obsidian-annotations/v1/notes/hash/meta.json';
    await adapter.mkdir('.obsidian-annotations/v1/notes/hash');
    await adapter.write(target, 'revision 1');
    const store = new ObsidianVaultTextFileStore(adapter);
    adapter.failNextPromotion();

    await expect(store.write(target, 'revision 2')).rejects.toThrow('Injected promotion failure');
    expect(store.wasRecentlyWritten(target)).toBe(false);
    await expect(store.read(target)).resolves.toBe('revision 1');

    await store.write(target, 'revision 2');
    await expect(store.read(target)).resolves.toBe('revision 2');
    await expect(adapter.exists(`${target}.inkstone-bak`)).resolves.toBe(false);
    await expect(adapter.exists(`${target}.inkstone-tmp`)).resolves.toBe(false);
  });

  it('identifies canonical paths recently written by this plugin for watcher deduplication', async () => {
    const adapter = new MemoryDataAdapter();
    const store = new ObsidianVaultTextFileStore(adapter);
    const target = '.obsidian-annotations/v1/notes/hash/surfaces/surface-1.json';

    expect(store.wasRecentlyWritten(target, 1_000)).toBe(false);
    await store.write(target, 'revision 1');
    const writtenAt = Date.now();

    expect(store.wasRecentlyWritten(target, writtenAt)).toBe(true);
    expect(store.wasRecentlyWritten(target, writtenAt + 5_001)).toBe(false);
  });

  it('does not suppress a different iCloud payload that arrives at a recently written path', async () => {
    const adapter = new MemoryDataAdapter();
    const store = new ObsidianVaultTextFileStore(adapter);
    const target = '.obsidian-annotations/v1/notes/hash/annotations/annotation-1.json';

    await store.write(target, 'local revision 2');
    await expect(store.isUnchangedRecentWrite(target)).resolves.toBe(true);

    await adapter.write(target, 'remote revision 3');

    await expect(store.isUnchangedRecentWrite(target)).resolves.toBe(false);
    expect(store.wasRecentlyWritten(target)).toBe(false);
  });
});

class MemoryDataAdapter {
  private failPromotion = false;
  private readonly files = new Map<string, string>();
  private readonly folders = new Set<string>();

  constructor(private readonly hangReads = false) {}

  append(path: string, contents: string): Promise<void> {
    this.files.set(path, `${this.files.get(path) ?? ''}${contents}`);
    return Promise.resolve();
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path) || this.folders.has(path));
  }

  list(
    path: string,
  ): Promise<{ readonly files: readonly string[]; readonly folders: readonly string[] }> {
    const prefix = `${path}/`;
    const files = [...this.files.keys()].filter(
      (candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'),
    );
    const folders = [...this.folders].filter(
      (candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'),
    );
    return Promise.resolve({ files, folders });
  }

  mkdir(path: string): Promise<void> {
    if (this.files.has(path) || this.folders.has(path)) {
      return Promise.reject(new Error('Folder already exists.'));
    }
    this.folders.add(path);
    return Promise.resolve();
  }

  failNextPromotion(): void {
    this.failPromotion = true;
  }

  read(path: string): Promise<string> {
    if (this.hangReads) {
      return new Promise(() => undefined);
    }
    const contents = this.files.get(path);
    return contents === undefined
      ? Promise.reject(new Error(`Missing file ${path}.`))
      : Promise.resolve(contents);
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    for (const candidate of [...this.files.keys()]) {
      if (candidate.startsWith(`${path}/`)) this.files.delete(candidate);
    }
    for (const candidate of [...this.folders]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.folders.delete(candidate);
    }
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    if (this.failPromotion && from.endsWith('.inkstone-tmp')) {
      this.failPromotion = false;
      return Promise.reject(new Error('Injected promotion failure'));
    }
    if (this.files.has(to) || this.folders.has(to)) {
      return Promise.reject(new Error('Destination file already exists!'));
    }
    const contents = this.files.get(from);
    if (contents !== undefined) {
      this.files.delete(from);
      this.files.set(to, contents);
      return Promise.resolve();
    }
    if (!this.folders.has(from)) return Promise.reject(new Error(`Missing file ${from}.`));
    const folders = [...this.folders]
      .filter((candidate) => candidate === from || candidate.startsWith(`${from}/`))
      .sort((left, right) => left.length - right.length);
    const files = [...this.files.entries()].filter(([candidate]) =>
      candidate.startsWith(`${from}/`),
    );
    for (const folder of folders) this.folders.delete(folder);
    for (const [path] of files) this.files.delete(path);
    for (const folder of folders) this.folders.add(`${to}${folder.slice(from.length)}`);
    for (const [path, value] of files) this.files.set(`${to}${path.slice(from.length)}`, value);
    return Promise.resolve();
  }

  write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
    return Promise.resolve();
  }
}
