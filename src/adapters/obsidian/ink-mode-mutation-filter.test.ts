// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { shouldReconcileInkMutations } from './ink-mode-mutation-filter';

describe('Ink Mode mutation filter', () => {
  it('ignores mutations produced inside the plugin-owned Ink surface', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const mutations = observeNextMutation(root);
    const surface = document.createElement('div');
    surface.className = 'inkstone-ink-surface';

    root.append(surface);

    expect(shouldReconcileInkMutations(await mutations)).toBe(false);
  });

  it('still reconciles external Reading View content changes', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const mutations = observeNextMutation(root);

    root.append(document.createElement('p'));

    expect(shouldReconcileInkMutations(await mutations)).toBe(true);
  });
});

function observeNextMutation(root: HTMLElement): Promise<readonly MutationRecord[]> {
  return new Promise((resolve) => {
    const observer = new MutationObserver((mutations) => {
      observer.disconnect();
      resolve(mutations);
    });
    observer.observe(root, { childList: true, subtree: true });
  });
}
