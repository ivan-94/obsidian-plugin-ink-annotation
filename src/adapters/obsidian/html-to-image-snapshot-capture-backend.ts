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
  removeSnapshotCaptureExcludedNodes,
  replaceDirectlyUnsupportedCaptureNodes,
  replaceGeneratedCaptureNodesForRetry,
  resolveLoadedSnapshotImageDataUrl,
  SNAPSHOT_CAPTURE_EXCLUDED_SELECTOR,
  type SnapshotLocalImageResolver,
} from './snapshot-dom-capture-preparation';
import { toEmbeddedHtmlBlob } from './embedded-html-to-image-renderer';

type HtmlToImageRenderer = (
  node: HTMLElement,
  options: {
    readonly filter: (node: HTMLElement) => boolean;
    readonly height: number;
    readonly pixelRatio: number;
    readonly skipAutoScale: boolean;
    readonly skipFonts: boolean;
    readonly width: number;
  },
) => Promise<Blob | null>;

const CAPABILITIES = Object.freeze({
  backendId: 'html-to-image',
  backendVersion: '1.11.13',
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
  supportsCancellation: false,
});

export class HtmlToImageSnapshotCaptureBackend implements SnapshotCaptureBackend {
  private readonly document: Document;
  private readonly renderToBlob: HtmlToImageRenderer;
  private readonly resolveImageDataUrl: SnapshotLocalImageResolver;

  constructor(
    input: {
      readonly document?: Document;
      readonly renderToBlob?: HtmlToImageRenderer;
      readonly resolveImageDataUrl?: SnapshotLocalImageResolver;
    } = {},
  ) {
    this.document = input.document ?? globalThis.document;
    this.renderToBlob = input.renderToBlob ?? toEmbeddedHtmlBlob;
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
        'html-to-image Snapshot capture requires a Reading DOM root.',
      );
    }
    await waitForFontsBounded(this.document, request.signal);
    if (request.signal.aborted) throw aborted();
    const { clone, isolation } = isolateViewport(this.document, subject, request.viewportCssRect);
    try {
      await prepareHtmlToImageClone(subject, clone, request.signal, this.resolveImageDataUrl);
      positionIsolatedClone(
        clone,
        request.subjectCssRect ?? subject.getBoundingClientRect(),
        request.viewportCssRect,
      );
      // html-to-image applies pixelRatio to these CSS-pixel bounds itself.
      const options = {
        filter: includeCaptureNode,
        height: request.viewportCssRect.height,
        pixelRatio: request.desiredPixelRatio,
        skipAutoScale: true,
        skipFonts: true,
        width: request.viewportCssRect.width,
      };
      let fallbackUsed = false;
      let blob: Blob | null;
      try {
        blob = await this.renderToBlob(isolation, options);
      } catch (error) {
        if (request.signal.aborted) throw aborted();
        if (replaceGeneratedCaptureNodesForRetry(clone) === 0) throw error;
        fallbackUsed = true;
        blob = await this.renderToBlob(isolation, options);
      }
      if ((blob === null || blob.type !== 'image/png') && !fallbackUsed) {
        if (replaceGeneratedCaptureNodesForRetry(clone) > 0) {
          blob = await this.renderToBlob(isolation, options);
        }
      }
      if (request.signal.aborted) throw aborted();
      if (blob === null || blob.type !== 'image/png') {
        throw new SnapshotCaptureError(
          'invalid-result',
          'html-to-image did not return a PNG Snapshot.',
        );
      }
      const pngBytes = new Uint8Array(await blob.arrayBuffer());
      const dimensions = readPngImageDimensions(pngBytes);
      return Object.freeze({
        backendId: CAPABILITIES.backendId,
        backendVersion: CAPABILITIES.backendVersion,
        captureGeneration: request.captureGeneration,
        capturedCssRect: Object.freeze({ ...request.viewportCssRect }),
        mimeType: 'image/png' as const,
        pixelHeight: dimensions.height,
        pixelRatio: dimensions.width / request.viewportCssRect.width,
        pixelWidth: dimensions.width,
        pngBytes,
      });
    } finally {
      isolation.remove();
    }
  }
}

function isolateViewport(
  document: Document,
  source: HTMLElement,
  viewport: SnapshotCaptureRequest['viewportCssRect'],
): { readonly clone: HTMLElement; readonly isolation: HTMLElement } {
  const isolation = document.createElement('div');
  isolation.dataset.inkstoneSnapshotIsolation = '';
  preserveCaptureAncestorContext(source, isolation);
  // html-to-image serializes this position into its SVG; offscreen coordinates blank WKWebView.
  Object.assign(isolation.style, {
    background: resolveCaptureBackgroundColor(source),
    height: `${viewport.height}px`,
    left: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
    position: 'fixed',
    top: '0',
    width: `${viewport.width}px`,
    zIndex: '-2147483648',
  });
  const clone = source.cloneNode(true) as HTMLElement;
  isolation.append(clone);
  document.body.append(isolation);
  return { clone, isolation };
}

function preserveCaptureAncestorContext(source: HTMLElement, isolation: HTMLElement): void {
  let ancestor = source.parentElement;
  while (ancestor !== null && ancestor !== source.ownerDocument.body) {
    for (const className of ancestor.classList) isolation.classList.add(className);
    ancestor = ancestor.parentElement;
  }
}

function resolveCaptureBackgroundColor(source: HTMLElement): string {
  const view = source.ownerDocument.defaultView;
  if (view === null) return 'transparent';
  let element: HTMLElement | null = source;
  while (element !== null) {
    const color = view.getComputedStyle(element).backgroundColor;
    if (color !== 'transparent' && !/^rgba\(0,\s*0,\s*0,\s*0\)$/u.test(color)) return color;
    element = element.parentElement;
  }
  return 'transparent';
}

function positionIsolatedClone(
  clone: HTMLElement,
  sourceBounds: Pick<DOMRect, 'left' | 'top' | 'width'>,
  viewport: SnapshotCaptureRequest['viewportCssRect'],
): void {
  clone.removeAttribute('id');
  clone.style.margin = '0';
  clone.style.position = 'absolute';
  clone.style.transform = `translate(${sourceBounds.left - viewport.left}px, ${sourceBounds.top - viewport.top}px)`;
  clone.style.transformOrigin = '0 0';
  clone.style.width = `${sourceBounds.width}px`;
}

async function prepareHtmlToImageClone(
  sourceRoot: HTMLElement,
  cloneRoot: HTMLElement,
  signal: AbortSignal,
  resolveImageDataUrl: SnapshotLocalImageResolver,
): Promise<void> {
  removeSnapshotCaptureExcludedNodes(cloneRoot);
  await inlineSnapshotCaptureImages(sourceRoot, cloneRoot, signal, resolveImageDataUrl);
  replaceDirectlyUnsupportedCaptureNodes(sourceRoot, cloneRoot);
}

function includeCaptureNode(node: HTMLElement): boolean {
  return !(node.matches?.(SNAPSHOT_CAPTURE_EXCLUDED_SELECTOR) ?? false);
}

async function waitForFontsBounded(document: Document, signal: AbortSignal): Promise<void> {
  const fonts = document.fonts;
  if (fonts === undefined || fonts.status === 'loaded') return;
  await Promise.race([
    fonts.ready.catch(() => undefined),
    new Promise<void>((resolve) => globalThis.setTimeout(resolve, 180)),
  ]);
  if (signal.aborted) throw aborted();
}

function isElement(value: unknown): value is HTMLElement {
  return typeof value === 'object' && value !== null && (value as Node).nodeType === 1;
}

function aborted(): SnapshotCaptureError {
  return new SnapshotCaptureError('aborted', 'Snapshot capture was cancelled.');
}
