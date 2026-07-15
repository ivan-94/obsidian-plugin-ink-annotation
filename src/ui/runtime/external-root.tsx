import { render, type ComponentChildren } from 'preact';
import { useLayoutEffect } from 'preact/hooks';

export function ExternalRoot({
  children,
  host,
}: {
  readonly children: ComponentChildren;
  readonly host: HTMLElement;
}) {
  useLayoutEffect(() => {
    render(<>{children}</>, host);
    return () => render(null, host);
  }, [children, host]);
  return null;
}
