// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { createDismissibleMenuController } from './runtime/dismissible-layer';

describe('dismissible menu', () => {
  afterEach(() => document.body.replaceChildren());

  it('keeps one menu open and dismisses it outside or with Escape', () => {
    const firstTrigger = document.createElement('button');
    const firstMenu = document.createElement('div');
    firstMenu.hidden = true;
    const secondTrigger = document.createElement('button');
    const secondMenu = document.createElement('div');
    secondMenu.hidden = true;
    document.body.append(firstTrigger, firstMenu, secondTrigger, secondMenu);
    const first = createDismissibleMenuController({
      document,
      menu: firstMenu,
      trigger: firstTrigger,
    });
    const second = createDismissibleMenuController({
      document,
      menu: secondMenu,
      trigger: secondTrigger,
    });

    first.open();
    expect(firstMenu.hidden).toBe(false);
    second.open();
    expect(firstMenu.hidden).toBe(true);
    expect(secondMenu.hidden).toBe(false);

    secondMenu.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(secondMenu.hidden).toBe(false);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(secondMenu.hidden).toBe(true);

    first.open();
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(firstMenu.hidden).toBe(true);
    expect(document.activeElement).toBe(firstTrigger);
  });
});
