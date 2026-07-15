import type { InkSurfacePartition } from '../domain/ink-surface-layout';

export type InkSurfaceHeights = readonly number[] & { readonly usedFallback: boolean };

/** Maps stable source partitions onto the rendered Reading View without exposing tile UI. */
export function measureInkSurfaceHeights(input: {
  readonly minimumTotalHeight?: number;
  readonly partitions: readonly InkSurfacePartition[];
  readonly root: HTMLElement;
  readonly source: string;
}): InkSurfaceHeights {
  if (input.partitions.length === 0) {
    return withFallbackFlag([], false);
  }
  const totalHeight = Math.max(
    1,
    Math.ceil(input.root.scrollHeight || input.root.clientHeight || 1),
    Math.ceil(input.minimumTotalHeight ?? 0),
  );
  const rootTop = input.root.getBoundingClientRect().top;
  const markers = [...input.root.querySelectorAll<HTMLElement>('[data-line]')]
    .map((element) => ({
      line: Number.parseInt(element.dataset.line ?? '', 10),
      y: Math.round(element.getBoundingClientRect().top - rootTop),
    }))
    .filter(({ line, y }) => Number.isInteger(line) && Number.isFinite(y))
    .sort((left, right) => left.line - right.line || left.y - right.y);

  let usedFallback = false;
  const boundaries = [0];
  for (const partition of input.partitions.slice(1)) {
    const targetLine = lineAtOffset(input.source, partition.sourceStart);
    const candidate = markers.find(({ line }) => line >= targetLine);
    const proportional = Math.round(
      (partition.sourceStart / Math.max(1, input.source.length)) * totalHeight,
    );
    const previous = boundaries.at(-1) ?? 0;
    const measured = candidate?.y;
    const boundary =
      measured !== undefined && measured > previous && measured < totalHeight
        ? measured
        : proportional;
    if (measured === undefined || boundary !== measured) {
      usedFallback = true;
    }
    boundaries.push(Math.min(totalHeight - 1, Math.max(previous + 1, boundary)));
  }
  boundaries.push(totalHeight);

  const heights = boundaries.slice(1).map((boundary, index) => {
    const previous = boundaries[index] ?? 0;
    return Math.max(1, boundary - previous);
  });
  return withFallbackFlag(heights, usedFallback);
}

function lineAtOffset(source: string, offset: number): number {
  let line = 0;
  for (let index = 0; index < Math.min(offset, source.length); index += 1) {
    if (source[index] === '\n') line += 1;
  }
  return line;
}

function withFallbackFlag(values: number[], usedFallback: boolean): InkSurfaceHeights {
  Object.defineProperty(values, 'usedFallback', {
    configurable: false,
    enumerable: false,
    value: usedFallback,
    writable: false,
  });
  return values as unknown as InkSurfaceHeights;
}
