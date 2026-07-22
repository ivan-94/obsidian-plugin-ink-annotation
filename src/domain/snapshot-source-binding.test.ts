import { describe, expect, it } from 'vitest';

import { createSnapshotSourceBinding, projectSnapshotSourceLink } from './snapshot-source-binding';

describe('Snapshot Source Binding', () => {
  it('creates bounded unique Coverage Anchors that include first, Focus, and last visible blocks', async () => {
    const lines = [
      '# Chapter',
      'Alpha block',
      'Beta block',
      'Gamma block',
      'Delta block',
      'Omega block',
    ];
    const source = lines.join('\n\n');
    const blocks = lines.map((line) => {
      const start = source.indexOf(line);
      return {
        end: start + line.length,
        scope: { headingPath: line.startsWith('#') ? ['Chapter'] : ['Chapter'] },
        start,
      };
    });

    const binding = await createSnapshotSourceBinding({
      blocks,
      focusBlockIndex: 3,
      source,
    });

    expect(binding.coverage).toHaveLength(5);
    expect(binding.focus.quote.exact).toBe('Gamma block');
    expect(binding.coverage.map((target) => target.quote.exact)).toEqual([
      '# Chapter',
      'Alpha block',
      'Gamma block',
      'Delta block',
      'Omega block',
    ]);
    expect(new Set(binding.coverage.map((target) => target.position.start)).size).toBe(5);
    expect(binding.headingPath).toEqual(['Chapter']);
    expect(binding.coverage).toContainEqual(binding.focus);
  });

  it('derives linked, source-changed, and unanchored without mutating image-local data', async () => {
    const source = '# Chapter\n\nAlpha block\n\nGamma block\n\nOmega block';
    const blocks = ['# Chapter', 'Alpha block', 'Gamma block', 'Omega block'].map((exact) => {
      const start = source.indexOf(exact);
      return { end: start + exact.length, scope: { headingPath: ['Chapter'] }, start };
    });
    const binding = await createSnapshotSourceBinding({ blocks, focusBlockIndex: 2, source });

    expect(projectSnapshotSourceLink(source, binding).state).toBe('linked');
    expect(projectSnapshotSourceLink(`Preface\n\n${source}`, binding).state).toBe('linked');
    expect(
      projectSnapshotSourceLink(source.replace('Gamma block', 'Gamma changed'), binding).state,
    ).toBe('source-changed');
    expect(projectSnapshotSourceLink('Entirely different note', binding)).toMatchObject({
      failure: { candidateCount: 0, reason: 'not-found' },
      state: 'unanchored',
    });
  });
});
