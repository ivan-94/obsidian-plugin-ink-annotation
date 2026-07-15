import { describe, expect, it } from 'vitest';

import { mapRenderedRangeToSource, mapSourceRangeToRendered } from './rendered-source-map';

describe('rendered Markdown source mapping', () => {
  it('maps a selection inside inline emphasis to UTF-16 source positions', () => {
    const source = '# Intro\n\n## Architecture\n\nMutable **Markdown** needs resilient anchors.';
    const sectionSourceStart = source.indexOf('Mutable');
    const sectionSource = source.slice(sectionSourceStart);
    const renderedText = 'Mutable Markdown needs resilient anchors.';
    const renderedStart = renderedText.indexOf('Markdown');

    const mapped = mapRenderedRangeToSource({
      renderedEnd: renderedStart + 'Markdown'.length,
      renderedStart,
      renderedText,
      sectionSource,
      sectionSourceStart,
    });

    const expectedStart = source.indexOf('Markdown');
    expect(mapped).toEqual({
      end: expectedStart + 'Markdown'.length,
      exact: 'Markdown',
      start: expectedStart,
    });
    expect(source.slice(mapped.start, mapped.end)).toBe(mapped.exact);
  });

  it('maps a persisted source range back to the same rendered characters', () => {
    const sectionSource = 'Mutable **Markdown** needs resilient anchors.';
    const sectionSourceStart = 29;
    const localStart = sectionSource.indexOf('Markdown');

    const rendered = mapSourceRangeToRendered({
      exact: 'Markdown',
      renderedText: 'Mutable Markdown needs resilient anchors.',
      sectionSource,
      sectionSourceStart,
      sourceEnd: sectionSourceStart + localStart + 'Markdown'.length,
      sourceStart: sectionSourceStart + localStart,
    });

    expect(rendered).toEqual({ end: 16, exact: 'Markdown', start: 8 });
  });

  it('locates one paragraph block when Obsidian returns the containing document section', () => {
    const sectionSource =
      '# Fixtures\n\nThis paragraph contains **bold text** and _italic text_.\n\n## Next';
    const renderedText = 'This paragraph contains bold text and italic text.';
    const renderedStart = renderedText.indexOf('bold text');

    const mapped = mapRenderedRangeToSource({
      renderedEnd: renderedStart + 'bold text'.length,
      renderedStart,
      renderedText,
      sectionSource,
      sectionSourceStart: 0,
    });

    expect(mapped.start).toBe(sectionSource.indexOf('bold text'));
    expect(
      mapSourceRangeToRendered({
        exact: mapped.exact,
        renderedText,
        sectionSource,
        sectionSourceStart: 0,
        sourceEnd: mapped.end,
        sourceStart: mapped.start,
      }),
    ).toEqual({
      end: renderedStart + 'bold text'.length,
      exact: 'bold text',
      start: renderedStart,
    });
  });

  it('fails closed when the rendered paragraph matches multiple source blocks', () => {
    expect(() =>
      mapRenderedRangeToSource({
        renderedEnd: 8,
        renderedStart: 0,
        renderedText: 'Repeated paragraph.',
        sectionSource: 'Repeated paragraph.\n\nRepeated paragraph.',
        sectionSourceStart: 0,
      }),
    ).toThrow(/multiple Markdown source blocks/u);
  });

  it.each([
    {
      exact: 'bold',
      rendered: 'Task bold',
      source: '- [ ] Task **bold**',
    },
    {
      exact: 'label',
      rendered: 'Quote label',
      source: '> Quote [label](https://example.com)',
    },
    {
      exact: 'highlighted',
      rendered: 'Callout highlighted',
      source: '> [!NOTE] Callout ==highlighted==',
    },
    {
      exact: 'אבג',
      rendered: '中文 😀 e\u0301 RTL אבג',
      source: '中文 😀 _e\u0301_ RTL ~~אבג~~',
    },
  ])('maps supported first-version Markdown: $source', ({ exact, rendered, source }) => {
    const renderedStart = rendered.indexOf(exact);
    const mapped = mapRenderedRangeToSource({
      renderedEnd: renderedStart + exact.length,
      renderedStart,
      renderedText: rendered,
      sectionSource: source,
      sectionSourceStart: 0,
    });

    expect(mapped.exact).toBe(exact);
    expect(
      mapSourceRangeToRendered({
        exact,
        renderedText: rendered,
        sectionSource: source,
        sectionSourceStart: 0,
        sourceEnd: mapped.end,
        sourceStart: mapped.start,
      }),
    ).toEqual({ end: renderedStart + exact.length, exact, start: renderedStart });
  });
});
