import { useRef, useState } from 'preact/hooks';

import type { AnnotationListItemModel } from '../models/annotation-list-item-model';
import { ObsidianIcon } from '../primitives/obsidian-icon';
import { AnnotationSummary } from './annotation-summary';
import { ListItemFrame } from './list-item-frame';
import { useDismissibleMenu } from './use-dismissible-menu';

export function InkAnnotationListItem({
  document,
  model,
  onDelete,
  onEdit,
  onExportPng,
  onExportSvg,
  onRestore,
  onSelect,
  selection,
}: {
  readonly document: Document;
  readonly model: AnnotationListItemModel;
  readonly onDelete: () => void;
  readonly onEdit: () => void;
  readonly onExportPng: () => void;
  readonly onExportSvg: () => void;
  readonly onRestore: () => void;
  readonly onSelect: () => void;
  readonly selection?: { readonly onToggle: () => void; readonly selected: boolean };
}) {
  const actions =
    selection === undefined ? (
      model.state.deleted ? (
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
          document={document}
          model={model}
          onDelete={onDelete}
          onEdit={onEdit}
          onExportPng={onExportPng}
          onExportSvg={onExportSvg}
        />
      )
    ) : (
      <input
        aria-label={`Select Ink ${model.id}`}
        checked={selection.selected}
        onClick={(event) => {
          event.stopPropagation();
          selection.onToggle();
        }}
        type="checkbox"
      />
    );
  const status = model.state.deleted
    ? 'deleted'
    : model.tone === 'warning'
      ? 'needs-rebase'
      : 'active';
  return (
    <ListItemFrame
      actions={<div className="inkstone-sidebar-ink-row__actions">{actions}</div>}
      className="inkstone-sidebar-ink-row"
      status={status}
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
        onActivate={() => onSelect()}
        selectionMode={selection !== undefined}
      />
    </ListItemFrame>
  );
}

function InkActions({
  document,
  model,
  onDelete,
  onEdit,
  onExportPng,
  onExportSvg,
}: {
  readonly document: Document;
  readonly model: AnnotationListItemModel;
  readonly onDelete: () => void;
  readonly onEdit: () => void;
  readonly onExportPng: () => void;
  readonly onExportSvg: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const dismissible = useDismissibleMenu(document);
  const menuId = `inkstone-ink-actions-${encodeURIComponent(model.id)}`;
  const act = (action: () => void): void => {
    dismissible.controller.current?.close();
    action();
  };
  return (
    <>
      <button
        aria-controls={menuId}
        aria-expanded="false"
        aria-haspopup="menu"
        aria-label={`Open Ink actions for ${model.title}`}
        className="inkstone-icon-button"
        data-inkstone-ink-actions={model.id}
        onClick={() => {
          if (dismissible.controller.current?.toggle() === true) {
            armedRef.current = false;
            setArmed(false);
            const remove = dismissible.menu.current?.querySelector<HTMLButtonElement>(
              '[data-inkstone-ink-delete]',
            );
            remove?.classList.remove('is-armed');
            remove?.setAttribute('aria-label', 'Delete Ink surface');
            const label = remove?.querySelector('.inkstone-icon-button__label');
            if (label !== null && label !== undefined) label.textContent = 'Delete';
            dismissible.menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
          }
        }}
        ref={dismissible.trigger}
        type="button"
      >
        <ObsidianIcon icon="ellipsis" />
      </button>
      <div
        className="inkstone-sidebar-ink-row__menu"
        data-inkstone-ink-menu={model.id}
        hidden
        id={menuId}
        ref={dismissible.menu}
        role="menu"
      >
        <InkMenuButton
          dataInkEdit={model.id}
          icon="pen-line"
          label="Edit Ink"
          onClick={() => act(onEdit)}
          text="Edit"
        />
        <InkMenuButton
          icon="file-code-2"
          label="Export Ink as SVG"
          onClick={() => act(onExportSvg)}
          text="Export SVG"
        />
        <InkMenuButton
          icon="image-down"
          label="Export Ink as PNG"
          onClick={() => act(onExportPng)}
          text="Export PNG"
        />
        <button
          aria-label={armed ? 'Confirm delete Ink surface' : 'Delete Ink surface'}
          className={`inkstone-icon-button inkstone-icon-button--danger${armed ? ' is-armed' : ''}`}
          data-inkstone-ink-delete={model.id}
          onClick={(event) => {
            if (!armedRef.current) {
              armedRef.current = true;
              setArmed(true);
              event.currentTarget.classList.add('is-armed');
              event.currentTarget.setAttribute('aria-label', 'Confirm delete Ink surface');
              const label = event.currentTarget.querySelector('.inkstone-icon-button__label');
              if (label !== null) label.textContent = 'Confirm delete';
              return;
            }
            act(onDelete);
          }}
          role="menuitem"
          type="button"
        >
          <ObsidianIcon icon="trash-2" />
          <span className="inkstone-icon-button__label">{armed ? 'Confirm delete' : 'Delete'}</span>
        </button>
      </div>
    </>
  );
}

function InkMenuButton({
  dataInkEdit,
  icon,
  label,
  onClick,
  text,
}: {
  readonly dataInkEdit?: string;
  readonly icon: string;
  readonly label: string;
  readonly onClick: () => void;
  readonly text: string;
}) {
  return (
    <button
      aria-label={label}
      className="inkstone-icon-button"
      data-inkstone-ink-edit={dataInkEdit}
      onClick={onClick}
      role="menuitem"
      type="button"
    >
      <ObsidianIcon icon={icon} />
      <span className="inkstone-icon-button__label">{text}</span>
    </button>
  );
}
