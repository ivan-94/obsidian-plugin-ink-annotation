import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import type { Blockquote, List, ListItem, Paragraph, PhrasingContent, Root } from 'mdast';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { mathFromMarkdown } from 'mdast-util-math';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import type { Position } from 'unist';

export const OBSIDIAN_SOURCE_DIALECT_VERSION = 'obsidian-gfm-v1';

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
  readonly kind:
    | 'blockquote'
    | 'callout-body'
    | 'callout-title'
    | 'code-block'
    | 'heading'
    | 'list'
    | 'list-item'
    | 'math-block'
    | 'paragraph'
    | 'table'
    | 'table-cell'
    | 'table-row';
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

/** Bounded parser-artifact cache. Entries are touched on read and evicted least-recently-used. */
export class SourceProjectionCache {
  private readonly entries = new Map<
    string,
    {
      readonly estimatedBytes: number;
      readonly projection: SourceProjection;
      readonly source: string;
    }
  >();
  private readonly maxEntries: number;
  private readonly maxEstimatedBytes: number;
  private retainedEstimatedBytes = 0;

  constructor(
    limits:
      | number
      | {
          readonly maxEntries: number;
          readonly maxEstimatedBytes: number;
        } = { maxEntries: 8, maxEstimatedBytes: 16 * 1024 * 1024 },
  ) {
    this.maxEntries = typeof limits === 'number' ? limits : limits.maxEntries;
    this.maxEstimatedBytes =
      typeof limits === 'number' ? 16 * 1024 * 1024 : limits.maxEstimatedBytes;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error('Source Projection cache size must be a positive integer.');
    }
    if (!Number.isFinite(this.maxEstimatedBytes) || this.maxEstimatedBytes < 1) {
      throw new Error('Source Projection cache byte limit must be positive.');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get estimatedBytes(): number {
    return this.retainedEstimatedBytes;
  }

  clear(): void {
    this.entries.clear();
    this.retainedEstimatedBytes = 0;
  }

  getOrBuild(input: BuildSourceProjectionInput): SourceProjection {
    const key = projectionCacheKey(input);
    const cached = this.entries.get(key);
    if (cached !== undefined && cached.source === input.source) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.projection;
    }

    const projection = buildSourceProjection(input);
    const replaced = this.entries.get(key);
    if (replaced !== undefined) {
      this.retainedEstimatedBytes -= replaced.estimatedBytes;
      this.entries.delete(key);
    }
    const estimatedBytes = estimateProjectionBytes(input.source, projection);
    this.entries.set(key, { estimatedBytes, projection, source: input.source });
    this.retainedEstimatedBytes += estimatedBytes;
    while (
      this.entries.size > this.maxEntries ||
      this.retainedEstimatedBytes > this.maxEstimatedBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.entries.get(oldest);
      if (evicted !== undefined) this.retainedEstimatedBytes -= evicted.estimatedBytes;
      this.entries.delete(oldest);
    }
    return projection;
  }
}

export function buildSourceProjection(input: BuildSourceProjectionInput): SourceProjection {
  const tree = fromMarkdown(input.source, {
    extensions: [frontmatter(), gfm(), math()],
    mdastExtensions: [frontmatterFromMarkdown(), gfmFromMarkdown(), mathFromMarkdown()],
  });

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

/** Fast deterministic revision token for disposable local projection caches. */
export function sourceProjectionRevision(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${source.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function projectionCacheKey(input: SourceProjectionKey): string {
  return JSON.stringify([input.dialectVersion, input.filePath, input.sourceRevision]);
}

function estimateProjectionBytes(source: string, projection: SourceProjection): number {
  return (
    source.length * 2 +
    projection.blocks.reduce(
      (bytes, block) => bytes + 96 + block.visibleText.length * 2 + block.runs.length * 64,
      0,
    )
  );
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

  const start =
    tryMapSourceBoundary(input.block, input.sourceStart, 'start') ??
    input.block.runs.find(
      (run) =>
        run.selectable &&
        run.displayEnd > run.displayStart &&
        run.sourceEnd > input.sourceStart &&
        run.sourceStart < input.sourceEnd,
    )?.displayStart;
  const end =
    tryMapSourceBoundary(input.block, input.sourceEnd, 'end') ??
    [...input.block.runs]
      .reverse()
      .find(
        (run) =>
          run.selectable &&
          run.displayEnd > run.displayStart &&
          run.sourceStart < input.sourceEnd &&
          run.sourceEnd > input.sourceStart,
      )?.displayEnd;
  if (start === undefined || end === undefined || end <= start) {
    throw new Error('Projected source range has no visible display interval.');
  }

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
      blocks.push(...projectList(node, [{ index: rootIndex, kind: 'list' }], source));
      return;
    }
    if (node.type === 'blockquote') {
      const callout = projectCallout(node, rootIndex, source);
      if (callout !== null) {
        blocks.push(...callout);
        return;
      }
      node.children.forEach((child, childIndex) => {
        if (child.type === 'paragraph') {
          const childStart = requiredOffset(child.position?.start.offset);
          const block = projectPhrasingBlock(
            child,
            'blockquote',
            [
              { index: rootIndex, kind: 'blockquote' },
              { index: childIndex, kind: 'paragraph' },
            ],
            source,
            {
              end: requiredOffset(child.position?.end.offset),
              start: lineStartAt(source, childStart),
            },
          );
          if (block !== undefined) blocks.push(block);
          return;
        }
        if (child.type === 'list') {
          blocks.push(
            ...projectList(
              child,
              [
                { index: rootIndex, kind: 'blockquote' },
                { index: childIndex, kind: 'list' },
              ],
              source,
            ),
          );
        }
      });
      return;
    }
    if (node.type === 'table') {
      node.children.forEach((row, rowIndex) => {
        row.children.forEach((cell, cellIndex) => {
          const block = projectPhrasingBlock(
            cell,
            'table-cell',
            [
              { index: rootIndex, kind: 'table' },
              { index: rowIndex, kind: 'table-row' },
              { index: cellIndex, kind: 'table-cell' },
            ],
            source,
          );
          if (block !== undefined) {
            blocks.push(block);
          }
        });
      });
      return;
    }
    if (node.type === 'code') {
      const sourceStart = requiredOffset(node.position?.start.offset);
      const sourceEnd = requiredOffset(node.position?.end.offset);
      const raw = source.slice(sourceStart, sourceEnd);
      const contentOffset = raw.indexOf(node.value);
      if (contentOffset >= 0) {
        const contentStart = sourceStart + contentOffset;
        const contentEnd = contentStart + node.value.length;
        const runs: VisibleTextRun[] = [];
        appendHiddenRun(runs, sourceStart, contentStart, 0);
        appendIdentityRun(runs, contentStart, node.value, 0, 'code-text');
        appendHiddenRun(runs, contentEnd, sourceEnd, node.value.length);
        blocks.push({
          id: `code-block:${sourceStart}:${sourceEnd}`,
          kind: 'code-block',
          runs,
          sourceEnd,
          sourceStart,
          structuralPath: [{ index: rootIndex, kind: 'code-block' }],
          visibleText: node.value,
        });
      }
      return;
    }
    if (node.type === 'math') {
      const sourceStart = requiredOffset(node.position?.start.offset);
      const sourceEnd = requiredOffset(node.position?.end.offset);
      const runs: VisibleTextRun[] = [];
      appendAtomicRun(runs, sourceStart, sourceEnd, 0, node.value, 'math');
      blocks.push({
        id: `math-block:${sourceStart}:${sourceEnd}`,
        kind: 'math-block',
        runs,
        sourceEnd,
        sourceStart,
        structuralPath: [{ index: rootIndex, kind: 'math-block' }],
        visibleText: node.value,
      });
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

function projectCallout(
  blockquote: Blockquote,
  rootIndex: number,
  source: string,
): readonly ProjectedBlock[] | null {
  const blockStart = requiredOffset(blockquote.position?.start.offset);
  const blockEnd = requiredOffset(blockquote.position?.end.offset);
  const lines = sourceLinesWithin(source, blockStart, blockEnd);
  const first = lines[0];
  if (first === undefined) {
    return null;
  }
  const declaration = /^[ \t]*>[ \t]*\[![^\]]+\][+-]?(?:[ \t]+(?<title>.*))?$/u.exec(first.text);
  if (declaration === null) {
    return null;
  }

  const blocks: ProjectedBlock[] = [];
  const title = declaration.groups?.title;
  if (title !== undefined && title.length > 0) {
    blocks.push(
      projectLineBlock('callout-title', first, first.text.lastIndexOf(title), title, [
        { index: rootIndex, kind: 'blockquote' },
        { index: 0, kind: 'callout-title' },
      ]),
    );
  }

  let bodyGroup: Array<{
    readonly content: string;
    readonly contentOffset: number;
    readonly index: number;
    readonly line: (typeof lines)[number];
  }> = [];
  const flushBodyGroup = (): void => {
    if (bodyGroup.length === 0) return;
    blocks.push(projectCalloutBodyGroup(bodyGroup, rootIndex));
    bodyGroup = [];
  };
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const body = /^[ \t]*>[ \t]?(?<content>.*)$/u.exec(line.text);
    const content = body?.groups?.content;
    if (content === undefined || content.length === 0) {
      flushBodyGroup();
      continue;
    }
    bodyGroup.push({
      content,
      contentOffset: line.text.lastIndexOf(content),
      index,
      line,
    });
  }
  flushBodyGroup();
  return blocks;
}

function projectCalloutBodyGroup(
  lines: readonly {
    readonly content: string;
    readonly contentOffset: number;
    readonly index: number;
    readonly line: { readonly end: number; readonly start: number; readonly text: string };
  }[],
  rootIndex: number,
): ProjectedBlock {
  const first = lines[0]!;
  const last = lines.at(-1)!;
  const runs: VisibleTextRun[] = [];
  let displayOffset = 0;
  let sourceCursor = first.line.start;
  let visibleText = '';

  lines.forEach((entry, lineIndex) => {
    const contentStart = entry.line.start + entry.contentOffset;
    appendHiddenRun(runs, sourceCursor, contentStart, displayOffset);
    const inline = projectInlineSnippet(entry.content);
    if (inline === undefined) {
      const decoded = appendDecodedText(runs, contentStart, entry.content, displayOffset, 'text');
      displayOffset += decoded.length;
      visibleText += decoded;
    } else {
      runs.push(
        ...inline.runs.map((run) => ({
          ...run,
          displayEnd: run.displayEnd + displayOffset,
          displayStart: run.displayStart + displayOffset,
          sourceEnd: run.sourceEnd + contentStart,
          sourceStart: run.sourceStart + contentStart,
        })),
      );
      displayOffset += inline.visibleText.length;
      visibleText += inline.visibleText;
    }
    sourceCursor = contentStart + entry.content.length;
    const next = lines[lineIndex + 1];
    if (next !== undefined) {
      appendHiddenRun(runs, sourceCursor, entry.line.end, displayOffset);
      appendAtomicRun(runs, entry.line.end, next.line.start, displayOffset, '\n', 'text');
      displayOffset += 1;
      visibleText += '\n';
      sourceCursor = next.line.start;
    }
  });
  appendHiddenRun(runs, sourceCursor, last.line.end, displayOffset);
  return {
    id: `callout-body:${first.line.start}:${last.line.end}`,
    kind: 'callout-body',
    runs,
    sourceEnd: last.line.end,
    sourceStart: first.line.start,
    structuralPath: [
      { index: rootIndex, kind: 'blockquote' },
      { index: first.index, kind: 'callout-body' },
    ],
    visibleText,
  };
}

function projectLineBlock(
  kind: 'callout-body' | 'callout-title',
  line: { readonly end: number; readonly start: number; readonly text: string },
  contentOffset: number,
  content: string,
  structuralPath: readonly StructuralPathSegment[],
): ProjectedBlock {
  const contentStart = line.start + contentOffset;
  const runs: VisibleTextRun[] = [];
  appendHiddenRun(runs, line.start, contentStart, 0);
  const inline = projectInlineSnippet(content);
  const visibleText =
    inline === undefined
      ? appendDecodedText(runs, contentStart, content, 0, 'text')
      : inline.visibleText;
  if (inline !== undefined) {
    runs.push(
      ...inline.runs.map((run) => ({
        ...run,
        sourceEnd: run.sourceEnd + contentStart,
        sourceStart: run.sourceStart + contentStart,
      })),
    );
  }
  appendHiddenRun(runs, contentStart + content.length, line.end, visibleText.length);
  return {
    id: `${kind}:${line.start}:${line.end}`,
    kind,
    runs,
    sourceEnd: line.end,
    sourceStart: line.start,
    structuralPath,
    visibleText,
  };
}

function projectInlineSnippet(
  source: string,
): { readonly runs: readonly VisibleTextRun[]; readonly visibleText: string } | undefined {
  const tree = fromMarkdown(source, {
    extensions: [frontmatter(), gfm(), math()],
    mdastExtensions: [frontmatterFromMarkdown(), gfmFromMarkdown(), mathFromMarkdown()],
  });
  const paragraph = tree.children.find((node): node is Paragraph => node.type === 'paragraph');
  return paragraph === undefined
    ? undefined
    : projectPhrasingContent(paragraph.children, source, 0, source.length);
}

function sourceLinesWithin(
  source: string,
  sourceStart: number,
  sourceEnd: number,
): readonly { readonly end: number; readonly start: number; readonly text: string }[] {
  const lines = [];
  let start = sourceStart;
  while (start <= sourceEnd) {
    const newline = source.indexOf('\n', start);
    const rawEnd = newline < 0 || newline > sourceEnd ? sourceEnd : newline;
    const end = source[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
    lines.push({ end, start, text: source.slice(start, end) });
    if (newline < 0 || newline >= sourceEnd) {
      break;
    }
    start = newline + 1;
  }
  return lines;
}

function projectList(
  list: List,
  listPath: readonly StructuralPathSegment[],
  source: string,
): readonly ProjectedBlock[] {
  return list.children.flatMap((item, itemIndex) => {
    const itemPath = [...listPath, { index: itemIndex, kind: 'list-item' as const }];
    return item.children.flatMap((child, childIndex) => {
      if (child.type === 'paragraph') {
        const block = projectListItem(
          item,
          child,
          [...itemPath, { index: childIndex, kind: 'paragraph' }],
          source,
          childIndex === 0,
        );
        return block === undefined ? [] : [block];
      }
      return child.type === 'list'
        ? projectList(child, [...itemPath, { index: childIndex, kind: 'list' }], source)
        : [];
    });
  });
}

function projectListItem(
  item: ListItem,
  paragraph: Paragraph,
  structuralPath: readonly StructuralPathSegment[],
  source: string,
  firstChild: boolean,
): ProjectedBlock | undefined {
  const itemStart = requiredOffset(item.position?.start.offset);
  const paragraphStart = requiredOffset(paragraph.position?.start.offset);
  const paragraphEnd = requiredOffset(paragraph.position?.end.offset);
  return projectPhrasingBlock(paragraph, 'list-item', structuralPath, source, {
    end: paragraphEnd,
    start: firstChild ? itemStart : lineStartAt(source, paragraphStart),
  });
}

function lineStartAt(source: string, offset: number): number {
  return source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

function projectPhrasingBlock(
  node: PhrasingParent,
  kind: 'blockquote' | 'heading' | 'list-item' | 'paragraph' | 'table-cell',
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

interface PhrasingParent {
  readonly children: readonly PhrasingContent[];
  readonly position?: Position | undefined;
}

function projectPhrasingContent(
  children: readonly PhrasingContent[],
  source: string,
  sourceStart: number,
  sourceEnd: number,
): { readonly runs: readonly VisibleTextRun[]; readonly visibleText: string } | undefined {
  const runs: VisibleTextRun[] = [];
  let displayOffset = 0;
  let rawHtmlDepth = 0;
  let sourceCursor = sourceStart;
  let visibleText = '';

  for (const child of children) {
    const childStart = requiredOffset(child.position?.start.offset);
    const childEnd = requiredOffset(child.position?.end.offset);
    if (child.type === 'text') {
      if (rawHtmlDepth > 0) {
        appendHiddenRun(runs, sourceCursor, childStart, displayOffset);
        const unsupportedRuns: VisibleTextRun[] = [];
        const unsupportedText = appendDecodedText(
          unsupportedRuns,
          childStart,
          source.slice(childStart, childEnd),
          displayOffset,
          'generated',
        );
        runs.push(
          ...unsupportedRuns.map((run) => ({
            ...run,
            mapping: 'synthetic' as const,
            selectable: false,
          })),
        );
        displayOffset += unsupportedText.length;
        visibleText += unsupportedText;
        sourceCursor = childEnd;
        continue;
      }
      const projectedText = projectTextContent(source.slice(childStart, childEnd), childStart);
      if (projectedText === undefined) {
        return undefined;
      }
      appendHiddenRun(runs, sourceCursor, childStart, displayOffset);
      runs.push(
        ...projectedText.runs.map((run) => ({
          ...run,
          displayEnd: run.displayEnd + displayOffset,
          displayStart: run.displayStart + displayOffset,
        })),
      );
      displayOffset += projectedText.visibleText.length;
      visibleText += projectedText.visibleText;
      sourceCursor = childEnd;
      continue;
    }
    if (child.type === 'html') {
      appendHiddenRun(runs, sourceCursor, childEnd, displayOffset);
      rawHtmlDepth = nextRawHtmlDepth(rawHtmlDepth, source.slice(childStart, childEnd));
      sourceCursor = childEnd;
      continue;
    }
    if (child.type === 'break' || child.type === 'image' || child.type === 'imageReference') {
      appendHiddenRun(runs, sourceCursor, childEnd, displayOffset);
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
    if (child.type === 'inlineMath') {
      appendHiddenRun(runs, sourceCursor, childStart, displayOffset);
      appendAtomicRun(runs, childStart, childEnd, displayOffset, child.value, 'math');
      displayOffset += child.value.length;
      visibleText += child.value;
      sourceCursor = childEnd;
      continue;
    }
    if (
      child.type === 'delete' ||
      child.type === 'emphasis' ||
      child.type === 'link' ||
      child.type === 'linkReference' ||
      child.type === 'strong'
    ) {
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
          role:
            (child.type === 'link' || child.type === 'linkReference') && run.role === 'text'
              ? ('link-label' as const)
              : run.role,
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

function nextRawHtmlDepth(current: number, raw: string): number {
  if (/^<\s*\//u.test(raw)) return Math.max(0, current - 1);
  if (
    /^<\s*(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/iu.test(raw) ||
    /\/\s*>$/u.test(raw) ||
    /^<!--/u.test(raw)
  ) {
    return current;
  }
  return /^<\s*[A-Za-z][^>]*>$/u.test(raw) ? current + 1 : current;
}

function projectTextContent(
  raw: string,
  sourceStart: number,
): { readonly runs: readonly VisibleTextRun[]; readonly visibleText: string } | undefined {
  const blockId = /[ \t]+\^[A-Za-z0-9-]+[ \t]*$/u.exec(raw);
  const projectedRaw = blockId?.index === undefined ? raw : raw.slice(0, blockId.index);
  const runs: VisibleTextRun[] = [];
  let displayOffset = 0;
  let sourceOffset = 0;
  let visibleText = '';

  while (sourceOffset < projectedRaw.length) {
    const embedStart = projectedRaw.indexOf('![[', sourceOffset);
    const wikilinkStart = projectedRaw.indexOf('[[', sourceOffset);
    const highlightStart = projectedRaw.indexOf('==', sourceOffset);
    const commentStart = projectedRaw.indexOf('%%', sourceOffset);
    const tokenStart = firstSourceOffset(embedStart, wikilinkStart, highlightStart, commentStart);
    if (tokenStart < 0) {
      const text = projectedRaw.slice(sourceOffset);
      const decoded = appendDecodedText(
        runs,
        sourceStart + sourceOffset,
        text,
        displayOffset,
        'text',
      );
      visibleText += decoded;
      break;
    }
    const before = projectedRaw.slice(sourceOffset, tokenStart);
    const decodedBefore = appendDecodedText(
      runs,
      sourceStart + sourceOffset,
      before,
      displayOffset,
      'text',
    );
    displayOffset += decodedBefore.length;
    visibleText += decodedBefore;

    if (tokenStart === embedStart) {
      const close = projectedRaw.indexOf(']]', embedStart + 3);
      if (close < 0) {
        const remainder = projectedRaw.slice(embedStart);
        const decodedRemainder = appendDecodedText(
          runs,
          sourceStart + embedStart,
          remainder,
          displayOffset,
          'text',
        );
        visibleText += decodedRemainder;
        break;
      }
      appendHiddenRun(runs, sourceStart + embedStart, sourceStart + close + 2, displayOffset);
      sourceOffset = close + 2;
      continue;
    }

    if (tokenStart === commentStart) {
      const close = projectedRaw.indexOf('%%', commentStart + 2);
      if (close < 0) {
        const remainder = projectedRaw.slice(commentStart);
        const decodedRemainder = appendDecodedText(
          runs,
          sourceStart + commentStart,
          remainder,
          displayOffset,
          'text',
        );
        visibleText += decodedRemainder;
        break;
      }
      appendHiddenRun(runs, sourceStart + commentStart, sourceStart + close + 2, displayOffset);
      sourceOffset = close + 2;
      continue;
    }

    if (tokenStart === highlightStart) {
      const close = projectedRaw.indexOf('==', highlightStart + 2);
      if (close < 0) {
        const remainder = projectedRaw.slice(highlightStart);
        const decodedRemainder = appendDecodedText(
          runs,
          sourceStart + highlightStart,
          remainder,
          displayOffset,
          'text',
        );
        visibleText += decodedRemainder;
        break;
      }
      const contentStart = highlightStart + 2;
      const content = projectedRaw.slice(contentStart, close);
      appendHiddenRun(
        runs,
        sourceStart + highlightStart,
        sourceStart + contentStart,
        displayOffset,
      );
      const decodedContent = appendDecodedText(
        runs,
        sourceStart + contentStart,
        content,
        displayOffset,
        'text',
      );
      displayOffset += decodedContent.length;
      visibleText += decodedContent;
      appendHiddenRun(runs, sourceStart + close, sourceStart + close + 2, displayOffset);
      sourceOffset = close + 2;
      continue;
    }

    const close = projectedRaw.indexOf(']]', wikilinkStart + 2);
    if (close < 0) {
      const remainder = projectedRaw.slice(wikilinkStart);
      const decodedRemainder = appendDecodedText(
        runs,
        sourceStart + wikilinkStart,
        remainder,
        displayOffset,
        'text',
      );
      visibleText += decodedRemainder;
      break;
    }
    const contentStart = wikilinkStart + 2;
    const content = projectedRaw.slice(contentStart, close);
    const aliasSeparator = content.lastIndexOf('|');
    const labelStart =
      aliasSeparator < 0 ? contentStart : contentStart + aliasSeparator + '|'.length;
    const label = projectedRaw.slice(labelStart, close);
    appendHiddenRun(runs, sourceStart + wikilinkStart, sourceStart + labelStart, displayOffset);
    const decodedLabel = appendDecodedText(
      runs,
      sourceStart + labelStart,
      label,
      displayOffset,
      'link-label',
    );
    displayOffset += decodedLabel.length;
    visibleText += decodedLabel;
    appendHiddenRun(runs, sourceStart + close, sourceStart + close + 2, displayOffset);
    sourceOffset = close + 2;
  }

  appendHiddenRun(runs, sourceStart + projectedRaw.length, sourceStart + raw.length, displayOffset);
  return { runs, visibleText };
}

function appendDecodedText(
  runs: VisibleTextRun[],
  sourceStart: number,
  raw: string,
  displayStart: number,
  role: VisibleRunRole,
): string {
  let displayOffset = displayStart;
  let sourceOffset = 0;
  let visibleText = '';

  while (sourceOffset < raw.length) {
    const lineBreak = /^(?<newline>\r\n|\r|\n)(?<container>[ \t]*(?:>[ \t]*)+)?/u.exec(
      raw.slice(sourceOffset),
    );
    if (lineBreak !== null) {
      const newline = lineBreak.groups?.newline ?? '\n';
      const container = lineBreak.groups?.container ?? '';
      appendAtomicRun(
        runs,
        sourceStart + sourceOffset,
        sourceStart + sourceOffset + newline.length,
        displayOffset,
        '\n',
        role,
      );
      appendHiddenRun(
        runs,
        sourceStart + sourceOffset + newline.length,
        sourceStart + sourceOffset + newline.length + container.length,
        displayOffset + 1,
      );
      displayOffset += 1;
      visibleText += '\n';
      sourceOffset += newline.length + container.length;
      continue;
    }

    const escape = /^\\([!-/:-@[-`{-~])/u.exec(raw.slice(sourceOffset));
    if (escape !== null) {
      const visible = escape[1] ?? '';
      appendAtomicRun(
        runs,
        sourceStart + sourceOffset,
        sourceStart + sourceOffset + escape[0].length,
        displayOffset,
        visible,
        role,
      );
      displayOffset += visible.length;
      visibleText += visible;
      sourceOffset += escape[0].length;
      continue;
    }

    const reference = /^&(#(?:[xX][0-9A-Fa-f]+|[0-9]+)|[A-Za-z][A-Za-z0-9]+);/u.exec(
      raw.slice(sourceOffset),
    );
    if (reference !== null) {
      const visible = decodeCharacterReference(reference[1] ?? '');
      if (visible !== null) {
        appendAtomicRun(
          runs,
          sourceStart + sourceOffset,
          sourceStart + sourceOffset + reference[0].length,
          displayOffset,
          visible,
          role,
        );
        displayOffset += visible.length;
        visibleText += visible;
        sourceOffset += reference[0].length;
        continue;
      }
    }

    let identityEnd = sourceOffset + 1;
    while (
      identityEnd < raw.length &&
      raw[identityEnd] !== '\\' &&
      raw[identityEnd] !== '&' &&
      raw[identityEnd] !== '\r' &&
      raw[identityEnd] !== '\n'
    ) {
      identityEnd += 1;
    }
    const identity = raw.slice(sourceOffset, identityEnd);
    appendIdentityRun(runs, sourceStart + sourceOffset, identity, displayOffset, role);
    displayOffset += identity.length;
    visibleText += identity;
    sourceOffset = identityEnd;
  }

  return visibleText;
}

function decodeCharacterReference(reference: string): string | null {
  if (!reference.startsWith('#')) {
    return decodeNamedCharacterReference(reference) || null;
  }
  const hexadecimal = reference[1]?.toLowerCase() === 'x';
  const digits = reference.slice(hexadecimal ? 2 : 1);
  const value = Number.parseInt(digits, hexadecimal ? 16 : 10);
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return '\uFFFD';
  }
  return String.fromCodePoint(value);
}

function appendAtomicRun(
  runs: VisibleTextRun[],
  sourceStart: number,
  sourceEnd: number,
  displayStart: number,
  visibleText: string,
  role: VisibleRunRole,
): void {
  runs.push({
    displayEnd: displayStart + visibleText.length,
    displayStart,
    mapping: 'atomic',
    role,
    selectable: true,
    sourceEnd,
    sourceStart,
  });
}

function firstSourceOffset(...offsets: readonly number[]): number {
  const present = offsets.filter((offset) => offset >= 0);
  return present.length === 0 ? -1 : Math.min(...present);
}

function appendIdentityRun(
  runs: VisibleTextRun[],
  sourceStart: number,
  text: string,
  displayStart: number,
  role: VisibleRunRole,
): void {
  if (text.length === 0) {
    return;
  }
  runs.push({
    displayEnd: displayStart + text.length,
    displayStart,
    mapping: 'identity',
    role,
    selectable: true,
    sourceEnd: sourceStart + text.length,
    sourceStart,
  });
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
    if (!candidate.selectable || !isDisplayBoundaryInRun(candidate, displayOffset, edge)) {
      return false;
    }
    return candidate.mapping === 'identity' || candidate.mapping === 'atomic';
  });
  if (run === undefined) {
    throw new Error('Projected display boundary has no stable source position.');
  }
  if (run.mapping === 'atomic') {
    if (edge === 'start' && displayOffset === run.displayStart) return run.sourceStart;
    if (edge === 'end' && displayOffset === run.displayEnd) return run.sourceEnd;
    throw new Error('A transformed character must be selected as one atomic unit.');
  }
  return run.sourceStart + displayOffset - run.displayStart;
}

function mapIdentitySourceBoundary(
  block: ProjectedBlock,
  sourceOffset: number,
  edge: 'end' | 'start',
): number {
  const run = block.runs.find((candidate) => {
    if (!candidate.selectable || !isSourceBoundaryInRun(candidate, sourceOffset, edge)) {
      return false;
    }
    return candidate.mapping === 'identity' || candidate.mapping === 'atomic';
  });
  if (run === undefined) {
    throw new Error('Projected source boundary has no stable display position.');
  }
  if (run.mapping === 'atomic') {
    if (edge === 'start' && sourceOffset === run.sourceStart) return run.displayStart;
    if (edge === 'end' && sourceOffset === run.sourceEnd) return run.displayEnd;
    throw new Error('A transformed source reference must be selected as one atomic unit.');
  }
  return run.displayStart + sourceOffset - run.sourceStart;
}

function tryMapSourceBoundary(
  block: ProjectedBlock,
  sourceOffset: number,
  edge: 'end' | 'start',
): number | undefined {
  try {
    return mapIdentitySourceBoundary(block, sourceOffset, edge);
  } catch {
    return undefined;
  }
}

function isDisplayBoundaryInRun(
  run: VisibleTextRun,
  offset: number,
  edge: 'end' | 'start',
): boolean {
  return edge === 'start'
    ? offset >= run.displayStart && offset < run.displayEnd
    : offset > run.displayStart && offset <= run.displayEnd;
}

function isSourceBoundaryInRun(
  run: VisibleTextRun,
  offset: number,
  edge: 'end' | 'start',
): boolean {
  return edge === 'start'
    ? offset >= run.sourceStart && offset < run.sourceEnd
    : offset > run.sourceStart && offset <= run.sourceEnd;
}

function requiredOffset(offset: number | undefined): number {
  if (offset === undefined) {
    throw new Error('Markdown parser did not provide an absolute source offset.');
  }
  return offset;
}
