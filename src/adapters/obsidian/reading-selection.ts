export const SUPPORTED_BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li';

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

  const restrictedReason =
    restrictedContentReason(range.startContainer) ??
    restrictedContentReason(range.endContainer) ??
    restrictedContentReasonInRange(range);
  if (restrictedReason !== null) {
    return { reason: restrictedReason, supported: false };
  }

  const startBlock = findSupportedBlock(range.startContainer);
  const endBlock = findSupportedBlock(range.endContainer);
  if (startBlock === null || endBlock === null) {
    return { reason: 'unsupported-block', supported: false };
  }
  const selectedBlocks = selectedSupportedBlocks(readingRoot, range);
  const structuralKind = supportedBlockKind(startBlock);
  if (
    selectedBlocks[0] !== startBlock ||
    selectedBlocks.at(-1) !== endBlock ||
    selectedBlocks.some((block) => supportedBlockKind(block) !== structuralKind)
  ) {
    return { reason: 'cross-block', supported: false };
  }

  const renderedStart = textLengthBefore(startBlock, range.startContainer, range.startOffset);
  const renderedEnd = textLengthBefore(endBlock, range.endContainer, range.endOffset);
  const exact = range.toString();
  if (
    startBlock === endBlock &&
    startBlock.textContent?.slice(renderedStart, renderedEnd) !== exact
  ) {
    return { reason: 'unsupported-block', supported: false };
  }

  const fragments =
    startBlock === endBlock
      ? [{ block: startBlock, renderedEnd, renderedStart }]
      : selectedBlocks
          .map((block) => ({
            block,
            renderedEnd: block === endBlock ? renderedEnd : (block.textContent?.length ?? 0),
            renderedStart: block === startBlock ? renderedStart : 0,
          }))
          .filter((fragment) => fragment.renderedEnd > fragment.renderedStart);
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

function selectedSupportedBlocks(readingRoot: HTMLElement, range: Range): readonly HTMLElement[] {
  const nodeFilter = readingRoot.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = readingRoot.ownerDocument.createTreeWalker(readingRoot, nodeFilter);
  const blocks: HTMLElement[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    if (range.intersectsNode(node)) {
      const block = findSupportedBlock(node);
      if (block !== null && blocks.at(-1) !== block) blocks.push(block);
    }
    node = walker.nextNode();
  }
  return blocks;
}

function supportedBlockKind(block: HTMLElement): string {
  if (block.closest('li') !== null) return 'list-item';
  if (block.closest('blockquote') !== null) return 'blockquote';
  if (block.closest('.callout') !== null) return 'callout';
  return block.tagName;
}

function findSupportedBlock(node: Node): HTMLElement | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>(SUPPORTED_BLOCK_SELECTOR) ?? null;
}

function restrictedContentReason(
  node: Node,
): Extract<CapturedReadingSelection, { supported: false }>['reason'] | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (element?.closest('pre, code') !== null) {
    return 'code-content';
  }
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

function restrictedContentReasonInRange(
  range: Range,
): Extract<CapturedReadingSelection, { supported: false }>['reason'] | null {
  const contents = range.cloneContents();
  if (contents.querySelector('pre, code') !== null) return 'code-content';
  if (contents.querySelector('mjx-container, .math, .math-block') !== null) return 'math-content';
  if (contents.querySelector('.internal-embed, .markdown-embed, .embed-container') !== null) {
    return 'embedded-content';
  }
  if (contents.querySelector('.dataview, .block-language-dataview, .mermaid, iframe') !== null) {
    return 'generated-content';
  }
  return null;
}

function textLengthBefore(block: HTMLElement, node: Node, offset: number): number {
  const prefix = block.ownerDocument.createRange();
  prefix.selectNodeContents(block);
  prefix.setEnd(node, offset);
  return prefix.toString().length;
}
