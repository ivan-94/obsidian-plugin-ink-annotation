// @vitest-environment jsdom

import { act } from 'preact/test-utils';
import { useEffect } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createI18n } from '../i18n/create-i18n';
import { useI18n } from '../i18n/locale-context';
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

  it('provides the injected locale to the whole island', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const island = createPreactIsland(LocalizedProbe, { i18n: createI18n('zh') });

    await act(() => island.mount(container, {}));

    expect(container.textContent).toBe('已选择 2 项');
  });
});

function Probe({ cleanup, label }: { readonly cleanup: () => void; readonly label: string }) {
  useEffect(() => cleanup, [cleanup]);
  return <button type="button">{label}</button>;
}

function LocalizedProbe() {
  const i18n = useI18n();
  return <span>{i18n.t('sidebar.selectedCount', { count: 2 })}</span>;
}
