import type { AnnotationSidebarStore, SidebarScope } from '../stores/annotation-sidebar-store';

export function ScopeSwitcher({
  onScopeChange,
  store,
}: {
  readonly onScopeChange: (scope: SidebarScope) => void;
  readonly store: AnnotationSidebarStore;
}) {
  const activeScope = store.scope.value;
  const select = (scope: SidebarScope): void => {
    if (scope === store.scope.peek()) return;
    store.setScope(scope);
    onScopeChange(scope);
  };
  return (
    <div aria-label="Annotation scope" className="inkstone-sidebar__scope" role="tablist">
      <button
        aria-pressed={activeScope === 'current-file'}
        aria-selected={activeScope === 'current-file'}
        onClick={() => select('current-file')}
        role="tab"
        type="button"
      >
        Current file
      </button>
      <button
        aria-pressed={activeScope === 'entire-vault'}
        aria-selected={activeScope === 'entire-vault'}
        onClick={() => select('entire-vault')}
        role="tab"
        type="button"
      >
        Entire Vault
      </button>
    </div>
  );
}
