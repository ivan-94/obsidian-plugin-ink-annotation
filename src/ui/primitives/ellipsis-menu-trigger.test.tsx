// @vitest-environment jsdom

import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EllipsisMenuTrigger } from './ellipsis-menu-trigger';

describe('EllipsisMenuTrigger', () => {
  afterEach(() => document.body.replaceChildren());

  it('opens the shared global menu and keeps aria-expanded synchronized', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const selected = vi.fn();
    render(
      <EllipsisMenuTrigger
        className="inkstone-icon-button test-trigger"
        items={[{ id: 'edit', onSelect: selected, title: 'Edit' }]}
        label="Open actions"
      />,
      container,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button');

    trigger?.click();

    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-obsidian-test-menu]')).toBeNull();
    const item = document.body.querySelector<HTMLButtonElement>('[data-obsidian-test-menu] button');
    expect(item?.textContent).toBe('Edit');

    item?.click();

    expect(selected).toHaveBeenCalledTimes(1);
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  it('returns focus to the trigger when Escape dismisses the menu', () => {
    const container = document.createElement('div');
    document.body.append(container);
    render(
      <EllipsisMenuTrigger
        items={[{ id: 'edit', onSelect: () => undefined, title: 'Edit' }]}
        label="Open actions"
      />,
      container,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button');
    trigger?.click();
    document.body.querySelector<HTMLButtonElement>('[data-obsidian-test-menu] button')?.focus();

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });
});
