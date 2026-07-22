// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  compareInkBrushRasterReplays,
  type InkBrushRasterReplay,
  type InkBrushRasterSnapshot,
  type InkBrushRasterTool,
} from '../domain/ink-brush-raster-oracle';
import type { InkCompiledBrushGeometry } from '../domain/ink-brush-geometry-contract';
import { SharedInkStrokeGeometry } from '../domain/ink-shared-stroke-geometry';
import type { InkSurfaceRecord } from '../domain/ink-surface';
import { drawInkBrushGeometryToCanvas } from '../ui/ink-brush-canvas-adapter';
import { exportInkPng, exportInkSvg } from './ink-exporter';

const WIDTH = 200;
const HEIGHT = 100;
const SCALE = 2;
const SAMPLE_AXIS = 4;
const RASTER_BOUNDS = Object.freeze({ height: 50, width: 100, x: 0, y: 0 });

describe('Ink physical export cross-adapter raster evidence', () => {
  it.each(['pen', 'highlighter'] as const)(
    'keeps %s Canvas, SVG, and PNG coverage within the fixed S28 oracle',
    (tool) => {
      const record = physicalRecord(tool);
      const canvas = replay(() => rasterCanvasAdapter(record));
      const svg = replay(() => rasterSvgAdapter(record, tool));
      const png = replay(() => rasterPngAdapter(record, tool));

      const svgComparison = compareInkBrushRasterReplays({
        candidate: svg,
        reference: canvas,
        tool,
      });
      const pngComparison = compareInkBrushRasterReplays({
        candidate: png,
        reference: canvas,
        tool,
      });

      if (svgComparison.kind === 'compared' && !svgComparison.passed) {
        throw new Error(`SVG comparison failed: ${JSON.stringify(svgComparison.metrics)}`);
      }
      if (pngComparison.kind === 'compared' && !pngComparison.passed) {
        throw new Error(`PNG comparison failed: ${JSON.stringify(pngComparison.metrics)}`);
      }
      expect(svgComparison).toMatchObject({
        checks: {
          alphaWeightedIoU: true,
          boundaryP95: true,
          maximumNormalizedAlphaDelta: true,
        },
        deterministic: true,
        kind: 'compared',
        passed: true,
      });
      expect(pngComparison).toMatchObject({
        checks: {
          alphaWeightedIoU: true,
          boundaryP95: true,
          maximumNormalizedAlphaDelta: true,
        },
        deterministic: true,
        kind: 'compared',
        passed: true,
      });
    },
    10_000,
  );
});

function replay(build: () => InkBrushRasterSnapshot): InkBrushRasterReplay {
  return { first: build(), replay: build() };
}

function rasterCanvasAdapter(record: InkSurfaceRecord): InkBrushRasterSnapshot {
  const geometry = compileOnlyGeometry(record);
  const context = new RasterCanvasContext();
  drawInkBrushGeometryToCanvas(context.asCanvas(), geometry);
  const fill = context.onlyFill();
  return rasterContours(fill.contours, fill.alpha);
}

function rasterSvgAdapter(
  record: InkSurfaceRecord,
  tool: InkBrushRasterTool,
): InkBrushRasterSnapshot {
  const parsed = new DOMParser().parseFromString(exportInkSvg(record), 'image/svg+xml');
  const path = parsed.querySelector(`[data-ink-tool="${tool}"]`);
  if (path === null) throw new Error('SVG adapter omitted physical Brush Geometry.');
  const data = path.getAttribute('d');
  if (data === null) throw new Error('SVG adapter omitted physical contour data.');
  return rasterContours(parseFilledSvgPath(data), Number(path.getAttribute('opacity') ?? 1));
}

function rasterPngAdapter(
  record: InkSurfaceRecord,
  tool: InkBrushRasterTool,
): InkBrushRasterSnapshot {
  const rgba = decodeUncompressedPng(
    exportInkPng(record, { background: 'transparent', height: HEIGHT, width: WIDTH }),
  );
  const alpha = new Uint8Array(WIDTH * HEIGHT);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = rgba[index * 4 + 3] as number;
  }
  const fullAlpha = Math.round((tool === 'pen' ? 1 : 0.35) * 255);
  const coverage = alpha.map((value) => Math.min(255, Math.round((value / fullAlpha) * 255)));
  return { alpha, bounds: RASTER_BOUNDS, coverage, height: HEIGHT, scale: SCALE, width: WIDTH };
}

function compileOnlyGeometry(record: InkSurfaceRecord): InkCompiledBrushGeometry {
  const stroke = record.strokes[0];
  if (stroke === undefined) throw new Error('Missing physical raster fixture stroke.');
  const result = new SharedInkStrokeGeometry().compile(stroke);
  if (!('geometry' in result) || result.kind === 'degraded') {
    throw new Error('Expected exact candidate physical Brush Geometry.');
  }
  return result.geometry;
}

function rasterContours(
  contours: readonly (readonly RasterPoint[])[],
  opacity: number,
): InkBrushRasterSnapshot {
  const coverage = new Uint8Array(WIDTH * HEIGHT);
  const alpha = new Uint8Array(WIDTH * HEIGHT);
  const samples = SAMPLE_AXIS * SAMPLE_AXIS;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      let covered = 0;
      for (let sampleY = 0; sampleY < SAMPLE_AXIS; sampleY += 1) {
        for (let sampleX = 0; sampleX < SAMPLE_AXIS; sampleX += 1) {
          const logicalX = (x + (sampleX + 0.5) / SAMPLE_AXIS) / SCALE;
          const logicalY = (y + (sampleY + 0.5) / SAMPLE_AXIS) / SCALE;
          if (insideNonzero(logicalX, logicalY, contours)) covered += 1;
        }
      }
      const index = y * WIDTH + x;
      coverage[index] = Math.round((covered / samples) * 255);
      alpha[index] = Math.round((covered / samples) * opacity * 255);
    }
  }
  return { alpha, bounds: RASTER_BOUNDS, coverage, height: HEIGHT, scale: SCALE, width: WIDTH };
}

interface RasterPoint {
  readonly x: number;
  readonly y: number;
}

function insideNonzero(
  x: number,
  y: number,
  contours: readonly (readonly RasterPoint[])[],
): boolean {
  let winding = 0;
  for (const contour of contours) {
    const first = contour[0];
    if (first === undefined) continue;
    for (let index = 0; index < contour.length; index += 1) {
      const start = contour[index];
      const end = contour[(index + 1) % contour.length];
      if (start === undefined || end === undefined) continue;
      const side = (end.x - start.x) * (y - start.y) - (x - start.x) * (end.y - start.y);
      if (start.y <= y) {
        if (end.y > y && side > 0) winding += 1;
      } else if (end.y <= y && side < 0) {
        winding -= 1;
      }
    }
  }
  return winding !== 0;
}

function parseFilledSvgPath(data: string): readonly (readonly RasterPoint[])[] {
  const tokens = data.match(/[MLZ]|-?(?:\d+(?:\.\d+)?|\.\d+)/gu) ?? [];
  const contours: RasterPoint[][] = [];
  let current: RasterPoint[] | null = null;
  for (let index = 0; index < tokens.length;) {
    const command = tokens[index];
    index += 1;
    if (command === 'Z') {
      current = null;
      continue;
    }
    if (command !== 'M' && command !== 'L') throw new Error('Unsupported SVG contour command.');
    const x = Number(tokens[index]);
    const y = Number(tokens[index + 1]);
    index += 2;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid SVG contour point.');
    if (command === 'M') {
      current = [];
      contours.push(current);
    }
    if (current === null) throw new Error('SVG line command has no contour.');
    current.push({ x, y });
  }
  return contours;
}

interface RecordedCanvasFill {
  readonly alpha: number;
  readonly contours: readonly (readonly RasterPoint[])[];
}

class RasterCanvasContext {
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  private current: RasterPoint[] | null = null;
  private readonly fills: RecordedCanvasFill[] = [];
  private path: RasterPoint[][] = [];
  private readonly stack: number[] = [];

  asCanvas(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D;
  }

  beginPath(): void {
    this.path = [];
    this.current = null;
  }

  closePath(): void {
    this.current = null;
  }

  fill(): void {
    this.fills.push({
      alpha: this.globalAlpha,
      contours: this.path.map((contour) => contour.map((point) => ({ ...point }))),
    });
  }

  lineTo(x: number, y: number): void {
    if (this.current === null) throw new Error('Canvas lineTo has no current contour.');
    this.current.push({ x, y });
  }

  moveTo(x: number, y: number): void {
    this.current = [{ x, y }];
    this.path.push(this.current);
  }

  onlyFill(): RecordedCanvasFill {
    const fill = this.fills[0];
    if (fill === undefined || this.fills.length !== 1) {
      throw new Error('Physical Canvas adapter must isolate one fill per Logical Stroke.');
    }
    return fill;
  }

  restore(): void {
    this.globalAlpha = this.stack.pop() ?? 1;
  }

  save(): void {
    this.stack.push(this.globalAlpha);
  }
}

function physicalRecord(tool: InkBrushRasterTool): InkSurfaceRecord {
  const orientation =
    tool === 'pen'
      ? ({ kind: 'unavailable' } as const)
      : ({
          altitude: 0.25,
          azimuth: 0,
          kind: 'measured' as const,
          reliable: true,
        } as const);
  const points = (tool === 'pen' ? [10, 50, 90] : [20, 80, 20]).map((x, index) => ({
    orientation,
    pressure: tool === 'pen' ? ([0.2, 0.85, 0.5][index] ?? 0.5) : 0.5,
    pressureKind: 'measured' as const,
    time: index * 10,
    x,
    y: tool === 'pen' ? 15 + index * 10 : 25,
  }));
  const stroke =
    tool === 'pen'
      ? {
          brushRenderVersion: 'pen-physical-v1' as const,
          color: '#112233',
          id: 'physical-pen',
          inputProfile: { pressure: 'measured' as const, tilt: 'unavailable' as const },
          points,
          tool,
          width: 5,
        }
      : {
          brushRenderVersion: 'highlighter-chisel-v1' as const,
          color: '#ffcc00',
          id: 'physical-highlighter',
          inputProfile: { pressure: 'measured' as const, tilt: 'measured' as const },
          points,
          tool,
          width: 10,
        };
  return {
    createdAt: '2026-07-18T00:00:00.000Z',
    filePath: 'Raster.md',
    id: `surface-${tool}`,
    layout: {
      blockFingerprints: [],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 50,
      logicalWidth: 100,
      originY: 0,
      sourceRevision: 'source-1',
      themeMode: 'light',
    },
    noteId: 'note-raster',
    revision: 1,
    schemaVersion: 3,
    status: 'active',
    strokes: [stroke],
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
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
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let row = 0; row < HEIGHT; row += 1) {
    rgba.set(
      scanlines.slice(row * (WIDTH * 4 + 1) + 1, (row + 1) * (WIDTH * 4 + 1)),
      row * WIDTH * 4,
    );
  }
  return rgba;
}
