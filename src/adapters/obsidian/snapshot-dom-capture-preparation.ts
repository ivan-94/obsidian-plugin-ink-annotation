export const SNAPSHOT_CAPTURE_EXCLUDED_SELECTOR = [
  '.inkstone-reading-toolbar',
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

export function removeSnapshotCaptureExcludedNodes(root: HTMLElement): void {
  for (const element of root.querySelectorAll(SNAPSHOT_CAPTURE_EXCLUDED_SELECTOR)) element.remove();
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
