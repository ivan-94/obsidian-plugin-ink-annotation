// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import type { InkSurfacePartition } from '../domain/ink-surface-layout';
import { measureInkSurfaceHeights } from './ink-surface-geometry';

describe('Ink surface DOM geometry', () => {
  it('uses Obsidian data-line positions while keeping boundaries invisible and exhaustive', () => {
    const root = document.createElement('div');
    const first = marker(0, 0);
    const second = marker(4, 380);
    root.append(first, second);
    Object.defineProperties(root, { clientHeight: { value: 900 }, scrollHeight: { value: 900 } });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0));

    expect(
      measureInkSurfaceHeights({
        partitions: [partition(0, 11), partition(12, 25)],
        root,
        source: '# A\n\nAlpha\n\n# B\n\nBeta',
      }),
    ).toEqual([380, 520]);
  });

  it('falls back proportionally and reports that fallback instead of pretending DOM alignment', () => {
    const root = document.createElement('div');
    Object.defineProperties(root, { clientHeight: { value: 1000 }, scrollHeight: { value: 1000 } });

    const measured = measureInkSurfaceHeights({
      partitions: [partition(0, 24), partition(25, 100)],
      root,
      source: 'x'.repeat(100),
    });

    expect(measured).toEqual([250, 750]);
    expect(measured.usedFallback).toBe(true);
  });

  it('covers the complete Reading View scroll extent when Obsidian virtualizes the sizer', () => {
    const root = document.createElement('div');
    Object.defineProperties(root, { clientHeight: { value: 900 }, scrollHeight: { value: 900 } });

    const measured = measureInkSurfaceHeights({
      minimumTotalHeight: 1200,
      partitions: [partition(0, 24), partition(25, 100)],
      root,
      source: 'x'.repeat(100),
    });

    expect(measured).toEqual([300, 900]);
    expect(measured.reduce((total, height) => total + height, 0)).toBe(1200);
  });
});

function marker(line: number, top: number): HTMLElement {
  const element = document.createElement('div');
  element.dataset.line = String(line);
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(top));
  return element;
}

function rect(top: number): DOMRect {
  return {
    bottom: top + 20,
    height: 20,
    left: 0,
    right: 960,
    toJSON: () => ({}),
    top,
    width: 960,
    x: 0,
    y: top,
  };
}

function partition(sourceStart: number, sourceEnd: number): InkSurfacePartition {
  return {
    blockFingerprints: [`${sourceStart}`],
    fullNoteFallback: false,
    headingPath: [],
    sectionFingerprint: `${sourceStart}:${sourceEnd}`,
    sourceEnd,
    sourceStart,
  };
}
