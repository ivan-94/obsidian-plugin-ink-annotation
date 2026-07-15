import type { StylePreset } from '../domain/style-preset';
import { decorateIconButton } from './icon-button';

export type QuickToolbarAction =
  | { readonly kind: 'add-note' }
  | { readonly kind: 'highlight'; readonly styleId: string }
  | { readonly kind: 'more' }
  | { readonly kind: 'underline'; readonly styleId: string };

export interface QuickToolbarShowInput {
  readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
  readonly presets: readonly StylePreset[];
  readonly recentStyleId: string;
}

export interface QuickToolbarUnavailableInput {
  readonly anchorRect: Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>;
  readonly message: string;
}

export class QuickHighlightToolbar {
  private readonly document: Document;
  private readonly onAction: (action: QuickToolbarAction) => Promise<void>;
  private readonly onDismiss: () => void;
  private readonly onError: (error: unknown) => void;
  private removeGlobalListeners: (() => void) | null = null;
  private toolbar: HTMLDivElement | null = null;

  constructor(input: {
    readonly document: Document;
    readonly onAction: (action: QuickToolbarAction) => Promise<void>;
    readonly onDismiss: () => void;
    readonly onError?: (error: unknown) => void;
  }) {
    this.document = input.document;
    this.onAction = input.onAction;
    this.onDismiss = input.onDismiss;
    this.onError = input.onError ?? (() => undefined);
  }

  show(input: QuickToolbarShowInput): void {
    this.close(false);
    const toolbar = this.createContainer(input.anchorRect, 'toolbar');
    const recentStyleId = input.presets.some((preset) => preset.id === input.recentStyleId)
      ? input.recentStyleId
      : input.presets[0]?.id;
    if (recentStyleId === undefined) {
      throw new Error('Quick annotation toolbar requires at least one style preset.');
    }

    input.presets.forEach((preset, index) => {
      const label = preset.name ?? preset.id;
      const button = this.createButton(`Highlight: ${label}`, index === 0);
      button.classList.add('inkstone-quick-toolbar__color-action');
      button.classList.toggle('is-recent', preset.id === recentStyleId);
      button.setAttribute('aria-pressed', String(preset.id === recentStyleId));
      const swatch = this.document.createElement('span');
      swatch.className = 'inkstone-quick-toolbar__swatch';
      swatch.setAttribute('aria-hidden', 'true');
      swatch.style.setProperty('--inkstone-preset-color', preset.color);
      button.append(swatch);
      button.addEventListener(
        'click',
        () => void this.commit({ kind: 'highlight', styleId: preset.id }, button),
      );
      toolbar.append(button);
    });

    const underline = this.createButton('Underline');
    decorateIconButton(underline, { icon: 'underline', label: 'Underline' });
    underline.classList.add('inkstone-quick-toolbar__underline');
    underline.addEventListener(
      'click',
      () => void this.commit({ kind: 'underline', styleId: recentStyleId }, underline),
    );
    toolbar.append(underline);

    const addNote = this.createButton('Add note');
    decorateIconButton(addNote, { icon: 'message-square-plus', label: 'Add note' });
    addNote.addEventListener('click', () => void this.commit({ kind: 'add-note' }, addNote));
    toolbar.append(addNote);

    const more = this.createButton('Open annotation details');
    decorateIconButton(more, { icon: 'square-pen', label: 'Open annotation details' });
    more.classList.add('inkstone-quick-toolbar__details');
    more.addEventListener('click', () => void this.commit({ kind: 'more' }, more));
    toolbar.append(more);

    this.mount(toolbar);
    toolbar.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }

  showUnavailable(input: QuickToolbarUnavailableInput): void {
    this.close(false);
    const toolbar = this.createContainer(input.anchorRect, 'status');
    toolbar.classList.add('inkstone-quick-toolbar--unavailable');
    toolbar.tabIndex = -1;

    const message = this.document.createElement('span');
    message.className = 'inkstone-quick-toolbar__reason';
    message.textContent = input.message;
    toolbar.append(message);

    this.mount(toolbar);
    toolbar.focus({ preventScroll: true });
  }

  close(notify = true): void {
    if (this.toolbar === null) {
      return;
    }
    this.removeGlobalListeners?.();
    this.removeGlobalListeners = null;
    this.toolbar.remove();
    this.toolbar = null;
    if (notify) {
      this.onDismiss();
    }
  }

  private createButton(label: string, tabbable = false): HTMLButtonElement {
    const button = this.document.createElement('button');
    button.className = 'inkstone-quick-toolbar__action';
    button.type = 'button';
    button.tabIndex = tabbable ? 0 : -1;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    return button;
  }

  private installGlobalDismissListeners(toolbar: HTMLElement): void {
    const dismissOutside = (event: Event): void => {
      const target = event.target;
      const NodeConstructor = this.document.defaultView?.Node;
      if (
        NodeConstructor === undefined ||
        !(target instanceof NodeConstructor) ||
        !toolbar.contains(target)
      ) {
        this.close(true);
      }
    };
    const dismissOnScroll = (): void => this.close(true);
    this.document.addEventListener('pointerdown', dismissOutside, true);
    this.document.addEventListener('scroll', dismissOnScroll, true);
    this.removeGlobalListeners = () => {
      this.document.removeEventListener('pointerdown', dismissOutside, true);
      this.document.removeEventListener('scroll', dismissOnScroll, true);
    };
  }

  private createContainer(
    anchorRect: Pick<DOMRect, 'left' | 'top' | 'width'>,
    role: 'status' | 'toolbar',
  ): HTMLDivElement {
    const toolbar = this.document.createElement('div');
    toolbar.className = 'inkstone-quick-toolbar';
    toolbar.dataset.inkstoneQuickToolbar = '';
    toolbar.setAttribute('aria-label', 'Annotation actions');
    toolbar.setAttribute('role', role);
    toolbar.style.setProperty(
      '--inkstone-toolbar-x',
      `${Math.round(anchorRect.left + anchorRect.width / 2)}px`,
    );
    toolbar.style.setProperty('--inkstone-toolbar-y', `${Math.round(anchorRect.top)}px`);
    toolbar.addEventListener('keydown', (event) => this.handleKeydown(event, toolbar));
    return toolbar;
  }

  private handleKeydown(event: KeyboardEvent, toolbar: HTMLElement): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close(true);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }
    const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (buttons.length === 0) {
      return;
    }
    event.preventDefault();
    const current = this.document.activeElement;
    const currentIndex = Math.max(
      0,
      buttons.findIndex((button) => button === current),
    );
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowRight'
            ? (currentIndex + 1) % buttons.length
            : (currentIndex - 1 + buttons.length) % buttons.length;
    buttons.forEach((button, index) => {
      button.tabIndex = index === nextIndex ? 0 : -1;
    });
    buttons[nextIndex]?.focus({ preventScroll: true });
  }

  private mount(toolbar: HTMLDivElement): void {
    this.document.body.append(toolbar);
    this.toolbar = toolbar;
    this.installGlobalDismissListeners(toolbar);
  }

  private async commit(action: QuickToolbarAction, button: HTMLButtonElement): Promise<void> {
    this.toolbar?.querySelector('[role="alert"]')?.remove();
    button.disabled = true;
    try {
      await this.onAction(action);
      this.close(false);
    } catch (commitError) {
      this.onError(commitError);
      if (this.toolbar === null) {
        return;
      }
      const error = this.document.createElement('span');
      error.className = 'inkstone-quick-toolbar__error';
      error.setAttribute('role', 'alert');
      error.textContent = "Couldn't save locally. Retry.";
      this.toolbar.append(error);
      button.disabled = false;
      button.focus({ preventScroll: true });
    }
  }
}
