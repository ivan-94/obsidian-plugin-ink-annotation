import type {
  CompactAnnotationRow,
  CurrentFileAnnotationList,
} from '../domain/current-file-annotation-list';
import type { InkSurfaceSummary } from '../domain/ink-surface-summary';
import { createDismissibleMenu } from './dismissible-menu';
import { createIcon, createIconButton, createIconStatus } from './icon-button';

export class CurrentFileSidebar {
  private activeId: string | null = null;
  private readonly container: HTMLElement;
  private readonly document: Document;
  private readonly onSelect: (annotationId: string) => void;
  private readonly onInspect: (annotationId: string, invoker: HTMLElement) => void;
  private readonly onEntireVault: () => void | Promise<void>;
  private readonly onExportCurrentFile: (invoker: HTMLElement) => void;
  private readonly onRetry: () => void;
  private readonly onDeleteInk: (surfaceId: string) => void;
  private readonly onEditInk: (surfaceId: string) => void;
  private readonly onExportInkPng: (surfaceId: string) => void;
  private readonly onExportInkReport: () => void;
  private readonly onExportInkSvg: (surfaceId: string) => void;
  private readonly onRestoreInk: (surfaceId: string) => void;
  private readonly onReviewConflicts: (invoker: HTMLElement) => void;
  private readonly onSelectInk: (summary: InkSurfaceSummary) => void;

  constructor(input: {
    readonly container: HTMLElement;
    readonly document: Document;
    readonly onInspect?: (annotationId: string, invoker: HTMLElement) => void;
    readonly onDeleteInk?: (surfaceId: string) => void;
    readonly onEditInk?: (surfaceId: string) => void;
    readonly onExportInkPng?: (surfaceId: string) => void;
    readonly onExportInkReport?: () => void;
    readonly onExportInkSvg?: (surfaceId: string) => void;
    readonly onEntireVault?: () => void | Promise<void>;
    readonly onExportCurrentFile?: (invoker: HTMLElement) => void;
    readonly onRetry?: () => void;
    readonly onReviewConflicts?: (invoker: HTMLElement) => void;
    readonly onRestoreInk?: (surfaceId: string) => void;
    readonly onSelect: (annotationId: string) => void;
    readonly onSelectInk?: (summary: InkSurfaceSummary) => void;
  }) {
    this.container = input.container;
    this.document = input.document;
    this.onInspect = input.onInspect ?? (() => undefined);
    this.onDeleteInk = input.onDeleteInk ?? (() => undefined);
    this.onEditInk = input.onEditInk ?? (() => undefined);
    this.onExportInkPng = input.onExportInkPng ?? (() => undefined);
    this.onExportInkReport = input.onExportInkReport ?? (() => undefined);
    this.onExportInkSvg = input.onExportInkSvg ?? (() => undefined);
    this.onEntireVault = input.onEntireVault ?? (() => undefined);
    this.onExportCurrentFile = input.onExportCurrentFile ?? (() => undefined);
    this.onRetry = input.onRetry ?? (() => undefined);
    this.onReviewConflicts = input.onReviewConflicts ?? (() => undefined);
    this.onRestoreInk = input.onRestoreInk ?? (() => undefined);
    this.onSelect = input.onSelect;
    this.onSelectInk = input.onSelectInk ?? (() => undefined);
  }

  render(
    model: CurrentFileAnnotationList,
    health: { readonly conflictCount: number; readonly readIssueCount: number } = {
      conflictCount: 0,
      readIssueCount: 0,
    },
    inkSummaries: readonly InkSurfaceSummary[] = [],
  ): void {
    const focusTarget = this.captureFocusTarget();
    this.container.replaceChildren();
    this.container.classList.add('inkstone-sidebar');
    this.container.classList.remove('inkstone-sidebar--vault');

    const header = this.document.createElement('header');
    header.className = 'inkstone-sidebar__header';
    const scope = this.document.createElement('div');
    scope.className = 'inkstone-sidebar__scope';
    scope.setAttribute('aria-label', 'Annotation scope');
    scope.setAttribute('role', 'tablist');
    const current = this.document.createElement('button');
    current.type = 'button';
    current.textContent = 'Current file';
    current.setAttribute('role', 'tab');
    current.setAttribute('aria-pressed', 'true');
    current.setAttribute('aria-selected', 'true');
    const entireVault = this.document.createElement('button');
    entireVault.type = 'button';
    entireVault.textContent = 'Entire Vault';
    entireVault.setAttribute('role', 'tab');
    entireVault.setAttribute('aria-label', 'Show Entire Vault');
    entireVault.setAttribute('aria-pressed', 'false');
    entireVault.setAttribute('aria-selected', 'false');
    entireVault.addEventListener('click', () => {
      const switched = this.onEntireVault();
      void Promise.resolve(switched).then(() => focusActiveScopeButton(this.container));
    });
    scope.append(current, entireVault);
    const headerActions = this.document.createElement('div');
    headerActions.className = 'inkstone-sidebar__header-actions';
    const cloudStatus = createIconStatus(this.document, {
      icon: 'cloud-off',
      label: 'Sync status unavailable',
    });
    cloudStatus.classList.add('inkstone-visually-hidden');
    cloudStatus.dataset.inkstoneCloudStatus = '';
    const searchToggle = createIconButton(this.document, {
      icon: 'search',
      label: 'Search current file annotations',
    });
    const refresh = createIconButton(this.document, {
      icon: 'refresh-cw',
      label: 'Refresh annotations',
    });
    refresh.addEventListener('click', this.onRetry);
    const more = createIconButton(this.document, { icon: 'ellipsis', label: 'More actions' });
    more.setAttribute('aria-haspopup', 'menu');
    const menu = this.document.createElement('div');
    menu.className = 'inkstone-sidebar__overflow-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    const headerMenu = createDismissibleMenu({ document: this.document, menu, trigger: more });
    const exportCurrentFile = createIconButton(this.document, {
      icon: 'share',
      label: 'Export current file annotations',
      text: 'Export current file…',
    });
    exportCurrentFile.setAttribute('role', 'menuitem');
    exportCurrentFile.addEventListener('click', () => {
      headerMenu.close();
      this.onExportCurrentFile(exportCurrentFile);
    });
    const exportInkReport = createIconButton(this.document, {
      icon: 'file-down',
      label: 'Export current file Ink report',
      text: 'Export Ink report…',
    });
    exportInkReport.setAttribute('role', 'menuitem');
    exportInkReport.addEventListener('click', () => {
      headerMenu.close();
      this.onExportInkReport();
    });
    menu.append(exportCurrentFile, exportInkReport);
    more.addEventListener('click', headerMenu.toggle);
    headerActions.append(cloudStatus, searchToggle, refresh, more);
    header.append(scope, headerActions, menu);
    this.container.append(header);

    if (health.conflictCount > 0 || health.readIssueCount > 0) {
      const alert = this.document.createElement('div');
      alert.className = 'inkstone-sidebar__storage-alert';
      alert.setAttribute('role', 'alert');
      const messages: string[] = [];
      if (health.conflictCount > 0) {
        messages.push(
          `${health.conflictCount} ${health.conflictCount === 1 ? 'conflict needs' : 'conflicts need'} repair`,
        );
      }
      if (health.readIssueCount > 0) {
        messages.push(
          `${health.readIssueCount} ${health.readIssueCount === 1 ? "file couldn't" : "files couldn't"} be read`,
        );
      }
      alert.textContent = `${messages.join('. ')}. Canonical artifacts were preserved.`;
      if (health.conflictCount > 0) {
        const review = this.document.createElement('button');
        review.type = 'button';
        review.setAttribute('aria-label', 'Review annotation conflicts');
        review.textContent = 'Review conflicts';
        review.addEventListener('click', () => this.onReviewConflicts(review));
        alert.append(review);
      }
      this.container.append(alert);
    }

    if (model.total === 0 && inkSummaries.length === 0) {
      const empty = this.document.createElement('div');
      empty.className = 'inkstone-sidebar__empty';
      empty.append(createIcon(this.document, 'bookmark-plus', 'inkstone-sidebar__empty-icon'));
      const emptyTitle = this.document.createElement('h3');
      emptyTitle.textContent = 'No annotations yet';
      const emptyCopy = this.document.createElement('p');
      emptyCopy.textContent = 'Select text in Reading View or start Ink Mode.';
      empty.append(emptyTitle, emptyCopy);
      searchToggle.disabled = true;
      exportCurrentFile.disabled = true;
      exportInkReport.disabled = true;
      this.container.append(empty);
      this.restoreFocusTarget(focusTarget);
      return;
    }

    const search = this.document.createElement('label');
    search.className = 'inkstone-sidebar__search';
    search.hidden = true;
    search.append(createIcon(this.document, 'search'));
    const searchInput = this.document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search annotations';
    searchInput.setAttribute('aria-label', 'Search current file annotations');
    search.append(searchInput);
    searchToggle.addEventListener('click', () => {
      search.hidden = !search.hidden;
      searchToggle.setAttribute('aria-pressed', String(!search.hidden));
      if (!search.hidden) searchInput.focus({ preventScroll: true });
    });
    this.container.append(search);

    if (inkSummaries.length > 0) {
      this.container.append(this.createInkSection(inkSummaries));
    }

    for (const group of model.groups) {
      const section = this.document.createElement('section');
      section.className = `inkstone-sidebar-group inkstone-sidebar-group--${group.kind}`;
      const heading = this.document.createElement('h3');
      heading.dataset.inkstoneGroupTitle = '';
      heading.dataset.count = String(group.rows.length);
      heading.append(
        createIcon(this.document, group.kind === 'problems' ? 'triangle-alert' : 'file-text'),
      );
      const headingText = this.document.createElement('span');
      headingText.textContent = group.title;
      heading.append(headingText);
      section.append(heading);
      for (const row of group.rows) {
        section.append(this.createRow(row));
      }
      this.container.append(section);
    }
    searchInput.addEventListener('input', () => this.filterVisibleRows(searchInput.value));
    this.applyActiveState();
    this.restoreFocusTarget(focusTarget);
  }

  selectAnnotation(annotationId: string): boolean {
    const row = [...this.container.querySelectorAll<HTMLElement>('[data-annotation-id]')].find(
      (candidate) => candidate.dataset.annotationId === annotationId,
    );
    if (row === undefined) {
      return false;
    }
    this.activeId = annotationId;
    this.applyActiveState();
    row.scrollIntoView?.({ block: 'nearest' });
    return true;
  }

  renderFailure(message: string): void {
    this.container.replaceChildren();
    this.container.classList.add('inkstone-sidebar');
    this.container.classList.remove('inkstone-sidebar--vault');
    const alert = this.document.createElement('div');
    alert.className = 'inkstone-sidebar__storage-alert';
    alert.setAttribute('role', 'alert');
    alert.textContent = `${message} Cloud status remains unknown.`;
    const retry = this.document.createElement('button');
    retry.type = 'button';
    retry.setAttribute('aria-label', 'Retry annotations');
    retry.textContent = 'Retry';
    retry.addEventListener('click', this.onRetry);
    alert.append(retry);
    this.container.append(alert);
  }

  private createRow(row: CompactAnnotationRow): HTMLElement {
    const wrapper = this.document.createElement('div');
    wrapper.className = 'inkstone-sidebar-row';
    wrapper.dataset.inkstoneAnnotationStatus = row.status;

    const button = this.document.createElement('button');
    button.className = 'inkstone-sidebar-row__summary';
    button.type = 'button';
    button.dataset.annotationId = row.id;
    button.dataset.inkstoneAnnotationRow = '';

    const marker = createIcon(
      this.document,
      rowIcon(row),
      `inkstone-sidebar-row__marker inkstone-sidebar-row__marker--${row.marker.kind}`,
    );
    if ('styleId' in row.marker) {
      marker.dataset.inkstoneStyleId = row.marker.styleId;
    }
    button.append(marker);

    const content = this.document.createElement('span');
    content.className = 'inkstone-sidebar-row__content';
    const quote = this.document.createElement('span');
    quote.className = 'inkstone-sidebar-row__quote';
    quote.textContent = row.quote;
    quote.title = row.quote;
    content.append(quote);
    if (row.notePreview !== null) {
      const note = this.document.createElement('span');
      note.className = 'inkstone-sidebar-row__note';
      note.textContent = row.notePreview;
      note.title = row.notePreview;
      content.append(note);
    }
    const metadata = this.document.createElement('span');
    metadata.className = 'inkstone-sidebar-row__metadata';
    metadata.textContent = [
      markerLabel(row),
      ...row.tags.map((tag) => `#${tag}`),
      row.status === 'active' ? undefined : formatStatus(row.status),
      formatCompactTimestamp(row.updatedAt),
    ]
      .filter((part): part is string => part !== undefined)
      .join('  ·  ');
    metadata.title = metadata.textContent;
    content.append(metadata);
    button.append(content);
    wrapper.append(button);

    const actions = this.document.createElement('div');
    actions.className = 'inkstone-sidebar-row__actions';
    const menuId = `inkstone-annotation-menu-${encodeURIComponent(row.id)}`;
    const more = createIconButton(this.document, {
      icon: 'ellipsis',
      label: `Open actions for ${row.quote}`,
    });
    more.dataset.inkstoneAnnotationActions = row.id;
    more.id = `inkstone-annotation-edit-${encodeURIComponent(row.id)}`;
    more.setAttribute('aria-controls', menuId);
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-haspopup', 'menu');
    const menu = this.document.createElement('div');
    menu.className = 'inkstone-sidebar-row__menu';
    menu.dataset.inkstoneAnnotationMenu = row.id;
    menu.id = menuId;
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    const annotationMenu = createDismissibleMenu({
      document: this.document,
      menu,
      trigger: more,
    });
    more.addEventListener('click', () => {
      if (annotationMenu.toggle()) menu.querySelector<HTMLButtonElement>('button')?.focus();
    });
    const edit = createIconButton(this.document, {
      icon: 'square-pen',
      label: 'Edit annotation',
      text: 'Edit',
    });
    edit.setAttribute('role', 'menuitem');
    edit.addEventListener('click', () => {
      annotationMenu.close();
      this.onInspect(row.id, more);
    });
    menu.append(edit);
    actions.append(more, menu);
    wrapper.append(actions);

    button.addEventListener('click', () => {
      this.activeId = row.id;
      this.applyActiveState();
      this.onSelect(row.id);
    });
    return wrapper;
  }

  private createInkSection(summaries: readonly InkSurfaceSummary[]): HTMLElement {
    const section = this.document.createElement('section');
    section.className = 'inkstone-sidebar-group inkstone-sidebar-group--ink';
    const heading = this.document.createElement('h3');
    heading.dataset.inkstoneGroupTitle = '';
    heading.dataset.count = String(summaries.length);
    heading.append(createIcon(this.document, 'waves'));
    const headingText = this.document.createElement('span');
    headingText.textContent = 'Ink';
    heading.append(headingText);
    section.append(heading);

    for (const summary of summaries) {
      const wrapper = this.document.createElement('div');
      wrapper.className = 'inkstone-sidebar-ink-row';
      wrapper.dataset.inkstoneInkStatus =
        summary.deletedAt === undefined ? summary.status : 'deleted';
      const button = this.document.createElement('button');
      button.type = 'button';
      button.dataset.inkstoneInkRow = summary.id;
      button.setAttribute(
        'aria-label',
        `Ink in ${summary.headingPath.at(-1) ?? 'Document'}, ${summary.strokeCount} strokes, ${summary.deletedAt === undefined ? summary.status : 'deleted'}`,
      );
      const thumbnail = this.document.createElement('img');
      thumbnail.alt = '';
      thumbnail.dataset.inkstoneInkThumbnail = summary.id;
      thumbnail.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(summary.thumbnailSvg)}`;
      const content = this.document.createElement('span');
      content.className = 'inkstone-sidebar-ink-row__content';
      const title = this.document.createElement('strong');
      title.textContent = summary.headingPath.at(-1) ?? 'Document';
      title.title = summary.headingPath.join(' › ') || 'Document';
      const metadata = this.document.createElement('span');
      const status = summary.deletedAt === undefined ? summary.status : 'deleted';
      metadata.textContent = [
        `${summary.strokeCount} ${summary.strokeCount === 1 ? 'stroke' : 'strokes'}`,
        status === 'active' ? undefined : formatStatus(status),
      ]
        .filter((part): part is string => part !== undefined)
        .join(' · ');
      content.append(title, metadata);
      button.append(thumbnail, content);
      button.addEventListener('click', () => this.onSelectInk(summary));
      wrapper.append(button);

      const actions = this.document.createElement('div');
      actions.className = 'inkstone-sidebar-ink-row__actions';
      if (summary.deletedAt === undefined) {
        const menuId = `inkstone-ink-actions-${encodeURIComponent(summary.id)}`;
        const more = createIconButton(this.document, {
          icon: 'ellipsis',
          label: `Open Ink actions for ${summary.headingPath.at(-1) ?? 'Document'}`,
        });
        more.dataset.inkstoneInkActions = summary.id;
        more.setAttribute('aria-controls', menuId);
        more.setAttribute('aria-expanded', 'false');
        more.setAttribute('aria-haspopup', 'menu');
        const menu = this.document.createElement('div');
        menu.className = 'inkstone-sidebar-ink-row__menu';
        menu.dataset.inkstoneInkMenu = summary.id;
        menu.id = menuId;
        menu.hidden = true;
        menu.setAttribute('role', 'menu');
        const inkMenu = createDismissibleMenu({
          document: this.document,
          menu,
          trigger: more,
        });
        const edit = createIconButton(this.document, { icon: 'pen-line', label: 'Edit Ink' });
        edit.setAttribute('role', 'menuitem');
        edit.dataset.inkstoneInkEdit = summary.id;
        const editLabel = this.document.createElement('span');
        editLabel.className = 'inkstone-icon-button__label';
        editLabel.textContent = 'Edit';
        edit.append(editLabel);
        edit.addEventListener('click', () => {
          inkMenu.close();
          this.onEditInk(summary.id);
        });
        const remove = createIconButton(this.document, {
          danger: true,
          icon: 'trash-2',
          label: 'Delete Ink surface',
          text: 'Delete',
        });
        remove.setAttribute('role', 'menuitem');
        remove.dataset.inkstoneInkDelete = summary.id;
        let armed = false;
        const resetDeleteConfirmation = (): void => {
          armed = false;
          remove.classList.remove('is-armed');
          remove.setAttribute('aria-label', 'Delete Ink surface');
          remove.title = 'Delete Ink surface';
          const label = remove.querySelector('.inkstone-icon-button__label');
          if (label !== null) label.textContent = 'Delete';
        };
        more.addEventListener('click', () => {
          if (!inkMenu.toggle()) return;
          resetDeleteConfirmation();
          menu.querySelector<HTMLButtonElement>('button')?.focus();
        });
        remove.addEventListener('click', () => {
          if (!armed) {
            armed = true;
            remove.classList.add('is-armed');
            remove.setAttribute('aria-label', 'Confirm delete Ink surface');
            remove.title = 'Confirm delete Ink surface';
            const label = remove.querySelector('.inkstone-icon-button__label');
            if (label !== null) label.textContent = 'Confirm delete';
            return;
          }
          inkMenu.close();
          this.onDeleteInk(summary.id);
        });
        const exportSvg = createIconButton(this.document, {
          icon: 'file-code-2',
          label: 'Export Ink as SVG',
          text: 'Export SVG',
        });
        exportSvg.setAttribute('role', 'menuitem');
        exportSvg.addEventListener('click', () => {
          inkMenu.close();
          this.onExportInkSvg(summary.id);
        });
        const exportPng = createIconButton(this.document, {
          icon: 'image-down',
          label: 'Export Ink as PNG',
          text: 'Export PNG',
        });
        exportPng.setAttribute('role', 'menuitem');
        exportPng.addEventListener('click', () => {
          inkMenu.close();
          this.onExportInkPng(summary.id);
        });
        menu.append(edit, exportSvg, exportPng, remove);
        actions.append(more, menu);
      } else {
        const restore = createIconButton(this.document, {
          icon: 'rotate-ccw',
          label: 'Restore Ink surface',
          text: 'Restore',
        });
        restore.dataset.inkstoneInkRestore = summary.id;
        restore.addEventListener('click', () => this.onRestoreInk(summary.id));
        actions.append(restore);
      }
      wrapper.append(actions);
      section.append(wrapper);
    }
    return section;
  }

  private applyActiveState(): void {
    for (const button of this.container.querySelectorAll<HTMLButtonElement>(
      '[data-inkstone-annotation-row]',
    )) {
      const active = button.dataset.annotationId === this.activeId;
      button.closest('.inkstone-sidebar-row')?.classList.toggle('is-active', active);
      if (active) {
        button.setAttribute('aria-current', 'true');
      } else {
        button.removeAttribute('aria-current');
      }
    }
  }

  private filterVisibleRows(query: string): void {
    const normalized = query.trim().toLocaleLowerCase();
    for (const row of this.container.querySelectorAll<HTMLElement>(
      '.inkstone-sidebar-row, .inkstone-sidebar-ink-row',
    )) {
      row.hidden =
        normalized.length > 0 && !row.textContent?.toLocaleLowerCase().includes(normalized);
    }
    for (const section of this.container.querySelectorAll<HTMLElement>('.inkstone-sidebar-group')) {
      const rows = [
        ...section.querySelectorAll<HTMLElement>(
          '.inkstone-sidebar-row, .inkstone-sidebar-ink-row',
        ),
      ];
      section.hidden = rows.length > 0 && rows.every((row) => row.hidden);
    }
  }

  private captureFocusTarget(): SidebarFocusTarget | null {
    const active = this.document.activeElement;
    if (active === null || !this.container.contains(active)) return null;
    const element = active as HTMLElement;
    const wrapper = element.closest('.inkstone-sidebar-row');
    const annotationId =
      wrapper?.querySelector<HTMLElement>('[data-annotation-id]')?.dataset.annotationId;
    return {
      ...(annotationId === undefined ? {} : { annotationId }),
      ...(element.getAttribute('aria-label') === null
        ? {}
        : { ariaLabel: element.getAttribute('aria-label') as string }),
      kind: element.matches('[data-inkstone-annotation-row]') ? 'summary' : 'control',
      text: element.textContent?.trim() ?? '',
    };
  }

  private restoreFocusTarget(target: SidebarFocusTarget | null): void {
    if (target === null) return;
    let candidate: HTMLElement | null = null;
    if (target.annotationId !== undefined) {
      const summary = [
        ...this.container.querySelectorAll<HTMLElement>('[data-annotation-id]'),
      ].find((element) => element.dataset.annotationId === target.annotationId);
      candidate =
        target.kind === 'summary'
          ? (summary ?? null)
          : (summary?.parentElement?.querySelector<HTMLElement>(
              target.ariaLabel === undefined
                ? 'button'
                : `button[aria-label="${target.ariaLabel}"]`,
            ) ?? null);
    }
    if (candidate === null && target.ariaLabel !== undefined) {
      candidate =
        [...this.container.querySelectorAll<HTMLElement>('[aria-label]')].find(
          (element) => element.getAttribute('aria-label') === target.ariaLabel,
        ) ?? null;
    }
    if (candidate === null && target.text.length > 0) {
      candidate =
        [...this.container.querySelectorAll<HTMLElement>('button')].find(
          (element) => element.textContent?.trim() === target.text,
        ) ?? null;
    }
    candidate?.focus({ preventScroll: true });
  }
}

interface SidebarFocusTarget {
  readonly annotationId?: string;
  readonly ariaLabel?: string;
  readonly kind: 'control' | 'summary';
  readonly text: string;
}

function focusActiveScopeButton(container: HTMLElement): void {
  container
    .querySelector<HTMLButtonElement>('.inkstone-sidebar__scope button[aria-pressed="true"]')
    ?.focus({ preventScroll: true });
}

function markerLabel(row: CompactAnnotationRow): string {
  switch (row.marker.kind) {
    case 'highlight':
      return 'Highlight';
    case 'underline':
      return 'Underline';
    case 'note':
      return 'Note';
  }
}

function rowIcon(row: CompactAnnotationRow): string {
  switch (row.marker.kind) {
    case 'highlight':
      return 'highlighter';
    case 'underline':
      return 'underline';
    case 'note':
      return 'message-square-text';
  }
}

function formatStatus(value: string): string {
  const label = value.replaceAll('-', ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatCompactTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
