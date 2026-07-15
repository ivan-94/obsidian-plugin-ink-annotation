// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  annotationIdsAtElement,
  cleanupHighlights,
  renderHighlight,
  renderHighlightPlan,
  renderNoteAnchorIndicator,
} from './reading-highlight-renderer';

describe('Reading View highlight renderer', () => {
  it('wraps only intersecting text nodes and restores the original DOM on cleanup', () => {
    const root = document.createElement('section');
    root.innerHTML = '<p>Mutable <em>Markdown</em> keeps <a href="/note">links</a> intact.</p>';
    const originalHtml = root.innerHTML;
    const renderedText = root.textContent ?? '';
    const start = renderedText.indexOf('Markdown');

    const fragments = renderHighlight(root, {
      annotationId: 'annotation-1',
      end: start + 'Markdown'.length,
      start,
      styleId: 'highlight-yellow',
    });

    expect(fragments).toHaveLength(1);
    expect(root.querySelector('em > span.inkstone-text-highlight')?.textContent).toBe('Markdown');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/note');
    expect(root.textContent).toBe(renderedText);

    cleanupHighlights(root);
    expect(root.innerHTML).toBe(originalHtml);
  });

  it('renders a heading range without replacing the heading element', () => {
    const heading = document.createElement('h2');
    heading.innerHTML = 'A <em>resilient</em> anchor';

    renderHighlight(heading, {
      annotationId: 'annotation-heading',
      end: 11,
      start: 2,
      styleId: 'highlight-yellow',
    });

    expect(heading.tagName).toBe('H2');
    expect(heading.querySelector('em > .inkstone-text-highlight')?.textContent).toBe('resilient');
  });

  it('renders overlap fragments without breaking heading semantics and exposes every hit record', () => {
    const heading = document.createElement('h2');
    heading.innerHTML = 'A <em>resilient</em> anchor';
    const originalText = heading.textContent;

    renderHighlightPlan(heading, [
      {
        annotationId: 'wide',
        end: 11,
        kind: 'highlight',
        start: 2,
        styleId: 'sun',
        updatedAt: '2026-07-14T08:00:00.000Z',
      },
      {
        annotationId: 'specific',
        end: 8,
        kind: 'highlight',
        start: 4,
        styleId: 'mint',
        updatedAt: '2026-07-14T08:01:00.000Z',
      },
    ]);

    const overlap = [...heading.querySelectorAll<HTMLElement>('.inkstone-text-highlight')].find(
      (element) => element.dataset.inkstoneAnnotationIds?.includes('specific') === true,
    );
    expect(heading.tagName).toBe('H2');
    expect(heading.querySelector('em')).not.toBeNull();
    expect(heading.textContent).toBe(originalText);
    expect(annotationIdsAtElement(overlap ?? null)).toEqual(['specific', 'wide']);
  });

  it('renders a note-only anchor as a distinct zero-width indicator', () => {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'A selected passage with a note.';
    const originalText = paragraph.textContent;

    const indicator = renderNoteAnchorIndicator(paragraph, {
      annotationId: 'note-only-1',
      offset: 'A selected passage'.length,
    });

    expect(indicator.classList.contains('inkstone-note-anchor')).toBe(true);
    expect(indicator.getAttribute('aria-label')).toBe('Open annotation note');
    expect(annotationIdsAtElement(indicator)).toEqual(['note-only-1']);
    expect(paragraph.textContent).toBe(originalText);
    cleanupHighlights(paragraph);
    expect(paragraph.querySelector('.inkstone-note-anchor')).toBeNull();
    expect(paragraph.textContent).toBe(originalText);
  });
});
