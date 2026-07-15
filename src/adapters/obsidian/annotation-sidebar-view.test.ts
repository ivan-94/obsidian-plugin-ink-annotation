// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { VaultAnnotationIndex } from '../../domain/vault-annotation-index';
import { AnnotationSidebarView } from './annotation-sidebar-view';

vi.mock('obsidian', () => ({
  ItemView: class {
    readonly contentEl: HTMLElement;

    constructor(leaf: { readonly contentEl?: HTMLElement }) {
      this.contentEl = leaf.contentEl ?? document.createElement('div');
    }
  },
  setIcon: () => undefined,
  setTooltip: () => undefined,
}));

describe('Annotation sidebar scope switching', () => {
  afterEach(() => document.body.replaceChildren());

  it('reuses a fresh Vault index instead of rebuilding on every scope switch', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const index = new VaultAnnotationIndex();
    const restoreCached = vi.fn(() => {
      index.rebuild([]);
      return Promise.resolve(0);
    });
    const rebuild = vi.fn(() => Promise.resolve({ indexed: 0, issues: [] }));
    const listCurrentFile = vi.fn(() =>
      Promise.resolve({
        conflicts: [],
        issues: [],
        model: { groups: [], total: 0 },
      }),
    );
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      getCurrentFilePath: () => 'Note.md',
      inkRepository: { listSurfaceSummaries: () => Promise.resolve([]) } as never,
      inspectAnnotation: () => undefined,
      navigateToAnnotation: () => true,
      navigateToVaultAnnotation: () => undefined,
      onBulkDeleteInk: () => Promise.resolve({ failed: [] }),
      onDeleteAnnotation: () => Promise.resolve(),
      onDeleteInk: () => Promise.resolve(),
      onEditInk: () => undefined,
      onExportCurrentFile: () => undefined,
      onExportInkPng: () => Promise.resolve(),
      onExportInkReport: () => Promise.resolve(),
      onExportInkSvg: () => Promise.resolve(),
      onExportVaultEntries: () => undefined,
      onNavigateInk: () => undefined,
      onRepairInkConflict: () => Promise.resolve(),
      onRestoreInk: () => Promise.resolve(),
      onRestoreAnnotation: () => Promise.resolve(),
      service: { listCurrentFile } as never,
      stylePresets: [],
      vaultIndex: index,
      vaultIndexBuilder: { rebuild, restoreCached } as never,
    });
    await view.onOpen();

    clickScope(container, 'Entire Vault');
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    clickScope(container, 'Current file');
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe('Current file'),
    );
    clickScope(container, 'Entire Vault');
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe('Entire Vault'),
    );

    expect(restoreCached).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(listCurrentFile).toHaveBeenCalledTimes(2);
  });
});

function clickScope(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`Missing scope button: ${label}`);
  button.click();
}
