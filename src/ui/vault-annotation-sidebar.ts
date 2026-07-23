import type {
  AnnotationIndexEntry,
  VaultAnnotationIndex,
  VaultAnnotationQueryPort,
} from '../domain/vault-annotation-index';
import type { VaultCatalogQueryPort } from '../application/vault-catalog';
import type { SnapshotAnnotationSummary } from '../domain/snapshot-annotation-summary';
import { createPreactIsland, type UiIsland } from './runtime/mount-preact-island';
import {
  VaultAnnotationSidebarApp,
  type VaultAnnotationSidebarAppProps,
} from './sidebar/vault-annotation-sidebar-app';
import type {
  BulkOutcome,
  BulkSelectionSnapshot,
  SelectOption,
} from './sidebar/vault-sidebar-types';
import { createVaultSidebarStore, type VaultSidebarStore } from './stores/annotation-sidebar-store';
import { VaultCatalogPageModel } from './vault-catalog-page-model';

export class VaultAnnotationSidebar {
  private readonly container: HTMLElement;
  private readonly document: Document;
  private frameRequest: number | null = null;
  private readonly headerContainer: HTMLElement | undefined;
  private readonly catalog: VaultCatalogQueryPort | undefined;
  private catalogAbort: AbortController | null = null;
  private catalogQueryKey = '';
  private readonly index: VaultAnnotationQueryPort;
  private readonly island: UiIsland<VaultAnnotationSidebarAppProps> =
    createPreactIsland(VaultAnnotationSidebarApp);
  private mounted = false;
  private readonly onBulkAddTags: (
    selection: readonly BulkSelectionSnapshot[],
    tags: readonly string[],
  ) => Promise<BulkOutcome>;
  private readonly onBulkChangeStyle: (
    selection: readonly BulkSelectionSnapshot[],
    styleId: string,
  ) => Promise<BulkOutcome>;
  private readonly onBulkCopy: (entries: readonly AnnotationIndexEntry[]) => Promise<void>;
  private readonly onBulkDelete: (
    selection: readonly BulkSelectionSnapshot[],
  ) => Promise<BulkOutcome>;
  private readonly onCurrentFile: () => void | Promise<void>;
  private readonly onDeleteSnapshot: (summary: SnapshotAnnotationSummary) => void;
  private readonly onEdit:
    ((entry: AnnotationIndexEntry, invoker: HTMLElement) => void) | undefined;
  private readonly onEditSnapshot: (summary: SnapshotAnnotationSummary) => void;
  private readonly onExport: (
    entries: readonly AnnotationIndexEntry[],
    invoker: HTMLElement,
  ) => void;
  private readonly onOpen: (entry: AnnotationIndexEntry, invoker: HTMLElement) => void;
  private readonly onExportSnapshot: (summary: SnapshotAnnotationSummary) => void;
  private readonly onPreviewSnapshot: (summary: SnapshotAnnotationSummary) => void;
  private readonly onRelinkSnapshot: (summary: SnapshotAnnotationSummary) => void;
  private readonly onRestoreSnapshot: (summary: SnapshotAnnotationSummary) => void;
  private readonly onSelectSnapshotSource: (summary: SnapshotAnnotationSummary) => void;
  private readonly loadSnapshotThumbnail:
    ((summary: SnapshotAnnotationSummary) => Promise<string | null>) | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly showScope: boolean;
  private readonly state: VaultSidebarStore;
  private readonly styleOptions: readonly SelectOption[];
  private readonly unsubscribeIndex: () => void;
  private readonly pageModel: VaultCatalogPageModel | undefined;

  constructor(input: {
    readonly container: HTMLElement;
    readonly document: Document;
    readonly headerContainer?: HTMLElement;
    readonly catalog?: VaultCatalogQueryPort;
    readonly index?: VaultAnnotationIndex;
    readonly onBulkAddTags?: (
      selection: readonly BulkSelectionSnapshot[],
      tags: readonly string[],
    ) => Promise<BulkOutcome>;
    readonly onBulkChangeStyle?: (
      selection: readonly BulkSelectionSnapshot[],
      styleId: string,
    ) => Promise<BulkOutcome>;
    readonly onBulkCopy?: (entries: readonly AnnotationIndexEntry[]) => Promise<void>;
    readonly onBulkDelete?: (selection: readonly BulkSelectionSnapshot[]) => Promise<BulkOutcome>;
    readonly onCurrentFile?: () => void | Promise<void>;
    readonly onDeleteSnapshot?: (summary: SnapshotAnnotationSummary) => void;
    readonly onEdit?: (entry: AnnotationIndexEntry, invoker: HTMLElement) => void;
    readonly onEditSnapshot?: (summary: SnapshotAnnotationSummary) => void;
    readonly onExport?: (entries: readonly AnnotationIndexEntry[], invoker: HTMLElement) => void;
    readonly onExportSnapshot?: (summary: SnapshotAnnotationSummary) => void;
    readonly onOpen?: (entry: AnnotationIndexEntry, invoker: HTMLElement) => void;
    readonly onPreviewSnapshot?: (summary: SnapshotAnnotationSummary) => void;
    readonly onRelinkSnapshot?: (summary: SnapshotAnnotationSummary) => void;
    readonly onRestoreSnapshot?: (summary: SnapshotAnnotationSummary) => void;
    readonly onSelectSnapshotSource?: (summary: SnapshotAnnotationSummary) => void;
    readonly loadSnapshotThumbnail?: (summary: SnapshotAnnotationSummary) => Promise<string | null>;
    readonly state?: VaultSidebarStore;
    readonly styleOptions?: readonly SelectOption[];
    readonly showScope?: boolean;
  }) {
    this.container = input.container;
    this.document = input.document;
    this.headerContainer = input.headerContainer;
    if (input.catalog === undefined && input.index === undefined) {
      throw new Error('Vault Annotation Sidebar requires a Catalog or legacy index.');
    }
    this.catalog = input.catalog;
    this.pageModel = input.catalog === undefined ? undefined : new VaultCatalogPageModel();
    this.index = input.index ?? (this.pageModel as VaultCatalogPageModel);
    this.onBulkAddTags = input.onBulkAddTags ?? (() => Promise.resolve({ failed: [] }));
    this.onBulkChangeStyle = input.onBulkChangeStyle ?? (() => Promise.resolve({ failed: [] }));
    this.onBulkCopy = input.onBulkCopy ?? (() => Promise.resolve());
    const onBulkDelete = input.onBulkDelete ?? (() => Promise.resolve({ failed: [] }));
    this.onBulkDelete = async (selection) => {
      const outcome = await onBulkDelete(selection);
      if (this.catalog !== undefined) void this.refreshCatalog();
      return outcome;
    };
    this.onCurrentFile = input.onCurrentFile ?? (() => undefined);
    this.onDeleteSnapshot = input.onDeleteSnapshot ?? (() => undefined);
    this.onEdit = input.onEdit;
    this.onEditSnapshot = input.onEditSnapshot ?? (() => undefined);
    this.onExport = input.onExport ?? (() => undefined);
    this.onExportSnapshot = input.onExportSnapshot ?? (() => undefined);
    this.onOpen = input.onOpen ?? (() => undefined);
    this.onPreviewSnapshot = input.onPreviewSnapshot ?? (() => undefined);
    this.onRelinkSnapshot = input.onRelinkSnapshot ?? (() => undefined);
    this.onRestoreSnapshot = input.onRestoreSnapshot ?? (() => undefined);
    this.onSelectSnapshotSource = input.onSelectSnapshotSource ?? (() => undefined);
    this.loadSnapshotThumbnail = input.loadSnapshotThumbnail;
    this.showScope = input.showScope ?? true;
    this.state = input.state ?? createVaultSidebarStore();
    this.styleOptions = input.styleOptions ?? [];
    this.state.indexVersion.value = this.index.version;
    this.unsubscribeIndex = this.index.subscribe(() => {
      this.state.indexVersion.value = this.index.version;
      if (this.state.status.value === 'ready') this.renderNow();
    });
  }

  showBuilding(progress: { readonly completed: number; readonly total: number }): void {
    this.state.buildingProgress.value = progress;
    this.state.status.value = 'building';
    this.container.classList.add('inkstone-sidebar');
    this.container.classList.remove('inkstone-sidebar--vault');
    this.renderNow();
  }

  showReady(): void {
    this.clearSearchTimer();
    this.state.status.value = 'ready';
    this.container.classList.add('inkstone-sidebar', 'inkstone-sidebar--vault');
    this.renderNow();
    if (this.catalog !== undefined) void this.refreshCatalog();
  }

  async refreshCatalog(): Promise<void> {
    if (this.catalog === undefined || this.pageModel === undefined) return;
    const key = JSON.stringify({
      filters: this.state.filters.peek(),
      text: this.state.searchQuery.peek(),
    });
    this.catalogAbort?.abort();
    const abort = new AbortController();
    this.catalogAbort = abort;
    this.catalogQueryKey = key;
    try {
      const filters = this.state.filters.peek();
      const text = this.state.searchQuery.peek();
      if (text.trim().length === 0 && !hasExplicitFilters(filters)) {
        const loadedNoteIds = this.pageModel.loadedNoteIds();
        const result = await this.catalog.recentNotes({ signal: abort.signal });
        if (abort.signal.aborted) return;
        const hadGroups = this.pageModel.query().groups.length > 0;
        this.pageModel.showRecent(result.notes);
        if (!hadGroups) {
          this.state.collapsedGroups.value = new Set(result.notes.map(({ filePath }) => filePath));
        }
        const visibleNoteIds = new Set(result.notes.map(({ noteId }) => noteId));
        for (const noteId of loadedNoteIds) {
          if (!visibleNoteIds.has(noteId)) continue;
          const page = await this.catalog.entriesForNote({
            limit: 50,
            noteId,
            signal: abort.signal,
          });
          if (abort.signal.aborted) return;
          if (page.state === 'ready') this.pageModel.showNotePage(noteId, page.entries);
        }
      } else {
        const result = await this.catalog.search({
          filters,
          limit: 50,
          signal: abort.signal,
          text,
        });
        if (abort.signal.aborted || result.state === 'superseded') return;
        this.pageModel.showSearch(result.entries);
        this.state.collapsedGroups.value = new Set();
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      this.showUnavailable(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.catalogAbort === abort) this.catalogAbort = null;
    }
  }

  showUnavailable(message = 'Index unavailable'): void {
    this.state.unavailableMessage.value = message;
    this.state.status.value = 'unavailable';
    this.container.classList.add('inkstone-sidebar');
    this.container.classList.remove('inkstone-sidebar--vault');
    this.renderNow();
  }

  dispose(): void {
    this.catalogAbort?.abort();
    this.catalogAbort = null;
    this.clearSearchTimer();
    if (this.frameRequest !== null) {
      this.document.defaultView?.cancelAnimationFrame(this.frameRequest);
      this.frameRequest = null;
    }
    this.unsubscribeIndex();
    this.island.unmount();
    this.mounted = false;
  }

  private clearSearchTimer(): void {
    if (this.searchTimer === null) return;
    clearTimeout(this.searchTimer);
    this.searchTimer = null;
  }

  private props(): VaultAnnotationSidebarAppProps {
    return {
      document: this.document,
      ...(this.catalog === undefined ? {} : { boundedCatalog: true }),
      ...(this.pageModel === undefined ? {} : { groupTotals: this.pageModel.groupTotals() }),
      ...(this.headerContainer === undefined ? {} : { headerContainer: this.headerContainer }),
      index: this.index,
      onBulkAddTags: this.onBulkAddTags,
      onBulkChangeStyle: this.onBulkChangeStyle,
      onBulkCopy: this.onBulkCopy,
      onBulkDelete: this.onBulkDelete,
      onCurrentFile: this.onCurrentFile,
      onDeleteSnapshot: this.onDeleteSnapshot,
      ...(this.onEdit === undefined ? {} : { onEdit: this.onEdit }),
      onEditSnapshot: this.onEditSnapshot,
      onExport: this.onExport,
      onExportSnapshot: this.onExportSnapshot,
      onOpen: this.onOpen,
      onPreviewSnapshot: this.onPreviewSnapshot,
      onRelinkSnapshot: this.onRelinkSnapshot,
      onRestoreSnapshot: this.onRestoreSnapshot,
      onSelectSnapshotSource: this.onSelectSnapshotSource,
      ...(this.loadSnapshotThumbnail === undefined
        ? {}
        : { loadSnapshotThumbnail: this.loadSnapshotThumbnail }),
      onRenderNow: () => this.renderNow(),
      onRequestFrame: () => this.requestFrame(),
      onResetSearchAndFilters: () => this.resetSearchAndFilters(),
      onSearch: (value) => this.search(value),
      ...(this.catalog === undefined
        ? {}
        : {
            onToggleGroup: (filePath: string, expanded: boolean) => {
              if (expanded) void this.loadCatalogGroup(filePath);
            },
          }),
      showScope: this.showScope,
      state: this.state,
      styleOptions: this.styleOptions,
    };
  }

  private renderNow(): void {
    if (this.catalog !== undefined && this.state.status.peek() === 'ready') {
      const key = JSON.stringify({
        filters: this.state.filters.peek(),
        text: this.state.searchQuery.peek(),
      });
      if (key !== this.catalogQueryKey && this.catalogAbort === null) {
        void this.refreshCatalog();
      }
    }
    const props = this.props();
    if (this.mounted) this.island.update(props);
    else {
      this.island.mount(this.container, props);
      this.mounted = true;
    }
  }

  private requestFrame(): void {
    if (this.frameRequest !== null) return;
    const request = this.document.defaultView?.requestAnimationFrame;
    if (request === undefined) {
      this.renderNow();
      return;
    }
    this.frameRequest = request(() => {
      this.frameRequest = null;
      this.renderNow();
    });
  }

  private resetSearchAndFilters(): void {
    this.clearSearchTimer();
    this.state.searchInput.value = '';
    this.state.searchQuery.value = '';
    this.state.filters.value = {};
    this.state.scrollOffset.value = 0;
    this.renderNow();
  }

  private search(value: string): void {
    this.state.searchInput.value = value;
    this.clearSearchTimer();
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.state.searchQuery.value = value;
      this.state.scrollOffset.value = 0;
      this.renderNow();
    }, 100);
  }

  private async loadCatalogGroup(filePath: string): Promise<void> {
    if (this.catalog === undefined || this.pageModel === undefined) return;
    const note = this.pageModel.noteForPath(filePath);
    if (note === undefined) return;
    const result = await this.catalog.entriesForNote({ limit: 50, noteId: note.noteId });
    if (result.state === 'ready') this.pageModel.showNotePage(note.noteId, result.entries);
  }
}

function hasExplicitFilters(filters: object): boolean {
  return Object.values(filters).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== '',
  );
}
