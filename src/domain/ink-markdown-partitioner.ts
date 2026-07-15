import {
  partitionInkBlocks,
  type InkMarkdownBlock,
  type InkSurfacePartition,
} from './ink-surface-layout';

interface SourceLine {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

/** Parses only the structural information needed for stable, hidden Ink boundaries. */
export function parseInkMarkdownBlocks(source: string): readonly InkMarkdownBlock[] {
  const lines = sourceLines(source);
  const blocks: InkMarkdownBlock[] = [];
  const headings: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.text.trim().length === 0) {
      index += 1;
      continue;
    }

    const heading = /^(?: {0,3})(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line.text);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      const title = heading[2]?.trim() ?? '';
      headings.length = level - 1;
      headings[level - 1] = title;
      blocks.push(toBlock(source, line.start, line.end, headings, 'heading'));
      index += 1;
      continue;
    }

    const start = line.start;
    let end = line.end;
    if (/^(?: {0,3})(?:`{3,}|~{3,})/u.test(line.text)) {
      const marker = /^(?: {0,3})(`{3,}|~{3,})/u.exec(line.text)?.[1] ?? '```';
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index];
        if (candidate === undefined) break;
        end = candidate.end;
        index += 1;
        if (candidate.text.trimStart().startsWith(marker[0]?.repeat(marker.length) ?? marker)) {
          break;
        }
      }
    } else {
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index];
        if (
          candidate === undefined ||
          candidate.text.trim().length === 0 ||
          /^(?: {0,3})#{1,6}[ \t]+/u.test(candidate.text) ||
          /^(?: {0,3})(?:`{3,}|~{3,})/u.test(candidate.text)
        ) {
          break;
        }
        end = candidate.end;
        index += 1;
      }
    }
    blocks.push(toBlock(source, start, end, headings, 'block'));
  }

  return blocks;
}

export function buildInkMarkdownPartitions(
  source: string,
  options: { readonly maxBlocks: number },
): readonly InkSurfacePartition[] {
  return partitionInkBlocks(parseInkMarkdownBlocks(source), options);
}

function toBlock(
  source: string,
  sourceStart: number,
  sourceEnd: number,
  headingPath: readonly string[],
  kind: InkMarkdownBlock['kind'],
): InkMarkdownBlock {
  const exact = source.slice(sourceStart, sourceEnd);
  return {
    fingerprint: stableFingerprint(`${kind}\u0000${exact}`),
    headingPath: [...headingPath],
    kind,
    sourceEnd,
    sourceStart,
  };
}

function stableFingerprint(value: string): string {
  // Two independent 32-bit FNV-1a passes keep the on-disk identity compact and deterministic.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

function sourceLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf('\n', start);
    const endWithNewline = newline < 0 ? source.length : newline + 1;
    const rawEnd = newline < 0 ? source.length : newline;
    const end = source[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
    lines.push({ end, start, text: source.slice(start, end) });
    start = endWithNewline;
  }
  return lines;
}
