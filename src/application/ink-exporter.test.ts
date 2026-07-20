// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { SharedInkStrokeGeometry } from '../domain/ink-shared-stroke-geometry';
import { splitInkStrokeIntoSurfaceFragments } from '../domain/ink-surface-layout';
import type { InkSurfaceRecord } from '../domain/ink-surface';
import {
  exportInkPng,
  exportInkPngRecords,
  exportInkSvg,
  renderInkStandaloneHtml,
} from './ink-exporter';

describe('Ink portability exports', () => {
  it('exports parseable SVG with logical geometry and tool semantics', () => {
    const source = surface();
    const svg = exportInkSvg(source, { background: 'transparent' });
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const firstStroke = source.strokes[0];
    if (firstStroke === undefined) throw new Error('Missing Ink fixture stroke.');
    const shared = new SharedInkStrokeGeometry().compile(firstStroke);
    if (!('geometry' in shared)) throw new Error('Expected shared legacy geometry.');

    expect(parsed.querySelector('parsererror')).toBeNull();
    expect(parsed.documentElement.getAttribute('viewBox')).toBe('0 0 100 50');
    expect(parsed.querySelectorAll('path')).toHaveLength(2);
    expect(parsed.querySelector('path')?.getAttribute('d')).toBe('M 10 10 L 90 40');
    expect(parsed.querySelector('path')?.getAttribute('data-ink-brush-version')).toBe(
      'legacy-round-v1',
    );
    expect(parsed.querySelector('path')?.getAttribute('data-ink-geometry-digest')).toBe(
      shared.geometry.geometryDigest,
    );
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

  it('fails closed instead of exporting an unknown v3 Brush Render Version as legacy Ink', () => {
    const base = surface();
    const invalid = {
      ...base,
      layout: { ...base.layout, originY: 0 },
      schemaVersion: 3,
      strokes: [
        {
          ...base.strokes[0],
          brushRenderVersion: 'future-brush-v9',
          inputProfile: { pressure: 'measured', tilt: 'measured' },
        },
      ],
    } as unknown as InkSurfaceRecord;

    expect(() => exportInkSvg(invalid)).toThrow(/unsupported brush metadata/u);
    expect(() =>
      exportInkPng(invalid, { background: 'transparent', height: 50, width: 100 }),
    ).toThrow(/unsupported brush metadata/u);
    expect(() =>
      renderInkStandaloneHtml([invalid], {
        generatedAt: '2026-07-14T13:00:00.000Z',
        title: 'Ink report',
      }),
    ).toThrow(/unsupported brush metadata/u);
  });

  it('exports candidate physical Pen as its shared quantized filled contours', () => {
    const parsed = new DOMParser().parseFromString(
      exportInkSvg(physicalSurface()),
      'image/svg+xml',
    );
    const path = parsed.querySelector('[data-ink-brush-version="pen-physical-v1"]');

    expect(parsed.querySelector('parsererror')).toBeNull();
    expect(path).not.toBeNull();
    expect(path?.getAttribute('fill')).toBe('#112233');
    expect(path?.getAttribute('fill-rule')).toBe('nonzero');
    expect(path?.getAttribute('stroke')).toBeNull();
    expect(path?.getAttribute('stroke-width')).toBeNull();
    expect(path?.getAttribute('d')).toMatch(/^M .+ Z(?: M .+ Z)*$/u);
  });

  it('rasterizes candidate physical Pen from shared filled contours in PNG', () => {
    const rgba = decodeUncompressedPng(
      exportInkPng(physicalSurface(), {
        background: 'transparent',
        height: 100,
        width: 200,
      }),
    );

    expect(rgba.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
  });

  it('applies physical Highlighter density once per Logical Stroke and source-over between strokes', () => {
    const one = decodeUncompressedPng(
      exportInkPng(physicalHighlighterSurface(1), {
        background: 'transparent',
        height: 100,
        width: 200,
      }),
    );
    const two = decodeUncompressedPng(
      exportInkPng(physicalHighlighterSurface(2), {
        background: 'transparent',
        height: 100,
        width: 200,
      }),
    );
    const crossingAlpha = (50 * 200 + 100) * 4 + 3;
    const oneStrokeAlpha = Math.round(0.35 * 255);
    const normalized = oneStrokeAlpha / 255;

    expect(one[crossingAlpha]).toBe(oneStrokeAlpha);
    expect(two[crossingAlpha]).toBe(Math.round((normalized + normalized * (1 - normalized)) * 255));

    const svg = new DOMParser().parseFromString(
      exportInkSvg(physicalHighlighterSurface(1)),
      'image/svg+xml',
    );
    const path = svg.querySelector('[data-ink-brush-version="highlighter-chisel-v1"]');
    expect(path?.getAttribute('opacity')).toBe('0.35');
    expect(path?.getAttribute('d')?.split(' Z').length).toBeGreaterThan(2);
  });

  it('joins linked physical fragments before standalone SVG compilation without a cap or alpha seam', () => {
    const records = splitPhysicalHighlighterSurfaces();
    const html = renderInkStandaloneHtml(records, {
      generatedAt: '2026-07-18T00:00:00.000Z',
      title: 'Joined Ink',
    });
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const paths = parsed.querySelectorAll('[data-ink-stroke-id="joined-highlighter"]');

    expect(paths).toHaveLength(1);
    expect(paths[0]?.getAttribute('opacity')).toBe('0.35');
    expect(paths[0]?.getAttribute('d')).toContain(' 50 ');
    expect(parsed.querySelectorAll('section')).toHaveLength(1);
    expect(parsed.querySelector('section > p')?.textContent).toContain('1 stroke');
  });

  it('refuses direct SVG and PNG export of an incomplete linked physical fragment', () => {
    const [top] = splitPhysicalHighlighterSurfaces();
    if (top === undefined) throw new Error('Missing partial export fixture.');

    expect(() => exportInkSvg(top)).toThrow(/incomplete physical fragment boundary/u);
    expect(() => exportInkPng(top, { background: 'transparent', height: 100, width: 100 })).toThrow(
      /incomplete physical fragment boundary/u,
    );
  });

  it('joins linked physical fragments before multi-surface PNG rasterization', () => {
    const rgba = decodeUncompressedPng(
      exportInkPngRecords(splitPhysicalHighlighterSurfaces(), {
        background: 'transparent',
        height: 200,
        width: 200,
      }),
    );
    const boundaryAlpha = (100 * 200 + 100) * 4 + 3;

    expect(rgba[boundaryAlpha]).toBe(Math.round(0.35 * 255));
    expect(rgba[boundaryAlpha - 200 * 4]).toBe(Math.round(0.35 * 255));
    expect(rgba[boundaryAlpha + 200 * 4]).toBe(Math.round(0.35 * 255));
  });
});

function physicalSurface(): InkSurfaceRecord {
  const base = surface();
  const pen = base.strokes[0];
  if (pen === undefined) throw new Error('Missing Ink fixture stroke.');
  return {
    ...base,
    layout: { ...base.layout, originY: 0 },
    schemaVersion: 3,
    strokes: [
      {
        ...pen,
        brushRenderVersion: 'pen-physical-v1',
        color: '#112233',
        inputProfile: { pressure: 'measured', tilt: 'measured' },
        points: pen.points.map((point) => ({
          orientation: { kind: 'unavailable' as const },
          pressure: point.pressure,
          pressureKind: 'measured' as const,
          time: point.time,
          x: point.x,
          y: point.y,
        })),
      },
    ],
  };
}

function physicalHighlighterSurface(strokeCount: number): InkSurfaceRecord {
  const base = surface();
  const points = [20, 80, 20].map((x, index) => ({
    orientation: {
      altitude: 0.2,
      azimuth: 0,
      kind: 'measured' as const,
      reliable: true,
    },
    pressure: 0.5,
    pressureKind: 'measured' as const,
    time: index * 10,
    x,
    y: 25,
  }));
  return {
    ...base,
    layout: { ...base.layout, originY: 0 },
    schemaVersion: 3,
    strokes: Array.from({ length: strokeCount }, (_unused, index) => ({
      brushRenderVersion: 'highlighter-chisel-v1' as const,
      color: '#ffcc00',
      id: `physical-highlighter-${index}`,
      inputProfile: { pressure: 'measured' as const, tilt: 'measured' as const },
      points,
      tool: 'highlighter' as const,
      width: 8,
    })),
  };
}

function splitPhysicalHighlighterSurfaces(): readonly InkSurfaceRecord[] {
  const stroke = {
    brushRenderVersion: 'highlighter-chisel-v1' as const,
    color: '#ffcc00',
    id: 'joined-highlighter',
    inputProfile: { pressure: 'measured' as const, tilt: 'measured' as const },
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
    tool: 'highlighter' as const,
    width: 10,
  };
  const fragments = splitInkStrokeIntoSurfaceFragments({
    stroke,
    surfaces: [
      { endY: 50, id: 'top', logicalHeight: 50, startY: 0 },
      { endY: 100, id: 'bottom', logicalHeight: 50, startY: 50 },
    ],
  });
  return fragments.map((fragment, index) => ({
    ...surface(),
    filePath: 'Joined.md',
    id: fragment.surfaceId,
    layout: {
      ...surface().layout,
      logicalHeight: 50,
      originY: index * 50,
    },
    schemaVersion: 3,
    strokes: [fragment.stroke],
  }));
}

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
    if (type === 'IDAT') {
      for (const byte of png.slice(offset + 8, offset + 8 + length)) idat.push(byte);
    }
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
    for (const byte of compressed.slice(cursor, cursor + length)) output.push(byte);
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
