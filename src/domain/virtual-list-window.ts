export interface VirtualListWindow {
  readonly end: number;
  readonly offsetTop: number;
  readonly start: number;
  readonly totalHeight: number;
}

export function calculateVirtualListWindow(input: {
  readonly overscan: number;
  readonly rowHeight: number;
  readonly scrollTop: number;
  readonly total: number;
  readonly viewportHeight: number;
}): VirtualListWindow {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Virtual list ${name} must be a non-negative finite number.`);
    }
  }
  if (input.rowHeight === 0) {
    throw new Error('Virtual list rowHeight must be greater than zero.');
  }
  const total = Math.floor(input.total);
  const overscan = Math.floor(input.overscan);
  const firstVisible = Math.min(total, Math.floor(input.scrollTop / input.rowHeight));
  const visibleCount = Math.ceil(input.viewportHeight / input.rowHeight);
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(total, firstVisible + visibleCount + overscan);
  return {
    end,
    offsetTop: start * input.rowHeight,
    start,
    totalHeight: total * input.rowHeight,
  };
}
