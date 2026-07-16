export function setIcon(parent: HTMLElement, iconId: string): void {
  const svg = parent.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('data-icon', iconId);
  svg.setAttribute('aria-hidden', 'true');
  parent.append(svg);
}

export function setTooltip(
  element: HTMLElement,
  tooltip: string,
  options?: { readonly placement?: string },
): void {
  void options;
  element.title = tooltip;
  element.dataset.tooltip = tooltip;
}

interface TestMenuPosition {
  readonly width?: number;
  readonly x: number;
  readonly y: number;
}

const activeMenus = new WeakMap<Document, Menu>();

export class MenuItem {
  checked: boolean | null | undefined;
  disabled = false;
  icon: string | null = null;
  onSelect: (() => void) | null = null;
  section: string | null = null;
  title: string | DocumentFragment = '';
  warning = false;

  setTitle(title: string | DocumentFragment): this {
    this.title = title;
    return this;
  }

  setIcon(icon: string | null): this {
    this.icon = icon;
    return this;
  }

  setChecked(checked: boolean | null): this {
    this.checked = checked;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  setWarning(warning: boolean): this {
    this.warning = warning;
    return this;
  }

  setIsLabel(): this {
    return this;
  }

  onClick(callback: () => void): this {
    this.onSelect = callback;
    return this;
  }

  setSection(section: string): this {
    this.section = section;
    return this;
  }
}

export class Menu {
  private readonly hideCallbacks: Array<() => void> = [];
  private readonly items: MenuItem[] = [];
  private menuElement: HTMLElement | null = null;
  private ownerDocument: Document | null = null;
  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.close();
  };
  private readonly handlePointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (isNode(target) && this.menuElement?.contains(target) === true) return;
    this.close();
  };

  addItem(callback: (item: MenuItem) => unknown): this {
    const item = new MenuItem();
    callback(item);
    this.items.push(item);
    return this;
  }

  addSeparator(): this {
    return this;
  }

  setNoIcon(): this {
    return this;
  }

  setUseNativeMenu(): this {
    return this;
  }

  setParentElement(): this {
    return this;
  }

  showAtMouseEvent(event: MouseEvent): this {
    const ownerDocument = event.view?.document ?? document;
    return this.show(ownerDocument, { x: event.clientX, y: event.clientY });
  }

  showAtPosition(position: TestMenuPosition, ownerDocument: Document = document): this {
    return this.show(ownerDocument, position);
  }

  hide(): this {
    return this.closeMenu();
  }

  close(): void {
    this.closeMenu();
  }

  onHide(callback: () => void): void {
    this.hideCallbacks.push(callback);
  }

  private show(ownerDocument: Document, position: TestMenuPosition): this {
    this.closeMenu();
    activeMenus.get(ownerDocument)?.close();
    const menu = ownerDocument.createElement('div');
    menu.dataset.obsidianTestMenu = '';
    menu.dataset.menuX = String(position.x);
    menu.dataset.menuY = String(position.y);
    if (position.width !== undefined) menu.dataset.menuWidth = String(position.width);
    for (const item of this.items) {
      const button = ownerDocument.createElement('button');
      button.setAttribute(
        'aria-label',
        typeof item.title === 'string' ? item.title : (item.title.textContent ?? ''),
      );
      button.disabled = item.disabled;
      if (item.icon !== null) button.dataset.icon = item.icon;
      if (item.section !== null) button.dataset.section = item.section;
      if (item.warning) button.dataset.warning = 'true';
      if (typeof item.title === 'string') button.textContent = item.title;
      else button.append(item.title.cloneNode(true));
      button.addEventListener('click', () => {
        if (button.disabled) return;
        item.onSelect?.();
        this.closeMenu();
      });
      menu.append(button);
    }
    ownerDocument.body.append(menu);
    this.menuElement = menu;
    this.ownerDocument = ownerDocument;
    activeMenus.set(ownerDocument, this);
    ownerDocument.addEventListener('keydown', this.handleKeyDown, true);
    ownerDocument.addEventListener('pointerdown', this.handlePointerDown, true);
    return this;
  }

  private closeMenu(): this {
    if (this.menuElement === null) return this;
    const ownerDocument = this.ownerDocument;
    this.menuElement.remove();
    this.menuElement = null;
    this.ownerDocument = null;
    if (ownerDocument !== null) {
      ownerDocument.removeEventListener('keydown', this.handleKeyDown, true);
      ownerDocument.removeEventListener('pointerdown', this.handlePointerDown, true);
      if (activeMenus.get(ownerDocument) === this) activeMenus.delete(ownerDocument);
    }
    for (const callback of this.hideCallbacks) callback();
    return this;
  }
}

function isNode(value: EventTarget | null): value is Node {
  return value !== null && 'nodeType' in value;
}
