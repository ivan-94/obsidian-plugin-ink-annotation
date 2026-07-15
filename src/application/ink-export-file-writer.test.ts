import { describe, expect, it } from 'vitest';

import type { InkSurfaceRecord } from '../domain/ink-surface';
import {
  type InkExportFileStore,
  writeInkPngExport,
  writeInkStandaloneReport,
  writeInkSvgExport,
} from './ink-export-file-writer';

describe('Ink export file writer', () => {
  it('sanitizes names and chooses a unique SVG path without overwriting an existing export', async () => {
    const existing = 'Inkstone Exports/Ink - Folder-Ink-Note.md - Intro-.svg';
    const store = new MemoryInkExportStore([[existing, 'existing']]);

    const path = await writeInkSvgExport(surface(), store);

    expect(path).toBe('Inkstone Exports/Ink - Folder-Ink-Note.md - Intro- 2.svg');
    expect(store.text.get(existing)).toBe('existing');
    expect(store.text.get(path)).toMatch(/^<svg[\s\S]*<path[\s\S]*<\/svg>\n$/u);
    expect(store.directories).toEqual(['Inkstone Exports']);
  });

  it('writes a bounded valid PNG and a standalone accessible HTML report', async () => {
    const store = new MemoryInkExportStore();

    const pngPath = await writeInkPngExport(surface(), store);
    const reportPath = await writeInkStandaloneReport(
      [surface()],
      { generatedAt: '2026-07-15T00:00:00.000Z', title: 'Review: Ink / report' },
      store,
    );

    expect(pngPath).toBe('Inkstone Exports/Ink - Folder-Ink-Note.md - Intro-.png');
    expect([...new Uint8Array(store.binary.get(pngPath)!).slice(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    expect(reportPath).toBe('Inkstone Exports/Review- Ink - report.html');
    expect(store.text.get(reportPath)).toContain('<!doctype html>');
    expect(store.text.get(reportPath)).toContain('1 stroke');
  });

  it('removes a partial export when the underlying store write fails', async () => {
    const store = new MemoryInkExportStore();
    store.failTextWrite = true;

    await expect(writeInkSvgExport(surface(), store)).rejects.toThrow('write failed');

    expect(store.text.size).toBe(0);
    expect(store.removed).toEqual(['Inkstone Exports/Ink - Folder-Ink-Note.md - Intro-.svg']);
  });
});

class MemoryInkExportStore implements InkExportFileStore {
  readonly binary = new Map<string, ArrayBuffer>();
  readonly directories: string[] = [];
  failTextWrite = false;
  readonly removed: string[] = [];
  readonly text: Map<string, string>;

  constructor(initial: readonly (readonly [string, string])[] = []) {
    this.text = new Map(initial);
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.text.has(path) || this.binary.has(path));
  }

  mkdir(path: string): Promise<void> {
    this.directories.push(path);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    this.text.delete(path);
    this.binary.delete(path);
    this.removed.push(path);
    return Promise.resolve();
  }

  write(path: string, contents: string): Promise<void> {
    this.text.set(path, contents);
    if (this.failTextWrite) return Promise.reject(new Error('write failed'));
    return Promise.resolve();
  }

  writeBinary(path: string, contents: ArrayBuffer): Promise<void> {
    this.binary.set(path, contents);
    return Promise.resolve();
  }
}

function surface(): InkSurfaceRecord {
  return {
    binding: {
      blockFingerprints: ['intro'],
      headingPath: ['Intro?'],
      sectionFingerprint: 'intro',
      sourceEnd: 80,
      sourceStart: 0,
    },
    createdAt: '2026-07-15T00:00:00.000Z',
    filePath: 'Folder/Ink:Note.md',
    id: 'surface-1',
    layout: {
      blockFingerprints: ['intro'],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 50,
      logicalWidth: 100,
      sourceRevision: 'source-1',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: [
      {
        color: '#111111',
        id: 'stroke-1',
        points: [
          { pressure: 0.5, time: 0, x: 10, y: 10 },
          { pressure: 0.5, time: 1, x: 90, y: 40 },
        ],
        tool: 'pen',
        width: 2,
      },
    ],
    updatedAt: '2026-07-15T00:00:00.000Z',
  };
}
