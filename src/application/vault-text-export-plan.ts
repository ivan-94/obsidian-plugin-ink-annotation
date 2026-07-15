import type { AnnotationIndexEntry } from '../domain/vault-annotation-index';
import type { TextAnnotationExportFormat } from './text-annotation-exporter';

export const MAX_INDEXED_MARKDOWN_EXPORT_ENTRIES = 1_000;

export interface VaultTextExportPart {
  readonly entries: readonly AnnotationIndexEntry[];
  readonly title: string;
}

/**
 * Large Markdown reports are split before they enter the indexed Vault. Obsidian's
 * metadata worker otherwise has to parse one multi-megabyte, heading-heavy file.
 * HTML remains a single standalone file because Obsidian does not Markdown-index it.
 */
export function planVaultTextExport(
  entries: readonly AnnotationIndexEntry[],
  title: string,
  format: TextAnnotationExportFormat,
  maxMarkdownEntries = MAX_INDEXED_MARKDOWN_EXPORT_ENTRIES,
): readonly VaultTextExportPart[] {
  if (!Number.isInteger(maxMarkdownEntries) || maxMarkdownEntries < 1) {
    throw new Error('Markdown export partition size must be a positive integer.');
  }
  if (format === 'html-mark' || entries.length <= maxMarkdownEntries) {
    return [{ entries, title }];
  }
  const partCount = Math.ceil(entries.length / maxMarkdownEntries);
  return Array.from({ length: partCount }, (_, index) => ({
    entries: entries.slice(index * maxMarkdownEntries, (index + 1) * maxMarkdownEntries),
    title: `${title} - Part ${index + 1} of ${partCount}`,
  }));
}
