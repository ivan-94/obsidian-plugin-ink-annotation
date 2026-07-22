import type { AnnotationListItemModel } from '../models/annotation-list-item-model';
import { EllipsisMenuTrigger } from '../primitives/ellipsis-menu-trigger';
import { ObsidianIcon } from '../primitives/obsidian-icon';
import { ListItemFrame } from './list-item-frame';

export function InkAnnotationListItem({
  model,
  onDeleteRequest,
  onExportPng,
  onExportSvg,
  onRestore,
  onSelect,
  selection,
}: {
  readonly model: AnnotationListItemModel;
  readonly onDeleteRequest: () => void;
  readonly onExportPng: () => void;
  readonly onExportSvg: () => void;
  readonly onRestore: () => void;
  readonly onSelect: () => void;
  readonly selection?: { readonly onToggle: () => void; readonly selected: boolean };
}) {
  const actions = model.state.deleted ? (
    <button
      className="inkstone-icon-button"
      data-inkstone-ink-restore={model.id}
      onClick={onRestore}
      type="button"
    >
      <ObsidianIcon icon="rotate-ccw" />
      <span className="inkstone-icon-button__label">Restore</span>
    </button>
  ) : (
    <InkActions
      model={model}
      onDeleteRequest={onDeleteRequest}
      onExportPng={onExportPng}
      onExportSvg={onExportSvg}
    />
  );
  const status = model.state.deleted
    ? 'deleted'
    : model.tone === 'warning'
      ? 'needs-rebase'
      : 'active';
  return (
    <ListItemFrame
      actions={actions}
      disabled={model.state.deleted}
      model={model}
      onActivate={() => onSelect()}
      presentation={{ context: 'current', status }}
      {...(selection === undefined
        ? {}
        : {
            selection: {
              label: `Select Legacy Ink ${model.id}`,
              onToggle: selection.onToggle,
              selected: selection.selected,
            },
          })}
    />
  );
}

function InkActions({
  model,
  onDeleteRequest,
  onExportPng,
  onExportSvg,
}: {
  readonly model: AnnotationListItemModel;
  readonly onDeleteRequest: () => void;
  readonly onExportPng: () => void;
  readonly onExportSvg: () => void;
}) {
  return (
    <EllipsisMenuTrigger
      className="inkstone-icon-button inkstone-list-item__action-trigger"
      dataAttributes={{ 'data-inkstone-ink-actions': model.id }}
      items={[
        { icon: 'file-code-2', id: 'export-svg', onSelect: onExportSvg, title: 'Export SVG' },
        { icon: 'image-down', id: 'export-png', onSelect: onExportPng, title: 'Export PNG' },
        {
          icon: 'trash-2',
          id: 'delete',
          onSelect: onDeleteRequest,
          title: 'Delete Legacy Ink surface…',
          warning: true,
        },
      ]}
      label={`Open Legacy Ink actions for ${model.title}`}
    />
  );
}
