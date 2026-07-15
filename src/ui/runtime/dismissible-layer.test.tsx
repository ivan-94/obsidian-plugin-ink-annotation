// @vitest-environment jsdom

import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createObsidianUiEnvironment } from './obsidian-ui-environment';
import { DismissibleLayer } from './dismissible-layer';

describe('DismissibleLayer', () => {
  afterEach(() => document.body.replaceChildren());

  it('dismisses only the top owner-document layer and returns focus on Escape', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const frameDocument = frame.contentDocument;
    if (frameDocument === null) throw new Error('Expected iframe document.');
    const trigger = frameDocument.createElement('button');
    frameDocument.body.append(trigger);
    trigger.focus();
    const environment = createObsidianUiEnvironment(frameDocument.body);
    const firstDismiss = vi.fn();
    const secondDismiss = vi.fn();
    const remove = vi.spyOn(frameDocument, 'removeEventListener');
    const root = frameDocument.createElement('div');
    frameDocument.body.append(root);

    render(
      <>
        <DismissibleLayer environment={environment} onDismiss={firstDismiss} returnFocus={trigger}>
          <div data-layer="first" />
        </DismissibleLayer>
        <DismissibleLayer environment={environment} onDismiss={secondDismiss} returnFocus={trigger}>
          <div data-layer="second" />
        </DismissibleLayer>
      </>,
      root,
    );

    frameDocument
      .querySelector('[data-layer="second"]')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(secondDismiss).not.toHaveBeenCalled();

    frameDocument.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(secondDismiss).toHaveBeenCalledWith('escape');
    expect(firstDismiss).not.toHaveBeenCalled();
    expect(frameDocument.activeElement).toBe(trigger);

    render(null, root);
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), true);
  });
});
