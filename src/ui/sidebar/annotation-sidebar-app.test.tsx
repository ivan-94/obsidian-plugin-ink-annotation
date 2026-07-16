// @vitest-environment jsdom

import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPreactIsland } from '../runtime/mount-preact-island';
import { AnnotationSidebarStore } from '../stores/annotation-sidebar-store';
import { AnnotationSidebarApp } from './annotation-sidebar-app';

describe('AnnotationSidebarApp', () => {
  afterEach(() => document.body.replaceChildren());

  it('keeps one shell and content host while switching the active scope', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const store = new AnnotationSidebarStore();
    const changed: string[] = [];
    const currentHosts: Array<HTMLElement | null> = [];
    const vaultHosts: Array<HTMLElement | null> = [];
    const currentActionHosts: Array<HTMLElement | null> = [];
    const vaultActionHosts: Array<HTMLElement | null> = [];
    const island = createPreactIsland(AnnotationSidebarApp);

    await act(() =>
      island.mount(container, {
        onCurrentContentMount: (host) => currentHosts.push(host),
        onCurrentHeaderActionsMount: (host) => currentActionHosts.push(host),
        onScopeChange: (scope) => changed.push(scope),
        onVaultContentMount: (host) => vaultHosts.push(host),
        onVaultHeaderActionsMount: (host) => vaultActionHosts.push(host),
        store,
      }),
    );
    const contentHost = container.querySelector<HTMLElement>('[data-inkstone-sidebar-content]');
    const currentHost = container.querySelector<HTMLElement>(
      '[data-inkstone-sidebar-scope-content="current-file"]',
    );
    const vaultHost = container.querySelector<HTMLElement>(
      '[data-inkstone-sidebar-scope-content="entire-vault"]',
    );
    expect(contentHost).not.toBeNull();
    expect(currentHost?.hidden).toBe(false);
    expect(vaultHost?.hidden).toBe(true);
    expect(activeScope(container)).toBe('Current file');
    const scopeTabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(scopeTabs[0]?.getAttribute('aria-label')).toBe('Current file');
    expect(scopeTabs[0]?.querySelector('[data-inkstone-icon="file-text"]')).not.toBeNull();
    expect(scopeTabs[1]?.getAttribute('aria-label')).toBe('Entire Vault');
    expect(scopeTabs[1]?.querySelector('[data-inkstone-icon="library"]')).not.toBeNull();
    expect(scopeTabs[0]?.querySelector('.inkstone-sidebar__scope-label')?.textContent).toBe(
      'Current file',
    );

    await act(() => clickScope(container, 'Entire Vault'));
    expect(store.scope.value).toBe('entire-vault');
    expect(activeScope(container)).toBe('Entire Vault');
    expect(container.querySelector('[data-inkstone-sidebar-content]')).toBe(contentHost);
    expect(container.querySelector('[data-inkstone-sidebar-scope-content="current-file"]')).toBe(
      currentHost,
    );
    expect(container.querySelector('[data-inkstone-sidebar-scope-content="entire-vault"]')).toBe(
      vaultHost,
    );
    expect(currentHost?.hidden).toBe(true);
    expect(vaultHost?.hidden).toBe(false);

    await act(() => clickScope(container, 'Current file'));
    expect(store.scope.value).toBe('current-file');
    expect(activeScope(container)).toBe('Current file');
    expect(changed).toEqual(['entire-vault', 'current-file']);

    await act(() => island.unmount());
    expect(currentHosts.at(-1)).toBeNull();
    expect(vaultHosts.at(-1)).toBeNull();
    expect(currentActionHosts.at(-1)).toBeNull();
    expect(vaultActionHosts.at(-1)).toBeNull();
  });

  it('renders the Current file empty state from the long-lived Store', async () => {
    const container = document.createElement('div');
    const store = new AnnotationSidebarStore();
    store.current.status.value = 'ready';
    const island = createPreactIsland(AnnotationSidebarApp);

    await act(() =>
      island.mount(container, {
        onCurrentContentMount: () => undefined,
        onCurrentHeaderActionsMount: () => undefined,
        onScopeChange: () => undefined,
        onVaultContentMount: () => undefined,
        onVaultHeaderActionsMount: () => undefined,
        store,
      }),
    );

    expect(container.textContent).toContain('No annotations yet');
    expect(
      container
        .querySelector('.inkstone-empty-state')
        ?.parentElement?.classList.contains('inkstone-sidebar__empty'),
    ).toBe(true);
    expect(container.querySelector('[data-inkstone-sidebar-content]')?.hasAttribute('hidden')).toBe(
      true,
    );

    await act(() => island.unmount());
  });

  it('keeps the Vault content and search controls mounted when a query has no matches', async () => {
    const container = document.createElement('div');
    const store = new AnnotationSidebarStore();
    store.scope.value = 'entire-vault';
    store.vault.status.value = 'ready';
    store.vault.queryResult.value = {
      groups: [],
      state: 'no-matches',
      total: 0,
    };
    const island = createPreactIsland(AnnotationSidebarApp);

    await act(() =>
      island.mount(container, {
        onCurrentContentMount: () => undefined,
        onCurrentHeaderActionsMount: () => undefined,
        onScopeChange: () => undefined,
        onVaultContentMount: () => undefined,
        onVaultHeaderActionsMount: () => undefined,
        store,
      }),
    );

    expect(container.querySelector('[data-inkstone-sidebar-content]')?.hasAttribute('hidden')).toBe(
      false,
    );
    expect(
      container
        .querySelector('[data-inkstone-sidebar-scope-content="entire-vault"]')
        ?.hasAttribute('hidden'),
    ).toBe(false);
    expect(container.querySelector('.inkstone-sidebar__empty')).toBeNull();

    await act(() => island.unmount());
  });

  it('keeps a Current file read failure visible and retryable', async () => {
    const container = document.createElement('div');
    const retry = vi.fn();
    const store = new AnnotationSidebarStore();
    store.current.status.value = 'error';
    const island = createPreactIsland(AnnotationSidebarApp);

    await act(() =>
      island.mount(container, {
        onCurrentContentMount: () => undefined,
        onCurrentHeaderActionsMount: () => undefined,
        onRetryCurrent: retry,
        onScopeChange: () => undefined,
        onVaultContentMount: () => undefined,
        onVaultHeaderActionsMount: () => undefined,
        store,
      }),
    );

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't read annotations locally.",
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Retry annotations"]')?.click();
    expect(retry).toHaveBeenCalledTimes(1);

    await act(() => island.unmount());
  });
});

function activeScope(container: HTMLElement): string | undefined {
  return container.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? undefined;
}

function clickScope(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`Missing scope: ${label}`);
  button.click();
}
