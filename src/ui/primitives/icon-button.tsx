import { setTooltip } from 'obsidian';
import { useLayoutEffect, useRef } from 'preact/hooks';

import { ObsidianIcon } from './obsidian-icon';

export interface IconButtonProps {
  readonly busy?: boolean;
  readonly className?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly icon: string;
  readonly label: string;
  readonly onClick?: (event: MouseEvent) => void;
  readonly pressed?: boolean;
  readonly text?: string;
}

export function IconButton({
  busy = false,
  className,
  danger = false,
  disabled = false,
  icon,
  label,
  onClick,
  pressed,
  text,
}: IconButtonProps) {
  const button = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const current = button.current;
    if (current === null) return;
    setTooltip(current, label, { placement: 'top' });
  }, [label]);

  return (
    <button
      aria-busy={busy || undefined}
      aria-label={label}
      aria-pressed={pressed}
      className={[
        'inkstone-icon-button',
        danger ? 'inkstone-icon-button--danger' : '',
        className ?? '',
      ]
        .filter((value) => value.length > 0)
        .join(' ')}
      data-inkstone-icon={icon}
      disabled={disabled}
      onClick={onClick}
      ref={button}
      type="button"
    >
      <ObsidianIcon icon={icon} />
      {text === undefined ? null : <span className="inkstone-icon-button__label">{text}</span>}
    </button>
  );
}
