import { setIcon } from 'obsidian';
import { useLayoutEffect, useRef } from 'preact/hooks';

export function ObsidianIcon({
  className,
  icon,
  styleId,
}: {
  readonly className?: string;
  readonly icon: string;
  readonly styleId?: string;
}) {
  const element = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const current = element.current;
    if (current === null) return;
    current.replaceChildren();
    setIcon(current, icon);
  }, [icon]);

  return (
    <span
      aria-hidden="true"
      className={className ?? 'inkstone-icon-button__icon'}
      data-inkstone-icon={icon}
      data-inkstone-style-id={styleId}
      ref={element}
    />
  );
}
