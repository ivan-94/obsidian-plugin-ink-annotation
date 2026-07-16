import type { ComponentChildren } from 'preact';

import type { AnnotationListItemModel } from '../models/annotation-list-item-model';
import { AnnotationSummary } from './annotation-summary';

export interface ListItemPresentation {
  readonly context: 'current' | 'vault';
  readonly filePath?: string;
  readonly fixedHeight?: number;
  readonly showSecondary?: boolean;
  readonly status: string;
}

export interface ListItemSelection {
  readonly label: string;
  readonly onToggle: () => void;
  readonly selected: boolean;
}

export function ListItemFrame({
  actions,
  disabled = false,
  model,
  onActivate,
  presentation,
  selection,
}: {
  readonly actions: ComponentChildren;
  readonly disabled?: boolean;
  readonly model: AnnotationListItemModel;
  readonly onActivate: (button: HTMLButtonElement) => void;
  readonly presentation: ListItemPresentation;
  readonly selection?: ListItemSelection;
}) {
  const selectionMode = selection !== undefined;
  const thumbnail = model.leading.kind === 'thumbnail';
  const className =
    presentation.context === 'vault'
      ? 'inkstone-vault-row'
      : thumbnail
        ? 'inkstone-sidebar-ink-row'
        : 'inkstone-sidebar-row';
  const statusAttributes =
    presentation.context === 'vault'
      ? {
          'data-inkstone-entry-status': presentation.status,
          'data-inkstone-entry-type': model.kind,
        }
      : thumbnail
        ? { 'data-inkstone-ink-status': presentation.status }
        : { 'data-inkstone-annotation-status': presentation.status };
  const actionClassName = [
    'inkstone-list-item__actions',
    presentation.context === 'vault'
      ? 'inkstone-vault-row__actions'
      : thumbnail
        ? 'inkstone-sidebar-ink-row__actions'
        : 'inkstone-sidebar-row__actions',
  ].join(' ');
  return (
    <div
      aria-selected={selectionMode ? selection.selected : undefined}
      className={`${className}${model.state.active ? ' is-active' : ''}`}
      data-inkstone-bulk-selection={
        presentation.context === 'vault' && selectionMode ? 'true' : undefined
      }
      data-inkstone-selection-mode={selectionMode ? 'true' : 'false'}
      data-note-group={presentation.context === 'vault' ? presentation.filePath : undefined}
      onClick={selectionMode ? selection.onToggle : undefined}
      onKeyDown={
        selectionMode
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              selection.onToggle();
            }
          : undefined
      }
      style={
        presentation.fixedHeight === undefined
          ? undefined
          : { height: `${presentation.fixedHeight}px` }
      }
      tabIndex={selectionMode ? 0 : undefined}
      {...statusAttributes}
    >
      <AnnotationSummary
        context={presentation.context}
        disabled={disabled}
        model={model}
        onActivate={onActivate}
        selectionMode={selectionMode}
        showSecondary={presentation.showSecondary ?? presentation.context === 'current'}
      />
      {selectionMode ? (
        <input
          aria-label={selection.label}
          checked={selection.selected}
          onClick={(event) => {
            event.stopPropagation();
            selection.onToggle();
          }}
          type="checkbox"
        />
      ) : actions === null || actions === undefined || actions === false ? null : (
        <div className={actionClassName}>{actions}</div>
      )}
    </div>
  );
}
