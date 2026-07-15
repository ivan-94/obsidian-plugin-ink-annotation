// @vitest-environment jsdom

import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPreactIsland } from '../runtime/mount-preact-island';
import { StatusBanner } from './status-banner';

describe('StatusBanner', () => {
  afterEach(() => document.body.replaceChildren());

  it('keeps an error visible and exposes a named retry action', async () => {
    const container = document.createElement('div');
    const retry = vi.fn();
    const island = createPreactIsland(StatusBanner);

    await act(() =>
      island.mount(container, {
        action: { label: 'Retry local read', onSelect: retry },
        kind: 'error',
        message: "Couldn't read annotations locally.",
      }),
    );

    const banner = container.querySelector('.inkstone-status-banner');
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.textContent).toContain("Couldn't read annotations locally.");
    expect(banner?.querySelector('svg')?.getAttribute('data-icon')).toBe('circle-alert');
    banner?.querySelector<HTMLButtonElement>('button[aria-label="Retry local read"]')?.click();
    expect(retry).toHaveBeenCalledTimes(1);

    await act(() => island.unmount());
  });
});
