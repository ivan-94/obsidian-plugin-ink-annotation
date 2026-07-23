import { describe, expect, it } from 'vitest';

import {
  buildSourceProjection,
  mapProjectedDisplayRangeToSource,
  mapProjectedSourceRangeToDisplay,
  OBSIDIAN_SOURCE_DIALECT_VERSION,
  SourceProjectionCache,
} from './source-projection';

describe('parser-backed source projection', () => {
  it('bounds parser artifacts with an LRU cache keyed by dialect, file, and revision', () => {
    const cache = new SourceProjectionCache(2);
    const firstInput = {
      dialectVersion: OBSIDIAN_SOURCE_DIALECT_VERSION,
      filePath: 'one.md',
      source: 'one',
      sourceRevision: 'rev-1',
    };
    const first = cache.getOrBuild(firstInput);

    expect(cache.getOrBuild(firstInput)).toBe(first);
    cache.getOrBuild({ ...firstInput, filePath: 'two.md', source: 'two' });
    cache.getOrBuild({ ...firstInput, filePath: 'three.md', source: 'three' });

    expect(cache.size).toBe(2);
    expect(cache.getOrBuild(firstInput)).not.toBe(first);
    expect(
      cache.getOrBuild({
        ...firstInput,
        dialectVersion: 'obsidian-gfm-v2',
      }),
    ).not.toBe(cache.getOrBuild(firstInput));

    const byteBounded = new SourceProjectionCache({
      maxEntries: 100,
      maxEstimatedBytes: 1_024,
    });
    for (let index = 0; index < 100; index += 1) {
      byteBounded.getOrBuild({
        ...firstInput,
        filePath: `note-${index}.md`,
        source: `note ${index}`,
        sourceRevision: `revision-${index}`,
      });
    }
    expect(byteBounded.size).toBeLessThan(100);
    expect(byteBounded.estimatedBytes).toBeLessThanOrEqual(1_024);
  });

  it('treats YAML frontmatter as hidden document metadata', () => {
    const source = ['---', 'title: Test', 'tags:', '  - one', '---', '', '# Heading'].join('\n');
    const projection = buildSourceProjection({
      dialectVersion: OBSIDIAN_SOURCE_DIALECT_VERSION,
      filePath: 'Frontmatter.md',
      source,
      sourceRevision: 'revision-1',
    });

    expect(projection.blocks).toMatchObject([{ kind: 'heading', visibleText: 'Heading' }]);
  });

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

  it('projects nested list items in source order without parent-child overlap', () => {
    const source = '- parent\n  - child\n  - last\n- sibling';
    const projection = buildSourceProjection({
      dialectVersion: 'commonmark-v1',
      filePath: 'Nested lists.md',
      source,
      sourceRevision: 'revision-1',
    });

    expect(projection.blocks.map((block) => block.visibleText)).toEqual([
      'parent',
      'child',
      'last',
      'sibling',
    ]);
    expect(projection.blocks[0]).toMatchObject({
      sourceEnd: source.indexOf('\n'),
      sourceStart: 0,
    });
    expect(projection.blocks[1]).toMatchObject({
      sourceStart: source.indexOf('- child'),
    });
  });

  it('projects every paragraph in a loose list item without claiming its nested child list', () => {
    const source = '- first paragraph\n\n  second paragraph\n\n  - nested child';
    const projection = buildSourceProjection({
      dialectVersion: OBSIDIAN_SOURCE_DIALECT_VERSION,
      filePath: 'Loose list.md',
      source,
      sourceRevision: 'revision-1',
    });

    expect(
      projection.blocks.map((block) => ({
        kind: block.kind,
        visibleText: block.visibleText,
      })),
    ).toEqual([
      { kind: 'list-item', visibleText: 'first paragraph' },
      { kind: 'list-item', visibleText: 'second paragraph' },
      { kind: 'list-item', visibleText: 'nested child' },
    ]);
    expect(projection.blocks[1]!.sourceEnd).toBeLessThanOrEqual(projection.blocks[2]!.sourceStart);
  });

  it('treats GFM task markers as hidden list-item syntax', () => {
    const source = '- [ ] open\n- [x] done';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Tasks.md',
      source,
      sourceRevision: 'revision-1',
    });

    expect(projection.blocks.map((block) => block.visibleText)).toEqual(['open', 'done']);
    expect(
      mapProjectedDisplayRangeToSource({
        block: projection.blocks[1]!,
        displayEnd: 'done'.length,
        displayStart: 0,
        source,
      }),
    ).toEqual({
      end: source.length,
      exact: 'done',
      start: source.indexOf('done'),
    });
  });

  it('maps a Markdown link through its visible label and hides its destination', () => {
    const source = 'Open [the guide](https://example.com/docs) now.';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Links.md',
      source,
      sourceRevision: 'revision-1',
    });
    const paragraph = projection.blocks[0]!;
    const labelStart = paragraph.visibleText.indexOf('the guide');

    expect(paragraph.visibleText).toBe('Open the guide now.');
    expect(
      mapProjectedDisplayRangeToSource({
        block: paragraph,
        displayEnd: labelStart + 'the guide'.length,
        displayStart: labelStart,
        source,
      }),
    ).toEqual({
      end: source.indexOf('the guide') + 'the guide'.length,
      exact: 'the guide',
      start: source.indexOf('the guide'),
    });
  });

  it('maps aliased and unaliased Obsidian wikilinks through their visible labels', () => {
    const source = 'Open [[Vault]] and [[Page|Alias]].';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Wikilinks.md',
      source,
      sourceRevision: 'revision-1',
    });
    const paragraph = projection.blocks[0]!;

    expect(paragraph.visibleText).toBe('Open Vault and Alias.');
    const aliasDisplayStart = paragraph.visibleText.indexOf('Alias');
    expect(
      mapProjectedDisplayRangeToSource({
        block: paragraph,
        displayEnd: aliasDisplayStart + 'Alias'.length,
        displayStart: aliasDisplayStart,
        source,
      }),
    ).toEqual({
      end: source.indexOf('Alias') + 'Alias'.length,
      exact: 'Alias',
      start: source.indexOf('Alias'),
    });
  });

  it('maps Obsidian highlight content while hiding its delimiters', () => {
    const source = 'Keep ==this marked text== selectable.';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Highlight.md',
      source,
      sourceRevision: 'revision-1',
    });
    const paragraph = projection.blocks[0]!;
    const selected = 'this marked text';
    const displayStart = paragraph.visibleText.indexOf(selected);

    expect(paragraph.visibleText).toBe('Keep this marked text selectable.');
    expect(
      mapProjectedDisplayRangeToSource({
        block: paragraph,
        displayEnd: displayStart + selected.length,
        displayStart,
        source,
      }),
    ).toEqual({
      end: source.indexOf(selected) + selected.length,
      exact: selected,
      start: source.indexOf(selected),
    });
  });

  it('hides Obsidian comments and trailing block IDs without rejecting surrounding text', () => {
    const source = 'prefix %%private%% suffix ^stable-id';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Hidden syntax.md',
      source,
      sourceRevision: 'revision-1',
    });
    const paragraph = projection.blocks[0]!;
    const selected = 'suffix';
    const displayStart = paragraph.visibleText.indexOf(selected);

    expect(paragraph.visibleText).toBe('prefix  suffix');
    expect(
      mapProjectedDisplayRangeToSource({
        block: paragraph,
        displayEnd: displayStart + selected.length,
        displayStart,
        source,
      }),
    ).toEqual({
      end: source.indexOf(selected) + selected.length,
      exact: selected,
      start: source.indexOf(selected),
    });
  });

  it('maps Markdown escapes and character references as atomic visible runs', () => {
    const source = 'Escaped \\* and &amp; plus &#x1F600;.';
    const visibleText = 'Escaped * and & plus 😀.';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Entities.md',
      source,
      sourceRevision: 'revision-1',
    });
    const paragraph = projection.blocks[0]!;
    const ampersandDisplay = visibleText.indexOf('&');

    expect(paragraph.visibleText).toBe(visibleText);
    expect(
      mapProjectedDisplayRangeToSource({
        block: paragraph,
        displayEnd: ampersandDisplay + 1,
        displayStart: ampersandDisplay,
        source,
      }),
    ).toEqual({
      end: source.indexOf('&amp;') + '&amp;'.length,
      exact: '&amp;',
      start: source.indexOf('&amp;'),
    });
  });

  it('preserves UTF-16 offsets across CJK, emoji, combining text, bidi text, ZWJ, and CRLF', () => {
    const source = '中文 😀 e\u0301 אבג 👩‍💻\r\nnext &#128512;';
    const visibleText = '中文 😀 e\u0301 אבג 👩‍💻\nnext 😀';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Unicode.md',
      source,
      sourceRevision: 'revision-1',
    });
    const paragraph = projection.blocks[0]!;
    const emoji = '👩‍💻';
    const displayStart = visibleText.indexOf(emoji);
    const sourceStart = source.indexOf(emoji);

    expect(paragraph.visibleText).toBe(visibleText);
    expect(
      mapProjectedDisplayRangeToSource({
        block: paragraph,
        displayEnd: displayStart + emoji.length,
        displayStart,
        source,
      }),
    ).toEqual({
      end: sourceStart + emoji.length,
      exact: emoji,
      start: sourceStart,
    });
  });

  it('hides continuation quote markers in a multiline blockquote', () => {
    const source = '> first line\r\n> second line';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Multiline quote.md',
      source,
      sourceRevision: 'revision-1',
    });

    expect(projection.blocks).toHaveLength(1);
    expect(projection.blocks[0]).toMatchObject({
      kind: 'blockquote',
      visibleText: 'first line\nsecond line',
    });
  });

  it('projects separate blockquote paragraphs as distinct non-overlapping blocks', () => {
    const source = '> first paragraph\n>\n> second paragraph';
    const projection = buildSourceProjection({
      dialectVersion: OBSIDIAN_SOURCE_DIALECT_VERSION,
      filePath: 'Quote paragraphs.md',
      source,
      sourceRevision: 'revision-1',
    });

    expect(projection.blocks.map((block) => block.visibleText)).toEqual([
      'first paragraph',
      'second paragraph',
    ]);
    expect(projection.blocks[0]!.sourceEnd).toBeLessThanOrEqual(projection.blocks[1]!.sourceStart);
  });

  it('projects blockquote text while hiding quote markers', () => {
    const source = '> Quote **text**';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Quote.md',
      source,
      sourceRevision: 'revision-1',
    });
    const quote = projection.blocks[0]!;

    expect(quote).toMatchObject({
      kind: 'blockquote',
      sourceEnd: source.length,
      sourceStart: 0,
      visibleText: 'Quote text',
    });
  });

  it('projects explicit Obsidian callout title and body as separate blocks', () => {
    const source = '> [!NOTE] Explicit **title**\n> Body ==text==\n> continued';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Callout.md',
      source,
      sourceRevision: 'revision-1',
    });

    expect(
      projection.blocks.map((block) => ({
        kind: block.kind,
        visibleText: block.visibleText,
      })),
    ).toEqual([
      { kind: 'callout-title', visibleText: 'Explicit title' },
      { kind: 'callout-body', visibleText: 'Body text\ncontinued' },
    ]);
  });

  it('projects GFM table cells as independently selectable blocks', () => {
    const source = '| Name | Value |\n| --- | --- |\n| Alpha | **One** |';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Table.md',
      source,
      sourceRevision: 'revision-1',
    });

    expect(projection.blocks.map((block) => block.visibleText)).toEqual([
      'Name',
      'Value',
      'Alpha',
      'One',
    ]);
    expect(projection.blocks.every((block) => block.kind === 'table-cell')).toBe(true);
  });

  it('projects fenced code text independently from fences and language metadata', () => {
    const source = '```ts\nconst answer = 42;\n```';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Code.md',
      source,
      sourceRevision: 'revision-1',
    });
    const code = projection.blocks[0]!;

    expect(code).toMatchObject({
      kind: 'code-block',
      visibleText: 'const answer = 42;',
    });
    expect(
      mapProjectedDisplayRangeToSource({
        block: code,
        displayEnd: code.visibleText.length,
        displayStart: 0,
        source,
      }),
    ).toEqual({
      end: source.indexOf('const answer = 42;') + 'const answer = 42;'.length,
      exact: 'const answer = 42;',
      start: source.indexOf('const answer = 42;'),
    });
  });

  it('projects inline and block math as indivisible source-backed atoms', () => {
    const inlineSource = 'Before $x^2$ after';
    const inline = buildSourceProjection({
      dialectVersion: OBSIDIAN_SOURCE_DIALECT_VERSION,
      filePath: 'Inline math.md',
      source: inlineSource,
      sourceRevision: 'revision-1',
    }).blocks[0]!;
    const mathDisplayStart = inline.visibleText.indexOf('x^2');

    expect(inline.visibleText).toBe('Before x^2 after');
    expect(
      mapProjectedDisplayRangeToSource({
        block: inline,
        displayEnd: mathDisplayStart + 'x^2'.length,
        displayStart: mathDisplayStart,
        source: inlineSource,
      }),
    ).toEqual({
      end: inlineSource.indexOf('$x^2$') + '$x^2$'.length,
      exact: '$x^2$',
      start: inlineSource.indexOf('$x^2$'),
    });

    const blockSource = '$$\nx^2 + y^2\n$$';
    const block = buildSourceProjection({
      dialectVersion: OBSIDIAN_SOURCE_DIALECT_VERSION,
      filePath: 'Block math.md',
      source: blockSource,
      sourceRevision: 'revision-1',
    }).blocks[0]!;
    expect(block).toMatchObject({ kind: 'math-block', visibleText: 'x^2 + y^2' });
    expect(
      mapProjectedDisplayRangeToSource({
        block,
        displayEnd: block.visibleText.length,
        displayStart: 0,
        source: blockSource,
      }),
    ).toEqual({ end: blockSource.length, exact: blockSource, start: 0 });
  });

  it('keeps surrounding source-backed text when an embedded note is generated in the same block', () => {
    const source = 'before ![[Other note]] after';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Embed.md',
      source,
      sourceRevision: 'revision-1',
    });

    expect(projection.blocks[0]?.visibleText).toBe('before  after');
  });

  it('keeps text around static raw HTML selectable while its interior stays non-selectable', () => {
    const source = 'before <span>raw</span> after';
    const projection = buildSourceProjection({
      dialectVersion: OBSIDIAN_SOURCE_DIALECT_VERSION,
      filePath: 'Raw HTML.md',
      source,
      sourceRevision: 'revision-1',
    });
    const paragraph = projection.blocks[0]!;
    const rawDisplayStart = paragraph.visibleText.indexOf('raw');
    const afterDisplayStart = paragraph.visibleText.indexOf('after');

    expect(paragraph.visibleText).toBe('before raw after');
    expect(() =>
      mapProjectedDisplayRangeToSource({
        block: paragraph,
        displayEnd: rawDisplayStart + 'raw'.length,
        displayStart: rawDisplayStart,
        source,
      }),
    ).toThrow(/stable source position/u);
    expect(
      mapProjectedDisplayRangeToSource({
        block: paragraph,
        displayEnd: afterDisplayStart + 'after'.length,
        displayStart: afterDisplayStart,
        source,
      }),
    ).toEqual({
      end: source.length,
      exact: 'after',
      start: source.indexOf('after'),
    });
  });
});
