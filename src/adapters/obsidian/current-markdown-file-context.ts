interface FileLike {
  readonly path: string;
}

interface LeafLike {
  readonly view?: {
    readonly file?: FileLike | null;
    readonly getViewType?: () => string;
  };
}

interface WorkspaceLike {
  getActiveFile(): FileLike | null;
  getLeavesOfType(viewType: string): readonly LeafLike[];
}

/** Keeps Current file bound to the last Markdown leaf when a sidebar takes workspace focus. */
export class CurrentMarkdownFileContext {
  private lastFilePath: string | null;

  constructor(private readonly workspace: WorkspaceLike) {
    this.lastFilePath = markdownPath(workspace.getActiveFile()?.path);
    if (this.lastFilePath === null) {
      this.lastFilePath =
        workspace
          .getLeavesOfType('markdown')
          .map(markdownLeafPath)
          .find((path): path is string => path !== null) ?? null;
    }
  }

  currentFilePath(): string | null {
    const activePath = markdownPath(this.workspace.getActiveFile()?.path);
    if (activePath !== null) this.lastFilePath = activePath;
    if (this.lastFilePath === null) {
      this.lastFilePath = this.firstOpenMarkdownPath();
    }
    return this.lastFilePath;
  }

  observeLeaf(leaf: LeafLike | null): void {
    const path = markdownLeafPath(leaf);
    if (path !== null) this.lastFilePath = path;
  }

  private firstOpenMarkdownPath(): string | null {
    return (
      this.workspace
        .getLeavesOfType('markdown')
        .map(markdownLeafPath)
        .find((path): path is string => path !== null) ?? null
    );
  }
}

function markdownLeafPath(leaf: LeafLike | null): string | null {
  if (leaf?.view?.getViewType?.() !== 'markdown') return null;
  return markdownPath(leaf.view.file?.path);
}

function markdownPath(path: string | undefined): string | null {
  return typeof path === 'string' && path.toLocaleLowerCase().endsWith('.md') ? path : null;
}
