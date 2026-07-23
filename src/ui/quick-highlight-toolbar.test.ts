// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_STYLE_PRESETS } from '../domain/style-preset';
import { QuickHighlightToolbar, type QuickToolbarAction } from './quick-highlight-toolbar';

describe('quick highlight toolbar', () => {
  it('shows five colors, underline, add note and explicit details in stable order', async () => {
    let committedAction: QuickToolbarAction | null = null;
    const toolbar = new QuickHighlightToolbar({
      document,
      onAction: (action) => {
        committedAction = action;
        return Promise.resolve();
      },
      onDismiss: () => undefined,
    });

    toolbar.show({
      anchorRect: new DOMRect(100, 120, 80, 20),
      presets: DEFAULT_STYLE_PRESETS,
      recentStyleId: 'highlight-sun',
    });
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>('.inkstone-quick-toolbar button'),
    ];
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Highlight: Sun',
      'Highlight: Mint',
      'Highlight: Sky',
      'Highlight: Rose',
      'Highlight: Violet',
      'Underline',
      'Add note',
      'Open annotation details',
    ]);
    expect(buttons.slice(5).map((button) => button.dataset.inkstoneIcon)).toEqual([
      'underline',
      'message-square-plus',
      'square-pen',
    ]);
    expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');

    buttons[1]?.click();
    await Promise.resolve();

    expect(committedAction).toEqual({ kind: 'highlight', styleId: 'highlight-mint' });
    expect(document.querySelector('[data-inkstone-quick-toolbar]')).toBeNull();
  });

  it('uses the recent style for underline and supports roving keyboard focus', async () => {
    const actions: QuickToolbarAction[] = [];
    const toolbar = new QuickHighlightToolbar({
      document,
      onAction: (action) => {
        actions.push(action);
        return Promise.resolve();
      },
      onDismiss: () => undefined,
    });
    toolbar.show({
      anchorRect: new DOMRect(100, 120, 80, 20),
      presets: DEFAULT_STYLE_PRESETS,
      recentStyleId: 'highlight-violet',
    });
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>('.inkstone-quick-toolbar button'),
    ];
    expect(document.activeElement).toBe(buttons[0]);
    buttons[0]?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }));
    expect(document.activeElement).toBe(buttons.at(-1));
    buttons.at(-1)?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Home' }));
    expect(document.activeElement).toBe(buttons[0]);
    buttons[0]?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End' }));
    expect(document.activeElement).toBe(buttons.at(-1));

    buttons.find((button) => button.getAttribute('aria-label') === 'Underline')?.click();
    await Promise.resolve();
    expect(actions).toEqual([{ kind: 'underline', styleId: 'highlight-violet' }]);
  });

  it('does not steal focus or collapse the native selection in the mobile action bar', () => {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Keep this native selection visible.';
    const focusedControl = document.createElement('button');
    document.body.append(paragraph, focusedControl);
    const text = paragraph.firstChild;
    if (!(text instanceof Text)) throw new Error('Selection fixture is missing text.');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 9);
    focusedControl.focus();
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    expect(document.getSelection()?.toString()).toBe('Keep this');
    const toolbar = new QuickHighlightToolbar({
      document,
      layout: 'mobile-action-bar',
      onAction: () => Promise.resolve(),
      onDismiss: () => undefined,
    });

    toolbar.show({
      anchorRect: new DOMRect(100, 120, 80, 20),
      presets: DEFAULT_STYLE_PRESETS,
      recentStyleId: 'highlight-sun',
    });

    expect(document.activeElement).toBe(focusedControl);
    expect(document.getSelection()?.toString()).toBe('Keep this');
    expect(document.querySelector('[data-inkstone-quick-toolbar]')?.classList).toContain(
      'inkstone-quick-toolbar--mobile-action-bar',
    );

    toolbar.close(false);
    document.getSelection()?.removeAllRanges();
    paragraph.remove();
    focusedControl.remove();
  });

  it('docks the mobile action bar to the visual viewport instead of the native selection', () => {
    const visualViewport = new EventTarget();
    Object.defineProperties(visualViewport, {
      height: { value: 700 },
      offsetLeft: { value: 100 },
      offsetTop: { value: 40 },
      width: { value: 640 },
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('inkstone-quick-toolbar')
          ? new DOMRect(0, 0, 360, 50)
          : new DOMRect();
      });
    const toolbar = new QuickHighlightToolbar({
      document,
      layout: 'mobile-action-bar',
      onAction: () => Promise.resolve(),
      onDismiss: () => undefined,
    });

    toolbar.show({
      anchorRect: new DOMRect(101, 240, 20, 30),
      presets: DEFAULT_STYLE_PRESETS,
      recentStyleId: 'highlight-sun',
    });

    const element = document.querySelector<HTMLElement>('[data-inkstone-quick-toolbar]');
    expect(element?.style.left).toBe('240px');
    expect(element?.style.top).toBe('678px');
    expect(element?.dataset.inkstonePlacement).toBe('bottom-action-bar');

    toolbar.close(false);
    rect.mockRestore();
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined,
    });
  });

  it('keeps retry context when local persistence fails', async () => {
    let attempts = 0;
    let reportedError: unknown;
    const toolbar = new QuickHighlightToolbar({
      document,
      onAction: () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error('disk unavailable'));
        }
        return Promise.resolve();
      },
      onDismiss: () => undefined,
      onError: (error) => {
        reportedError = error;
      },
    });
    toolbar.show({
      anchorRect: new DOMRect(100, 120, 80, 20),
      presets: DEFAULT_STYLE_PRESETS,
      recentStyleId: 'highlight-sun',
    });

    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Highlight: Sun"]');
    button?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't save locally. Retry.",
    );
    expect(button?.disabled).toBe(false);
    expect(reportedError).toEqual(new Error('disk unavailable'));

    button?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(2);
    expect(document.querySelector('[data-inkstone-quick-toolbar]')).toBeNull();
  });

  it('dismisses pending context when the user clicks outside or begins scrolling', () => {
    let dismissals = 0;
    const toolbar = new QuickHighlightToolbar({
      document,
      onAction: () => Promise.resolve(),
      onDismiss: () => {
        dismissals += 1;
      },
    });
    const show = (): void =>
      toolbar.show({
        anchorRect: new DOMRect(100, 120, 80, 20),
        presets: DEFAULT_STYLE_PRESETS,
        recentStyleId: 'highlight-sun',
      });

    show();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.querySelector('[data-inkstone-quick-toolbar]')).toBeNull();

    show();
    document.dispatchEvent(new Event('scroll'));
    expect(document.querySelector('[data-inkstone-quick-toolbar]')).toBeNull();
    expect(dismissals).toBe(2);
  });

  it('uses the owner-document dismiss stack for Escape and releases it on close', () => {
    let dismissals = 0;
    const remove = vi.spyOn(document, 'removeEventListener');
    const toolbar = new QuickHighlightToolbar({
      document,
      onAction: () => Promise.resolve(),
      onDismiss: () => {
        dismissals += 1;
      },
    });
    toolbar.show({
      anchorRect: new DOMRect(100, 120, 80, 20),
      presets: DEFAULT_STYLE_PRESETS,
      recentStyleId: 'highlight-sun',
    });

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(dismissals).toBe(1);
    expect(document.querySelector('[data-inkstone-quick-toolbar]')).toBeNull();
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), true);
  });

  it('keeps the toolbar inside an offset visual viewport near the left edge', () => {
    const visualViewport = new EventTarget();
    Object.defineProperties(visualViewport, {
      height: { value: 700 },
      offsetLeft: { value: 100 },
      offsetTop: { value: 40 },
      width: { value: 640 },
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('inkstone-quick-toolbar')
          ? new DOMRect(0, 0, 360, 50)
          : new DOMRect();
      });
    const toolbar = new QuickHighlightToolbar({
      document,
      onAction: () => Promise.resolve(),
      onDismiss: () => undefined,
    });

    toolbar.show({
      anchorRect: new DOMRect(101, 240, 20, 30),
      presets: DEFAULT_STYLE_PRESETS,
      recentStyleId: 'highlight-sun',
    });

    const element = document.querySelector<HTMLElement>('[data-inkstone-quick-toolbar]');
    expect(element?.style.left).toBe('112px');
    expect(element?.style.top).toBe('182px');
    expect(element?.dataset.inkstonePlacement).toBe('above');

    toolbar.close(false);
    rect.mockRestore();
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined,
    });
  });

  it('shows a concise non-destructive reason for an unsupported selection', () => {
    const toolbar = new QuickHighlightToolbar({
      document,
      onAction: () => Promise.resolve(),
      onDismiss: () => undefined,
    });

    toolbar.showUnavailable({
      anchorRect: new DOMRect(100, 120, 80, 20),
      message: 'Generated content cannot be mapped to stable Markdown source.',
    });

    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      'Generated content cannot be mapped to stable Markdown source.',
    );
    expect(document.querySelector('.inkstone-quick-toolbar button')).toBeNull();
    toolbar.close(false);
  });

  it('offers an explicit Snapshot action without converting the failed text annotation', async () => {
    const annotateSnapshot = vi.fn(() => Promise.resolve());
    const toolbar = new QuickHighlightToolbar({
      document,
      onAction: () => Promise.resolve(),
      onDismiss: () => undefined,
    });

    toolbar.showUnavailable({
      action: {
        label: 'Annotate a snapshot instead',
        onActivate: annotateSnapshot,
      },
      anchorRect: new DOMRect(100, 120, 80, 20),
      message: 'This content cannot be traced to this Markdown file.',
    });
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Annotate a snapshot instead"]')
      ?.click();

    await vi.waitFor(() => expect(annotateSnapshot).toHaveBeenCalledOnce());
    expect(document.querySelector('button[aria-label="Annotate a snapshot instead"]')).toBeNull();
  });
});
