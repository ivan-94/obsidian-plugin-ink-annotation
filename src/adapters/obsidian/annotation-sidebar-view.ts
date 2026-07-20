import { ItemView, type WorkspaceLeaf } from 'obsidian';

import type { AnnotationService } from '../../application/annotation-service';
import type { VaultIndexBuilder } from '../../application/vault-index-builder';
import type { VaultAnnotationIndex } from '../../domain/vault-annotation-index';
import {
  inkSummaryToIndexEntry,
  textRecordToIndexEntry,
} from '../../domain/vault-annotation-index';
import { annotationTargetText, type TextAnnotationRecord } from '../../domain/text-annotation';
import type { StylePreset } from '../../domain/style-preset';
import type { CurrentFileAnnotationList } from '../../domain/current-file-annotation-list';
import { CurrentFileSidebar } from '../../ui/current-file-sidebar';
import { VaultAnnotationSidebar } from '../../ui/vault-annotation-sidebar';
import type {
  InkSurfaceConflict,
  InkSurfaceRepository,
} from '../../storage/ink-surface-repository';
import { summarizeInkSurface, type InkSurfaceSummary } from '../../domain/ink-surface-summary';
import type { RepositoryConflict } from '../../storage/sidecar-repository';
import {
  AnnotationConflictDialog,
  type AnnotationConflictReviewView,
} from '../../ui/annotation-conflict-dialog';
import {
  AnnotationSidebarApp,
  type AnnotationSidebarAppProps,
} from '../../ui/sidebar/annotation-sidebar-app';
import { createPreactIsland, type UiIsland } from '../../ui/runtime/mount-preact-island';
import { AnnotationSidebarStore } from '../../ui/stores/annotation-sidebar-store';
import type {
  AnnotationSidebarCommands,
  AnnotationSidebarDeletedItem,
} from './annotation-sidebar-commands';

export const ANNOTATION_SIDEBAR_VIEW_TYPE = 'inkstone-annotation-sidebar';

export class AnnotationSidebarView extends ItemView {
  private currentCache: {
    readonly filePath: string;
    readonly health: { readonly conflictCount: number; readonly readIssueCount: number };
    readonly inkSummaries: readonly InkSurfaceSummary[];
    readonly model: CurrentFileAnnotationList;
  } | null = null;
  private currentComponent: CurrentFileSidebar | null = null;
  private currentConflicts: readonly RepositoryConflict[] = [];
  private currentInkConflicts: readonly InkSurfaceConflict[] = [];
  private currentContentEl: HTMLElement | null = null;
  private currentFileStale = false;
  private currentHeaderActionsEl: HTMLElement | null = null;
  private readonly sidebarIsland: UiIsland<AnnotationSidebarAppProps> =
    createPreactIsland(AnnotationSidebarApp);
  private readonly sidebarStore = new AnnotationSidebarStore();
  private readonly currentInkSummaryGenerations = new Map<string, number>();
  private currentRefreshGeneration = 0;
  private readonly commands: Required<Pick<AnnotationSidebarCommands, 'closed' | 'issue'>> &
    Omit<AnnotationSidebarCommands, 'closed' | 'issue'>;
  private readonly conflictDialog: AnnotationConflictDialog;
  private recentDeletion: readonly AnnotationSidebarDeletedItem[] = [];
  private recentDeletionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inkRepository: InkSurfaceRepository;
  private readonly service: AnnotationService;
  private readonly stylePresets: readonly StylePreset[];
  private readonly vaultIndex: VaultAnnotationIndex;
  private readonly vaultIndexBuilder: VaultIndexBuilder;
  private vaultBuildAbort: AbortController | null = null;
  private vaultComponent: VaultAnnotationSidebar | null = null;
  private vaultIndexFresh = false;
  private vaultRestoreAttempted = false;
  private vaultContentEl: HTMLElement | null = null;
  private vaultHeaderActionsEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    input: {
      readonly commands: AnnotationSidebarCommands;
      readonly inkRepository: InkSurfaceRepository;
      readonly service: AnnotationService;
      readonly stylePresets: readonly StylePreset[];
      readonly vaultIndex: VaultAnnotationIndex;
      readonly vaultIndexBuilder: VaultIndexBuilder;
    },
  ) {
    super(leaf);
    this.commands = {
      ...input.commands,
      closed: input.commands.closed ?? (() => undefined),
      issue: input.commands.issue ?? (() => undefined),
    };
    this.conflictDialog = new AnnotationConflictDialog({ document: this.contentEl.ownerDocument });
    this.inkRepository = input.inkRepository;
    this.service = input.service;
    this.stylePresets = input.stylePresets;
    this.vaultIndex = input.vaultIndex;
    this.vaultIndexBuilder = input.vaultIndexBuilder;
  }

  getViewType(): string {
    return ANNOTATION_SIDEBAR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Annotations';
  }

  override getIcon(): string {
    return 'highlighter';
  }

  override async onOpen(): Promise<void> {
    this.contentEl.classList.add('inkstone-annotation-sidebar-view');
    this.sidebarIsland.mount(this.contentEl, {
      onCurrentContentMount: (host) => {
        this.currentContentEl = host;
      },
      onCurrentHeaderActionsMount: (host) => {
        this.currentHeaderActionsEl = host;
      },
      onRetryCurrent: () => {
        void this.refreshCurrentFile();
      },
      onRetryVault: () => {
        this.vaultIndexFresh = false;
        void this.refreshVaultIndex();
      },
      onRestoreRecentDeletion: () => {
        void this.restoreRecentDeletion();
      },
      onScopeChange: (scope) => {
        if (scope === 'current-file') {
          void this.showCurrentFile();
        } else {
          void this.showEntireVault();
        }
      },
      onVaultContentMount: (host) => {
        this.vaultContentEl = host;
      },
      onVaultHeaderActionsMount: (host) => {
        this.vaultHeaderActionsEl = host;
      },
      store: this.sidebarStore,
    });
    await this.showCurrentFile();
  }

  override onClose(): Promise<void> {
    this.vaultBuildAbort?.abort();
    this.vaultBuildAbort = null;
    this.clearRecentDeletion();
    this.currentComponent?.dispose();
    this.currentComponent = null;
    this.vaultComponent?.dispose();
    this.vaultComponent = null;
    this.currentConflicts = [];
    this.currentInkConflicts = [];
    this.conflictDialog.close(false);
    this.sidebarIsland.unmount();
    this.contentEl.classList.remove('inkstone-annotation-sidebar-view');
    this.currentContentEl = null;
    this.currentHeaderActionsEl = null;
    this.vaultContentEl = null;
    this.vaultHeaderActionsEl = null;
    this.commands.closed();
    return Promise.resolve();
  }

  async refresh(): Promise<void> {
    if (this.sidebarStore.scope.value === 'entire-vault') {
      if (this.sidebarStore.current.filePath.peek() !== this.commands.getCurrentFilePath()) {
        this.currentFileStale = true;
      }
      this.vaultComponent?.showReady();
      return;
    }
    if (this.currentComponent === null) {
      return;
    }
    await this.refreshCurrentFile();
  }

  async followActiveFile(): Promise<void> {
    const filePath = this.commands.getCurrentFilePath();
    if (this.sidebarStore.scope.value === 'entire-vault') {
      if (this.sidebarStore.current.filePath.peek() !== filePath) this.currentFileStale = true;
      return;
    }
    if (
      this.currentComponent === null ||
      (!this.currentFileStale && this.sidebarStore.current.filePath.peek() === filePath)
    ) {
      return;
    }
    await this.refreshCurrentFile();
  }

  async refreshAfterCanonicalSidecarChange(): Promise<void> {
    this.currentFileStale = true;
    this.vaultIndexFresh = false;
    if (this.sidebarStore.scope.value === 'entire-vault') {
      await this.refreshVaultIndex();
      return;
    }
    await this.refreshCurrentFile();
  }

  async refreshAfterCanonicalMutation(filePath: string): Promise<void> {
    const currentFilePath = this.commands.getCurrentFilePath();
    if (this.currentCache?.filePath === filePath || currentFilePath === filePath) {
      this.currentFileStale = true;
    }
    if (
      this.sidebarStore.scope.value === 'current-file' &&
      this.currentComponent !== null &&
      currentFilePath === filePath
    ) {
      await this.refreshCurrentFile();
    }
  }

  applyInkSurfaceSummaries(filePath: string, summaries: readonly InkSurfaceSummary[]): void {
    assertInkSummarySetForFile(filePath, summaries);
    const authoritativeSummaries = [...summaries];
    this.currentInkSummaryGenerations.set(
      filePath,
      (this.currentInkSummaryGenerations.get(filePath) ?? 0) + 1,
    );

    if (this.currentCache?.filePath === filePath) {
      this.currentCache = {
        ...this.currentCache,
        inkSummaries: authoritativeSummaries,
      };
    }
    if (
      this.sidebarStore.scope.value !== 'current-file' ||
      this.sidebarStore.current.filePath.value !== filePath
    ) {
      return;
    }
    this.sidebarStore.current.inkSummaries.value = authoritativeSummaries;
    if (this.currentCache?.filePath !== filePath) {
      this.currentFileStale = true;
      if (this.currentComponent !== null) void this.refreshCurrentFile();
    }
  }

  selectAnnotation(annotationIds: readonly string[]): boolean {
    for (const annotationId of annotationIds) {
      if (this.currentComponent?.selectAnnotation(annotationId) === true) {
        return true;
      }
    }
    return false;
  }

  private async showCurrentFile(): Promise<void> {
    this.sidebarStore.setScope('current-file');
    if (this.currentComponent !== null) {
      if (
        this.currentFileStale ||
        this.sidebarStore.current.filePath.peek() !== this.commands.getCurrentFilePath()
      ) {
        await this.refreshCurrentFile();
      }
      return;
    }
    this.currentConflicts = [];
    this.currentInkConflicts = [];
    this.currentComponent = new CurrentFileSidebar({
      container: this.getCurrentContentEl(),
      document: this.contentEl.ownerDocument,
      headerContainer: this.getCurrentHeaderActionsEl(),
      onBulkAddTags: async (selection, tags) => {
        const outcome = await this.service.bulkAddTags(selection, tags);
        await this.refreshCurrentFile();
        return {
          failed: selection.filter((item) =>
            outcome.failed.some(
              (candidate) => candidate.filePath === item.filePath && candidate.id === item.id,
            ),
          ),
        };
      },
      onBulkChangeStyle: async (selection, styleId) => {
        const outcome = await this.service.bulkChangeStyle(selection, styleId);
        await this.refreshCurrentFile();
        return {
          failed: selection.filter((item) =>
            outcome.failed.some(
              (candidate) => candidate.filePath === item.filePath && candidate.id === item.id,
            ),
          ),
        };
      },
      onBulkCopy: async (selection) => {
        const clipboard = globalThis.navigator.clipboard;
        if (clipboard === undefined) throw new Error('Clipboard API is unavailable.');
        await clipboard.writeText(
          `${selection
            .map(
              (entry) =>
                `- ${entry.quote} — ${entry.filePath}${entry.body === undefined ? '' : `\n  ${entry.body}`}`,
            )
            .join('\n')}\n`,
        );
      },
      onBulkDelete: async (selection) => {
        const outcome = await this.commands.bulkDelete(selection);
        this.showRecentDeletion(outcome.succeeded);
        return {
          failed: selection.filter((item) =>
            outcome.failed.some(
              (candidate) => candidate.filePath === item.filePath && candidate.id === item.id,
            ),
          ),
        };
      },
      onBulkExport: async (selection, invoker) => {
        const entries = await Promise.all(
          selection.map(async (item) => {
            if (item.type !== 'ink') {
              const [record] = await this.service.getAnnotationsById(item.filePath, [item.id]);
              return record === undefined ? [] : [textRecordToIndexEntry(record)];
            }
            const [surface, loaded] = await Promise.all([
              this.inkRepository.readSurface(item.filePath, item.id),
              this.inkRepository.listSurfaces(item.filePath),
            ]);
            return surface === null
              ? []
              : [
                  inkSummaryToIndexEntry(
                    summarizeInkSurface(surface, { relatedRecords: loaded.records }),
                    surface.noteId,
                  ),
                ];
          }),
        );
        this.commands.exportVaultEntries(entries.flat(), invoker);
      },
      onEntireVault: () => this.showEntireVault(),
      onDeleteAnnotation: (annotationId, expectedRevision) => {
        const filePath = this.commands.getCurrentFilePath();
        if (filePath !== null) {
          void this.commands
            .deleteAnnotation(filePath, annotationId, expectedRevision)
            .catch(this.commands.issue);
        }
      },
      onDeleteInk: (surfaceId, expectedRevision) => {
        const filePath = this.commands.getCurrentFilePath();
        if (filePath !== null) {
          void this.commands
            .deleteInk(filePath, surfaceId, expectedRevision)
            .then(() => this.refreshCurrentFile(), this.commands.issue);
        }
      },
      onEditInk: (surfaceId) => {
        const filePath = this.commands.getCurrentFilePath();
        if (filePath !== null) this.commands.editInk(filePath, surfaceId);
      },
      onExportCurrentFile: (invoker) => {
        const filePath = this.commands.getCurrentFilePath();
        if (filePath !== null) {
          this.commands.exportCurrentFile(filePath, invoker);
        }
      },
      onExportInkPng: (surfaceId) => {
        const filePath = this.commands.getCurrentFilePath();
        if (filePath !== null)
          void this.commands.exportInkPng(filePath, surfaceId).catch(this.commands.issue);
      },
      onExportInkReport: () => {
        const filePath = this.commands.getCurrentFilePath();
        if (filePath !== null)
          void this.commands.exportInkReport(filePath).catch(this.commands.issue);
      },
      onExportInkSvg: (surfaceId) => {
        const filePath = this.commands.getCurrentFilePath();
        if (filePath !== null)
          void this.commands.exportInkSvg(filePath, surfaceId).catch(this.commands.issue);
      },
      onInspect: this.commands.inspectAnnotation,
      ...(this.commands.repairAnnotation === undefined
        ? {}
        : {
            onRepairAnnotation: (annotationId: string, invoker: HTMLElement) => {
              const filePath = this.commands.getCurrentFilePath();
              if (filePath !== null) {
                void this.commands
                  .repairAnnotation?.(filePath, annotationId, invoker)
                  .catch(this.commands.issue);
              }
            },
          }),
      onRetry: () => void this.refreshCurrentFile(),
      onReviewConflicts: (invoker) => this.showConflictDialog(invoker),
      onRestoreInk: (surfaceId, expectedRevision) => {
        const filePath = this.commands.getCurrentFilePath();
        if (filePath !== null) {
          void this.commands
            .restoreInk(filePath, surfaceId, expectedRevision)
            .then(() => this.refreshCurrentFile(), this.commands.issue);
        }
      },
      onRestoreAnnotation: (annotationId, expectedRevision) => {
        const filePath = this.commands.getCurrentFilePath();
        if (filePath !== null) {
          void this.commands
            .restoreAnnotation(filePath, annotationId, expectedRevision)
            .catch(this.commands.issue);
        }
      },
      onSelect: (annotationId) => {
        if (!this.commands.navigateToAnnotation(annotationId)) {
          this.currentComponent?.selectAnnotation(annotationId);
        }
      },
      onSelectInk: this.commands.navigateToInk,
      showScope: false,
      state: this.sidebarStore.current,
      styleOptions: this.stylePresets.map((preset) => [preset.id, preset.name ?? preset.id]),
    });
    const cached = this.currentCache;
    if (cached !== null && cached.filePath === this.commands.getCurrentFilePath()) {
      this.currentComponent.render(cached.model, cached.health, cached.inkSummaries);
    }
    await this.refreshCurrentFile();
  }

  private async refreshCurrentFile(): Promise<void> {
    const component = this.currentComponent;
    if (component === null) {
      return;
    }
    const generation = ++this.currentRefreshGeneration;
    const filePath = this.commands.getCurrentFilePath();
    this.sidebarStore.current.filePath.value = filePath;
    if (filePath === null) {
      this.currentCache = null;
      this.currentFileStale = false;
      this.currentConflicts = [];
      this.currentInkConflicts = [];
      if (this.currentComponent === component) {
        component.render({ groups: [], total: 0 });
      }
      return;
    }
    const inkSummaryGeneration = this.currentInkSummaryGenerations.get(filePath) ?? 0;
    if (
      this.sidebarStore.current.status.peek() !== 'ready' ||
      this.currentCache?.filePath !== filePath
    ) {
      this.sidebarStore.current.status.value = 'loading';
    }
    try {
      const [loaded, inkSummaries] = await Promise.all([
        this.service.listCurrentFile(filePath),
        this.inkRepository.listSurfaceSummaries(filePath),
      ]);
      if (this.currentComponent !== component || generation !== this.currentRefreshGeneration) {
        return;
      }
      const projectedInkSummaries =
        (this.currentInkSummaryGenerations.get(filePath) ?? 0) === inkSummaryGeneration
          ? inkSummaries
          : this.currentCache?.filePath === filePath
            ? this.currentCache.inkSummaries
            : this.sidebarStore.current.filePath.peek() === filePath
              ? this.sidebarStore.current.inkSummaries.peek()
              : inkSummaries;
      loaded.issues.forEach(this.commands.issue);
      const currentConflicts = loaded.conflicts.filter(
        (conflict) => conflict.kind === 'same-revision-divergence',
      );
      const inkConflicts = projectedInkSummaries.some((summary) => summary.conflict === true)
        ? (await this.inkRepository.listSurfaces(filePath)).conflicts.filter(
            (conflict) => conflict.kind === 'same-revision-divergence',
          )
        : [];
      if (this.currentComponent !== component || generation !== this.currentRefreshGeneration)
        return;
      this.currentConflicts = currentConflicts;
      this.currentInkConflicts = inkConflicts;
      const health = {
        conflictCount: currentConflicts.length + inkConflicts.length,
        readIssueCount: loaded.issues.filter((issue) => issue.kind === 'corrupt-record').length,
      };
      this.currentCache = {
        filePath,
        health,
        inkSummaries: projectedInkSummaries,
        model: loaded.model,
      };
      this.currentFileStale = false;
      component.render(loaded.model, health, projectedInkSummaries);
    } catch (error) {
      if (this.currentComponent !== component || generation !== this.currentRefreshGeneration) {
        return;
      }
      this.commands.issue(error);
      this.currentFileStale = false;
      component.renderFailure(storageFailureMessage(error));
    }
  }

  private async showEntireVault(): Promise<void> {
    this.sidebarStore.setScope('entire-vault');
    if (this.vaultComponent !== null) {
      await this.refreshVaultIndex();
      return;
    }
    this.conflictDialog.close(false);
    this.currentConflicts = [];
    this.currentInkConflicts = [];
    this.vaultBuildAbort?.abort();
    this.vaultBuildAbort = null;
    const retainFailures = <T extends { readonly filePath: string; readonly id: string }>(
      selection: readonly T[],
      failed: readonly { readonly filePath: string; readonly id: string }[],
    ): readonly T[] =>
      selection.filter((item) =>
        failed.some(
          (candidate) => candidate.filePath === item.filePath && candidate.id === item.id,
        ),
      );
    const updateIndex = (records: readonly TextAnnotationRecord[]): void => {
      for (const record of records) {
        const styleName =
          record.mark === undefined
            ? undefined
            : this.vaultIndex.snapshot().find((entry) => entry.styleId === record.mark?.styleId)
                ?.styleName;
        this.vaultIndex.upsert(
          textRecordToIndexEntry(record, {
            ...(styleName === undefined ? {} : { styleName }),
          }),
        );
      }
    };
    const component = new VaultAnnotationSidebar({
      container: this.getVaultContentEl(),
      document: this.contentEl.ownerDocument,
      headerContainer: this.getVaultHeaderActionsEl(),
      index: this.vaultIndex,
      onBulkAddTags: async (selection, tags) => {
        const outcome = await this.service.bulkAddTags(selection, tags);
        updateIndex(outcome.succeeded);
        return { failed: retainFailures(selection, outcome.failed) };
      },
      onBulkChangeStyle: async (selection, styleId) => {
        const outcome = await this.service.bulkChangeStyle(selection, styleId);
        updateIndex(outcome.succeeded);
        return { failed: retainFailures(selection, outcome.failed) };
      },
      onBulkCopy: async (entries) => {
        const clipboard = globalThis.navigator.clipboard;
        if (clipboard === undefined) {
          throw new Error('Clipboard API is unavailable.');
        }
        await clipboard.writeText(
          `${entries
            .map(
              (entry) =>
                `- ${entry.quote} — ${entry.filePath}${entry.body === undefined ? '' : `\n  ${entry.body}`}`,
            )
            .join('\n')}\n`,
        );
      },
      onBulkDelete: async (selection) => {
        const outcome = await this.commands.bulkDelete(selection);
        for (const record of outcome.succeeded) {
          if (record.noteId === undefined) continue;
          this.vaultIndex.removeAtOrBelow({
            id: record.id,
            maximumRevision: record.deletedRevision - 1,
            noteId: record.noteId,
          });
        }
        this.showRecentDeletion(outcome.succeeded);
        return {
          failed: retainFailures(selection, outcome.failed),
        };
      },
      onCurrentFile: () => this.showCurrentFile(),
      onEdit: (entry, invoker) => {
        if (entry.type === 'ink') {
          this.commands.editInk(entry.filePath, entry.id);
          return;
        }
        this.commands.inspectAnnotation(entry.id, invoker);
      },
      onExport: this.commands.exportVaultEntries,
      onOpen: (entry) => this.commands.navigateToVaultAnnotation(entry),
      state: this.sidebarStore.vault,
      showScope: false,
      styleOptions: this.stylePresets.map((preset) => [preset.id, preset.name ?? preset.id]),
    });
    this.vaultComponent = component;
    if (this.vaultIndex.isReady()) {
      component.showReady();
    } else {
      component.showBuilding({ completed: 0, total: 0 });
    }
    await this.refreshVaultIndex();
  }

  private getCurrentContentEl(): HTMLElement {
    if (this.currentContentEl === null) {
      throw new Error('The annotation sidebar shell is not mounted.');
    }
    return this.currentContentEl;
  }

  private getCurrentHeaderActionsEl(): HTMLElement {
    if (this.currentHeaderActionsEl === null) {
      throw new Error('The annotation sidebar header is not mounted.');
    }
    return this.currentHeaderActionsEl;
  }

  private getVaultContentEl(): HTMLElement {
    if (this.vaultContentEl === null) {
      throw new Error('The annotation sidebar shell is not mounted.');
    }
    return this.vaultContentEl;
  }

  private getVaultHeaderActionsEl(): HTMLElement {
    if (this.vaultHeaderActionsEl === null) {
      throw new Error('The annotation sidebar header is not mounted.');
    }
    return this.vaultHeaderActionsEl;
  }

  private async refreshVaultIndex(): Promise<void> {
    const component = this.vaultComponent;
    if (component === null || this.vaultIndexFresh) return;
    this.vaultBuildAbort?.abort();
    const abort = new AbortController();
    this.vaultBuildAbort = abort;
    let hasUsableIndex = this.vaultIndex.isReady();
    try {
      if (!hasUsableIndex && !this.vaultRestoreAttempted) {
        this.vaultRestoreAttempted = true;
        await this.vaultIndexBuilder.restoreCached();
        hasUsableIndex = this.vaultIndex.isReady();
      }
      if (hasUsableIndex) {
        component.showReady();
      } else {
        component.showBuilding({ completed: 0, total: 0 });
      }
      const rebuild = await this.vaultIndexBuilder.rebuild({
        onProgress: (progress) => {
          if (!abort.signal.aborted && !hasUsableIndex && this.vaultComponent === component) {
            component.showBuilding(progress);
          }
        },
        signal: abort.signal,
      });
      if (!abort.signal.aborted && this.vaultComponent === component) {
        this.vaultIndexFresh = rebuild.status !== 'superseded';
        component.showReady();
      }
    } catch (error) {
      if (!abort.signal.aborted && this.vaultComponent === component) {
        this.commands.issue(error);
        if (hasUsableIndex) {
          component.showReady();
        } else {
          component.showUnavailable(storageFailureMessage(error));
        }
      }
    } finally {
      if (this.vaultBuildAbort === abort) this.vaultBuildAbort = null;
    }
  }

  private showConflictDialog(invoker: HTMLElement): void {
    const conflicts = this.currentConflicts;
    const inkConflicts = this.currentInkConflicts;
    if (conflicts.length === 0 && inkConflicts.length === 0) return;
    const views: readonly AnnotationConflictReviewView[] = [
      ...conflicts.map((conflict) => ({
        annotationId: conflict.annotationId,
        candidates: conflict.candidates.map(({ path, record }) => ({
          ...(record.body === undefined ? {} : { body: record.body }),
          ...(record.deviceId === undefined ? {} : { deviceId: record.deviceId }),
          ...(record.mark === undefined ? {} : { mark: record.mark }),
          path,
          quote: annotationTargetText(record.target),
          revision: record.revision,
          tags: record.tags,
          updatedAt: record.updatedAt,
        })),
        kind: 'text' as const,
      })),
      ...inkConflicts.map((conflict) => ({
        annotationId: conflict.surfaceId,
        candidates: conflict.candidates.map(({ path, record }) => {
          let previewSvg: string | undefined;
          try {
            previewSvg = summarizeInkSurface(record).thumbnailSvg;
          } catch {
            // A conflict candidate is only one record, so linked physical Ink may be incomplete.
            // Keep repair available without rendering a misleading capped fragment preview.
          }
          const strokeCount = record.strokes.filter((stroke) => stroke.tool !== 'eraser').length;
          const headingPath = record.binding?.headingPath ?? [];
          return {
            body: `${strokeCount} ${strokeCount === 1 ? 'stroke' : 'strokes'} · ${record.status}`,
            ...(record.deviceId === undefined ? {} : { deviceId: record.deviceId }),
            path,
            ...(previewSvg === undefined ? {} : { previewSvg }),
            quote: headingPath.length === 0 ? 'Document Ink' : headingPath.join(' › '),
            revision: record.revision,
            tags: [],
            updatedAt: record.updatedAt,
          };
        }),
        kind: 'ink' as const,
      })),
    ];
    this.conflictDialog.show({
      conflicts: views,
      invoker,
      onResolve: async (annotationId, candidatePath, kind) => {
        const filePath = this.commands.getCurrentFilePath();
        if (filePath === null) {
          throw new Error('The annotation conflict is no longer available.');
        }
        if (kind === 'ink') {
          const conflict = inkConflicts.find((candidate) => candidate.surfaceId === annotationId);
          if (conflict === undefined) {
            throw new Error('The Ink conflict is no longer available.');
          }
          await this.commands.repairInkConflict(filePath, conflict, candidatePath);
        } else {
          const conflict = conflicts.find((candidate) => candidate.annotationId === annotationId);
          if (conflict === undefined) {
            throw new Error('The annotation conflict is no longer available.');
          }
          await this.service.repairConflict(filePath, conflict, candidatePath);
        }
        await this.refreshCurrentFile();
      },
    });
  }

  private showRecentDeletion(items: readonly AnnotationSidebarDeletedItem[]): void {
    if (items.length === 0) return;
    const now = Date.now();
    const currentState = this.sidebarStore.recentDeletion.peek();
    const previousItems =
      currentState !== null && !currentState.pending && currentState.expiresAt > now
        ? this.recentDeletion
        : [];
    this.recentDeletion = mergeDeletedItems(previousItems, items);
    this.scheduleRecentDeletionExpiry({
      count: this.recentDeletion.length,
      error: null,
      expiresAt: now + 5_000,
      pending: false,
    });
  }

  private async restoreRecentDeletion(): Promise<void> {
    const receipt = this.recentDeletion;
    if (receipt.length === 0 || this.sidebarStore.recentDeletion.peek()?.pending === true) return;
    if (this.recentDeletionTimer !== null) {
      clearTimeout(this.recentDeletionTimer);
      this.recentDeletionTimer = null;
    }
    this.sidebarStore.recentDeletion.value = {
      count: receipt.length,
      error: null,
      expiresAt: Number.POSITIVE_INFINITY,
      pending: true,
    };
    try {
      const outcome = await this.commands.restoreDeleted(receipt);
      if (this.recentDeletion !== receipt) return;
      if (outcome.failed.length === 0) {
        this.clearRecentDeletion();
        return;
      }
      this.recentDeletion = outcome.failed;
      this.scheduleRecentDeletionExpiry({
        count: outcome.failed.length,
        error: `${outcome.failed.length} ${outcome.failed.length === 1 ? 'annotation' : 'annotations'} could not be restored.`,
        expiresAt: Date.now() + 5_000,
        pending: false,
      });
    } catch (error) {
      if (this.recentDeletion !== receipt) return;
      this.scheduleRecentDeletionExpiry({
        count: receipt.length,
        error: error instanceof Error ? error.message : String(error),
        expiresAt: Date.now() + 5_000,
        pending: false,
      });
      this.commands.issue(error);
    }
  }

  private scheduleRecentDeletionExpiry(state: {
    readonly count: number;
    readonly error: string | null;
    readonly expiresAt: number;
    readonly pending: boolean;
  }): void {
    if (this.recentDeletionTimer !== null) clearTimeout(this.recentDeletionTimer);
    this.sidebarStore.recentDeletion.value = state;
    this.recentDeletionTimer = setTimeout(() => this.clearRecentDeletion(), 5_000);
  }

  private clearRecentDeletion(): void {
    if (this.recentDeletionTimer !== null) clearTimeout(this.recentDeletionTimer);
    this.recentDeletionTimer = null;
    this.recentDeletion = [];
    this.sidebarStore.recentDeletion.value = null;
  }
}

function assertInkSummarySetForFile(
  filePath: string,
  summaries: readonly InkSurfaceSummary[],
): void {
  const ids = new Set<string>();
  for (const summary of summaries) {
    if (summary.filePath !== filePath) {
      throw new Error(
        `Ink sidebar summary for ${filePath} included another note: ${summary.filePath}.`,
      );
    }
    if (ids.has(summary.id)) {
      throw new Error(`Ink sidebar summary for ${filePath} contains duplicate ${summary.id}.`);
    }
    ids.add(summary.id);
  }
}

function mergeDeletedItems(
  current: readonly AnnotationSidebarDeletedItem[],
  added: readonly AnnotationSidebarDeletedItem[],
): readonly AnnotationSidebarDeletedItem[] {
  const merged = new Map<string, AnnotationSidebarDeletedItem>();
  for (const item of [...current, ...added]) {
    merged.set(
      `${item.type}\u0000${item.filePath}\u0000${item.id}\u0000${item.deletedRevision}`,
      item,
    );
  }
  return [...merged.values()];
}

function storageFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|not downloaded|hydrate/iu.test(message)) {
    return "Annotation files aren't available locally yet.";
  }
  if (/quota|space|disk full/iu.test(message)) {
    return 'There is not enough local storage to read annotations.';
  }
  if (/permission|denied|read-only/iu.test(message)) {
    return 'Obsidian cannot access the local annotation files.';
  }
  return "Couldn't read annotations locally.";
}
