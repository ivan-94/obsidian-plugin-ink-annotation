import type {
  ProjectedBlock,
  ProjectedBlockKind,
  SourceProjection,
} from '../../domain/source-projection';
import { mapProjectedDisplayRangeToSource } from '../../domain/source-projection';

export const READING_SOURCE_BLOCK_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, li, th, td, pre, .callout-title-inner';
const GENERATED_READING_SELECTOR =
  '.internal-embed, .markdown-embed, .embed-container, .dataview, .block-language-dataview, .mermaid, iframe';

export type ReadingSourceProjectionFailureCode =
  | 'empty-selection'
  | 'generated-content'
  | 'internal-error'
  | 'non-monotonic-selection'
  | 'outside-reading-view'
  | 'projection-warming'
  | 'source-target-ambiguous'
  | 'source-target-not-found'
  | 'stale-context'
  | 'unsupported-syntax';

export class ReadingSourceProjectionError extends Error {
  readonly code: ReadingSourceProjectionFailureCode;

  constructor(code: ReadingSourceProjectionFailureCode, message: string) {
    super(message);
    this.name = 'ReadingSourceProjectionError';
    this.code = code;
  }
}

export interface ReadingTextNodeEntry {
  readonly end: number;
  readonly node: Text;
  readonly start: number;
}

export interface ReadingBlockBinding {
  readonly element: HTMLElement;
  readonly projectedBlock: ProjectedBlock;
  readonly textNodes: readonly ReadingTextNodeEntry[];
  readonly visibleText: string;
}

export interface ReadingBlockBindingFailure {
  readonly code: ReadingSourceProjectionFailureCode;
  readonly element: HTMLElement;
  readonly visibleText: string;
}

export interface ReadingBlockBindingResult {
  readonly bindings: ReadonlyMap<HTMLElement, ReadingBlockBinding>;
  readonly failures: readonly ReadingBlockBindingFailure[];
}

export function mapReadingSelectionToSource(input: {
  readonly bindings: ReadonlyMap<HTMLElement, ReadingBlockBinding>;
  readonly fragments: readonly {
    readonly block: HTMLElement;
    readonly renderedEnd: number;
    readonly renderedStart: number;
  }[];
  readonly source: string;
}): { readonly end: number; readonly exact: string; readonly start: number } {
  const mapped = input.fragments.map((fragment) => {
    const binding = input.bindings.get(fragment.block);
    if (binding === undefined) {
      throw new ReadingSourceProjectionError(
        'source-target-not-found',
        'The selected Reading View block has no unique source binding.',
      );
    }
    try {
      return mapProjectedDisplayRangeToSource({
        block: binding.projectedBlock,
        displayEnd: fragment.renderedEnd,
        displayStart: fragment.renderedStart,
        source: input.source,
      });
    } catch (error) {
      throw new ReadingSourceProjectionError(
        'unsupported-syntax',
        error instanceof Error ? error.message : 'The selected endpoint is not source-backed.',
      );
    }
  });
  const first = mapped[0];
  const last = mapped.at(-1);
  if (first === undefined || last === undefined) {
    throw new ReadingSourceProjectionError(
      'source-target-not-found',
      'The selection has no source-backed fragments.',
    );
  }
  for (let index = 1; index < mapped.length; index += 1) {
    const previous = mapped[index - 1];
    const current = mapped[index];
    if (previous === undefined || current === undefined || current.start < previous.end) {
      throw new ReadingSourceProjectionError(
        'non-monotonic-selection',
        'The rendered selection does not follow Markdown source order.',
      );
    }
  }
  return {
    end: last.end,
    exact: input.source.slice(first.start, last.end),
    start: first.start,
  };
}

export function bindReadingBlocks(input: {
  readonly projection: SourceProjection;
  readonly root: HTMLElement;
  readonly sectionRange: (
    element: HTMLElement,
  ) => { readonly end: number; readonly start: number } | null;
}): ReadingBlockBindingResult {
  const elements = readingSourceBlocks(input.root);
  const visible = elements.map((element) => ownedReadingText(element));
  const generated = elements.map((element) => isGeneratedReadingElement(element));
  const compatible = elements.map((element, elementIndex) => {
    const range = input.sectionRange(element);
    const kind = readingBlockKind(element);
    const visibleText = visible[elementIndex]?.text ?? '';
    return input.projection.blocks.map(
      (block) =>
        generated[elementIndex] !== true &&
        block.kind === kind &&
        block.visibleText === visibleText &&
        (range === null || (block.sourceStart >= range.start && block.sourceEnd <= range.end)),
    );
  });
  const prefix = buildPrefixAlignment(compatible);
  const suffix = buildSuffixAlignment(compatible);
  const bindings = new Map<HTMLElement, ReadingBlockBinding>();
  const failures: ReadingBlockBindingFailure[] = [];

  elements.forEach((element, elementIndex) => {
    const candidates = input.projection.blocks.flatMap((block, blockIndex) =>
      compatible[elementIndex]?.[blockIndex] === true &&
      prefix[elementIndex]?.[blockIndex] === true &&
      suffix[elementIndex + 1]?.[blockIndex + 1] === true
        ? [block]
        : [],
    );
    const owned = visible[elementIndex] ?? { entries: [], text: '' };
    if (candidates.length === 1) {
      bindings.set(element, {
        element,
        projectedBlock: candidates[0]!,
        textNodes: owned.entries,
        visibleText: owned.text,
      });
      return;
    }
    failures.push({
      code:
        generated[elementIndex] === true
          ? 'generated-content'
          : candidates.length === 0
            ? 'source-target-not-found'
            : 'source-target-ambiguous',
      element,
      visibleText: owned.text,
    });
  });

  return { bindings, failures };
}

export function ownedReadingText(element: HTMLElement): {
  readonly entries: readonly ReadingTextNodeEntry[];
  readonly text: string;
} {
  const entries: ReadingTextNodeEntry[] = [];
  let text = '';

  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      const value = (node as Text).data;
      const start = text.length;
      text += value;
      entries.push({ end: text.length, node: node as Text, start });
      return;
    }
    if (!(node instanceof element.ownerDocument.defaultView!.Element)) {
      return;
    }
    const child = node;
    if (child !== element && child.matches(READING_SOURCE_BLOCK_SELECTOR)) {
      return;
    }
    if (child.matches(`${GENERATED_READING_SELECTOR}, button, .callout-icon, .callout-fold`)) {
      return;
    }
    for (const descendant of child.childNodes) {
      visit(descendant);
    }
  };

  visit(element);
  return { entries, text };
}

export function isOwnedReadingTextNode(element: HTMLElement, node: Text): boolean {
  if (!element.contains(node)) return false;
  const parent = node.parentElement;
  if (
    parent?.closest(`${GENERATED_READING_SELECTOR}, button, .callout-icon, .callout-fold`) !== null
  ) {
    return false;
  }
  return parent?.closest(READING_SOURCE_BLOCK_SELECTOR) === element;
}

function isGeneratedReadingElement(element: HTMLElement): boolean {
  return element.closest(GENERATED_READING_SELECTOR) !== null;
}

export function readingBlockKind(element: HTMLElement): ProjectedBlockKind | null {
  if (element.matches('li')) return 'list-item';
  if (element.matches('pre')) return 'code-block';
  if (element.matches('th, td')) return 'table-cell';
  if (element.matches('.callout-title-inner')) return 'callout-title';
  if (element.matches('h1, h2, h3, h4, h5, h6')) return 'heading';
  if (element.matches('p') && element.closest('li') !== null) return 'list-item';
  if (element.matches('p') && element.closest('.callout-content') !== null) return 'callout-body';
  if (element.matches('p') && element.closest('blockquote') !== null) return 'blockquote';
  if (element.matches('p')) return 'paragraph';
  return null;
}

function readingSourceBlocks(root: HTMLElement): readonly HTMLElement[] {
  const candidates = [
    ...(root.matches(READING_SOURCE_BLOCK_SELECTOR) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(READING_SOURCE_BLOCK_SELECTOR),
  ];
  return candidates.filter((element) => {
    if (readingBlockKind(element) === null) {
      return false;
    }
    if (element.matches('li') && [...element.children].some((child) => child.matches('p'))) {
      return false;
    }
    return true;
  });
}

function buildPrefixAlignment(compatible: readonly (readonly boolean[])[]): readonly boolean[][] {
  const elementCount = compatible.length;
  const blockCount = compatible[0]?.length ?? 0;
  const prefix = Array.from({ length: elementCount + 1 }, () =>
    Array.from({ length: blockCount + 1 }, () => false),
  );
  for (let blockIndex = 0; blockIndex <= blockCount; blockIndex += 1) {
    prefix[0]![blockIndex] = true;
  }
  for (let elementIndex = 1; elementIndex <= elementCount; elementIndex += 1) {
    const skippable = compatible[elementIndex - 1]?.every((matches) => !matches) ?? true;
    if (skippable) {
      prefix[elementIndex]![0] = prefix[elementIndex - 1]![0]!;
    }
    for (let blockIndex = 1; blockIndex <= blockCount; blockIndex += 1) {
      prefix[elementIndex]![blockIndex] =
        prefix[elementIndex]![blockIndex - 1]! ||
        (skippable && prefix[elementIndex - 1]![blockIndex]!) ||
        (compatible[elementIndex - 1]?.[blockIndex - 1] === true &&
          prefix[elementIndex - 1]?.[blockIndex - 1] === true);
    }
  }
  return prefix;
}

function buildSuffixAlignment(compatible: readonly (readonly boolean[])[]): readonly boolean[][] {
  const elementCount = compatible.length;
  const blockCount = compatible[0]?.length ?? 0;
  const suffix = Array.from({ length: elementCount + 1 }, () =>
    Array.from({ length: blockCount + 1 }, () => false),
  );
  for (let blockIndex = 0; blockIndex <= blockCount; blockIndex += 1) {
    suffix[elementCount]![blockIndex] = true;
  }
  for (let elementIndex = elementCount - 1; elementIndex >= 0; elementIndex -= 1) {
    const skippable = compatible[elementIndex]?.every((matches) => !matches) ?? true;
    if (skippable) {
      suffix[elementIndex]![blockCount] = suffix[elementIndex + 1]![blockCount]!;
    }
    for (let blockIndex = blockCount - 1; blockIndex >= 0; blockIndex -= 1) {
      suffix[elementIndex]![blockIndex] =
        suffix[elementIndex]![blockIndex + 1]! ||
        (skippable && suffix[elementIndex + 1]![blockIndex]!) ||
        (compatible[elementIndex]?.[blockIndex] === true &&
          suffix[elementIndex + 1]?.[blockIndex + 1] === true);
    }
  }
  return suffix;
}
