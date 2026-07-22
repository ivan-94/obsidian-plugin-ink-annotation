import type { SnapshotAnnotationFlattener } from '../../application/snapshot-annotation-export';
import type { SnapshotAnnotationRecord } from '../../domain/snapshot-annotation';

interface SnapshotThumbnailResizeInput {
  readonly height: number;
  readonly pngBytes: Uint8Array;
  readonly signal: AbortSignal;
  readonly width: number;
}

type SnapshotThumbnailResizer = (input: SnapshotThumbnailResizeInput) => Promise<string>;

const SNAPSHOT_THUMBNAIL_MAX_EDGE = 640;

export class BrowserSnapshotThumbnailer {
  private readonly flattener: SnapshotAnnotationFlattener;
  private readonly resize: SnapshotThumbnailResizer;

  constructor(input: {
    readonly document?: Document;
    readonly flattener: SnapshotAnnotationFlattener;
    readonly resize?: SnapshotThumbnailResizer;
  }) {
    this.flattener = input.flattener;
    this.resize =
      input.resize ??
      ((request) => resizeBrowserPng(input.document ?? globalThis.document, request));
  }

  async create(
    record: SnapshotAnnotationRecord,
    pngBytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<string> {
    const flattened = await this.flattener.flatten(record, pngBytes, signal);
    const scale = Math.min(
      1,
      SNAPSHOT_THUMBNAIL_MAX_EDGE / Math.max(record.asset.pixelWidth, record.asset.pixelHeight),
    );
    return this.resize({
      height: Math.max(1, Math.round(record.asset.pixelHeight * scale)),
      pngBytes: flattened,
      signal,
      width: Math.max(1, Math.round(record.asset.pixelWidth * scale)),
    });
  }
}

async function resizeBrowserPng(
  document: Document,
  input: SnapshotThumbnailResizeInput,
): Promise<string> {
  if (input.signal.aborted) throw abortError();
  if (typeof globalThis.createImageBitmap !== 'function') {
    throw new Error('This browser cannot decode a Snapshot thumbnail.');
  }
  const bitmap = await globalThis.createImageBitmap(
    new Blob([Uint8Array.from(input.pngBytes).buffer], { type: 'image/png' }),
  );
  try {
    if (input.signal.aborted) throw abortError();
    const canvas = document.createElement('canvas');
    canvas.width = input.width;
    canvas.height = input.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Snapshot thumbnail Canvas 2D is unavailable.');
    context.drawImage(bitmap, 0, 0, input.width, input.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value === null
            ? reject(new Error('Snapshot thumbnail PNG encoding failed.'))
            : resolve(value),
        'image/png',
      ),
    );
    return await blobToDataUrl(blob);
  } finally {
    bitmap.close();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Snapshot thumbnail encoding failed.'));
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Snapshot thumbnail encoding returned no data URL.'));
    reader.readAsDataURL(blob);
  });
}

function abortError(): DOMException {
  return new DOMException('Snapshot thumbnail was cancelled.', 'AbortError');
}
