import type { AnnotationListItemModel } from '../models/annotation-list-item-model';
import { ObsidianIcon } from '../primitives/obsidian-icon';
import { AnnotationSummary } from './annotation-summary';
import { ListItemFrame } from './list-item-frame';
import { useDismissibleMenu } from './use-dismissible-menu';

export function TextAnnotationListItem({
  document,
  model,
  onDelete,
  onInspect,
  onRestore,
  onSelect,
  selection,
}: {
  readonly document: Document;
  readonly model: AnnotationListItemModel;
  readonly onDelete: () => void;
  readonly onInspect: (invoker: HTMLElement) => void;
  readonly onRestore: () => void;
  readonly onSelect: () => void;
  readonly selection?: { readonly onToggle: () => void; readonly selected: boolean };
}) {
  const actions =
    selection === undefined ? (
      model.state.deleted ? (
        <button
          className="inkstone-icon-button"
          data-inkstone-annotation-restore={model.id}
          onClick={onRestore}
          type="button"
        >
          <ObsidianIcon icon="rotate-ccw" />
          <span className="inkstone-icon-button__label">Restore</span>
        </button>
      ) : (
        <TextActions document={document} model={model} onDelete={onDelete} onInspect={onInspect} />
      )
    ) : (
      <input
        aria-label={`Select annotation ${model.id}`}
        checked={selection.selected}
        onClick={(event) => {
          event.stopPropagation();
          selection.onToggle();
        }}
        type="checkbox"
      />
    );
  return (
    <ListItemFrame
      active={model.state.active}
      actions={<div className="inkstone-sidebar-row__actions">{actions}</div>}
      status={model.state.deleted ? 'deleted' : model.state.unanchored ? 'unanchored' : 'active'}
      {...(selection === undefined
        ? {}
        : {
            onSelectionToggle: selection.onToggle,
            selected: selection.selected,
            selectionMode: true,
          })}
    >
      <AnnotationSummary
        disabled={model.state.deleted}
        model={model}
        onActivate={(button) => {
          const root = button.closest('.inkstone-sidebar');
          for (const candidate of root?.querySelectorAll<HTMLElement>(
            '[data-inkstone-annotation-row]',
          ) ?? []) {
            const active = candidate.dataset.annotationId === model.id;
            candidate.closest('.inkstone-sidebar-row')?.classList.toggle('is-active', active);
            if (active) candidate.setAttribute('aria-current', 'true');
            else candidate.removeAttribute('aria-current');
          }
          onSelect();
        }}
        selectionMode={selection !== undefined}
      />
    </ListItemFrame>
  );
}

function TextActions({
  document,
  model,
  onDelete,
  onInspect,
}: {
  readonly document: Document;
  readonly model: AnnotationListItemModel;
  readonly onDelete: () => void;
  readonly onInspect: (invoker: HTMLElement) => void;
}) {
  const dismissible = useDismissibleMenu(document);
  const menuId = `inkstone-annotation-menu-${encodeURIComponent(model.id)}`;
  const close = (): void => dismissible.controller.current?.close();
  return (
    <>
      <button
        aria-controls={menuId}
        aria-expanded="false"
        aria-haspopup="menu"
        aria-label={`Open actions for ${model.title}`}
        className="inkstone-icon-button"
        data-inkstone-annotation-actions={model.id}
        id={`inkstone-annotation-edit-${encodeURIComponent(model.id)}`}
        onClick={() => {
          if (dismissible.controller.current?.toggle() === true) {
            dismissible.menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
          }
        }}
        ref={dismissible.trigger}
        type="button"
      >
        <ObsidianIcon icon="ellipsis" />
      </button>
      <div
        className="inkstone-sidebar-row__menu"
        data-inkstone-annotation-menu={model.id}
        hidden
        id={menuId}
        ref={dismissible.menu}
        role="menu"
      >
        <button
          aria-label="Edit annotation"
          className="inkstone-icon-button"
          onClick={() => {
            close();
            if (dismissible.trigger.current !== null) onInspect(dismissible.trigger.current);
          }}
          role="menuitem"
          type="button"
        >
          <ObsidianIcon icon="square-pen" />
          <span className="inkstone-icon-button__label">Edit</span>
        </button>
        <button
          aria-label="Delete annotation"
          className="inkstone-icon-button inkstone-icon-button--danger"
          onClick={() => {
            close();
            onDelete();
          }}
          role="menuitem"
          type="button"
        >
          <ObsidianIcon icon="trash-2" />
          <span className="inkstone-icon-button__label">Delete</span>
        </button>
      </div>
    </>
  );
}
