import type { AnnotationIndexEntry, VaultAnnotationIndex } from '../domain/vault-annotation-index';
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

export class VaultAnnotationSidebar {
  private readonly container: HTMLElement;
  private readonly document: Document;
  private frameRequest: number | null = null;
  private readonly headerContainer: HTMLElement | undefined;
  private readonly index: VaultAnnotationIndex;
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

  constructor(input: {
    readonly container: HTMLElement;
    readonly document: Document;
    readonly headerContainer?: HTMLElement;
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
    this.index = input.index;
    this.onBulkAddTags = input.onBulkAddTags ?? (() => Promise.resolve({ failed: [] }));
    this.onBulkChangeStyle = input.onBulkChangeStyle ?? (() => Promise.resolve({ failed: [] }));
    this.onBulkCopy = input.onBulkCopy ?? (() => Promise.resolve());
    this.onBulkDelete = input.onBulkDelete ?? (() => Promise.resolve({ failed: [] }));
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
  }

  showUnavailable(message = 'Index unavailable'): void {
    this.state.unavailableMessage.value = message;
    this.state.status.value = 'unavailable';
    this.container.classList.add('inkstone-sidebar');
    this.container.classList.remove('inkstone-sidebar--vault');
    this.renderNow();
  }

  dispose(): void {
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
      showScope: this.showScope,
      state: this.state,
      styleOptions: this.styleOptions,
    };
  }

  private renderNow(): void {
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
}
