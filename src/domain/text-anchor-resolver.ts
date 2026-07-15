import type { TextAnnotationTarget } from './text-annotation';

export type AnchorResolution =
  | {
      readonly confidence: number;
      readonly end: number;
      readonly kind: 'resolved';
      readonly method: 'block' | 'global' | 'position' | 'section';
      readonly start: number;
    }
  | {
      readonly candidates: number;
      readonly kind: 'unanchored';
      readonly reason: 'ambiguous' | 'not-found';
    };

interface Candidate {
  readonly contextScore: number;
  readonly end: number;
  readonly start: number;
}

export function resolveTextAnchor(source: string, target: TextAnnotationTarget): AnchorResolution {
  const { end, start } = target.position;
  if (start >= 0 && end <= source.length && source.slice(start, end) === target.quote.exact) {
    return { confidence: 1, end, kind: 'resolved', method: 'position', start };
  }

  const allStarts = findOccurrences(source, target.quote.exact);
  if (allStarts.length === 0) {
    return { candidates: 0, kind: 'unanchored', reason: 'not-found' };
  }

  const blockRange = originalLineRange(source, target);
  const blockCandidates = candidatesInRange(allStarts, target.quote.exact.length, blockRange);
  if (blockCandidates.length === 1) {
    const candidate = blockCandidates[0] as number;
    if (quoteContextScore(source, candidate, target) >= 0.5) {
      return resolved(candidate, target.quote.exact.length, 'block', 0.95);
    }
  }

  const sectionRange = headingSectionRange(source, target.scope.headingPath);
  const sectionCandidates = candidatesInRange(allStarts, target.quote.exact.length, sectionRange);
  if (sectionCandidates.length === 1) {
    const candidate = sectionCandidates[0] as number;
    if (quoteContextScore(source, candidate, target) >= 0.25) {
      return resolved(candidate, target.quote.exact.length, 'section', 0.9);
    }
  }

  if (allStarts.length === 1) {
    return resolved(allStarts[0] as number, target.quote.exact.length, 'global', 0.8);
  }

  const ranked = allStarts
    .map((candidateStart) => ({
      contextScore: quoteContextScore(source, candidateStart, target),
      end: candidateStart + target.quote.exact.length,
      start: candidateStart,
    }))
    .sort((left, right) => right.contextScore - left.contextScore);
  const best = ranked[0] as Candidate;
  const runnerUp = ranked[1] as Candidate;
  if (best.contextScore >= 0.5 && best.contextScore - runnerUp.contextScore >= 0.2) {
    return {
      confidence: Math.round((0.75 + best.contextScore * 0.2) * 100) / 100,
      end: best.end,
      kind: 'resolved',
      method: 'global',
      start: best.start,
    };
  }

  return { candidates: allStarts.length, kind: 'unanchored', reason: 'ambiguous' };
}

function resolved(
  start: number,
  exactLength: number,
  method: Extract<AnchorResolution, { kind: 'resolved' }>['method'],
  confidence: number,
): AnchorResolution {
  return { confidence, end: start + exactLength, kind: 'resolved', method, start };
}

function findOccurrences(source: string, exact: string): readonly number[] {
  const starts: number[] = [];
  let from = 0;
  while (from <= source.length - exact.length) {
    const start = source.indexOf(exact, from);
    if (start < 0) {
      break;
    }
    starts.push(start);
    from = start + Math.max(1, exact.length);
  }
  return starts;
}

function candidatesInRange(
  starts: readonly number[],
  exactLength: number,
  range: { readonly end: number; readonly start: number } | null,
): readonly number[] {
  if (range === null) {
    return [];
  }
  return starts.filter((start) => start >= range.start && start + exactLength <= range.end);
}

function originalLineRange(
  source: string,
  target: TextAnnotationTarget,
): { readonly end: number; readonly start: number } | null {
  const startLine = target.scope.sectionStartLine;
  const endLine = target.scope.sectionEndLine;
  if (startLine === undefined || endLine === undefined || endLine < startLine) {
    return null;
  }
  const offsets = lineOffsets(source);
  if (startLine >= offsets.length) {
    return null;
  }
  return {
    end: offsets[endLine + 1] ?? source.length,
    start: offsets[startLine] as number,
  };
}

function headingSectionRange(
  source: string,
  expectedPath: readonly string[] | undefined,
): { readonly end: number; readonly start: number } | null {
  if (expectedPath === undefined || expectedPath.length === 0) {
    return null;
  }
  const headings = parseHeadings(source);
  const matching = headings.filter((heading) => arraysEqual(heading.path, expectedPath));
  if (matching.length !== 1) {
    return null;
  }
  const heading = matching[0] as (typeof headings)[number];
  const next = headings.find(
    (candidate) => candidate.start > heading.start && candidate.level <= heading.level,
  );
  return { end: next?.start ?? source.length, start: heading.start };
}

function parseHeadings(source: string): readonly {
  readonly level: number;
  readonly path: readonly string[];
  readonly start: number;
}[] {
  const headings: Array<{
    readonly level: number;
    readonly path: readonly string[];
    readonly start: number;
  }> = [];
  const stack: string[] = [];
  const offsets = lineOffsets(source);
  for (let line = 0; line < offsets.length; line += 1) {
    const start = offsets[line] as number;
    const end = offsets[line + 1] === undefined ? source.length : (offsets[line + 1] as number) - 1;
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(source.slice(start, end));
    if (match === null) {
      continue;
    }
    const level = (match[1] as string).length;
    stack.splice(level - 1);
    stack[level - 1] = match[2] as string;
    headings.push({ level, path: stack.filter((entry) => entry !== undefined), start });
  }
  return headings;
}

function lineOffsets(source: string): readonly number[] {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function quoteContextScore(
  source: string,
  candidateStart: number,
  target: TextAnnotationTarget,
): number {
  const candidateEnd = candidateStart + target.quote.exact.length;
  const prefix = source.slice(
    Math.max(0, candidateStart - target.quote.prefix.length),
    candidateStart,
  );
  const suffix = source.slice(candidateEnd, candidateEnd + target.quote.suffix.length);
  const prefixScore =
    matchingSuffixLength(prefix, target.quote.prefix) / Math.max(1, target.quote.prefix.length);
  const suffixScore =
    matchingPrefixLength(suffix, target.quote.suffix) / Math.max(1, target.quote.suffix.length);
  return (prefixScore + suffixScore) / 2;
}

function matchingSuffixLength(left: string, right: string): number {
  let length = 0;
  while (
    length < left.length &&
    length < right.length &&
    left[left.length - 1 - length] === right[right.length - 1 - length]
  ) {
    length += 1;
  }
  return length;
}

function matchingPrefixLength(left: string, right: string): number {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) {
    length += 1;
  }
  return length;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
