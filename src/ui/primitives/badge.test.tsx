// @vitest-environment jsdom

import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import { createPreactIsland } from '../runtime/mount-preact-island';
import { Badge } from './badge';

describe('Badge', () => {
  afterEach(() => document.body.replaceChildren());

  it('announces a warning count without relying on color alone', async () => {
    const container = document.createElement('div');
    const island = createPreactIsland(Badge);

    await act(() =>
      island.mount(container, { label: 'annotations need repair', tone: 'warning', value: 2 }),
    );

    const badge = container.querySelector('.inkstone-badge');
    expect(badge?.textContent).toBe('2');
    expect(badge?.getAttribute('aria-label')).toBe('2 annotations need repair');
    expect(badge?.classList.contains('inkstone-badge--warning')).toBe(true);

    await act(() => island.unmount());
  });
});
