import { describe, expect, it } from 'vitest';

import {
  buildSourceProjection,
  mapProjectedDisplayRangeToSource,
  mapProjectedSourceRangeToDisplay,
} from './source-projection';

describe('parser-backed source projection', () => {
  it('maps the second item in a tight list as its own source-backed block', () => {
    const source = '- first\n- second\n- third';
    const projection = buildSourceProjection({
      dialectVersion: 'commonmark-v1',
      filePath: 'Lists.md',
      source,
      sourceRevision: 'revision-1',
    });

    const second = projection.blocks.find((block) => block.visibleText === 'second');

    expect(second).toMatchObject({
      kind: 'list-item',
      sourceEnd: source.indexOf('second') + 'second'.length,
      sourceStart: source.indexOf('- second'),
      visibleText: 'second',
    });
    expect(
      mapProjectedDisplayRangeToSource({
        block: second!,
        displayEnd: 'second'.length,
        displayStart: 0,
        source,
      }),
    ).toEqual({
      end: source.indexOf('second') + 'second'.length,
      exact: 'second',
      start: source.indexOf('second'),
    });
  });

  it('maps ordinary paragraph text beside inline code without rejecting the block', () => {
    const source = 'Selectable prefix beside `inline code` remains selectable.';
    const projection = buildSourceProjection({
      dialectVersion: 'commonmark-v1',
      filePath: 'Inline code.md',
      source,
      sourceRevision: 'revision-1',
    });

    const paragraph = projection.blocks[0];
    const selected = 'Selectable prefix';

    expect(paragraph).toMatchObject({
      kind: 'paragraph',
      visibleText: 'Selectable prefix beside inline code remains selectable.',
    });
    expect(
      mapProjectedDisplayRangeToSource({
        block: paragraph!,
        displayEnd: selected.length,
        displayStart: 0,
        source,
      }),
    ).toEqual({
      end: selected.length,
      exact: selected,
      start: 0,
    });
  });

  it('projects a list-item source range back to the same visible characters', () => {
    const source = '- first\n- second\n- third';
    const projection = buildSourceProjection({
      dialectVersion: 'commonmark-v1',
      filePath: 'Lists.md',
      source,
      sourceRevision: 'revision-1',
    });
    const second = projection.blocks.find((block) => block.visibleText === 'second')!;
    const sourceStart = source.indexOf('second');

    expect(
      mapProjectedSourceRangeToDisplay({
        block: second,
        sourceEnd: sourceStart + 'second'.length,
        sourceStart,
      }),
    ).toEqual({
      end: 'second'.length,
      exact: 'second',
      start: 0,
    });
  });

  it('preserves hidden emphasis markers inside a selected source interval', () => {
    const source = 'plain **bold** tail';
    const visibleText = 'plain bold tail';
    const projection = buildSourceProjection({
      dialectVersion: 'commonmark-v1',
      filePath: 'Emphasis.md',
      source,
      sourceRevision: 'revision-1',
    });
    const paragraph = projection.blocks[0]!;

    expect(paragraph.visibleText).toBe(visibleText);
    expect(
      mapProjectedDisplayRangeToSource({
        block: paragraph,
        displayEnd: visibleText.length,
        displayStart: 0,
        source,
      }),
    ).toEqual({
      end: source.length,
      exact: source,
      start: 0,
    });
    expect(
      mapProjectedSourceRangeToDisplay({
        block: paragraph,
        sourceEnd: source.length,
        sourceStart: 0,
      }),
    ).toEqual({
      end: visibleText.length,
      exact: visibleText,
      start: 0,
    });
  });
});
