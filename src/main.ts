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
import {
  ANNOTATION_SIDEBAR_VIEW_TYPE,
  AnnotationSidebarView,
} from './adapters/obsidian/annotation-sidebar-view';
import { ReadingViewIntegration } from './adapters/obsidian/reading-view-integration';
import { ObsidianInkModeManager } from './adapters/obsidian/ink-mode-manager';
import { LivePreviewAnnotationCoordinator } from './adapters/obsidian/live-preview-extension';
import { AnnotationService } from './application/annotation-service';
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
  writeInkPngExport,
  writeInkStandaloneReport,
  writeInkSvgExport,
} from './application/ink-export-file-writer';
import { VaultIndexBuilder } from './application/vault-index-builder';
import {
  applyCanonicalInkSurfaceChanged,
  applyCanonicalRecordChanged,
  applyCanonicalRecordRemoved,
} from './application/vault-index-events';
import { StylePresetCatalog } from './domain/style-preset';
import type { TextAnnotationRecord } from './domain/text-annotation';
import { VaultAnnotationIndex, type AnnotationIndexEntry } from './domain/vault-annotation-index';
import { AnnotationInspector } from './ui/annotation-inspector';
import { AnnotationExportDialog } from './ui/annotation-export-dialog';
import { NoteComposer } from './ui/note-composer';
import { Diagnostics, type DiagnosticMemoryMetricName } from './runtime/diagnostics';
import { PluginRuntime } from './runtime/plugin-runtime';
import { VersionedSourceCache } from './runtime/versioned-source-cache';
import { InkstoneSettingTab } from './settings-tab';
import { DEFAULT_SETTINGS, ensureDeviceId, parseSettings, type InkstoneSettings } from './settings';
import { SidecarRepository } from './storage/sidecar-repository';
import { InkSurfaceRepository } from './storage/ink-surface-repository';
import { VaultIndexCache } from './storage/vault-index-cache';
import { LocalInkToolPreferenceStore } from './storage/local-ink-tool-preference';

export default class InkstoneAnnotationsPlugin extends Plugin {
  private readonly diagnostics = new Diagnostics(false);
  private readonly runtime = new PluginRuntime();
  private pluginSettings: InkstoneSettings = DEFAULT_SETTINGS;
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
    this.runtime.start();
    const readingSourceCache = new VersionedSourceCache(8);
    this.runtime.registerDisposer(() => readingSourceCache.clear());

    const sidecarStore = new ObsidianVaultTextFileStore(this.app.vault.adapter);
    const vaultIndex = new VaultAnnotationIndex();
    const styleName = (styleId: string): string | undefined =>
      this.pluginSettings.stylePresets.find((preset) => preset.id === styleId)?.name;
    const repository = new SidecarRepository(sidecarStore, {
      onRecordChanged: (record) => {
        applyCanonicalRecordChanged(vaultIndex, record, styleName);
      },
      onRecordRemoved: (record) => {
        applyCanonicalRecordRemoved(vaultIndex, record);
      },
    });
    const inkRepository = new InkSurfaceRepository(sidecarStore, {
      onSurfaceChanged: (record) => {
        applyCanonicalInkSurfaceChanged(vaultIndex, record);
        void this.sidebarView?.refresh();
      },
    });
    const annotationService = new AnnotationService({
      deviceId: this.pluginSettings.deviceId,
      repository,
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
    const vaultIndexBuilder = new VaultIndexBuilder({
      cache: new VaultIndexCache(sidecarStore),
      index: vaultIndex,
      onCacheIssue: (error) => console.warn('[Inkstone Annotations]', error),
      source: {
        listAnnotations: (filePath) => repository.listAnnotations(filePath),
        listNotes: () => repository.listNotes(),
        listSurfaceSummaries: (filePath) => inkRepository.listSurfaceSummaries(filePath),
      },
      styleName,
    });
    let livePreview: LivePreviewAnnotationCoordinator | null = null;
    const refreshAnnotationSurfaces = async (filePath: string): Promise<void> => {
      await this.readingView?.refreshAnnotations(filePath);
      livePreview?.refresh(filePath);
      await this.sidebarView?.refresh();
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
        const deleted = await annotationService.deleteAnnotation(record.filePath, record.id);
        lastDeleted = deleted;
        await refreshAnnotationSurfaces(record.filePath);
        return deleted;
      },
      onExport: (record, invoker) => {
        void exportItemsForFile(record.filePath)
          .then((items) => {
            const selected = items.filter((item) => item.record.id === record.id);
            showExportDialog({
              invoker,
              items: () => selected,
              title: `Annotation - ${record.target.quote.exact.slice(0, 48)}`,
            });
          })
          .catch((error) => console.warn('[Inkstone Annotations]', error));
      },
      onNavigate: (record) => {
        void navigateToSource(record).catch((error) =>
          console.warn('[Inkstone Annotations]', error),
        );
      },
      onPreviewReattach: async (record) => {
        const replacement = await this.readingView?.captureCurrentSelection();
        if (replacement === null || replacement === undefined) {
          throw new Error('Select replacement text in Reading View first.');
        }
        return annotationService.previewReattachment(record.filePath, record.id, replacement);
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
    let editorComposer: NoteComposer | null = null;
    const livePreviewCoordinator = new LivePreviewAnnotationCoordinator({
      contextForState: (state) => ({
        filePath: state.field(editorInfoField, false)?.file?.path ?? null,
        livePreview: state.field(editorLivePreviewField, false) ?? false,
      }),
      document: globalThis.document,
      onAnnotationHit: (annotationIds, invoker) => {
        this.sidebarView?.selectAnnotation(annotationIds);
        openInspector(annotationIds, invoker);
      },
      onAnnotationsChanged: (filePath) => refreshAnnotationSurfaces(filePath),
      onIssue: (error) => console.warn('[Inkstone Annotations]', error),
      onNoteDraft: (draft, anchorRect) => {
        editorComposer?.dispose();
        const composer = new NoteComposer({
          anchorRect,
          document: globalThis.document,
          draft,
          layout: Platform.isMobile ? 'bottom-sheet' : 'anchored',
          onClose: () => {
            if (editorComposer === composer) editorComposer = null;
            void refreshAnnotationSurfaces(draft.filePath);
          },
          onIssue: (error) => console.warn('[Inkstone Annotations]', error),
          service: annotationService,
        });
        editorComposer = composer;
        composer.show();
      },
      presets: this.pluginSettings.stylePresets,
      service: annotationService,
      styleColor: (styleId) =>
        this.pluginSettings.stylePresets.find((preset) => preset.id === styleId)?.color,
    });
    livePreview = livePreviewCoordinator;
    this.registerEditorExtension(livePreviewCoordinator.extension);
    this.runtime.registerDisposer(() => {
      editorComposer?.dispose();
      editorComposer = null;
      livePreviewCoordinator.dispose();
      livePreview = null;
    });
    let inkMode: ObsidianInkModeManager | null = null;
    this.registerView(ANNOTATION_SIDEBAR_VIEW_TYPE, (leaf) => {
      const view = new AnnotationSidebarView(leaf, {
        getCurrentFilePath: () => this.app.workspace.getActiveFile()?.path ?? null,
        inkRepository,
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
        onClosed: () => {
          if (this.sidebarView === view) {
            this.sidebarView = null;
          }
        },
        onBulkDeleteInk: async (selection) => {
          const failed: (typeof selection)[number][] = [];
          for (const item of selection) {
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
              await inkRepository.tombstoneSurface(
                item.filePath,
                item.id,
                new Date().toISOString(),
                this.pluginSettings.deviceId,
              );
            } catch (error) {
              console.warn('[Inkstone Annotations]', error);
              failed.push(item);
            }
          }
          return { failed };
        },
        onDeleteInk: async (filePath, surfaceId) => {
          await inkRepository.tombstoneSurface(
            filePath,
            surfaceId,
            new Date().toISOString(),
            this.pluginSettings.deviceId,
          );
        },
        onEditInk: (filePath, surfaceId) => {
          void inkRepository
            .listSurfaceSummaries(filePath)
            .then((summaries) => summaries.find((summary) => summary.id === surfaceId))
            .then((summary) =>
              summary === undefined ? undefined : inkMode?.navigateToSurface(summary, true),
            )
            .catch((error) => console.warn('[Inkstone Annotations]', error));
        },
        onExportCurrentFile: (filePath, invoker) => {
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
        onExportInkPng: async (filePath, surfaceId) => {
          const record = await inkRepository.readSurface(filePath, surfaceId);
          if (record === null) throw new Error(`Ink surface no longer exists: ${surfaceId}`);
          const path = await writeInkPngExport(record, sidecarStore);
          new Notice(`Exported Ink PNG to ${path}`);
        },
        onExportInkReport: async (filePath) => {
          const loaded = await inkRepository.listSurfaces(filePath);
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
        onExportInkSvg: async (filePath, surfaceId) => {
          const record = await inkRepository.readSurface(filePath, surfaceId);
          if (record === null) throw new Error(`Ink surface no longer exists: ${surfaceId}`);
          const path = await writeInkSvgExport(record, sidecarStore);
          new Notice(`Exported Ink SVG to ${path}`);
        },
        onExportVaultEntries: (entries, invoker) => {
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
        onIssue: (error) => console.warn('[Inkstone Annotations]', error),
        onRepairInkConflict: async (filePath, conflict, candidatePath) => {
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
        onNavigateInk: (summary) => {
          void inkMode
            ?.navigateToSurface(summary)
            .catch((error) => console.warn('[Inkstone Annotations]', error));
        },
        onRestoreInk: async (filePath, surfaceId) => {
          await inkRepository.restoreSurface(
            filePath,
            surfaceId,
            new Date().toISOString(),
            this.pluginSettings.deviceId,
          );
        },
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
      inkRepository,
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
      textRepository: repository,
    });
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
    });
    this.registerEvent(
      this.app.workspace.on('layout-change', () => inkMode.registerAllMarkdownViews()),
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        inkMode.handleActiveLeafChange();
        void this.sidebarView?.refresh();
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
        /^\.obsidian-annotations\/v1\/notes\/[^/]+\/(?:annotations|surfaces)\/[^/]+\.json$/u.test(
          file.path,
        );
      if (!canonical) return;
      if (file.path.includes('/surfaces/')) {
        void inkRepository
          .rebuildSummariesForSidecarPath(file.path)
          .then((filePath) => (filePath === null ? undefined : refreshAnnotationSurfaces(filePath)))
          .catch((error) => console.warn('[Inkstone Annotations]', error));
      }
      scheduleExternalSidecarRefresh();
    };
    this.runtime.registerDisposer(() => {
      if (sidecarRefreshTimer !== null) clearTimeout(sidecarRefreshTimer);
      sidecarRefreshTimer = null;
    });
    this.registerEvent(this.app.vault.on('create', handleCanonicalSidecarEvent));
    this.registerEvent(this.app.vault.on('modify', handleCanonicalSidecarEvent));
    this.registerEvent(this.app.vault.on('delete', handleCanonicalSidecarEvent));
    this.registerEvent(
      this.app.vault.on('rename', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') {
          return;
        }
        void this.app.vault
          .cachedRead(file)
          .then((source) => annotationService.reconcileNotePath(file.path, source))
          .then(() => refreshAnnotationSurfaces(file.path))
          .catch((error) => console.warn('[Inkstone Annotations]', error));
      }),
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (
          !(file instanceof TFile) ||
          file.extension !== 'md' ||
          file.path !== this.app.workspace.getActiveFile()?.path
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
        void annotationService
          .markNoteSourceMissing(file.path)
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
    await this.saveData(this.pluginSettings);
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
    const summary =
      metrics.length === 0 ? 'No timing samples yet.' : JSON.stringify(metrics, null, 2);

    new Notice(summary, 10_000);
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
