export interface HighlightRenderRange {
  readonly annotationId: string;
  readonly end: number;
  readonly kind?: 'highlight' | 'underline';
  readonly start: number;
  readonly styleId: string;
}

export interface NoteAnchorRenderPoint {
  readonly annotationId: string;
  readonly offset: number;
}

const HIGHLIGHT_SELECTOR = 'span[data-inkstone-annotation-id]';

export function renderHighlight(
  root: HTMLElement,
  range: HighlightRenderRange,
  acceptTextNode?: (node: Text) => boolean,
): readonly HTMLSpanElement[] {
  if (range.start < 0 || range.end <= range.start) {
    throw new Error('Highlight render range must be a non-empty forward range.');
  }

  const textNodes = collectTextNodes(root, acceptTextNode);
  const totalLength = textNodes.at(-1)?.end ?? 0;
  if (range.end > totalLength) {
    throw new Error('Highlight render range exceeds the rendered section.');
  }

  const fragments: HTMLSpanElement[] = [];
  for (const entry of textNodes) {
    const fragmentStart = Math.max(range.start, entry.start);
    const fragmentEnd = Math.min(range.end, entry.end);
    if (fragmentStart >= fragmentEnd) {
      continue;
    }

    const localStart = fragmentStart - entry.start;
    const localEnd = fragmentEnd - entry.start;
    let selectedNode = entry.node;
    if (localEnd < selectedNode.data.length) {
      selectedNode.splitText(localEnd);
    }
    if (localStart > 0) {
      selectedNode = selectedNode.splitText(localStart);
    }

    const wrapper = root.ownerDocument.createElement('span');
    wrapper.className = 'inkstone-text-highlight';
    wrapper.dataset.inkstoneAnnotationId = range.annotationId;
    wrapper.dataset.inkstoneStyleId = range.styleId;
    if (range.kind === 'underline') {
      wrapper.classList.add('inkstone-text-highlight--underline-only');
      wrapper.dataset.inkstoneUnderlineAnnotationIds = JSON.stringify([range.annotationId]);
      wrapper.dataset.inkstoneUnderlineStyleIds = JSON.stringify([range.styleId]);
    }
    selectedNode.parentNode?.insertBefore(wrapper, selectedNode);
    wrapper.append(selectedNode);
    fragments.push(wrapper);
  }

  return fragments;
}

export function cleanupHighlights(root: HTMLElement): void {
  for (const wrapper of root.querySelectorAll<HTMLSpanElement>(HIGHLIGHT_SELECTOR)) {
    const parent = wrapper.parentNode;
    wrapper.replaceWith(...wrapper.childNodes);
    parent?.normalize();
  }
}

export function renderNoteAnchorIndicator(
  root: HTMLElement,
  point: NoteAnchorRenderPoint,
  acceptTextNode?: (node: Text) => boolean,
): HTMLSpanElement {
  const textNodes = collectTextNodes(root, acceptTextNode);
  const totalLength = textNodes.at(-1)?.end ?? 0;
  if (point.offset < 0 || point.offset > totalLength) {
    throw new Error('Note anchor point exceeds the rendered section.');
  }
  const indicator = root.ownerDocument.createElement('span');
  indicator.className = 'inkstone-note-anchor';
  indicator.dataset.inkstoneAnnotationId = point.annotationId;
  indicator.dataset.inkstoneAnnotationIds = JSON.stringify([point.annotationId]);
  indicator.setAttribute('aria-label', 'Open annotation note');
  indicator.setAttribute('role', 'button');
  indicator.tabIndex = 0;

  const entry = textNodes.find((candidate) => point.offset <= candidate.end);
  if (entry === undefined) {
    root.append(indicator);
    return indicator;
  }
  const range = root.ownerDocument.createRange();
  range.setStart(entry.node, point.offset - entry.start);
  range.collapse(true);
  range.insertNode(indicator);
  return indicator;
}

export function renderHighlightPlan(
  root: HTMLElement,
  intervals: readonly AnnotationRenderInterval[],
  acceptTextNode?: (node: Text) => boolean,
): readonly HTMLSpanElement[] {
  cleanupHighlights(root);
  const fragments: HTMLSpanElement[] = [];
  const plan = buildIntervalRenderPlan(intervals);

  for (const segment of [...plan].reverse()) {
    const primaryId = segment.backgroundAnnotationId ?? segment.annotationIds[0];
    if (primaryId === undefined) {
      continue;
    }
    const rendered = renderHighlight(
      root,
      {
        annotationId: primaryId,
        end: segment.end,
        start: segment.start,
        styleId: segment.backgroundStyleId ?? segment.underlineStyleIds[0] ?? 'annotation-default',
      },
      acceptTextNode,
    );
    for (const fragment of rendered) {
      fragment.dataset.inkstoneAnnotationIds = JSON.stringify(segment.annotationIds);
      if (segment.backgroundAnnotationId === undefined) {
        fragment.classList.add('inkstone-text-highlight--underline-only');
      }
      if (segment.underlineAnnotationIds.length > 0) {
        fragment.dataset.inkstoneUnderlineAnnotationIds = JSON.stringify(
          segment.underlineAnnotationIds,
        );
        fragment.dataset.inkstoneUnderlineStyleIds = JSON.stringify(segment.underlineStyleIds);
      }
      fragments.push(fragment);
    }
  }
  return fragments;
}

export function annotationIdsAtElement(element: Element | null): readonly string[] {
  const wrapper = element?.closest<HTMLElement>(HIGHLIGHT_SELECTOR);
  if (wrapper === null || wrapper === undefined) {
    return [];
  }
  const encoded = wrapper.dataset.inkstoneAnnotationIds;
  if (encoded === undefined) {
    const id = wrapper.dataset.inkstoneAnnotationId;
    return id === undefined ? [] : [id];
  }
  try {
    const ids: unknown = JSON.parse(encoded);
    return Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? ids : [];
  } catch {
    return [];
  }
}

function collectTextNodes(
  root: HTMLElement,
  acceptTextNode?: (node: Text) => boolean,
): readonly {
  readonly end: number;
  readonly node: Text;
  readonly start: number;
}[] {
  const nodeFilter = root.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = root.ownerDocument.createTreeWalker(root, nodeFilter);
  const entries: Array<{ readonly end: number; readonly node: Text; readonly start: number }> = [];
  let offset = 0;
  let current = walker.nextNode();

  while (current !== null) {
    if (isTextNode(current) && (acceptTextNode === undefined || acceptTextNode(current))) {
      const start = offset;
      offset += current.data.length;
      entries.push({ end: offset, node: current, start });
    }
    current = walker.nextNode();
  }

  return entries;
}

function isTextNode(node: Node): node is Text {
  return node.nodeType === 3;
}
import {
  buildIntervalRenderPlan,
  type AnnotationRenderInterval,
} from '../domain/interval-render-plan';
