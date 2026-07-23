import { ownedReadingText, READING_SOURCE_BLOCK_SELECTOR } from './reading-source-projection';

export const SUPPORTED_BLOCK_SELECTOR = READING_SOURCE_BLOCK_SELECTOR;

export type CapturedReadingSelection =
  | {
      readonly block: HTMLElement;
      readonly endBlock: HTMLElement;
      readonly exact: string;
      readonly fragments: readonly {
        readonly block: HTMLElement;
        readonly renderedEnd: number;
        readonly renderedStart: number;
      }[];
      readonly renderedEnd: number;
      readonly renderedStart: number;
      readonly supported: true;
    }
  | {
      readonly reason:
        | 'code-content'
        | 'cross-block'
        | 'embedded-content'
        | 'empty'
        | 'generated-content'
        | 'math-content'
        | 'outside-reading-view'
        | 'unsupported-block';
      readonly supported: false;
    };

export function captureReadingSelection(
  readingRoot: HTMLElement,
  range: Range,
): CapturedReadingSelection {
  if (range.collapsed || range.toString().trim().length === 0) {
    return { reason: 'empty', supported: false };
  }

  if (!readingRoot.contains(range.startContainer) || !readingRoot.contains(range.endContainer)) {
    return { reason: 'outside-reading-view', supported: false };
  }

  const restrictedEndpointReason =
    restrictedContentReason(range.startContainer) ?? restrictedContentReason(range.endContainer);
  if (restrictedEndpointReason !== null) {
    return { reason: restrictedEndpointReason, supported: false };
  }

  const selectedParts = selectedTextParts(readingRoot, range);
  if (selectedParts.length === 0) {
    return { reason: 'empty', supported: false };
  }

  const restrictedReason =
    selectedParts
      .map((part) => restrictedContentReason(part.node))
      .find((reason) => reason !== null) ?? null;
  if (restrictedReason !== null) {
    return { reason: restrictedReason, supported: false };
  }

  if (selectedParts.some((part) => part.block === null && part.node.data.trim().length > 0)) {
    return { reason: 'unsupported-block', supported: false };
  }
  const supportedParts = selectedParts.filter(
    (part): part is SelectedTextPart & { block: HTMLElement } => part.block !== null,
  );
  const selectedBlocks = supportedParts.reduce<HTMLElement[]>((blocks, part) => {
    if (blocks.at(-1) !== part.block) blocks.push(part.block);
    return blocks;
  }, []);
  const startBlock = selectedBlocks[0];
  const endBlock = selectedBlocks.at(-1);
  if (startBlock === undefined || endBlock === undefined) {
    return { reason: 'unsupported-block', supported: false };
  }
  const fragments = selectedBlocks.map((block) => {
    const parts = supportedParts.filter((part) => part.block === block);
    const first = parts[0];
    const last = parts.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error('Selected block has no selected text parts.');
    }
    return {
      block,
      renderedEnd: textLengthBefore(block, last.node, last.end),
      renderedStart: textLengthBefore(block, first.node, first.start),
    };
  });
  const renderedStart = fragments[0]?.renderedStart ?? 0;
  const renderedEnd = fragments.at(-1)?.renderedEnd ?? 0;
  const firstPart = supportedParts[0];
  const lastPart = supportedParts.at(-1);
  if (firstPart === undefined || lastPart === undefined) {
    return { reason: 'empty', supported: false };
  }
  const exactRange = readingRoot.ownerDocument.createRange();
  exactRange.setStart(firstPart.node, firstPart.start);
  exactRange.setEnd(lastPart.node, lastPart.end);
  const exact = exactRange.toString();
  if (
    startBlock === endBlock &&
    ownedReadingText(startBlock).text.slice(renderedStart, renderedEnd) !== exact
  ) {
    return { reason: 'unsupported-block', supported: false };
  }

  if (fragments.length < (startBlock === endBlock ? 1 : 2)) {
    return { reason: 'cross-block', supported: false };
  }

  return {
    block: startBlock,
    endBlock,
    exact,
    fragments,
    renderedEnd,
    renderedStart,
    supported: true,
  };
}

interface SelectedTextPart {
  readonly block: HTMLElement | null;
  readonly end: number;
  readonly node: Text;
  readonly start: number;
}

function selectedTextParts(readingRoot: HTMLElement, range: Range): readonly SelectedTextPart[] {
  const nodeFilter = readingRoot.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = readingRoot.ownerDocument.createTreeWalker(readingRoot, nodeFilter);
  const rangeConstructor = readingRoot.ownerDocument.defaultView?.Range;
  const parts: SelectedTextPart[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    if (node.nodeType === 3) {
      const textNode = node as Text;
      const nodeRange = readingRoot.ownerDocument.createRange();
      nodeRange.selectNodeContents(textNode);
      const overlaps =
        rangeConstructor !== undefined &&
        range.compareBoundaryPoints(rangeConstructor.START_TO_END, nodeRange) > 0 &&
        range.compareBoundaryPoints(rangeConstructor.END_TO_START, nodeRange) < 0;
      if (overlaps) {
        const start = range.startContainer === textNode ? range.startOffset : 0;
        const end = range.endContainer === textNode ? range.endOffset : textNode.data.length;
        if (end > start) {
          parts.push({ block: findSupportedBlock(textNode), end, node: textNode, start });
        }
      }
    }
    node = walker.nextNode();
  }
  return parts;
}

function findSupportedBlock(node: Node): HTMLElement | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>(SUPPORTED_BLOCK_SELECTOR) ?? null;
}

function restrictedContentReason(
  node: Node,
): Extract<CapturedReadingSelection, { supported: false }>['reason'] | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (element?.closest('mjx-container, .math, .math-block') !== null) {
    return 'math-content';
  }
  if (element?.closest('.internal-embed, .markdown-embed, .embed-container') !== null) {
    return 'embedded-content';
  }
  if (element?.closest('.dataview, .block-language-dataview, .mermaid, iframe') !== null) {
    return 'generated-content';
  }
  return null;
}

function textLengthBefore(block: HTMLElement, node: Node, offset: number): number {
  const entry = ownedReadingText(block).entries.find((candidate) => candidate.node === node);
  if (entry === undefined || offset < 0 || offset > entry.node.data.length) {
    throw new Error('Selected text node is not owned by its Reading View block.');
  }
  return entry.start + offset;
}
