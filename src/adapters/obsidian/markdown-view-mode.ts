export interface MarkdownViewModeReader {
  readonly file?: { readonly path: string } | null;
  readonly getMode?: () => string;
}

/** Annotation interaction surfaces exist only in Obsidian Reading View. */
export function isAnnotationReadingView(view: MarkdownViewModeReader): boolean {
  return typeof view.getMode !== 'function' || view.getMode() === 'preview';
}

export function shouldRefreshAnnotationSurfacesForModify(
  filePath: string,
  activeView: MarkdownViewModeReader | null,
): boolean {
  return (
    activeView !== null && activeView.file?.path === filePath && isAnnotationReadingView(activeView)
  );
}
