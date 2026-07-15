import { describe, expect, it } from 'vitest';

import { VaultAnnotationIndex, type AnnotationIndexEntry } from './vault-annotation-index';

describe('Vault annotation index performance', () => {
  it('searches 20,000 list-only records within the interactive budget', () => {
    const index = new VaultAnnotationIndex();
    index.rebuild(Array.from({ length: 20_000 }, (_, position) => entry(position)));
    index.query({ text: 'warm-up-query' });

    const durations = Array.from({ length: 20 }, (_, sample) => {
      const position = 19_999 - sample * 499;
      const startedAt = performance.now();
      const result = index.query({ text: `needle-${position}` });
      const durationMs = performance.now() - startedAt;
      expect(result.total).toBe(1);
      expect(result.groups[0]?.rows[0]?.id).toBe(
        position % 2 === 0 ? `annotation-${position}` : `surface-${position}`,
      );
      return durationMs;
    });
    const sorted = [...durations].sort((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;

    expect(p95).toBeLessThan(25);
  });

  it('keeps broad one-character searches inside the remaining debounce budget', () => {
    const index = new VaultAnnotationIndex();
    index.rebuild(Array.from({ length: 20_000 }, (_, position) => entry(position)));
    index.query({ text: 'warm-up-query' });

    const durations = ['n', 'e', 'o', 't', 'i'].map((text) => {
      const startedAt = performance.now();
      const result = index.query({ text });
      const durationMs = performance.now() - startedAt;
      expect(result.total).toBeGreaterThan(0);
      return durationMs;
    });
    const p95 = [...durations].sort((left, right) => left - right)[durations.length - 1];

    expect(p95).toBeLessThan(50);
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
