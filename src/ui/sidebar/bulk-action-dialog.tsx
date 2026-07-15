import type { ComponentChildren } from 'preact';

import { ObsidianIcon } from '../primitives/obsidian-icon';

export function BulkActionDialog({
  ariaLabel,
  children,
  confirmAriaLabel,
  confirmLabel,
  danger = false,
  description,
  feedback,
  icon,
  onCancel,
  onConfirm,
  pending,
  title,
}: {
  readonly ariaLabel: string;
  readonly children?: ComponentChildren;
  readonly confirmAriaLabel: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly description?: string | undefined;
  readonly feedback: string | null;
  readonly icon: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly pending: boolean;
  readonly title: string;
}) {
  return (
    <div aria-label={ariaLabel} className="inkstone-bulk-dialog" role="dialog">
      <header className="inkstone-bulk-dialog__header">
        <ObsidianIcon className="inkstone-bulk-dialog__icon" icon={icon} />
        <div>
          <h3 className="inkstone-bulk-dialog__title">{title}</h3>
          {description === undefined ? null : (
            <p className="inkstone-bulk-dialog__description">{description}</p>
          )}
        </div>
      </header>
      {children === undefined ? null : (
        <div className="inkstone-bulk-dialog__field">{children}</div>
      )}
      {feedback === null ? null : (
        <p className="inkstone-bulk-dialog__feedback" role="alert">
          {feedback}
        </p>
      )}
      <footer className="inkstone-bulk-dialog__actions">
        <button disabled={pending} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          aria-label={confirmAriaLabel}
          className={danger ? 'inkstone-bulk-dialog__confirm--danger' : undefined}
          disabled={pending}
          onClick={onConfirm}
          type="button"
        >
          {confirmLabel}
        </button>
      </footer>
    </div>
  );
}
