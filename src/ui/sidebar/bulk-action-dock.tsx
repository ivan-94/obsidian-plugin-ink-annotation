import { ObsidianIcon } from '../primitives/obsidian-icon';

export function BulkActionDock({
  copyFeedback,
  hasInk,
  onCopy,
  onDelete,
  onExport,
  onStyle,
  onTags,
  selectedCount,
}: {
  readonly copyFeedback: string | null;
  readonly hasInk: boolean;
  readonly onCopy: () => void;
  readonly onDelete: () => void;
  readonly onExport: (invoker: HTMLButtonElement) => void;
  readonly onStyle: () => void;
  readonly onTags: () => void;
  readonly selectedCount: number;
}) {
  const empty = selectedCount === 0;
  const copyPending = copyFeedback === 'Copying…';
  const copySucceeded = copyFeedback === 'Copied';
  const copyLabel = copyFeedback ?? 'Copy selected';
  const copyIcon =
    copyFeedback === null
      ? 'copy'
      : copyPending
        ? 'loader-circle'
        : copySucceeded
          ? 'check'
          : 'triangle-alert';
  return (
    <div className="inkstone-bulk-action-dock-host">
      <div
        aria-label="Selected annotation actions"
        className="inkstone-bulk-action-dock"
        role="toolbar"
      >
        <span className="inkstone-bulk-action-dock__count">{selectedCount} selected</span>
        <button
          aria-label="Tag selected"
          className="inkstone-icon-button"
          disabled={empty || hasInk}
          onClick={onTags}
          title={hasInk ? 'Tags are available for text annotations only.' : 'Add tags'}
          type="button"
        >
          <ObsidianIcon icon="tag" />
        </button>
        <button
          aria-label="Style selected"
          className="inkstone-icon-button"
          disabled={empty || hasInk}
          onClick={onStyle}
          title={hasInk ? 'Styles are available for text annotations only.' : 'Change style'}
          type="button"
        >
          <ObsidianIcon icon="scan-text" />
        </button>
        <button
          aria-label={copyLabel}
          className="inkstone-icon-button"
          disabled={empty || copyPending}
          onClick={onCopy}
          title={copyFeedback === null ? 'Copy' : copyLabel}
          type="button"
        >
          <ObsidianIcon icon={copyIcon} />
        </button>
        <button
          aria-label="Export selected"
          className="inkstone-icon-button"
          disabled={empty}
          onClick={(event) => onExport(event.currentTarget)}
          title="Export"
          type="button"
        >
          <ObsidianIcon icon="share" />
        </button>
        <span aria-hidden="true" className="inkstone-bulk-action-dock__divider" />
        <button
          aria-label="Delete selected"
          className="inkstone-icon-button inkstone-icon-button--danger"
          disabled={empty}
          onClick={onDelete}
          title="Delete"
          type="button"
        >
          <ObsidianIcon icon="trash-2" />
        </button>
      </div>
      {copyFeedback === null ? null : (
        <span
          className="inkstone-bulk-action-dock__feedback"
          data-tone={copyPending ? 'pending' : copySucceeded ? 'success' : 'error'}
          role="status"
        >
          {copyLabel}
        </span>
      )}
    </div>
  );
}
