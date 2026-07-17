import { useLayoutEffect } from 'preact/hooks';

import type { AnnotationSidebarStore, SidebarScope } from '../stores/annotation-sidebar-store';
import { ObsidianIcon } from '../primitives/obsidian-icon';
import { SidebarHeader } from './sidebar-header';
import { sidebarStatePresentation, SidebarStateView } from './sidebar-state-view';

export interface AnnotationSidebarAppProps {
  readonly onCurrentContentMount: (host: HTMLElement | null) => void;
  readonly onCurrentHeaderActionsMount: (host: HTMLElement | null) => void;
  readonly onRetryCurrent?: () => void;
  readonly onRetryVault?: () => void;
  readonly onRestoreRecentDeletion?: () => void;
  readonly onScopeChange: (scope: SidebarScope) => void;
  readonly onVaultContentMount: (host: HTMLElement | null) => void;
  readonly onVaultHeaderActionsMount: (host: HTMLElement | null) => void;
  readonly store: AnnotationSidebarStore;
}

export function AnnotationSidebarApp({
  onCurrentContentMount,
  onCurrentHeaderActionsMount,
  onRetryCurrent,
  onRetryVault,
  onRestoreRecentDeletion,
  onScopeChange,
  onVaultContentMount,
  onVaultHeaderActionsMount,
  store,
}: AnnotationSidebarAppProps) {
  const presentation = sidebarStatePresentation(store, {
    ...(onRetryCurrent === undefined ? {} : { current: onRetryCurrent }),
    ...(onRetryVault === undefined ? {} : { vault: onRetryVault }),
  });
  const recentDeletion = store.recentDeletion.value;
  const hasRecentDeletion =
    recentDeletion !== null && (recentDeletion.pending || recentDeletion.expiresAt > Date.now());
  return (
    <div
      className={`inkstone-sidebar inkstone-sidebar--preact${hasRecentDeletion ? ' inkstone-sidebar--has-recent-deletion' : ''}`}
    >
      <SidebarHeader
        onCurrentHeaderActionsMount={onCurrentHeaderActionsMount}
        onScopeChange={onScopeChange}
        onVaultHeaderActionsMount={onVaultHeaderActionsMount}
        store={store}
      />
      <RecentDeletionBanner
        onRestore={onRestoreRecentDeletion ?? (() => undefined)}
        store={store}
      />
      <SidebarStateView presentation={presentation} />
      <div data-inkstone-sidebar-content hidden={presentation.kind !== 'content'}>
        <div
          data-inkstone-sidebar-scope-content="current-file"
          hidden={store.scope.value !== 'current-file'}
          ref={onCurrentContentMount}
        />
        <div
          data-inkstone-sidebar-scope-content="entire-vault"
          hidden={store.scope.value !== 'entire-vault'}
          ref={onVaultContentMount}
        />
      </div>
    </div>
  );
}

function RecentDeletionBanner({
  onRestore,
  store,
}: {
  readonly onRestore: () => void;
  readonly store: AnnotationSidebarStore;
}) {
  const receipt = store.recentDeletion.value;
  const expiresAt = receipt?.expiresAt ?? null;
  const error = receipt?.error ?? null;
  const pending = receipt?.pending ?? false;
  useLayoutEffect(() => {
    if (expiresAt === null || pending) return;
    const timer = setTimeout(
      () => {
        const current = store.recentDeletion.value;
        if (current !== null && current.expiresAt === expiresAt && !current.pending) {
          store.recentDeletion.value = null;
        }
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [error, expiresAt, pending, store]);
  if (receipt === null || (!receipt.pending && receipt.expiresAt <= Date.now())) {
    return null;
  }
  return (
    <div
      aria-live="polite"
      className="inkstone-sidebar__recent-deletion"
      data-inkstone-recent-deletion
      role="status"
    >
      <ObsidianIcon icon="trash-2" />
      <span className="inkstone-sidebar__recent-deletion-message">
        {receipt.count} {receipt.count === 1 ? 'annotation' : 'annotations'} deleted
      </span>
      {receipt.error === null ? null : (
        <span
          className="inkstone-sidebar__recent-deletion-error"
          data-inkstone-recent-deletion-error
          role="alert"
        >
          {receipt.error}
        </span>
      )}
      <button
        aria-label="Restore deleted annotations"
        className="inkstone-sidebar__recent-deletion-restore"
        disabled={receipt.pending}
        onClick={onRestore}
        type="button"
      >
        {receipt.pending ? 'Restoring…' : 'Restore'}
      </button>
    </div>
  );
}
