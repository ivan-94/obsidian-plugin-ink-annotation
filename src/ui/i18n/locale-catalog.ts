export type SupportedLocale = 'en' | 'zh';

export interface MessageParameters {
  readonly 'command.addNote': undefined;
  readonly 'command.applyHighlight': undefined;
  readonly 'command.captureSnapshot': undefined;
  readonly 'command.openAnnotations': undefined;
  readonly 'command.reopenSnapshot': undefined;
  readonly 'command.resumeSnapshotDraft': undefined;
  readonly 'command.selectSnapshotBackend': { readonly label: string };
  readonly 'command.showDiagnostics': undefined;
  readonly 'command.undoAnnotationDelete': undefined;
  readonly 'notice.annotationLinkIncomplete': undefined;
  readonly 'notice.annotationMissing': undefined;
  readonly 'notice.annotationRepairDifferentFile': undefined;
  readonly 'notice.annotationRepairFailed': undefined;
  readonly 'notice.annotationRepairNotNeeded': undefined;
  readonly 'notice.annotationRepairUnavailable': undefined;
  readonly 'notice.backgroundCleanupFailed': { readonly count: number };
  readonly 'notice.captureSnapshotFailed': undefined;
  readonly 'notice.capturingReadingView': undefined;
  readonly 'notice.diagnosticsDisabled': undefined;
  readonly 'notice.exportedInkPng': { readonly path: string };
  readonly 'notice.exportedInkReport': { readonly path: string };
  readonly 'notice.exportedInkSvg': { readonly path: string };
  readonly 'notice.exportedSnapshotPng': { readonly path: string };
  readonly 'notice.highlightSaveFailed': undefined;
  readonly 'notice.noAnnotationDeleteToUndo': undefined;
  readonly 'notice.noSnapshotDraft': undefined;
  readonly 'notice.noSnapshotToReopen': undefined;
  readonly 'notice.noTimingSamples': undefined;
  readonly 'notice.noteDraftFailed': undefined;
  readonly 'notice.openSidebarFailed': undefined;
  readonly 'notice.selectReplacementReadingView': undefined;
  readonly 'notice.selectSupportedText': undefined;
  readonly 'notice.snapshotBackendSelected': { readonly label: string };
  readonly 'notice.snapshotDraftReopenFailed': undefined;
  readonly 'notice.snapshotExportFromCard': undefined;
  readonly 'notice.snapshotRelinkFailed': undefined;
  readonly 'notice.snapshotReopenFailed': undefined;
  readonly 'notice.snapshotSourceUnavailable': undefined;
  readonly 'notice.undoAnnotationDeleteFailed': undefined;
  readonly 'snapshot.captureAction': undefined;
  readonly 'snapshot.capturingAction': undefined;
  readonly 'settings.cleanup.button': undefined;
  readonly 'settings.cleanup.cleaning': undefined;
  readonly 'settings.cleanup.confirm': {
    readonly eligibleCount: number;
    readonly heldCount: number;
  };
  readonly 'settings.cleanup.description': undefined;
  readonly 'settings.cleanup.failure': undefined;
  readonly 'settings.cleanup.name': undefined;
  readonly 'settings.cleanup.noEligible': { readonly heldCount: number };
  readonly 'settings.cleanup.scanning': undefined;
  readonly 'settings.cleanup.success': {
    readonly removedCount: number;
    readonly retainedCount: number;
  };
  readonly 'settings.diagnostics.description': undefined;
  readonly 'settings.diagnostics.name': undefined;
  readonly 'settings.style.namePlaceholder': undefined;
  readonly 'settings.style.stableId': { readonly id: string };
  readonly 'sidebar.selectedCount': { readonly count: number };
}

export type MessageKey = keyof MessageParameters;

export type MessageArguments<Key extends MessageKey> = MessageParameters[Key] extends undefined
  ? []
  : [parameters: MessageParameters[Key]];

export type LocaleCatalog = {
  readonly [Key in MessageKey]: (parameters: MessageParameters[Key]) => string;
};
