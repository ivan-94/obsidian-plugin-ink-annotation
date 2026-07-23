// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { buildSourceProjection } from '../../domain/source-projection';
import { captureReadingSelection } from './reading-selection';
import { bindReadingBlocks, mapReadingSelectionToSource } from './reading-source-projection';

describe('Reading View source projection binding', () => {
  it('binds every item in a tight list to its own parser-backed source block', () => {
    const source = '- first\n- second\n- third';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Lists.md',
      source,
      sourceRevision: 'revision-1',
    });
    const root = document.createElement('section');
    root.innerHTML = '<ul><li>first</li><li>second</li><li>third</li></ul>';
    const result = bindReadingBlocks({
      projection,
      root,
      sectionRange: () => ({ end: source.length, start: 0 }),
    });
    const items = root.querySelectorAll<HTMLElement>('li');

    expect(result.failures).toEqual([]);
    expect(result.bindings.get(items[1]!)).toMatchObject({
      projectedBlock: {
        sourceEnd: source.indexOf('second') + 'second'.length,
        sourceStart: source.indexOf('- second'),
        visibleText: 'second',
      },
      visibleText: 'second',
    });

    const text = items[1]!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 'second'.length);
    const captured = captureReadingSelection(root, range);
    if (!captured.supported) throw new Error(`Selection failed: ${captured.reason}`);

    expect(
      mapReadingSelectionToSource({
        bindings: result.bindings,
        fragments: captured.fragments,
        source,
      }),
    ).toEqual({
      end: source.indexOf('second') + 'second'.length,
      exact: 'second',
      start: source.indexOf('second'),
    });
  });

  it('binds representative supported Obsidian DOM across semantic block kinds', () => {
    const source = [
      '# Heading',
      '',
      '- [ ] Task **one**',
      '  - child',
      '',
      '> Quote [label](https://example.com)',
      '',
      '> [!NOTE] Explicit **title**',
      '> Body ==text==',
      '> continued',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | One |',
      '',
      '`inline` and [[Page]] / [[Target|Alias]]',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Supported matrix.md',
      source,
      sourceRevision: 'revision-1',
    });
    const root = document.createElement('section');
    root.innerHTML = [
      '<h1>Heading</h1>',
      '<ul><li class="task-list-item"><input type="checkbox">Task <strong>one</strong><ul><li>child</li></ul></li></ul>',
      '<blockquote><p>Quote <a href="https://example.com">label</a></p></blockquote>',
      '<div class="callout"><div class="callout-title"><div class="callout-title-inner">Explicit <strong>title</strong></div></div><div class="callout-content"><p>Body <mark>text</mark>\ncontinued</p></div></div>',
      '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Alpha</td><td>One</td></tr></tbody></table>',
      '<p><code>inline</code> and <a class="internal-link">Page</a> / <a class="internal-link">Alias</a></p>',
      '<pre><code><span class="token keyword">const</span> x = 1;</code></pre>',
    ].join('');

    const result = bindReadingBlocks({
      projection,
      root,
      sectionRange: () => ({ end: source.length, start: 0 }),
    });

    expect(result.failures).toEqual([]);
    expect([...result.bindings.values()].map(({ projectedBlock }) => projectedBlock.kind)).toEqual([
      'heading',
      'list-item',
      'list-item',
      'blockquote',
      'callout-title',
      'callout-body',
      'table-cell',
      'table-cell',
      'table-cell',
      'table-cell',
      'paragraph',
      'code-block',
    ]);
  });

  it('keeps surrounding blocks bindable when one rendered block has no source-compatible form', () => {
    const source = ['before', '', '```txt', 'source code', '```', '', 'after'].join('\n');
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Postprocessed block.md',
      source,
      sourceRevision: 'revision-1',
    });
    const root = document.createElement('section');
    root.innerHTML = '<p>before</p><pre><code>rendered by another plugin</code></pre><p>after</p>';

    const result = bindReadingBlocks({
      projection,
      root,
      sectionRange: () => ({ end: source.length, start: 0 }),
    });

    expect([...result.bindings.values()].map(({ visibleText }) => visibleText)).toEqual([
      'before',
      'after',
    ]);
    expect(result.failures).toMatchObject([
      {
        code: 'source-target-not-found',
        visibleText: 'rendered by another plugin',
      },
    ]);
  });

  it('reserves ambiguous for two surviving candidates and rejects generated blocks explicitly', () => {
    const source = 'same text\n\nsame text';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Ambiguous.md',
      source,
      sourceRevision: 'revision-1',
    });
    const ambiguousRoot = document.createElement('section');
    ambiguousRoot.innerHTML = '<p>same text</p>';
    const ambiguous = bindReadingBlocks({
      projection,
      root: ambiguousRoot,
      sectionRange: () => null,
    });

    expect(ambiguous.bindings.size).toBe(0);
    expect(ambiguous.failures).toMatchObject([{ code: 'source-target-ambiguous' }]);

    const generatedRoot = document.createElement('section');
    generatedRoot.innerHTML = '<div class="dataview"><p>same text</p></div>';
    const generated = bindReadingBlocks({
      projection,
      root: generatedRoot,
      sectionRange: () => null,
    });
    expect(generated.bindings.size).toBe(0);
    expect(generated.failures).toMatchObject([{ code: 'generated-content' }]);
  });

  it('binds loose-list paragraphs and nested items as separately owned blocks', () => {
    const source = '- first paragraph\n\n  second paragraph\n\n  - nested child';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Loose list.md',
      source,
      sourceRevision: 'revision-1',
    });
    const root = document.createElement('section');
    root.innerHTML =
      '<ul><li><p>first paragraph</p><p>second paragraph</p><ul><li>nested child</li></ul></li></ul>';
    const result = bindReadingBlocks({
      projection,
      root,
      sectionRange: () => ({ end: source.length, start: 0 }),
    });

    expect(result.failures).toEqual([]);
    expect([...result.bindings.values()].map(({ visibleText }) => visibleText)).toEqual([
      'first paragraph',
      'second paragraph',
      'nested child',
    ]);
  });

  it('binds separate paragraphs owned by one blockquote', () => {
    const source = '> first paragraph\n>\n> second paragraph';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Quote paragraphs.md',
      source,
      sourceRevision: 'revision-1',
    });
    const root = document.createElement('blockquote');
    root.innerHTML = '<p>first paragraph</p><p>second paragraph</p>';
    const result = bindReadingBlocks({
      projection,
      root,
      sectionRange: () => ({ end: source.length, start: 0 }),
    });

    expect(result.failures).toEqual([]);
    expect([...result.bindings.values()].map(({ visibleText }) => visibleText)).toEqual([
      'first paragraph',
      'second paragraph',
    ]);
  });

  it('binds raw HTML but rejects an endpoint inside the unsupported HTML region', () => {
    const source = 'before <span>raw</span> after';
    const projection = buildSourceProjection({
      dialectVersion: 'obsidian-gfm-v1',
      filePath: 'Raw HTML.md',
      source,
      sourceRevision: 'revision-1',
    });
    const root = document.createElement('section');
    root.innerHTML = '<p>before <span>raw</span> after</p>';
    const result = bindReadingBlocks({
      projection,
      root,
      sectionRange: () => ({ end: source.length, start: 0 }),
    });
    const raw = root.querySelector('span')?.firstChild;
    if (!(raw instanceof Text)) throw new Error('Raw HTML fixture is missing text.');
    const range = document.createRange();
    range.selectNodeContents(raw);
    const captured = captureReadingSelection(root, range);
    if (!captured.supported) throw new Error(`Selection failed early: ${captured.reason}`);

    expect(() =>
      mapReadingSelectionToSource({
        bindings: result.bindings,
        fragments: captured.fragments,
        source,
      }),
    ).toThrow(expect.objectContaining({ code: 'unsupported-syntax' }));
  });
});
