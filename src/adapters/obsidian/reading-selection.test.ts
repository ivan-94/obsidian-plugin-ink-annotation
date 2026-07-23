// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { captureReadingSelection } from './reading-selection';

describe('Reading View selection capture', () => {
  it('captures UTF-16 offsets inside one supported rendered block without retaining the Range', () => {
    const root = document.createElement('section');
    root.innerHTML = '<p>Mutable <em>Markdown</em> remains readable.</p>';
    const emphasis = root.querySelector('em');
    const textNode = emphasis?.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error('Fixture did not create an emphasis text node.');
    }
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.length);

    const captured = captureReadingSelection(root, range);

    expect(captured).toMatchObject({
      exact: 'Markdown',
      renderedEnd: 16,
      renderedStart: 8,
      supported: true,
    });
    if (captured.supported) {
      expect(captured.block.tagName).toBe('P');
      expect('range' in captured).toBe(false);
    }
  });

  it('ignores a zero-width endpoint in the next block', () => {
    const root = document.createElement('section');
    root.innerHTML =
      '<p>This paragraph contains <strong>bold</strong>, <em>italic</em>, <mark>highlighted</mark>, and <del>struck</del> text.</p><h2>Next section</h2>';
    const paragraph = root.querySelector('p');
    const first = paragraph?.firstChild;
    const next = root.querySelector('h2')?.firstChild;
    if (
      !(paragraph instanceof HTMLElement) ||
      !(first instanceof Text) ||
      !(next instanceof Text)
    ) {
      throw new Error('Boundary fixture is malformed.');
    }
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(next, 0);

    const captured = captureReadingSelection(root, range);

    expect(captured).toMatchObject({
      block: paragraph,
      endBlock: paragraph,
      exact: paragraph.textContent,
      fragments: [
        {
          block: paragraph,
          renderedEnd: paragraph.textContent.length,
          renderedStart: 0,
        },
      ],
      supported: true,
    });
  });

  it('does not reject a selection for zero-width restricted content at its boundary', () => {
    const root = document.createElement('section');
    root.innerHTML = '<p>Visible paragraph.</p><pre><code>restricted()</code></pre>';
    const paragraph = root.querySelector('p');
    const first = paragraph?.firstChild;
    const restricted = root.querySelector('code')?.firstChild;
    if (
      !(paragraph instanceof HTMLElement) ||
      !(first instanceof Text) ||
      !(restricted instanceof Text)
    ) {
      throw new Error('Restricted boundary fixture is malformed.');
    }
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(restricted, 0);

    expect(captureReadingSelection(root, range)).toMatchObject({
      block: paragraph,
      endBlock: paragraph,
      exact: 'Visible paragraph.',
      supported: true,
    });
  });

  it('captures a task-list label as one supported block', () => {
    const root = document.createElement('section');
    root.innerHTML =
      '<ul><li class="task-list-item"><input type="checkbox">Task <strong>label</strong></li></ul>';
    const textNode = root.querySelector('strong')?.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error('Fixture task label is missing.');
    }
    const range = document.createRange();
    range.selectNodeContents(textNode);

    const captured = captureReadingSelection(root, range);

    expect(captured).toMatchObject({ exact: 'label', supported: true });
    if (captured.supported) {
      expect(captured.block.tagName).toBe('LI');
    }
  });

  it('supports monotonic cross-kind selections and fails closed across generated content', () => {
    const root = document.createElement('section');
    root.innerHTML =
      '<p>First paragraph.</p><p>Second paragraph.</p><ul><li>List item.</li></ul><div class="dataview"><p>Generated value</p></div><p>After generated.</p>';
    const paragraphs = root.querySelectorAll('p');
    const firstText = paragraphs[0]?.firstChild;
    const secondText = paragraphs[1]?.firstChild;
    const listText = root.querySelector('li')?.firstChild;
    const generatedText = root.querySelector('.dataview p')?.firstChild;
    const afterGeneratedText = paragraphs[3]?.firstChild;
    if (
      !(firstText instanceof Text) ||
      !(secondText instanceof Text) ||
      !(listText instanceof Text) ||
      !(generatedText instanceof Text) ||
      !(afterGeneratedText instanceof Text)
    ) {
      throw new Error('Fixture text nodes are missing.');
    }

    const collapsed = document.createRange();
    collapsed.setStart(firstText, 2);
    collapsed.collapse(true);
    expect(captureReadingSelection(root, collapsed)).toEqual({
      reason: 'empty',
      supported: false,
    });

    const crossBlock = document.createRange();
    crossBlock.setStart(firstText, 6);
    crossBlock.setEnd(secondText, 6);
    expect(captureReadingSelection(root, crossBlock)).toMatchObject({
      block: paragraphs[0],
      endBlock: paragraphs[1],
      renderedEnd: 6,
      renderedStart: 6,
      supported: true,
    });

    const complexCrossBlock = document.createRange();
    complexCrossBlock.setStart(secondText, 0);
    complexCrossBlock.setEnd(listText, 4);
    expect(captureReadingSelection(root, complexCrossBlock)).toMatchObject({
      block: paragraphs[1],
      endBlock: root.querySelector('li'),
      supported: true,
    });

    const acrossGenerated = document.createRange();
    acrossGenerated.setStart(secondText, 0);
    acrossGenerated.setEnd(afterGeneratedText, 5);
    expect(captureReadingSelection(root, acrossGenerated)).toEqual({
      reason: 'generated-content',
      supported: false,
    });

    const generated = document.createRange();
    generated.selectNodeContents(generatedText);
    expect(captureReadingSelection(root, generated)).toEqual({
      reason: 'generated-content',
      supported: false,
    });
  });

  it('ignores Obsidian wrapper whitespace between source-backed blocks', () => {
    const root = document.createElement('section');
    root.innerHTML = [
      '<div class="el-p"><p>Paragraph text.</p></div>',
      '\n',
      '<div class="el-ul"><ul>\n<li>List item.</li>\n</ul></div>',
    ].join('');
    const paragraph = root.querySelector('p');
    const listItem = root.querySelector('li');
    const paragraphText = paragraph?.firstChild;
    const listText = listItem?.firstChild;
    if (
      !(paragraph instanceof HTMLElement) ||
      !(listItem instanceof HTMLElement) ||
      !(paragraphText instanceof Text) ||
      !(listText instanceof Text)
    ) {
      throw new Error('Wrapper-whitespace fixture is malformed.');
    }
    const range = document.createRange();
    range.setStart(paragraphText, 0);
    range.setEnd(listText, listText.data.length);

    expect(captureReadingSelection(root, range)).toMatchObject({
      block: paragraph,
      endBlock: listItem,
      fragments: [
        {
          block: paragraph,
          renderedEnd: paragraphText.data.length,
          renderedStart: 0,
        },
        {
          block: listItem,
          renderedEnd: listText.data.length,
          renderedStart: 0,
        },
      ],
      supported: true,
    });
  });

  it('captures inline and fenced code as source-backed blocks', () => {
    const root = document.createElement('section');
    root.innerHTML = '<p>before <code>inline code</code> after</p><pre><code>fenced()</code></pre>';
    const inline = root.querySelector('p code')?.firstChild;
    const fenced = root.querySelector('pre code')?.firstChild;
    if (!(inline instanceof Text) || !(fenced instanceof Text)) {
      throw new Error('Code fixture has no text nodes.');
    }
    const inlineRange = document.createRange();
    inlineRange.selectNodeContents(inline);
    const fencedRange = document.createRange();
    fencedRange.selectNodeContents(fenced);

    expect(captureReadingSelection(root, inlineRange)).toMatchObject({
      exact: 'inline code',
      supported: true,
    });
    expect(captureReadingSelection(root, fencedRange)).toMatchObject({
      block: root.querySelector('pre'),
      exact: 'fenced()',
      supported: true,
    });
  });

  it('rejects a MathJax element endpoint even when the rendered glyph has no text node', () => {
    const root = document.createElement('section');
    root.innerHTML =
      '<p>before <span class="math math-inline"><mjx-container><mjx-math><mjx-msup></mjx-msup></mjx-math></mjx-container></span>.</p>';
    const mathEndpoint = root.querySelector('mjx-msup');
    const trailing = root.querySelector('p')?.lastChild;
    if (!(mathEndpoint instanceof HTMLElement) || !(trailing instanceof Text)) {
      throw new Error('MathJax endpoint fixture is malformed.');
    }
    const range = document.createRange();
    range.setStart(mathEndpoint, 0);
    range.setEnd(trailing, trailing.data.length);

    expect(captureReadingSelection(root, range)).toEqual({
      reason: 'math-content',
      supported: false,
    });
  });

  it.each([
    { html: '<div class="math"><p>rendered math</p></div>', reason: 'math-content', selector: 'p' },
    {
      html: '<div class="internal-embed"><p>embedded note</p></div>',
      reason: 'embedded-content',
      selector: 'p',
    },
    {
      html: '<div class="mermaid"><p>generated graph</p></div>',
      reason: 'generated-content',
      selector: 'p',
    },
  ] as const)('returns $reason for restricted DOM', ({ html, reason, selector }) => {
    const root = document.createElement('section');
    root.innerHTML = html;
    const textNode = root.querySelector(selector)?.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error('Restricted fixture has no text node.');
    }
    const range = document.createRange();
    range.selectNodeContents(textNode);

    expect(captureReadingSelection(root, range)).toEqual({ reason, supported: false });
  });
});
