import type { AnnotationIndexEntry } from '../../domain/vault-annotation-index';
import type { InkSurfaceSummary } from '../../domain/ink-surface-summary';
import type { InkSurfaceConflict } from '../../storage/ink-surface-repository';

export interface AnnotationSidebarBulkSelection {
  readonly expectedRevision: number;
  readonly filePath: string;
  readonly id: string;
  readonly noteId?: string;
  readonly type: AnnotationIndexEntry['type'];
}

export interface AnnotationSidebarDeletedItem {
  readonly deletedRevision: number;
  readonly filePath: string;
  readonly id: string;
  readonly noteId?: string;
  readonly type: AnnotationIndexEntry['type'];
}

export interface AnnotationSidebarBulkDeleteOutcome {
  readonly failed: readonly AnnotationSidebarBulkSelection[];
  readonly succeeded: readonly AnnotationSidebarDeletedItem[];
}

export interface AnnotationSidebarBulkRestoreOutcome {
  readonly failed: readonly AnnotationSidebarDeletedItem[];
}

export interface AnnotationSidebarCommands {
  readonly bulkDelete: (
    selection: readonly AnnotationSidebarBulkSelection[],
  ) => Promise<AnnotationSidebarBulkDeleteOutcome>;
  readonly closed?: () => void;
  readonly deleteAnnotation: (
    filePath: string,
    annotationId: string,
    expectedRevision: number,
  ) => Promise<void>;
  readonly deleteInk: (
    filePath: string,
    surfaceId: string,
    expectedRevision: number,
  ) => Promise<void>;
  readonly editInk: (filePath: string, surfaceId: string) => void;
  readonly exportCurrentFile: (filePath: string, invoker: HTMLElement) => void;
  readonly exportInkPng: (filePath: string, surfaceId: string) => Promise<void>;
  readonly exportInkReport: (filePath: string) => Promise<void>;
  readonly exportInkSvg: (filePath: string, surfaceId: string) => Promise<void>;
  readonly exportVaultEntries: (
    entries: readonly AnnotationIndexEntry[],
    invoker: HTMLElement,
  ) => void;
  readonly getCurrentFilePath: () => string | null;
  readonly inspectAnnotation: (annotationId: string, invoker: HTMLElement) => void;
  readonly issue?: (error: unknown) => void;
  readonly navigateToAnnotation: (annotationId: string) => boolean;
  readonly navigateToInk: (summary: InkSurfaceSummary) => void;
  readonly navigateToVaultAnnotation: (entry: AnnotationIndexEntry) => void;
  readonly repairAnnotation?: (
    filePath: string,
    annotationId: string,
    invoker: HTMLElement,
  ) => Promise<void>;
  readonly repairInkConflict: (
    filePath: string,
    conflict: InkSurfaceConflict,
    candidatePath: string,
  ) => Promise<void>;
  readonly restoreAnnotation: (
    filePath: string,
    annotationId: string,
    expectedRevision: number,
  ) => Promise<void>;
  readonly restoreDeleted: (
    selection: readonly AnnotationSidebarDeletedItem[],
  ) => Promise<AnnotationSidebarBulkRestoreOutcome>;
  readonly restoreInk: (
    filePath: string,
    surfaceId: string,
    expectedRevision: number,
  ) => Promise<void>;
}
