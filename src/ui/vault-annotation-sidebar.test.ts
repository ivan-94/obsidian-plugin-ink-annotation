// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { VaultAnnotationIndex, type AnnotationIndexEntry } from '../domain/vault-annotation-index';
import { VaultAnnotationSidebar } from './vault-annotation-sidebar';

describe('Entire Vault annotation sidebar', () => {
  afterEach(() => document.body.replaceChildren());

  it('distinguishes building, empty and no-matching-result states', () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    const sidebar = new VaultAnnotationSidebar({ container, document, index });

    sidebar.showBuilding({ completed: 2, total: 10 });
    expect(container.textContent).toContain('Index building 2 of 10');

    sidebar.showReady();
    expect(container.textContent).toContain('No annotations');

    index.rebuild([entry('one', 'Searchable quote')]);
    sidebar.showReady();
    const search = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search annotations"]',
    );
    if (search === null) {
      throw new Error('Expected Vault search input.');
    }
    search.value = 'does not exist';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(container.textContent).toContain('No matching results');
  });

  it('restores keyboard focus to the active scope after returning to Current file', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const index = new VaultAnnotationIndex();
    const sidebar = new VaultAnnotationSidebar({
      container,
      document,
      index,
      onCurrentFile: () => {
        container.innerHTML =
          '<div class="inkstone-sidebar__scope"><button aria-pressed="true">Current file</button><button aria-pressed="false">Entire Vault</button></div>';
        return Promise.resolve();
      },
    });
    sidebar.showReady();

    container.querySelector<HTMLButtonElement>('.inkstone-sidebar__scope button')?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.activeElement?.textContent).toBe('Current file');
  });

  it('keeps Vault popovers exclusive and dismisses them outside', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const sidebar = new VaultAnnotationSidebar({
      container,
      document,
      index: new VaultAnnotationIndex(),
    });
    sidebar.showReady();
    const more = container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
    const headerMenu = container.querySelector<HTMLElement>('.inkstone-sidebar__overflow-menu');
    const filters = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Filter annotations"]',
    );
    const filterMenu = container.querySelector<HTMLElement>('.inkstone-vault-filters--popover');

    more?.click();
    expect(headerMenu?.hidden).toBe(false);
    filters?.click();
    expect(headerMenu?.hidden).toBe(true);
    expect(filterMenu?.hidden).toBe(false);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(filterMenu?.hidden).toBe(true);
    expect(filters?.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens row actions as a real menu and dispatches open, edit and export commands', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const index = new VaultAnnotationIndex();
    index.rebuild([entry('row-actions', 'Row actions')]);
    const opened: string[] = [];
    const edited: string[] = [];
    const exported: string[] = [];
    const sidebar = new VaultAnnotationSidebar({
      container,
      document,
      index,
      onEdit: (selected) => edited.push(selected.id),
      onExport: (entries) => exported.push(entries.map((selected) => selected.id).join(',')),
      onOpen: (selected) => opened.push(selected.id),
    });
    sidebar.showReady();

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-inkstone-vault-actions="row-actions"]',
    );
    const menu = container.querySelector<HTMLElement>('[data-inkstone-vault-menu="row-actions"]');
    trigger?.click();
    expect(menu?.hidden).toBe(false);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(opened).toEqual([]);

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(menu?.hidden).toBe(true);

    trigger?.click();
    menu?.querySelector<HTMLButtonElement>('button[aria-label="Edit Row actions"]')?.click();
    expect(edited).toEqual(['row-actions']);
    expect(menu?.hidden).toBe(true);

    trigger?.click();
    menu?.querySelector<HTMLButtonElement>('button[aria-label="Export Row actions"]')?.click();
    expect(exported).toEqual(['row-actions']);

    trigger?.click();
    menu
      ?.querySelector<HTMLButtonElement>('button[aria-label="Open source for Row actions"]')
      ?.click();
    expect(opened).toEqual(['row-actions']);
  });

  it('applies and removes a visible type filter chip', () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    index.rebuild([
      entry('highlight', 'Highlight row'),
      { ...entry('underline', 'Underline row'), type: 'underline' },
    ]);
    const sidebar = new VaultAnnotationSidebar({ container, document, index });
    sidebar.showReady();

    const type = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by type"]');
    if (type === null) {
      throw new Error('Expected type filter.');
    }
    type.value = 'underline';
    type.dispatchEvent(new Event('change', { bubbles: true }));

    expect(container.querySelectorAll('[data-annotation-id]')).toHaveLength(1);
    const chip = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove type filter"]',
    );
    expect(chip?.textContent).toContain('Type: Underline');
    chip?.click();
    expect(container.querySelectorAll('[data-annotation-id]')).toHaveLength(2);
  });

  it('searches, filters and opens an Ink summary without materializing vector data', () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    const ink: AnnotationIndexEntry = {
      body: '12 strokes',
      conflict: false,
      filePath: 'Sketches/Flow.md',
      id: 'surface-flow',
      ink: { headingPath: ['Architecture', 'Flow'], strokeCount: 12 },
      noteId: 'note-flow',
      position: 30,
      quote: 'Ink · Architecture › Flow',
      revision: 2,
      status: 'needs-rebase',
      tags: [],
      type: 'ink',
      updatedAt: '2026-07-14T10:00:00.000Z',
    };
    index.rebuild([entry('text', 'Text row'), ink]);
    const opened: string[] = [];
    const sidebar = new VaultAnnotationSidebar({
      container,
      document,
      index,
      onOpen: (selected) => opened.push(`${selected.type}:${selected.id}`),
    });
    sidebar.showReady();

    const type = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by type"]');
    expect([...(type?.options ?? [])].map((option) => option.textContent)).toContain('Ink');
    if (type === null) throw new Error('Expected type filter.');
    type.value = 'ink';
    type.dispatchEvent(new Event('change', { bubbles: true }));
    expect(container.querySelectorAll('[data-annotation-id]')).toHaveLength(1);
    container.querySelector<HTMLButtonElement>('[data-annotation-id="surface-flow"]')?.click();
    expect(opened).toEqual(['ink:surface-flow']);

    container.querySelector<HTMLButtonElement>('button[aria-label="Enter bulk mode"]')?.click();
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Tag selected"]')?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Style selected"]')?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Delete selected"]')?.disabled,
    ).toBe(false);
    expect(JSON.stringify(index.snapshot())).not.toContain('points');
  });

  it('keeps the rendered DOM bounded for 20,000 indexed rows', () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    index.rebuild(
      Array.from({ length: 20_000 }, (_, position) => ({
        ...entry(`row-${position}`, `Quote ${position}`),
        position,
      })),
    );
    const sidebar = new VaultAnnotationSidebar({ container, document, index });

    sidebar.showReady();

    expect(container.querySelectorAll('[data-annotation-id]').length).toBeLessThan(30);
    expect(
      container.querySelector('[data-inkstone-virtual-total]')?.getAttribute('style'),
    ).toContain('calc(1320042px + var(--inkstone-vault-bottom-safe-area))');
    const bottomSpacer = container.querySelector<HTMLElement>(
      '[data-inkstone-vault-bottom-spacer]',
    );
    expect(bottomSpacer?.style.top).toBe('1320042px');
    expect(bottomSpacer?.style.height).toBe('var(--inkstone-vault-bottom-safe-area)');
    expect(container.querySelector<HTMLElement>('.inkstone-vault-group-header')?.style.height).toBe(
      '42px',
    );
    expect(container.querySelector<HTMLElement>('.inkstone-vault-row')?.style.height).toBe('66px');
    expect(container.classList.contains('inkstone-sidebar--vault')).toBe(true);
    expect(container.querySelector<HTMLElement>('.inkstone-vault-virtual-list')?.style.height).toBe(
      '100%',
    );
    expect(
      container.querySelector<HTMLElement>('.inkstone-vault-virtual-list')?.style.maxHeight,
    ).toBe('');
  });

  it('keeps search, filter and sort in one compact toolbar and discloses filters on demand', () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    index.rebuild([entry('one', 'One')]);
    const sidebar = new VaultAnnotationSidebar({ container, document, index });
    sidebar.showReady();

    const toolbar = container.querySelector('.inkstone-vault-toolbar');
    expect(toolbar?.children).toHaveLength(3);
    expect(container.querySelector('[aria-label="Focus annotation search"]')).toBeNull();
    expect(
      container
        .querySelector('[aria-label="Sync status unavailable"]')
        ?.classList.contains('inkstone-visually-hidden'),
    ).toBe(true);
    expect(container.querySelector('.inkstone-vault-summary')).toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Search annotations"]')
        ?.placeholder,
    ).toBe('Search 1 annotation…');
    expect(container.querySelector('.inkstone-sidebar__header h2')).toBeNull();
    expect(container.querySelector('.inkstone-sidebar__header')?.textContent).toContain(
      'Current fileEntire Vault',
    );
    const filters = container.querySelector<HTMLElement>('.inkstone-vault-filters--popover');
    expect(filters?.hidden).toBe(true);
    container.querySelector<HTMLButtonElement>('button[aria-label="Filter annotations"]')?.click();
    expect(filters?.hidden).toBe(false);
    expect(container.querySelectorAll('.inkstone-vault-group-header')).toHaveLength(1);
  });

  it('uses compact discoverable text and reserves warning metadata for problem states', () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    index.rebuild([
      entry('active', 'A very long annotation title'),
      {
        ...entry('problem', 'Ink · Architecture › Flow'),
        conflict: false,
        status: 'needs-rebase',
        type: 'ink',
      },
    ]);
    const sidebar = new VaultAnnotationSidebar({ container, document, index });

    sidebar.showReady();

    const groupName = container.querySelector<HTMLElement>('.inkstone-vault-group-header strong');
    expect(groupName?.title).toBe('Notes/Search.md');
    const active = container.querySelector<HTMLElement>('[data-annotation-id="active"]');
    expect(active?.querySelector('.inkstone-vault-row__quote')?.getAttribute('title')).toBe(
      'A very long annotation title',
    );
    expect(active?.querySelector('.inkstone-vault-row__metadata')?.textContent).toBe(
      'Highlight07-14 08:00',
    );
    const problem = container
      .querySelector<HTMLElement>('[data-annotation-id="problem"]')
      ?.closest<HTMLElement>('.inkstone-vault-row');
    expect(problem?.dataset.inkstoneEntryStatus).toBe('needs-rebase');
    expect(problem?.querySelector('.inkstone-vault-row__metadata')?.textContent).toBe(
      'Needs rebase07-14 08:00',
    );
    expect(problem?.querySelector('.inkstone-vault-row__metadata--warning')).not.toBeNull();
  });

  it('shows checkboxes only in bulk mode and confirms the exact delete snapshot', async () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    index.rebuild([entry('one', 'First'), entry('two', 'Second')]);
    const deleted: unknown[] = [];
    const sidebar = new VaultAnnotationSidebar({
      container,
      document,
      index,
      onBulkDelete: (selection) => {
        deleted.push(selection);
        return Promise.resolve({ failed: [] });
      },
    });
    sidebar.showReady();

    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    container.querySelector<HTMLButtonElement>('button[aria-label="Enter bulk mode"]')?.click();
    const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checkboxes).toHaveLength(2);
    for (const checkbox of checkboxes) {
      checkbox.click();
    }
    container.querySelector<HTMLButtonElement>('button[aria-label="Delete selected"]')?.click();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      'Delete 2 annotations?',
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Confirm bulk delete"]')?.click();

    await vi.waitFor(() => expect(deleted).toHaveLength(1));
    expect(deleted[0]).toMatchObject([
      { expectedRevision: 1, id: 'one' },
      { expectedRevision: 1, id: 'two' },
    ]);
  });

  it('builds tag filters from the index and exposes a removable chip', () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    index.rebuild([{ ...entry('tagged', 'Tagged'), tags: ['review'] }, entry('plain', 'Plain')]);
    const sidebar = new VaultAnnotationSidebar({ container, document, index });
    sidebar.showReady();

    const tag = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by tag"]');
    if (tag === null) {
      throw new Error('Expected tag filter.');
    }
    tag.value = 'review';
    tag.dispatchEvent(new Event('change', { bubbles: true }));
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-annotation-id]')].map(
        (row) => row.dataset.annotationId,
      ),
    ).toEqual(['tagged']);
    container.querySelector<HTMLButtonElement>('button[aria-label="Remove tag filter"]')?.click();
    expect(container.querySelectorAll('[data-annotation-id]')).toHaveLength(2);
  });

  it('filters by an explicit updated-after date', () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    index.rebuild([
      entry('new', 'New'),
      { ...entry('old', 'Old'), updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const sidebar = new VaultAnnotationSidebar({ container, document, index });
    sidebar.showReady();

    const after = container.querySelector<HTMLInputElement>('input[aria-label="Updated after"]');
    if (after === null) {
      throw new Error('Expected updated-after filter.');
    }
    after.value = '2026-07-01';
    after.dispatchEvent(new Event('change', { bubbles: true }));
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-annotation-id]')].map(
        (row) => row.dataset.annotationId,
      ),
    ).toEqual(['new']);
  });

  it('submits bulk tags for the explicit revision snapshot', async () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    index.rebuild([entry('tag-me', 'Tag me')]);
    const calls: unknown[] = [];
    const sidebar = new VaultAnnotationSidebar({
      container,
      document,
      index,
      onBulkAddTags: (selection, tags) => {
        calls.push({ selection, tags });
        return Promise.resolve({ failed: [] });
      },
    });
    sidebar.showReady();
    container.querySelector<HTMLButtonElement>('button[aria-label="Enter bulk mode"]')?.click();
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Tag selected"]')?.click();
    const tags = container.querySelector<HTMLInputElement>('input[aria-label="Bulk tags"]');
    if (tags === null) {
      throw new Error('Expected bulk tag input.');
    }
    tags.value = 'review, architecture';
    container.querySelector<HTMLButtonElement>('button[aria-label="Apply bulk tags"]')?.click();

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      selection: [{ expectedRevision: 1, id: 'tag-me' }],
      tags: ['review', 'architecture'],
    });
  });

  it('requires an explicit style choice before a bulk style change', async () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    index.rebuild([
      entry('style-me', 'Style me'),
      { ...entry('catalog', 'Catalog'), styleId: 'highlight-violet', styleName: 'Violet' },
    ]);
    const calls: string[] = [];
    const sidebar = new VaultAnnotationSidebar({
      container,
      document,
      index,
      onBulkChangeStyle: (_selection, styleId) => {
        calls.push(styleId);
        return Promise.resolve({ failed: [] });
      },
    });
    sidebar.showReady();
    container.querySelector<HTMLButtonElement>('button[aria-label="Enter bulk mode"]')?.click();
    container
      .querySelector<HTMLInputElement>('input[aria-label="Select annotation style-me"]')
      ?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Style selected"]')?.click();
    const style = container.querySelector<HTMLSelectElement>('select[aria-label="Bulk style"]');
    if (style === null) {
      throw new Error('Expected bulk style choice.');
    }
    style.value = 'highlight-violet';
    container.querySelector<HTMLButtonElement>('button[aria-label="Apply bulk style"]')?.click();

    await vi.waitFor(() => expect(calls).toEqual(['highlight-violet']));
  });

  it('offers configured styles even when no current row uses them', () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    index.rebuild([entry('style-me', 'Style me')]);
    const sidebar = new VaultAnnotationSidebar({
      container,
      document,
      index,
      styleOptions: [
        ['highlight-sun', 'Sun'],
        ['highlight-violet', 'Violet'],
      ],
    });
    sidebar.showReady();
    container.querySelector<HTMLButtonElement>('button[aria-label="Enter bulk mode"]')?.click();
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Style selected"]')?.click();

    expect(
      [
        ...container.querySelectorAll<HTMLOptionElement>('select[aria-label="Bulk style"] option'),
      ].map((option) => option.textContent),
    ).toEqual(['Sun', 'Violet']);
  });

  it('retains failed bulk selections after a partial delete outcome', async () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    index.rebuild([entry('keep-selected', 'Keep selected')]);
    const sidebar = new VaultAnnotationSidebar({
      container,
      document,
      index,
      onBulkDelete: (selection) => Promise.resolve({ failed: selection }),
    });
    sidebar.showReady();
    container.querySelector<HTMLButtonElement>('button[aria-label="Enter bulk mode"]')?.click();
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Delete selected"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Confirm bulk delete"]')?.click();

    await vi.waitFor(() =>
      expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(
        true,
      ),
    );
    expect(container.textContent).toContain('1 selected');
  });

  it('exports the current filtered results or only the explicit bulk selection', () => {
    const container = document.createElement('div');
    const index = new VaultAnnotationIndex();
    index.rebuild([
      entry('highlight', 'Highlight row'),
      { ...entry('underline', 'Underline row'), type: 'underline' },
    ]);
    const exports: string[][] = [];
    const sidebar = new VaultAnnotationSidebar({
      container,
      document,
      index,
      onExport: (entries) => exports.push(entries.map((item) => item.id)),
    });
    sidebar.showReady();
    const type = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by type"]');
    if (type === null) {
      throw new Error('Expected type filter.');
    }
    type.value = 'underline';
    type.dispatchEvent(new Event('change', { bubbles: true }));
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Export current results"]')
      ?.click();

    type.value = '';
    type.dispatchEvent(new Event('change', { bubbles: true }));
    container.querySelector<HTMLButtonElement>('button[aria-label="Enter bulk mode"]')?.click();
    container
      .querySelector<HTMLInputElement>('input[aria-label="Select annotation highlight"]')
      ?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Export selected"]')?.click();

    expect(exports).toEqual([['underline'], ['highlight']]);
  });
});

function entry(id: string, quote: string): AnnotationIndexEntry {
  return {
    conflict: false,
    filePath: 'Notes/Search.md',
    id,
    noteId: 'note-search',
    position: 0,
    quote,
    revision: 1,
    status: 'active',
    styleId: 'highlight-sun',
    tags: [],
    type: 'highlight',
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}
