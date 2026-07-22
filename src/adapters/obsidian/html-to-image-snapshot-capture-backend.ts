import { toBlob } from 'html-to-image';

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
  pairSnapshotCaptureElements,
  removeSnapshotCaptureExcludedNodes,
  replaceDirectlyUnsupportedCaptureNodes,
  replaceGeneratedCaptureNodesForRetry,
  replaceSnapshotCaptureNodeWithPlaceholder,
  snapshotImageIsRemote,
  SNAPSHOT_CAPTURE_EXCLUDED_SELECTOR,
} from './snapshot-dom-capture-preparation';

type HtmlToImageRenderer = (
  node: HTMLElement,
  options: {
    readonly filter: (node: HTMLElement) => boolean;
    readonly height: number;
    readonly pixelRatio: number;
    readonly skipAutoScale: boolean;
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

  constructor(
    input: { readonly document?: Document; readonly renderToBlob?: HtmlToImageRenderer } = {},
  ) {
    this.document = input.document ?? globalThis.document;
    this.renderToBlob = input.renderToBlob ?? toBlob;
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
    prepareHtmlToImageClone(subject, clone);
    try {
      // html-to-image applies pixelRatio to these CSS-pixel bounds itself.
      const options = {
        filter: includeCaptureNode,
        height: request.viewportCssRect.height,
        pixelRatio: request.desiredPixelRatio,
        skipAutoScale: true,
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
  const sourceBounds = source.getBoundingClientRect();
  const isolation = document.createElement('div');
  isolation.dataset.inkstoneSnapshotIsolation = '';
  // html-to-image serializes this position into its SVG; offscreen coordinates blank WKWebView.
  Object.assign(isolation.style, {
    background: getComputedStyle(source).backgroundColor,
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
  clone.removeAttribute('id');
  clone.style.margin = '0';
  clone.style.position = 'absolute';
  clone.style.transform = `translate(${sourceBounds.left - viewport.left}px, ${sourceBounds.top - viewport.top}px)`;
  clone.style.transformOrigin = '0 0';
  clone.style.width = `${sourceBounds.width}px`;
  isolation.append(clone);
  document.body.append(isolation);
  return { clone, isolation };
}

function prepareHtmlToImageClone(sourceRoot: HTMLElement, cloneRoot: HTMLElement): void {
  removeSnapshotCaptureExcludedNodes(cloneRoot);
  for (const { clone, source } of pairSnapshotCaptureElements<HTMLImageElement>(
    sourceRoot,
    cloneRoot,
    'img',
  )) {
    if (source === null) {
      replaceSnapshotCaptureNodeWithPlaceholder(clone, clone, 'image');
    } else if (snapshotImageIsRemote(source)) {
      replaceSnapshotCaptureNodeWithPlaceholder(source, clone, 'remote-image');
    } else if (!source.complete || source.naturalWidth <= 0 || source.naturalHeight <= 0) {
      replaceSnapshotCaptureNodeWithPlaceholder(source, clone, 'local-image');
    }
  }
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
