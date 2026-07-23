import type { Heading, List, ListItem, Paragraph, PhrasingContent, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';

export type ProjectedBlockKind =
  | 'blockquote'
  | 'callout-body'
  | 'callout-title'
  | 'code-block'
  | 'heading'
  | 'list-item'
  | 'math-block'
  | 'paragraph'
  | 'table-cell';

export type VisibleRunMapping = 'atomic' | 'hidden' | 'identity' | 'synthetic';

export type VisibleRunRole =
  'code-text' | 'generated' | 'inline-code' | 'link-label' | 'math' | 'syntax' | 'text';

export interface SourceProjectionKey {
  readonly dialectVersion: string;
  readonly filePath: string;
  readonly sourceRevision: string;
}

export interface StructuralPathSegment {
  readonly index: number;
  readonly kind: 'heading' | 'list' | 'list-item' | 'paragraph';
}

export interface VisibleTextRun {
  readonly displayEnd: number;
  readonly displayStart: number;
  readonly mapping: VisibleRunMapping;
  readonly role: VisibleRunRole;
  readonly selectable: boolean;
  readonly sourceEnd: number;
  readonly sourceStart: number;
}

export interface ProjectedBlock {
  readonly id: string;
  readonly kind: ProjectedBlockKind;
  readonly runs: readonly VisibleTextRun[];
  readonly sourceEnd: number;
  readonly sourceStart: number;
  readonly structuralPath: readonly StructuralPathSegment[];
  readonly visibleText: string;
}

export interface SourceProjection {
  readonly blocks: readonly ProjectedBlock[];
  readonly key: SourceProjectionKey;
  readonly sourceLength: number;
}

export interface BuildSourceProjectionInput extends SourceProjectionKey {
  readonly source: string;
}

export interface MappedProjectedSourceRange {
  readonly end: number;
  readonly exact: string;
  readonly start: number;
}

export interface MappedProjectedDisplayRange {
  readonly end: number;
  readonly exact: string;
  readonly start: number;
}

export function buildSourceProjection(input: BuildSourceProjectionInput): SourceProjection {
  const tree = fromMarkdown(input.source);

  return {
    blocks: projectRoot(tree, input.source),
    key: {
      dialectVersion: input.dialectVersion,
      filePath: input.filePath,
      sourceRevision: input.sourceRevision,
    },
    sourceLength: input.source.length,
  };
}

export function mapProjectedDisplayRangeToSource(input: {
  readonly block: ProjectedBlock;
  readonly displayEnd: number;
  readonly displayStart: number;
  readonly source: string;
}): MappedProjectedSourceRange {
  if (
    !Number.isInteger(input.displayStart) ||
    !Number.isInteger(input.displayEnd) ||
    input.displayStart < 0 ||
    input.displayEnd <= input.displayStart ||
    input.displayEnd > input.block.visibleText.length
  ) {
    throw new Error('Projected display selection is empty or outside the block.');
  }

  const start = mapIdentityBoundary(input.block, input.displayStart, 'start');
  const end = mapIdentityBoundary(input.block, input.displayEnd, 'end');

  return {
    end,
    exact: input.source.slice(start, end),
    start,
  };
}

export function mapProjectedSourceRangeToDisplay(input: {
  readonly block: ProjectedBlock;
  readonly sourceEnd: number;
  readonly sourceStart: number;
}): MappedProjectedDisplayRange {
  if (
    !Number.isInteger(input.sourceStart) ||
    !Number.isInteger(input.sourceEnd) ||
    input.sourceStart < input.block.sourceStart ||
    input.sourceEnd <= input.sourceStart ||
    input.sourceEnd > input.block.sourceEnd
  ) {
    throw new Error('Projected source selection is empty or outside the block.');
  }

  const start = mapIdentitySourceBoundary(input.block, input.sourceStart, 'start');
  const end = mapIdentitySourceBoundary(input.block, input.sourceEnd, 'end');

  return {
    end,
    exact: input.block.visibleText.slice(start, end),
    start,
  };
}

function projectRoot(root: Root, source: string): readonly ProjectedBlock[] {
  const blocks: ProjectedBlock[] = [];

  root.children.forEach((node, rootIndex) => {
    if (node.type === 'list') {
      blocks.push(...projectList(node, rootIndex, source));
      return;
    }
    if (node.type === 'paragraph' || node.type === 'heading') {
      const block = projectPhrasingBlock(
        node,
        node.type,
        [{ index: rootIndex, kind: node.type }],
        source,
      );
      if (block !== undefined) {
        blocks.push(block);
      }
    }
  });

  return blocks;
}

function projectList(list: List, rootIndex: number, source: string): readonly ProjectedBlock[] {
  return list.children.flatMap((item, itemIndex) => {
    const paragraph = item.children.find((child): child is Paragraph => child.type === 'paragraph');
    if (paragraph === undefined) {
      return [];
    }
    const block = projectListItem(item, paragraph, rootIndex, itemIndex, source);
    return block === undefined ? [] : [block];
  });
}

function projectListItem(
  item: ListItem,
  paragraph: Paragraph,
  rootIndex: number,
  itemIndex: number,
  source: string,
): ProjectedBlock | undefined {
  const itemStart = requiredOffset(item.position?.start.offset);
  const itemEnd = requiredOffset(item.position?.end.offset);
  return projectPhrasingBlock(
    paragraph,
    'list-item',
    [
      { index: rootIndex, kind: 'list' },
      { index: itemIndex, kind: 'list-item' },
    ],
    source,
    {
      end: itemEnd,
      start: itemStart,
    },
  );
}

function projectPhrasingBlock(
  node: Heading | Paragraph,
  kind: 'heading' | 'list-item' | 'paragraph',
  structuralPath: readonly StructuralPathSegment[],
  source: string,
  sourceBounds?: { readonly end: number; readonly start: number },
): ProjectedBlock | undefined {
  const sourceStart = sourceBounds?.start ?? requiredOffset(node.position?.start.offset);
  const sourceEnd = sourceBounds?.end ?? requiredOffset(node.position?.end.offset);
  const projected = projectPhrasingContent(node.children, source, sourceStart, sourceEnd);
  if (projected === undefined) {
    return undefined;
  }

  return {
    id: `${kind}:${sourceStart}:${sourceEnd}`,
    kind,
    runs: projected.runs,
    sourceEnd,
    sourceStart,
    structuralPath,
    visibleText: projected.visibleText,
  };
}

function projectPhrasingContent(
  children: readonly PhrasingContent[],
  source: string,
  sourceStart: number,
  sourceEnd: number,
): { readonly runs: readonly VisibleTextRun[]; readonly visibleText: string } | undefined {
  const runs: VisibleTextRun[] = [];
  let displayOffset = 0;
  let sourceCursor = sourceStart;
  let visibleText = '';

  for (const child of children) {
    const childStart = requiredOffset(child.position?.start.offset);
    const childEnd = requiredOffset(child.position?.end.offset);
    if (child.type === 'text') {
      if (source.slice(childStart, childEnd) !== child.value) {
        return undefined;
      }
      appendHiddenRun(runs, sourceCursor, childStart, displayOffset);
      runs.push({
        displayEnd: displayOffset + child.value.length,
        displayStart: displayOffset,
        mapping: 'identity',
        role: 'text',
        selectable: true,
        sourceEnd: childEnd,
        sourceStart: childStart,
      });
      displayOffset += child.value.length;
      visibleText += child.value;
      sourceCursor = childEnd;
      continue;
    }
    if (child.type === 'inlineCode') {
      const raw = source.slice(childStart, childEnd);
      const contentOffset = raw.indexOf(child.value);
      if (contentOffset < 0) {
        return undefined;
      }
      const contentStart = childStart + contentOffset;
      const contentEnd = contentStart + child.value.length;
      appendHiddenRun(runs, sourceCursor, contentStart, displayOffset);
      runs.push({
        displayEnd: displayOffset + child.value.length,
        displayStart: displayOffset,
        mapping: 'identity',
        role: 'inline-code',
        selectable: true,
        sourceEnd: contentEnd,
        sourceStart: contentStart,
      });
      displayOffset += child.value.length;
      visibleText += child.value;
      sourceCursor = contentEnd;
      continue;
    }
    if (child.type === 'emphasis' || child.type === 'strong') {
      const nested = projectPhrasingContent(child.children, source, childStart, childEnd);
      if (nested === undefined) {
        return undefined;
      }
      appendHiddenRun(runs, sourceCursor, childStart, displayOffset);
      runs.push(
        ...nested.runs.map((run) => ({
          ...run,
          displayEnd: run.displayEnd + displayOffset,
          displayStart: run.displayStart + displayOffset,
        })),
      );
      displayOffset += nested.visibleText.length;
      visibleText += nested.visibleText;
      sourceCursor = childEnd;
      continue;
    }
    return undefined;
  }

  appendHiddenRun(runs, sourceCursor, sourceEnd, displayOffset);
  return { runs, visibleText };
}

function appendHiddenRun(
  runs: VisibleTextRun[],
  sourceStart: number,
  sourceEnd: number,
  displayOffset: number,
): void {
  if (sourceEnd <= sourceStart) {
    return;
  }
  runs.push({
    displayEnd: displayOffset,
    displayStart: displayOffset,
    mapping: 'hidden',
    role: 'syntax',
    selectable: false,
    sourceEnd,
    sourceStart,
  });
}

function mapIdentityBoundary(
  block: ProjectedBlock,
  displayOffset: number,
  edge: 'end' | 'start',
): number {
  const run = block.runs.find((candidate) => {
    if (!candidate.selectable || candidate.mapping !== 'identity') {
      return false;
    }
    return edge === 'start'
      ? displayOffset >= candidate.displayStart && displayOffset < candidate.displayEnd
      : displayOffset > candidate.displayStart && displayOffset <= candidate.displayEnd;
  });
  if (run === undefined) {
    throw new Error('Projected display boundary has no stable source position.');
  }
  return run.sourceStart + displayOffset - run.displayStart;
}

function mapIdentitySourceBoundary(
  block: ProjectedBlock,
  sourceOffset: number,
  edge: 'end' | 'start',
): number {
  const run = block.runs.find((candidate) => {
    if (!candidate.selectable || candidate.mapping !== 'identity') {
      return false;
    }
    return edge === 'start'
      ? sourceOffset >= candidate.sourceStart && sourceOffset < candidate.sourceEnd
      : sourceOffset > candidate.sourceStart && sourceOffset <= candidate.sourceEnd;
  });
  if (run === undefined) {
    throw new Error('Projected source boundary has no stable display position.');
  }
  return run.displayStart + sourceOffset - run.sourceStart;
}

function requiredOffset(offset: number | undefined): number {
  if (offset === undefined) {
    throw new Error('Markdown parser did not provide an absolute source offset.');
  }
  return offset;
}
