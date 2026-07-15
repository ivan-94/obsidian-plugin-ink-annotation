import { render, type ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo } from 'preact/hooks';

import type { ObsidianUiEnvironment } from './obsidian-ui-environment';

export function PortalRoot({
  children,
  environment,
}: {
  readonly children: ComponentChildren;
  readonly environment: ObsidianUiEnvironment;
}) {
  const host = useMemo(() => {
    const element = environment.document.createElement('div');
    element.dataset.inkstonePortalRoot = '';
    return element;
  }, [environment.document]);

  useLayoutEffect(() => {
    environment.portalRoot.append(host);
    return () => {
      render(null, host);
      host.remove();
    };
  }, [environment.portalRoot, host]);

  useLayoutEffect(() => {
    render(<>{children}</>, host);
  }, [children, host]);

  return null;
}
