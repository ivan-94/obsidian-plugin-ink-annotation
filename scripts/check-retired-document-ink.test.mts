import { describe, expect, it } from 'vitest';

import {
  findRetiredDocumentInkMarkers,
  findRetiredDocumentInkStyleMarkers,
} from './check-retired-document-ink.mjs';

describe('retired document Ink bundle Gate', () => {
  it('reports every user-visible legacy Ink entry in a bundle', () => {
    expect(findRetiredDocumentInkMarkers('Toggle Ink Mode … 开始涂鸦')).toEqual([
      'Toggle Ink Mode',
      '开始涂鸦',
    ]);
  });

  it('accepts Snapshot-only freehand wording', () => {
    expect(findRetiredDocumentInkMarkers('Capture & annotate · Read only · Edit')).toEqual([]);
  });

  it('rejects retired live-document workspace selectors while keeping the shared toolbar', () => {
    expect(
      findRetiredDocumentInkStyleMarkers(
        '.inkstone-ink-controls {} .inkstone-ink-workspace {} .inkstone-ink-rebase-dialog {}',
      ),
    ).toEqual(['.inkstone-ink-workspace', '.inkstone-ink-rebase-dialog']);
  });
});
