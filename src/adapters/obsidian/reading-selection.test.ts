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

  it('supports simple same-kind cross-block selections and fails closed for complex combinations', () => {
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
    expect(captureReadingSelection(root, complexCrossBlock)).toEqual({
      reason: 'cross-block',
      supported: false,
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

  it.each([
    { html: '<p><code>inline code</code></p>', reason: 'code-content', selector: 'code' },
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
