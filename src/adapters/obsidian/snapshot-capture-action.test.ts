// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  ensureSnapshotCaptureAction,
  ensureSnapshotCaptureActions,
} from './snapshot-capture-action';

describe('Snapshot capture Reading View action', () => {
  it('is idempotent when Obsidian mounts view actions outside contentEl', () => {
    document.body.replaceChildren();
    const contentEl = document.createElement('div');
    const viewActions = document.createElement('div');
    document.body.append(contentEl, viewActions);
    const addAction = vi.fn((_icon: string, _label: string, callback: () => void) => {
      const action = document.createElement('button');
      action.addEventListener('click', callback);
      viewActions.append(action);
      return action;
    });
    const view = { addAction, contentEl };
    const actions = new Map<typeof view, HTMLElement>();

    const first = ensureSnapshotCaptureAction({
      actionLabel: '截取并标注',
      actions,
      onActivate: vi.fn(),
      view,
    });
    const second = ensureSnapshotCaptureAction({
      actionLabel: '截取并标注',
      actions,
      onActivate: vi.fn(),
      view,
    });

    expect(first).toBe(second);
    expect(addAction).toHaveBeenCalledWith('camera', '截取并标注', expect.any(Function));
    expect(first.getAttribute('aria-label')).toBe('截取并标注');
    expect(viewActions.querySelectorAll('[data-inkstone-snapshot-action]')).toHaveLength(1);
    expect(contentEl.querySelector('[data-inkstone-snapshot-action]')).toBeNull();
  });

  it('installs actions for every Markdown leaf even when a sidebar leaf owns focus', () => {
    document.body.replaceChildren();
    const actions = new Map<ReturnType<typeof createView>, HTMLElement>();
    const first = createView();
    const second = createView();

    ensureSnapshotCaptureActions({
      actionLabel: 'Capture & annotate',
      actions,
      onActivate: vi.fn(),
      views: [first, second],
    });
    ensureSnapshotCaptureActions({
      actionLabel: 'Capture & annotate',
      actions,
      onActivate: vi.fn(),
      views: [first, second],
    });

    expect(first.addAction).toHaveBeenCalledOnce();
    expect(second.addAction).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('[data-inkstone-snapshot-action]')).toHaveLength(2);
  });
});

function createView() {
  const header = document.createElement('div');
  document.body.append(header);
  return {
    addAction: vi.fn((_icon: string, _label: string, callback: () => void) => {
      const action = document.createElement('button');
      action.addEventListener('click', callback);
      header.append(action);
      return action;
    }),
  };
}
