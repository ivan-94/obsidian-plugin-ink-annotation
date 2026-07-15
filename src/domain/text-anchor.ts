import type { TextAnnotationTarget, TextStructuralScope } from './text-annotation';

const CONTEXT_LENGTH = 32;

export interface CreateTextAnchorInput {
  readonly end: number;
  readonly scope: TextStructuralScope;
  readonly source: string;
  readonly start: number;
}

export async function createTextAnchor({
  end,
  scope,
  source,
  start,
}: CreateTextAnchorInput): Promise<TextAnnotationTarget> {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > source.length) {
    throw new Error('Selection position is outside the Markdown source.');
  }

  const exact = source.slice(start, end);
  if (exact.length === 0) {
    throw new Error('Selection must not be empty.');
  }

  const enrichedScope = await enrichScope(source, start, scope);

  return {
    position: { end, start, unit: 'utf16-code-unit' },
    quote: {
      exact,
      prefix: source.slice(Math.max(0, start - CONTEXT_LENGTH), start),
      suffix: source.slice(end, end + CONTEXT_LENGTH),
    },
    scope: enrichedScope,
    sourceRevision: await hashText(source),
  };
}

async function enrichScope(
  source: string,
  selectionStart: number,
  scope: TextStructuralScope,
): Promise<TextStructuralScope> {
  const cloned = cloneScope(scope);
  const blockSource = sourceForLineScope(source, scope);
  return {
    ...cloned,
    ...(cloned.blockFingerprint !== undefined || blockSource === null
      ? {}
      : { blockFingerprint: await hashText(normalizeBlockSource(blockSource)) }),
    ...(cloned.headingPath !== undefined
      ? {}
      : { headingPath: headingPathAt(source, selectionStart) }),
  };
}

export function resolveTextAnchorByPosition(
  source: string,
  target: TextAnnotationTarget,
): { readonly end: number; readonly start: number } | null {
  const { end, start } = target.position;
  if (start < 0 || end > source.length || source.slice(start, end) !== target.quote.exact) {
    return null;
  }

  return { end, start };
}

export async function hashText(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cloneScope(scope: TextStructuralScope): TextStructuralScope {
  return {
    ...(scope.blockFingerprint === undefined ? {} : { blockFingerprint: scope.blockFingerprint }),
    ...(scope.headingPath === undefined ? {} : { headingPath: [...scope.headingPath] }),
    ...(scope.sectionEndLine === undefined ? {} : { sectionEndLine: scope.sectionEndLine }),
    ...(scope.sectionStartLine === undefined ? {} : { sectionStartLine: scope.sectionStartLine }),
  };
}

function sourceForLineScope(source: string, scope: TextStructuralScope): string | null {
  const startLine = scope.sectionStartLine;
  const endLine = scope.sectionEndLine;
  if (startLine === undefined || endLine === undefined || endLine < startLine) {
    return null;
  }
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      offsets.push(index + 1);
    }
  }
  const start = offsets[startLine];
  if (start === undefined) {
    return null;
  }
  return source.slice(start, offsets[endLine + 1] ?? source.length);
}

function normalizeBlockSource(source: string): string {
  return source.replaceAll('\r\n', '\n').trim();
}

function headingPathAt(source: string, position: number): readonly string[] {
  const stack: string[] = [];
  let lineStart = 0;
  while (lineStart <= position) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(source.slice(lineStart, lineEnd));
    if (match !== null) {
      const level = (match[1] as string).length;
      stack.splice(level - 1);
      stack[level - 1] = match[2] as string;
    }
    if (newline < 0 || newline >= position) {
      break;
    }
    lineStart = newline + 1;
  }
  return stack.filter((entry) => entry !== undefined);
}
