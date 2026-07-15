import { describe, expect, it } from 'vitest';

import { cssPointToInkLogical, inkLogicalToCanvasPixel } from './ink-coordinate';

describe('Ink coordinate conversion', () => {
  it('maps CSS input to logical coordinates, then device pixels independently', () => {
    const logical = cssPointToInkLogical(
      { x: 240, y: 300 },
      { cssHeight: 600, cssWidth: 480, logicalHeight: 1200, logicalWidth: 960 },
    );

    expect(logical).toEqual({ x: 480, y: 600 });
    expect(
      inkLogicalToCanvasPixel(logical, {
        canvasPixelHeight: 2400,
        canvasPixelWidth: 1920,
        logicalHeight: 1200,
        logicalWidth: 960,
      }),
    ).toEqual({ x: 960, y: 1200 });
  });

  it('clamps edge input and rejects zero-sized layouts', () => {
    expect(
      cssPointToInkLogical(
        { x: -10, y: 900 },
        { cssHeight: 600, cssWidth: 480, logicalHeight: 1200, logicalWidth: 960 },
      ),
    ).toEqual({ x: 0, y: 1200 });
    expect(() =>
      cssPointToInkLogical(
        { x: 1, y: 1 },
        { cssHeight: 0, cssWidth: 480, logicalHeight: 1200, logicalWidth: 960 },
      ),
    ).toThrow();
  });
});
