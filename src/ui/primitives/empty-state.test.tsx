// @vitest-environment jsdom

import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPreactIsland } from '../runtime/mount-preact-island';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  afterEach(() => document.body.replaceChildren());

  it('presents an explanation and an optional named recovery action', async () => {
    const container = document.createElement('div');
    const retry = vi.fn();
    const island = createPreactIsland(EmptyState);

    await act(() =>
      island.mount(container, {
        action: { icon: 'refresh-cw', label: 'Retry annotations', onSelect: retry },
        description: "Annotation files aren't available locally yet.",
        icon: 'cloud-off',
        title: 'Annotations unavailable',
      }),
    );

    expect(container.querySelector('h3')?.textContent).toBe('Annotations unavailable');
    expect(container.querySelector('p')?.textContent).toBe(
      "Annotation files aren't available locally yet.",
    );
    expect(container.querySelector('svg')?.getAttribute('data-icon')).toBe('cloud-off');
    container.querySelector<HTMLButtonElement>('button[aria-label="Retry annotations"]')?.click();
    expect(retry).toHaveBeenCalledTimes(1);

    await act(() => island.unmount());
  });
});
