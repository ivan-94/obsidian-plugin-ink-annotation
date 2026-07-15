import { describe, expect, it } from 'vitest';

import { createTextAnchor } from './text-anchor';
import { resolveTextAnchor } from './text-anchor-resolver';

describe('compound text anchor resolver', () => {
  it('resolves in position, block, section and global order as Markdown mutates', async () => {
    const original = '# Intro\n\nThe target phrase lives here.\n\n## Later\n\nAnother paragraph.';
    const exact = 'target phrase';
    const start = original.indexOf(exact);
    const target = await createTextAnchor({
      end: start + exact.length,
      scope: { headingPath: ['Intro'], sectionEndLine: 2, sectionStartLine: 2 },
      source: original,
      start,
    });

    expect(resolveTextAnchor(original, target)).toMatchObject({
      kind: 'resolved',
      method: 'position',
      start,
    });

    const blockEdited = original.replace('The target', 'The newly target');
    expect(resolveTextAnchor(blockEdited, target)).toMatchObject({
      kind: 'resolved',
      method: 'block',
      start: blockEdited.indexOf(exact),
    });

    const lineInserted = original.replace('# Intro\n\n', '# Intro\n\nA new paragraph.\n\n');
    expect(resolveTextAnchor(lineInserted, target)).toMatchObject({
      kind: 'resolved',
      method: 'section',
      start: lineInserted.indexOf(exact),
    });

    const renamedAndMoved = `## Later\n\nAnother paragraph.\n\n# Renamed\n\nThe ${exact} lives here.`;
    expect(resolveTextAnchor(renamedAndMoved, target)).toMatchObject({
      kind: 'resolved',
      method: 'global',
      start: renamedAndMoved.indexOf(exact),
    });
  });

  it('uses quote context to choose one repeated candidate but rejects indistinguishable copies', async () => {
    const original = '# One\n\nAlpha target phrase omega.';
    const exact = 'target phrase';
    const start = original.indexOf(exact);
    const target = await createTextAnchor({
      end: start + exact.length,
      scope: { headingPath: ['One'], sectionEndLine: 2, sectionStartLine: 2 },
      source: original,
      start,
    });
    const distinguishable =
      '# Other\n\nBeta target phrase gamma.\n\n# Renamed\n\nAlpha target phrase omega.';

    expect(resolveTextAnchor(distinguishable, target)).toMatchObject({
      kind: 'resolved',
      method: 'global',
      start: distinguishable.lastIndexOf(exact),
    });

    const ambiguous = 'Alpha target phrase omega.\n\nAlpha target phrase omega.';
    const unscopedTarget = await createTextAnchor({
      end: start + exact.length,
      scope: {},
      source: original,
      start,
    });
    expect(resolveTextAnchor(ambiguous, unscopedTarget)).toEqual({
      candidates: 2,
      kind: 'unanchored',
      reason: 'ambiguous',
    });
  });

  it('returns an explicit unanchored reason when the quote was deleted', async () => {
    const source = 'Keep this exact quote safe.';
    const exact = 'exact quote';
    const start = source.indexOf(exact);
    const target = await createTextAnchor({ end: start + exact.length, scope: {}, source, start });

    expect(resolveTextAnchor('The passage was removed.', target)).toEqual({
      candidates: 0,
      kind: 'unanchored',
      reason: 'not-found',
    });
  });

  it('never throws or returns an out-of-bounds target across deterministic random edits', async () => {
    const original = '# Unicode\n\nCJK 中文, emoji 😀, combining e\u0301, RTL אבג target phrase.';
    const exact = 'target phrase';
    const start = original.indexOf(exact);
    const target = await createTextAnchor({
      end: start + exact.length,
      scope: { headingPath: ['Unicode'], sectionEndLine: 2, sectionStartLine: 2 },
      source: original,
      start,
    });
    let seed = 0x5eed;

    for (let iteration = 0; iteration < 200; iteration += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const first = seed % (original.length + 1);
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const second = seed % (original.length + 1);
      const low = Math.min(first, second);
      const high = Math.max(first, second);
      const mutated =
        iteration % 2 === 0
          ? `${original.slice(0, first)}Δ${original.slice(first)}`
          : `${original.slice(0, low)}${original.slice(high)}`;

      const resolution = resolveTextAnchor(mutated, target);
      if (resolution.kind === 'resolved') {
        expect(resolution.start).toBeGreaterThanOrEqual(0);
        expect(resolution.end).toBeLessThanOrEqual(mutated.length);
        expect(mutated.slice(resolution.start, resolution.end)).toBe(exact);
      }
    }
  });
});
