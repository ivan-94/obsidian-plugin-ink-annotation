import { ObsidianIcon } from '../primitives/obsidian-icon';

export function SelectionModeHeaderActions({
  onDeselectAll,
  onDone,
  onSelectAll,
  selectedCount,
  totalCount,
}: {
  readonly onDeselectAll: () => void;
  readonly onDone: () => void;
  readonly onSelectAll: () => void;
  readonly selectedCount: number;
  readonly totalCount: number;
}) {
  return (
    <div className="inkstone-sidebar__header-actions" data-inkstone-selection-header="">
      <span aria-live="polite" className="inkstone-visually-hidden">
        {selectedCount} selected
      </span>
      <button
        aria-label="Select all annotations"
        className="inkstone-icon-button"
        disabled={totalCount === 0 || selectedCount === totalCount}
        onClick={onSelectAll}
        title="Select all"
        type="button"
      >
        <ObsidianIcon icon="check-check" />
      </button>
      <button
        aria-label="Deselect all annotations"
        className="inkstone-icon-button"
        disabled={selectedCount === 0}
        onClick={onDeselectAll}
        title="Deselect all"
        type="button"
      >
        <ObsidianIcon icon="list-x" />
      </button>
      <button
        aria-label="Done selecting"
        className="inkstone-icon-button"
        onClick={onDone}
        title="Done"
        type="button"
      >
        <ObsidianIcon icon="check" />
      </button>
    </div>
  );
}
