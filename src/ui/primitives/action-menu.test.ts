// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { showActionMenu } from './action-menu';

describe('Action Menu', () => {
  afterEach(() => document.body.replaceChildren());

  it('opens element-anchored actions in the trigger owner document', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const frameDocument = frame.contentDocument;
    if (frameDocument === null) throw new Error('Expected iframe document.');
    const trigger = frameDocument.createElement('button');
    frameDocument.body.append(trigger);
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(domRect(180, 24, 32, 32));
    const selected = vi.fn();

    showActionMenu({
      anchor: { element: trigger, kind: 'element' },
      items: [
        {
          icon: 'square-pen',
          id: 'edit',
          onSelect: selected,
          title: 'Edit',
        },
      ],
    });

    const menu = frameDocument.body.querySelector<HTMLElement>('[data-obsidian-test-menu]');
    expect(menu).not.toBeNull();
    expect(document.body.querySelector('[data-obsidian-test-menu]')).toBeNull();
    expect(menu?.dataset.menuX).toBe('180');
    expect(menu?.dataset.menuY).toBe('56');
    expect(menu?.dataset.menuWidth).toBe('32');
    const edit = menu?.querySelector<HTMLButtonElement>('button');
    expect(edit?.textContent).toBe('Edit');
    expect(edit?.dataset.icon).toBe('square-pen');

    edit?.click();

    expect(selected).toHaveBeenCalledTimes(1);
    expect(frameDocument.body.querySelector('[data-obsidian-test-menu]')).toBeNull();
  });

  it('supports pointer anchors and native item states without a trigger dependency', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const frameDocument = frame.contentDocument;
    const frameWindow = frame.contentWindow;
    if (frameDocument === null || frameWindow === null) throw new Error('Expected iframe window.');
    const onHide = vi.fn();
    const event = new (frameWindow as Window & typeof globalThis).MouseEvent('contextmenu', {
      clientX: 296,
      clientY: 184,
      view: frameWindow,
    });

    const handle = showActionMenu({
      anchor: { event, kind: 'pointer' },
      items: [
        {
          disabled: true,
          icon: 'trash-2',
          id: 'delete',
          onSelect: vi.fn(),
          section: 'danger',
          title: 'Delete',
          warning: true,
        },
      ],
      onHide,
    });

    const item = frameDocument.body.querySelector<HTMLButtonElement>(
      '[data-obsidian-test-menu] button',
    );
    expect(item?.disabled).toBe(true);
    expect(item?.dataset.icon).toBe('trash-2');
    expect(item?.dataset.section).toBe('danger');
    expect(item?.dataset.warning).toBe('true');
    expect(item?.parentElement?.dataset.menuX).toBe('296');
    expect(item?.parentElement?.dataset.menuY).toBe('184');

    handle.close();

    expect(onHide).toHaveBeenCalledTimes(1);
  });
});

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    bottom: y + height,
    height,
    left: x,
    right: x + width,
    toJSON: () => ({}),
    top: y,
    width,
    x,
    y,
  };
}
