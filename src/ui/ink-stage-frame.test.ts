import { describe, expect, it } from 'vitest';

import { createInkStageFrame } from './ink-stage-frame';

describe('Ink Stage Frame', () => {
  it.each([
    { scale: 0.5, expectedClient: { x: 175, y: 250 } },
    { scale: 1, expectedClient: { x: 250, y: 400 } },
    { scale: 1.5, expectedClient: { x: 325, y: 550 } },
  ])(
    'uses the measured $scale scale for every logical/client conversion',
    ({ expectedClient, scale }) => {
      const frame = createInkStageFrame({
        actualScale: scale,
        canvasClientRect: { height: 600, left: 40, top: 60, width: 800 },
        documentClientOrigin: { x: 100, y: 100 },
      });

      expect(frame.logicalToClient({ x: 150, y: 300 })).toEqual(expectedClient);
      expect(frame.clientToLogical(expectedClient)).toEqual({ x: 150, y: 300 });
    },
  );

  it('writes the exact client conversion into one reusable target', () => {
    const frame = createInkStageFrame({
      actualScale: 0.87358,
      canvasClientRect: { height: 891, left: 244, top: 70, width: 679 },
      documentClientOrigin: { x: 276.125, y: 123.5 },
    });
    const target = { x: Number.NaN, y: Number.NaN };

    for (const client of [
      { x: -41.75, y: 153.4375 },
      { x: 276.125, y: 123.5 },
      { x: 923.25, y: 891.125 },
    ]) {
      const expected = frame.clientToLogical(client);
      const result = frame.clientToLogicalInto(client, target);

      expect(result).toBe(target);
      expect(target).toEqual(expected);
    }
  });

  it.each([
    { label: '50%', scale: 0.5 },
    { label: '100%', scale: 1 },
    { label: '150%', scale: 1.5 },
    { label: 'Fit', scale: 0.87358 },
  ])('keeps one persisted stroke coincident with its Markdown landmark at $label', ({ scale }) => {
    const persistedPoint = Object.freeze({ x: 150, y: 300 });
    const persistedBytes = JSON.stringify(persistedPoint);
    const canvasClientRect = { height: 800, left: 40, top: 60, width: 900 };
    const documentClientOrigin = { x: 100, y: 120 };
    const frame = createInkStageFrame({
      actualScale: scale,
      canvasClientRect,
      documentClientOrigin,
    });
    const markdownLandmark = {
      x: documentClientOrigin.x + persistedPoint.x * scale,
      y: documentClientOrigin.y + persistedPoint.y * scale,
    };
    const canvasPoint = frame.logicalToCanvasCss(persistedPoint);

    expect(frame.logicalToClient(persistedPoint)).toEqual(markdownLandmark);
    expect({
      x: canvasClientRect.left + canvasPoint.x,
      y: canvasClientRect.top + canvasPoint.y,
    }).toEqual(markdownLandmark);
    expect(frame.canvasCssToLogical(canvasPoint)).toEqual(persistedPoint);
    expect(JSON.stringify(persistedPoint)).toBe(persistedBytes);
  });

  it('derives one logical viewport from the measured Canvas and document origins', () => {
    const frame = createInkStageFrame({
      actualScale: 0.5,
      canvasClientRect: { height: 450, left: 240, top: 70, width: 680 },
      documentClientOrigin: { x: 407, y: 140 },
    });

    expect(frame.logicalViewport).toEqual({
      height: 900,
      left: -334,
      top: -140,
      width: 1360,
    });
  });

  it('absorbs a sidebar resize into a newly measured frame instead of reconstructing centering', () => {
    const beforeResize = createInkStageFrame({
      actualScale: 1,
      canvasClientRect: { height: 900, left: 100, top: 70, width: 1200 },
      documentClientOrigin: { x: 348, y: 140 },
    });
    const afterResize = createInkStageFrame({
      actualScale: 0.75,
      canvasClientRect: { height: 900, left: 100, top: 70, width: 900 },
      documentClientOrigin: { x: 286, y: 140 },
    });
    const landmark = { x: 80, y: 160 };

    expect(beforeResize.logicalToCanvasCss(landmark)).toEqual({ x: 328, y: 230 });
    expect(afterResize.logicalToCanvasCss(landmark)).toEqual({ x: 246, y: 190 });
    expect(afterResize.canvasCssToLogical({ x: 246, y: 190 })).toEqual(landmark);
  });

  it('round-trips nonzero and fractional coordinates through all coordinate spaces', () => {
    const frame = createInkStageFrame({
      actualScale: 0.87358,
      canvasClientRect: { height: 891, left: 244, top: 70, width: 679 },
      documentClientOrigin: { x: 276.125, y: 123.5 },
    });
    const logical = { x: -41.75, y: 153.4375 };
    const client = frame.logicalToClient(logical);
    const canvasCss = frame.logicalToCanvasCss(logical);

    expect(frame.clientToLogical(client).x).toBeCloseTo(logical.x, 12);
    expect(frame.clientToLogical(client).y).toBeCloseTo(logical.y, 12);
    expect(frame.canvasCssToLogical(canvasCss).x).toBeCloseTo(logical.x, 12);
    expect(frame.canvasCssToLogical(canvasCss).y).toBeCloseTo(logical.y, 12);
  });

  it('produces the complete DPR-aware Canvas backing-store matrix', () => {
    const frame = createInkStageFrame({
      actualScale: 0.5,
      canvasClientRect: { height: 800, left: 240, top: 70, width: 1000 },
      documentClientOrigin: { x: 407, y: 140 },
    });

    expect(frame.canvasBackingTransform(2)).toEqual({
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 334,
      f: 140,
    });
  });

  it.each([
    {
      input: {
        actualScale: 0,
        canvasClientRect: { height: 800, left: 0, top: 0, width: 1000 },
        documentClientOrigin: { x: 0, y: 0 },
      },
      message: 'Ink Stage Frame scale must be positive.',
    },
    {
      input: {
        actualScale: 1,
        canvasClientRect: { height: 800, left: 0, top: 0, width: Number.NaN },
        documentClientOrigin: { x: 0, y: 0 },
      },
      message: 'Ink Stage Frame Canvas width must be positive.',
    },
    {
      input: {
        actualScale: 1,
        canvasClientRect: { height: 800, left: 0, top: 0, width: 1000 },
        documentClientOrigin: { x: Number.POSITIVE_INFINITY, y: 0 },
      },
      message: 'Ink Stage Frame document origin x must be finite.',
    },
  ])('rejects invalid measured facts', ({ input, message }) => {
    expect(() => createInkStageFrame(input)).toThrow(message);
  });

  it('publishes frozen frame values so one update cannot be partially mutated', () => {
    const frame = createInkStageFrame({
      actualScale: 1,
      canvasClientRect: { height: 800, left: 40, top: 60, width: 1000 },
      documentClientOrigin: { x: 100, y: 120 },
    });
    const point = frame.logicalToClient({ x: 1, y: 2 });
    const transform = frame.canvasBackingTransform(2);

    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.logicalViewport)).toBe(true);
    expect(Object.isFrozen(point)).toBe(true);
    expect(Object.isFrozen(transform)).toBe(true);
  });
});
