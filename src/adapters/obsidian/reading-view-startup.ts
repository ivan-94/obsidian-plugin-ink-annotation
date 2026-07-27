export interface OpenMarkdownView {
  readonly mode: string;
  readonly rerender: (full: boolean) => void;
}

export function refreshAlreadyOpenReadingViews(views: readonly OpenMarkdownView[]): void {
  for (const view of views) {
    if (view.mode === 'preview') {
      view.rerender(true);
    }
  }
}
