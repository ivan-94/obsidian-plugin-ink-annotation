import { useLayoutEffect, useRef } from 'preact/hooks';

import {
  createDismissibleMenuController,
  type DismissibleMenuController,
} from '../runtime/dismissible-layer';

export function useDismissibleMenu(document: Document) {
  const controller = useRef<DismissibleMenuController | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (menu.current === null || trigger.current === null) return;
    controller.current = createDismissibleMenuController({
      document,
      menu: menu.current,
      trigger: trigger.current,
    });
    return () => {
      controller.current?.dispose();
      controller.current = null;
    };
  }, [document]);

  return { controller, menu, trigger };
}
