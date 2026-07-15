import { ItemView, type WorkspaceLeaf } from 'obsidian';

import type { AnnotationService } from '../../application/annotation-service';
import type { VaultIndexBuilder } from '../../application/vault-index-builder';
import type {
  AnnotationIndexEntry,
  VaultAnnotationIndex,
} from '../../domain/vault-annotation-index';
import { textRecordToIndexEntry } from '../../domain/vault-annotation-index';
import type { TextAnnotationRecord } from '../../domain/text-annotation';
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
  private readonly conflictDialog: AnnotationConflictDialog;
  private readonly getCurrentFilePath: () => string | null;
  private readonly navigateToAnnotation: (annotationId: string) => boolean;
  private readonly navigateToVaultAnnotation: (entry: AnnotationIndexEntry) => void;
  private readonly inspectAnnotation: (annotationId: string, invoker: HTMLElement) => void;
  private readonly inkRepository: InkSurfaceRepository;
  private readonly onDeleteInk: (filePath: string, surfaceId: string) => Promise<void>;
  private readonly onDeleteAnnotation: (filePath: string, annotationId: string) => Promise<void>;
  private readonly onBulkDeleteInk: (
    selection: readonly {
      readonly expectedRevision: number;
      readonly filePath: string;
      readonly id: string;
      readonly noteId: string;
      readonly type: AnnotationIndexEntry['type'];
    }[],
  ) => Promise<{
    readonly failed: readonly {
      readonly expectedRevision: number;
      readonly filePath: string;
      readonly id: string;
      readonly noteId: string;
      readonly type: AnnotationIndexEntry['type'];
    }[];
  }>;
  private readonly onEditInk: (filePath: string, surfaceId: string) => void;
  private readonly onExportInkPng: (filePath: string, surfaceId: string) => Promise<void>;
  private readonly onExportInkReport: (filePath: string) => Promise<void>;
  private readonly onExportInkSvg: (filePath: string, surfaceId: string) => Promise<void>;
  private readonly onRepairInkConflict: (
    filePath: string,
    conflict: InkSurfaceConflict,
    candidatePath: string,
  ) => Promise<void>;
  private readonly onNavigateInk: (summary: InkSurfaceSummary) => void;
  private readonly onRestoreInk: (filePath: string, surfaceId: string) => Promise<void>;
  private readonly onRestoreAnnotation: (
    filePath: string,
    annotationId: string,
    expectedRevision: number,
  ) => Promise<void>;
  private readonly onClosed: () => void;
  private readonly onExportCurrentFile: (filePath: string, invoker: HTMLElement) => void;
  private readonly onExportVaultEntries: (
    entries: readonly AnnotationIndexEntry[],
    invoker: HTMLElement,
  ) => void;
  private readonly onIssue: (error: unknown) => void;
  private readonly service: AnnotationService;
  private readonly stylePresets: readonly StylePreset[];
  private readonly vaultIndex: VaultAnnotationIndex;
  private readonly vaultIndexBuilder: VaultIndexBuilder;
  private vaultBuildAbort: AbortController | null = null;
  private vaultComponent: VaultAnnotationSidebar | null = null;
  private vaultIndexFresh = false;
  private vaultRestoreAttempted = false;

  constructor(
    leaf: WorkspaceLeaf,
    input: {
      readonly getCurrentFilePath: () => string | null;
      readonly inspectAnnotation: (annotationId: string, invoker: HTMLElement) => void;
      readonly inkRepository: InkSurfaceRepository;
      readonly navigateToAnnotation: (annotationId: string) => boolean;
      readonly navigateToVaultAnnotation: (entry: AnnotationIndexEntry) => void;
      readonly onClosed?: () => void;
      readonly onBulkDeleteInk: AnnotationSidebarView['onBulkDeleteInk'];
      readonly onDeleteAnnotation: AnnotationSidebarView['onDeleteAnnotation'];
      readonly onDeleteInk: (filePath: string, surfaceId: string) => Promise<void>;
      readonly onEditInk: (filePath: string, surfaceId: string) => void;
      readonly onExportInkPng: (filePath: string, surfaceId: string) => Promise<void>;
      readonly onExportInkReport: (filePath: string) => Promise<void>;
      readonly onExportInkSvg: (filePath: string, surfaceId: string) => Promise<void>;
      readonly onNavigateInk: (summary: InkSurfaceSummary) => void;
      readonly onExportCurrentFile: (filePath: string, invoker: HTMLElement) => void;
      readonly onExportVaultEntries: (
        entries: readonly AnnotationIndexEntry[],
        invoker: HTMLElement,
      ) => void;
      readonly onIssue?: (error: unknown) => void;
      readonly onRepairInkConflict: AnnotationSidebarView['onRepairInkConflict'];
      readonly onRestoreInk: (filePath: string, surfaceId: string) => Promise<void>;
      readonly onRestoreAnnotation: AnnotationSidebarView['onRestoreAnnotation'];
      readonly service: AnnotationService;
      readonly stylePresets: readonly StylePreset[];
      readonly vaultIndex: VaultAnnotationIndex;
      readonly vaultIndexBuilder: VaultIndexBuilder;
    },
  ) {
    super(leaf);
    this.getCurrentFilePath = input.getCurrentFilePath;
    this.conflictDialog = new AnnotationConflictDialog({ document: this.contentEl.ownerDocument });
    this.inspectAnnotation = input.inspectAnnotation;
    this.inkRepository = input.inkRepository;
    this.navigateToAnnotation = input.navigateToAnnotation;
    this.navigateToVaultAnnotation = input.navigateToVaultAnnotation;
    this.onClosed = input.onClosed ?? (() => undefined);
    this.onBulkDeleteInk = input.onBulkDeleteInk;
    this.onDeleteAnnotation = input.onDeleteAnnotation;
    this.onDeleteInk = input.onDeleteInk;
    this.onEditInk = input.onEditInk;
    this.onExportInkPng = input.onExportInkPng;
    this.onExportInkReport = input.onExportInkReport;
    this.onExportInkSvg = input.onExportInkSvg;
    this.onNavigateInk = input.onNavigateInk;
    this.onExportCurrentFile = input.onExportCurrentFile;
    this.onExportVaultEntries = input.onExportVaultEntries;
    this.onIssue = input.onIssue ?? (() => undefined);
    this.onRepairInkConflict = input.onRepairInkConflict;
    this.onRestoreInk = input.onRestoreInk;
    this.onRestoreAnnotation = input.onRestoreAnnotation;
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
    await this.showCurrentFile();
  }

  override onClose(): Promise<void> {
    this.vaultBuildAbort?.abort();
    this.vaultBuildAbort = null;
    this.currentComponent?.dispose();
    this.currentComponent = null;
    this.vaultComponent = null;
    this.currentConflicts = [];
    this.currentInkConflicts = [];
    this.conflictDialog.close(false);
    this.contentEl.empty();
    this.onClosed();
    return Promise.resolve();
  }

  async refresh(): Promise<void> {
    if (this.vaultComponent !== null) {
      this.vaultComponent.showReady();
      return;
    }
    if (this.currentComponent === null) {
      return;
    }
    await this.refreshCurrentFile();
  }

  async refreshAfterCanonicalSidecarChange(): Promise<void> {
    this.vaultIndexFresh = false;
    if (this.vaultComponent !== null) {
      await this.refreshVaultIndex();
      return;
    }
    await this.refreshCurrentFile();
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
    if (this.currentComponent !== null) return;
    this.vaultBuildAbort?.abort();
    this.vaultBuildAbort = null;
    this.vaultComponent = null;
    this.currentConflicts = [];
    this.currentInkConflicts = [];
    this.currentComponent = new CurrentFileSidebar({
      container: this.contentEl,
      document: this.contentEl.ownerDocument,
      onEntireVault: () => this.showEntireVault(),
      onDeleteAnnotation: (annotationId) => {
        const filePath = this.getCurrentFilePath();
        if (filePath !== null) {
          void this.onDeleteAnnotation(filePath, annotationId).catch(this.onIssue);
        }
      },
      onDeleteInk: (surfaceId) => {
        const filePath = this.getCurrentFilePath();
        if (filePath !== null) {
          void this.onDeleteInk(filePath, surfaceId).then(
            () => this.refreshCurrentFile(),
            this.onIssue,
          );
        }
      },
      onEditInk: (surfaceId) => {
        const filePath = this.getCurrentFilePath();
        if (filePath !== null) this.onEditInk(filePath, surfaceId);
      },
      onExportCurrentFile: (invoker) => {
        const filePath = this.getCurrentFilePath();
        if (filePath !== null) {
          this.onExportCurrentFile(filePath, invoker);
        }
      },
      onExportInkPng: (surfaceId) => {
        const filePath = this.getCurrentFilePath();
        if (filePath !== null) void this.onExportInkPng(filePath, surfaceId).catch(this.onIssue);
      },
      onExportInkReport: () => {
        const filePath = this.getCurrentFilePath();
        if (filePath !== null) void this.onExportInkReport(filePath).catch(this.onIssue);
      },
      onExportInkSvg: (surfaceId) => {
        const filePath = this.getCurrentFilePath();
        if (filePath !== null) void this.onExportInkSvg(filePath, surfaceId).catch(this.onIssue);
      },
      onInspect: this.inspectAnnotation,
      onRetry: () => void this.refreshCurrentFile(),
      onReviewConflicts: (invoker) => this.showConflictDialog(invoker),
      onRestoreInk: (surfaceId) => {
        const filePath = this.getCurrentFilePath();
        if (filePath !== null) {
          void this.onRestoreInk(filePath, surfaceId).then(
            () => this.refreshCurrentFile(),
            this.onIssue,
          );
        }
      },
      onRestoreAnnotation: (annotationId, expectedRevision) => {
        const filePath = this.getCurrentFilePath();
        if (filePath !== null) {
          void this.onRestoreAnnotation(filePath, annotationId, expectedRevision).catch(
            this.onIssue,
          );
        }
      },
      onSelect: (annotationId) => {
        if (!this.navigateToAnnotation(annotationId)) {
          this.currentComponent?.selectAnnotation(annotationId);
        }
      },
      onSelectInk: this.onNavigateInk,
    });
    const cached = this.currentCache;
    if (cached !== null && cached.filePath === this.getCurrentFilePath()) {
      this.currentComponent.render(cached.model, cached.health, cached.inkSummaries);
    }
    await this.refreshCurrentFile();
  }

  private async refreshCurrentFile(): Promise<void> {
    const component = this.currentComponent;
    if (component === null) {
      return;
    }
    const filePath = this.getCurrentFilePath();
    if (filePath === null) {
      this.currentCache = null;
      this.currentConflicts = [];
      this.currentInkConflicts = [];
      if (this.currentComponent === component) {
        component.render({ groups: [], total: 0 });
      }
      return;
    }
    try {
      const [loaded, inkSummaries] = await Promise.all([
        this.service.listCurrentFile(filePath),
        this.inkRepository.listSurfaceSummaries(filePath),
      ]);
      if (this.currentComponent !== component) {
        return;
      }
      loaded.issues.forEach(this.onIssue);
      this.currentConflicts = loaded.conflicts.filter(
        (conflict) => conflict.kind === 'same-revision-divergence',
      );
      const inkConflicts = inkSummaries.some((summary) => summary.conflict === true)
        ? (await this.inkRepository.listSurfaces(filePath)).conflicts.filter(
            (conflict) => conflict.kind === 'same-revision-divergence',
          )
        : [];
      if (this.currentComponent !== component) return;
      this.currentInkConflicts = inkConflicts;
      const health = {
        conflictCount: this.currentConflicts.length + this.currentInkConflicts.length,
        readIssueCount: loaded.issues.filter((issue) => issue.kind === 'corrupt-record').length,
      };
      this.currentCache = { filePath, health, inkSummaries, model: loaded.model };
      component.render(loaded.model, health, inkSummaries);
    } catch (error) {
      if (this.currentComponent !== component) {
        return;
      }
      this.onIssue(error);
      component.renderFailure(storageFailureMessage(error));
    }
  }

  private async showEntireVault(): Promise<void> {
    if (this.vaultComponent !== null) return;
    this.conflictDialog.close(false);
    this.currentConflicts = [];
    this.currentInkConflicts = [];
    this.vaultBuildAbort?.abort();
    this.vaultBuildAbort = null;
    this.currentComponent?.dispose();
    this.currentComponent = null;
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
      container: this.contentEl,
      document: this.contentEl.ownerDocument,
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
        const textSelection = selection.filter((item) => item.type !== 'ink');
        const inkSelection = selection.filter((item) => item.type === 'ink');
        const [textOutcome, inkOutcome] = await Promise.all([
          this.service.bulkDelete(textSelection),
          this.onBulkDeleteInk(inkSelection),
        ]);
        for (const record of textOutcome.succeeded) {
          this.vaultIndex.remove({
            expectedRevision: record.revision - 1,
            id: record.id,
            noteId: record.noteId,
          });
        }
        return {
          failed: [...retainFailures(textSelection, textOutcome.failed), ...inkOutcome.failed],
        };
      },
      onCurrentFile: () => this.showCurrentFile(),
      onEdit: (entry, invoker) => {
        if (entry.type === 'ink') {
          this.onEditInk(entry.filePath, entry.id);
          return;
        }
        this.inspectAnnotation(entry.id, invoker);
      },
      onExport: this.onExportVaultEntries,
      onOpen: (entry) => this.navigateToVaultAnnotation(entry),
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
      await this.vaultIndexBuilder.rebuild({
        onProgress: (progress) => {
          if (!abort.signal.aborted && !hasUsableIndex && this.vaultComponent === component) {
            component.showBuilding(progress);
          }
        },
        signal: abort.signal,
      });
      if (!abort.signal.aborted && this.vaultComponent === component) {
        this.vaultIndexFresh = true;
        component.showReady();
      }
    } catch (error) {
      if (!abort.signal.aborted && this.vaultComponent === component) {
        this.onIssue(error);
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
          quote: record.target.quote.exact,
          revision: record.revision,
          tags: record.tags,
          updatedAt: record.updatedAt,
        })),
        kind: 'text' as const,
      })),
      ...inkConflicts.map((conflict) => ({
        annotationId: conflict.surfaceId,
        candidates: conflict.candidates.map(({ path, record }) => {
          const summary = summarizeInkSurface(record);
          return {
            body: `${summary.strokeCount} ${summary.strokeCount === 1 ? 'stroke' : 'strokes'} · ${summary.status}`,
            ...(record.deviceId === undefined ? {} : { deviceId: record.deviceId }),
            path,
            previewSvg: summary.thumbnailSvg,
            quote:
              summary.headingPath.length === 0 ? 'Document Ink' : summary.headingPath.join(' › '),
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
        const filePath = this.getCurrentFilePath();
        if (filePath === null) {
          throw new Error('The annotation conflict is no longer available.');
        }
        if (kind === 'ink') {
          const conflict = inkConflicts.find((candidate) => candidate.surfaceId === annotationId);
          if (conflict === undefined) {
            throw new Error('The Ink conflict is no longer available.');
          }
          await this.onRepairInkConflict(filePath, conflict, candidatePath);
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
