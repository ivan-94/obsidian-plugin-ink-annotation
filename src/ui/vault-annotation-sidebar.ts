import type {
  AnnotationIndexEntry,
  VaultAnnotationFilters,
  VaultAnnotationIndex,
} from '../domain/vault-annotation-index';
import { createDismissibleMenu } from './dismissible-menu';
import { createIcon, createIconButton, createIconStatus } from './icon-button';

const VAULT_GROUP_HEIGHT = 42;
const VAULT_ROW_HEIGHT = 66;

export class VaultAnnotationSidebar {
  private readonly collapsedGroups = new Set<string>();
  private readonly container: HTMLElement;
  private readonly document: Document;
  private readonly index: VaultAnnotationIndex;
  private readonly onCurrentFile: () => void | Promise<void>;
  private readonly onBulkAddTags: (
    selection: readonly BulkSelectionSnapshot[],
    tags: readonly string[],
  ) => Promise<BulkOutcome>;
  private readonly onBulkChangeStyle: (
    selection: readonly BulkSelectionSnapshot[],
    styleId: string,
  ) => Promise<BulkOutcome>;
  private readonly onBulkCopy: (entries: readonly AnnotationIndexEntry[]) => Promise<void>;
  private readonly onBulkDelete: (selection: readonly BulkSelectionSnapshot[]) => Promise<{
    readonly failed: readonly BulkSelectionSnapshot[];
  }>;
  private readonly onEdit:
    ((entry: AnnotationIndexEntry, invoker: HTMLElement) => void) | undefined;
  private readonly onOpen: (entry: AnnotationIndexEntry, invoker: HTMLElement) => void;
  private readonly onExport: (
    entries: readonly AnnotationIndexEntry[],
    invoker: HTMLElement,
  ) => void;
  private readonly styleOptions: readonly SelectOption[];

  constructor(input: {
    readonly container: HTMLElement;
    readonly document: Document;
    readonly index: VaultAnnotationIndex;
    readonly onBulkAddTags?: (
      selection: readonly BulkSelectionSnapshot[],
      tags: readonly string[],
    ) => Promise<BulkOutcome>;
    readonly onBulkChangeStyle?: (
      selection: readonly BulkSelectionSnapshot[],
      styleId: string,
    ) => Promise<BulkOutcome>;
    readonly onBulkCopy?: (entries: readonly AnnotationIndexEntry[]) => Promise<void>;
    readonly onBulkDelete?: (selection: readonly BulkSelectionSnapshot[]) => Promise<{
      readonly failed: readonly BulkSelectionSnapshot[];
    }>;
    readonly onCurrentFile?: () => void | Promise<void>;
    readonly onEdit?: (entry: AnnotationIndexEntry, invoker: HTMLElement) => void;
    readonly onExport?: (entries: readonly AnnotationIndexEntry[], invoker: HTMLElement) => void;
    readonly onOpen?: (entry: AnnotationIndexEntry, invoker: HTMLElement) => void;
    readonly styleOptions?: readonly SelectOption[];
  }) {
    this.container = input.container;
    this.document = input.document;
    this.index = input.index;
    this.onBulkAddTags = input.onBulkAddTags ?? (() => Promise.resolve({ failed: [] }));
    this.onBulkChangeStyle = input.onBulkChangeStyle ?? (() => Promise.resolve({ failed: [] }));
    this.onBulkCopy = input.onBulkCopy ?? (() => Promise.resolve());
    this.onBulkDelete = input.onBulkDelete ?? (() => Promise.resolve({ failed: [] }));
    this.onCurrentFile = input.onCurrentFile ?? (() => undefined);
    this.onEdit = input.onEdit;
    this.onExport = input.onExport ?? (() => undefined);
    this.onOpen = input.onOpen ?? (() => undefined);
    this.styleOptions = input.styleOptions ?? [];
  }

  showBuilding(progress: { readonly completed: number; readonly total: number }): void {
    this.container.replaceChildren();
    this.container.classList.add('inkstone-sidebar');
    this.container.classList.remove('inkstone-sidebar--vault');
    this.container.append(this.createScope());
    const status = this.document.createElement('p');
    status.dataset.inkstoneVaultState = 'building';
    status.textContent = `Index building ${progress.completed} of ${progress.total}`;
    this.container.append(status);
  }

  showReady(): void {
    this.container.replaceChildren();
    this.container.classList.add('inkstone-sidebar');
    this.container.classList.add('inkstone-sidebar--vault');
    const header = this.document.createElement('header');
    header.className = 'inkstone-sidebar__header';
    const scope = this.createScope();
    const headerActions = this.document.createElement('div');
    headerActions.className = 'inkstone-sidebar__header-actions';
    const sync = createIconStatus(this.document, {
      icon: 'cloud-off',
      label: 'Sync status unavailable',
    });
    sync.classList.add('inkstone-visually-hidden');
    const refresh = createIconButton(this.document, {
      icon: 'refresh-cw',
      label: 'Refresh annotation index',
    });
    refresh.addEventListener('click', () => this.showReady());
    const more = createIconButton(this.document, { icon: 'ellipsis', label: 'More actions' });
    more.setAttribute('aria-haspopup', 'menu');
    const headerMenu = this.document.createElement('div');
    headerMenu.className = 'inkstone-sidebar__overflow-menu';
    headerMenu.hidden = true;
    headerMenu.setAttribute('role', 'menu');
    const headerMenuController = createDismissibleMenu({
      document: this.document,
      menu: headerMenu,
      trigger: more,
    });
    more.addEventListener('click', headerMenuController.toggle);
    headerActions.append(sync, refresh, more);
    header.append(scope, headerActions, headerMenu);
    this.container.append(header);
    const search = this.document.createElement('input');
    search.type = 'search';
    search.setAttribute('aria-label', 'Search annotations');
    const annotationCount = this.index.snapshot().length;
    search.placeholder = `Search ${annotationCount.toLocaleString()} ${annotationCount === 1 ? 'annotation' : 'annotations'}…`;
    const toolbar = this.document.createElement('div');
    toolbar.className = 'inkstone-vault-toolbar';
    const searchField = this.document.createElement('label');
    searchField.className = 'inkstone-vault-search';
    searchField.append(createIcon(this.document, 'search'), search);
    const filterToggle = createIconButton(this.document, {
      icon: 'list-filter',
      label: 'Filter annotations',
      text: 'All',
    });
    filterToggle.classList.add('inkstone-vault-filter-toggle');
    filterToggle.setAttribute('aria-haspopup', 'true');
    const sort = createIconButton(this.document, {
      icon: 'arrow-up-down',
      label: 'Sort: Document order',
    });
    let newestFirst = false;
    sort.addEventListener('click', () => {
      newestFirst = !newestFirst;
      sort.setAttribute('aria-label', newestFirst ? 'Sort: Updated' : 'Sort: Document order');
      sort.title = sort.getAttribute('aria-label') ?? '';
      renderResults();
    });
    toolbar.append(searchField, filterToggle, sort);
    const filterBar = this.document.createElement('div');
    filterBar.className = 'inkstone-vault-filters';
    const entries = this.index.snapshot();
    const typeFilter = createSelect(this.document, 'Filter by type', [
      ['', 'All types'],
      ['highlight', 'Highlight'],
      ['underline', 'Underline'],
      ['note', 'Note'],
      ['ink', 'Ink'],
    ]);
    const tagFilter = createSelect(this.document, 'Filter by tag', [
      ['', 'All tags'],
      ...uniqueOptions(entries.flatMap((entry) => entry.tags)),
    ]);
    const statusFilter = createSelect(this.document, 'Filter by status', [
      ['', 'All statuses'],
      ['active', 'Active'],
      ['draft', 'Draft'],
      ['resolved', 'Resolved'],
      ['unanchored', 'Unanchored'],
      ['needs-rebase', 'Needs rebase'],
    ]);
    const styleFilter = createSelect(this.document, 'Filter by style', [
      ['', 'All styles'],
      ...uniqueOptions(
        entries.flatMap((entry) =>
          entry.styleId === undefined
            ? []
            : [[entry.styleId, entry.styleName ?? entry.styleId] as const],
        ),
      ),
    ]);
    const folderFilter = createSelect(this.document, 'Filter by folder', [
      ['', 'All folders'],
      ...uniqueOptions(
        entries.flatMap((entry) => {
          const separator = entry.filePath.lastIndexOf('/');
          return separator < 0 ? [] : [entry.filePath.slice(0, separator)];
        }),
      ),
    ]);
    const noteFilter = createSelect(this.document, 'Filter by note', [
      ['', 'All notes'],
      ...uniqueOptions(entries.map((entry) => [entry.noteId, entry.filePath] as const)),
    ]);
    const updatedAfter = this.document.createElement('input');
    updatedAfter.type = 'date';
    updatedAfter.setAttribute('aria-label', 'Updated after');
    const updatedBefore = this.document.createElement('input');
    updatedBefore.type = 'date';
    updatedBefore.setAttribute('aria-label', 'Updated before');
    const chips = this.document.createElement('div');
    chips.className = 'inkstone-vault-filter-chips';
    filterBar.append(
      typeFilter,
      tagFilter,
      statusFilter,
      styleFilter,
      folderFilter,
      noteFilter,
      updatedAfter,
      updatedBefore,
    );
    filterBar.classList.add('inkstone-vault-filters--popover');
    filterBar.hidden = true;
    filterBar.setAttribute('aria-label', 'Annotation filters');
    filterBar.setAttribute('role', 'group');
    const filterMenuController = createDismissibleMenu({
      document: this.document,
      menu: filterBar,
      trigger: filterToggle,
    });
    filterToggle.addEventListener('click', () => {
      if (filterMenuController.toggle()) typeFilter.focus({ preventScroll: true });
    });
    const results = this.document.createElement('div');
    results.className = 'inkstone-vault-results';
    results.dataset.inkstoneVaultResults = '';
    let bulkMode = false;
    const selected = new Map<string, AnnotationIndexEntry>();
    const bulkBar = this.document.createElement('div');
    bulkBar.className = 'inkstone-vault-bulk-bar';
    const bulkToggle = createIconButton(this.document, {
      icon: 'list-checks',
      label: 'Enter bulk mode',
      text: 'Select multiple…',
    });
    const exportResults = createIconButton(this.document, {
      icon: 'share',
      label: 'Export current results',
      text: 'Export results…',
    });
    bulkToggle.setAttribute('role', 'menuitem');
    exportResults.setAttribute('role', 'menuitem');
    headerMenu.append(bulkToggle, exportResults);
    const bulkActions = this.document.createElement('div');
    bulkActions.hidden = true;
    const selectionStatus = this.document.createElement('span');
    const deleteSelected = createIconButton(this.document, {
      danger: true,
      icon: 'trash-2',
      label: 'Delete selected',
      text: 'Delete',
    });
    const tagSelected = createIconButton(this.document, {
      icon: 'tag',
      label: 'Tag selected',
      text: 'Add tags',
    });
    const styleSelected = createIconButton(this.document, {
      icon: 'scan-text',
      label: 'Style selected',
      text: 'Change style',
    });
    const copySelected = createIconButton(this.document, {
      icon: 'copy',
      label: 'Copy selected',
      text: 'Copy',
    });
    const exportSelected = createIconButton(this.document, {
      icon: 'share',
      label: 'Export selected',
      text: 'Export',
    });
    bulkActions.append(
      selectionStatus,
      tagSelected,
      styleSelected,
      copySelected,
      exportSelected,
      deleteSelected,
    );
    bulkBar.append(bulkActions);
    const currentFilters = (): VaultAnnotationFilters => ({
      ...(folderFilter.value.length === 0 ? {} : { folders: [folderFilter.value] }),
      ...(noteFilter.value.length === 0 ? {} : { noteIds: [noteFilter.value] }),
      ...(statusFilter.value.length === 0
        ? {}
        : { statuses: [statusFilter.value as AnnotationIndexEntry['status']] }),
      ...(styleFilter.value.length === 0 ? {} : { styleIds: [styleFilter.value] }),
      ...(tagFilter.value.length === 0 ? {} : { tags: [tagFilter.value] }),
      ...(typeFilter.value.length === 0
        ? {}
        : { types: [typeFilter.value as AnnotationIndexEntry['type']] }),
      ...(updatedAfter.value.length === 0
        ? {}
        : { updatedAfter: `${updatedAfter.value}T00:00:00.000Z` }),
      ...(updatedBefore.value.length === 0
        ? {}
        : { updatedBefore: `${updatedBefore.value}T23:59:59.999Z` }),
    });
    const renderChips = (): void => {
      chips.replaceChildren();
      let activeCount = 0;
      for (const [name, label, select] of [
        ['type', 'Type', typeFilter],
        ['tag', 'Tag', tagFilter],
        ['status', 'Status', statusFilter],
        ['style', 'Style', styleFilter],
        ['folder', 'Folder', folderFilter],
        ['note', 'Note', noteFilter],
      ] as const) {
        if (select.value.length === 0) {
          continue;
        }
        activeCount += 1;
        const chip = this.document.createElement('button');
        chip.type = 'button';
        chip.setAttribute('aria-label', `Remove ${name} filter`);
        chip.textContent = `${label}: ${select.selectedOptions[0]?.textContent ?? select.value} ×`;
        chip.addEventListener('click', () => {
          select.value = '';
          renderChips();
          renderResults();
        });
        chips.append(chip);
      }
      for (const [name, label, input] of [
        ['updated-after', 'After', updatedAfter],
        ['updated-before', 'Before', updatedBefore],
      ] as const) {
        if (input.value.length === 0) {
          continue;
        }
        activeCount += 1;
        const chip = this.document.createElement('button');
        chip.type = 'button';
        chip.setAttribute('aria-label', `Remove ${name} filter`);
        chip.textContent = `${label}: ${input.value} ×`;
        chip.addEventListener('click', () => {
          input.value = '';
          renderChips();
          renderResults();
        });
        chips.append(chip);
      }
      const label = filterToggle.querySelector<HTMLElement>('.inkstone-icon-button__label');
      if (label !== null) {
        label.textContent =
          activeCount === 0
            ? 'All'
            : typeFilter.value.length > 0 && activeCount === 1
              ? (typeFilter.selectedOptions[0]?.textContent ?? 'Filtered')
              : `${activeCount} filters`;
      }
    };
    const updateBulkBar = (): void => {
      bulkActions.hidden = !bulkMode;
      bulkBar.hidden = !bulkMode;
      selectionStatus.textContent = `${selected.size} selected`;
      for (const action of [copySelected, exportSelected, deleteSelected]) {
        action.disabled = selected.size === 0;
      }
      const hasInk = [...selected.values()].some((entry) => entry.type === 'ink');
      tagSelected.disabled = selected.size === 0 || hasInk;
      styleSelected.disabled = selected.size === 0 || hasInk;
      tagSelected.title = hasInk ? 'Tags are available for text annotations only.' : '';
      styleSelected.title = hasInk ? 'Styles are available for text annotations only.' : '';
    };
    const renderResults = (): void =>
      this.renderResults(
        results,
        search.value,
        currentFilters(),
        {
          bulkMode,
          onSelectionChange: (entry, checked) => {
            const key = `${entry.noteId}\u0000${entry.id}`;
            if (checked) {
              selected.set(key, entry);
            } else {
              selected.delete(key);
            }
            updateBulkBar();
          },
          selected,
        },
        newestFirst,
      );
    search.addEventListener('input', renderResults);
    for (const select of [
      typeFilter,
      tagFilter,
      statusFilter,
      styleFilter,
      folderFilter,
      noteFilter,
    ]) {
      select.addEventListener('change', () => {
        renderChips();
        renderResults();
      });
    }
    for (const input of [updatedAfter, updatedBefore]) {
      input.addEventListener('change', () => {
        renderChips();
        renderResults();
      });
    }
    bulkToggle.addEventListener('click', () => {
      bulkMode = !bulkMode;
      bulkToggle.setAttribute('aria-label', bulkMode ? 'Exit bulk mode' : 'Enter bulk mode');
      const label = bulkToggle.querySelector<HTMLElement>('.inkstone-icon-button__label');
      if (label !== null) label.textContent = bulkMode ? 'Done selecting' : 'Select multiple…';
      headerMenuController.close();
      if (!bulkMode) {
        selected.clear();
      }
      updateBulkBar();
      renderResults();
    });
    exportResults.addEventListener('click', () => {
      headerMenuController.close();
      const result = this.index.query({ filters: currentFilters(), text: search.value });
      this.onExport(
        result.groups.flatMap((group) => group.rows),
        exportResults,
      );
    });
    const retainFailed = (outcome: BulkOutcome): void => {
      selected.clear();
      for (const failed of outcome.failed) {
        const entry = this.index
          .snapshot()
          .find(
            (candidate) =>
              candidate.noteId === failed.noteId &&
              candidate.id === failed.id &&
              candidate.type === failed.type,
          );
        if (entry !== undefined) {
          selected.set(`${entry.noteId}\u0000${entry.id}`, entry);
        }
      }
      updateBulkBar();
      renderResults();
    };
    tagSelected.addEventListener('click', () => {
      const snapshot = [...selected.values()].map(toBulkSnapshot);
      if (snapshot.length === 0) {
        return;
      }
      const dialog = this.document.createElement('div');
      dialog.setAttribute('aria-label', 'Add tags to selected annotations');
      dialog.setAttribute('role', 'dialog');
      const input = this.document.createElement('input');
      input.type = 'text';
      input.setAttribute('aria-label', 'Bulk tags');
      input.placeholder = 'Tags, separated by commas';
      const apply = this.document.createElement('button');
      apply.type = 'button';
      apply.setAttribute('aria-label', 'Apply bulk tags');
      apply.textContent = 'Apply';
      apply.addEventListener('click', () => {
        const tags = input.value
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
        if (tags.length === 0) {
          return;
        }
        apply.disabled = true;
        void this.onBulkAddTags(snapshot, tags).then((outcome) => {
          dialog.remove();
          retainFailed(outcome);
        });
      });
      const cancel = this.document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => dialog.remove());
      dialog.append(input, apply, cancel);
      this.container.append(dialog);
      input.focus({ preventScroll: true });
    });
    styleSelected.addEventListener('click', () => {
      const snapshot = [...selected.values()].map(toBulkSnapshot);
      const styles = uniqueOptions(
        this.styleOptions.length > 0
          ? this.styleOptions
          : this.index
              .snapshot()
              .flatMap((entry) =>
                entry.styleId === undefined
                  ? []
                  : [[entry.styleId, entry.styleName ?? entry.styleId] as const],
              ),
      );
      if (snapshot.length === 0 || styles.length === 0) {
        return;
      }
      const dialog = this.document.createElement('div');
      dialog.setAttribute('aria-label', 'Change style for selected annotations');
      dialog.setAttribute('role', 'dialog');
      const style = createSelect(this.document, 'Bulk style', styles);
      const apply = this.document.createElement('button');
      apply.type = 'button';
      apply.setAttribute('aria-label', 'Apply bulk style');
      apply.textContent = 'Apply';
      apply.addEventListener('click', () => {
        apply.disabled = true;
        void this.onBulkChangeStyle(snapshot, style.value).then((outcome) => {
          dialog.remove();
          retainFailed(outcome);
        });
      });
      const cancel = this.document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => dialog.remove());
      dialog.append(style, apply, cancel);
      this.container.append(dialog);
      style.focus({ preventScroll: true });
    });
    copySelected.addEventListener('click', () => {
      void this.onBulkCopy([...selected.values()]);
    });
    exportSelected.addEventListener('click', () => {
      this.onExport([...selected.values()], exportSelected);
    });
    deleteSelected.addEventListener('click', () => {
      const snapshot = [...selected.values()].map(toBulkSnapshot);
      if (snapshot.length === 0) {
        return;
      }
      const dialog = this.document.createElement('div');
      dialog.setAttribute('aria-label', 'Confirm bulk deletion');
      dialog.setAttribute('role', 'dialog');
      const message = this.document.createElement('p');
      message.textContent = `Delete ${snapshot.length} ${snapshot.length === 1 ? 'annotation' : 'annotations'}?`;
      const confirm = this.document.createElement('button');
      confirm.type = 'button';
      confirm.setAttribute('aria-label', 'Confirm bulk delete');
      confirm.textContent = 'Delete';
      const cancel = this.document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => dialog.remove());
      confirm.addEventListener('click', () => {
        confirm.disabled = true;
        void this.onBulkDelete(snapshot).then((outcome) => {
          selected.clear();
          for (const failed of outcome.failed) {
            const entry = this.index
              .snapshot()
              .find(
                (candidate) =>
                  candidate.noteId === failed.noteId &&
                  candidate.id === failed.id &&
                  candidate.type === failed.type,
              );
            if (entry !== undefined) {
              selected.set(`${entry.noteId}\u0000${entry.id}`, entry);
            }
          }
          dialog.remove();
          updateBulkBar();
          renderResults();
        });
      });
      dialog.append(message, confirm, cancel);
      this.container.append(dialog);
      confirm.focus({ preventScroll: true });
    });
    this.container.append(toolbar, filterBar, chips, results, bulkBar);
    updateBulkBar();
    renderResults();
  }

  showUnavailable(message = 'Index unavailable'): void {
    this.container.replaceChildren();
    this.container.classList.add('inkstone-sidebar');
    this.container.classList.remove('inkstone-sidebar--vault');
    this.container.append(this.createScope());
    const status = this.document.createElement('p');
    status.dataset.inkstoneVaultState = 'unavailable';
    status.setAttribute('role', 'alert');
    status.textContent = message;
    this.container.append(status);
  }

  private createScope(): HTMLElement {
    const scope = this.document.createElement('div');
    scope.className = 'inkstone-sidebar__scope';
    scope.setAttribute('aria-label', 'Annotation scope');
    scope.setAttribute('role', 'tablist');
    const current = this.document.createElement('button');
    current.type = 'button';
    current.textContent = 'Current file';
    current.setAttribute('role', 'tab');
    current.setAttribute('aria-pressed', 'false');
    current.setAttribute('aria-selected', 'false');
    current.addEventListener('click', () => {
      const switched = this.onCurrentFile();
      void Promise.resolve(switched).then(() => focusActiveScopeButton(this.container));
    });
    const entire = this.document.createElement('button');
    entire.type = 'button';
    entire.textContent = 'Entire Vault';
    entire.setAttribute('role', 'tab');
    entire.setAttribute('aria-pressed', 'true');
    entire.setAttribute('aria-selected', 'true');
    scope.append(current, entire);
    return scope;
  }

  private renderResults(
    container: HTMLElement,
    text: string,
    filters: VaultAnnotationFilters = {},
    bulk: BulkRenderState = {
      bulkMode: false,
      onSelectionChange: () => undefined,
      selected: new Map(),
    },
    newestFirst = false,
  ): void {
    container.replaceChildren();
    const result = this.index.query({ filters, text });
    if (result.state !== 'ready') {
      const empty = this.document.createElement('p');
      empty.className = 'inkstone-sidebar__empty';
      empty.dataset.inkstoneVaultState = result.state;
      empty.textContent =
        result.state === 'no-annotations' ? 'No annotations' : 'No matching results';
      container.append(empty);
      return;
    }
    const groups = [...result.groups]
      .map((group) => ({
        ...group,
        rows: newestFirst
          ? [...group.rows].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          : group.rows,
      }))
      .sort((left, right) => {
        if (!newestFirst) return left.filePath.localeCompare(right.filePath);
        return (
          (right.rows[0]?.updatedAt ?? '').localeCompare(left.rows[0]?.updatedAt ?? '') ||
          left.filePath.localeCompare(right.filePath)
        );
      });
    const items: VaultVirtualItem[] = groups.flatMap((group) => [
      { filePath: group.filePath, kind: 'group' as const, total: group.rows.length },
      ...(this.collapsedGroups.has(group.filePath)
        ? []
        : group.rows.map((entry) => ({ entry, kind: 'row' as const }))),
    ]);
    const offsets = [0];
    for (const item of items) {
      offsets.push(
        (offsets.at(-1) ?? 0) + (item.kind === 'group' ? VAULT_GROUP_HEIGHT : VAULT_ROW_HEIGHT),
      );
    }
    const viewport = this.document.createElement('div');
    viewport.className = 'inkstone-vault-virtual-list';
    viewport.style.overflowY = 'auto';
    viewport.style.height = '100%';
    const total = this.document.createElement('div');
    total.dataset.inkstoneVirtualTotal = '';
    const contentHeight = offsets.at(-1) ?? 0;
    total.style.height = `calc(${contentHeight}px + var(--inkstone-vault-bottom-safe-area))`;
    total.style.position = 'relative';
    const visible = this.document.createElement('div');
    visible.style.left = '0';
    visible.style.position = 'absolute';
    visible.style.right = '0';
    const bottomSpacer = this.document.createElement('div');
    bottomSpacer.className = 'inkstone-vault-scroll-spacer';
    bottomSpacer.dataset.inkstoneVaultBottomSpacer = '';
    bottomSpacer.setAttribute('aria-hidden', 'true');
    bottomSpacer.style.height = 'var(--inkstone-vault-bottom-safe-area)';
    bottomSpacer.style.top = `${contentHeight}px`;
    total.append(visible, bottomSpacer);
    viewport.append(total);
    container.append(viewport);

    const renderWindow = (): void => {
      const viewportHeight = viewport.clientHeight || 560;
      const overscanPixels = 180;
      const start = offsetIndex(offsets, Math.max(0, viewport.scrollTop - overscanPixels));
      let end = start;
      const visibleBottom = viewport.scrollTop + viewportHeight + overscanPixels;
      while (end < items.length && (offsets[end] ?? 0) < visibleBottom) end += 1;
      visible.replaceChildren();
      visible.style.transform = `translateY(${offsets[start] ?? 0}px)`;
      for (let index = start; index < end; index += 1) {
        const item = items[index];
        if (item === undefined) continue;
        if (item.kind === 'group') {
          const group = this.document.createElement('button');
          group.type = 'button';
          group.className = 'inkstone-vault-group-header';
          group.dataset.noteGroup = item.filePath;
          group.style.height = `${VAULT_GROUP_HEIGHT}px`;
          group.setAttribute('aria-expanded', String(!this.collapsedGroups.has(item.filePath)));
          group.append(createIcon(this.document, 'file-text'));
          const name = this.document.createElement('strong');
          name.textContent = item.filePath;
          name.title = item.filePath;
          const count = this.document.createElement('span');
          count.className = 'inkstone-vault-group-header__count';
          count.textContent = String(item.total);
          group.append(name, count, createIcon(this.document, 'chevron-down'));
          group.addEventListener('click', () => {
            if (this.collapsedGroups.has(item.filePath)) this.collapsedGroups.delete(item.filePath);
            else this.collapsedGroups.add(item.filePath);
            this.renderResults(container, text, filters, bulk, newestFirst);
          });
          visible.append(group);
          continue;
        }
        const entry = item.entry;
        const wrapper = this.document.createElement('div');
        wrapper.className = 'inkstone-vault-row';
        wrapper.dataset.noteGroup = entry.filePath;
        wrapper.dataset.inkstoneEntryType = entry.type;
        wrapper.dataset.inkstoneEntryStatus = entry.conflict ? 'conflict' : entry.status;
        wrapper.style.height = `${VAULT_ROW_HEIGHT}px`;
        wrapper.append(
          createIcon(this.document, entryIcon(entry), 'inkstone-vault-row__type-icon'),
        );
        if (bulk.bulkMode) {
          const checkbox = this.document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.setAttribute('aria-label', `Select annotation ${entry.id}`);
          checkbox.checked = bulk.selected.has(`${entry.noteId}\u0000${entry.id}`);
          checkbox.addEventListener('click', () => bulk.onSelectionChange(entry, checkbox.checked));
          wrapper.append(checkbox);
        }
        const row = this.document.createElement('button');
        row.type = 'button';
        row.className = 'inkstone-sidebar-row__summary';
        row.dataset.annotationId = entry.id;
        const quote = this.document.createElement('span');
        quote.className = 'inkstone-vault-row__quote';
        quote.textContent = entry.quote;
        quote.title = entry.quote;
        const metadata = this.document.createElement('span');
        metadata.className = 'inkstone-vault-row__metadata';
        const metadataParts: Array<{ readonly label: string; readonly warning?: boolean }> = [];
        if (entry.type !== 'ink') {
          metadataParts.push({ label: formatStatus(entry.type) });
        }
        if (entry.tags[0] !== undefined) {
          metadataParts.push({ label: `#${entry.tags[0]}` });
        }
        if (entry.conflict) {
          metadataParts.push({ label: 'Conflict', warning: true });
        }
        if (entry.status !== 'active') {
          metadataParts.push({
            label: formatStatus(entry.status),
            warning: entry.status === 'unanchored' || entry.status === 'needs-rebase',
          });
        }
        metadataParts.push({ label: formatCompactTimestamp(entry.updatedAt) });
        for (const part of metadataParts) {
          const item = this.document.createElement('span');
          item.textContent = part.label;
          if (part.warning === true) item.classList.add('inkstone-vault-row__metadata--warning');
          metadata.append(item);
        }
        metadata.title = metadataParts.map((part) => part.label).join(' · ');
        row.append(quote, metadata);
        row.addEventListener('click', () => this.onOpen(entry, row));
        const actions = createIconButton(this.document, {
          icon: 'ellipsis',
          label: `Open actions for ${entry.quote}`,
        });
        actions.dataset.inkstoneVaultActions = entry.id;
        actions.setAttribute('aria-haspopup', 'menu');
        const menu = this.document.createElement('div');
        menu.className = 'inkstone-vault-row__menu';
        menu.dataset.inkstoneVaultMenu = entry.id;
        menu.hidden = true;
        menu.setAttribute('role', 'menu');
        const menuController = createDismissibleMenu({
          document: this.document,
          menu,
          trigger: actions,
        });
        const openAction = createIconButton(this.document, {
          icon: 'external-link',
          label: `Open source for ${entry.quote}`,
          text: 'Open source',
        });
        openAction.setAttribute('role', 'menuitem');
        openAction.addEventListener('click', () => {
          menuController.close();
          this.onOpen(entry, actions);
        });
        menu.append(openAction);
        if (this.onEdit !== undefined) {
          const editAction = createIconButton(this.document, {
            icon: 'square-pen',
            label: `Edit ${entry.quote}`,
            text: 'Edit',
          });
          editAction.setAttribute('role', 'menuitem');
          editAction.addEventListener('click', () => {
            menuController.close();
            this.onEdit?.(entry, actions);
          });
          menu.append(editAction);
        }
        const exportAction = createIconButton(this.document, {
          icon: 'share',
          label: `Export ${entry.quote}`,
          text: 'Export',
        });
        exportAction.setAttribute('role', 'menuitem');
        exportAction.addEventListener('click', () => {
          menuController.close();
          this.onExport([entry], actions);
        });
        menu.append(exportAction);
        actions.addEventListener('click', () => {
          const opened = menuController.toggle();
          if (!opened) return;
          const viewportRect = viewport.getBoundingClientRect();
          const triggerRect = actions.getBoundingClientRect();
          const shouldOpenUpward =
            viewportRect.bottom - triggerRect.bottom < 132 &&
            triggerRect.top - viewportRect.top > 132;
          menu.classList.toggle('inkstone-vault-row__menu--upward', shouldOpenUpward);
          menu.querySelector<HTMLButtonElement>('button')?.focus();
        });
        wrapper.append(row, actions, menu);
        visible.append(wrapper);
      }
    };
    viewport.addEventListener('scroll', renderWindow, { passive: true });
    renderWindow();
  }
}

function focusActiveScopeButton(container: HTMLElement): void {
  container
    .querySelector<HTMLButtonElement>('.inkstone-sidebar__scope button[aria-pressed="true"]')
    ?.focus({ preventScroll: true });
}

interface BulkSelectionSnapshot {
  readonly expectedRevision: number;
  readonly filePath: string;
  readonly id: string;
  readonly noteId: string;
  readonly type: AnnotationIndexEntry['type'];
}

type VaultVirtualItem =
  | { readonly filePath: string; readonly kind: 'group'; readonly total: number }
  | { readonly entry: AnnotationIndexEntry; readonly kind: 'row' };

function offsetIndex(offsets: readonly number[], target: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((offsets[middle] ?? 0) <= target) low = middle;
    else high = middle - 1;
  }
  return low;
}

function entryIcon(entry: AnnotationIndexEntry): string {
  if (entry.conflict || entry.status === 'unanchored' || entry.status === 'needs-rebase') {
    return 'triangle-alert';
  }
  if (entry.type === 'ink') return 'waves';
  if (entry.type === 'note') return 'message-square-text';
  if (entry.type === 'underline') return 'underline';
  return 'highlighter';
}

function formatStatus(value: string): string {
  const label = value.replaceAll('-', ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatCompactTimestamp(value: string): string {
  const compactIso = /^(?:\d{4}-)?(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return compactIso === null ? value : `${compactIso[1]} ${compactIso[2]}`;
}

interface BulkOutcome {
  readonly failed: readonly BulkSelectionSnapshot[];
}

interface BulkRenderState {
  readonly bulkMode: boolean;
  readonly onSelectionChange: (entry: AnnotationIndexEntry, checked: boolean) => void;
  readonly selected: ReadonlyMap<string, AnnotationIndexEntry>;
}

function toBulkSnapshot(entry: AnnotationIndexEntry): BulkSelectionSnapshot {
  return {
    expectedRevision: entry.revision,
    filePath: entry.filePath,
    id: entry.id,
    noteId: entry.noteId,
    type: entry.type,
  };
}

type SelectOption = readonly [value: string, label: string];

function createSelect(
  document: Document,
  ariaLabel: string,
  options: readonly SelectOption[],
): HTMLSelectElement {
  const select = document.createElement('select');
  select.setAttribute('aria-label', ariaLabel);
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  return select;
}

function uniqueOptions(values: readonly (SelectOption | string)[]): readonly SelectOption[] {
  const options = new Map<string, string>();
  for (const value of values) {
    const [id, label] = typeof value === 'string' ? [value, value] : value;
    if (id.length > 0 && !options.has(id)) {
      options.set(id, label);
    }
  }
  return [...options.entries()].sort((left, right) => left[1].localeCompare(right[1]));
}
