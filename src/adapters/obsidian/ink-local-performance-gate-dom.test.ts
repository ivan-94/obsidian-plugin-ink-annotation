// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { waitForLocalGateEditableSurface } from './ink-local-performance-gate';

describe('local Obsidian performance Gate DOM targeting', () => {
  it('ignores the read-only Preview surface while reacquiring Edit after a lifecycle transition', async () => {
    const root = document.createElement('div');
    const preview = document.createElement('div');
    preview.className = 'inkstone-ink-surface inkstone-ink-preview-projection';
    preview.dataset.inkstoneInkPreviewProjection = 'note-a';
    const scroller = document.createElement('div');
    scroller.className = 'markdown-preview-view is-ink-mode';
    const editable = document.createElement('div');
    editable.className = 'inkstone-ink-surface';
    editable.dataset.inkstoneInkController = 'controller-2';
    scroller.append(editable);
    root.append(preview, scroller);
    document.body.append(root);

    await expect(
      waitForLocalGateEditableSurface({
        previousFilePathMatches: true,
        previousSurfaces: new Set<HTMLElement>(),
        root,
      }),
    ).resolves.toBe(editable);
  });
});
