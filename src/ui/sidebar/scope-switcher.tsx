import type { AnnotationSidebarStore, SidebarScope } from '../stores/annotation-sidebar-store';
import { ObsidianIcon } from '../primitives/obsidian-icon';

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
        aria-label="Current file"
        aria-pressed={activeScope === 'current-file'}
        aria-selected={activeScope === 'current-file'}
        onClick={() => select('current-file')}
        role="tab"
        type="button"
      >
        <ObsidianIcon className="inkstone-sidebar__scope-icon" icon="file-text" />
        <span className="inkstone-sidebar__scope-label">Current file</span>
      </button>
      <button
        aria-label="Entire Vault"
        aria-pressed={activeScope === 'entire-vault'}
        aria-selected={activeScope === 'entire-vault'}
        onClick={() => select('entire-vault')}
        role="tab"
        type="button"
      >
        <ObsidianIcon className="inkstone-sidebar__scope-icon" icon="library" />
        <span className="inkstone-sidebar__scope-label">Entire Vault</span>
      </button>
    </div>
  );
}
