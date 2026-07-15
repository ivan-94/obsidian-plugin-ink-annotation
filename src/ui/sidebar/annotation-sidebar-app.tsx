import type { AnnotationSidebarStore, SidebarScope } from '../stores/annotation-sidebar-store';
import { SidebarHeader } from './sidebar-header';
import { sidebarStatePresentation, SidebarStateView } from './sidebar-state-view';

export interface AnnotationSidebarAppProps {
  readonly onCurrentContentMount: (host: HTMLElement | null) => void;
  readonly onCurrentHeaderActionsMount: (host: HTMLElement | null) => void;
  readonly onRetryCurrent?: () => void;
  readonly onRetryVault?: () => void;
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
  onScopeChange,
  onVaultContentMount,
  onVaultHeaderActionsMount,
  store,
}: AnnotationSidebarAppProps) {
  const presentation = sidebarStatePresentation(store, {
    ...(onRetryCurrent === undefined ? {} : { current: onRetryCurrent }),
    ...(onRetryVault === undefined ? {} : { vault: onRetryVault }),
  });
  return (
    <div className="inkstone-sidebar inkstone-sidebar--preact">
      <SidebarHeader
        onCurrentHeaderActionsMount={onCurrentHeaderActionsMount}
        onScopeChange={onScopeChange}
        onVaultHeaderActionsMount={onVaultHeaderActionsMount}
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
