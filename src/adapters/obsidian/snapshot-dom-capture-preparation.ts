import { SnapshotCaptureError } from './snapshot-capture-backend';

export const SNAPSHOT_CAPTURE_EXCLUDED_SELECTOR = [
  '.inkstone-reading-toolbar',
  '[data-inkstone-quick-toolbar-host]',
  '.inkstone-note-anchor',
  '.collapse-indicator',
  '.heading-collapse-indicator',
  '.prompt',
  '.prompt-container',
  '.suggestion-container',
  '.menu',
  '.tooltip',
].join(',');

const DIRECT_PLACEHOLDER_SELECTOR = 'iframe, video, audio, canvas, object, embed';
const RETRY_PLACEHOLDER_SELECTOR = [
  '.mermaid',
  '.block-language-mermaid',
  'mjx-container',
  '.math',
  '.dataview',
  '.block-language-dataview',
  '.internal-embed:not(.image-embed)',
  'svg',
].join(',');

export interface CaptureElementPair<T extends Element> {
  readonly clone: T;
  readonly source: T | null;
}

export type SnapshotLocalImageResolver = (
  image: HTMLImageElement,
  signal: AbortSignal,
) => Promise<string>;

export function removeSnapshotCaptureExcludedNodes(root: HTMLElement): void {
  for (const element of root.querySelectorAll(SNAPSHOT_CAPTURE_EXCLUDED_SELECTOR)) element.remove();
}

/**
 * Inlines the exact styles for the first-party foreignObject serializer, which owns its clone.
 * Do not use this before html-to-image: that renderer already performs its own complete
 * computed-style traversal.
 */
export async function inlineSnapshotCaptureComputedStyles(
  sourceRoot: HTMLElement,
  cloneRoot: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  const sourceElements = [sourceRoot, ...sourceRoot.querySelectorAll<HTMLElement>('*')].filter(
    (element) =>
      !element.matches(SNAPSHOT_CAPTURE_EXCLUDED_SELECTOR) &&
      element.closest(SNAPSHOT_CAPTURE_EXCLUDED_SELECTOR) === null,
  );
  const cloneElements = [cloneRoot, ...cloneRoot.querySelectorAll<HTMLElement>('*')];
  if (sourceElements.length !== cloneElements.length) {
    throw new SnapshotCaptureError(
      'capture-failed',
      'Snapshot style isolation could not preserve the supported DOM structure.',
    );
  }
  const view = sourceRoot.ownerDocument.defaultView;
  if (view === null) {
    throw new SnapshotCaptureError('backend-unavailable', 'DOM styles unavailable.');
  }
  for (let index = 0; index < sourceElements.length; index += 1) {
    if (signal.aborted) {
      throw new SnapshotCaptureError('aborted', 'Snapshot capture was cancelled.');
    }
    const source = sourceElements[index] as HTMLElement;
    const target = cloneElements[index] as HTMLElement;
    const computed = view.getComputedStyle(source);
    for (let propertyIndex = 0; propertyIndex < computed.length; propertyIndex += 1) {
      const property = computed.item(propertyIndex);
      if (property.length === 0) continue;
      target.style.setProperty(
        property,
        computed.getPropertyValue(property),
        computed.getPropertyPriority(property),
      );
    }
    if (index > 0 && index % 128 === 0) await nextTask();
  }
}

export function pairSnapshotCaptureElements<T extends Element>(
  sourceRoot: HTMLElement,
  cloneRoot: HTMLElement,
  selector: string,
): readonly CaptureElementPair<T>[] {
  const sources = [...sourceRoot.querySelectorAll<T>(selector)].filter(
    (element) => element.closest(SNAPSHOT_CAPTURE_EXCLUDED_SELECTOR) === null,
  );
  return [...cloneRoot.querySelectorAll<T>(selector)].map((clone, index) => ({
    clone,
    source: sources[index] ?? null,
  }));
}

export async function inlineSnapshotCaptureImages(
  sourceRoot: HTMLElement,
  cloneRoot: HTMLElement,
  signal: AbortSignal,
  resolveImageDataUrl: SnapshotLocalImageResolver,
): Promise<void> {
  const pairs = pairSnapshotCaptureElements<HTMLImageElement>(sourceRoot, cloneRoot, 'img');
  for (let index = 0; index < pairs.length; index += 1) {
    if (signal.aborted) throw captureAborted();
    const { clone, source } = pairs[index] as (typeof pairs)[number];
    if (source === null) {
      replaceSnapshotCaptureNodeWithPlaceholder(clone, clone, 'image');
      continue;
    }
    if (snapshotImageIsRemote(source)) {
      replaceSnapshotCaptureNodeWithPlaceholder(source, clone, 'remote-image');
      continue;
    }
    if (!source.complete || source.naturalWidth <= 0 || source.naturalHeight <= 0) {
      replaceSnapshotCaptureNodeWithPlaceholder(source, clone, 'local-image');
      continue;
    }
    try {
      clone.src = await resolveImageDataUrl(source, signal);
      clone.srcset = '';
    } catch (error) {
      if (signal.aborted) throw captureAborted();
      void error;
      replaceSnapshotCaptureNodeWithPlaceholder(source, clone, 'local-image');
    }
  }
}

export async function resolveLoadedSnapshotImageDataUrl(
  image: HTMLImageElement,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw captureAborted();
  const canvas = image.ownerDocument.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Snapshot local image Canvas 2D is unavailable.');
  context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value === null
          ? reject(new Error('Snapshot local image PNG encoding failed.'))
          : resolve(value),
      'image/png',
    ),
  );
  if (signal.aborted) throw captureAborted();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = (): void => {
      reader.onerror = null;
      reader.onload = null;
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reader.abort();
      reject(captureAborted());
    };
    reader.onerror = () => {
      const error = reader.error ?? new Error('Snapshot image encoding failed.');
      cleanup();
      reject(error);
    };
    reader.onload = () => {
      const result = reader.result;
      cleanup();
      if (typeof result === 'string') resolve(result);
      else reject(new Error('Snapshot image encoding returned no data URL.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.readAsDataURL(blob);
  });
}

export function replaceDirectlyUnsupportedCaptureNodes(
  sourceRoot: HTMLElement,
  cloneRoot: HTMLElement,
): number {
  const pairs = pairSnapshotCaptureElements<Element>(
    sourceRoot,
    cloneRoot,
    DIRECT_PLACEHOLDER_SELECTOR,
  );
  for (const { clone, source } of pairs) {
    replaceSnapshotCaptureNodeWithPlaceholder(source ?? clone, clone, clone.tagName.toLowerCase());
  }
  return pairs.length;
}

/** Replaces only the largest generated/plugin roots so nested SVG nodes do not create duplicates. */
export function replaceGeneratedCaptureNodesForRetry(root: HTMLElement): number {
  const candidates = [...root.querySelectorAll<Element>(RETRY_PLACEHOLDER_SELECTOR)].filter(
    (element) =>
      element.closest(SNAPSHOT_CAPTURE_EXCLUDED_SELECTOR) === null &&
      !hasMatchingAncestor(element, root, RETRY_PLACEHOLDER_SELECTOR),
  );
  for (const element of candidates) {
    replaceSnapshotCaptureNodeWithPlaceholder(element, element, generatedKind(element));
  }
  return candidates.length;
}

export function replaceSnapshotCaptureNodeWithPlaceholder(
  source: Element,
  clone: Element,
  kind: string,
): void {
  const placeholder = clone.ownerDocument.createElement('div');
  const bounds = source.getBoundingClientRect();
  const width = resolvedDimension(source, 'width', bounds.width, 160);
  const height = resolvedDimension(source, 'height', bounds.height, 90);
  placeholder.dataset.inkstoneSnapshotPlaceholder = kind;
  placeholder.setAttribute('aria-label', `${kind} content unavailable in this Snapshot`);
  placeholder.textContent = 'Content unavailable in snapshot';
  Object.assign(placeholder.style, {
    alignItems: 'center',
    background: 'rgba(127, 127, 127, 0.12)',
    border: '1px dashed rgba(127, 127, 127, 0.55)',
    borderRadius: '6px',
    boxSizing: 'border-box',
    color: 'rgba(127, 127, 127, 0.95)',
    display: source.tagName.toLowerCase() === 'img' ? 'inline-flex' : 'flex',
    font: '12px/1.3 system-ui, sans-serif',
    height: `${height}px`,
    justifyContent: 'center',
    maxWidth: '100%',
    overflow: 'hidden',
    padding: '8px',
    textAlign: 'center',
    width: `${width}px`,
  });
  clone.replaceWith(placeholder);
}

export function snapshotImageIsRemote(image: HTMLImageElement): boolean {
  return /^https?:\/\//iu.test(image.currentSrc || image.src);
}

function hasMatchingAncestor(element: Element, root: HTMLElement, selector: string): boolean {
  let ancestor = element.parentElement;
  while (ancestor !== null && ancestor !== root) {
    if (ancestor.matches(selector)) return true;
    ancestor = ancestor.parentElement;
  }
  return false;
}

function generatedKind(element: Element): string {
  if (element.matches('.mermaid, .block-language-mermaid')) return 'mermaid';
  if (element.matches('mjx-container, .math')) return 'math';
  if (element.matches('.dataview, .block-language-dataview')) return 'dataview';
  if (element.matches('.internal-embed:not(.image-embed)')) return 'plugin-embed';
  return 'svg';
}

function resolvedDimension(
  element: Element,
  attribute: 'height' | 'width',
  measured: number,
  fallback: number,
): number {
  if (Number.isFinite(measured) && measured > 0) return Math.max(1, Math.round(measured));
  const declared = Number.parseFloat(element.getAttribute(attribute) ?? '');
  return Number.isFinite(declared) && declared > 0 ? Math.max(1, Math.round(declared)) : fallback;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function captureAborted(): SnapshotCaptureError {
  return new SnapshotCaptureError('aborted', 'Snapshot capture was cancelled.');
}
