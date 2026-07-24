import type { LocaleCatalog } from '../locale-catalog';

export function createEnglishCatalog(formatNumber: (value: number) => string): LocaleCatalog {
  return {
    'command.addNote': () => 'Add note to selection',
    'command.applyHighlight': () => 'Apply last highlight to selection',
    'command.captureSnapshot': () => 'Capture & annotate current Reading View',
    'command.openAnnotations': () => 'Open annotations for current file',
    'command.reopenSnapshot': () => 'Reopen latest Snapshot annotation',
    'command.resumeSnapshotDraft': () => 'Resume latest Snapshot annotation draft',
    'command.selectSnapshotBackend': ({ label }) => `Snapshot acceptance: use ${label} backend`,
    'command.showDiagnostics': () => 'Show diagnostics',
    'command.undoAnnotationDelete': () => 'Undo last annotation delete',
    'inspector.annotationJsonCopied': () => 'Annotation JSON copied',
    'inspector.annotationLinkCopied': () => 'Annotation link copied',
    'inspector.cancel': () => 'Cancel',
    'inspector.cancelReattachment': () => 'Cancel reattachment',
    'inspector.chooseHint': () => 'Several annotations share this passage.',
    'inspector.chooseTitle': () => 'Choose annotation',
    'inspector.confirmReattachment': () => 'Confirm reattachment',
    'inspector.copyFailed': () => "Couldn't copy. Retry.",
    'inspector.copyJson': () => 'Copy annotation JSON',
    'inspector.copyLink': () => 'Copy annotation link',
    'inspector.copyQuote': () => 'Copy quote',
    'inspector.deleteAnnotation': () => 'Delete annotation',
    'inspector.deleteFailed': () => "Couldn't delete locally. Retry.",
    'inspector.deletedTitle': () => 'Annotation deleted',
    'inspector.deleting': () => 'Deleting…',
    'inspector.exportAnnotation': () => 'Export annotation',
    'inspector.exportOpened': () => 'Export options opened',
    'inspector.goToSource': () => 'Go to source',
    'inspector.label': () => 'Annotation inspector',
    'inspector.legacyStyle': () => 'Legacy style',
    'inspector.mark.highlight': () => 'Highlight',
    'inspector.mark.note': () => 'Note',
    'inspector.mark.underline': () => 'Underline',
    'inspector.markType': () => 'Mark type',
    'inspector.markTypeLabel': ({ type }) => `${type} mark type`,
    'inspector.newTarget': () => 'New target',
    'inspector.note': () => 'Note',
    'inspector.notePlaceholder': () => 'Add a note…',
    'inspector.quoteCopied': () => 'Quote copied',
    'inspector.reattachFailed': () =>
      "Couldn't reattach locally. The original target is unchanged.",
    'inspector.repairHint': () => 'Replace the missing target with your current selection?',
    'inspector.repairPreview': () => 'Target replacement preview',
    'inspector.repairTitle': () => 'Repair annotation',
    'inspector.retry': () => 'Retry',
    'inspector.retrySave': () => 'Retry save',
    'inspector.save': () => 'Save',
    'inspector.saveAnnotation': () => 'Save annotation',
    'inspector.saveFailed': () => "Couldn't save locally. Retry.",
    'inspector.savedLocally': () => 'Saved locally',
    'inspector.saving': () => 'Saving…',
    'inspector.sourceOpened': () => 'Source opened',
    'inspector.style': () => 'Style',
    'inspector.styleLabel': ({ name }) => `Style: ${name}`,
    'inspector.tags': () => 'Tags',
    'inspector.targetCurrent': () => 'Current target',
    'inspector.undo': () => 'Undo',
    'inspector.undoDelete': () => 'Undo delete',
    'inspector.undoFailed': () => "Couldn't undo locally. Retry.",
    'inspector.useSelection': () => 'Use selection',
    'notice.annotationLinkIncomplete': () =>
      'The annotation link is missing its file or annotation ID.',
    'notice.annotationMissing': () => 'The linked annotation is missing or deleted.',
    'notice.annotationRepairDifferentFile': () =>
      'Select replacement text in the same note as this annotation.',
    'notice.annotationRepairFailed': () =>
      "Couldn't prepare this repair. The original target is unchanged.",
    'notice.annotationRepairNotNeeded': () => 'This annotation no longer needs repair.',
    'notice.annotationRepairUnavailable': () =>
      'This annotation is no longer available for repair.',
    'notice.backgroundCleanupFailed': ({ count }) =>
      `Inkstone could not clean up ${formatNumber(count)} background task(s).`,
    'notice.captureSnapshotFailed': () => 'Snapshot capture failed.',
    'notice.capturingReadingView': () => 'Capturing current Reading View…',
    'notice.diagnosticsDisabled': () =>
      'Diagnostics are disabled. Enable them in Inkstone Annotations settings.',
    'notice.exportedInkPng': ({ path }) => `Exported Ink PNG to ${path}`,
    'notice.exportedInkReport': ({ path }) => `Exported Ink report to ${path}`,
    'notice.exportedInkSvg': ({ path }) => `Exported Ink SVG to ${path}`,
    'notice.exportedSnapshotPng': ({ path }) => `Exported flattened Snapshot PNG to ${path}`,
    'notice.highlightSaveFailed': () => "Couldn't save highlight locally. Retry.",
    'notice.noAnnotationDeleteToUndo': () => 'No annotation deletion is available to undo.',
    'notice.noSnapshotDraft': () => 'No Snapshot annotation draft exists for this file.',
    'notice.noSnapshotToReopen': () => 'No saved Snapshot annotation exists for this file.',
    'notice.noTimingSamples': () => 'No timing samples yet.',
    'notice.noteDraftFailed': () => "Couldn't create a local note draft. Retry.",
    'notice.openSidebarFailed': () => "Couldn't open the annotation sidebar.",
    'notice.selectReplacementReadingView': () =>
      'Select supported replacement text in Reading View first.',
    'notice.selectSupportedText': () =>
      'Select supported text in Reading View or Live Preview first.',
    'notice.snapshotBackendSelected': ({ label }) => `Snapshot capture backend: ${label}`,
    'notice.snapshotDraftReopenFailed': () => 'Snapshot draft reopen failed.',
    'notice.snapshotExportFromCard': () => 'Snapshot annotations export from the card menu.',
    'notice.snapshotRelinkFailed': () => 'Snapshot relink failed.',
    'notice.snapshotReopenFailed': () => 'Snapshot reopen failed.',
    'notice.snapshotSourceUnavailable': () => 'Snapshot source is unavailable. Relink it first.',
    'notice.undoAnnotationDeleteFailed': () => "Couldn't undo annotation deletion locally. Retry.",
    'quickToolbar.addNote': () => 'Add note',
    'quickToolbar.highlightStyle': ({ name }) => `Highlight: ${name}`,
    'quickToolbar.label': () => 'Annotation actions',
    'quickToolbar.openDetails': () => 'Open annotation details',
    'quickToolbar.saveFailed': () => "Couldn't save locally. Retry.",
    'quickToolbar.snapshotStartFailed': () => "Couldn't start Snapshot annotation. Retry.",
    'quickToolbar.underline': () => 'Underline',
    'snapshot.captureAction': () => 'Capture & annotate',
    'snapshot.capturingAction': () => 'Capturing Reading View',
    'settings.cleanup.button': () => 'Clear cache',
    'settings.cleanup.cleaning': () => 'Cleaning…',
    'settings.cleanup.confirm': ({ eligibleCount, heldCount }) => {
      const held =
        heldCount === 0
          ? ''
          : `\n\n${formatNumber(heldCount)} conflicting or damaged text annotation(s) will be retained.`;
      return `Permanently delete ${formatNumber(eligibleCount)} deleted text annotation(s)? This action cannot be undone.${held}`;
    },
    'settings.cleanup.description': () =>
      'Permanently remove deleted highlights and text notes. Conflicting or damaged data is retained. Ink and Snapshot annotations are not included.',
    'settings.cleanup.failure': () => 'Cache cleanup failed.',
    'settings.cleanup.name': () => 'Clear cache',
    'settings.cleanup.noEligible': ({ heldCount }) =>
      heldCount === 0
        ? 'There is no text annotation cache to clear.'
        : `${formatNumber(heldCount)} conflicting or damaged text annotation(s) were retained.`,
    'settings.cleanup.scanning': () => 'Scanning…',
    'settings.cleanup.success': ({ removedCount, retainedCount }) =>
      `Cache cleanup complete: permanently removed ${formatNumber(removedCount)} text annotation(s); retained ${formatNumber(retainedCount)} due to conflicts or damage.`,
    'settings.diagnostics.description': () =>
      'Keep local timing samples. Annotation text, ink points, and file paths are never logged.',
    'settings.diagnostics.name': () => 'Diagnostics',
    'settings.style.namePlaceholder': () => 'Preset name',
    'settings.style.stableId': ({ id }) => `Stable style ID: ${id}`,
    'sidebar.selectedCount': ({ count }) => `${formatNumber(count)} selected`,
  };
}
