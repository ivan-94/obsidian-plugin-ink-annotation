// @vitest-environment jsdom

import type * as Obsidian from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VaultAnnotationIndex } from '../../domain/vault-annotation-index';
import type { InkSurfaceRecord } from '../../domain/ink-surface';
import { summarizeInkSurface } from '../../domain/ink-surface-summary';
import { AnnotationSidebarView } from './annotation-sidebar-view';

vi.mock('obsidian', async (importOriginal) => {
  const original = await importOriginal<typeof Obsidian>();
  return {
    ...original,
    ItemView: class {
      readonly contentEl: HTMLElement;

      constructor(leaf: { readonly contentEl?: HTMLElement }) {
        this.contentEl = leaf.contentEl ?? document.createElement('div');
      }
    },
  };
});

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
        bulkDelete: () => Promise.resolve({ failed: [], succeeded: [] }),
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
        restoreDeleted: () => Promise.resolve({ failed: [] }),
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

  it('does not mark a Vault index fresh when a canonical mutation supersedes its rebuild', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const index = new VaultAnnotationIndex();
    index.rebuild([]);
    const rebuild = vi
      .fn()
      .mockResolvedValueOnce({ indexed: 0, issues: [], status: 'superseded' })
      .mockResolvedValueOnce({ indexed: 0, issues: [], status: 'committed' });
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      commands: sidebarCommands(),
      inkRepository: { listSurfaceSummaries: () => Promise.resolve([]) } as never,
      service: {
        listCurrentFile: () =>
          Promise.resolve({ conflicts: [], issues: [], model: { groups: [], total: 0 } }),
      } as never,
      stylePresets: [],
      vaultIndex: index,
      vaultIndexBuilder: { rebuild, restoreCached: () => Promise.resolve(0) } as never,
    });
    await view.onOpen();

    clickScope(container, 'Entire Vault');
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    clickScope(container, 'Current file');
    clickScope(container, 'Entire Vault');

    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
    await view.onClose();
  });

  it('updates one Ink row after a local stroke without reloading or replacing the sidebar tree', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const initial = inkSurface(1);
    const listCurrentFile = vi.fn(() =>
      Promise.resolve({
        conflicts: [],
        issues: [],
        model: {
          groups: [
            {
              kind: 'heading' as const,
              rows: [
                {
                  id: 'text-1',
                  marker: { kind: 'highlight' as const, styleId: 'highlight-sun' },
                  notePreview: null,
                  position: 0,
                  quote: 'Stable text annotation',
                  revision: 1,
                  status: 'active' as const,
                  tags: [],
                  updatedAt: initial.updatedAt,
                },
              ],
              title: 'Document',
            },
          ],
          total: 1,
        },
      }),
    );
    const listSurfaceSummaries = vi.fn(() => Promise.resolve([summarizeInkSurface(initial)]));
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      commands: sidebarCommands(),
      inkRepository: { listSurfaceSummaries } as never,
      service: { listCurrentFile } as never,
      stylePresets: [],
      vaultIndex: new VaultAnnotationIndex(),
      vaultIndexBuilder: {
        rebuild: () => Promise.resolve({ indexed: 0, issues: [] }),
        restoreCached: () => Promise.resolve(0),
      } as never,
    });
    await view.onOpen();
    const inkRow = container.querySelector('[data-inkstone-ink-row="surface-1"]');
    const textRow = container.querySelector('[data-annotation-id="text-1"]');

    view.applyInkSurfaceChanged(inkSurface(2));

    expect(listCurrentFile).toHaveBeenCalledTimes(1);
    expect(listSurfaceSummaries).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(inkRow?.textContent).toContain('2 strokes'));
    expect(container.querySelector('[data-inkstone-ink-row="surface-1"]')).toBe(inkRow);
    expect(container.querySelector('[data-annotation-id="text-1"]')).toBe(textRow);
  });

  it('keeps the loaded Current file when the active leaf changes within the same file', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const listCurrentFile = vi.fn(() =>
      Promise.resolve({ conflicts: [], issues: [], model: { groups: [], total: 0 } }),
    );
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      commands: sidebarCommands(),
      inkRepository: { listSurfaceSummaries: () => Promise.resolve([]) } as never,
      service: { listCurrentFile } as never,
      stylePresets: [],
      vaultIndex: new VaultAnnotationIndex(),
      vaultIndexBuilder: {
        rebuild: () => Promise.resolve({ indexed: 0, issues: [] }),
        restoreCached: () => Promise.resolve(0),
      } as never,
    });
    await view.onOpen();

    await view.followActiveFile();

    expect(listCurrentFile).toHaveBeenCalledTimes(1);
  });

  it('keeps Current file content visible while revalidating the same file', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const loaded = {
      conflicts: [],
      issues: [],
      model: {
        groups: [
          {
            kind: 'heading' as const,
            rows: [
              {
                id: 'stable-row',
                marker: { kind: 'highlight' as const, styleId: 'highlight-sun' },
                notePreview: null,
                position: 0,
                quote: 'Stable while refreshing',
                revision: 1,
                status: 'active' as const,
                tags: [],
                updatedAt: '2026-07-16T10:24:00.000Z',
              },
            ],
            title: 'Document',
          },
        ],
        total: 1,
      },
    };
    let resolveRefresh!: () => void;
    const pendingRefresh = new Promise<typeof loaded>((resolve) => {
      resolveRefresh = () => resolve(loaded);
    });
    const listCurrentFile = vi
      .fn<() => Promise<typeof loaded>>()
      .mockResolvedValueOnce(loaded)
      .mockReturnValueOnce(pendingRefresh);
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      commands: sidebarCommands(),
      inkRepository: { listSurfaceSummaries: () => Promise.resolve([]) } as never,
      service: { listCurrentFile } as never,
      stylePresets: [],
      vaultIndex: new VaultAnnotationIndex(),
      vaultIndexBuilder: {
        rebuild: () => Promise.resolve({ indexed: 0, issues: [] }),
        restoreCached: () => Promise.resolve(0),
      } as never,
    });
    await view.onOpen();

    const refreshing = view.refresh();
    await Promise.resolve();

    expect(container.textContent).toContain('Stable while refreshing');
    expect(container.textContent).not.toContain('Loading annotations…');
    expect(container.querySelector('[data-inkstone-sidebar-content]')?.hasAttribute('hidden')).toBe(
      false,
    );
    resolveRefresh();
    await refreshing;
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
        bulkDelete: () => Promise.resolve({ failed: [], succeeded: [] }),
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
        restoreDeleted: () => Promise.resolve({ failed: [] }),
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
    const vaultHeaderActions = container.querySelector<HTMLElement>(
      '[data-inkstone-sidebar-header-actions="entire-vault"]',
    );
    if (vaultHeaderActions === null) throw new Error('Missing Vault header actions.');
    clickActionMenuItem(vaultHeaderActions, 'More actions', 'Select multiple…');
    await vi.waitFor(() => {
      expect(
        container.querySelector<HTMLInputElement>('.inkstone-vault-row input[type="checkbox"]'),
      ).not.toBeNull();
    });
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
        bulkDelete: () => Promise.resolve({ failed: [], succeeded: [] }),
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
        restoreDeleted: () => Promise.resolve({ failed: [] }),
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
    await view.followActiveFile();

    expect(listCurrentFile).toHaveBeenLastCalledWith('Second.md');
    expect(container.textContent).toContain('Annotation from Second.md');
    expect(container.textContent).not.toContain('Annotation from First.md');

    clickScope(container, 'Entire Vault');
    currentFilePath = 'Third.md';
    await view.followActiveFile();
    clickScope(container, 'Current file');

    await vi.waitFor(() => {
      expect(listCurrentFile).toHaveBeenLastCalledWith('Third.md');
      expect(container.textContent).toContain('Annotation from Third.md');
    });
    expect(container.textContent).not.toContain('Annotation from Second.md');
  });

  it('routes Current file bulk deletion through one command and exposes its shared Restore receipt', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const deletedItem = {
      deletedRevision: 2,
      filePath: 'Note.md',
      id: 'bulk-text',
      type: 'highlight' as const,
    };
    const bulkDelete = vi.fn(
      (
        selection: readonly {
          readonly expectedRevision: number;
          readonly filePath: string;
          readonly id: string;
          readonly type: string;
        }[],
      ) => {
        void selection;
        return Promise.resolve({ failed: [], succeeded: [deletedItem] });
      },
    );
    const restoreDeleted = vi.fn(() => Promise.resolve({ failed: [] }));
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      commands: { ...sidebarCommands(), bulkDelete, restoreDeleted },
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
                      id: 'bulk-text',
                      marker: { kind: 'highlight' as const, styleId: 'highlight-sun' },
                      notePreview: null,
                      position: 0,
                      quote: 'Delete through the shared command',
                      revision: 1,
                      status: 'active' as const,
                      tags: [],
                      updatedAt: '2026-07-17T04:00:00.000Z',
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
      vaultIndex: new VaultAnnotationIndex(),
      vaultIndexBuilder: {
        rebuild: () => Promise.resolve({ indexed: 0, issues: [] }),
        restoreCached: () => Promise.resolve(0),
      } as never,
    });
    await view.onOpen();

    const currentHeaderActions = container.querySelector<HTMLElement>(
      '[data-inkstone-sidebar-header-actions="current-file"]',
    );
    if (currentHeaderActions === null) throw new Error('Missing Current file header actions.');
    clickActionMenuItem(currentHeaderActions, 'More actions', 'Select multiple…');
    await vi.waitFor(() =>
      expect(
        container.querySelector('input[aria-label="Select annotation bulk-text"]'),
      ).not.toBeNull(),
    );
    container
      .querySelector<HTMLInputElement>('input[aria-label="Select annotation bulk-text"]')
      ?.click();
    await vi.waitFor(() =>
      expect(
        container.querySelector('button[aria-label="Delete selected"]')?.hasAttribute('disabled'),
      ).toBe(false),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Delete selected"]')?.click();
    await vi.waitFor(() =>
      expect(container.querySelector('button[aria-label="Confirm bulk delete"]')).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Confirm bulk delete"]')?.click();

    await vi.waitFor(() => expect(bulkDelete).toHaveBeenCalledTimes(1));
    expect(bulkDelete.mock.calls[0]?.[0]).toMatchObject([
      { expectedRevision: 1, filePath: 'Note.md', id: 'bulk-text', type: 'highlight' },
    ]);
    await vi.waitFor(() => expect(container.textContent).toContain('1 annotation deleted'));
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Restore deleted annotations"]')
      ?.click();
    await vi.waitFor(() => expect(restoreDeleted).toHaveBeenCalledWith([deletedItem]));
    await view.onClose();
  });

  it('keeps consecutive completed deletion batches in one retryable Restore receipt', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const first = {
      deletedRevision: 2,
      filePath: 'Note.md',
      id: 'first-delete',
      type: 'highlight' as const,
    };
    const second = {
      deletedRevision: 4,
      filePath: 'Note.md',
      id: 'second-delete',
      type: 'underline' as const,
    };
    const restoreDeleted = vi.fn(() => Promise.resolve({ failed: [] }));
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      commands: { ...sidebarCommands(), restoreDeleted },
      inkRepository: { listSurfaceSummaries: () => Promise.resolve([]) } as never,
      service: {
        listCurrentFile: () =>
          Promise.resolve({ conflicts: [], issues: [], model: { groups: [], total: 0 } }),
      } as never,
      stylePresets: [],
      vaultIndex: new VaultAnnotationIndex(),
      vaultIndexBuilder: {
        rebuild: () => Promise.resolve({ indexed: 0, issues: [], status: 'committed' }),
        restoreCached: () => Promise.resolve(0),
      } as never,
    });
    await view.onOpen();
    const receiptHarness = view as unknown as {
      showRecentDeletion: (items: readonly (typeof first | typeof second)[]) => void;
    };

    receiptHarness.showRecentDeletion([first]);
    receiptHarness.showRecentDeletion([second, second]);

    await vi.waitFor(() => expect(container.textContent).toContain('2 annotations deleted'));
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Restore deleted annotations"]')
      ?.click();
    await vi.waitFor(() => expect(restoreDeleted).toHaveBeenCalledWith([first, second]));
    await view.onClose();
  });

  it('keeps an Entire Vault bulk deletion recoverable without putting tombstones back in the active index', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const index = new VaultAnnotationIndex();
    index.rebuild([
      {
        conflict: false,
        filePath: 'Note.md',
        id: 'vault-text',
        noteId: 'note-1',
        position: 0,
        quote: 'Vault deletion',
        revision: 1,
        status: 'active',
        styleId: 'highlight-sun',
        tags: [],
        type: 'highlight',
        updatedAt: '2026-07-17T04:00:00.000Z',
      },
    ]);
    const deletedItem = {
      deletedRevision: 2,
      filePath: 'Note.md',
      id: 'vault-text',
      noteId: 'note-1',
      type: 'highlight' as const,
    };
    const bulkDelete = vi.fn(() => Promise.resolve({ failed: [], succeeded: [deletedItem] }));
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      commands: { ...sidebarCommands(), bulkDelete },
      inkRepository: { listSurfaceSummaries: () => Promise.resolve([]) } as never,
      service: {
        listCurrentFile: () =>
          Promise.resolve({ conflicts: [], issues: [], model: { groups: [], total: 0 } }),
      } as never,
      stylePresets: [],
      vaultIndex: index,
      vaultIndexBuilder: {
        rebuild: () => Promise.resolve({ indexed: 1, issues: [] }),
        restoreCached: () => Promise.resolve(0),
      } as never,
    });
    await view.onOpen();
    clickScope(container, 'Entire Vault');
    await waitForInput(container, 'Search annotations');
    const vaultHeaderActions = container.querySelector<HTMLElement>(
      '[data-inkstone-sidebar-header-actions="entire-vault"]',
    );
    if (vaultHeaderActions === null) throw new Error('Missing Vault header actions.');
    clickActionMenuItem(vaultHeaderActions, 'More actions', 'Select multiple…');
    await vi.waitFor(() =>
      expect(container.querySelector('.inkstone-vault-row input[type="checkbox"]')).not.toBeNull(),
    );
    container
      .querySelector<HTMLInputElement>('.inkstone-vault-row input[type="checkbox"]')
      ?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Delete selected"]')?.click();
    await vi.waitFor(() =>
      expect(container.querySelector('button[aria-label="Confirm bulk delete"]')).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Confirm bulk delete"]')?.click();

    await vi.waitFor(() => expect(bulkDelete).toHaveBeenCalledTimes(1));
    expect(index.snapshot()).toEqual([]);
    expect(container.textContent).toContain('1 annotation deleted');
    expect(
      container.querySelector('button[aria-label="Restore deleted annotations"]'),
    ).not.toBeNull();
    await view.onClose();
  });

  it('invalidates the hidden Current file cache when an Entire Vault mutation affects it', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const index = new VaultAnnotationIndex();
    index.rebuild([]);
    const listCurrentFile = vi.fn(() =>
      Promise.resolve({ conflicts: [], issues: [], model: { groups: [], total: 0 } }),
    );
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      commands: sidebarCommands(),
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
    clickScope(container, 'Entire Vault');
    await waitForInput(container, 'Search annotations');

    await view.refreshAfterCanonicalMutation('Note.md');
    clickScope(container, 'Current file');

    await vi.waitFor(() => expect(listCurrentFile).toHaveBeenCalledTimes(2));
    await view.onClose();
  });

  it('does not let an older Current file refresh repaint a row after deletion', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const empty = { conflicts: [], issues: [], model: { groups: [], total: 0 } } as const;
    let releaseStale: (() => void) | undefined;
    const stale = new Promise<{
      readonly conflicts: readonly [];
      readonly issues: readonly [];
      readonly model: {
        readonly groups: readonly [
          {
            readonly kind: 'heading';
            readonly rows: readonly [
              {
                readonly id: 'deleted-row';
                readonly marker: { readonly kind: 'highlight'; readonly styleId: 'highlight-sun' };
                readonly notePreview: null;
                readonly position: 0;
                readonly quote: 'Stale deleted row';
                readonly revision: 1;
                readonly status: 'active';
                readonly tags: readonly [];
                readonly updatedAt: '2026-07-17T05:00:00.000Z';
              },
            ];
            readonly title: 'Document';
          },
        ];
        readonly total: 1;
      };
    }>((resolve) => {
      releaseStale = () =>
        resolve({
          conflicts: [],
          issues: [],
          model: {
            groups: [
              {
                kind: 'heading',
                rows: [
                  {
                    id: 'deleted-row',
                    marker: { kind: 'highlight', styleId: 'highlight-sun' },
                    notePreview: null,
                    position: 0,
                    quote: 'Stale deleted row',
                    revision: 1,
                    status: 'active',
                    tags: [],
                    updatedAt: '2026-07-17T05:00:00.000Z',
                  },
                ],
                title: 'Document',
              },
            ],
            total: 1,
          },
        });
    });
    const listCurrentFile = vi
      .fn()
      .mockResolvedValueOnce(empty)
      .mockReturnValueOnce(stale)
      .mockResolvedValueOnce(empty);
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      commands: sidebarCommands(),
      inkRepository: { listSurfaceSummaries: () => Promise.resolve([]) } as never,
      service: { listCurrentFile } as never,
      stylePresets: [],
      vaultIndex: new VaultAnnotationIndex(),
      vaultIndexBuilder: {
        rebuild: () => Promise.resolve({ indexed: 0, issues: [], status: 'committed' }),
        restoreCached: () => Promise.resolve(0),
      } as never,
    });
    await view.onOpen();

    const olderRefresh = view.refreshAfterCanonicalMutation('Note.md');
    await vi.waitFor(() => expect(listCurrentFile).toHaveBeenCalledTimes(2));
    await view.refreshAfterCanonicalMutation('Note.md');
    expect(container.textContent).not.toContain('Stale deleted row');

    releaseStale?.();
    await olderRefresh;
    expect(container.textContent).not.toContain('Stale deleted row');
    await view.onClose();
  });

  it('routes an unanchored row repair with its current file and menu invoker', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const repairs: string[] = [];
    const view = new AnnotationSidebarView({ contentEl: container } as never, {
      commands: {
        bulkDelete: () => Promise.resolve({ failed: [], succeeded: [] }),
        deleteAnnotation: () => Promise.resolve(),
        deleteInk: () => Promise.resolve(),
        editInk: () => undefined,
        exportCurrentFile: () => undefined,
        exportInkPng: () => Promise.resolve(),
        exportInkReport: () => Promise.resolve(),
        exportInkSvg: () => Promise.resolve(),
        exportVaultEntries: () => undefined,
        getCurrentFilePath: () => 'Repair.md',
        inspectAnnotation: () => undefined,
        navigateToAnnotation: () => true,
        navigateToInk: () => undefined,
        navigateToVaultAnnotation: () => undefined,
        repairAnnotation: (filePath, annotationId, invoker) => {
          repairs.push(`${filePath}:${annotationId}:${invoker.dataset.inkstoneAnnotationActions}`);
          return Promise.resolve();
        },
        repairInkConflict: () => Promise.resolve(),
        restoreAnnotation: () => Promise.resolve(),
        restoreDeleted: () => Promise.resolve({ failed: [] }),
        restoreInk: () => Promise.resolve(),
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
                  kind: 'problems' as const,
                  rows: [
                    {
                      id: 'lost-target',
                      marker: { kind: 'highlight' as const, styleId: 'highlight-sun' },
                      notePreview: null,
                      position: 0,
                      quote: 'Lost quote',
                      revision: 1,
                      status: 'unanchored' as const,
                      tags: [],
                      updatedAt: '2026-07-15T08:00:00.000Z',
                    },
                  ],
                  title: 'Problems',
                },
              ],
              total: 1,
            },
          }),
      } as never,
      stylePresets: [],
      vaultIndex: new VaultAnnotationIndex(),
      vaultIndexBuilder: {
        rebuild: () => Promise.resolve({ indexed: 0, issues: [] }),
        restoreCached: () => Promise.resolve(0),
      } as never,
    });
    await view.onOpen();

    container
      .querySelector<HTMLButtonElement>('[data-inkstone-annotation-actions="lost-target"]')
      ?.click();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-obsidian-test-menu] button[aria-label="Repair target"]',
      )
      ?.click();
    await vi.waitFor(() => expect(repairs).toEqual(['Repair.md:lost-target:lost-target']));
  });
});

function clickScope(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`Missing scope button: ${label}`);
  button.click();
}

function clickActionMenuItem(
  container: HTMLElement,
  triggerLabel: string,
  itemLabel: string,
): void {
  container.querySelector<HTMLButtonElement>(`button[aria-label="${triggerLabel}"]`)?.click();
  const item = document.body.querySelector<HTMLButtonElement>(
    `[data-obsidian-test-menu] button[aria-label="${itemLabel}"]`,
  );
  if (item === null) throw new Error(`Missing action menu item: ${itemLabel}`);
  item.click();
}

async function waitForInput(container: HTMLElement, label: string): Promise<HTMLInputElement> {
  await vi.waitFor(() => {
    expect(container.querySelector(`input[aria-label="${label}"]`)).not.toBeNull();
  });
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (input === null) throw new Error(`Missing input: ${label}`);
  return input;
}

function sidebarCommands() {
  return {
    bulkDelete: () => Promise.resolve({ failed: [], succeeded: [] }),
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
    restoreDeleted: () => Promise.resolve({ failed: [] }),
    restoreInk: () => Promise.resolve(),
  };
}

function inkSurface(strokeCount: number): InkSurfaceRecord {
  return {
    binding: {
      blockFingerprints: ['anchor-lab'],
      headingPath: ['Anchor Lab'],
      sectionFingerprint: 'anchor-section',
      sourceEnd: 20,
      sourceStart: 0,
    },
    createdAt: '2026-07-16T02:00:00.000Z',
    filePath: 'Note.md',
    id: 'surface-1',
    layout: {
      blockFingerprints: ['anchor-lab'],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1_200,
      logicalWidth: 704,
      sourceRevision: 'source-1',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: strokeCount,
    schemaVersion: 2,
    status: 'active',
    strokes: Array.from({ length: strokeCount }, (_, index) => ({
      color: '#d36f6f',
      id: `stroke-${index}`,
      points: [
        { pressure: 0.5, time: index, x: 10 + index, y: 20 + index },
        { pressure: 0.5, time: index + 1, x: 20 + index, y: 30 + index },
      ],
      tool: 'pen' as const,
      width: 4,
    })),
    updatedAt: `2026-07-16T02:00:0${strokeCount}.000Z`,
  };
}
