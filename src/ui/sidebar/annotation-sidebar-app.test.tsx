// @vitest-environment jsdom

import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPreactIsland } from '../runtime/mount-preact-island';
import { AnnotationSidebarStore } from '../stores/annotation-sidebar-store';
import { AnnotationSidebarApp } from './annotation-sidebar-app';

describe('AnnotationSidebarApp', () => {
  afterEach(() => document.body.replaceChildren());

  it('renders initial loading as a compact list skeleton instead of a stretched status banner', async () => {
    const container = document.createElement('div');
    const store = new AnnotationSidebarStore();
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

    const loading = container.querySelector('[aria-label="Loading annotations"]');
    expect(loading?.classList.contains('inkstone-sidebar__loading')).toBe(true);
    expect(loading?.getAttribute('role')).toBe('status');
    expect(loading?.textContent).toContain('Loading annotations…');
    expect(loading?.querySelectorAll('.inkstone-sidebar__loading-row')).toHaveLength(3);
    expect(container.querySelector('.inkstone-status-banner')).toBeNull();

    await act(() => island.unmount());
  });

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

  it('keeps a recent deletion Restore action visible while switching sidebar scopes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T04:00:00.000Z'));
    const container = document.createElement('div');
    const restore = vi.fn();
    const store = new AnnotationSidebarStore();
    store.current.status.value = 'ready';
    store.vault.status.value = 'ready';
    store.recentDeletion.value = {
      count: 3,
      error: null,
      expiresAt: Date.now() + 5_000,
      pending: false,
    };
    const island = createPreactIsland(AnnotationSidebarApp);

    await act(() =>
      island.mount(container, {
        onCurrentContentMount: () => undefined,
        onCurrentHeaderActionsMount: () => undefined,
        onRestoreRecentDeletion: restore,
        onScopeChange: () => undefined,
        onVaultContentMount: () => undefined,
        onVaultHeaderActionsMount: () => undefined,
        store,
      }),
    );

    const banner = container.querySelector('[data-inkstone-recent-deletion]');
    expect(banner?.textContent).toContain('3 annotations deleted');
    banner
      ?.querySelector<HTMLButtonElement>('button[aria-label="Restore deleted annotations"]')
      ?.click();
    expect(restore).toHaveBeenCalledTimes(1);

    await act(() => clickScope(container, 'Entire Vault'));
    expect(container.querySelector('[data-inkstone-recent-deletion]')).toBe(banner);
    expect(container.textContent).toContain('3 annotations deleted');

    await act(() => island.unmount());
    vi.useRealTimers();
  });

  it('expires a recent deletion receipt after its Restore window closes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T04:00:00.000Z'));
    const container = document.createElement('div');
    const store = new AnnotationSidebarStore();
    store.current.status.value = 'ready';
    store.recentDeletion.value = {
      count: 1,
      error: null,
      expiresAt: Date.now() + 5_000,
      pending: false,
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
    expect(container.textContent).toContain('1 annotation deleted');

    await act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(store.recentDeletion.value).toBeNull();
    expect(container.querySelector('[data-inkstone-recent-deletion]')).toBeNull();

    await act(() => island.unmount());
    vi.useRealTimers();
  });

  it('disables repeat Restore requests while a recent deletion is restoring', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T04:00:00.000Z'));
    const container = document.createElement('div');
    const store = new AnnotationSidebarStore();
    store.current.status.value = 'ready';
    store.recentDeletion.value = {
      count: 2,
      error: null,
      expiresAt: Date.now() + 5_000,
      pending: true,
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

    const restore = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Restore deleted annotations"]',
    );
    expect(restore?.disabled).toBe(true);
    expect(restore?.textContent).toBe('Restoring…');

    await act(() => island.unmount());
    vi.useRealTimers();
  });

  it('keeps a failed recent deletion Restore visible and retryable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T04:00:00.000Z'));
    const container = document.createElement('div');
    const store = new AnnotationSidebarStore();
    store.current.status.value = 'ready';
    store.recentDeletion.value = {
      count: 2,
      error: "Couldn't restore annotations locally.",
      expiresAt: Date.now() + 5_000,
      pending: false,
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

    expect(container.querySelector('[data-inkstone-recent-deletion]')).not.toBeNull();
    expect(container.querySelector('[data-inkstone-recent-deletion-error]')?.textContent).toBe(
      "Couldn't restore annotations locally.",
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Restore deleted annotations"]')
        ?.disabled,
    ).toBe(false);

    await act(() => island.unmount());
    vi.useRealTimers();
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
