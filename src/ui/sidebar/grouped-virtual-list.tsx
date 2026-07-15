import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';

export interface GroupedVirtualListProps<T> {
  readonly itemHeight: (item: T) => number;
  readonly itemKey: (item: T) => string;
  readonly items: readonly T[];
  readonly onScrollOffsetChange: (offset: number) => void;
  readonly overscanPx: number;
  readonly renderItem: (item: T) => ComponentChildren;
  readonly scrollOffset: number;
}

export function GroupedVirtualList<T>({
  itemHeight,
  itemKey,
  items,
  onScrollOffsetChange,
  overscanPx,
  renderItem,
  scrollOffset,
}: GroupedVirtualListProps<T>) {
  const viewport = useRef<HTMLDivElement>(null);
  const offsets = useMemo(() => {
    const values = [0];
    for (const item of items) values.push((values.at(-1) ?? 0) + itemHeight(item));
    return values;
  }, [itemHeight, items]);
  const viewportHeight = viewport.current?.clientHeight || 560;
  const start = offsetIndex(offsets, Math.max(0, scrollOffset - overscanPx));
  const visibleBottom = scrollOffset + viewportHeight + overscanPx;
  let end = start;
  while (end < items.length && (offsets[end] ?? 0) < visibleBottom) end += 1;
  const totalHeight = offsets.at(-1) ?? 0;

  useLayoutEffect(() => {
    if (viewport.current !== null && viewport.current.scrollTop !== scrollOffset) {
      viewport.current.scrollTop = scrollOffset;
    }
  }, [scrollOffset]);

  return (
    <div
      className="inkstone-vault-virtual-list"
      onScroll={(event) => onScrollOffsetChange(event.currentTarget.scrollTop)}
      ref={viewport}
      style={{ height: '100%', overflowY: 'auto' }}
    >
      <div
        data-inkstone-virtual-total=""
        style={{
          height: `calc(${totalHeight}px + var(--inkstone-vault-bottom-safe-area))`,
          position: 'relative',
        }}
      >
        <div
          style={{
            left: 0,
            position: 'absolute',
            right: 0,
            transform: `translateY(${offsets[start] ?? 0}px)`,
          }}
        >
          {items.slice(start, end).map((item) => (
            <div
              data-inkstone-virtual-item=""
              key={itemKey(item)}
              style={{ height: `${itemHeight(item)}px` }}
            >
              {renderItem(item)}
            </div>
          ))}
        </div>
        <div
          aria-hidden="true"
          className="inkstone-vault-scroll-spacer"
          data-inkstone-vault-bottom-spacer=""
          style={{
            height: 'var(--inkstone-vault-bottom-safe-area)',
            top: `${totalHeight}px`,
          }}
        />
      </div>
    </div>
  );
}

function offsetIndex(offsets: readonly number[], target: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((offsets[middle] ?? 0) <= target) low = middle;
    else high = middle - 1;
  }
  return low;
}
