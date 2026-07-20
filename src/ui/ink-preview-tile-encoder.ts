export interface InkPreviewTileEncoder {
  dispose(): void;
  encode(canvas: OffscreenCanvas): Promise<ArrayBuffer | null>;
}

interface PendingEncode {
  readonly resolve: (bytes: ArrayBuffer | null) => void;
}

interface PreviewEncoderWorkerMessage {
  readonly bytes?: ArrayBuffer;
  readonly id?: number;
  readonly type?: string;
}

/** PNG encoding is optional disposable-cache work and must never fall back to the main thread. */
export class InkPreviewTileWorkerEncoder implements InkPreviewTileEncoder {
  private disposed = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingEncode>();
  private worker: Worker | null = null;

  constructor() {
    this.worker = createPreviewEncoderWorker();
    if (this.worker === null) return;
    this.worker.onmessage = ({ data }: MessageEvent<PreviewEncoderWorkerMessage>) => {
      const id = data.id;
      if (!Number.isSafeInteger(id)) return;
      const pending = this.pending.get(id as number);
      if (pending === undefined) return;
      this.pending.delete(id as number);
      pending.resolve(
        data.type === 'encoded' && data.bytes instanceof ArrayBuffer ? data.bytes : null,
      );
    };
    this.worker.onerror = () => this.fail();
    this.worker.onmessageerror = () => this.fail();
  }

  encode(canvas: OffscreenCanvas): Promise<ArrayBuffer | null> {
    const worker = this.worker;
    if (this.disposed || worker === null) return Promise.resolve(null);
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      try {
        const bitmap = canvas.transferToImageBitmap();
        worker.postMessage(
          { bitmap, height: canvas.height, id, type: 'encode', width: canvas.width },
          [bitmap],
        );
      } catch {
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fail();
  }

  private fail(): void {
    const worker = this.worker;
    this.worker = null;
    try {
      worker?.terminate();
    } catch {
      // A failed disposable-cache Worker is already unusable.
    }
    for (const { resolve } of this.pending.values()) resolve(null);
    this.pending.clear();
  }
}

function createPreviewEncoderWorker(): Worker | null {
  if (
    typeof globalThis.Worker !== 'function' ||
    typeof globalThis.Blob !== 'function' ||
    typeof globalThis.URL?.createObjectURL !== 'function'
  ) {
    return null;
  }
  let objectUrl: string | null = null;
  try {
    objectUrl = globalThis.URL.createObjectURL(
      new Blob([`(${previewEncoderWorkerMain.toString()})();`], { type: 'text/javascript' }),
    );
    return new Worker(objectUrl);
  } catch {
    return null;
  } finally {
    if (objectUrl !== null) globalThis.URL.revokeObjectURL(objectUrl);
  }
}

function previewEncoderWorkerMain(): void {
  const scope = self as unknown as {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage(message: unknown, transfer: Transferable[]): void;
  };
  scope.onmessage = (event): void => {
    const input = event.data as {
      readonly bitmap?: ImageBitmap;
      readonly height?: number;
      readonly id?: number;
      readonly width?: number;
    };
    const id = input.id;
    const bitmap = input.bitmap;
    const width = input.width;
    const height = input.height;
    if (
      !Number.isSafeInteger(id) ||
      bitmap === undefined ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height)
    ) {
      return;
    }
    const canvas = new OffscreenCanvas(width as number, height as number);
    const context = canvas.getContext('2d');
    if (context === null) {
      bitmap.close();
      scope.postMessage({ id, type: 'failed' }, []);
      return;
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    void canvas
      .convertToBlob({ type: 'image/png' })
      .then((blob) => blob.arrayBuffer())
      .then(
        (bytes) => scope.postMessage({ bytes, id, type: 'encoded' }, [bytes]),
        () => scope.postMessage({ id, type: 'failed' }, []),
      );
  };
}
