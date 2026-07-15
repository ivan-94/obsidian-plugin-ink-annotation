// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CurrentFileAnnotationList } from '../domain/current-file-annotation-list';
import type { InkSurfaceSummary } from '../domain/ink-surface-summary';
import { CurrentFileSidebar } from './current-file-sidebar';

describe('current-file sidebar', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('shows an instructional empty state without fake annotation data', () => {
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({ container, document, onSelect: () => undefined });

    sidebar.render({ groups: [], total: 0 });

    expect(container.textContent).toContain('No annotations yet');
    expect(container.textContent).toContain('Select text in Reading View or start Ink Mode.');
    expect(container.querySelector('[data-inkstone-annotation-row]')).toBeNull();
  });

  it('renders compact heading/problem groups and marks only the active row', () => {
    const selected: string[] = [];
    const inspected: string[] = [];
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onInspect: (id) => inspected.push(id),
      onSelect: (id) => selected.push(id),
    });
    sidebar.render(fixture());

    expect(
      [...container.querySelectorAll('[data-inkstone-group-title]')].map(
        (element) => element.textContent,
      ),
    ).toEqual(['Problems', 'Intro']);
    const row = container.querySelector<HTMLButtonElement>('[data-annotation-id="active-1"]');
    expect(row?.querySelector('.inkstone-sidebar-row__quote')?.textContent).toBe('Active quote');
    expect(row?.querySelector('.inkstone-sidebar-row__note')?.textContent).toBe('A short note');
    expect(row?.querySelector('.inkstone-sidebar-row__content')?.children).toHaveLength(3);

    row?.click();

    expect(selected).toEqual(['active-1']);
    expect(row?.getAttribute('aria-current')).toBe('true');
    expect(row?.parentElement?.classList.contains('is-active')).toBe(true);
    const metadata = row?.querySelector('.inkstone-sidebar-row__metadata')?.textContent;
    expect(metadata).toContain('tag-one');
    expect(metadata).toMatch(/07-14 \d{2}:01/);
    expect(metadata).not.toContain('active');
    expect(metadata).not.toContain('2026-');
    expect(row?.querySelector('.inkstone-sidebar-row__quote')?.getAttribute('title')).toBe(
      'Active quote',
    );
    const actions = row?.parentElement?.querySelector<HTMLButtonElement>(
      '[data-inkstone-annotation-actions="active-1"]',
    );
    const actionMenu = row?.parentElement?.querySelector<HTMLElement>(
      '[data-inkstone-annotation-menu="active-1"]',
    );
    expect(actions?.getAttribute('aria-expanded')).toBe('false');
    expect(actionMenu?.hidden).toBe(true);
    actions?.click();
    expect(actions?.getAttribute('aria-expanded')).toBe('true');
    actionMenu?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(actions?.getAttribute('aria-expanded')).toBe('false');
    expect(actionMenu?.hidden).toBe(true);
    actions?.click();
    row?.parentElement?.querySelector<HTMLButtonElement>('[aria-label="Edit annotation"]')?.click();
    expect(inspected).toEqual(['active-1']);
    expect(
      container.querySelector('[data-annotation-id="problem-1"]')?.hasAttribute('aria-current'),
    ).toBe(false);
    expect(
      container
        .querySelector('[data-annotation-id="problem-1"]')
        ?.parentElement?.classList.contains('is-active'),
    ).toBe(false);
  });

  it('keeps Current file menus exclusive and dismisses them outside', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const sidebar = new CurrentFileSidebar({ container, document, onSelect: () => undefined });
    sidebar.render(fixture(), undefined, [inkSummary()]);
    const inkToggle = container.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-actions="surface-1"]',
    );
    const inkMenu = container.querySelector<HTMLElement>('[data-inkstone-ink-menu="surface-1"]');
    const annotationToggle = container.querySelector<HTMLButtonElement>(
      '[data-inkstone-annotation-actions="active-1"]',
    );
    const annotationMenu = container.querySelector<HTMLElement>(
      '[data-inkstone-annotation-menu="active-1"]',
    );

    inkToggle?.click();
    expect(inkMenu?.hidden).toBe(false);
    annotationToggle?.click();
    expect(inkMenu?.hidden).toBe(true);
    expect(annotationMenu?.hidden).toBe(false);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(annotationMenu?.hidden).toBe(true);
    expect(annotationToggle?.getAttribute('aria-expanded')).toBe('false');
  });

  it('deletes a text annotation from its row menu and exposes a short Restore action', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T13:42:00.000Z'));
    const deleted: string[] = [];
    const restored: string[] = [];
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onDeleteAnnotation: (id: string) => deleted.push(id),
      onRestoreAnnotation: (id: string, revision: number) => restored.push(`${id}:${revision}`),
      onSelect: () => undefined,
    });
    sidebar.render(fixture());

    container
      .querySelector<HTMLButtonElement>('[data-inkstone-annotation-actions="active-1"]')
      ?.click();
    container
      .querySelector<HTMLElement>('[data-inkstone-annotation-menu="active-1"]')
      ?.querySelector<HTMLButtonElement>('[aria-label="Delete annotation"]')
      ?.click();
    expect(deleted).toEqual(['active-1']);

    sidebar.render({
      groups: [
        {
          kind: 'heading',
          rows: [
            {
              ...fixture().groups[1]!.rows[0]!,
              deletedAt: '2026-07-15T13:42:00.000Z',
              revision: 2,
            },
          ],
          title: 'Intro',
        },
      ],
      total: 1,
    });
    const restore = container.querySelector<HTMLButtonElement>(
      '[data-inkstone-annotation-restore="active-1"]',
    );
    expect(restore).not.toBeNull();
    restore?.click();
    expect(restored).toEqual(['active-1:2']);

    vi.advanceTimersByTime(5_000);
    expect(container.querySelector('[data-inkstone-annotation-restore="active-1"]')).toBeNull();
    sidebar.dispose();
  });

  it('synchronizes a document hit only while the already-open component exists', () => {
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({ container, document, onSelect: () => undefined });
    sidebar.render(fixture());

    expect(sidebar.selectAnnotation('problem-1')).toBe(true);
    expect(
      container.querySelector('[data-annotation-id="problem-1"]')?.getAttribute('aria-current'),
    ).toBe('true');
    expect(sidebar.selectAnnotation('missing')).toBe(false);
  });

  it('preserves an active row and its keyboard focus across host-driven refreshes', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const sidebar = new CurrentFileSidebar({ container, document, onSelect: () => undefined });
    sidebar.render(fixture());
    const row = container.querySelector<HTMLButtonElement>('[data-annotation-id="active-1"]');
    row?.click();
    row?.focus();

    sidebar.render(fixture());

    const refreshed = container.querySelector<HTMLButtonElement>('[data-annotation-id="active-1"]');
    expect(refreshed?.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(refreshed);
  });

  it('keeps a stable Inspector return-focus target when the sidebar rerenders', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const sidebar = new CurrentFileSidebar({ container, document, onSelect: () => undefined });
    sidebar.render(fixture());
    sidebar.selectAnnotation('active-1');
    const original = container.querySelector<HTMLButtonElement>(
      '[data-inkstone-annotation-actions="active-1"]',
    );

    sidebar.render(fixture());

    expect(original?.id).not.toBe('');
    expect(document.getElementById(original?.id ?? '')).not.toBe(original);
    expect(document.getElementById(original?.id ?? '')?.dataset.inkstoneAnnotationActions).toBe(
      'active-1',
    );
  });

  it('exposes cloud-unknown, conflict and damaged-file states without claiming sync', () => {
    const reviews: string[] = [];
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onReviewConflicts: () => reviews.push('review'),
      onSelect: () => undefined,
    });

    sidebar.render(fixture(), { conflictCount: 2, readIssueCount: 1 });

    expect(container.querySelector('[data-inkstone-cloud-status]')?.textContent).toBe(
      'Sync status unavailable',
    );
    expect(
      container
        .querySelector('[data-inkstone-cloud-status]')
        ?.classList.contains('inkstone-visually-hidden'),
    ).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '2 conflicts need repair',
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "1 file couldn't be read",
    );
    expect(container.textContent).not.toContain('Synced');
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Review annotation conflicts"]')
      ?.click();
    expect(reviews).toEqual(['review']);
  });

  it('keeps a failed local read visible and retryable', () => {
    const retries: string[] = [];
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onRetry: () => retries.push('retry'),
      onSelect: () => undefined,
    });

    sidebar.renderFailure("Annotation files aren't available locally yet.");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Annotation files aren't available locally yet.",
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Retry annotations"]')?.click();
    expect(retries).toEqual(['retry']);
  });

  it('requests Entire Vault only after the user activates that scope', () => {
    const scopes: string[] = [];
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onEntireVault: () => {
        scopes.push('vault');
      },
      onSelect: () => undefined,
    });
    sidebar.render(fixture());

    expect(scopes).toEqual([]);
    container.querySelector<HTMLButtonElement>('button[aria-label="Show Entire Vault"]')?.click();
    expect(scopes).toEqual(['vault']);
  });

  it('restores keyboard focus to the active scope after an asynchronous scope switch', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onEntireVault: () => {
        container.innerHTML =
          '<div class="inkstone-sidebar__scope"><button aria-pressed="false">Current file</button><button aria-pressed="true">Entire Vault</button></div>';
        return Promise.resolve();
      },
      onSelect: () => undefined,
    });
    sidebar.render(fixture());

    container.querySelector<HTMLButtonElement>('button[aria-label="Show Entire Vault"]')?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.activeElement?.textContent).toBe('Entire Vault');
  });

  it('offers current-file export only when annotations exist', () => {
    const exports: string[] = [];
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onExportCurrentFile: () => exports.push('current-file'),
      onSelect: () => undefined,
    });

    sidebar.render(fixture());
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Export current file annotations"]')
      ?.click();
    expect(exports).toEqual(['current-file']);

    sidebar.render({ groups: [], total: 0 });
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Export current file annotations"]',
      )?.disabled,
    ).toBe(true);
  });

  it('renders Ink thumbnail metadata and routes locate/edit/delete/restore without loading vectors', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:01:03.000Z'));
    const actions: string[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onDeleteInk: (id) => actions.push(`delete:${id}`),
      onEditInk: (id) => actions.push(`edit:${id}`),
      onExportInkPng: (id) => actions.push(`png:${id}`),
      onExportInkSvg: (id) => actions.push(`svg:${id}`),
      onRestoreInk: (id) => actions.push(`restore:${id}`),
      onSelect: () => undefined,
      onSelectInk: (summary) => actions.push(`select:${summary.id}`),
    });

    sidebar.render({ groups: [], total: 0 }, undefined, [inkSummary(), deletedInkSummary()]);

    expect(container.querySelector('[data-inkstone-ink-thumbnail]')?.getAttribute('src')).toContain(
      'data:image/svg+xml',
    );
    expect(container.textContent).toContain('2 strokes');
    container.querySelector<HTMLButtonElement>('[data-inkstone-ink-row="surface-1"]')?.click();
    const menuToggle = container.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-actions="surface-1"]',
    );
    const menu = container.querySelector<HTMLElement>('[data-inkstone-ink-menu="surface-1"]');
    expect(menuToggle).not.toBeNull();
    expect(menu?.hidden).toBe(true);
    expect(
      container.querySelectorAll('.inkstone-sidebar-ink-row__actions > .inkstone-icon-button'),
    ).toHaveLength(2);
    menuToggle?.click();
    expect(menuToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(menu?.hidden).toBe(false);
    expect(menu?.textContent).toContain('Edit');
    expect(menu?.textContent).toContain('Export SVG');
    expect(menu?.textContent).toContain('Export PNG');
    expect(menu?.textContent).toContain('Delete');
    container.querySelector<HTMLButtonElement>('[data-inkstone-ink-edit="surface-1"]')?.click();
    menuToggle?.click();
    container.querySelector<HTMLButtonElement>('[aria-label="Export Ink as SVG"]')?.click();
    menuToggle?.click();
    container.querySelector<HTMLButtonElement>('[aria-label="Export Ink as PNG"]')?.click();
    menuToggle?.click();
    const remove = container.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-delete="surface-1"]',
    );
    remove?.click();
    expect(remove?.getAttribute('aria-label')).toBe('Confirm delete Ink surface');
    expect(actions).toEqual([
      'select:surface-1',
      'edit:surface-1',
      'svg:surface-1',
      'png:surface-1',
    ]);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    menuToggle?.click();
    expect(remove?.getAttribute('aria-label')).toBe('Delete Ink surface');
    remove?.click();
    expect(remove?.getAttribute('aria-label')).toBe('Confirm delete Ink surface');
    remove?.click();
    container.querySelector<HTMLButtonElement>('[data-inkstone-ink-restore="surface-2"]')?.click();
    expect(actions).toEqual([
      'select:surface-1',
      'edit:surface-1',
      'svg:surface-1',
      'png:surface-1',
      'delete:surface-1',
      'restore:surface-2',
    ]);
  });

  it('removes a deleted Ink restore row five seconds after its tombstone time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:01:00.000Z'));
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onSelect: () => undefined,
    });

    sidebar.render({ groups: [], total: 0 }, undefined, [deletedInkSummary()]);
    expect(container.querySelector('[data-inkstone-ink-restore="surface-2"]')).not.toBeNull();

    vi.advanceTimersByTime(4_999);
    expect(container.querySelector('[data-inkstone-ink-restore="surface-2"]')).not.toBeNull();
    vi.advanceTimersByTime(1);

    expect(container.querySelector('[data-inkstone-ink-restore="surface-2"]')).toBeNull();
    expect(container.textContent).toContain('No annotations yet');
    sidebar.dispose();
    vi.useRealTimers();
  });

  it('never exposes a zero-stroke internal surface as a user annotation', () => {
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onSelect: () => undefined,
    });

    sidebar.render({ groups: [], total: 0 }, undefined, [
      { ...inkSummary(), strokeCount: 0, thumbnailSvg: '<svg></svg>' },
    ]);

    expect(container.querySelector('[data-inkstone-ink-row]')).toBeNull();
    expect(container.textContent).toContain('No annotations yet');
  });
});

function fixture(): CurrentFileAnnotationList {
  return {
    groups: [
      {
        kind: 'problems',
        rows: [
          {
            id: 'problem-1',
            marker: { kind: 'highlight', styleId: 'highlight-sun' },
            notePreview: null,
            position: 20,
            quote: 'Lost quote',
            revision: 1,
            status: 'unanchored',
            tags: ['repair'],
            updatedAt: '2026-07-14T09:00:00.000Z',
          },
        ],
        title: 'Problems',
      },
      {
        kind: 'heading',
        rows: [
          {
            id: 'active-1',
            marker: { kind: 'underline', styleId: 'highlight-mint' },
            notePreview: 'A short note',
            position: 40,
            quote: 'Active quote',
            revision: 1,
            status: 'active',
            tags: ['tag-one'],
            updatedAt: '2026-07-14T09:01:00.000Z',
          },
        ],
        title: 'Intro',
      },
    ],
    total: 2,
  };
}

function inkSummary(): InkSurfaceSummary {
  return {
    filePath: 'Ink.md',
    headingPath: ['Intro'],
    id: 'surface-1',
    logicalHeight: 600,
    logicalWidth: 960,
    position: 100,
    revision: 2,
    status: 'active',
    strokeCount: 2,
    thumbnailSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    updatedAt: '2026-07-14T12:00:00.000Z',
  };
}

function deletedInkSummary(): InkSurfaceSummary {
  return {
    ...inkSummary(),
    deletedAt: '2026-07-14T12:01:00.000Z',
    id: 'surface-2',
    position: 200,
  };
}
