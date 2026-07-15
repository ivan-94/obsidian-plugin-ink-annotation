import type { AnnotationSidebarStore, SidebarScope } from '../stores/annotation-sidebar-store';
import { ScopeSwitcher } from './scope-switcher';

export function SidebarHeader({
  onCurrentHeaderActionsMount,
  onScopeChange,
  onVaultHeaderActionsMount,
  store,
}: {
  readonly onCurrentHeaderActionsMount: (host: HTMLElement | null) => void;
  readonly onScopeChange: (scope: SidebarScope) => void;
  readonly onVaultHeaderActionsMount: (host: HTMLElement | null) => void;
  readonly store: AnnotationSidebarStore;
}) {
  return (
    <header className="inkstone-sidebar__header">
      <ScopeSwitcher onScopeChange={onScopeChange} store={store} />
      <div
        data-inkstone-sidebar-header-actions="current-file"
        hidden={store.scope.value !== 'current-file'}
        ref={onCurrentHeaderActionsMount}
      />
      <div
        data-inkstone-sidebar-header-actions="entire-vault"
        hidden={store.scope.value !== 'entire-vault'}
        ref={onVaultHeaderActionsMount}
      />
    </header>
  );
}
