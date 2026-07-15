import { describe, expect, it } from 'vitest';

import { writeTextExportFile, type TextExportFileStore } from './text-export-file-writer';

describe('text export file writer', () => {
  it('writes streamed chunks to a unique path without overwriting existing content', async () => {
    const store = new MemoryExportStore({
      'Inkstone Exports/Annotations.md': 'existing',
    });

    const path = await writeTextExportFile({
      chunks: chunks('# Header\n', 'row 1\n', 'row 2\n'),
      requestedPath: 'Inkstone Exports/Annotations.md',
      store,
    });

    expect(path).toBe('Inkstone Exports/Annotations 2.md');
    expect(store.files.get(path)).toBe('# Header\nrow 1\nrow 2\n');
    expect(store.files.get('Inkstone Exports/Annotations.md')).toBe('existing');
    expect(store.largestWrite).toBeLessThanOrEqual('# Header\n'.length);
    expect(store.renames).toEqual([
      {
        from: 'Inkstone Exports/.Annotations 2.md.inkstone-export-tmp',
        to: 'Inkstone Exports/Annotations 2.md',
      },
    ]);
    expect([...store.files.keys()]).not.toContain(
      'Inkstone Exports/.Annotations 2.md.inkstone-export-tmp',
    );
  });

  it('removes a partial export after an append failure', async () => {
    const store = new MemoryExportStore();
    store.failAppend = true;

    await expect(
      writeTextExportFile({
        chunks: chunks('header', 'body'),
        requestedPath: 'Inkstone Exports/Failed.md',
        store,
      }),
    ).rejects.toThrow('append failed');
    expect(store.files.has('Inkstone Exports/Failed.md')).toBe(false);
    expect(store.files.has('Inkstone Exports/.Failed.md.inkstone-export-tmp')).toBe(false);
  });

  it('does not delete a final path created concurrently when promotion fails', async () => {
    const store = new MemoryExportStore();
    store.failRenameWithCollision = true;

    await expect(
      writeTextExportFile({
        chunks: chunks('complete temporary output'),
        requestedPath: 'Inkstone Exports/Race.md',
        store,
      }),
    ).rejects.toThrow('rename collision');
    expect(store.files.get('Inkstone Exports/Race.md')).toBe('concurrent owner');
    expect(store.files.has('Inkstone Exports/.Race.md.inkstone-export-tmp')).toBe(false);
  });
});

function* chunks(...values: readonly string[]): Generator<string> {
  for (const value of values) {
    yield value;
  }
}

class MemoryExportStore implements TextExportFileStore {
  readonly files: Map<string, string>;
  failAppend = false;
  failRenameWithCollision = false;
  largestWrite = 0;
  readonly renames: Array<{ readonly from: string; readonly to: string }> = [];

  constructor(initial: Record<string, string> = {}) {
    this.files = new Map(Object.entries(initial));
  }

  append(path: string, contents: string): Promise<void> {
    if (this.failAppend) {
      return Promise.reject(new Error('append failed'));
    }
    this.largestWrite = Math.max(this.largestWrite, contents.length);
    this.files.set(path, `${this.files.get(path) ?? ''}${contents}`);
    return Promise.resolve();
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  mkdir(): Promise<void> {
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    if (this.failRenameWithCollision) {
      this.files.set(to, 'concurrent owner');
      return Promise.reject(new Error('rename collision'));
    }
    const contents = this.files.get(from);
    if (contents === undefined) return Promise.reject(new Error('rename source missing'));
    this.files.delete(from);
    this.files.set(to, contents);
    this.renames.push({ from, to });
    return Promise.resolve();
  }

  write(path: string, contents: string): Promise<void> {
    this.largestWrite = Math.max(this.largestWrite, contents.length);
    this.files.set(path, contents);
    return Promise.resolve();
  }
}
