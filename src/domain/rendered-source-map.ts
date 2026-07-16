export interface RenderedRangeInput {
  readonly renderedEnd: number;
  readonly renderedStart: number;
  readonly renderedText: string;
  readonly sectionSource: string;
  readonly sectionSourceStart: number;
}

export interface MappedSourceRange {
  readonly end: number;
  readonly exact: string;
  readonly start: number;
}

export interface SourceRangeInput {
  readonly exact: string;
  readonly renderedText: string;
  readonly sectionSource: string;
  readonly sectionSourceStart: number;
  readonly sourceEnd: number;
  readonly sourceStart: number;
}

export function locateRenderedBlockSourceRange(input: {
  readonly renderedText: string;
  readonly sectionSource: string;
  readonly sectionSourceStart: number;
}): { readonly end: number; readonly start: number } {
  const selected = selectRenderedBlock(input.sectionSource, input.renderedText);
  return {
    end: input.sectionSourceStart + selected.end,
    start: input.sectionSourceStart + selected.start,
  };
}

const DOUBLE_PRESENTATION_MARKERS = ['**', '__', '~~', '=='] as const;

export function mapRenderedRangeToSource(input: RenderedRangeInput): MappedSourceRange {
  if (
    !Number.isInteger(input.renderedStart) ||
    !Number.isInteger(input.renderedEnd) ||
    input.renderedStart < 0 ||
    input.renderedEnd <= input.renderedStart ||
    input.renderedEnd > input.renderedText.length
  ) {
    throw new Error('Rendered selection is empty or outside the rendered block.');
  }

  const selected = selectRenderedBlock(input.sectionSource, input.renderedText);
  const projection = selected.projection;

  const localStartInBlock = projection.sourceOffsets[input.renderedStart];
  const lastSourceOffset = projection.sourceOffsets[input.renderedEnd - 1];
  if (localStartInBlock === undefined || lastSourceOffset === undefined) {
    throw new Error('Rendered selection has no stable source position.');
  }

  const localStart = selected.start + localStartInBlock;
  const localEnd = selected.start + lastSourceOffset + 1;
  const exact = input.renderedText.slice(input.renderedStart, input.renderedEnd);

  return {
    end: input.sectionSourceStart + localEnd,
    exact,
    start: input.sectionSourceStart + localStart,
  };
}

export function mapSourceRangeToRendered(input: SourceRangeInput): MappedSourceRange {
  const localStart = input.sourceStart - input.sectionSourceStart;
  const localEnd = input.sourceEnd - input.sectionSourceStart;
  if (
    localStart < 0 ||
    localEnd <= localStart ||
    localEnd > input.sectionSource.length ||
    input.sectionSource.slice(localStart, localEnd) !== input.exact
  ) {
    throw new Error('Persisted source range does not match its exact quote in this section.');
  }

  const selected = selectRenderedBlock(input.sectionSource, input.renderedText);
  const projection = selected.projection;
  const blockLocalStart = localStart - selected.start;
  const blockLocalEnd = localEnd - selected.start;

  const selectedRenderedOffsets = projection.sourceOffsets.flatMap((offset, renderedOffset) =>
    offset >= blockLocalStart && offset < blockLocalEnd ? [renderedOffset] : [],
  );
  const renderedStart = selectedRenderedOffsets[0];
  const renderedLast = selectedRenderedOffsets.at(-1);
  if (renderedStart === undefined || renderedLast === undefined) {
    throw new Error('Persisted source range has no visible rendered characters.');
  }
  if (
    renderedLast - renderedStart + 1 !== selectedRenderedOffsets.length ||
    projection.sourceOffsets
      .slice(renderedStart, renderedLast + 1)
      .some((offset) => offset < blockLocalStart || offset >= blockLocalEnd)
  ) {
    throw new Error('Persisted source range does not map to one contiguous rendered selection.');
  }
  const renderedEnd = renderedLast + 1;
  const renderedExact = input.renderedText.slice(renderedStart, renderedEnd);

  return { end: renderedEnd, exact: renderedExact, start: renderedStart };
}

function selectRenderedBlock(
  source: string,
  renderedText: string,
): {
  readonly end: number;
  readonly projection: ReturnType<typeof projectSupportedMarkdown>;
  readonly start: number;
} {
  const matches: Array<{
    readonly end: number;
    readonly projection: ReturnType<typeof projectSupportedMarkdown>;
    readonly start: number;
  }> = [];
  let fallbackProjection = '';

  for (const candidate of markdownBlockCandidates(source)) {
    try {
      const projection = projectSupportedMarkdown(source.slice(candidate.start, candidate.end));
      if (candidate.start === 0 && candidate.end === source.length) {
        fallbackProjection = projection.text;
      }
      if (projection.text === renderedText) {
        matches.push({ ...candidate, projection });
      }
    } catch {
      // A restricted candidate must not prevent another supported block from mapping.
    }
  }

  const unique = matches.filter(
    (match, index) =>
      matches.findIndex(
        (candidate) => candidate.start === match.start && candidate.end === match.end,
      ) === index,
  );
  if (unique.length === 1) {
    return unique[0] as (typeof unique)[number];
  }
  if (unique.length > 1) {
    throw new Error('Rendered block matches multiple Markdown source blocks.');
  }
  throw renderedMismatchError(fallbackProjection, renderedText);
}

function markdownBlockCandidates(source: string): readonly {
  readonly end: number;
  readonly start: number;
}[] {
  const candidates: Array<{ readonly end: number; readonly start: number }> = [
    { end: source.length, start: 0 },
  ];
  const lines = sourceLines(source);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.text.trim().length === 0) {
      index += 1;
      continue;
    }
    candidates.push({ end: line.end, start: line.start });
    if (/^#{1,6}[ \t]+/u.test(line.text)) {
      index += 1;
      continue;
    }

    const start = line.start;
    let end = line.end;
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (next === undefined || next.text.trim().length === 0 || /^#{1,6}[ \t]+/u.test(next.text)) {
        break;
      }
      end = next.end;
      index += 1;
    }
    candidates.push({ end, start });
  }
  return candidates;
}

function sourceLines(source: string): readonly {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}[] {
  const lines: Array<{ readonly end: number; readonly start: number; readonly text: string }> = [];
  let start = 0;
  while (start <= source.length) {
    const newline = source.indexOf('\n', start);
    const endWithCarriageReturn = newline < 0 ? source.length : newline;
    const end =
      source[endWithCarriageReturn - 1] === '\r'
        ? endWithCarriageReturn - 1
        : endWithCarriageReturn;
    lines.push({ end, start, text: source.slice(start, end) });
    if (newline < 0) {
      break;
    }
    start = newline + 1;
  }
  return lines;
}

function renderedMismatchError(projected: string, rendered: string): Error {
  let mismatchAt = 0;
  while (
    mismatchAt < projected.length &&
    mismatchAt < rendered.length &&
    projected[mismatchAt] === rendered[mismatchAt]
  ) {
    mismatchAt += 1;
  }
  return new Error(
    `Rendered block cannot be mapped uniquely to supported Markdown source ` +
      `(projected length ${projected.length}, rendered length ${rendered.length}, mismatch at ${mismatchAt}).`,
  );
}

function projectSupportedMarkdown(source: string): {
  readonly sourceOffsets: readonly number[];
  readonly text: string;
} {
  const sourceOffsets: number[] = [];
  let text = '';
  let index = 0;

  while (index < source.length) {
    if (index === 0 || source[index - 1] === '\n') {
      index += blockPrefixLength(source.slice(index));
      if (index >= source.length) {
        break;
      }
    }

    const doubleMarker = DOUBLE_PRESENTATION_MARKERS.find((marker) =>
      source.startsWith(marker, index),
    );
    if (doubleMarker !== undefined) {
      index += doubleMarker.length;
      continue;
    }

    const character = source[index];
    if (character === '!' && source[index + 1] === '[') {
      throw new Error('Images and embeds do not have a stable visible-text mapping.');
    }
    if (character === '[' && source[index + 1] === '[') {
      const close = source.indexOf(']]', index + 2);
      if (close < 0) {
        throw new Error('Wikilink mapping is incomplete.');
      }
      const innerStart = index + 2;
      const inner = source.slice(innerStart, close);
      const aliasSeparator = inner.lastIndexOf('|');
      if (aliasSeparator < 0) {
        throw new Error('Wikilinks require an explicit visible alias for stable mapping.');
      }
      const aliasStart = innerStart + aliasSeparator + 1;
      for (let aliasIndex = aliasStart; aliasIndex < close; aliasIndex += 1) {
        text += source[aliasIndex];
        sourceOffsets.push(aliasIndex);
      }
      index = close + 2;
      continue;
    }
    if (character === '[') {
      index += 1;
      continue;
    }
    if (character === ']' && source[index + 1] === '(') {
      const close = source.indexOf(')', index + 2);
      if (close < 0) {
        throw new Error('Markdown link destination is incomplete.');
      }
      index = close + 1;
      continue;
    }
    if (character === '*' || character === '_') {
      index += 1;
      continue;
    }

    if (character === '`') {
      throw new Error('Inline code mapping is restricted in S02.');
    }

    if (character === '\\' && index + 1 < source.length) {
      index += 1;
      text += source[index];
      sourceOffsets.push(index);
      index += 1;
      continue;
    }

    text += character;
    sourceOffsets.push(index);
    index += 1;
  }

  return { sourceOffsets, text };
}

function blockPrefixLength(source: string): number {
  const heading = /^(#{1,6})[ \t]+/u.exec(source)?.[0].length ?? 0;
  if (heading > 0) {
    return heading;
  }
  const quote = /^(?:>[ \t]?)+/u.exec(source)?.[0].length ?? 0;
  const afterQuote = source.slice(quote);
  const callout = /^\[![^\]\n]+\][+-]?[ \t]+/u.exec(afterQuote)?.[0].length ?? 0;
  if (quote > 0) {
    return quote + callout;
  }
  return /^(?:[ \t]*(?:[-+*]|\d+[.)])[ \t]+)(?:\[[ xX]\][ \t]+)?/u.exec(source)?.[0].length ?? 0;
}
