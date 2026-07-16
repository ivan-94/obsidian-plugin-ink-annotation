// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import type { InkSurfaceRecord } from '../domain/ink-surface';
import { exportInkPng, exportInkSvg, renderInkStandaloneHtml } from './ink-exporter';

describe('Ink portability exports', () => {
  it('exports parseable SVG with logical geometry and tool semantics', () => {
    const svg = exportInkSvg(surface(), { background: 'transparent' });
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');

    expect(parsed.querySelector('parsererror')).toBeNull();
    expect(parsed.documentElement.getAttribute('viewBox')).toBe('0 0 100 50');
    expect(parsed.querySelectorAll('path')).toHaveLength(2);
    expect(parsed.querySelector('path')?.getAttribute('d')).toBe('M 10 10 L 90 40');
    expect(parsed.querySelector('[data-ink-tool="highlighter"]')?.getAttribute('opacity')).toBe(
      '0.45',
    );
  });

  it('expands SVG and PNG mapping for Ink outside the document width', () => {
    const base = surface();
    const first = base.strokes[0];
    if (first === undefined) throw new Error('Missing Ink fixture stroke.');
    const outside = {
      ...base,
      strokes: [
        {
          ...first,
          points: [point(-20, 10), point(120, 40)],
        },
      ],
    };

    const svg = new DOMParser().parseFromString(exportInkSvg(outside), 'image/svg+xml');
    expect(svg.documentElement.getAttribute('viewBox')).toBe('-21 0 142 50');
    const png = exportInkPng(outside, { background: 'transparent', height: 50, width: 142 });
    expect(decodeUncompressedPng(png).some((value, index) => index % 4 === 3 && value > 0)).toBe(
      true,
    );
  });

  it('exports a valid RGBA PNG with requested dimensions and background', () => {
    const png = exportInkPng(surface(), { background: '#ffffff', height: 100, width: 200 });

    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(readUint32(png, 16)).toBe(200);
    expect(readUint32(png, 20)).toBe(100);
    const rgba = decodeUncompressedPng(png);
    expect([...rgba.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    const painted = rgba.some((value, index) => index % 4 !== 3 && value < 240);
    expect(painted).toBe(true);
  });

  it('builds a standalone HTML report containing accessible vector Ink', () => {
    const html = renderInkStandaloneHtml([surface()], {
      generatedAt: '2026-07-14T13:00:00.000Z',
      title: 'Ink report',
    });

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Ink report');
    expect(html).toContain('2 strokes');
    expect(html).toContain('<svg');
  });
});

function surface(): InkSurfaceRecord {
  return {
    binding: {
      blockFingerprints: ['a'],
      headingPath: ['Intro'],
      sectionFingerprint: 'a',
      sourceEnd: 100,
      sourceStart: 0,
    },
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Ink.md',
    id: 'surface-a',
    layout: {
      blockFingerprints: ['a'],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 50,
      logicalWidth: 100,
      sourceRevision: 'source',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: [
      {
        color: '#111111',
        id: 'pen',
        points: [point(10, 10), point(90, 40)],
        tool: 'pen',
        width: 2,
      },
      {
        color: '#ffd54f',
        id: 'mark',
        points: [point(20, 25), point(80, 25)],
        tool: 'highlighter',
        width: 8,
      },
    ],
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}

function point(x: number, y: number) {
  return { pressure: 0.5, time: x + y, x, y };
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function decodeUncompressedPng(png: Uint8Array): Uint8Array {
  let offset = 8;
  const idat: number[] = [];
  while (offset < png.length) {
    const length = readUint32(png, offset);
    const type = String.fromCharCode(...png.slice(offset + 4, offset + 8));
    if (type === 'IDAT') idat.push(...png.slice(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const compressed = Uint8Array.from(idat);
  const output: number[] = [];
  let cursor = 2;
  while (cursor < compressed.length - 4) {
    const header = compressed[cursor] as number;
    cursor += 1;
    const length = (compressed[cursor] as number) | ((compressed[cursor + 1] as number) << 8);
    cursor += 4;
    output.push(...compressed.slice(cursor, cursor + length));
    cursor += length;
    if ((header & 1) === 1) break;
  }
  const scanlines = Uint8Array.from(output);
  const width = readUint32(png, 16);
  const height = readUint32(png, 20);
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    rgba.set(
      scanlines.slice(row * (width * 4 + 1) + 1, (row + 1) * (width * 4 + 1)),
      row * width * 4,
    );
  }
  return rgba;
}
