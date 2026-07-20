import { assertInkSurfaceRecord, type InkSurfaceRecord } from '../domain/ink-surface';
import type { InkCompiledBrushGeometry } from '../domain/ink-brush-geometry-contract';
import { SharedInkStrokeGeometry } from '../domain/ink-shared-stroke-geometry';
import { joinInkStrokeSurfaceFragments } from '../domain/ink-surface-layout';

export interface InkExportBackgroundOptions {
  readonly background: string;
}

const SHARED_GEOMETRY = new SharedInkStrokeGeometry();

export function exportInkSvg(
  record: InkSurfaceRecord,
  options: InkExportBackgroundOptions = { background: 'transparent' },
): string {
  return renderInkSvgScene(compileSingleSurfaceScene(record), options);
}

/** Cold multi-surface export path; linked fragments are joined in note-global coordinates first. */
export function exportInkSvgRecords(
  records: readonly InkSurfaceRecord[],
  options: InkExportBackgroundOptions = { background: 'transparent' },
): string {
  return renderInkSvgScene(compileJoinedSurfaceScene(records), options);
}

interface CompiledInkExportScene {
  readonly geometries: readonly InkCompiledBrushGeometry[];
  readonly logicalHeight: number;
  readonly logicalWidth: number;
}

function renderInkSvgScene(
  scene: CompiledInkExportScene,
  options: InkExportBackgroundOptions,
): string {
  const bounds = sharedVisibleBounds(scene.logicalWidth, scene.logicalHeight, scene.geometries);
  const background =
    options.background === 'transparent'
      ? ''
      : `<rect width="100%" height="100%" fill="${escapeXml(options.background)}"/>`;
  const paths = scene.geometries.map(renderSvgGeometry).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${format(bounds.minX)} ${format(bounds.minY)} ${format(bounds.width)} ${format(bounds.height)}" role="img" aria-label="Ink annotation">${background}${paths}</svg>`;
}

function renderSvgGeometry(geometry: InkCompiledBrushGeometry): string {
  const metadata = `data-ink-stroke-id="${escapeXml(geometry.logicalStrokeId)}" data-ink-tool="${geometry.tool}" data-ink-brush-version="${geometry.version}" data-ink-geometry-digest="${geometry.geometryDigest}"`;
  if (geometry.version === 'legacy-round-v1') {
    const grid = geometry.quantization.logicalGrid;
    const path = geometry.coverage.centerline
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'} ${format(point.x * grid)} ${format(point.y * grid)}`,
      )
      .join(' ');
    const paint = legacyExportPaint(geometry.tool, geometry.color);
    const opacity = paint.opacity === 1 ? '' : ` opacity="${format(paint.opacity)}"`;
    const width = geometry.coverage.diameterUnits * grid;
    return `<path ${metadata} d="${path}" fill="none" stroke="${escapeXml(paint.color)}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${format(width)}"${opacity}/>`;
  }
  const grid = geometry.quantization.logicalGrid;
  const path = geometry.coverage.contours
    .map((contour) =>
      contour
        .map(
          (point, index) =>
            `${index === 0 ? 'M' : 'L'} ${format(point.x * grid)} ${format(point.y * grid)}`,
        )
        .join(' ')
        .concat(' Z'),
    )
    .join(' ');
  const opacity =
    geometry.blend.alpha.value === 1 ? '' : ` opacity="${format(geometry.blend.alpha.value)}"`;
  return `<path ${metadata} d="${path}" fill="${escapeXml(geometry.color)}" fill-rule="${geometry.hitShape.fillRule}"${opacity}/>`;
}

function legacyExportPaint(
  tool: Extract<InkCompiledBrushGeometry, { readonly version: 'legacy-round-v1' }>['tool'],
  sourceColor: string,
): { readonly color: string; readonly opacity: number } {
  const alphaColor = /^#(?<rgb>[0-9a-f]{6})(?<alpha>[0-9a-f]{2})$/iu.exec(sourceColor);
  const alpha = alphaColor?.groups?.alpha;
  const rgb = alphaColor?.groups?.rgb;
  return {
    color: rgb === undefined ? sourceColor : `#${rgb}`,
    opacity:
      alpha === undefined ? (tool === 'highlighter' ? 0.45 : 1) : Number.parseInt(alpha, 16) / 255,
  };
}

export function exportInkPng(
  record: InkSurfaceRecord,
  options: { readonly background: string; readonly height: number; readonly width: number },
): Uint8Array {
  return renderInkPngScene(compileSingleSurfaceScene(record), options);
}

/** Cold multi-surface PNG export path sharing the same joined geometry scene as SVG and HTML. */
export function exportInkPngRecords(
  records: readonly InkSurfaceRecord[],
  options: { readonly background: string; readonly height: number; readonly width: number },
): Uint8Array {
  return renderInkPngScene(compileJoinedSurfaceScene(records), options);
}

function renderInkPngScene(
  scene: CompiledInkExportScene,
  options: { readonly background: string; readonly height: number; readonly width: number },
): Uint8Array {
  assertRasterDimensions(options.width, options.height);
  const pixels = new Uint8Array(options.width * options.height * 4);
  if (options.background !== 'transparent') {
    const background = parseColor(options.background);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      pixels.set(background, offset);
    }
  }
  const bounds = sharedVisibleBounds(scene.logicalWidth, scene.logicalHeight, scene.geometries);
  const scaleX = options.width / bounds.width;
  const scaleY = options.height / bounds.height;
  for (const geometry of scene.geometries) {
    rasterGeometry(
      pixels,
      options.width,
      options.height,
      geometry,
      scaleX,
      scaleY,
      bounds.minX,
      bounds.minY,
    );
  }
  return encodePng(options.width, options.height, pixels);
}

export function renderInkStandaloneHtml(
  records: readonly InkSurfaceRecord[],
  input: { readonly generatedAt: string; readonly title: string },
): string {
  const sections = groupStandaloneRecords(records)
    .map((group) => {
      const first = group[0];
      if (first === undefined) throw new Error('Ink standalone export group cannot be empty.');
      const heading = first.binding?.headingPath.join(' › ') || first.filePath || 'Document';
      const scene = compileJoinedSurfaceScene(group);
      const count = scene.geometries.length;
      const statuses = [...new Set(group.map((record) => record.status))].join(', ');
      return `<section><h2>${escapeHtml(heading)}</h2><p>${count} ${count === 1 ? 'stroke' : 'strokes'} · ${escapeHtml(statuses)}</p>${renderInkSvgScene(scene, { background: 'transparent' })}</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style>body{font-family:system-ui,sans-serif;max-width:960px;margin:auto;padding:24px}section{margin-block:24px}svg{display:block;width:100%;height:auto;border:1px solid #ccc;background:#fff}p{color:#666}</style></head><body><h1>${escapeHtml(input.title)}</h1><p>Generated ${escapeHtml(input.generatedAt)}</p>${sections}</body></html>
`;
}

function groupStandaloneRecords(
  records: readonly InkSurfaceRecord[],
): readonly (readonly InkSurfaceRecord[])[] {
  const groups = new Map<string, InkSurfaceRecord[]>();
  for (const record of records) {
    if (record.deletedAt !== undefined) continue;
    const key = `${record.filePath}\u0000${record.noteId}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [record]);
    else group.push(record);
  }
  return [...groups.values()];
}

function compileVisibleSharedInk(
  strokes: InkSurfaceRecord['strokes'],
): readonly InkCompiledBrushGeometry[] {
  return strokes
    .filter((stroke) => stroke.tool !== 'eraser')
    .map((stroke) => {
      const result = SHARED_GEOMETRY.compile(stroke);
      if (result.kind === 'exact' || result.kind === 'unpublished') return result.geometry;
      if (result.kind === 'degraded') {
        throw new Error(
          `Ink export refuses degraded ${result.requestedVersion} geometry: ${result.diagnostic}.`,
        );
      }
      throw new Error(
        `Unsupported Ink Brush Geometry ${result.requestedVersion}: ${result.reason}.`,
      );
    });
}

function sharedVisibleBounds(
  logicalWidth: number,
  logicalHeight: number,
  geometries: readonly InkCompiledBrushGeometry[],
): {
  readonly height: number;
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
} {
  let minimumX = 0;
  let minimumY = 0;
  let maximumX = logicalWidth;
  let maximumY = logicalHeight;
  for (const { bounds } of geometries) {
    minimumX = Math.min(minimumX, bounds.x);
    minimumY = Math.min(minimumY, bounds.y);
    maximumX = Math.max(maximumX, bounds.x + bounds.width);
    maximumY = Math.max(maximumY, bounds.y + bounds.height);
  }
  return {
    height: maximumY - minimumY,
    minX: minimumX,
    minY: minimumY,
    width: maximumX - minimumX,
  };
}

function compileSingleSurfaceScene(record: InkSurfaceRecord): CompiledInkExportScene {
  assertInkSurfaceRecord(record);
  const startY = record.schemaVersion === 1 ? 0 : (record.layout.originY as number);
  joinInkStrokeSurfaceFragments(
    record.strokes
      .filter((stroke) => stroke.tool !== 'eraser')
      .map((stroke) => ({
        endY: startY + record.layout.logicalHeight,
        logicalHeight: record.layout.logicalHeight,
        schemaVersion: record.schemaVersion,
        startY,
        stroke,
        surfaceId: record.id,
      })),
  );
  return {
    geometries: compileVisibleSharedInk(record.strokes),
    logicalHeight: record.layout.logicalHeight,
    logicalWidth: record.layout.logicalWidth,
  };
}

function compileJoinedSurfaceScene(
  sourceRecords: readonly InkSurfaceRecord[],
): CompiledInkExportScene {
  if (sourceRecords.length === 0) {
    throw new Error('Ink multi-surface export requires at least one surface.');
  }
  for (const record of sourceRecords) assertInkSurfaceRecord(record);
  const first = sourceRecords[0] as InkSurfaceRecord;
  if (
    sourceRecords.some(
      (record) => record.filePath !== first.filePath || record.noteId !== first.noteId,
    )
  ) {
    throw new Error('Ink multi-surface export can join only one note at a time.');
  }
  const schemaVersions = new Set(sourceRecords.map((record) => record.schemaVersion));
  if (schemaVersions.size > 1) {
    throw new Error('Ink multi-surface export refuses mixed canonical schema versions.');
  }
  const ordered = [...sourceRecords].sort((left, right) =>
    left.schemaVersion === 1
      ? (left.binding?.sourceStart ?? Number.MAX_SAFE_INTEGER) -
          (right.binding?.sourceStart ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id)
      : (left.layout.originY as number) - (right.layout.originY as number) ||
        left.id.localeCompare(right.id),
  );
  let cumulativeOrigin = 0;
  let logicalHeight = 0;
  let logicalWidth = 0;
  const fragments = ordered.flatMap((record) => {
    const startY =
      record.schemaVersion === 1 ? cumulativeOrigin : (record.layout.originY as number);
    cumulativeOrigin = startY + record.layout.logicalHeight;
    logicalHeight = Math.max(logicalHeight, cumulativeOrigin);
    logicalWidth = Math.max(logicalWidth, record.layout.logicalWidth);
    return record.strokes
      .filter((stroke) => stroke.tool !== 'eraser')
      .map((stroke) => ({
        endY: startY + record.layout.logicalHeight,
        logicalHeight: record.layout.logicalHeight,
        schemaVersion: record.schemaVersion,
        startY,
        stroke,
        surfaceId: record.id,
      }));
  });
  return {
    geometries: compileVisibleSharedInk(joinInkStrokeSurfaceFragments(fragments)),
    logicalHeight,
    logicalWidth,
  };
}

function rasterGeometry(
  pixels: Uint8Array,
  width: number,
  height: number,
  geometry: InkCompiledBrushGeometry,
  scaleX: number,
  scaleY: number,
  minimumX: number,
  minimumY: number,
): void {
  if (geometry.version !== 'legacy-round-v1') {
    rasterFilledContours(pixels, width, height, geometry, scaleX, scaleY, minimumX, minimumY);
    return;
  }
  const paint = legacyExportPaint(geometry.tool, geometry.color);
  const color = parseColor(paint.color);
  color[3] = Math.round((color[3] as number) * paint.opacity);
  const grid = geometry.quantization.logicalGrid;
  const radius = Math.max(
    0.5,
    (geometry.coverage.diameterUnits * grid * Math.min(scaleX, scaleY)) / 2,
  );
  const points = geometry.coverage.centerline;
  if (points.length === 1) {
    const only = points[0];
    if (only === undefined) return;
    paintDisk(
      pixels,
      width,
      height,
      (only.x * grid - minimumX) * scaleX,
      (only.y * grid - minimumY) * scaleY,
      radius,
      color,
    );
    return;
  }
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (start === undefined || end === undefined) continue;
    const startX = (start.x * grid - minimumX) * scaleX;
    const startY = (start.y * grid - minimumY) * scaleY;
    const endX = (end.x * grid - minimumX) * scaleX;
    const endY = (end.y * grid - minimumY) * scaleY;
    const steps = Math.max(1, Math.ceil(Math.hypot(endX - startX, endY - startY) * 1.5));
    for (let step = 0; step <= steps; step += 1) {
      const ratio = step / steps;
      paintDisk(
        pixels,
        width,
        height,
        startX + (endX - startX) * ratio,
        startY + (endY - startY) * ratio,
        radius,
        color,
      );
    }
  }
}

const PHYSICAL_RASTER_SAMPLE_AXIS = 4;

function rasterFilledContours(
  pixels: Uint8Array,
  width: number,
  height: number,
  geometry: Extract<
    InkCompiledBrushGeometry,
    { readonly version: 'highlighter-chisel-v1' | 'pen-physical-v1' }
  >,
  scaleX: number,
  scaleY: number,
  minimumX: number,
  minimumY: number,
): void {
  const grid = geometry.quantization.logicalGrid;
  const contours = geometry.coverage.contours.map((contour) =>
    contour.map((point) => ({
      x: (point.x * grid - minimumX) * scaleX,
      y: (point.y * grid - minimumY) * scaleY,
    })),
  );
  const left = Math.max(0, Math.floor((geometry.bounds.x - minimumX) * scaleX) - 1);
  const top = Math.max(0, Math.floor((geometry.bounds.y - minimumY) * scaleY) - 1);
  const right = Math.min(
    width - 1,
    Math.ceil((geometry.bounds.x + geometry.bounds.width - minimumX) * scaleX) + 1,
  );
  const bottom = Math.min(
    height - 1,
    Math.ceil((geometry.bounds.y + geometry.bounds.height - minimumY) * scaleY) + 1,
  );
  const baseColor = parseColor(geometry.color);
  const brushAlpha = geometry.blend.alpha.value;
  const sampleCount = PHYSICAL_RASTER_SAMPLE_AXIS * PHYSICAL_RASTER_SAMPLE_AXIS;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      let covered = 0;
      for (let sampleY = 0; sampleY < PHYSICAL_RASTER_SAMPLE_AXIS; sampleY += 1) {
        for (let sampleX = 0; sampleX < PHYSICAL_RASTER_SAMPLE_AXIS; sampleX += 1) {
          if (
            insideNonzeroContours(
              x + (sampleX + 0.5) / PHYSICAL_RASTER_SAMPLE_AXIS,
              y + (sampleY + 0.5) / PHYSICAL_RASTER_SAMPLE_AXIS,
              contours,
            )
          ) {
            covered += 1;
          }
        }
      }
      if (covered === 0) continue;
      const source = baseColor.slice();
      source[3] = Math.round((baseColor[3] as number) * brushAlpha * (covered / sampleCount));
      blendPixel(pixels, (y * width + x) * 4, source);
    }
  }
}

function insideNonzeroContours(
  x: number,
  y: number,
  contours: readonly (readonly { readonly x: number; readonly y: number }[])[],
): boolean {
  let winding = 0;
  for (const contour of contours) {
    for (let index = 1; index < contour.length; index += 1) {
      const start = contour[index - 1];
      const end = contour[index];
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

function paintDisk(
  pixels: Uint8Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
  source: Uint8Array,
): void {
  const minimumX = Math.max(0, Math.floor(centerX - radius));
  const maximumX = Math.min(width - 1, Math.ceil(centerX + radius));
  const minimumY = Math.max(0, Math.floor(centerY - radius));
  const maximumY = Math.min(height - 1, Math.ceil(centerY + radius));
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      if (Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY) > radius) continue;
      blendPixel(pixels, (y * width + x) * 4, source);
    }
  }
}

function blendPixel(target: Uint8Array, offset: number, source: Uint8Array): void {
  const sourceAlpha = (source[3] as number) / 255;
  const targetAlpha = (target[offset + 3] as number) / 255;
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outputAlpha === 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    target[offset + channel] = Math.round(
      ((source[channel] as number) * sourceAlpha +
        (target[offset + channel] as number) * targetAlpha * (1 - sourceAlpha)) /
        outputAlpha,
    );
  }
  target[offset + 3] = Math.round(outputAlpha * 255);
}

function encodePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    const scanlineOffset = row * (width * 4 + 1);
    scanlines[scanlineOffset] = 0;
    scanlines.set(pixels.slice(row * width * 4, (row + 1) * width * 4), scanlineOffset + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  return concatenate([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateUncompressed(scanlines)),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

function deflateUncompressed(input: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [Uint8Array.from([0x78, 0x01])];
  for (let offset = 0; offset < input.length; offset += 65_535) {
    const data = input.slice(offset, Math.min(input.length, offset + 65_535));
    const block = new Uint8Array(data.length + 5);
    block[0] = offset + data.length >= input.length ? 1 : 0;
    block[1] = data.length & 0xff;
    block[2] = (data.length >>> 8) & 0xff;
    const complement = ~data.length & 0xffff;
    block[3] = complement & 0xff;
    block[4] = (complement >>> 8) & 0xff;
    block.set(data, 5);
    blocks.push(block);
  }
  const checksum = new Uint8Array(4);
  new DataView(checksum.buffer).setUint32(0, adler32(input));
  blocks.push(checksum);
  return concatenate(blocks);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((character) => character.charCodeAt(0)));
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(data.length + 8, crc32(concatenate([typeBytes, data])));
  return chunk;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let first = 1;
  let second = 0;
  for (const byte of bytes) {
    first = (first + byte) % 65_521;
    second = (second + first) % 65_521;
  }
  return ((second << 16) | first) >>> 0;
}

function parseColor(value: string): Uint8Array {
  const match = /^#([0-9a-f]{3,8})$/iu.exec(value);
  if (match === null) throw new Error(`Ink export color is unsupported: ${value}`);
  let hex = match[1] as string;
  if (hex.length === 3 || hex.length === 4) {
    hex = [...hex].map((character) => `${character}${character}`).join('');
  }
  if (hex.length !== 6 && hex.length !== 8) {
    throw new Error(`Ink export color is unsupported: ${value}`);
  }
  return Uint8Array.from([
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
    hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255,
  ]);
}

function assertRasterDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 16_777_216
  ) {
    throw new Error('Ink PNG dimensions must be positive integers within the pixel budget.');
  }
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function format(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(8).replace(/0+$/u, '').replace(/\.$/u, '');
}

function escapeXml(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
