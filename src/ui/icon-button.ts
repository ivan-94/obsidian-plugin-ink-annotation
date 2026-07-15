import { setIcon, setTooltip } from 'obsidian';

export interface IconButtonOptions {
  readonly className?: string;
  readonly danger?: boolean;
  readonly icon: string;
  readonly label: string;
  readonly text?: string;
}

export function createIconButton(
  document: Document,
  options: IconButtonOptions,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  decorateIconButton(button, options);
  return button;
}

export function decorateIconButton(button: HTMLButtonElement, options: IconButtonOptions): void {
  button.replaceChildren();
  button.classList.add('inkstone-icon-button');
  if (options.className !== undefined) button.classList.add(options.className);
  if (options.danger === true) button.classList.add('inkstone-icon-button--danger');
  button.dataset.inkstoneIcon = options.icon;
  button.setAttribute('aria-label', options.label);
  setTooltip(button, options.label, { placement: 'top' });

  const icon = button.ownerDocument.createElement('span');
  icon.className = 'inkstone-icon-button__icon';
  icon.setAttribute('aria-hidden', 'true');
  setIcon(icon, options.icon);
  button.append(icon);

  if (options.text !== undefined) {
    const text = button.ownerDocument.createElement('span');
    text.className = 'inkstone-icon-button__label';
    text.textContent = options.text;
    button.append(text);
  }
}

export function createIcon(
  document: Document,
  iconId: string,
  className?: string,
): HTMLSpanElement {
  const icon = document.createElement('span');
  icon.className = className ?? 'inkstone-icon';
  icon.dataset.inkstoneIcon = iconId;
  icon.setAttribute('aria-hidden', 'true');
  setIcon(icon, iconId);
  return icon;
}

export function createIconStatus(
  document: Document,
  options: { readonly icon: string; readonly label: string },
): HTMLSpanElement {
  const status = document.createElement('span');
  status.className = 'inkstone-icon-status';
  status.setAttribute('aria-label', options.label);
  status.setAttribute('role', 'status');
  setTooltip(status, options.label, { placement: 'top' });
  status.append(createIcon(document, options.icon));
  const label = document.createElement('span');
  label.className = 'inkstone-visually-hidden';
  label.textContent = options.label;
  status.append(label);
  return status;
}
