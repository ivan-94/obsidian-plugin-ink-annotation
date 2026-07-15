import type { InkPoint, InkStroke, InkSurfaceRecord } from '../domain/ink-surface';

export interface InkExportBackgroundOptions {
  readonly background: string;
}

export function exportInkSvg(
  record: InkSurfaceRecord,
  options: InkExportBackgroundOptions = { background: 'transparent' },
): string {
  const background =
    options.background === 'transparent'
      ? ''
      : `<rect width="100%" height="100%" fill="${escapeXml(options.background)}"/>`;
  const paths = record.strokes
    .filter((stroke) => stroke.tool !== 'eraser')
    .map((stroke) => {
      const path = stroke.points
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${format(point.x)} ${format(point.y)}`)
        .join(' ');
      const opacity = stroke.tool === 'highlighter' ? ' opacity="0.45"' : '';
      return `<path data-ink-stroke-id="${escapeXml(stroke.linkedStrokeId ?? stroke.id)}" data-ink-tool="${stroke.tool}" d="${path}" fill="none" stroke="${escapeXml(stroke.color)}" stroke-linecap="round" stroke-linejoin="round" stroke-width="${format(stroke.width)}"${opacity}/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${format(record.layout.logicalWidth)} ${format(record.layout.logicalHeight)}" role="img" aria-label="Ink annotation">${background}${paths}</svg>`;
}

export function exportInkPng(
  record: InkSurfaceRecord,
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
  const scaleX = options.width / record.layout.logicalWidth;
  const scaleY = options.height / record.layout.logicalHeight;
  for (const stroke of record.strokes) {
    if (stroke.tool === 'eraser') continue;
    const color = parseColor(stroke.color);
    if (stroke.tool === 'highlighter') color[3] = Math.round((color[3] as number) * 0.45);
    rasterStroke(pixels, options.width, options.height, stroke, scaleX, scaleY, color);
  }
  return encodePng(options.width, options.height, pixels);
}

export function renderInkStandaloneHtml(
  records: readonly InkSurfaceRecord[],
  input: { readonly generatedAt: string; readonly title: string },
): string {
  const sections = records
    .filter((record) => record.deletedAt === undefined)
    .map((record) => {
      const heading = record.binding?.headingPath.join(' › ') || 'Document';
      const count = record.strokes.filter((stroke) => stroke.tool !== 'eraser').length;
      return `<section><h2>${escapeHtml(heading)}</h2><p>${count} ${count === 1 ? 'stroke' : 'strokes'} · ${escapeHtml(record.status)}</p>${exportInkSvg(record)}</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style>body{font-family:system-ui,sans-serif;max-width:960px;margin:auto;padding:24px}section{margin-block:24px}svg{display:block;width:100%;height:auto;border:1px solid #ccc;background:#fff}p{color:#666}</style></head><body><h1>${escapeHtml(input.title)}</h1><p>Generated ${escapeHtml(input.generatedAt)}</p>${sections}</body></html>
`;
}

function rasterStroke(
  pixels: Uint8Array,
  width: number,
  height: number,
  stroke: InkStroke,
  scaleX: number,
  scaleY: number,
  color: Uint8Array,
): void {
  const radius = Math.max(0.5, (stroke.width * Math.min(scaleX, scaleY)) / 2);
  const points = stroke.points;
  if (points.length === 1) {
    const only = points[0] as InkPoint;
    paintDisk(pixels, width, height, only.x * scaleX, only.y * scaleY, radius, color);
    return;
  }
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (start === undefined || end === undefined) continue;
    const startX = start.x * scaleX;
    const startY = start.y * scaleY;
    const endX = end.x * scaleX;
    const endY = end.y * scaleY;
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
    : value.toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '');
}

function escapeXml(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
