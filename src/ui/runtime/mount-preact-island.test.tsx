// @vitest-environment jsdom

import { act } from 'preact/test-utils';
import { useEffect } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPreactIsland } from './mount-preact-island';

describe('Preact UI island runtime', () => {
  afterEach(() => document.body.replaceChildren());

  it('mounts, updates and unmounts one component without leaving effects or DOM behind', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const cleanup = vi.fn();
    const island = createPreactIsland(Probe);

    await act(() => island.mount(container, { cleanup, label: 'Initial' }));
    expect(container.querySelector('button')?.textContent).toBe('Initial');

    await act(() => island.update({ cleanup, label: 'Updated' }));
    expect(container.querySelector('button')?.textContent).toBe('Updated');
    expect(cleanup).not.toHaveBeenCalled();

    await act(() => island.unmount());
    expect(container.childElementCount).toBe(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

function Probe({ cleanup, label }: { readonly cleanup: () => void; readonly label: string }) {
  useEffect(() => cleanup, [cleanup]);
  return <button type="button">{label}</button>;
}
