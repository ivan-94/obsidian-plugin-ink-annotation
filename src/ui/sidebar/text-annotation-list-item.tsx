import type { AnnotationListItemModel } from '../models/annotation-list-item-model';
import { EllipsisMenuTrigger } from '../primitives/ellipsis-menu-trigger';
import { ObsidianIcon } from '../primitives/obsidian-icon';
import { ListItemFrame } from './list-item-frame';

export function TextAnnotationListItem({
  model,
  onDelete,
  onInspect,
  onRepair,
  onRestore,
  onSelect,
  selection,
}: {
  readonly model: AnnotationListItemModel;
  readonly onDelete: () => void;
  readonly onInspect: (invoker: HTMLElement) => void;
  readonly onRepair?: (invoker: HTMLElement) => void;
  readonly onRestore: () => void;
  readonly onSelect: () => void;
  readonly selection?: { readonly onToggle: () => void; readonly selected: boolean };
}) {
  const actions = model.state.deleted ? (
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
    <TextActions
      model={model}
      onDelete={onDelete}
      onInspect={onInspect}
      {...(onRepair === undefined ? {} : { onRepair })}
    />
  );
  return (
    <ListItemFrame
      actions={actions}
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
      presentation={{
        context: 'current',
        showSecondary: true,
        status: model.state.deleted ? 'deleted' : model.state.unanchored ? 'unanchored' : 'active',
      }}
      {...(selection === undefined
        ? {}
        : {
            selection: {
              label: `Select annotation ${model.id}`,
              onToggle: selection.onToggle,
              selected: selection.selected,
            },
          })}
    />
  );
}

function TextActions({
  model,
  onDelete,
  onInspect,
  onRepair,
}: {
  readonly model: AnnotationListItemModel;
  readonly onDelete: () => void;
  readonly onInspect: (invoker: HTMLElement) => void;
  readonly onRepair?: (invoker: HTMLElement) => void;
}) {
  return (
    <EllipsisMenuTrigger
      className="inkstone-icon-button inkstone-list-item__action-trigger"
      dataAttributes={{ 'data-inkstone-annotation-actions': model.id }}
      id={`inkstone-annotation-edit-${encodeURIComponent(model.id)}`}
      items={(trigger) => [
        ...(model.state.unanchored && onRepair !== undefined
          ? [
              {
                icon: 'scan-text',
                id: 'repair',
                onSelect: () => onRepair(trigger),
                title: 'Repair target',
              },
            ]
          : []),
        {
          icon: 'square-pen',
          id: 'edit',
          onSelect: () => onInspect(trigger),
          title: 'Edit',
        },
        {
          icon: 'trash-2',
          id: 'delete',
          onSelect: onDelete,
          title: 'Delete',
          warning: true,
        },
      ]}
      label={`Open actions for ${model.title}`}
    />
  );
}
