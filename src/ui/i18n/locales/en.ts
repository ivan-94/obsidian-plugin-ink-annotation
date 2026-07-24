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
