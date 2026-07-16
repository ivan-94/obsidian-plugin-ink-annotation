import type { JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

import { type ActionMenuHandle, type ActionMenuItem, showActionMenu } from './action-menu';
import { ObsidianIcon } from './obsidian-icon';

export function EllipsisMenuTrigger({
  className = 'inkstone-icon-button',
  dataAttributes,
  disabled = false,
  id,
  items,
  label,
}: {
  readonly className?: string;
  readonly dataAttributes?: Readonly<Record<string, string>>;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly items:
    readonly ActionMenuItem[] | ((trigger: HTMLButtonElement) => readonly ActionMenuItem[]);
  readonly label: string;
}) {
  const activeMenu = useRef<ActionMenuHandle | null>(null);
  useLayoutEffect(
    () => () => {
      activeMenu.current?.close();
      activeMenu.current = null;
    },
    [],
  );
  const open = (event: JSX.TargetedMouseEvent<HTMLButtonElement>): void => {
    const trigger = event.currentTarget;
    activeMenu.current?.close();
    trigger.setAttribute('aria-expanded', 'true');
    activeMenu.current = showActionMenu({
      anchor: { element: trigger, kind: 'element' },
      items: typeof items === 'function' ? items(trigger) : items,
      onHide: () => {
        trigger.setAttribute('aria-expanded', 'false');
        activeMenu.current = null;
        if (trigger.ownerDocument.activeElement === trigger.ownerDocument.body) {
          trigger.focus({ preventScroll: true });
        }
      },
    });
  };
  return (
    <button
      aria-expanded="false"
      aria-haspopup="menu"
      aria-label={label}
      className={className}
      disabled={disabled}
      onClick={open}
      type="button"
      {...(id === undefined ? {} : { id })}
      {...dataAttributes}
    >
      <ObsidianIcon icon="ellipsis" />
    </button>
  );
}
