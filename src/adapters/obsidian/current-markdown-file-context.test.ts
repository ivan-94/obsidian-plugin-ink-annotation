import { describe, expect, it } from 'vitest';

import { CurrentMarkdownFileContext } from './current-markdown-file-context';

describe('Current Markdown file context', () => {
  it('seeds from the open Markdown leaf when the sidebar owns focus', () => {
    const context = new CurrentMarkdownFileContext({
      getActiveFile: () => null,
      getLeavesOfType: () => [markdownLeaf('Snapshot HAT Supported.md')],
    });

    expect(context.currentFilePath()).toBe('Snapshot HAT Supported.md');
  });

  it('remembers the last active Markdown leaf while a sidebar leaf owns focus', () => {
    const context = new CurrentMarkdownFileContext({
      getActiveFile: () => null,
      getLeavesOfType: () => [markdownLeaf('First.md')],
    });

    context.observeLeaf(markdownLeaf('Second.md'));
    context.observeLeaf({ view: { getViewType: () => 'inkstone-annotation-sidebar' } });

    expect(context.currentFilePath()).toBe('Second.md');
  });

  it('discovers a Markdown leaf that mounts after plugin construction', () => {
    let leaves: ReturnType<typeof markdownLeaf>[] = [];
    const context = new CurrentMarkdownFileContext({
      getActiveFile: () => null,
      getLeavesOfType: () => leaves,
    });
    leaves = [markdownLeaf('Mounted Later.md')];

    expect(context.currentFilePath()).toBe('Mounted Later.md');
  });
});

function markdownLeaf(path: string) {
  return {
    view: {
      file: { path },
      getViewType: () => 'markdown',
    },
  };
}
