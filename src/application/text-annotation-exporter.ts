import { annotationTargetText, type TextAnnotationRecord } from '../domain/text-annotation';

export type TextAnnotationExportFormat =
  'html-mark' | 'markdown-footnote' | 'markdown-highlight' | 'markdown-report';

export interface TextAnnotationExportItem {
  readonly conflict?: boolean;
  readonly overlap?: boolean;
  readonly record: TextAnnotationRecord;
  readonly styleName?: string;
}

export interface TextAnnotationExportOptions {
  readonly format: TextAnnotationExportFormat;
  readonly generatedAt: string;
  readonly title?: string;
}

export interface TextAnnotationExporter {
  collect(
    sortedItems: Iterable<TextAnnotationExportItem> | AsyncIterable<TextAnnotationExportItem>,
    options: TextAnnotationExportOptions,
  ): Promise<string>;
  stream(
    sortedItems: Iterable<TextAnnotationExportItem> | AsyncIterable<TextAnnotationExportItem>,
    options: TextAnnotationExportOptions,
  ): AsyncIterable<string>;
}

export const textAnnotationExporter: TextAnnotationExporter = {
  collect: collectTextAnnotationExport,
  stream: streamTextAnnotationExport,
};

export function sortTextAnnotationExportItems(
  items: readonly TextAnnotationExportItem[],
): readonly TextAnnotationExportItem[] {
  return [...items].sort(
    (left, right) =>
      compareText(left.record.filePath, right.record.filePath) ||
      left.record.target.position.start - right.record.target.position.start ||
      compareText(left.record.id, right.record.id),
  );
}

export async function collectTextAnnotationExport(
  sortedItems: Iterable<TextAnnotationExportItem> | AsyncIterable<TextAnnotationExportItem>,
  options: TextAnnotationExportOptions,
): Promise<string> {
  let output = '';
  for await (const chunk of streamTextAnnotationExport(sortedItems, options)) {
    output += chunk;
  }
  return output;
}

export async function* streamTextAnnotationExport(
  sortedItems: Iterable<TextAnnotationExportItem> | AsyncIterable<TextAnnotationExportItem>,
  options: TextAnnotationExportOptions,
): AsyncGenerator<string> {
  yield exportHeader(options);
  let index = 0;
  let previousFilePath: string | null = null;
  for await (const item of toAsyncIterable(sortedItems)) {
    index += 1;
    if (options.format === 'markdown-report' && item.record.filePath !== previousFilePath) {
      yield `## ${escapeMarkdownInline(item.record.filePath)}\n\n`;
      previousFilePath = item.record.filePath;
    }
    yield renderItem(item, index, options.format);
  }
  yield exportFooter(options.format, index);
}

export async function chooseUniqueExportPath(
  requestedPath: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  if (!(await exists(requestedPath))) {
    return requestedPath;
  }
  const separator = requestedPath.lastIndexOf('/');
  const directory = separator < 0 ? '' : requestedPath.slice(0, separator + 1);
  const filename = separator < 0 ? requestedPath : requestedPath.slice(separator + 1);
  const dot = filename.lastIndexOf('.');
  const stem = dot <= 0 ? filename : filename.slice(0, dot);
  const extension = dot <= 0 ? '' : filename.slice(dot);
  for (let suffix = 2; suffix <= 10_000; suffix += 1) {
    const candidate = `${directory}${stem} ${suffix}${extension}`;
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
  throw new Error('Could not choose a unique annotation export filename.');
}

export function buildTextAnnotationExportPath(
  title: string,
  format: TextAnnotationExportFormat,
  generatedAt: string,
): string {
  const safeTitle = title
    .replace(/[/\\:*?"<>|]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/gu, '');
  const timestamp = generatedAt.replace('.000', '').replaceAll(':', '-');
  const extension = format === 'html-mark' ? 'html' : 'md';
  return `Inkstone Exports/${safeTitle.length === 0 ? 'Annotations' : safeTitle} ${timestamp}.${extension}`;
}

function exportHeader(options: TextAnnotationExportOptions): string {
  const title = options.title ?? 'Inkstone annotations';
  switch (options.format) {
    case 'html-mark':
      return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(title)}</title>\n</head>\n<body>\n<h1>${escapeHtml(title)}</h1>\n`;
    case 'markdown-report':
      return `---\ninkstone-export: 1\ngenerated-at: ${options.generatedAt}\n---\n\n# ${escapeMarkdownInline(title === 'Inkstone annotations' ? 'Inkstone annotation report' : title)}\n\n`;
    case 'markdown-footnote':
    case 'markdown-highlight':
      return `# ${escapeMarkdownInline(title)}\n\n`;
  }
}

function exportFooter(format: TextAnnotationExportFormat, count: number): string {
  if (format === 'html-mark') {
    return `<footer>${count} ${count === 1 ? 'annotation' : 'annotations'}</footer>\n</body>\n</html>\n`;
  }
  return `<!-- Inkstone export: ${count} ${count === 1 ? 'annotation' : 'annotations'} -->\n`;
}

function renderItem(
  item: TextAnnotationExportItem,
  index: number,
  format: TextAnnotationExportFormat,
): string {
  switch (format) {
    case 'html-mark':
      return renderHtmlItem(item);
    case 'markdown-footnote':
      return renderFootnoteItem(item, index);
    case 'markdown-highlight':
      return renderHighlightItem(item);
    case 'markdown-report':
      return renderReportItem(item, index);
  }
}

function renderHighlightItem(item: TextAnnotationExportItem): string {
  const { record } = item;
  const quote = annotationTargetText(record.target);
  const kind = record.mark?.kind;
  let materialized: string;
  if (kind === 'highlight' && !quote.includes('\n') && !quote.includes('==')) {
    materialized = `==${escapeMarkdownInline(quote)}==`;
  } else if (kind === 'underline') {
    materialized = `${quoteBlock(quote)}\n\n_Underline is preserved as metadata; plain Markdown has no portable underline syntax._`;
  } else {
    materialized = `${quoteBlock(quote)}\n\n_Note-only annotation._`;
  }
  return `${materialized}\n\n${markdownMetadata(item)}${markdownNote(record)}---\n\n`;
}

function renderFootnoteItem(item: TextAnnotationExportItem, index: number): string {
  const id = `inkstone-${index}`;
  const quote = annotationTargetText(item.record.target);
  const definition = [
    annotationLabel(item),
    `source ${item.record.filePath}`,
    `position ${item.record.target.position.start}–${item.record.target.position.end} UTF-16`,
    item.record.tags.length === 0 ? '' : `tags ${item.record.tags.join(', ')}`,
    item.conflict === true ? 'conflict yes' : '',
    item.overlap === true ? 'overlap yes' : '',
    item.record.body === undefined ? '' : `note ${collapseWhitespace(item.record.body)}`,
    needsContext(item)
      ? `context ${collapseWhitespace(item.record.target.quote.prefix)} ⟦target⟧ ${collapseWhitespace(item.record.target.quote.suffix)}`
      : '',
    item.record.anchorFailure === undefined
      ? ''
      : `anchor failure ${item.record.anchorFailure.reason} (${item.record.anchorFailure.candidateCount} candidates)`,
  ].filter((part) => part.length > 0);
  return `${quoteBlock(`${quote}[^${id}]`)}\n\n[^${id}]: ${escapeMarkdownInline(definition.join(' · '))}\n\n`;
}

function renderReportItem(item: TextAnnotationExportItem, index: number): string {
  const { record } = item;
  let output = `### ${index}. ${escapeMarkdownInline(annotationLabel(item))}\n\n`;
  output += `${quoteBlock(annotationTargetText(record.target))}\n\n`;
  output += markdownMetadata(item);
  output += markdownNote(record);
  return `${output}\n`;
}

function renderHtmlItem(item: TextAnnotationExportItem): string {
  const { record } = item;
  const kind = record.mark?.kind ?? 'note';
  const quote = escapeHtml(annotationTargetText(record.target)).replaceAll('\n', '<br>');
  const materialized =
    kind === 'highlight'
      ? `<mark>${quote}</mark>`
      : kind === 'underline'
        ? `<u>${quote}</u>`
        : `<q>${quote}</q>`;
  const rows: [string, string][] = [
    ['Type', displayKind(record)],
    ['Style', item.styleName ?? record.mark?.styleId ?? 'none'],
    ['Status', record.status],
    ['Source', record.filePath],
    ['Position', `${record.target.position.start}–${record.target.position.end} UTF-16`],
    ['Tags', record.tags.join(', ') || 'none'],
    ['Conflict', item.conflict === true ? 'yes' : 'no'],
    ['Overlap', item.overlap === true ? 'yes' : 'no'],
  ];
  if (needsContext(item)) {
    rows.push(
      ['Context before', record.target.quote.prefix],
      ['Context after', record.target.quote.suffix],
    );
  }
  if (record.anchorFailure !== undefined) {
    rows.push([
      'Anchor failure',
      `${record.anchorFailure.reason} (${record.anchorFailure.candidateCount} candidates)`,
    ]);
  }
  return `<article data-annotation-id="${escapeHtml(record.id)}" data-kind="${kind}" data-status="${record.status}">\n${materialized}\n<dl>\n${rows.map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd>`).join('\n')}\n</dl>\n${record.body === undefined ? '' : `<section><h2>Note</h2><p>${escapeHtml(record.body).replaceAll('\n', '<br>')}</p></section>\n`}</article>\n`;
}

function markdownMetadata(item: TextAnnotationExportItem): string {
  const { record } = item;
  const lines = [
    `- Annotation: ${escapeMarkdownInline(annotationLabel(item))}`,
    `- Source: ${inlineCode(record.filePath)}`,
    `- Position: ${record.target.position.start}–${record.target.position.end} UTF-16`,
    `- Tags: ${record.tags.length === 0 ? 'none' : record.tags.map(inlineCode).join(', ')}`,
    `- Annotation ID: ${inlineCode(record.id)}`,
  ];
  if (item.conflict === true) {
    lines.push('- Conflict: yes');
  }
  if (item.overlap === true) {
    lines.push('- Overlap: yes');
  }
  if (needsContext(item)) {
    lines.push(`- Context before: ${inlineCode(record.target.quote.prefix)}`);
    lines.push(`- Context after: ${inlineCode(record.target.quote.suffix)}`);
  }
  if (record.anchorFailure !== undefined) {
    lines.push(
      `- Anchor failure: ${escapeMarkdownInline(record.anchorFailure.reason)} (${record.anchorFailure.candidateCount} candidates)`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function markdownNote(record: TextAnnotationRecord): string {
  if (record.body === undefined || record.body.length === 0) {
    return '\n';
  }
  return `\n**Note**\n\n${quoteBlock(record.body)}\n\n`;
}

function annotationLabel(item: TextAnnotationExportItem): string {
  const { record } = item;
  return [
    displayKind(record),
    item.styleName ?? record.mark?.styleId ?? '',
    record.status,
    item.conflict === true ? 'conflict' : '',
  ]
    .filter((part) => part.length > 0)
    .join(' · ');
}

function displayKind(record: TextAnnotationRecord): string {
  switch (record.mark?.kind) {
    case 'highlight':
      return 'Highlight';
    case 'underline':
      return 'Underline';
    case undefined:
      return 'Note only';
  }
}

function needsContext(item: TextAnnotationExportItem): boolean {
  return item.conflict === true || item.record.status === 'unanchored';
}

function quoteBlock(value: string): string {
  return value
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function escapeMarkdownInline(value: string): string {
  return value.replaceAll('\\', '\\\\').replace(/[`*_[\]<>|]/gu, '\\$&');
}

function inlineCode(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${value}${fence}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function* toAsyncIterable<T>(values: Iterable<T> | AsyncIterable<T>): AsyncGenerator<T> {
  for await (const value of values) {
    yield value;
  }
}
