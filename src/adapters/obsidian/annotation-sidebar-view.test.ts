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

  it('routes an unanchored row repair with its current file and menu invoker', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const repairs: string[] = [];
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
