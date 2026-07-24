import { applyStyle } from 'html-to-image/lib/apply-style';
import { cloneNode } from 'html-to-image/lib/clone-node';
import type { Options } from 'html-to-image/lib/types';
import {
  canvasToBlob,
  checkCanvasDimensions,
  createImage,
  getImageSize,
  getPixelRatio,
  nodeToDataURL,
} from 'html-to-image/lib/util';

/**
 * Uses html-to-image's embedded clone and Canvas pipeline while deliberately skipping its resource
 * and font embedding phases. Inkstone has already converted loaded Vault images to data URLs and
 * replaced unsupported media before this boundary.
 */
export async function toEmbeddedHtmlBlob(
  node: HTMLElement,
  options: Options = {},
): Promise<Blob | null> {
  const { height, width } = getImageSize(node, options);
  const svg = await toEmbeddedHtmlSvg(node, options);
  const image = await createImage(svg);
  const canvas = node.ownerDocument.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Snapshot Canvas 2D is unavailable.');
  const ratio = options.pixelRatio ?? getPixelRatio();
  const canvasWidth = options.canvasWidth ?? width;
  const canvasHeight = options.canvasHeight ?? height;
  canvas.width = canvasWidth * ratio;
  canvas.height = canvasHeight * ratio;
  if (!options.skipAutoScale) checkCanvasDimensions(canvas);
  canvas.style.width = `${canvasWidth}`;
  canvas.style.height = `${canvasHeight}`;
  if (options.backgroundColor) {
    context.fillStyle = options.backgroundColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, options);
}

export async function toEmbeddedHtmlSvg(node: HTMLElement, options: Options = {}): Promise<string> {
  const { height, width } = getImageSize(node, options);
  const clone = await cloneNode(node, options, true);
  if (clone === null) throw new Error('html-to-image returned no cloned Snapshot root.');
  suppressExternalResources(clone);
  applyStyle(clone, options);
  return nodeToDataURL(clone, width, height);
}

function suppressExternalResources(root: HTMLElement): void {
  const elements = [root, ...root.querySelectorAll<HTMLElement>('*')];
  for (const element of elements) {
    for (const property of ['background', 'background-image', 'mask', 'mask-image'] as const) {
      const value = element.style.getPropertyValue(property);
      if (value.includes('url(')) {
        element.style.setProperty(property, withoutExternalUrls(value), 'important');
      }
    }
    const webkitMask = element.style.getPropertyValue('-webkit-mask-image');
    if (webkitMask.includes('url(')) {
      element.style.setProperty('-webkit-mask-image', withoutExternalUrls(webkitMask), 'important');
    }
  }
  for (const style of root.querySelectorAll('style')) {
    if (style.textContent?.includes('url(')) {
      style.textContent = withoutExternalUrls(style.textContent);
    }
  }
  const transparentPixel = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  for (const image of root.querySelectorAll<SVGImageElement>('svg image')) {
    const href = image.getAttribute('href') ?? image.getAttribute('xlink:href') ?? '';
    if (!href.startsWith('data:')) image.setAttribute('href', transparentPixel);
    image.removeAttribute('xlink:href');
  }
}

function withoutExternalUrls(value: string): string {
  return value.replace(
    /url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/giu,
    (match, _quote, quoted, raw) => {
      const url = String(quoted ?? raw ?? '').trim();
      return url.startsWith('data:') ? match : 'none';
    },
  );
}
