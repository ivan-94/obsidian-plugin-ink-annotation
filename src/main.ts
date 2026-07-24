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
import { ObsidianSnapshotAnnotationManager } from './adapters/obsidian/snapshot-annotation-manager';
import { ElectronSnapshotCaptureBackend } from './adapters/obsidian/electron-snapshot-capture-backend';
import { resolveDesktopElectronCaptureSubject } from './adapters/obsidian/desktop-electron-capture-subject';
import {
  leaseSnapshotCaptureSubject,
  SnapshotCaptureBackendRegistry,
  type SnapshotCaptureBackend,
} from './adapters/obsidian/snapshot-capture-backend';
import {
  disposeSnapshotCaptureActions,
  ensureSnapshotCaptureActions,
} from './adapters/obsidian/snapshot-capture-action';
import { BrowserSnapshotAnnotationFlattener } from './adapters/obsidian/browser-snapshot-annotation-flattener';
import { BrowserSnapshotThumbnailer } from './adapters/obsidian/browser-snapshot-thumbnailer';
import { BrowserSnapshotPngCoverageValidator } from './adapters/obsidian/browser-snapshot-png-coverage-validator';
import { CurrentMarkdownFileContext } from './adapters/obsidian/current-markdown-file-context';
import { LivePreviewAnnotationCoordinator } from './adapters/obsidian/live-preview-extension';
import { shouldRefreshAnnotationSurfacesForModify } from './adapters/obsidian/markdown-view-mode';
import type {
  AnnotationSidebarBulkSelection,
  AnnotationSidebarDeletedItem,
} from './adapters/obsidian/annotation-sidebar-commands';
import { AnnotationService } from './application/annotation-service';
import { AnnotationProjectionCoordinator } from './application/annotation-projection-coordinator';
import { CanonicalInkSummarySource } from './application/canonical-ink-summary-source';
import {
  SidecarGarbageCollector,
  type SidecarGarbageCollectionPreview,
  type SidecarGarbageCollectionResult,
} from './application/sidecar-garbage-collector';
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
import { VaultCatalogReconciler } from './application/vault-catalog-reconciler';
import { VaultCatalogSession } from './application/vault-catalog-session';
import { VaultCatalogMarkdownProjector } from './application/vault-catalog-markdown-projector';
import type { InkSurfaceRecord } from './domain/ink-surface';
import { StylePresetCatalog } from './domain/style-preset';
import { annotationTargetText, type TextAnnotationRecord } from './domain/text-annotation';
import type { AnnotationIndexEntry } from './domain/vault-annotation-index';
import { hashText } from './domain/text-anchor';
import { SourceProjectionCache } from './domain/source-projection';
import { AnnotationInspector } from './ui/annotation-inspector';
import { AnnotationExportDialog } from './ui/annotation-export-dialog';
import { Diagnostics } from './runtime/diagnostics';
import { PluginRuntime } from './runtime/plugin-runtime';
import { VersionedSourceCache } from './runtime/versioned-source-cache';
import { InkstoneSettingTab } from './settings-tab';
import { DEFAULT_SETTINGS, ensureDeviceId, parseSettings, type InkstoneSettings } from './settings';
import { SidecarRepository } from './storage/sidecar-repository';
import { InkSurfaceRepository } from './storage/ink-surface-repository';
import { InkDocumentSnapshotRepository } from './storage/ink-document-snapshot-repository';
import { IndexedDbSnapshotAnnotationDraftStore } from './storage/indexeddb-snapshot-annotation-draft-store';
import { LocalInkToolPreferenceStore } from './storage/local-ink-tool-preference';
import { IndexedDbVaultCatalog } from './storage/indexeddb-vault-catalog';
import { SnapshotAnnotationRepository } from './storage/snapshot-annotation-repository';
import { GraveyardRepository } from './storage/graveyard-repository';
import { SnapshotAnnotationEditor } from './ui/snapshot-annotation-editor';
import { writeSnapshotAnnotationPngExport } from './application/snapshot-annotation-export';

declare const __INKSTONE_WEB_CAPTURE_BACKENDS__: boolean;
declare const __INKSTONE_ACCEPTANCE_COMMANDS__: boolean;

export default class InkstoneAnnotationsPlugin extends Plugin {
  private readonly diagnostics = new Diagnostics(false);
  private readonly runtime = new PluginRuntime();
  private pluginSettings: InkstoneSettings = DEFAULT_SETTINGS;
  private inspector: AnnotationInspector | null = null;
  private readingView: ReadingViewIntegration | null = null;
  private sidecarGarbageCollector: SidecarGarbageCollector | null = null;
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
    const sourceProjectionCache = new SourceProjectionCache({
      maxEntries: 8,
      maxEstimatedBytes: 16 * 1024 * 1024,
    });
    this.runtime.registerDisposer(() => sourceProjectionCache.clear());

    const sidecarStore = new ObsidianVaultTextFileStore(this.app.vault.adapter);
    const graveyardRepository = new GraveyardRepository(sidecarStore, this.pluginSettings.deviceId);
    const snapshotAnnotationRepository = new SnapshotAnnotationRepository(sidecarStore, {
      onDerivedIssue: (error) => console.warn('[Inkstone Annotations]', error),
    });
    const currentMarkdownFile = new CurrentMarkdownFileContext(this.app.workspace);
    let markVaultCatalogDirty: (filePath: string) => void = () => undefined;
    const styleName = (styleId: string): string | undefined =>
      this.pluginSettings.stylePresets.find((preset) => preset.id === styleId)?.name;
    const repository = new SidecarRepository(sidecarStore, {
      deletionEvidence: graveyardRepository,
      onEventIssue: (error) => console.warn('[Inkstone Annotations]', error),
      onRecordChanged: (record) => markVaultCatalogDirty(record.filePath),
      onRecordRemoved: (record) => markVaultCatalogDirty(record.filePath),
    });
    let refreshInkSurfaceProjection: (record: InkSurfaceRecord) => void = () => undefined;
    const inkRepository = new InkSurfaceRepository(sidecarStore, {
      onEventIssue: (error) => console.warn('[Inkstone Annotations]', error),
      onSurfaceChanged: (record) => refreshInkSurfaceProjection(record),
    });
    const inkSnapshotRepository = new InkDocumentSnapshotRepository(sidecarStore, {
      onSnapshotChanged: (record) => refreshInkSurfaceProjection(record),
    });
    const canonicalInkSummaries = new CanonicalInkSummarySource({
      legacy: inkRepository,
      snapshots: inkSnapshotRepository,
    });
    const canonicalInkSidebarRepository = {
      listSurfaceSummaries: (filePath: string) =>
        canonicalInkSummaries.listSurfaceSummaries(filePath),
      listSurfaces: async (filePath: string) => {
        const snapshot = await inkSnapshotRepository.read(filePath);
        return snapshot === null
          ? inkRepository.listSurfaces(filePath)
          : { conflicts: [], issues: [], records: [snapshot] };
      },
      readSurface: (filePath: string, surfaceId: string) =>
        canonicalInkSummaries.readSurface(filePath, surfaceId),
    };
    const tombstoneCanonicalInk = async (
      filePath: string,
      surfaceId: string,
      expectedLegacyRevision: number,
    ): Promise<InkSurfaceRecord> => {
      const snapshot = await inkSnapshotRepository.read(filePath);
      if (snapshot === null) {
        return inkRepository.tombstoneSurface(
          filePath,
          surfaceId,
          new Date().toISOString(),
          this.pluginSettings.deviceId,
          expectedLegacyRevision,
        );
      }
      if (snapshot.deletedAt !== undefined) {
        throw new Error(`Ink document is already deleted: ${filePath}`);
      }
      const deleted = await inkSnapshotRepository.tombstone(filePath, new Date().toISOString());
      // The snapshot is authoritative. Tombstone every still-visible migration row so the
      // transitional Sidebar cannot advertise fragments of a document that was deleted as one.
      // Failure here must not resurrect the snapshot.
      try {
        const legacy = await inkRepository.listSurfaces(filePath);
        for (const record of legacy.records.filter(({ deletedAt }) => deletedAt === undefined)) {
          await inkRepository.tombstoneSurface(
            filePath,
            record.id,
            deleted.updatedAt,
            this.pluginSettings.deviceId,
            record.revision,
          );
        }
      } catch (error) {
        console.warn('[Inkstone Annotations] Legacy Ink delete projection failed.', error);
      }
      return deleted;
    };
    const restoreCanonicalInk = async (
      filePath: string,
      surfaceId: string,
      expectedLegacyRevision: number,
    ): Promise<InkSurfaceRecord> => {
      const snapshot = await inkSnapshotRepository.read(filePath);
      if (snapshot === null) {
        return inkRepository.restoreSurface(
          filePath,
          surfaceId,
          new Date().toISOString(),
          this.pluginSettings.deviceId,
          expectedLegacyRevision,
        );
      }
      if (snapshot.deletedAt === undefined) {
        throw new Error(`Ink document is not deleted: ${filePath}`);
      }
      const snapshotDeletedAt = snapshot.deletedAt;
      const restored = await inkSnapshotRepository.restore(filePath, new Date().toISOString());
      try {
        const legacy = await inkRepository.listSurfaces(filePath);
        for (const record of legacy.records.filter(
          ({ deletedAt }) => deletedAt === snapshotDeletedAt,
        )) {
          await inkRepository.restoreSurface(
            filePath,
            record.id,
            restored.updatedAt,
            this.pluginSettings.deviceId,
            record.revision,
          );
        }
      } catch (error) {
        console.warn('[Inkstone Annotations] Legacy Ink restore projection failed.', error);
      }
      return restored;
    };
    const snapshotDraftStore =
      globalThis.indexedDB === undefined
        ? undefined
        : new IndexedDbSnapshotAnnotationDraftStore(globalThis.indexedDB);
    if (snapshotDraftStore !== undefined) {
      this.runtime.registerDisposer(() => snapshotDraftStore.close());
    }
    const vaultFingerprint = await hashText(
      resolveVaultLocalIdentity(this.app.vault, this.pluginSettings.deviceId),
    );
    const vaultCatalog =
      globalThis.indexedDB === undefined || globalThis.IDBKeyRange === undefined
        ? null
        : new IndexedDbVaultCatalog({
            IDBKeyRange: globalThis.IDBKeyRange,
            databaseName: `inkstone-vault-catalog-v1-${vaultFingerprint.slice(0, 24)}`,
            indexedDB: globalThis.indexedDB,
            vaultFingerprint,
            yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
          });
    const vaultCatalogReconciler = new VaultCatalogReconciler({
      onIssue: (error) => console.warn('[Inkstone Annotations]', error),
      source: {
        isSourceAvailable: (filePath) => this.app.vault.getFileByPath(filePath) !== null,
        listAnnotations: (filePath) => repository.listAnnotations(filePath),
        listNotes: () => repository.listNotes(),
        readNoteMeta: (filePath) => repository.readNoteMeta(filePath),
        listSnapshotRecords: (filePath) => snapshotAnnotationRepository.listRecords(filePath),
        listSurfaceSummaries: (filePath) => canonicalInkSummaries.listSurfaceSummaries(filePath),
        readMarkdown: async (filePath) => {
          const file = this.app.vault.getFileByPath(filePath);
          if (file === null) throw new Error(`Snapshot source note is missing: ${filePath}`);
          return this.app.vault.cachedRead(file);
        },
      },
      styleName,
      yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
    });
    const vaultCatalogMarkdownProjector =
      vaultCatalog === null
        ? null
        : new VaultCatalogMarkdownProjector(vaultCatalog, {
            yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
          });
    const vaultCatalogSession = new VaultCatalogSession({
      onIssue: (error) => console.warn('[Inkstone Annotations]', error),
      openCatalog: async (signal) => {
        if (vaultCatalog === null) throw new Error('Vault Catalog IndexedDB is unavailable.');
        await vaultCatalogReconciler.ensureInitialized(vaultCatalog, signal);
        return vaultCatalog;
      },
      projectPaths: async (_store, paths, signal) => {
        if (vaultCatalog === null) throw new Error('Vault Catalog IndexedDB is unavailable.');
        const markdownPaths = paths
          .filter((path) => path.startsWith('markdown:'))
          .map((path) => path.slice('markdown:'.length));
        const canonicalPaths = paths.filter((path) => !path.startsWith('markdown:'));
        if (canonicalPaths.length > 0) {
          await vaultCatalogReconciler.reconcileFiles(vaultCatalog, canonicalPaths, signal);
        }
        if (markdownPaths.length > 0 && vaultCatalogMarkdownProjector !== null) {
          await vaultCatalog.setFreshness('reconciling');
          try {
            for (const filePath of markdownPaths) {
              const [meta, file] = await Promise.all([
                repository.readNoteMeta(filePath),
                Promise.resolve(this.app.vault.getFileByPath(filePath)),
              ]);
              if (meta === null || file === null) continue;
              const source = await this.app.vault.cachedRead(file);
              await vaultCatalogMarkdownProjector.apply({
                noteId: meta.noteId,
                ...(signal === undefined ? {} : { signal }),
                source,
              });
            }
            await vaultCatalog.setFreshness('current');
          } catch (error) {
            await vaultCatalog.setFreshness('stale');
            throw error;
          }
        }
      },
      reconcile: (_store, signal) => {
        if (vaultCatalog === null) throw new Error('Vault Catalog IndexedDB is unavailable.');
        return vaultCatalogReconciler.reconcile(vaultCatalog, signal);
      },
    });
    markVaultCatalogDirty = (filePath) => vaultCatalogSession.markDirtyPath(filePath);
    refreshInkSurfaceProjection = (record) => {
      markVaultCatalogDirty(record.filePath);
      void canonicalInkSummaries
        .listSurfaceSummaries(record.filePath)
        .then((summaries) => this.sidebarView?.applyInkSurfaceSummaries(record.filePath, summaries))
        .catch((error) => console.warn('[Inkstone Annotations]', error));
    };
    this.runtime.registerDisposer(() => vaultCatalogSession.close());
    const annotationService = new AnnotationService({
      deviceId: this.pluginSettings.deviceId,
      repository,
    });
    this.sidecarGarbageCollector = new SidecarGarbageCollector({
      graveyard: graveyardRepository,
      now: () => new Date().toISOString(),
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
    const navigateToLegacyInk = async (filePath: string): Promise<void> => {
      const file = this.app.vault.getFileByPath(filePath);
      if (file === null) throw new Error(`Legacy Ink source file no longer exists: ${filePath}`);
      await this.app.workspace.getLeaf(false).openFile(file);
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
      const filePath = currentMarkdownFile.currentFilePath();
      if (filePath === null) {
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
    let snapshotAnnotationManager: ObsidianSnapshotAnnotationManager | null = null;
    this.registerView(ANNOTATION_SIDEBAR_VIEW_TYPE, (leaf) => {
      const view = new AnnotationSidebarView(leaf, {
        commands: {
          getCurrentFilePath: () => currentMarkdownFile.currentFilePath(),
          inspectAnnotation: (annotationId, invoker) => openInspector([annotationId], invoker),
          navigateToAnnotation: (annotationId) =>
            this.readingView?.focusAnnotation(annotationId) ?? false,
          navigateToVaultAnnotation: (entry) => {
            if (entry.type === 'ink') {
              void navigateToLegacyInk(entry.filePath).catch((error) =>
                console.warn('[Inkstone Annotations]', error),
              );
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
            const textSelection = selection.filter(
              (item) => item.type !== 'ink' && item.type !== 'snapshot',
            );
            const inkSelection = selection.filter((item) => item.type === 'ink');
            const snapshotSelection = selection.filter((item) => item.type === 'snapshot');
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

            for (const item of inkSelection) {
              try {
                const deleted = await tombstoneCanonicalInk(
                  item.filePath,
                  item.id,
                  item.expectedRevision,
                );
                succeeded.push({
                  deletedRevision: deleted.revision,
                  filePath: deleted.filePath,
                  id: item.id,
                  noteId: deleted.noteId,
                  type: 'ink',
                });
              } catch (error) {
                console.warn('[Inkstone Annotations]', error);
                failed.push(item);
              }
            }
            for (const item of snapshotSelection) {
              try {
                const deleted = await snapshotAnnotationRepository.tombstone(
                  item.filePath,
                  item.id,
                  item.expectedRevision,
                  new Date().toISOString(),
                );
                succeeded.push({
                  deletedRevision: deleted.revision,
                  filePath: deleted.filePath,
                  id: item.id,
                  noteId: deleted.noteId,
                  type: 'snapshot',
                });
              } catch (error) {
                console.warn('[Inkstone Annotations]', error);
                failed.push(item);
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
            await tombstoneCanonicalInk(filePath, surfaceId, expectedRevision);
            await annotationProjections.refresh([filePath]);
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
            const textEntries = entries.filter(
              (entry) => entry.type !== 'ink' && entry.type !== 'snapshot',
            );
            const inkEntries = entries.filter((entry) => entry.type === 'ink');
            if (textEntries.length === 0 && inkEntries.length === 0) {
              new Notice('Snapshot annotations export from the card menu.');
              return;
            }
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
            void navigateToLegacyInk(summary.filePath).catch((error) =>
              console.warn('[Inkstone Annotations]', error),
            );
          },
          restoreDeleted: async (selection) => {
            const failed: AnnotationSidebarDeletedItem[] = [];
            const restoredFilePaths = new Set<string>();
            const inkSelection = selection.filter((item) => item.type === 'ink');
            const snapshotSelection = selection.filter((item) => item.type === 'snapshot');
            for (const item of selection.filter(
              (candidate) => candidate.type !== 'ink' && candidate.type !== 'snapshot',
            )) {
              try {
                await annotationService.undoDeletion(item.filePath, item.id, item.deletedRevision);
                restoredFilePaths.add(item.filePath);
              } catch (error) {
                console.warn('[Inkstone Annotations]', error);
                failed.push(item);
              }
            }

            for (const item of inkSelection) {
              try {
                await restoreCanonicalInk(item.filePath, item.id, item.deletedRevision);
                restoredFilePaths.add(item.filePath);
              } catch (error) {
                console.warn('[Inkstone Annotations]', error);
                failed.push(item);
              }
            }
            for (const item of snapshotSelection) {
              try {
                await snapshotAnnotationRepository.restore(
                  item.filePath,
                  item.id,
                  item.deletedRevision,
                  new Date().toISOString(),
                );
                restoredFilePaths.add(item.filePath);
              } catch (error) {
                console.warn('[Inkstone Annotations]', error);
                failed.push(item);
              }
            }
            await annotationProjections.refresh([...restoredFilePaths]);
            return { failed };
          },
          restoreInk: async (filePath, surfaceId, expectedRevision) => {
            await restoreCanonicalInk(filePath, surfaceId, expectedRevision);
            await annotationProjections.refresh([filePath]);
          },
          restoreAnnotation: async (filePath, annotationId, expectedRevision) => {
            await annotationService.undoDeletion(filePath, annotationId, expectedRevision);
            if (lastDeleted?.id === annotationId && lastDeleted.filePath === filePath) {
              lastDeleted = null;
            }
            await refreshAnnotationSurfaces(filePath);
          },
        },
        inkRepository: canonicalInkSidebarRepository,
        service: annotationService,
        snapshots: {
          delete: async (summary) => {
            await snapshotAnnotationRepository.tombstone(
              summary.filePath,
              summary.id,
              summary.revision,
              new Date().toISOString(),
            );
          },
          edit: (summary) => {
            void snapshotAnnotationManager
              ?.reopen(summary.filePath, summary.id)
              .catch((error) => console.warn('[Inkstone Annotations]', error));
          },
          exportPng: async (summary) => {
            await snapshotAnnotationManager?.exportSnapshot(summary.filePath, summary.id);
          },
          jump: (summary) => {
            void snapshotAnnotationManager
              ?.jumpToSource(summary.filePath, summary.id)
              .then((jumped) => {
                if (!jumped) new Notice('Snapshot source is unavailable. Relink it first.');
              })
              .catch((error) => console.warn('[Inkstone Annotations]', error));
          },
          preview: (summary) => {
            void snapshotAnnotationManager
              ?.reopen(summary.filePath, summary.id, true)
              .catch((error) => console.warn('[Inkstone Annotations]', error));
          },
          readSource: async (filePath) => {
            const file = this.app.vault.getFileByPath(filePath);
            if (file === null) throw new Error(`Snapshot source note is missing: ${filePath}`);
            return this.app.vault.cachedRead(file);
          },
          relink: (summary) => {
            void this.readingView
              ?.captureCurrentSelection()
              .then(async (selection) => {
                if (selection === null || selection.filePath !== summary.filePath) {
                  throw new Error('Select replacement text in the same Reading View first.');
                }
                const sourceRevision = selection.target.sourceRevision;
                if (sourceRevision === undefined) {
                  throw new Error('The replacement selection has no source revision.');
                }
                await snapshotAnnotationRepository.relink(
                  summary.filePath,
                  summary.id,
                  summary.revision,
                  {
                    coverage: [selection.target],
                    focus: selection.target,
                    headingPath: selection.target.scope.headingPath ?? [],
                    sourceRevision,
                  },
                  new Date().toISOString(),
                );
                await view.refreshAfterCanonicalMutation(summary.filePath);
              })
              .catch((error) => {
                console.warn('[Inkstone Annotations]', error);
                new Notice(error instanceof Error ? error.message : 'Snapshot relink failed.');
              });
          },
          repository: snapshotAnnotationRepository,
          restore: (summary) => {
            void snapshotAnnotationRepository
              .restore(summary.filePath, summary.id, summary.revision, new Date().toISOString())
              .then(
                () => view.refreshAfterCanonicalMutation(summary.filePath),
                (error) => console.warn('[Inkstone Annotations]', error),
              );
          },
          thumbnail: (summary) =>
            snapshotAnnotationManager?.thumbnail(summary.filePath, summary.id) ??
            Promise.resolve(null),
        },
        stylePresets: this.pluginSettings.stylePresets,
        closeVaultCatalog: () => vaultCatalogSession.close(),
        markVaultCatalogDirty: (filePath) => vaultCatalogSession.markDirtyPath(filePath),
        requestVaultCatalogReconcile: () => vaultCatalogSession.requestReconcile(),
        vaultCatalog: vaultCatalogSession,
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
      onSnapshotFallback: async () => {
        if (snapshotAnnotationManager === null) {
          throw new Error('Snapshot annotation is unavailable.');
        }
        await snapshotAnnotationManager.captureActiveReadingView();
      },
      recordDuration: (name, durationMs) => this.diagnostics.recordDuration(name, durationMs),
      service: annotationService,
      sourceProjectionCache,
      presets: this.pluginSettings.stylePresets,
    });
    this.readingView = readingView;
    this.runtime.registerDisposer(() => readingView.dispose());
    const snapshotCaptureBackends: SnapshotCaptureBackend[] = [
      new ElectronSnapshotCaptureBackend(),
    ];
    let snapshotCaptureBackendId = 'electron-capture-page';
    if (__INKSTONE_WEB_CAPTURE_BACKENDS__) {
      const [{ HtmlToImageSnapshotCaptureBackend }, { ForeignObjectSnapshotCaptureBackend }] =
        await Promise.all([
          import('./adapters/obsidian/html-to-image-snapshot-capture-backend'),
          import('./adapters/obsidian/foreign-object-snapshot-capture-backend'),
        ]);
      snapshotCaptureBackends.push(
        new HtmlToImageSnapshotCaptureBackend({ document: globalThis.document }),
        new ForeignObjectSnapshotCaptureBackend({ document: globalThis.document }),
      );
      if (!Platform.isDesktopApp) snapshotCaptureBackendId = 'html-to-image';
    }
    snapshotAnnotationManager = new ObsidianSnapshotAnnotationManager({
      app: this.app,
      backendId: snapshotCaptureBackendId,
      captureBackends: new SnapshotCaptureBackendRegistry(snapshotCaptureBackends),
      createCaptureSubject: (readingRoot, backendId) =>
        backendId === 'electron-capture-page'
          ? resolveDesktopElectronCaptureSubject()
          : leaseSnapshotCaptureSubject(readingRoot),
      createThumbnailDataUrl: (record, pngBytes, signal) =>
        new BrowserSnapshotThumbnailer({
          document: globalThis.document,
          flattener: new BrowserSnapshotAnnotationFlattener({
            document: globalThis.document,
          }),
        }).create(record, pngBytes, signal),
      deviceId: this.pluginSettings.deviceId,
      document: globalThis.document,
      ...(snapshotDraftStore === undefined ? {} : { draftStore: snapshotDraftStore }),
      editor: new SnapshotAnnotationEditor({
        document: globalThis.document,
        preferenceStore: new LocalInkToolPreferenceStore(
          globalThis.localStorage,
          this.app.vault.getName(),
          this.pluginSettings.deviceId,
        ),
      }),
      exportSnapshot: async (record, pngBytes) => {
        const path = await writeSnapshotAnnotationPngExport({
          flattener: new BrowserSnapshotAnnotationFlattener({
            document: globalThis.document,
          }),
          pngBytes,
          record,
          store: sidecarStore,
        });
        new Notice(`Exported flattened Snapshot PNG to ${path}`);
      },
      onIssue: (error) => console.warn('[Inkstone Annotations]', error),
      onActiveSnapshotChanged: (snapshotId) => {
        if (snapshotId !== null) this.sidebarView?.selectSnapshot(snapshotId);
      },
      onRecordsChanged: async (filePath) => {
        await this.sidebarView?.refreshAfterCanonicalMutation(filePath);
        void snapshotAnnotationRepository
          .cleanupColdOrphans(filePath, {
            limit: 2,
            minimumAgeMs: 7 * 24 * 60 * 60 * 1_000,
            now: new Date().toISOString(),
          })
          .catch((error: unknown) => console.warn('[Inkstone Annotations]', error));
      },
      repository: snapshotAnnotationRepository,
      sourceProjectionCache,
      textRepository: repository,
      validatePngCoverage: (pngBytes, signal) =>
        new BrowserSnapshotPngCoverageValidator({
          document: globalThis.document,
        }).assertNonblank(pngBytes, signal),
    });
    if (snapshotAnnotationManager !== null) {
      this.runtime.registerDisposer(() => snapshotAnnotationManager.dispose());
      const snapshotActions = new Map<MarkdownView, HTMLElement>();
      const installSnapshotActions = (): void => {
        const views = this.app.workspace
          .getLeavesOfType('markdown')
          .flatMap((leaf) =>
            leaf.view instanceof MarkdownView && leaf.view.getMode() === 'preview'
              ? [leaf.view]
              : [],
          );
        ensureSnapshotCaptureActions({
          actions: snapshotActions,
          onActivate: (action) => {
            readingView.dismissTransientSelectionUi();
            action.classList.add('is-pending');
            action.setAttribute('aria-label', 'Capturing Reading View');
            void snapshotAnnotationManager
              ?.captureActiveReadingView()
              .catch((error: unknown) => {
                console.warn('[Inkstone Annotations]', error);
                new Notice(error instanceof Error ? error.message : 'Snapshot capture failed.');
              })
              .finally(() => {
                action.classList.remove('is-pending');
                action.setAttribute('aria-label', 'Capture & annotate');
              });
          },
          views,
        });
        void snapshotAnnotationManager
          ?.refreshSourceTrackingForActiveFile()
          .catch((error) => console.warn('[Inkstone Annotations]', error));
      };
      this.registerEvent(this.app.workspace.on('active-leaf-change', installSnapshotActions));
      this.registerEvent(this.app.workspace.on('layout-change', installSnapshotActions));
      this.app.workspace.onLayoutReady(installSnapshotActions);
      this.runtime.registerDisposer(() => disposeSnapshotCaptureActions(snapshotActions));
    }

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
    if (snapshotAnnotationManager !== null) {
      this.addCommand({
        id: 'capture-snapshot-annotation',
        name: 'Capture & annotate current Reading View',
        callback: () => {
          readingView.dismissTransientSelectionUi();
          new Notice('Capturing current Reading View…', 1_000);
          void snapshotAnnotationManager.captureActiveReadingView().catch((error: unknown) => {
            console.warn('[Inkstone Annotations]', error);
            new Notice(error instanceof Error ? error.message : 'Snapshot capture failed.');
          });
        },
      });
      this.addCommand({
        id: 'resume-latest-snapshot-annotation-draft',
        name: 'Resume latest Snapshot annotation draft',
        callback: () => {
          void snapshotAnnotationManager
            .resumeLatestDraftForActiveFile()
            .then((opened) => {
              if (!opened) new Notice('No Snapshot annotation draft exists for this file.');
            })
            .catch((error: unknown) => {
              console.warn('[Inkstone Annotations]', error);
              new Notice(error instanceof Error ? error.message : 'Snapshot draft reopen failed.');
            });
        },
      });
      if (__INKSTONE_ACCEPTANCE_COMMANDS__) {
        for (const [backendId, label] of [
          ['electron-capture-page', 'Electron'],
          ['html-to-image', 'html-to-image'],
          ['inkstone-foreign-object', 'Inkstone foreignObject'],
        ] as const) {
          if (!Platform.isDesktopApp && backendId === 'electron-capture-page') continue;
          this.addCommand({
            id: `select-snapshot-backend-${backendId}`,
            name: `Snapshot acceptance: use ${label} backend`,
            callback: () => {
              snapshotAnnotationManager?.selectBackend(backendId);
              new Notice(`Snapshot capture backend: ${label}`);
            },
          });
        }
      }
      this.addCommand({
        id: 'reopen-latest-snapshot-annotation',
        name: 'Reopen latest Snapshot annotation',
        callback: () => {
          void snapshotAnnotationManager
            .reopenLatestForActiveFile()
            .then((opened) => {
              if (!opened) new Notice('No saved Snapshot annotation exists for this file.');
            })
            .catch((error: unknown) => {
              console.warn('[Inkstone Annotations]', error);
              new Notice(error instanceof Error ? error.message : 'Snapshot reopen failed.');
            });
        },
      });
    }
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
    });
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        currentMarkdownFile.observeLeaf(leaf);
        const filePath = currentMarkdownFile.currentFilePath();
        if (filePath !== null) {
          void repository
            .readNoteMeta(filePath)
            .then((meta) => {
              if (meta !== null) {
                vaultCatalogSession.recordNoteOpened(meta.noteId, new Date().toISOString());
              }
            })
            .catch((error) => console.warn('[Inkstone Annotations]', error));
        }
        void this.sidebarView?.followActiveFile();
      }),
    );
    const handleCanonicalSidecarEvent = (file: { readonly path: string }): void => {
      const canonical =
        /^\.obsidian-annotations\/v1\/notes\/[^/]+\/(?:(?:annotations|surfaces)\/[^/]+\.json|snapshot-annotations\/[^/]+\/(?:record|summary)\.json|ink-summaries\.json|ink\.json)$/u.test(
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
          void repository
            .resolveFilePathForSidecar(file.path)
            .then((filePath) => {
              if (filePath === null) {
                vaultCatalogSession.requestReconcile();
                return;
              }
              markVaultCatalogDirty(filePath);
              void this.sidebarView?.refreshAfterCanonicalMutation(filePath);
            })
            .catch((error) => console.warn('[Inkstone Annotations]', error));
          if (file.path.endsWith('/ink.json')) {
            void inkSnapshotRepository
              .resolveFilePath(file.path)
              .then(async (filePath) => {
                if (filePath === null) return;
                await refreshAnnotationSurfaces(filePath);
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
                await refreshAnnotationSurfaces(filePath);
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
        });
    };
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
        void sidecarLifecycle
          .reconcileObservedRename(oldPath, file.path)
          .then(async (meta) => {
            await snapshotAnnotationRepository.reconcileObservedRename(
              oldPath,
              file.path,
              new Date().toISOString(),
            );
            if (meta !== null) markVaultCatalogDirty(file.path);
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
        if (file instanceof TFile && file.extension === 'md') {
          vaultCatalogSession.markDirtyPath(`markdown:${file.path}`);
        }
        const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (
          !(file instanceof TFile) ||
          file.extension !== 'md' ||
          !shouldRefreshAnnotationSurfacesForModify(file.path, activeMarkdownView)
        ) {
          return;
        }
        void Promise.all([
          refreshAnnotationSurfaces(file.path),
          snapshotAnnotationManager?.refreshSourceTrackingForActiveFile(),
        ]).catch((error) => console.warn('[Inkstone Annotations]', error));
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') {
          return;
        }
        void sidecarLifecycle
          .markSourceMissing(file.path)
          .then((meta) => {
            if (meta === null) return;
            markVaultCatalogDirty(file.path);
          })
          .catch((error) => console.warn('[Inkstone Annotations]', error));
      }),
    );

    this.diagnostics.recordDuration('plugin-startup', performance.now() - startedAt);
  }

  override onunload(): void {
    const startedAt = performance.now();
    const cleanupErrors = this.runtime.stop();
    this.readingView = null;
    this.sidecarGarbageCollector = null;
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

  previewCacheCleanup(): Promise<SidecarGarbageCollectionPreview> {
    if (this.sidecarGarbageCollector === null) {
      throw new Error('缓存清理服务尚未就绪。');
    }
    return this.sidecarGarbageCollector.preview();
  }

  clearCache(): Promise<SidecarGarbageCollectionResult> {
    if (this.sidecarGarbageCollector === null) {
      throw new Error('缓存清理服务尚未就绪。');
    }
    return this.sidecarGarbageCollector.clear();
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

function resolveVaultLocalIdentity(
  vault: { readonly adapter: unknown; getName(): string },
  deviceId: string,
): string {
  const adapter = vault.adapter as { getBasePath?: () => string };
  const basePath = adapter.getBasePath?.();
  return basePath === undefined || basePath.length === 0
    ? `mobile:${deviceId}:${vault.getName()}`
    : `desktop:${basePath}`;
}
