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

  it('keeps one shell while reusing a fresh Vault index across scope switches', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const index = new VaultAnnotationIndex();
    const restoreCached = vi.fn(() => {
      index.rebuild([]);
      return Promise.resolve(0);
    });
    let resolveRebuild: (() => void) | undefined;
    const rebuild = vi.fn(
      (input: { readonly signal: AbortSignal }) =>
        new Promise<{ indexed: number; issues: never[] }>((resolve) => {
          resolveRebuild = () => resolve({ indexed: 0, issues: [] });
          expect(input.signal.aborted).toBe(false);
        }),
    );
    const listCurrentFile = vi.fn(() =>
      Promise.resolve({
        conflicts: [],
        issues: [],
        model: { groups: [], total: 0 },
      }),
    );
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      commands: {
        bulkDeleteInk: () => Promise.resolve({ failed: [] }),
        deleteAnnotation: () => Promise.resolve(),
        deleteInk: () => Promise.resolve(),
        editInk: () => undefined,
        exportCurrentFile: () => undefined,
        exportInkPng: () => Promise.resolve(),
        exportInkReport: () => Promise.resolve(),
        exportInkSvg: () => Promise.resolve(),
        exportVaultEntries: () => undefined,
        getCurrentFilePath: () => 'Note.md',
        inspectAnnotation: () => undefined,
        navigateToAnnotation: () => true,
        navigateToInk: () => undefined,
        navigateToVaultAnnotation: () => undefined,
        repairInkConflict: () => Promise.resolve(),
        restoreAnnotation: () => Promise.resolve(),
        restoreInk: () => Promise.resolve(),
      },
      inkRepository: { listSurfaceSummaries: () => Promise.resolve([]) } as never,
      service: { listCurrentFile } as never,
      stylePresets: [],
      vaultIndex: index,
      vaultIndexBuilder: { rebuild, restoreCached } as never,
    });
    await view.onOpen();
    expect(container.classList.contains('inkstone-annotation-sidebar-view')).toBe(true);
    const contentHost = container.querySelector('[data-inkstone-sidebar-content]');
    expect(contentHost).not.toBeNull();
    expect(container.querySelectorAll('[aria-label="Annotation scope"]')).toHaveLength(1);
    expect(container.querySelectorAll('header')).toHaveLength(1);

    clickScope(container, 'Entire Vault');
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    clickScope(container, 'Current file');
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe('Current file'),
    );
    expect(rebuild.mock.calls[0]?.[0].signal.aborted).toBe(false);
    resolveRebuild?.();
    await Promise.resolve();
    clickScope(container, 'Entire Vault');
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe('Entire Vault'),
    );

    expect(restoreCached).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(listCurrentFile).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-inkstone-sidebar-content]')).toBe(contentHost);
    expect(container.querySelectorAll('[aria-label="Annotation scope"]')).toHaveLength(1);
    expect(container.querySelectorAll('header')).toHaveLength(1);
    await view.onClose();
    expect(container.classList.contains('inkstone-annotation-sidebar-view')).toBe(false);
  });

  it('preserves Vault search, filters, collapsed groups and scroll across scope switches', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const index = new VaultAnnotationIndex();
    index.rebuild(
      Array.from({ length: 40 }, (_, position) => ({
        conflict: false,
        filePath: position < 20 ? 'Notes/Architecture.md' : 'Notes/Implementation.md',
        id: `annotation-${position}`,
        noteId: position < 20 ? 'architecture' : 'implementation',
        position,
        quote: `Architecture note ${position}`,
        revision: 1,
        status: 'active' as const,
        styleId: 'highlight-sun',
        tags: [],
        type: 'highlight' as const,
        updatedAt: '2026-07-15T08:00:00.000Z',
      })),
    );
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      commands: {
        bulkDeleteInk: () => Promise.resolve({ failed: [] }),
        deleteAnnotation: () => Promise.resolve(),
        deleteInk: () => Promise.resolve(),
        editInk: () => undefined,
        exportCurrentFile: () => undefined,
        exportInkPng: () => Promise.resolve(),
        exportInkReport: () => Promise.resolve(),
        exportInkSvg: () => Promise.resolve(),
        exportVaultEntries: () => undefined,
        getCurrentFilePath: () => 'Note.md',
        inspectAnnotation: () => undefined,
        navigateToAnnotation: () => true,
        navigateToInk: () => undefined,
        navigateToVaultAnnotation: () => undefined,
        repairInkConflict: () => Promise.resolve(),
        restoreInk: () => Promise.resolve(),
        restoreAnnotation: () => Promise.resolve(),
      },
      inkRepository: { listSurfaceSummaries: () => Promise.resolve([]) } as never,
      service: {
        listCurrentFile: () =>
          Promise.resolve({
            conflicts: [],
            issues: [],
            model: {
              groups: [
                {
                  kind: 'heading' as const,
                  rows: [
                    {
                      id: 'current-annotation',
                      marker: { kind: 'highlight' as const, styleId: 'highlight-sun' },
                      notePreview: null,
                      position: 0,
                      quote: 'Current architecture note',
                      revision: 1,
                      status: 'active' as const,
                      tags: [],
                      updatedAt: '2026-07-15T08:00:00.000Z',
                    },
                  ],
                  title: 'Document',
                },
              ],
              total: 1,
            },
          }),
      } as never,
      stylePresets: [],
      vaultIndex: index,
      vaultIndexBuilder: {
        rebuild: () => Promise.resolve({ indexed: 0, issues: [] }),
        restoreCached: () => Promise.resolve(0),
      } as never,
    });
    await view.onOpen();
    const currentSearch = await waitForInput(container, 'Search current file annotations');
    currentSearch.value = 'current architecture';
    currentSearch.dispatchEvent(new Event('input', { bubbles: true }));

    clickScope(container, 'Entire Vault');
    const search = await waitForInput(container, 'Search annotations');
    search.value = 'architecture';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 110));
    const type = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by type"]');
    if (type === null) throw new Error('Missing type filter.');
    type.value = 'highlight';
    type.dispatchEvent(new Event('change', { bubbles: true }));
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Sort: Document order"]')
      ?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Enter bulk mode"]')?.click();
    container
      .querySelector<HTMLInputElement>('.inkstone-vault-row input[type="checkbox"]')
      ?.click();
    container
      .querySelector<HTMLButtonElement>(
        '[data-note-group="Notes/Architecture.md"] .inkstone-vault-group-header__toggle',
      )
      ?.click();
    const viewport = container.querySelector<HTMLElement>('.inkstone-vault-virtual-list');
    if (viewport === null) throw new Error('Missing Vault viewport.');
    viewport.scrollTop = 180;
    viewport.dispatchEvent(new Event('scroll'));
    clickScope(container, 'Current file');
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe('Current file'),
    );
    expect((await waitForInput(container, 'Search current file annotations')).value).toBe(
      'current architecture',
    );
    expect(await waitForInput(container, 'Search current file annotations')).toBe(currentSearch);
    clickScope(container, 'Entire Vault');

    expect(await waitForInput(container, 'Search annotations')).toBe(search);
    expect(search.value).toBe('architecture');
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Filter by type"]')?.value,
    ).toBe('highlight');
    expect(
      container
        .querySelector('[data-note-group="Notes/Architecture.md"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(container.querySelector<HTMLElement>('.inkstone-vault-virtual-list')?.scrollTop).toBe(
      180,
    );
    expect(container.querySelector('button[aria-label="Sort: Updated"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Done selecting"]')).not.toBeNull();
    expect(container.querySelector('.inkstone-bulk-action-dock')?.textContent).toContain(
      '1 selected',
    );
  });

  it('follows the active file after the Vault scope has been initialized', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const index = new VaultAnnotationIndex();
    index.rebuild([]);
    let currentFilePath = 'First.md';
    const listCurrentFile = vi.fn((filePath: string) =>
      Promise.resolve({
        conflicts: [],
        issues: [],
        model: {
          groups: [
            {
              kind: 'heading' as const,
              rows: [
                {
                  id: filePath,
                  marker: { kind: 'highlight' as const, styleId: 'highlight-sun' },
                  notePreview: null,
                  position: 0,
                  quote: `Annotation from ${filePath}`,
                  revision: 1,
                  status: 'active' as const,
                  tags: [],
                  updatedAt: '2026-07-15T08:00:00.000Z',
                },
              ],
              title: filePath,
            },
          ],
          total: 1,
        },
      }),
    );
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      commands: {
        bulkDeleteInk: () => Promise.resolve({ failed: [] }),
        deleteAnnotation: () => Promise.resolve(),
        deleteInk: () => Promise.resolve(),
        editInk: () => undefined,
        exportCurrentFile: () => undefined,
        exportInkPng: () => Promise.resolve(),
        exportInkReport: () => Promise.resolve(),
        exportInkSvg: () => Promise.resolve(),
        exportVaultEntries: () => undefined,
        getCurrentFilePath: () => currentFilePath,
        inspectAnnotation: () => undefined,
        navigateToAnnotation: () => true,
        navigateToInk: () => undefined,
        navigateToVaultAnnotation: () => undefined,
        repairInkConflict: () => Promise.resolve(),
        restoreAnnotation: () => Promise.resolve(),
        restoreInk: () => Promise.resolve(),
      },
      inkRepository: { listSurfaceSummaries: () => Promise.resolve([]) } as never,
      service: { listCurrentFile } as never,
      stylePresets: [],
      vaultIndex: index,
      vaultIndexBuilder: {
        rebuild: () => Promise.resolve({ indexed: 0, issues: [] }),
        restoreCached: () => Promise.resolve(0),
      } as never,
    });
    await view.onOpen();
    expect(container.textContent).toContain('Annotation from First.md');

    clickScope(container, 'Entire Vault');
    await waitForInput(container, 'Search annotations');
    clickScope(container, 'Current file');
    currentFilePath = 'Second.md';
    await view.refresh();

    expect(listCurrentFile).toHaveBeenLastCalledWith('Second.md');
    expect(container.textContent).toContain('Annotation from Second.md');
    expect(container.textContent).not.toContain('Annotation from First.md');

    clickScope(container, 'Entire Vault');
    currentFilePath = 'Third.md';
    await view.refresh();
    clickScope(container, 'Current file');

    await vi.waitFor(() => {
      expect(listCurrentFile).toHaveBeenLastCalledWith('Third.md');
      expect(container.textContent).toContain('Annotation from Third.md');
    });
    expect(container.textContent).not.toContain('Annotation from Second.md');
  });
});

function clickScope(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`Missing scope button: ${label}`);
  button.click();
}

async function waitForInput(container: HTMLElement, label: string): Promise<HTMLInputElement> {
  await vi.waitFor(() => {
    expect(container.querySelector(`input[aria-label="${label}"]`)).not.toBeNull();
  });
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (input === null) throw new Error(`Missing input: ${label}`);
  return input;
}
