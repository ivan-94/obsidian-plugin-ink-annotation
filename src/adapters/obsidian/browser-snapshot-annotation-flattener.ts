import type { SnapshotAnnotationFlattener } from '../../application/snapshot-annotation-export';
import type { InkBrushCompilationResult } from '../../domain/ink-brush-geometry-contract';
import { SharedInkStrokeGeometry } from '../../domain/ink-shared-stroke-geometry';
import { readPngImageDimensions } from '../../domain/png-image';
import type { SnapshotAnnotationRecord } from '../../domain/snapshot-annotation';

type ExactBrushGeometry = Extract<InkBrushCompilationResult, { readonly kind: 'exact' }>;

export interface SnapshotFlattenRasterInput {
  readonly geometries: readonly ExactBrushGeometry[];
  readonly pixelHeight: number;
  readonly pixelRatio: number;
  readonly pixelWidth: number;
  readonly pngBytes: Uint8Array;
  readonly signal: AbortSignal;
}

export type SnapshotFlattenRasterizer = (input: SnapshotFlattenRasterInput) => Promise<Uint8Array>;

export class BrowserSnapshotAnnotationFlattener implements SnapshotAnnotationFlattener {
  private readonly geometry = new SharedInkStrokeGeometry();
  private readonly rasterize: SnapshotFlattenRasterizer;

  constructor(input: {
    readonly document?: Document;
    readonly rasterize?: SnapshotFlattenRasterizer;
  }) {
    this.rasterize =
      input.rasterize ??
      ((request) => rasterizeBrowserSnapshot(input.document ?? globalThis.document, request));
  }

  async flatten(
    record: SnapshotAnnotationRecord,
    pngBytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (signal.aborted) throw abortError();
    const source = readPngImageDimensions(pngBytes);
    if (source.width !== record.asset.pixelWidth || source.height !== record.asset.pixelHeight) {
      throw new Error('Snapshot export image dimensions do not match its canonical record.');
    }
    const geometries = record.ink.strokes.map((stroke): ExactBrushGeometry => {
      const result = this.geometry.compile(stroke);
      if (result.kind !== 'exact') {
        const requestedVersion =
          'requestedVersion' in result
            ? result.requestedVersion
            : String(stroke.brushRenderVersion ?? 'legacy-round-v1');
        throw new Error(`Snapshot export refused unsupported brush renderer ${requestedVersion}.`);
      }
      return result;
    });
    const flattened = await this.rasterize({
      geometries,
      pixelHeight: record.asset.pixelHeight,
      pixelRatio: record.asset.pixelRatio,
      pixelWidth: record.asset.pixelWidth,
      pngBytes: Uint8Array.from(pngBytes),
      signal,
    });
    if (signal.aborted) throw abortError();
    const result = readPngImageDimensions(flattened);
    if (result.width !== record.asset.pixelWidth || result.height !== record.asset.pixelHeight) {
      throw new Error('Snapshot export rasterizer returned unexpected PNG dimensions.');
    }
    return flattened;
  }
}

async function rasterizeBrowserSnapshot(
  document: Document,
  input: SnapshotFlattenRasterInput,
): Promise<Uint8Array> {
  if (typeof globalThis.createImageBitmap !== 'function') {
    throw new Error('This browser cannot decode a Snapshot PNG for export.');
  }
  const bitmap = await globalThis.createImageBitmap(
    new Blob([Uint8Array.from(input.pngBytes).buffer], { type: 'image/png' }),
  );
  try {
    if (input.signal.aborted) throw abortError();
    const canvas = document.createElement('canvas');
    canvas.width = input.pixelWidth;
    canvas.height = input.pixelHeight;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Snapshot export Canvas 2D is unavailable.');
    context.drawImage(bitmap, 0, 0, input.pixelWidth, input.pixelHeight);
    context.setTransform(input.pixelRatio, 0, 0, input.pixelRatio, 0, 0);
    for (const compiled of input.geometries) paintGeometry(context, compiled);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) =>
          value === null
            ? reject(new Error('Snapshot flattened PNG encoding failed.'))
            : resolve(value),
        'image/png',
      );
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function paintGeometry(context: CanvasRenderingContext2D, compiled: ExactBrushGeometry): void {
  const geometry = compiled.geometry;
  const grid = geometry.quantization.logicalGrid;
  context.save();
  context.globalAlpha =
    geometry.blend.alpha.kind === 'fixed'
      ? geometry.blend.alpha.value
      : alphaFromCanonicalColor(geometry.color);
  context.globalCompositeOperation = 'source-over';
  if (geometry.version === 'legacy-round-v1') {
    const first = geometry.coverage.centerline[0];
    if (first !== undefined) {
      context.beginPath();
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.lineWidth = geometry.coverage.diameterUnits * grid;
      context.strokeStyle = geometry.color;
      context.moveTo(first.x * grid, first.y * grid);
      for (const point of geometry.coverage.centerline.slice(1)) {
        context.lineTo(point.x * grid, point.y * grid);
      }
      if (geometry.coverage.centerline.length === 1) {
        context.lineTo(first.x * grid + 0.01, first.y * grid + 0.01);
      }
      context.stroke();
    }
  } else {
    context.fillStyle = geometry.color;
    context.beginPath();
    for (const contour of geometry.coverage.contours) {
      const first = contour[0];
      if (first === undefined) continue;
      context.moveTo(first.x * grid, first.y * grid);
      for (const point of contour.slice(1)) context.lineTo(point.x * grid, point.y * grid);
      context.closePath();
    }
    context.fill(geometry.hitShape.fillRule);
  }
  context.restore();
}

function alphaFromCanonicalColor(color: string): number {
  const match = /^#[0-9a-f]{6}(?<alpha>[0-9a-f]{2})$/iu.exec(color);
  return match?.groups?.alpha === undefined ? 1 : Number.parseInt(match.groups.alpha, 16) / 255;
}

function abortError(): DOMException {
  return new DOMException('Snapshot export was cancelled.', 'AbortError');
}
