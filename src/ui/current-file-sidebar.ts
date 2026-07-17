import { batch } from '@preact/signals';

import type { CurrentFileAnnotationList } from '../domain/current-file-annotation-list';
import type { InkSurfaceSummary } from '../domain/ink-surface-summary';
import {
  CurrentFileSidebarApp,
  type CurrentFileSidebarAppProps,
} from './sidebar/current-file-sidebar-app';
import type {
  CurrentBulkOutcome,
  CurrentBulkSelectionEntry,
} from './sidebar/current-bulk-selection-types';
import type { SelectOption } from './sidebar/vault-sidebar-types';
import { createPreactIsland, type UiIsland } from './runtime/mount-preact-island';
import {
  createCurrentFileSidebarStore,
  type CurrentFileSidebarStore,
} from './stores/annotation-sidebar-store';

const RESTORE_WINDOW_MS = 5_000;

export class CurrentFileSidebar {
  private readonly container: HTMLElement;
  private readonly document: Document;
  private readonly headerContainer: HTMLElement | undefined;
  private readonly island: UiIsland<CurrentFileSidebarAppProps> =
    createPreactIsland(CurrentFileSidebarApp);
  private mounted = false;
  private readonly onBulkAddTags: (
    selection: readonly CurrentBulkSelectionEntry[],
    tags: readonly string[],
  ) => Promise<CurrentBulkOutcome>;
  private readonly onBulkChangeStyle: (
    selection: readonly CurrentBulkSelectionEntry[],
    styleId: string,
  ) => Promise<CurrentBulkOutcome>;
  private readonly onBulkCopy: (selection: readonly CurrentBulkSelectionEntry[]) => Promise<void>;
  private readonly onBulkDelete: (
    selection: readonly CurrentBulkSelectionEntry[],
  ) => Promise<CurrentBulkOutcome>;
  private readonly onBulkExport: (
    selection: readonly CurrentBulkSelectionEntry[],
    invoker: HTMLElement,
  ) => Promise<void>;
  private readonly onDeleteAnnotation: (annotationId: string, expectedRevision: number) => void;
  private readonly onDeleteInk: (surfaceId: string, expectedRevision: number) => void;
  private readonly onEditInk: (surfaceId: string) => void;
  private readonly onEntireVault: () => void | Promise<void>;
  private readonly onExportCurrentFile: (invoker: HTMLElement) => void;
  private readonly onExportInkPng: (surfaceId: string) => void;
  private readonly onExportInkReport: () => void;
  private readonly onExportInkSvg: (surfaceId: string) => void;
  private readonly onInspect: (annotationId: string, invoker: HTMLElement) => void;
  private readonly onRepairAnnotation:
    ((annotationId: string, invoker: HTMLElement) => void) | undefined;
  private readonly onRetry: () => void;
  private readonly onReviewConflicts: (invoker: HTMLElement) => void;
  private readonly onRestoreAnnotation: (annotationId: string, expectedRevision: number) => void;
  private readonly onRestoreInk: (surfaceId: string, expectedRevision: number) => void;
  private readonly onSelect: (annotationId: string) => void;
  private readonly onSelectInk: (summary: InkSurfaceSummary) => void;
  private readonly showScope: boolean;
  private readonly state: CurrentFileSidebarStore;
  private readonly styleOptions: readonly SelectOption[];

  constructor(input: {
    readonly container: HTMLElement;
    readonly document: Document;
    readonly headerContainer?: HTMLElement;
    readonly onBulkAddTags?: (
      selection: readonly CurrentBulkSelectionEntry[],
      tags: readonly string[],
    ) => Promise<CurrentBulkOutcome>;
    readonly onBulkChangeStyle?: (
      selection: readonly CurrentBulkSelectionEntry[],
      styleId: string,
    ) => Promise<CurrentBulkOutcome>;
    readonly onBulkCopy?: (selection: readonly CurrentBulkSelectionEntry[]) => Promise<void>;
    readonly onBulkDelete?: (
      selection: readonly CurrentBulkSelectionEntry[],
    ) => Promise<CurrentBulkOutcome>;
    readonly onBulkExport?: (
      selection: readonly CurrentBulkSelectionEntry[],
      invoker: HTMLElement,
    ) => Promise<void>;
    readonly onDeleteAnnotation?: (annotationId: string, expectedRevision: number) => void;
    readonly onInspect?: (annotationId: string, invoker: HTMLElement) => void;
    readonly onRepairAnnotation?: (annotationId: string, invoker: HTMLElement) => void;
    readonly onDeleteInk?: (surfaceId: string, expectedRevision: number) => void;
    readonly onEditInk?: (surfaceId: string) => void;
    readonly onExportInkPng?: (surfaceId: string) => void;
    readonly onExportInkReport?: () => void;
    readonly onExportInkSvg?: (surfaceId: string) => void;
    readonly onEntireVault?: () => void | Promise<void>;
    readonly onExportCurrentFile?: (invoker: HTMLElement) => void;
    readonly onRetry?: () => void;
    readonly onReviewConflicts?: (invoker: HTMLElement) => void;
    readonly onRestoreInk?: (surfaceId: string, expectedRevision: number) => void;
    readonly onRestoreAnnotation?: (annotationId: string, expectedRevision: number) => void;
    readonly onSelect: (annotationId: string) => void;
    readonly onSelectInk?: (summary: InkSurfaceSummary) => void;
    readonly showScope?: boolean;
    readonly state?: CurrentFileSidebarStore;
    readonly styleOptions?: readonly SelectOption[];
  }) {
    this.container = input.container;
    this.document = input.document;
    this.headerContainer = input.headerContainer;
    this.onBulkAddTags = input.onBulkAddTags ?? (() => Promise.resolve({ failed: [] }));
    this.onBulkChangeStyle = input.onBulkChangeStyle ?? (() => Promise.resolve({ failed: [] }));
    this.onBulkCopy = input.onBulkCopy ?? (() => Promise.resolve());
    this.onBulkDelete = input.onBulkDelete ?? (() => Promise.resolve({ failed: [] }));
    this.onBulkExport = input.onBulkExport ?? (() => Promise.resolve());
    this.onDeleteAnnotation = input.onDeleteAnnotation ?? (() => undefined);
    this.onDeleteInk = input.onDeleteInk ?? (() => undefined);
    this.onEditInk = input.onEditInk ?? (() => undefined);
    this.onEntireVault = input.onEntireVault ?? (() => undefined);
    this.onExportCurrentFile = input.onExportCurrentFile ?? (() => undefined);
    this.onExportInkPng = input.onExportInkPng ?? (() => undefined);
    this.onExportInkReport = input.onExportInkReport ?? (() => undefined);
    this.onExportInkSvg = input.onExportInkSvg ?? (() => undefined);
    this.onInspect = input.onInspect ?? (() => undefined);
    this.onRepairAnnotation = input.onRepairAnnotation;
    this.onRetry = input.onRetry ?? (() => undefined);
    this.onReviewConflicts = input.onReviewConflicts ?? (() => undefined);
    this.onRestoreAnnotation = input.onRestoreAnnotation ?? (() => undefined);
    this.onRestoreInk = input.onRestoreInk ?? (() => undefined);
    this.onSelect = input.onSelect;
    this.onSelectInk = input.onSelectInk ?? (() => undefined);
    this.showScope = input.showScope ?? true;
    this.state = input.state ?? createCurrentFileSidebarStore();
    this.styleOptions = input.styleOptions ?? [];
  }

  render(
    model: CurrentFileAnnotationList,
    health: { readonly conflictCount: number; readonly readIssueCount: number } = {
      conflictCount: 0,
      readIssueCount: 0,
    },
    inkSummaries: readonly InkSurfaceSummary[] = [],
  ): void {
    batch(() => {
      this.state.errorMessage.value = null;
      this.state.model.value = model;
      this.state.inkSummaries.value = inkSummaries;
      this.state.storageHealth.value = health;
      this.state.restoreDeadline.value = nextRestoreDeadline(model, inkSummaries, Date.now());
      this.state.status.value = 'ready';
    });
    this.renderIsland();
  }

  selectAnnotation(annotationId: string): boolean {
    const row = [...this.container.querySelectorAll<HTMLElement>('[data-annotation-id]')].find(
      (candidate) => candidate.dataset.annotationId === annotationId,
    );
    if (row === undefined) return false;
    this.state.activeAnnotationId.value = annotationId;
    for (const candidate of this.container.querySelectorAll<HTMLElement>(
      '[data-inkstone-annotation-row]',
    )) {
      const active = candidate.dataset.annotationId === annotationId;
      candidate.closest('.inkstone-sidebar-row')?.classList.toggle('is-active', active);
      if (active) candidate.setAttribute('aria-current', 'true');
      else candidate.removeAttribute('aria-current');
    }
    row.scrollIntoView?.({ block: 'nearest' });
    return true;
  }

  dispose(): void {
    this.state.scrollOffset.value = this.container.scrollTop;
    this.island.unmount();
    this.mounted = false;
  }

  renderFailure(message: string): void {
    batch(() => {
      this.state.errorMessage.value = message;
      this.state.restoreDeadline.value = null;
      this.state.status.value = 'error';
    });
    this.renderIsland();
  }

  private props(): CurrentFileSidebarAppProps {
    return {
      document: this.document,
      ...(this.headerContainer === undefined ? {} : { headerContainer: this.headerContainer }),
      onBulkAddTags: this.onBulkAddTags,
      onBulkChangeStyle: this.onBulkChangeStyle,
      onBulkCopy: this.onBulkCopy,
      onBulkDelete: this.onBulkDelete,
      onBulkExport: this.onBulkExport,
      onDeleteAnnotation: this.onDeleteAnnotation,
      onDeleteInk: this.onDeleteInk,
      onEditInk: this.onEditInk,
      onEntireVault: this.onEntireVault,
      onExportCurrentFile: this.onExportCurrentFile,
      onExportInkPng: this.onExportInkPng,
      onExportInkReport: this.onExportInkReport,
      onExportInkSvg: this.onExportInkSvg,
      onInspect: this.onInspect,
      ...(this.onRepairAnnotation === undefined
        ? {}
        : { onRepairAnnotation: this.onRepairAnnotation }),
      onRetry: this.onRetry,
      onReviewConflicts: this.onReviewConflicts,
      onRestoreAnnotation: this.onRestoreAnnotation,
      onRestoreInk: this.onRestoreInk,
      onSelect: this.onSelect,
      onSelectInk: this.onSelectInk,
      showScope: this.showScope,
      state: this.state,
      styleOptions: this.styleOptions,
    };
  }

  private renderIsland(): void {
    this.container.classList.add('inkstone-sidebar', 'inkstone-sidebar--current');
    this.container.classList.remove('inkstone-sidebar--vault');
    const props = this.props();
    if (this.mounted) this.island.update(props);
    else {
      this.island.mount(this.container, props);
      this.mounted = true;
    }
    this.container.scrollTop = this.state.scrollOffset.value;
  }
}

function nextRestoreDeadline(
  model: CurrentFileAnnotationList,
  inkSummaries: readonly InkSurfaceSummary[],
  now: number,
): number | null {
  const deadlines = [
    ...model.groups.flatMap((group) => group.rows).flatMap((row) => deadline(row.deletedAt)),
    ...inkSummaries.flatMap((summary) => deadline(summary.deletedAt)),
  ]
    .filter((value) => value > now)
    .sort((left, right) => left - right);
  return deadlines[0] ?? null;
}

function deadline(deletedAt: string | undefined): readonly number[] {
  if (deletedAt === undefined) return [];
  const value = Date.parse(deletedAt) + RESTORE_WINDOW_MS;
  return Number.isFinite(value) ? [value] : [];
}
