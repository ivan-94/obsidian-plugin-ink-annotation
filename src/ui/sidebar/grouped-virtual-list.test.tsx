// @vitest-environment jsdom

import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GroupedVirtualList } from './grouped-virtual-list';

describe('GroupedVirtualList', () => {
  afterEach(() => document.body.replaceChildren());

  it('keeps a mixed-height 20,000-item list bounded and reports scrolling', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const items = Array.from({ length: 20_000 }, (_, index) => ({
      height: index % 10 === 0 ? 42 : 66,
      id: `item-${index}`,
    }));
    const onScrollOffsetChange = vi.fn();

    render(
      <GroupedVirtualList
        itemHeight={(item) => item.height}
        itemKey={(item) => item.id}
        items={items}
        onScrollOffsetChange={onScrollOffsetChange}
        overscanPx={180}
        renderItem={(item) => <div data-item={item.id} />}
        scrollOffset={0}
      />,
      container,
    );

    expect(container.querySelectorAll('[data-item]').length).toBeLessThan(30);
    expect(
      container.querySelector('[data-inkstone-virtual-total]')?.getAttribute('style'),
    ).toContain('calc(1272000px + var(--inkstone-vault-bottom-safe-area))');
    const viewport = container.querySelector<HTMLElement>('.inkstone-vault-virtual-list');
    if (viewport === null) throw new Error('Expected virtual viewport.');
    viewport.scrollTop = 420;
    viewport.dispatchEvent(new Event('scroll'));
    expect(onScrollOffsetChange).toHaveBeenCalledWith(420);
  });
});
