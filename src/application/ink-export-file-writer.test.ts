import { describe, expect, it } from 'vitest';

import type { InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import { splitInkStrokeIntoSurfaceFragments } from '../domain/ink-surface-layout';
import {
  assertInkExportLoadSupported,
  type InkExportFileStore,
  writeInkPngExport,
  writeInkStandaloneReport,
  writeInkSvgExport,
} from './ink-export-file-writer';

describe('Ink export file writer', () => {
  it('rejects a partial-note export when canonical Ink is unsupported', () => {
    expect(() =>
      assertInkExportLoadSupported([
        {
          kind: 'unsupported-record',
          message: 'Update Inkstone before exporting this note.',
        },
      ]),
    ).toThrow('Update Inkstone before exporting this note.');

    expect(() =>
      assertInkExportLoadSupported([
        {
          kind: 'conflict',
          message: 'Resolve the divergent Ink artifacts before exporting.',
        },
      ]),
    ).toThrow('Resolve the divergent Ink artifacts before exporting.');
  });

  it('fails closed when a repository issue kind is unknown at the runtime boundary', () => {
    expect(() =>
      assertInkExportLoadSupported([
        {
          kind: 'Unsupported-record',
          message: 'Malformed runtime issue kind.',
        } as never,
      ]),
    ).toThrow(/unknown repository issue kind/u);
  });

  it('sanitizes names and chooses a unique SVG path without overwriting an existing export', async () => {
    const existing = 'Inkstone Exports/Ink - Folder-Ink-Note.md - Intro-.svg';
    const store = new MemoryInkExportStore([[existing, 'existing']]);

    const path = await writeInkSvgExport(surface(), store);

    expect(path).toBe('Inkstone Exports/Ink - Folder-Ink-Note.md - Intro- 2.svg');
    expect(store.text.get(existing)).toBe('existing');
    expect(store.text.get(path)).toMatch(/^<svg[\s\S]*<path[\s\S]*<\/svg>\n$/u);
    expect(store.directories).toEqual(['Inkstone Exports']);
  });

  it('joins the selected Logical Stroke across related surfaces before writing SVG', async () => {
    const store = new MemoryInkExportStore();
    const [top, bottom] = linkedPhysicalSurfaces();
    if (top === undefined || bottom === undefined) throw new Error('Missing linked Ink fixture.');

    const path = await writeInkSvgExport(top, store, [top, bottom]);
    const svg = store.text.get(path) ?? '';

    expect(svg.match(/data-ink-stroke-id="logical-highlighter"/gu)).toHaveLength(1);
    expect(svg).toContain('viewBox="0 0 100 100"');
    expect(svg).toContain('data-ink-brush-version="highlighter-chisel-v1"');
    expect(svg).toContain('fill="#ffcc00"');
    expect(svg).not.toContain('stroke-width=');
  });

  it('refuses SVG and PNG writes when a selected linked stroke is missing its sibling', async () => {
    const svgStore = new MemoryInkExportStore();
    const pngStore = new MemoryInkExportStore();
    const [top] = linkedPhysicalSurfaces();
    if (top === undefined) throw new Error('Missing partial Ink export fixture.');

    await expect(writeInkSvgExport(top, svgStore, [top])).rejects.toThrow(
      /incomplete physical fragment boundary/u,
    );
    await expect(writeInkPngExport(top, pngStore, [top])).rejects.toThrow(
      /incomplete physical fragment boundary/u,
    );

    expect(svgStore.text.size).toBe(0);
    expect(pngStore.binary.size).toBe(0);
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

  it('writes a joined cross-surface PNG with the note-global aspect ratio', async () => {
    const store = new MemoryInkExportStore();
    const [top, bottom] = linkedPhysicalSurfaces();
    if (top === undefined || bottom === undefined) throw new Error('Missing linked Ink fixture.');

    const path = await writeInkPngExport(top, store, [top, bottom]);
    const bytes = new Uint8Array(store.binary.get(path) ?? new ArrayBuffer(0));

    expect(readUint32(bytes, 16)).toBe(100);
    expect(readUint32(bytes, 20)).toBe(100);
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

function linkedPhysicalSurfaces(): readonly InkSurfaceRecord[] {
  const base = surface();
  const stroke: InkStroke = {
    brushRenderVersion: 'highlighter-chisel-v1',
    color: '#ffcc00',
    id: 'logical-highlighter',
    inputProfile: { pressure: 'measured', tilt: 'measured' },
    points: [40, 50, 60].map((y, index) => ({
      orientation: {
        altitude: 0.25,
        azimuth: Math.PI / 2,
        kind: 'measured' as const,
        reliable: true,
      },
      pressure: 0.5,
      pressureKind: 'measured' as const,
      time: index * 10,
      x: 50,
      y,
    })),
    tool: 'highlighter',
    width: 10,
  };
  const fragments = splitInkStrokeIntoSurfaceFragments({
    stroke,
    surfaces: [
      { endY: 50, id: 'top', logicalHeight: 50, startY: 0 },
      { endY: 100, id: 'bottom', logicalHeight: 50, startY: 50 },
    ],
  });
  return fragments.map((fragment) => ({
    ...base,
    filePath: 'Folder/Joined.md',
    id: fragment.surfaceId,
    layout: {
      ...base.layout,
      logicalHeight: 50,
      originY: fragment.surfaceId === 'top' ? 0 : 50,
    },
    schemaVersion: 3,
    strokes: [fragment.stroke],
  }));
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}
