import { describe, expect, it } from 'vitest';

import type { AnnotationIndexEntry } from '../domain/vault-annotation-index';
import { planVaultTextExport } from './vault-text-export-plan';

describe('Vault text export plan', () => {
  const entries = Array.from({ length: 2_001 }, (_, index) => ({
    id: String(index),
  })) as unknown as readonly AnnotationIndexEntry[];

  it('partitions large Markdown exports into indexer-safe files', () => {
    const parts = planVaultTextExport(entries, 'Annotations - Vault results', 'markdown-report');

    expect(parts.map((part) => part.entries.length)).toEqual([1_000, 1_000, 1]);
    expect(parts.map((part) => part.title)).toEqual([
      'Annotations - Vault results - Part 1 of 3',
      'Annotations - Vault results - Part 2 of 3',
      'Annotations - Vault results - Part 3 of 3',
    ]);
    expect(parts.flatMap((part) => part.entries)).toEqual(entries);
  });

  it('keeps HTML and small Markdown exports in one file', () => {
    expect(planVaultTextExport(entries, 'Vault', 'html-mark')).toEqual([
      { entries, title: 'Vault' },
    ]);
    expect(planVaultTextExport(entries.slice(0, 1_000), 'Vault', 'markdown-report')).toEqual([
      { entries: entries.slice(0, 1_000), title: 'Vault' },
    ]);
  });
});
