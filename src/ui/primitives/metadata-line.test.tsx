// @vitest-environment jsdom

import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { createPreactIsland } from '../runtime/mount-preact-island';
import { MetadataLine } from './metadata-line';

describe('MetadataLine', () => {
  afterEach(() => document.body.replaceChildren());

  it('renders ordered metadata with one accessible label and warning semantics', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const island = createPreactIsland(MetadataLine);

    await act(() =>
      island.mount(container, {
        tokens: [
          { kind: 'type', label: 'Highlight' },
          { kind: 'tag', label: '#review' },
          { kind: 'status', label: 'Unanchored', tone: 'warning' },
        ],
      }),
    );

    const line = container.querySelector('.inkstone-metadata-line');
    expect(line?.getAttribute('aria-label')).toBe('Highlight · #review · Unanchored');
    expect(
      [...(line?.querySelectorAll('.inkstone-metadata-line__token') ?? [])].map(
        (token) => token.textContent,
      ),
    ).toEqual(['Highlight', '#review', 'Unanchored']);
    expect(line?.querySelector('.inkstone-metadata-line__token--warning')?.textContent).toBe(
      'Unanchored',
    );

    await act(() => island.unmount());
  });
});
