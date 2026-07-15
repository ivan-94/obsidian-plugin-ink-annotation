// @vitest-environment jsdom

import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPreactIsland } from '../runtime/mount-preact-island';
import { IconButton } from './icon-button';

describe('Preact IconButton', () => {
  afterEach(() => document.body.replaceChildren());

  it('renders and updates an Obsidian icon in the island owner document', async () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const ownerDocument = iframe.contentDocument;
    if (ownerDocument === null) throw new Error('Missing iframe document.');
    const container = ownerDocument.createElement('div');
    ownerDocument.body.append(container);
    const onClick = vi.fn();
    const island = createPreactIsland(IconButton);

    await act(() =>
      island.mount(container, {
        icon: 'search',
        label: 'Search annotations',
        onClick,
      }),
    );
    const button = container.querySelector<HTMLButtonElement>('button');
    const initialIcon = button?.querySelector('svg');
    expect(button?.getAttribute('aria-label')).toBe('Search annotations');
    expect(button?.title).toBe('Search annotations');
    expect(initialIcon?.getAttribute('data-icon')).toBe('search');
    expect(initialIcon?.ownerDocument).toBe(ownerDocument);
    button?.click();
    expect(onClick).toHaveBeenCalledTimes(1);

    await act(() =>
      island.update({
        busy: true,
        danger: true,
        icon: 'trash-2',
        label: 'Delete annotation',
        onClick,
        pressed: true,
      }),
    );
    expect(button?.querySelectorAll('svg')).toHaveLength(1);
    expect(button?.querySelector('svg')?.getAttribute('data-icon')).toBe('trash-2');
    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.classList.contains('inkstone-icon-button--danger')).toBe(true);

    await act(() => island.unmount());
  });
});
