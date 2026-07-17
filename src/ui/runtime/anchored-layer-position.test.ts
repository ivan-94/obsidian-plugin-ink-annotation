// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { calculateAnchoredLayerPosition, positionAnchoredElement } from './anchored-layer-position';

describe('anchored layer positioning', () => {
  it('keeps a wide toolbar inside an offset visual viewport near the left edge', () => {
    expect(
      calculateAnchoredLayerPosition({
        anchorRect: { bottom: 270, left: 122, top: 240, width: 40 },
        layerSize: { height: 50, width: 360 },
        preferredPlacement: 'above',
        viewport: { height: 700, left: 120, top: 40, width: 640 },
      }),
    ).toEqual({ left: 132, placement: 'above', top: 182 });
  });

  it('flips an editor above its anchor when the preferred side would leave the viewport', () => {
    expect(
      calculateAnchoredLayerPosition({
        anchorRect: { bottom: 670, left: 640, top: 640, width: 80 },
        layerSize: { height: 300, width: 380 },
        preferredPlacement: 'below',
        viewport: { height: 700, left: 100, top: 20, width: 800 },
      }),
    ).toEqual({ left: 490, placement: 'above', top: 332 });
  });

  it('positions an element against the owner document visual viewport', () => {
    const element = document.createElement('div');
    document.body.append(element);
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 360, 50));
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { height: 700, offsetLeft: 120, offsetTop: 40, width: 640 },
    });

    positionAnchoredElement({
      anchorRect: { bottom: 270, left: 122, top: 240, width: 40 },
      document,
      element,
      preferredPlacement: 'above',
    });

    expect(element.style.left).toBe('132px');
    expect(element.style.top).toBe('182px');
    expect(element.style.getPropertyValue('--inkstone-anchored-max-height')).toBe('676px');
    expect(element.style.getPropertyValue('--inkstone-anchored-max-width')).toBe('616px');
    expect(element.dataset.inkstonePlacement).toBe('above');
  });
});
