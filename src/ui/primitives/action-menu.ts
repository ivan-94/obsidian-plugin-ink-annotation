import { Menu } from 'obsidian';

export type ActionMenuAnchor =
  | { readonly element: HTMLElement; readonly kind: 'element' }
  | { readonly event: MouseEvent | PointerEvent; readonly kind: 'pointer' };

export interface ActionMenuItem {
  readonly checked?: boolean | null;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly id: string;
  readonly onSelect: () => void;
  readonly section?: string;
  readonly title: string;
  readonly warning?: boolean;
}

export interface ActionMenuHandle {
  readonly close: () => void;
}

interface WarningCapableMenuItem {
  readonly setWarning?: (warning: boolean) => unknown;
}

export function showActionMenu({
  anchor,
  items,
  onHide,
}: {
  readonly anchor: ActionMenuAnchor;
  readonly items: readonly ActionMenuItem[];
  readonly onHide?: () => void;
}): ActionMenuHandle {
  const menu = new Menu();
  for (const action of items) {
    menu.addItem((item) => {
      item.setTitle(action.title);
      if (action.icon !== undefined) item.setIcon(action.icon);
      if (action.checked !== undefined) item.setChecked(action.checked);
      if (action.disabled !== undefined) item.setDisabled(action.disabled);
      const setWarning = (item as WarningCapableMenuItem).setWarning;
      if (action.warning !== undefined && typeof setWarning === 'function') {
        Reflect.apply(setWarning, item, [action.warning]);
      }
      if (action.section !== undefined) item.setSection(action.section);
      item.onClick(action.onSelect);
    });
  }
  if (onHide !== undefined) menu.onHide(onHide);
  if (anchor.kind === 'pointer') {
    menu.showAtMouseEvent(anchor.event);
  } else {
    const rect = anchor.element.getBoundingClientRect();
    menu.showAtPosition(
      {
        width: rect.width,
        x: rect.left,
        y: rect.bottom,
      },
      anchor.element.ownerDocument,
    );
  }
  return { close: () => menu.close() };
}
