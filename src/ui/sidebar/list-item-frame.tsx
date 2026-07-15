import type { ComponentChildren } from 'preact';

export function ListItemFrame({
  active = false,
  actions,
  children,
  className = 'inkstone-sidebar-row',
  onSelectionToggle,
  selected = false,
  selectionMode = false,
  status,
}: {
  readonly active?: boolean;
  readonly actions: ComponentChildren;
  readonly children: ComponentChildren;
  readonly className?: string;
  readonly onSelectionToggle?: () => void;
  readonly selected?: boolean;
  readonly selectionMode?: boolean;
  readonly status: string;
}) {
  const statusAttribute = className.includes('ink-row')
    ? { 'data-inkstone-ink-status': status }
    : { 'data-inkstone-annotation-status': status };
  return (
    <div
      aria-selected={selectionMode ? selected : undefined}
      className={`${className}${active ? ' is-active' : ''}`}
      data-inkstone-selection-mode={selectionMode ? 'true' : 'false'}
      onClick={selectionMode ? onSelectionToggle : undefined}
      onKeyDown={
        selectionMode
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onSelectionToggle?.();
            }
          : undefined
      }
      tabIndex={selectionMode ? 0 : undefined}
      {...statusAttribute}
    >
      {children}
      {actions}
    </div>
  );
}
