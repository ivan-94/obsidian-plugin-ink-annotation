import { describe, expect, it } from 'vitest';

import { VaultAnnotationIndex, type AnnotationIndexEntry } from './vault-annotation-index';

describe('Vault annotation index performance', () => {
  it('searches 20,000 list-only records within the interactive budget', () => {
    const index = new VaultAnnotationIndex();
    index.rebuild(Array.from({ length: 20_000 }, (_, position) => entry(position)));

    const startedAt = performance.now();
    const result = index.query({ text: 'needle-19999' });
    const durationMs = performance.now() - startedAt;

    expect(result.total).toBe(1);
    expect(result.groups[0]?.rows[0]?.id).toBe('surface-19999');
    expect(durationMs).toBeLessThan(250);
  });
});

function entry(position: number): AnnotationIndexEntry {
  if (position % 2 === 1) {
    return {
      body: `${position} strokes`,
      conflict: false,
      filePath: `Folder/Note-${Math.floor(position / 10)}.md`,
      id: `surface-${position}`,
      ink: { headingPath: ['Performance', `needle-${position}`], strokeCount: position },
      noteId: `note-${Math.floor(position / 10)}`,
      position,
      quote: `Ink · Performance › needle-${position}`,
      revision: 1,
      status: position % 5 === 0 ? 'needs-rebase' : 'active',
      tags: [],
      type: 'ink',
      updatedAt: '2026-07-14T08:00:00.000Z',
    };
  }
  return {
    conflict: false,
    filePath: `Folder/Note-${Math.floor(position / 10)}.md`,
    id: `annotation-${position}`,
    noteId: `note-${Math.floor(position / 10)}`,
    position,
    quote: `Indexed quote needle-${position}`,
    revision: 1,
    status: 'active',
    styleId: 'highlight-sun',
    tags: ['even'],
    type: 'highlight',
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}
