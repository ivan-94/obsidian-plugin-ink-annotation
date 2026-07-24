export interface SnapshotCaptureActionView {
  addAction(icon: string, label: string, callback: () => void): HTMLElement;
}

/**
 * Keeps one host-owned capture action per Reading View. Obsidian mounts actions beside, not inside,
 * `MarkdownView.contentEl`, so DOM lookup under the reading content cannot provide idempotency.
 */
export function ensureSnapshotCaptureAction<View extends SnapshotCaptureActionView>(input: {
  readonly actionLabel: string;
  readonly actions: Map<View, HTMLElement>;
  readonly onActivate: (action: HTMLElement) => void;
  readonly view: View;
}): HTMLElement {
  const installed = input.actions.get(input.view);
  if (installed?.isConnected === true) return installed;
  installed?.remove();

  const action = input.view.addAction('camera', input.actionLabel, () => {
    const current = input.actions.get(input.view);
    if (current !== undefined) input.onActivate(current);
  });
  action.dataset.inkstoneSnapshotAction = '';
  action.setAttribute('aria-label', input.actionLabel);
  input.actions.set(input.view, action);
  return action;
}

export function ensureSnapshotCaptureActions<View extends SnapshotCaptureActionView>(input: {
  readonly actionLabel: string;
  readonly actions: Map<View, HTMLElement>;
  readonly onActivate: (action: HTMLElement) => void;
  readonly views: Iterable<View>;
}): readonly HTMLElement[] {
  return [...input.views].map((view) =>
    ensureSnapshotCaptureAction({
      actionLabel: input.actionLabel,
      actions: input.actions,
      onActivate: input.onActivate,
      view,
    }),
  );
}

export function disposeSnapshotCaptureActions<View>(actions: Map<View, HTMLElement>): void {
  for (const action of actions.values()) action.remove();
  actions.clear();
}
