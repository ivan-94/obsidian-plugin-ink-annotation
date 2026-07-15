export interface DismissibleMenuController {
  readonly close: () => void;
  readonly open: () => void;
  readonly toggle: () => boolean;
}

const installedDocuments = new WeakSet<Document>();
let menuSequence = 0;

export function createDismissibleMenu(input: {
  readonly document: Document;
  readonly menu: HTMLElement;
  readonly trigger: HTMLElement;
}): DismissibleMenuController {
  installDocumentDismiss(input.document);
  if (input.menu.id.length === 0) {
    menuSequence += 1;
    input.menu.id = `inkstone-dismissible-menu-${menuSequence}`;
  }
  input.menu.dataset.inkstoneDismissibleMenu = '';
  input.trigger.setAttribute('aria-controls', input.menu.id);
  input.trigger.setAttribute('aria-expanded', String(!input.menu.hidden));

  const close = (): void => setMenuState(input.menu, input.trigger, false);
  const open = (): void => {
    closeOpenMenus(input.document, input.menu);
    setMenuState(input.menu, input.trigger, true);
  };
  const toggle = (): boolean => {
    const shouldOpen = input.menu.hidden === true;
    if (shouldOpen) open();
    else close();
    return shouldOpen;
  };
  input.menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
    input.trigger.focus({ preventScroll: true });
  });
  return { close, open, toggle };
}

function installDocumentDismiss(document: Document): void {
  if (installedDocuments.has(document)) return;
  installedDocuments.add(document);
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target;
      for (const menu of openMenus(document)) {
        const trigger = triggerFor(document, menu);
        if (
          target instanceof Node &&
          (menu.contains(target) || trigger?.contains(target) === true)
        ) {
          continue;
        }
        setMenuOpen(document, menu, false);
      }
    },
    true,
  );
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const menus = openMenus(document);
    if (menus.length === 0) return;
    const trigger = triggerFor(document, menus.at(-1) as HTMLElement);
    closeOpenMenus(document);
    trigger?.focus({ preventScroll: true });
  });
}

function closeOpenMenus(document: Document, except?: HTMLElement): void {
  for (const menu of openMenus(document)) {
    if (menu !== except) setMenuOpen(document, menu, false);
  }
}

function openMenus(document: Document): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-inkstone-dismissible-menu]')].filter(
    (menu) => !menu.hidden,
  );
}

function setMenuOpen(document: Document, menu: HTMLElement, open: boolean): void {
  const trigger = triggerFor(document, menu);
  if (trigger !== undefined) setMenuState(menu, trigger, open);
  else menu.hidden = !open;
}

function setMenuState(menu: HTMLElement, trigger: HTMLElement, open: boolean): void {
  menu.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
}

function triggerFor(document: Document, menu: HTMLElement): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[aria-controls]')].find(
    (candidate) => candidate.getAttribute('aria-controls') === menu.id,
  );
}
