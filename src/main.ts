import {
  editorInfoField,
  editorLivePreviewField,
  MarkdownRenderChild,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TFile,
} from 'obsidian';

import { ObsidianVaultTextFileStore } from './adapters/obsidian/vault-text-file-store';
import { InkPhysicalGateExport } from './adapters/obsidian/ink-physical-gate-export';
import { ObsidianLocalPerformanceGate } from './adapters/obsidian/ink-local-performance-gate';
import {
  ANNOTATION_SIDEBAR_VIEW_TYPE,
  AnnotationSidebarView,
} from './adapters/obsidian/annotation-sidebar-view';
import { ReadingViewIntegration } from './adapters/obsidian/reading-view-integration';
import { ObsidianInkModeManager } from './adapters/obsidian/ink-mode-manager';
import {
  INKSTONE_LOCAL_PERFORMANCE_GATE,
  INKSTONE_UNPUBLISHED_PHYSICAL_INK_HAT,
} from './build-flags';
import { LivePreviewAnnotationCoordinator } from './adapters/obsidian/live-preview-extension';
import { shouldRefreshAnnotationSurfacesForModify } from './adapters/obsidian/markdown-view-mode';
import type {
  AnnotationSidebarBulkSelection,
  AnnotationSidebarDeletedItem,
} from './adapters/obsidian/annotation-sidebar-commands';
import { AnnotationService } from './application/annotation-service';
import { AnnotationProjectionCoordinator } from './application/annotation-projection-coordinator';
import { SidecarLifecycleService } from './application/sidecar-lifecycle-service';
import {
  buildTextAnnotationExportPath,
  sortTextAnnotationExportItems,
  streamTextAnnotationExport,
  type TextAnnotationExportFormat,
  type TextAnnotationExportItem,
} from './application/text-annotation-exporter';
import { writeTextExportFile } from './application/text-export-file-writer';
import { planVaultTextExport } from './application/vault-text-export-plan';
import {
  assertInkExportLoadSupported,
  writeInkPngExport,
  writeInkStandaloneReport,
  writeInkSvgExport,
} from './application/ink-export-file-writer';
import { VaultIndexBuilder } from './application/vault-index-builder';
import {
  CanonicalInkSurfaceProjectionCoordinator,
  applyCanonicalRecordChanged,
  applyCanonicalRecordRemoved,
} from './application/vault-index-events';
import type { InkSurfaceRecord } from './domain/ink-surface';
import { StylePresetCatalog } from './domain/style-preset';
import { annotationTargetText, type TextAnnotationRecord } from './domain/text-annotation';
import { VaultAnnotationIndex, type AnnotationIndexEntry } from './domain/vault-annotation-index';
import { AnnotationInspector } from './ui/annotation-inspector';
import { AnnotationExportDialog } from './ui/annotation-export-dialog';
import { Diagnostics, type DiagnosticMemoryMetricName } from './runtime/diagnostics';
import {
  INK_PERFORMANCE_LOCAL_GATE_MAX_RECENT_SPANS,
  InkPerformanceDiagnostics,
} from './runtime/ink-performance-diagnostics';
import { S27PhysicalGateCapture } from './runtime/ink-physical-gate-capture';
import { PluginRuntime } from './runtime/plugin-runtime';
import { VersionedSourceCache } from './runtime/versioned-source-cache';
import { InkstoneSettingTab } from './settings-tab';
import {
  DEFAULT_SETTINGS,
  ensureDeviceId,
  parseSettings,
  type InkPresentationAdapter,
  type InkstoneSettings,
} from './settings';
import { SidecarRepository } from './storage/sidecar-repository';
import { InkSurfaceRepository } from './storage/ink-surface-repository';
import { InkDocumentSnapshotRepository } from './storage/ink-document-snapshot-repository';
import { IndexedDbInkDocumentDraftStore } from './storage/indexeddb-ink-document-draft-store';
import { VaultIndexCache } from './storage/vault-index-cache';
import { LocalInkToolPreferenceStore } from './storage/local-ink-tool-preference';

export default class InkstoneAnnotationsPlugin extends Plugin {
  private readonly diagnostics = new Diagnostics(false);
  private readonly inkPerformance = new InkPerformanceDiagnostics(
    false,
    undefined,
    INK_PERFORMANCE_LOCAL_GATE_MAX_RECENT_SPANS,
  );
  private readonly physicalGateCapture = new S27PhysicalGateCapture({
    diagnostics: this.inkPerformance,
    selectedPresentationAdapterState: () =>
      this.inkModeManager?.activePresentationAdapterState ?? null,
  });
  private readonly runtime = new PluginRuntime();
  private pluginSettings: InkstoneSettings = DEFAULT_SETTINGS;
  private inkModeManager: ObsidianInkModeManager | null = null;
  private inspector: AnnotationInspector | null = null;
  private readingView: ReadingViewIntegration | null = null;
  private sidebarView: AnnotationSidebarView | null = null;

  override async onload(): Promise<void> {
    const startedAt = performance.now();

    const loadedSettings = parseSettings(await this.loadData());
    this.pluginSettings = ensureDeviceId(loadedSettings, () => globalThis.crypto.randomUUID());
    if (loadedSettings.deviceId !== this.pluginSettings.deviceId) {
      await this.saveData(this.pluginSettings);
    }
    this.diagnostics.setEnabled(this.pluginSettings.diagnosticsEnabled);
    this.inkPerformance.setEnabled(this.pluginSettings.diagnosticsEnabled);
    this.runtime.start();
    this.runtime.registerDisposer(() => this.physicalGateCapture.cancel());
    const readingSourceCache = new VersionedSourceCache(8);
    this.runtime.registerDisposer(() => readingSourceCache.clear());

    const sidecarStore = new ObsidianVaultTextFileStore(this.app.vault.adapter);
    const vaultIndex = new VaultAnnotationIndex();
    const styleName = (styleId: string): string | undefined =>
      this.pluginSettings.stylePresets.find((preset) => preset.id === styleId)?.name;
    const repository = new SidecarRepository(sidecarStore, {
      onEventIssue: (error) => console.warn('[Inkstone Annotations]', error),
      onRecordChanged: (record) => {
        applyCanonicalRecordChanged(vaultIndex, record, styleName);
      },
      onRecordRemoved: (record) => {
        applyCanonicalRecordRemoved(vaultIndex, record);
      },
    });
    let refreshInkSurfaceProjection: (record: InkSurfaceRecord) => void = () => undefined;
    const inkRepository = new InkSurfaceRepository(sidecarStore, {
      onEventIssue: (error) => console.warn('[Inkstone Annotations]', error),
      onSurfaceChanged: (record) => refreshInkSurfaceProjection(record),
    });
    const inkSnapshotRepository = new InkDocumentSnapshotRepository(sidecarStore);
    const inkDraftStore =
      globalThis.indexedDB === undefined
        ? undefined
        : new IndexedDbInkDocumentDraftStore(globalThis.indexedDB);
    if (inkDraftStore !== undefined) this.runtime.registerDisposer(() => inkDraftStore.close());
    const inkSurfaceProjections = new CanonicalInkSurfaceProjectionCoordinator({
      applySummaries: (filePath, summaries) =>
        this.sidebarView?.applyInkSurfaceSummaries(filePath, summaries),
      index: vaultIndex,
      listSurfaceSummaries: (filePath) => inkRepository.listSurfaceSummaries(filePath),
    });
    refreshInkSurfaceProjection = (record) => {
      void inkSurfaceProjections
        .refresh(record)
        .catch((error) => console.warn('[Inkstone Annotations]', error));
    };
    this.runtime.registerDisposer(() => inkSurfaceProjections.dispose());
    const annotationService = new AnnotationService({
      deviceId: this.pluginSettings.deviceId,
      repository,
    });
    const sidecarLifecycle = new SidecarLifecycleService({
      annotations: repository,
      ink: inkRepository,
      inkSnapshot: inkSnapshotRepository,
    });
    const exportDialog = new AnnotationExportDialog({ document: globalThis.document });
    this.runtime.registerDisposer(() => exportDialog.close(false));
    const exportItemsForFile = async (
      filePath: string,
    ): Promise<readonly TextAnnotationExportItem[]> => {
      const loaded = await repository.listAnnotations(filePath);
      loaded.issues.forEach((issue) => console.warn('[Inkstone Annotations]', issue));
      const conflictIds = new Set(loaded.conflicts.map((conflict) => conflict.annotationId));
      return sortTextAnnotationExportItems(
        loaded.records
          .filter((record) => record.deletedAt === undefined)
          .map((record) => ({
            conflict: conflictIds.has(record.id),
            record,
            ...(record.mark === undefined
              ? {}
              : { styleName: styleName(record.mark.styleId) ?? record.mark.styleId }),
          })),
      );
    };
    const exportItemsForEntries = async function* (
      entries: readonly AnnotationIndexEntry[],
    ): AsyncGenerator<TextAnnotationExportItem> {
      const ordered = [...entries].sort(
        (left, right) =>
          left.filePath.localeCompare(right.filePath) ||
          left.position - right.position ||
          left.id.localeCompare(right.id),
      );
      let filePath = '';
      let conflictIds = new Set<string>();
      let records = new Map<string, TextAnnotationRecord>();
      for (const entry of ordered) {
        if (entry.filePath !== filePath) {
          filePath = entry.filePath;
          const loaded = await repository.listAnnotations(filePath);
          loaded.issues.forEach((issue) => console.warn('[Inkstone Annotations]', issue));
          conflictIds = new Set(loaded.conflicts.map((conflict) => conflict.annotationId));
          records = new Map(
            loaded.records
              .filter((record) => record.deletedAt === undefined)
              .map((record) => [record.id, record]),
          );
        }
        const record = records.get(entry.id);
        if (record !== undefined) {
          const resolvedStyleName =
            record.mark === undefined
              ? undefined
              : (entry.styleName ?? styleName(record.mark.styleId));
          yield {
            conflict: entry.conflict || conflictIds.has(entry.id),
            record,
            ...(resolvedStyleName === undefined ? {} : { styleName: resolvedStyleName }),
          };
        }
      }
    };
    const createExport = (
      items: Iterable<TextAnnotationExportItem> | AsyncIterable<TextAnnotationExportItem>,
      title: string,
      format: TextAnnotationExportFormat,
    ): Promise<string> => {
      const generatedAt = new Date().toISOString();
      return writeTextExportFile({
        chunks: streamTextAnnotationExport(items, { format, generatedAt, title }),
        requestedPath: buildTextAnnotationExportPath(title, format, generatedAt),
        store: sidecarStore,
      });
    };
    const createInkEntriesExport = async (
      entries: readonly AnnotationIndexEntry[],
    ): Promise<string> => {
      const records = [];
      for (const entry of entries) {
        if (entry.type !== 'ink') continue;
        const record = await inkRepository.readSurface(entry.filePath, entry.id);
        if (record !== null && record.deletedAt === undefined) records.push(record);
      }
      if (records.length === 0) {
        throw new Error('The selected Ink surfaces are missing or deleted.');
      }
      return writeInkStandaloneReport(
        records,
        { generatedAt: new Date().toISOString(), title: 'Ink - Vault results' },
        sidecarStore,
      );
    };
    const createVaultTextEntriesExport = async (
      entries: readonly AnnotationIndexEntry[],
      title: string,
      format: TextAnnotationExportFormat,
    ): Promise<string> => {
      const paths: string[] = [];
      for (const part of planVaultTextExport(entries, title, format)) {
        paths.push(await createExport(exportItemsForEntries(part.entries), part.title, format));
      }
      return paths.length === 1
        ? (paths[0] as string)
        : `${paths.length} files (${paths[0] as string} … ${paths.at(-1) as string})`;
    };
    const showExportDialog = (input: {
      readonly invoker: HTMLElement;
      readonly items: () =>
        Iterable<TextAnnotationExportItem> | AsyncIterable<TextAnnotationExportItem>;
      readonly title: string;
    }): void => {
      exportDialog.show({
        invoker: input.invoker,
        onExport: (format) => createExport(input.items(), input.title, format),
        title: `Export ${input.title}`,
      });
    };
    const vaultIndexCache = new VaultIndexCache(sidecarStore);
    const vaultIndexBuilder = new VaultIndexBuilder({
      cache: vaultIndexCache,
      index: vaultIndex,
      onCacheIssue: (error) => console.warn('[Inkstone Annotations]', error),
      source: {
        isSourceAvailable: (filePath) => this.app.vault.getFileByPath(filePath) !== null,
        listAnnotations: (filePath) => repository.listAnnotations(filePath),
        listNotes: () => repository.listNotes(),
        listSurfaceSummaries: (filePath) => inkRepository.listSurfaceSummaries(filePath),
      },
      styleName,
    });
    let livePreview: LivePreviewAnnotationCoordinator | null = null;
    const annotationProjections = new AnnotationProjectionCoordinator({
      consumers: [
        {
          name: 'reading-view',
          refresh: (filePath) => this.readingView?.refreshAnnotations(filePath),
        },
        {
          name: 'live-preview',
          refresh: (filePath) => livePreview?.refresh(filePath),
        },
        {
          name: 'sidebar',
          refresh: (filePath) => this.sidebarView?.refreshAfterCanonicalMutation(filePath),
        },
      ],
      onIssue: (error) => console.warn('[Inkstone Annotations]', error),
    });
    const refreshAnnotationSurfaces = async (filePath: string): Promise<void> => {
      await annotationProjections.refresh([filePath]);
    };
    let lastDeleted: TextAnnotationRecord | null = null;
    const navigateToSource = async (record: TextAnnotationRecord): Promise<void> => {
      if (this.readingView?.focusAnnotation(record.id) === true) {
        return;
      }
      const file = this.app.vault.getFileByPath(record.filePath);
      if (file === null) {
        throw new Error(`Source file no longer exists: ${record.filePath}`);
      }
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
      if (leaf.view instanceof MarkdownView) {
        const from = leaf.view.editor.offsetToPos(record.target.position.start);
        const to = leaf.view.editor.offsetToPos(record.target.position.end);
        leaf.view.editor.setSelection(from, to);
        leaf.view.editor.scrollIntoView({ from, to }, true);
      }
    };
    const inspector = new AnnotationInspector({
      document: globalThis.document,
      onDelete: async (record) => {
        const deleted = await annotationService.deleteAnnotation(
          record.filePath,
          record.id,
          record.revision,
        );
        lastDeleted = deleted;
        await refreshAnnotationSurfaces(record.filePath);
        return deleted;
      },
      onDiscard: async (record) => {
        if (record.status !== 'draft') return;
        await annotationService.discardEmptyDraft(record);
        await refreshAnnotationSurfaces(record.filePath);
      },
      onExport: (record, invoker) => {
        void exportItemsForFile(record.filePath)
          .then((items) => {
            const selected = items.filter((item) => item.record.id === record.id);
            showExportDialog({
              invoker,
              items: () => selected,
              title: `Annotation - ${annotationTargetText(record.target).slice(0, 48)}`,
            });
          })
          .catch((error) => console.warn('[Inkstone Annotations]', error));
      },
      onNavigate: (record) => {
        void navigateToSource(record).catch((error) =>
          console.warn('[Inkstone Annotations]', error),
        );
      },
      onConfirmReattach: async (record, candidate) => {
        const repaired = await annotationService.confirmReattachment(record.filePath, candidate);
        await refreshAnnotationSurfaces(record.filePath);
        return repaired;
      },
      onSave: async (record, changes) => {
        const updated = await annotationService.updateAnnotationContents(
          record.filePath,
          record.id,
          changes,
        );
        await refreshAnnotationSurfaces(record.filePath);
        return updated;
      },
      onUndo: async (record) => {
        const restored = await annotationService.undoDeletion(
          record.filePath,
          record.id,
          record.revision,
        );
        lastDeleted = null;
        await refreshAnnotationSurfaces(record.filePath);
        return restored;
      },
      presets: this.pluginSettings.stylePresets,
      writeClipboard: (text) => {
        const clipboard = globalThis.navigator.clipboard;
        return clipboard === undefined
          ? Promise.reject(new Error('Clipboard API is unavailable.'))
          : clipboard.writeText(text);
      },
    });
    this.inspector = inspector;
    const openInspector = (annotationIds: readonly string[], invoker: HTMLElement): void => {
      const filePath = this.app.workspace.getActiveFile()?.path;
      if (filePath === undefined) {
        return;
      }
      void annotationService
        .getAnnotationsById(filePath, annotationIds)
        .then((records) => {
          if (records.length > 0) {
            inspector.show({ anchorRect: invoker.getBoundingClientRect(), invoker, records });
          }
        })
        .catch((error) => console.warn('[Inkstone Annotations]', error));
    };
    const livePreviewCoordinator = new LivePreviewAnnotationCoordinator({
      contextForState: (state) => ({
        filePath: state.field(editorInfoField, false)?.file?.path ?? null,
        livePreview: state.field(editorLivePreviewField, false) ?? false,
      }),
      document: globalThis.document,
      enabled: false,
      onAnnotationHit: (annotationIds, invoker) => {
        this.sidebarView?.selectAnnotation(annotationIds);
        openInspector(annotationIds, invoker);
      },
      onAnnotationsChanged: (filePath) => refreshAnnotationSurfaces(filePath),
      onIssue: (error) => console.warn('[Inkstone Annotations]', error),
      onNoteDraft: (draft, anchorRect) => {
        inspector.show({
          anchorRect,
          initialFocus: 'note',
          records: [draft],
        });
      },
      presets: this.pluginSettings.stylePresets,
      service: annotationService,
      styleColor: (styleId) =>
        this.pluginSettings.stylePresets.find((preset) => preset.id === styleId)?.color,
    });
    livePreview = livePreviewCoordinator;
    this.registerEditorExtension(livePreviewCoordinator.extension);
    this.runtime.registerDisposer(() => {
      livePreviewCoordinator.dispose();
      livePreview = null;
    });
    let inkMode: ObsidianInkModeManager | null = null;
    this.registerView(ANNOTATION_SIDEBAR_VIEW_TYPE, (leaf) => {
      const view = new AnnotationSidebarView(leaf, {
        commands: {
          getCurrentFilePath: () => this.app.workspace.getActiveFile()?.path ?? null,
          inspectAnnotation: (annotationId, invoker) => openInspector([annotationId], invoker),
          navigateToAnnotation: (annotationId) =>
            this.readingView?.focusAnnotation(annotationId) ?? false,
          navigateToVaultAnnotation: (entry) => {
            if (entry.type === 'ink') {
              void inkRepository
                .listSurfaceSummaries(entry.filePath)
                .then((summaries) => summaries.find((summary) => summary.id === entry.id))
                .then((summary) =>
                  summary === undefined ? undefined : inkMode?.navigateToSurface(summary),
                )
                .catch((error) => console.warn('[Inkstone Annotations]', error));
              return;
            }
            void annotationService
              .getAnnotationsById(entry.filePath, [entry.id])
              .then(([record]) => (record === undefined ? undefined : navigateToSource(record)))
              .catch((error) => console.warn('[Inkstone Annotations]', error));
          },
          repairAnnotation: async (filePath, annotationId, invoker) => {
            try {
              const [record] = await annotationService.getAnnotationsById(filePath, [annotationId]);
              if (record === undefined) {
                new Notice('This annotation is no longer available for repair.');
                return;
              }
              if (record.status !== 'unanchored') {
                new Notice('This annotation no longer needs repair.');
                return;
              }
              const replacement = await this.readingView?.captureCurrentSelection();
              if (replacement === null || replacement === undefined) {
                new Notice('Select supported replacement text in Reading View first.');
                return;
              }
              const candidate = await annotationService.previewReattachment(
                filePath,
                annotationId,
                replacement,
              );
              inspector.showReattachmentPreview({
                anchorRect: invoker.getBoundingClientRect(),
                candidate,
                invoker,
                record,
              });
            } catch (error) {
              console.warn('[Inkstone Annotations]', error);
              new Notice(
                error instanceof Error &&
                  error.message === 'Replacement selection belongs to a different file.'
                  ? 'Select replacement text in the same note as this annotation.'
                  : "Couldn't prepare this repair. The original target is unchanged.",
              );
            }
          },
          closed: () => {
            if (this.sidebarView === view) {
              this.sidebarView = null;
            }
          },
          deleteAnnotation: async (filePath, annotationId, expectedRevision) => {
            const deleted = await annotationService.deleteAnnotation(
              filePath,
              annotationId,
              expectedRevision,
            );
            lastDeleted = deleted;
            await refreshAnnotationSurfaces(filePath);
          },
          bulkDelete: async (selection) => {
            const textSelection = selection.filter((item) => item.type !== 'ink');
            const inkSelection = selection.filter((item) => item.type === 'ink');
            const failed: AnnotationSidebarBulkSelection[] = [];
            const succeeded: AnnotationSidebarDeletedItem[] = [];

            try {
              const outcome = await annotationService.bulkDelete(textSelection);
              failed.push(
                ...textSelection.filter((item) =>
                  outcome.failed.some(
                    (candidate) => candidate.filePath === item.filePath && candidate.id === item.id,
                  ),
                ),
              );
              for (const record of outcome.succeeded) {
                const selected = textSelection.find(
                  (item) => item.filePath === record.filePath && item.id === record.id,
                );
                if (selected === undefined) continue;
                succeeded.push({
                  deletedRevision: record.revision,
                  filePath: record.filePath,
                  id: record.id,
                  noteId: record.noteId,
                  type: selected.type,
                });
              }
            } catch (error) {
              console.warn('[Inkstone Annotations]', error);
              failed.push(...textSelection);
            }

            const filePaths = [...new Set(inkSelection.map((item) => item.filePath))];
            const preparedFilePaths: string[] = [];
            try {
              for (const filePath of filePaths) {
                await inkMode?.prepareFileMutation(filePath);
                preparedFilePaths.push(filePath);
              }
            } catch (error) {
              console.warn('[Inkstone Annotations]', error);
              for (const filePath of preparedFilePaths) {
                await inkMode
                  ?.refreshFile(filePath)
                  .catch((refreshError) => console.warn('[Inkstone Annotations]', refreshError));
              }
              failed.push(...inkSelection);
            }
            if (preparedFilePaths.length === filePaths.length) {
              try {
                for (const item of inkSelection) {
                  try {
                    const current = await inkRepository.readSurface(item.filePath, item.id);
                    if (
                      current === null ||
                      current.deletedAt !== undefined ||
                      current.revision !== item.expectedRevision
                    ) {
                      failed.push(item);
                      continue;
                    }
                    const deleted = await inkRepository.tombstoneSurface(
                      item.filePath,
                      item.id,
                      new Date().toISOString(),
                      this.pluginSettings.deviceId,
                      item.expectedRevision,
                    );
                    succeeded.push({
                      deletedRevision: deleted.revision,
                      filePath: deleted.filePath,
                      id: deleted.id,
                      noteId: deleted.noteId,
                      type: 'ink',
                    });
                  } catch (error) {
                    console.warn('[Inkstone Annotations]', error);
                    failed.push(item);
                  }
                }
              } finally {
                for (const filePath of preparedFilePaths) {
                  await inkMode
                    ?.refreshFile(filePath)
                    .catch((error) => console.warn('[Inkstone Annotations]', error));
                }
              }
            }
            await annotationProjections.refresh(succeeded.map((item) => item.filePath));
            return {
              failed: selection.filter((item) =>
                failed.some(
                  (candidate) => candidate.filePath === item.filePath && candidate.id === item.id,
                ),
              ),
              succeeded,
            };
          },
          deleteInk: async (filePath, surfaceId, expectedRevision) => {
            await inkMode?.prepareFileMutation(filePath);
            await inkRepository.tombstoneSurface(
              filePath,
              surfaceId,
              new Date().toISOString(),
              this.pluginSettings.deviceId,
              expectedRevision,
            );
            await Promise.all([
              inkMode
                ?.refreshFile(filePath)
                .catch((error) => console.warn('[Inkstone Annotations]', error)),
              annotationProjections.refresh([filePath]),
            ]);
          },
          editInk: (filePath, surfaceId) => {
            void inkRepository
              .listSurfaceSummaries(filePath)
              .then((summaries) => summaries.find((summary) => summary.id === surfaceId))
              .then((summary) =>
                summary === undefined ? undefined : inkMode?.navigateToSurface(summary, true),
              )
              .catch((error) => console.warn('[Inkstone Annotations]', error));
          },
          exportCurrentFile: (filePath, invoker) => {
            void exportItemsForFile(filePath)
              .then((items) =>
                showExportDialog({
                  invoker,
                  items: () => items,
                  title: `Annotations - ${filePath}`,
                }),
              )
              .catch((error) => console.warn('[Inkstone Annotations]', error));
          },
          exportInkPng: async (filePath, surfaceId) => {
            const loaded = await inkRepository.listSurfaces(filePath);
            assertInkExportLoadSupported(loaded.issues);
            const record = loaded.records.find((candidate) => candidate.id === surfaceId) ?? null;
            if (record === null) throw new Error(`Ink surface no longer exists: ${surfaceId}`);
            const path = await writeInkPngExport(record, sidecarStore, loaded.records);
            new Notice(`Exported Ink PNG to ${path}`);
          },
          exportInkReport: async (filePath) => {
            const loaded = await inkRepository.listSurfaces(filePath);
            assertInkExportLoadSupported(loaded.issues);
            const path = await writeInkStandaloneReport(
              loaded.records,
              {
                generatedAt: new Date().toISOString(),
                title: `Ink - ${filePath}`,
              },
              sidecarStore,
            );
            new Notice(`Exported Ink report to ${path}`);
          },
          exportInkSvg: async (filePath, surfaceId) => {
            const loaded = await inkRepository.listSurfaces(filePath);
            assertInkExportLoadSupported(loaded.issues);
            const record = loaded.records.find((candidate) => candidate.id === surfaceId) ?? null;
            if (record === null) throw new Error(`Ink surface no longer exists: ${surfaceId}`);
            const path = await writeInkSvgExport(record, sidecarStore, loaded.records);
            new Notice(`Exported Ink SVG to ${path}`);
          },
          exportVaultEntries: (entries, invoker) => {
            const textEntries = entries.filter((entry) => entry.type !== 'ink');
            const inkEntries = entries.filter((entry) => entry.type === 'ink');
            if (inkEntries.length === 0) {
              exportDialog.show({
                invoker,
                onExport: (format) =>
                  createVaultTextEntriesExport(textEntries, 'Annotations - Vault results', format),
                title: 'Annotations - Vault results',
              });
              return;
            }
            exportDialog.show({
              invoker,
              onExport: async (format) => {
                const paths: string[] = [];
                if (textEntries.length > 0) {
                  paths.push(
                    await createVaultTextEntriesExport(
                      textEntries,
                      'Annotations - Vault results',
                      format,
                    ),
                  );
                }
                paths.push(await createInkEntriesExport(inkEntries));
                return paths.join(' + ');
              },
              title:
                textEntries.length === 0
                  ? 'Export selected Ink as standalone HTML'
                  : 'Export text plus Ink standalone HTML',
            });
          },
          issue: (error) => console.warn('[Inkstone Annotations]', error),
          repairInkConflict: async (filePath, conflict, candidatePath) => {
            const candidate = conflict.candidates.find(({ path }) => path === candidatePath);
            if (candidate === undefined) {
              throw new Error('The selected Ink conflict candidate is no longer available.');
            }
            await inkRepository.resolveConflict({
              candidate,
              deviceId: this.pluginSettings.deviceId,
              expectedHighestRevision: Math.max(
                ...conflict.candidates.map(({ record }) => record.revision),
              ),
              filePath,
              now: new Date().toISOString(),
            });
          },
          navigateToInk: (summary) => {
            void inkMode
              ?.navigateToSurface(summary)
              .catch((error) => console.warn('[Inkstone Annotations]', error));
          },
          restoreDeleted: async (selection) => {
            const failed: AnnotationSidebarDeletedItem[] = [];
            const restoredFilePaths = new Set<string>();
            const inkSelection = selection.filter((item) => item.type === 'ink');
            const inkFilePaths = [...new Set(inkSelection.map((item) => item.filePath))];
            const preparedFilePaths: string[] = [];
            try {
              for (const filePath of inkFilePaths) {
                await inkMode?.prepareFileMutation(filePath);
                preparedFilePaths.push(filePath);
              }
            } catch (error) {
              console.warn('[Inkstone Annotations]', error);
              for (const filePath of preparedFilePaths) {
                await inkMode
                  ?.refreshFile(filePath)
                  .catch((refreshError) => console.warn('[Inkstone Annotations]', refreshError));
              }
              failed.push(...inkSelection);
            }

            for (const item of selection.filter((candidate) => candidate.type !== 'ink')) {
              try {
                await annotationService.undoDeletion(item.filePath, item.id, item.deletedRevision);
                restoredFilePaths.add(item.filePath);
              } catch (error) {
                console.warn('[Inkstone Annotations]', error);
                failed.push(item);
              }
            }

            if (preparedFilePaths.length === inkFilePaths.length) {
              try {
                for (const item of inkSelection) {
                  try {
                    const current = await inkRepository.readSurface(item.filePath, item.id);
                    if (
                      current === null ||
                      current.deletedAt === undefined ||
                      current.revision !== item.deletedRevision
                    ) {
                      failed.push(item);
                      continue;
                    }
                    await inkRepository.restoreSurface(
                      item.filePath,
                      item.id,
                      new Date().toISOString(),
                      this.pluginSettings.deviceId,
                      item.deletedRevision,
                    );
                    restoredFilePaths.add(item.filePath);
                  } catch (error) {
                    console.warn('[Inkstone Annotations]', error);
                    failed.push(item);
                  }
                }
              } finally {
                for (const filePath of preparedFilePaths) {
                  await inkMode
                    ?.refreshFile(filePath)
                    .catch((error) => console.warn('[Inkstone Annotations]', error));
                }
              }
            }
            await annotationProjections.refresh([...restoredFilePaths]);
            return { failed };
          },
          restoreInk: async (filePath, surfaceId, expectedRevision) => {
            await inkRepository.restoreSurface(
              filePath,
              surfaceId,
              new Date().toISOString(),
              this.pluginSettings.deviceId,
              expectedRevision,
            );
            await Promise.all([
              inkMode
                ?.refreshFile(filePath)
                .catch((error) => console.warn('[Inkstone Annotations]', error)),
              annotationProjections.refresh([filePath]),
            ]);
          },
          restoreAnnotation: async (filePath, annotationId, expectedRevision) => {
            await annotationService.undoDeletion(filePath, annotationId, expectedRevision);
            if (lastDeleted?.id === annotationId && lastDeleted.filePath === filePath) {
              lastDeleted = null;
            }
            await refreshAnnotationSurfaces(filePath);
          },
        },
        inkRepository,
        service: annotationService,
        stylePresets: this.pluginSettings.stylePresets,
        vaultIndex,
        vaultIndexBuilder,
      });
      this.sidebarView = view;
      return view;
    });
    const readingView = new ReadingViewIntegration({
      document: globalThis.document,
      isMobile: Platform.isMobile,
      onAnnotationHit: (annotationIds, invoker) => {
        this.sidebarView?.selectAnnotation(annotationIds);
        openInspector(annotationIds, invoker);
      },
      onIssue: (error) => console.warn('[Inkstone Annotations]', error),
      onNoteDraft: (draft, target) => {
        inspector.show({
          anchorRect: target.anchorRect,
          initialFocus: 'note',
          invoker: target.block,
          records: [draft],
        });
      },
      onRecordsChanged: () => void this.sidebarView?.refresh(),
      recordDuration: (name, durationMs) => this.diagnostics.recordDuration(name, durationMs),
      service: annotationService,
      presets: this.pluginSettings.stylePresets,
    });
    this.readingView = readingView;
    this.runtime.registerDisposer(() => readingView.dispose());
    inkMode = new ObsidianInkModeManager({
      app: this.app,
      deviceId: this.pluginSettings.deviceId,
      document: globalThis.document,
      exportUnsavedInk: (surface) => writeInkSvgExport(surface, sidecarStore),
      inkPerformance: this.inkPerformance,
      ...(inkDraftStore === undefined ? {} : { inkDraftStore }),
      inkRepository,
      inkSnapshotRepository,
      onIssue: (error) => {
        console.warn('[Inkstone Annotations]', error);
        if (error instanceof Error) {
          new Notice(error.message);
        }
      },
      onWillEnter: () => readingView.dismissTransientSelectionUi(),
      preferenceStore: new LocalInkToolPreferenceStore(
        globalThis.localStorage,
        this.app.vault.getName(),
        this.pluginSettings.deviceId,
      ),
      recordInputToPaint: (durationMs) =>
        this.diagnostics.recordLatency('ink-input-to-paint', durationMs),
      showInkPreviewByDefault: this.pluginSettings.showInkPreviewByDefault,
      textRepository: repository,
      ...(INKSTONE_UNPUBLISHED_PHYSICAL_INK_HAT ? { unpublishedPhysicalInkHat: {} } : {}),
      ...(this.pluginSettings.inkPresentationAdapter === 'worker-offscreen-2d'
        ? { workerPresentation: { enabled: true as const } }
        : {}),
    });
    this.inkModeManager = inkMode;
    this.runtime.registerDisposer(() => inkMode.dispose());

    this.registerMarkdownPostProcessor(async (element, context) => {
      const file = this.app.vault.getFileByPath(context.sourcePath);
      if (file === null) {
        return;
      }
      const cleanup = await readingView.mountSection({
        filePath: context.sourcePath,
        getFullSource: () =>
          readingSourceCache.load(file.path, file.stat.mtime, () =>
            this.app.vault.cachedRead(file),
          ),
        getSectionInfo: (sectionElement) =>
          context.getSectionInfo(sectionElement) ?? context.getSectionInfo(element),
        root: element,
      });
      context.addChild(new ReadingSectionChild(element, cleanup));
    });

    this.addSettingTab(new InkstoneSettingTab(this.app, this));
    this.addCommand({
      id: 'show-diagnostics',
      name: 'Show diagnostics',
      callback: () => this.showDiagnostics(),
    });
    this.addCommand({
      id: 'start-s27-physical-gate-capture',
      name: 'Start S27 physical Gate capture',
      callback: () => void this.startS27PhysicalGateCapture(),
    });
    this.addCommand({
      id: 'export-s27-physical-gate-capture',
      name: 'Export S27 physical Gate capture',
      callback: () => void this.exportS27PhysicalGateCapture(),
    });
    this.addCommand({
      id: 'capture-memory-diagnostics',
      name: 'Capture memory diagnostics checkpoint',
      callback: () => this.captureMemoryCheckpoint('manual-memory-checkpoint', true),
    });
    this.addCommand({
      id: 'toggle-ink-mode',
      name: 'Toggle Ink Mode',
      callback: () =>
        void inkMode.toggle().then(() => this.captureMemoryCheckpoint('ink-mode-memory', false)),
    });
    this.addCommand({
      id: 'exit-ink-mode',
      name: 'Exit Ink Mode',
      callback: () => void inkMode.exit(),
    });
    this.registerObsidianProtocolHandler('inkstone-annotation', async (parameters) => {
      const filePath = parameters.file;
      const annotationId = parameters.id;
      if (filePath === undefined || annotationId === undefined) {
        new Notice('The annotation link is missing its file or annotation ID.');
        return;
      }
      const [record] = await annotationService.getAnnotationsById(filePath, [annotationId]);
      if (record === undefined) {
        new Notice('The linked annotation is missing or deleted.');
        return;
      }
      await navigateToSource(record);
    });
    this.addCommand({
      id: 'open-annotations',
      name: 'Open annotations for current file',
      callback: () => void this.activateAnnotationSidebar(),
    });
    this.addCommand({
      id: 'undo-last-annotation-delete',
      name: 'Undo last annotation delete',
      callback: () => {
        const deleted = lastDeleted;
        if (deleted === null) {
          new Notice('No annotation deletion is available to undo.');
          return;
        }
        void annotationService
          .undoDeletion(deleted.filePath, deleted.id, deleted.revision)
          .then(async () => {
            lastDeleted = null;
            await refreshAnnotationSurfaces(deleted.filePath);
          })
          .catch((error) => {
            console.warn('[Inkstone Annotations]', error);
            new Notice("Couldn't undo annotation deletion locally. Retry.");
          });
      },
    });
    this.addCommand({
      id: 'apply-last-highlight',
      name: 'Apply last highlight to selection',
      callback: () => {
        const styleId = this.pluginSettings.stylePresets[0]?.id ?? 'highlight-sun';
        void livePreviewCoordinator
          .commitSelection({ kind: 'highlight', styleId })
          .then((appliedInEditor) =>
            appliedInEditor ? true : readingView.applyLastHighlightToCurrentSelection(),
          )
          .then((applied) => {
            if (!applied) {
              new Notice('Select supported text in Reading View or Live Preview first.');
            }
          })
          .catch((error) => {
            console.warn('[Inkstone Annotations]', error);
            new Notice("Couldn't save highlight locally. Retry.");
          });
      },
    });
    this.addCommand({
      id: 'add-note-to-selection',
      name: 'Add note to selection',
      callback: () => {
        void livePreviewCoordinator
          .addNoteToSelection()
          .then((appliedInEditor) =>
            appliedInEditor ? true : readingView.addNoteToCurrentSelection(),
          )
          .then((applied) => {
            if (!applied) {
              new Notice('Select supported text in Reading View or Live Preview first.');
            }
          })
          .catch((error) => {
            console.warn('[Inkstone Annotations]', error);
            new Notice("Couldn't create a local note draft. Retry.");
          });
      },
    });

    const workspaceWaitStartedAt = performance.now();
    this.app.workspace.onLayoutReady(() => {
      this.diagnostics.recordDuration(
        'workspace-ready',
        performance.now() - workspaceWaitStartedAt,
      );
      inkMode.registerAllMarkdownViews();
      if (INKSTONE_LOCAL_PERFORMANCE_GATE) {
        const localGate = new ObsidianLocalPerformanceGate({
          app: this.app,
          diagnostics: this.inkPerformance,
          inkMode,
        });
        void localGate.runIfRequested().catch((error: unknown) => {
          console.error('[Inkstone Annotations] Local performance Gate failed.', error);
        });
      }
    });
    this.registerEvent(
      this.app.workspace.on('layout-change', () => inkMode.registerAllMarkdownViews()),
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        inkMode.handleActiveLeafChange();
        void this.sidebarView?.followActiveFile();
      }),
    );
    let sidecarRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleExternalSidecarRefresh = (): void => {
      if (sidecarRefreshTimer !== null) clearTimeout(sidecarRefreshTimer);
      sidecarRefreshTimer = setTimeout(() => {
        sidecarRefreshTimer = null;
        void this.sidebarView
          ?.refreshAfterCanonicalSidecarChange()
          .catch((error) => console.warn('[Inkstone Annotations]', error));
      }, 180);
    };
    const handleCanonicalSidecarEvent = (file: { readonly path: string }): void => {
      const canonical =
        /^\.obsidian-annotations\/v1\/notes\/[^/]+\/(?:(?:annotations|surfaces)\/[^/]+\.json|ink-summaries\.json|ink\.json)$/u.test(
          file.path,
        );
      if (!canonical) return;
      void sidecarStore
        .isUnchangedRecentWrite(file.path)
        .catch((error) => {
          console.warn('[Inkstone Annotations]', error);
          return false;
        })
        .then((unchangedLocalWrite) => {
          if (unchangedLocalWrite) return;
          if (file.path.endsWith('/ink.json')) {
            void inkSnapshotRepository
              .resolveFilePath(file.path)
              .then(async (filePath) => {
                if (filePath === null) return;
                await Promise.all([
                  refreshAnnotationSurfaces(filePath),
                  inkMode?.refreshFile(filePath),
                ]);
              })
              .catch((error) => console.warn('[Inkstone Annotations]', error));
          } else if (
            file.path.includes('/surfaces/') ||
            file.path.endsWith('/ink-summaries.json')
          ) {
            void inkRepository
              .rebuildSummariesForSidecarPath(file.path)
              .then(async (filePath) => {
                if (filePath === null) return;
                await Promise.all([
                  refreshAnnotationSurfaces(filePath),
                  inkMode?.refreshFile(filePath),
                ]);
              })
              .catch((error) => console.warn('[Inkstone Annotations]', error));
          } else {
            void repository
              .resolveFilePathForAnnotationSidecar(file.path)
              .then((filePath) =>
                filePath === null ? undefined : annotationProjections.refresh([filePath]),
              )
              .catch((error) => console.warn('[Inkstone Annotations]', error));
          }
          scheduleExternalSidecarRefresh();
        });
    };
    this.runtime.registerDisposer(() => {
      if (sidecarRefreshTimer !== null) clearTimeout(sidecarRefreshTimer);
      sidecarRefreshTimer = null;
    });
    this.registerEvent(this.app.vault.on('create', handleCanonicalSidecarEvent));
    this.registerEvent(this.app.vault.on('modify', handleCanonicalSidecarEvent));
    this.registerEvent(this.app.vault.on('delete', handleCanonicalSidecarEvent));
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        handleCanonicalSidecarEvent({ path: oldPath });
        if (file.path !== oldPath) handleCanonicalSidecarEvent(file);
        if (!(file instanceof TFile) || file.extension !== 'md') {
          return;
        }
        void vaultIndex
          .batch(async () => {
            const meta = await sidecarLifecycle.reconcileObservedRename(oldPath, file.path);
            if (meta !== null) {
              vaultIndex.renameNote({ newPath: file.path, noteId: meta.noteId, oldPath });
            }
            return meta;
          })
          .then(async (meta) => {
            if (meta !== null) {
              await vaultIndexCache
                .clear()
                .catch((error) => console.warn('[Inkstone Annotations]', error));
            }
            void this.app.vault
              .cachedRead(file)
              .then((source) => annotationService.reconcileNotePath(file.path, source))
              .catch((error) => console.warn('[Inkstone Annotations]', error));
            await refreshAnnotationSurfaces(file.path);
          })
          .catch((error) => console.warn('[Inkstone Annotations]', error));
      }),
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (
          !(file instanceof TFile) ||
          file.extension !== 'md' ||
          !shouldRefreshAnnotationSurfacesForModify(file.path, activeMarkdownView)
        ) {
          return;
        }
        void refreshAnnotationSurfaces(file.path).catch((error) =>
          console.warn('[Inkstone Annotations]', error),
        );
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') {
          return;
        }
        vaultIndex.removeFile(file.path);
        void vaultIndexCache
          .clear()
          .catch((error) => console.warn('[Inkstone Annotations]', error));
        void sidecarLifecycle
          .markSourceMissing(file.path)
          .then((meta) => {
            if (meta === null) return;
            vaultIndex.removeNote(meta.noteId);
          })
          .catch((error) => console.warn('[Inkstone Annotations]', error));
      }),
    );

    this.diagnostics.recordDuration('plugin-startup', performance.now() - startedAt);
    this.captureMemoryCheckpoint('plugin-load-memory', false);
  }

  override onunload(): void {
    const startedAt = performance.now();
    const cleanupErrors = this.runtime.stop();
    this.readingView = null;
    this.sidebarView = null;
    this.inspector?.close(false);
    this.inspector = null;
    this.inkModeManager = null;

    this.diagnostics.recordDuration('plugin-shutdown', performance.now() - startedAt);

    if (cleanupErrors.length > 0) {
      new Notice(`Inkstone could not clean up ${cleanupErrors.length} background task(s).`);
    }
  }

  getSettings(): InkstoneSettings {
    return this.pluginSettings;
  }

  async setDiagnosticsEnabled(enabled: boolean): Promise<void> {
    this.pluginSettings = { ...this.pluginSettings, diagnosticsEnabled: enabled };
    this.diagnostics.setEnabled(enabled);
    this.inkPerformance.setEnabled(enabled);
    await this.saveData(this.pluginSettings);
  }

  async setShowInkPreviewByDefault(enabled: boolean): Promise<void> {
    this.pluginSettings = { ...this.pluginSettings, showInkPreviewByDefault: enabled };
    await this.saveData(this.pluginSettings);
    await this.inkModeManager?.setPreviewByDefault(enabled);
  }

  async setInkPresentationAdapter(adapter: InkPresentationAdapter): Promise<void> {
    this.pluginSettings = { ...this.pluginSettings, inkPresentationAdapter: adapter };
    await this.saveData(this.pluginSettings);
    new Notice('Ink renderer selection applies after reloading Inkstone Annotations.');
  }

  async updateStylePreset(
    styleId: string,
    patch: { readonly color?: string; readonly name?: string },
  ): Promise<void> {
    const catalog = new StylePresetCatalog(this.pluginSettings.stylePresets);
    catalog.update(styleId, patch);
    const stylePresets = catalog.list();
    this.pluginSettings = { ...this.pluginSettings, stylePresets };
    await this.saveData(this.pluginSettings);
    this.inspector?.setPresets(stylePresets);
    await this.readingView?.setPresets(stylePresets);
  }

  private showDiagnostics(): void {
    if (!this.pluginSettings.diagnosticsEnabled) {
      new Notice('Diagnostics are disabled. Enable them in Inkstone Annotations settings.');
      return;
    }

    const metrics = this.diagnostics.snapshot();
    const inkPerformance = this.inkPerformance.snapshot();
    const summary =
      metrics.length === 0 &&
      inkPerformance.recentSpans.length === 0 &&
      inkPerformance.forbiddenWork.length === 0
        ? 'No timing samples yet.'
        : JSON.stringify({ inkPerformance, metrics }, null, 2);

    new Notice(summary, 10_000);
  }

  private async startS27PhysicalGateCapture(): Promise<void> {
    if (!this.pluginSettings.diagnosticsEnabled) {
      new Notice('Diagnostics are disabled. Enable them in Inkstone Annotations settings.');
      return;
    }
    try {
      const exporter = new InkPhysicalGateExport(this.app.vault.adapter);
      const condition = await exporter.readCondition();
      new Notice('S27 capture is calibrating 120 idle refresh intervals…');
      await this.physicalGateCapture.start(condition);
      new Notice(`S27 ${condition.conditionId} run ${condition.runIndex} is ready. Start writing.`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Could not start S27 capture.');
    }
  }

  private async exportS27PhysicalGateCapture(): Promise<void> {
    try {
      const exporter = new InkPhysicalGateExport(this.app.vault.adapter);
      await exporter.writeCapture(this.physicalGateCapture.finish());
      new Notice('S27 diagnostics exported to the owned fixture Vault.');
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Could not export S27 capture.');
    }
  }

  private captureMemoryCheckpoint(name: DiagnosticMemoryMetricName, notifyUser: boolean): boolean {
    if (!this.pluginSettings.diagnosticsEnabled) {
      if (notifyUser) {
        new Notice('Diagnostics are disabled. Enable them in Inkstone Annotations settings.');
      }
      return false;
    }
    const sample = readBrowserMemory();
    if (sample === null) {
      if (notifyUser)
        new Notice('Browser memory metrics are unavailable in this Obsidian runtime.');
      return false;
    }
    this.diagnostics.recordMemory(name, sample);
    if (notifyUser) new Notice('Memory diagnostics checkpoint captured locally.');
    return true;
  }

  private async activateAnnotationSidebar(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(ANNOTATION_SIDEBAR_VIEW_TYPE)[0];
    if (leaf === undefined) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      if (leaf === undefined) {
        new Notice("Couldn't open the annotation sidebar.");
        return;
      }
      await leaf.setViewState({ active: true, type: ANNOTATION_SIDEBAR_VIEW_TYPE });
    }
    await this.app.workspace.revealLeaf(leaf);
    await this.sidebarView?.refresh();
  }
}

function readBrowserMemory(): {
  readonly jsHeapSizeLimit: number;
  readonly totalJSHeapSize: number;
  readonly usedJSHeapSize: number;
} | null {
  const memory = (
    globalThis.performance as Performance & {
      readonly memory?: {
        readonly jsHeapSizeLimit: number;
        readonly totalJSHeapSize: number;
        readonly usedJSHeapSize: number;
      };
    }
  ).memory;
  return memory ?? null;
}

class ReadingSectionChild extends MarkdownRenderChild {
  constructor(
    containerEl: HTMLElement,
    private readonly cleanup: () => void,
  ) {
    super(containerEl);
  }

  override onunload(): void {
    this.cleanup();
  }
}
