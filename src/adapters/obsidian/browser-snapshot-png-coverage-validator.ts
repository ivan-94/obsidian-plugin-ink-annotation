type SnapshotPixelSampler = (
  pngBytes: Uint8Array,
  signal: AbortSignal,
) => Promise<Uint8ClampedArray>;

export class BrowserSnapshotPngCoverageValidator {
  private readonly samplePixels: SnapshotPixelSampler;

  constructor(
    input: { readonly document?: Document; readonly samplePixels?: SnapshotPixelSampler } = {},
  ) {
    this.samplePixels =
      input.samplePixels ??
      ((pngBytes, signal) =>
        sampleBrowserPixels(input.document ?? globalThis.document, pngBytes, signal));
  }

  async assertNonblank(pngBytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const pixels = await this.samplePixels(pngBytes, signal);
    if (signal.aborted) throw new DOMException('Snapshot validation was cancelled.', 'AbortError');
    if (pixels.length < 8 || pixels.length % 4 !== 0) {
      throw new Error('Snapshot PNG coverage sample is invalid.');
    }
    let minimum = 255;
    let maximum = 0;
    let maximumAlpha = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      minimum = Math.min(
        minimum,
        pixels[offset] ?? 255,
        pixels[offset + 1] ?? 255,
        pixels[offset + 2] ?? 255,
      );
      maximum = Math.max(
        maximum,
        pixels[offset] ?? 0,
        pixels[offset + 1] ?? 0,
        pixels[offset + 2] ?? 0,
      );
      maximumAlpha = Math.max(maximumAlpha, pixels[offset + 3] ?? 0);
    }
    if (maximumAlpha === 0 || maximum - minimum <= 2) {
      throw new Error('Snapshot PNG is uniform or blank; capture was not accepted.');
    }
  }
}

async function sampleBrowserPixels(
  document: Document,
  pngBytes: Uint8Array,
  signal: AbortSignal,
): Promise<Uint8ClampedArray> {
  if (typeof globalThis.createImageBitmap !== 'function') {
    throw new Error('This browser cannot validate Snapshot PNG coverage.');
  }
  const bitmap = await globalThis.createImageBitmap(
    new Blob([Uint8Array.from(pngBytes).buffer], { type: 'image/png' }),
  );
  try {
    if (signal.aborted) throw new DOMException('Snapshot validation was cancelled.', 'AbortError');
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('Snapshot coverage Canvas 2D is unavailable.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  } finally {
    bitmap.close();
  }
}
