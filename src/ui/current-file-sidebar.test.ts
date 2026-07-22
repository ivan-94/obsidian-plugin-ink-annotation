// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CurrentFileAnnotationList } from '../domain/current-file-annotation-list';
import type { InkSurfaceSummary } from '../domain/ink-surface-summary';
import type { SnapshotAnnotationSummary } from '../domain/snapshot-annotation-summary';
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
    expect(container.textContent).toContain(
      'Select text in Reading View or capture a Snapshot to annotate.',
    );
    expect(container.querySelector('[data-inkstone-annotation-row]')).toBeNull();
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Search current file annotations"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Search current file annotations"]',
      ),
    ).toBeNull();
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
    expect(actions?.getAttribute('aria-expanded')).toBe('false');
    actions?.click();
    expect(actions?.getAttribute('aria-expanded')).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(actions?.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.querySelector('[data-obsidian-test-menu]')).toBeNull();
    actions?.click();
    document.body
      .querySelector<HTMLButtonElement>('[data-obsidian-test-menu] button[aria-label="Edit"]')
      ?.click();
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

  it('opens text annotation actions in the owner-document menu layer', () => {
    const inspected: string[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onInspect: (id, invoker) =>
        inspected.push(`${id}:${invoker.dataset.inkstoneAnnotationActions}`),
      onSelect: () => undefined,
    });
    sidebar.render(fixture());

    container
      .querySelector<HTMLButtonElement>('[data-inkstone-annotation-actions="active-1"]')
      ?.click();

    expect(container.querySelector('[data-obsidian-test-menu]')).toBeNull();
    const menu = document.body.querySelector<HTMLElement>('[data-obsidian-test-menu]');
    expect(menu).not.toBeNull();
    menu?.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')?.click();
    expect(inspected).toEqual(['active-1:active-1']);
  });

  it('requests Ink deletion from the global menu and deletes only after confirmation', async () => {
    const deleted: string[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onDeleteInk: (id) => deleted.push(id),
      onSelect: () => undefined,
    });
    sidebar.render({ groups: [], total: 0 }, undefined, [inkSummary()]);

    container.querySelector<HTMLButtonElement>('[data-inkstone-ink-actions="surface-1"]')?.click();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-obsidian-test-menu] button[aria-label="Delete Legacy Ink surface…"]',
      )
      ?.click();

    expect(deleted).toEqual([]);
    await vi.waitFor(() => {
      expect(container.querySelector('[aria-label="Confirm Legacy Ink deletion"]')).not.toBeNull();
    });
    let dialog = container.querySelector<HTMLElement>('[aria-label="Confirm Legacy Ink deletion"]');
    dialog?.querySelector<HTMLButtonElement>('button:not([aria-label])')?.click();
    expect(deleted).toEqual([]);
    container.querySelector<HTMLButtonElement>('[data-inkstone-ink-actions="surface-1"]')?.click();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-obsidian-test-menu] button[aria-label="Delete Legacy Ink surface…"]',
      )
      ?.click();
    await vi.waitFor(() => {
      expect(container.querySelector('[aria-label="Confirm Legacy Ink deletion"]')).not.toBeNull();
    });
    dialog = container.querySelector<HTMLElement>('[aria-label="Confirm Legacy Ink deletion"]');
    dialog
      ?.querySelector<HTMLButtonElement>('[aria-label="Confirm delete Legacy Ink surface"]')
      ?.click();
    expect(deleted).toEqual(['surface-1']);
  });

  it('keeps Current file menus exclusive and dismisses them outside', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const sidebar = new CurrentFileSidebar({ container, document, onSelect: () => undefined });
    sidebar.render(fixture(), undefined, [inkSummary()]);
    const inkToggle = container.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-actions="surface-1"]',
    );
    const annotationToggle = container.querySelector<HTMLButtonElement>(
      '[data-inkstone-annotation-actions="active-1"]',
    );

    inkToggle?.click();
    expect(document.body.querySelector('[data-obsidian-test-menu]')?.textContent).toContain(
      'Export SVG',
    );
    annotationToggle?.click();
    expect(inkToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.querySelector('[data-obsidian-test-menu]')?.textContent).toContain('Edit');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.body.querySelector('[data-obsidian-test-menu]')).toBeNull();
    expect(annotationToggle?.getAttribute('aria-expanded')).toBe('false');
  });

  it('offers repair directly from an unanchored row menu', () => {
    const repairs: string[] = [];
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onRepairAnnotation: (id: string, invoker: HTMLElement) =>
        repairs.push(`${id}:${invoker.dataset.inkstoneAnnotationActions}`),
      onSelect: () => undefined,
    });
    sidebar.render(fixture());

    container
      .querySelector<HTMLButtonElement>('[data-inkstone-annotation-actions="active-1"]')
      ?.click();
    expect(
      document.body.querySelector('[data-obsidian-test-menu] button[aria-label="Repair target"]'),
    ).toBeNull();

    container
      .querySelector<HTMLButtonElement>('[data-inkstone-annotation-actions="problem-1"]')
      ?.click();
    const repair = document.body.querySelector<HTMLButtonElement>(
      '[data-obsidian-test-menu] button[aria-label="Repair target"]',
    );
    expect(repair?.textContent).toContain('Repair target');
    repair?.click();

    expect(repairs).toEqual(['problem-1:problem-1']);
    expect(document.body.querySelector('[data-obsidian-test-menu]')).toBeNull();
  });

  it('deletes a text annotation from its row menu and exposes a short Restore action', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T13:42:00.000Z'));
    const deleted: string[] = [];
    const restored: string[] = [];
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onDeleteAnnotation: (id: string, revision: number) => deleted.push(`${id}:${revision}`),
      onRestoreAnnotation: (id: string, revision: number) => restored.push(`${id}:${revision}`),
      onSelect: () => undefined,
    });
    sidebar.render(fixture());

    container
      .querySelector<HTMLButtonElement>('[data-inkstone-annotation-actions="active-1"]')
      ?.click();
    document.body
      .querySelector<HTMLButtonElement>('[data-obsidian-test-menu] button[aria-label="Delete"]')
      ?.click();
    expect(deleted).toEqual(['active-1:1']);

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
    await Promise.resolve();
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
    expect(document.getElementById(original?.id ?? '')).toBe(original);
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
    container.querySelector<HTMLButtonElement>('button[aria-label="Entire Vault"]')?.click();
    expect(scopes).toEqual(['vault']);
  });

  it('uses the same row, search and header behavior in Current file selection mode', async () => {
    const navigated: string[] = [];
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onSelect: (id) => navigated.push(id),
      onSelectInk: (summary) => navigated.push(summary.id),
    });
    sidebar.render(fixture(), undefined, [inkSummary()]);

    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Search current file annotations"]',
      ),
    ).toBeNull();
    clickActionMenuItem(container, 'More actions', 'Select multiple…');
    await vi.waitFor(() =>
      expect(container.querySelector('button[aria-label="Done selecting"]')).not.toBeNull(),
    );

    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Search current file annotations"]',
      )?.disabled,
    ).toBe(true);
    expect(container.querySelector('[data-inkstone-annotation-actions]')).toBeNull();
    expect(container.querySelector('[data-inkstone-ink-actions]')).toBeNull();

    container.querySelector<HTMLButtonElement>('[data-annotation-id="active-1"]')?.click();
    container.querySelector<HTMLButtonElement>('[data-inkstone-ink-row="surface-1"]')?.click();
    expect(navigated).toEqual([]);
    await vi.waitFor(() => {
      expect(
        container
          .querySelector('[data-annotation-id="active-1"]')
          ?.closest('.inkstone-sidebar-row')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
      expect(
        container
          .querySelector('[data-inkstone-ink-row="surface-1"]')
          ?.closest('.inkstone-sidebar-ink-row')
          ?.getAttribute('aria-selected'),
      ).toBe('true');
    });

    container
      .querySelector<HTMLButtonElement>('button[aria-label="Select all annotations"]')
      ?.click();
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(
          (checkbox) => checkbox.checked,
        ),
      ).toBe(true),
    );
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Deselect all annotations"]')
      ?.click();
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(
          (checkbox) => !checkbox.checked,
        ),
      ).toBe(true),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Done selecting"]')?.click();
    await vi.waitFor(() => {
      expect(container.querySelector('input[type="checkbox"]')).toBeNull();
      expect(container.querySelector('button[aria-label="More actions"]')).not.toBeNull();
    });
  });

  it('offers Current file selections the same five bulk actions', async () => {
    const copied: unknown[] = [];
    let finishCopy: (() => void) | undefined;
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onBulkCopy: (entries) => {
        copied.push(entries);
        return new Promise<void>((resolve) => {
          finishCopy = resolve;
        });
      },
      onSelect: () => undefined,
    });
    sidebar.render(fixture(), undefined, [inkSummary()]);

    clickActionMenuItem(container, 'More actions', 'Select multiple…');
    await vi.waitFor(() =>
      expect(container.querySelector('button[aria-label="Done selecting"]')).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>('[data-annotation-id="active-1"]')?.click();

    await vi.waitFor(() => {
      expect(container.querySelector('.inkstone-bulk-action-dock')?.textContent).toContain(
        '1 selected',
      );
    });
    const actions = [
      ...container.querySelectorAll<HTMLButtonElement>('.inkstone-bulk-action-dock button'),
    ];
    expect(actions.map((button) => button.title)).toEqual([
      'Add tags',
      'Change style',
      'Copy',
      'Export',
      'Delete',
    ]);

    container.querySelector<HTMLButtonElement>('button[aria-label="Copy selected"]')?.click();
    await vi.waitFor(() => expect(copied).toHaveLength(1));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Copying…');
    expect(container.querySelector('button[aria-label="Copying…"]')).not.toBeNull();
    finishCopy?.();
    await vi.waitFor(() => {
      expect(container.querySelector('[role="status"]')?.textContent).toBe('Copied');
      expect(container.querySelector('button[aria-label="Copied"]')).not.toBeNull();
    });
  });

  it('leaves selection mode after a successful bulk delete and explains short Restore', async () => {
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onBulkDelete: () => Promise.resolve({ failed: [] }),
      onSelect: () => undefined,
    });
    sidebar.render(fixture());

    clickActionMenuItem(container, 'More actions', 'Select multiple…');
    await vi.waitFor(() =>
      expect(container.querySelector('button[aria-label="Done selecting"]')).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>('[data-annotation-id="active-1"]')?.click();
    await vi.waitFor(() =>
      expect(container.querySelector('button[aria-label="Delete selected"]')).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Delete selected"]')?.click();

    await vi.waitFor(() =>
      expect(container.querySelector('.inkstone-bulk-dialog__description')?.textContent).toBe(
        'Deleted annotations can be restored for a short time.',
      ),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Confirm bulk delete"]')?.click();

    await vi.waitFor(() => {
      expect(container.querySelector('button[aria-label="Done selecting"]')).toBeNull();
      expect(container.querySelector('input[type="checkbox"]')).toBeNull();
      expect(container.querySelector('button[aria-label="More actions"]')).not.toBeNull();
    });
  });

  it('retains failed Current file selections after a partial bulk delete', async () => {
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onBulkDelete: (selection) => Promise.resolve({ failed: selection }),
      onSelect: () => undefined,
    });
    sidebar.render(fixture());

    clickActionMenuItem(container, 'More actions', 'Select multiple…');
    await vi.waitFor(() =>
      expect(container.querySelector('button[aria-label="Done selecting"]')).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>('[data-annotation-id="active-1"]')?.click();
    await vi.waitFor(() =>
      expect(container.querySelector('button[aria-label="Delete selected"]')).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Delete selected"]')?.click();
    await vi.waitFor(() =>
      expect(container.querySelector('button[aria-label="Confirm bulk delete"]')).not.toBeNull(),
    );
    container.querySelector<HTMLButtonElement>('button[aria-label="Confirm bulk delete"]')?.click();

    await vi.waitFor(() => {
      expect(container.querySelector('button[aria-label="Done selecting"]')).not.toBeNull();
      expect(
        container.querySelector<HTMLInputElement>('input[aria-label="Select annotation active-1"]')
          ?.checked,
      ).toBe(true);
      expect(container.textContent).toContain('1 selected');
    });
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

    container.querySelector<HTMLButtonElement>('button[aria-label="Entire Vault"]')?.click();
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
    container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')?.click();
    document.body
      .querySelector<HTMLButtonElement>(
        '[data-obsidian-test-menu] button[aria-label="Export current file…"]',
      )
      ?.click();
    expect(exports).toEqual(['current-file']);

    sidebar.render({ groups: [], total: 0 });
    container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')?.click();
    expect(
      document.body.querySelector<HTMLButtonElement>(
        '[data-obsidian-test-menu] button[aria-label="Export current file…"]',
      )?.disabled,
    ).toBe(true);
  });

  it('renders Ink thumbnail metadata and routes locate/edit/delete/restore without loading vectors', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:01:03.000Z'));
    const actions: string[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onDeleteInk: (id, expectedRevision) => actions.push(`delete:${id}@${expectedRevision}`),
      onExportInkPng: (id) => actions.push(`png:${id}`),
      onExportInkSvg: (id) => actions.push(`svg:${id}`),
      onRestoreInk: (id, expectedRevision) => actions.push(`restore:${id}@${expectedRevision}`),
      onSelect: () => undefined,
      onSelectInk: (summary) => actions.push(`select:${summary.id}`),
    });

    sidebar.render({ groups: [], total: 0 }, undefined, [inkSummary(), deletedInkSummary()]);

    expect(container.querySelector('[data-inkstone-ink-thumbnail]')?.getAttribute('src')).toContain(
      'data:image/svg+xml',
    );
    expect(container.textContent).toContain('Legacy Ink');
    expect(container.textContent).toContain('2 strokes');
    container.querySelector<HTMLButtonElement>('[data-inkstone-ink-row="surface-1"]')?.click();
    const menuToggle = container.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-actions="surface-1"]',
    );
    expect(menuToggle).not.toBeNull();
    expect(
      container.querySelectorAll('.inkstone-sidebar-ink-row__actions > .inkstone-icon-button'),
    ).toHaveLength(2);
    menuToggle?.click();
    expect(menuToggle?.getAttribute('aria-expanded')).toBe('true');
    let menu = document.body.querySelector<HTMLElement>('[data-obsidian-test-menu]');
    expect(menu?.textContent).not.toContain('Edit');
    expect(menu?.textContent).toContain('Export SVG');
    expect(menu?.textContent).toContain('Export PNG');
    expect(menu?.textContent).toContain('Delete Legacy Ink surface');
    menu?.querySelector<HTMLButtonElement>('button[aria-label="Export SVG"]')?.click();
    menuToggle?.click();
    menu = document.body.querySelector<HTMLElement>('[data-obsidian-test-menu]');
    menu?.querySelector<HTMLButtonElement>('button[aria-label="Export PNG"]')?.click();
    menuToggle?.click();
    menu = document.body.querySelector<HTMLElement>('[data-obsidian-test-menu]');
    menu
      ?.querySelector<HTMLButtonElement>('button[aria-label="Delete Legacy Ink surface…"]')
      ?.click();
    expect(actions).toEqual(['select:surface-1', 'svg:surface-1', 'png:surface-1']);
    await vi.waitFor(() => {
      expect(container.querySelector('[aria-label="Confirm Legacy Ink deletion"]')).not.toBeNull();
    });
    container
      .querySelector<HTMLButtonElement>('[aria-label="Confirm delete Legacy Ink surface"]')
      ?.click();
    container.querySelector<HTMLButtonElement>('[data-inkstone-ink-restore="surface-2"]')?.click();
    expect(actions).toEqual([
      'select:surface-1',
      'svg:surface-1',
      'png:surface-1',
      'delete:surface-1@2',
      'restore:surface-2@2',
    ]);
  });

  it('removes a deleted Ink restore row five seconds after its tombstone time', async () => {
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
    await Promise.resolve();

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

  it('renders each Snapshot as an aspect-ratio preview card with actions in one menu', () => {
    const container = document.createElement('div');
    const source = vi.fn();
    const preview = vi.fn();
    const edit = vi.fn();
    const exported = vi.fn();
    const deleted = vi.fn();
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onDeleteSnapshot: deleted,
      onEditSnapshot: edit,
      onExportSnapshot: exported,
      onPreviewSnapshot: preview,
      onSelect: () => undefined,
      onSelectSnapshotSource: source,
    });
    sidebar.render({ groups: [], total: 0 }, undefined, [], [snapshotSummary()]);

    expect(container.querySelector('[data-inkstone-snapshot-id="snapshot-a"]')).not.toBeNull();
    expect(container.textContent).toContain('3 strokes');
    expect(
      container.querySelector<HTMLElement>('[data-inkstone-snapshot-id="snapshot-a"]')?.style
        .aspectRatio,
    ).toBe('300 / 200');
    expect(container.querySelector('[aria-label="Edit Snapshot"]')).toBeNull();
    expect(container.querySelector('[aria-label="Export Snapshot PNG"]')).toBeNull();
    expect(container.querySelector('[aria-label="Delete Snapshot"]')).toBeNull();

    container.querySelector<HTMLButtonElement>('[aria-label^="Preview Snapshot"]')?.click();
    const strokeCount = container.querySelector<HTMLElement>('[data-inkstone-snapshot-strokes]');
    expect(strokeCount?.tagName).toBe('SPAN');
    expect(container.querySelector('[aria-label^="Jump to Snapshot source"]')).toBeNull();
    strokeCount?.click();
    expect(source).not.toHaveBeenCalled();
    clickActionMenuItem(
      container,
      'Open actions for Snapshot captured 2026-07-22T00:00:00.000Z',
      'Go to source',
    );
    clickActionMenuItem(
      container,
      'Open actions for Snapshot captured 2026-07-22T00:00:00.000Z',
      'Edit Snapshot',
    );
    clickActionMenuItem(
      container,
      'Open actions for Snapshot captured 2026-07-22T00:00:00.000Z',
      'Export Snapshot PNG',
    );
    clickActionMenuItem(
      container,
      'Open actions for Snapshot captured 2026-07-22T00:00:00.000Z',
      'Delete Snapshot',
    );
    expect(preview).toHaveBeenCalledOnce();
    expect(source).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();
    expect(exported).toHaveBeenCalledOnce();
    expect(deleted).toHaveBeenCalledOnce();
  });

  it('groups Snapshot cards into one masonry surface per heading', () => {
    const container = document.createElement('div');
    const sidebar = new CurrentFileSidebar({
      container,
      document,
      onSelect: () => undefined,
    });
    sidebar.render(
      { groups: [], total: 0 },
      undefined,
      [],
      [snapshotSummary(), { ...snapshotSummary(), id: 'snapshot-b' }],
    );

    const masonry = container.querySelector('[data-inkstone-snapshot-masonry]');
    expect(masonry).not.toBeNull();
    expect(masonry?.querySelectorAll('[data-inkstone-snapshot-id]')).toHaveLength(2);
  });
});

function clickActionMenuItem(
  container: HTMLElement,
  triggerLabel: string,
  itemLabel: string,
): void {
  const trigger = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === triggerLabel,
  );
  if (trigger === undefined) throw new Error(`Expected menu trigger: ${triggerLabel}`);
  trigger.click();
  const item = [
    ...document.body.querySelectorAll<HTMLButtonElement>('[data-obsidian-test-menu] button'),
  ].find((button) => button.getAttribute('aria-label') === itemLabel);
  if (item === undefined) throw new Error(`Expected menu item: ${itemLabel}`);
  item.click();
}

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

function snapshotSummary(): SnapshotAnnotationSummary {
  return {
    capturedAt: '2026-07-22T00:00:00.000Z',
    filePath: 'Notes/Test.md',
    headingPath: ['Test'],
    id: 'snapshot-a',
    linkState: 'linked',
    logicalHeight: 200,
    logicalWidth: 300,
    revision: 1,
    sourceOrder: 10,
    status: 'active',
    strokeCount: 3,
    thumbnailKey: 'snapshot:a:1',
    updatedAt: '2026-07-22T00:00:00.000Z',
  };
}
