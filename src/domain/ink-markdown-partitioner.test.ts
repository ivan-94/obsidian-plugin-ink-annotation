import { describe, expect, it } from 'vitest';

import { buildInkMarkdownPartitions, parseInkMarkdownBlocks } from './ink-markdown-partitioner';

describe('Markdown Ink partitioner', () => {
  it('tracks nested heading paths and keeps paragraph source ranges', () => {
    const source = '# A\n\nIntro.\n\n## A1\n\nDetail.\n\n# B\n\nEnd.';

    const blocks = parseInkMarkdownBlocks(source);

    expect(blocks.map(({ headingPath, kind }) => [kind, headingPath])).toEqual([
      ['heading', ['A']],
      ['block', ['A']],
      ['heading', ['A', 'A1']],
      ['block', ['A', 'A1']],
      ['heading', ['B']],
      ['block', ['B']],
    ]);
    expect(source.slice(blocks[1]?.sourceStart, blocks[1]?.sourceEnd)).toBe('Intro.');
  });

  it('produces the same section identity when an intact section moves in the note', () => {
    const before = buildInkMarkdownPartitions('# A\n\nAlpha.\n\n# B\n\nBeta.', { maxBlocks: 8 });
    const after = buildInkMarkdownPartitions('# B\n\nBeta.\n\n# A\n\nAlpha.', { maxBlocks: 8 });

    const beforeA = before.find((partition) => partition.headingPath.at(-1) === 'A');
    const afterA = after.find((partition) => partition.headingPath.at(-1) === 'A');
    expect(afterA?.sectionFingerprint).toBe(beforeA?.sectionFingerprint);
    expect(afterA?.sourceStart).not.toBe(beforeA?.sourceStart);
  });

  it('changes only the edited section fingerprint', () => {
    const before = buildInkMarkdownPartitions('# A\n\nAlpha.\n\n# B\n\nBeta.', { maxBlocks: 8 });
    const after = buildInkMarkdownPartitions('# A\n\nAlpha changed.\n\n# B\n\nBeta.', {
      maxBlocks: 8,
    });

    expect(after[0]?.sectionFingerprint).not.toBe(before[0]?.sectionFingerprint);
    expect(after[1]?.sectionFingerprint).toBe(before[1]?.sectionFingerprint);
  });

  it('keeps fenced code and lists as bounded blocks instead of falling back to the full note', () => {
    const partitions = buildInkMarkdownPartitions(
      '# A\n\n- one\n- two\n\n```ts\nconst value = 1;\n```\n\nAfter.',
      { maxBlocks: 2 },
    );

    expect(partitions).toHaveLength(2);
    expect(partitions.every((partition) => !partition.fullNoteFallback)).toBe(true);
    expect(partitions.flatMap((partition) => partition.blockFingerprints)).toHaveLength(4);
  });
});
