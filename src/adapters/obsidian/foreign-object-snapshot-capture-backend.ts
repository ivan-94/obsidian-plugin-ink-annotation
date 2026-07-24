import { readPngImageDimensions } from '../../domain/png-image';
import {
  resolveSnapshotCaptureSubject,
  SnapshotCaptureError,
  type SnapshotCaptureBackend,
  type SnapshotCaptureBackendResult,
  type SnapshotCaptureCapabilities,
  type SnapshotCaptureRequest,
} from './snapshot-capture-backend';
import {
  inlineSnapshotCaptureImages,
  inlineSnapshotCaptureComputedStyles,
  removeSnapshotCaptureExcludedNodes,
  replaceDirectlyUnsupportedCaptureNodes,
  replaceGeneratedCaptureNodesForRetry,
  resolveLoadedSnapshotImageDataUrl,
  type SnapshotLocalImageResolver,
} from './snapshot-dom-capture-preparation';

interface ForeignObjectRasterInput {
  readonly pixelHeight: number;
  readonly pixelWidth: number;
  readonly signal: AbortSignal;
  readonly svg: string;
}

type ForeignObjectRasterizer = (input: ForeignObjectRasterInput) => Promise<Uint8Array>;
type SvgImageLoader = (dataUrl: string, signal: AbortSignal) => Promise<CanvasImageSource>;

const CAPABILITIES = Object.freeze({
  backendId: 'inkstone-foreign-object',
  backendVersion: '1',
  contentClasses: Object.freeze([
    'headings-paragraphs',
    'inline-formatting',
    'lists',
    'blockquotes-callouts',
    'tables-code',
    'vault-local-raster-images',
    'svg-math-generated-best-effort',
    'resource-level-placeholders',
  ]),
  platform: 'web' as const,
  supportsCancellation: true,
});

export class ForeignObjectSnapshotCaptureBackend implements SnapshotCaptureBackend {
  private readonly document: Document;
  private readonly rasterizeSvg: ForeignObjectRasterizer;
  private readonly resolveImageDataUrl: SnapshotLocalImageResolver;

  constructor(
    input: {
      readonly document?: Document;
      readonly loadSvgImage?: SvgImageLoader;
      readonly rasterizeSvg?: ForeignObjectRasterizer;
      readonly resolveImageDataUrl?: SnapshotLocalImageResolver;
    } = {},
  ) {
    this.document = input.document ?? globalThis.document;
    const loadSvgImage =
      input.loadSvgImage ??
      ((dataUrl: string, signal: AbortSignal) =>
        loadSvgDataUrlImage(this.document, dataUrl, signal));
    this.rasterizeSvg =
      input.rasterizeSvg ??
      ((request) => rasterizeForeignObject(this.document, request, loadSvgImage));
    this.resolveImageDataUrl = input.resolveImageDataUrl ?? resolveLoadedSnapshotImageDataUrl;
  }

  describe(): SnapshotCaptureCapabilities {
    return CAPABILITIES;
  }

  async capture(request: SnapshotCaptureRequest): Promise<SnapshotCaptureBackendResult> {
    if (request.signal.aborted) throw aborted();
    const subject = resolveSnapshotCaptureSubject(request.subject);
    if (!isElement(subject)) {
      throw new SnapshotCaptureError(
        'backend-unavailable',
        'Inkstone foreignObject capture requires a Reading DOM root.',
      );
    }
    const clone = subject.cloneNode(true) as HTMLElement;
    removeSnapshotCaptureExcludedNodes(clone);
    await inlineSnapshotCaptureComputedStyles(subject, clone, request.signal);
    await inlineSnapshotCaptureImages(subject, clone, request.signal, this.resolveImageDataUrl);
    replaceDirectlyUnsupportedCaptureNodes(subject, clone);
    const bounds = request.subjectCssRect ?? subject.getBoundingClientRect();
    clone.removeAttribute('id');
    clone.style.margin = '0';
    clone.style.position = 'absolute';
    clone.style.transform = `translate(${bounds.left - request.viewportCssRect.left}px, ${bounds.top - request.viewportCssRect.top}px)`;
    clone.style.transformOrigin = '0 0';
    clone.style.width = `${bounds.width || request.viewportCssRect.width}px`;
    const { height, width } = request.viewportCssRect;
    const pixelWidth = Math.round(width * request.desiredPixelRatio);
    const pixelHeight = Math.round(height * request.desiredPixelRatio);
    let pngBytes: Uint8Array;
    let dimensions: ReturnType<typeof readPngImageDimensions>;
    try {
      pngBytes = await this.rasterizeSvg({
        pixelHeight,
        pixelWidth,
        signal: request.signal,
        svg: serializeForeignObjectClone(clone, width, height),
      });
      dimensions = readPngImageDimensions(pngBytes);
    } catch (error) {
      if (request.signal.aborted) throw aborted();
      if (replaceGeneratedCaptureNodesForRetry(clone) === 0) throw error;
      pngBytes = await this.rasterizeSvg({
        pixelHeight,
        pixelWidth,
        signal: request.signal,
        svg: serializeForeignObjectClone(clone, width, height),
      });
      dimensions = readPngImageDimensions(pngBytes);
    }
    if (request.signal.aborted) throw aborted();
    return Object.freeze({
      backendId: CAPABILITIES.backendId,
      backendVersion: CAPABILITIES.backendVersion,
      captureGeneration: request.captureGeneration,
      capturedCssRect: Object.freeze({ ...request.viewportCssRect }),
      mimeType: 'image/png' as const,
      pixelHeight: dimensions.height,
      pixelRatio: dimensions.width / width,
      pixelWidth: dimensions.width,
      pngBytes,
    });
  }
}

function serializeForeignObjectClone(clone: HTMLElement, width: number, height: number): string {
  const serialized = new XMLSerializer().serializeToString(clone);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;overflow:hidden;width:${width}px;height:${height}px">${serialized}</div></foreignObject></svg>`;
}

async function rasterizeForeignObject(
  document: Document,
  input: ForeignObjectRasterInput,
  loadSvgImage: SvgImageLoader,
): Promise<Uint8Array> {
  if (input.signal.aborted) throw aborted();
  const image = await loadSvgImage(svgDataUrl(input.svg), input.signal);
  if (input.signal.aborted) throw aborted();
  const canvas = document.createElement('canvas');
  canvas.width = input.pixelWidth;
  canvas.height = input.pixelHeight;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Snapshot foreignObject Canvas 2D is unavailable.');
  context.drawImage(image, 0, 0, input.pixelWidth, input.pixelHeight);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value === null ? reject(new Error('Snapshot PNG encoding failed.')) : resolve(value),
      'image/png',
    ),
  );
  if (input.signal.aborted) throw aborted();
  return new Uint8Array(await blob.arrayBuffer());
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function loadSvgDataUrlImage(
  document: Document,
  dataUrl: string,
  signal: AbortSignal,
): Promise<HTMLImageElement> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const image = document.createElement('img');
    const cleanup = (): void => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      image.src = '';
      reject(aborted());
    };
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error('Snapshot SVG image decoding failed.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    image.decoding = 'async';
    image.src = dataUrl;
  });
}

function isElement(value: unknown): value is HTMLElement {
  return typeof value === 'object' && value !== null && (value as Node).nodeType === 1;
}

function aborted(): SnapshotCaptureError {
  return new SnapshotCaptureError('aborted', 'Snapshot capture was cancelled.');
}
