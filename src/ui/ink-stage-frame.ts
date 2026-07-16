export interface CssPoint {
  readonly x: number;
  readonly y: number;
}

export interface CssRect {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export interface LogicalRect {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export interface CanvasBackingTransform {
  readonly a: number;
  readonly b: 0;
  readonly c: 0;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export interface InkStageFrameInput {
  readonly actualScale: number;
  readonly canvasClientRect: CssRect;
  readonly documentClientOrigin: CssPoint;
}

/**
 * One immutable coordinate authority for an Ink render frame.
 *
 * The frame accepts only measured client-space facts. Centering, scrolling, CSS zoom, and fixed
 * containing-block behavior belong to the DOM measurement adapter, not to this transform.
 */
export interface InkStageFrame {
  readonly actualScale: number;
  readonly canvasClientRect: CssRect;
  readonly documentClientOrigin: CssPoint;
  readonly logicalViewport: LogicalRect;
  readonly canvasBackingTransform: (devicePixelRatio: number) => CanvasBackingTransform;
  readonly canvasCssToLogical: (point: CssPoint) => CssPoint;
  readonly clientToLogical: (point: CssPoint) => CssPoint;
  readonly logicalToCanvasCss: (point: CssPoint) => CssPoint;
  readonly logicalToClient: (point: CssPoint) => CssPoint;
}

export function createInkStageFrame(input: InkStageFrameInput): InkStageFrame {
  assertPositive(input.actualScale, 'Ink Stage Frame scale');
  assertFinite(input.canvasClientRect.left, 'Ink Stage Frame Canvas left');
  assertFinite(input.canvasClientRect.top, 'Ink Stage Frame Canvas top');
  assertPositive(input.canvasClientRect.width, 'Ink Stage Frame Canvas width');
  assertPositive(input.canvasClientRect.height, 'Ink Stage Frame Canvas height');
  assertFinite(input.documentClientOrigin.x, 'Ink Stage Frame document origin x');
  assertFinite(input.documentClientOrigin.y, 'Ink Stage Frame document origin y');

  const actualScale = input.actualScale;
  const canvasClientRect = freezeRect(input.canvasClientRect);
  const documentClientOrigin = freezePoint(input.documentClientOrigin);
  const logicalViewport = Object.freeze({
    height: canvasClientRect.height / actualScale,
    left: (canvasClientRect.left - documentClientOrigin.x) / actualScale,
    top: (canvasClientRect.top - documentClientOrigin.y) / actualScale,
    width: canvasClientRect.width / actualScale,
  });

  return Object.freeze({
    actualScale,
    canvasClientRect,
    documentClientOrigin,
    logicalViewport,
    canvasBackingTransform(devicePixelRatio: number): CanvasBackingTransform {
      assertPositive(devicePixelRatio, 'Ink Stage Frame device pixel ratio');
      return Object.freeze({
        a: devicePixelRatio * actualScale,
        b: 0,
        c: 0,
        d: devicePixelRatio * actualScale,
        e: devicePixelRatio * (documentClientOrigin.x - canvasClientRect.left),
        f: devicePixelRatio * (documentClientOrigin.y - canvasClientRect.top),
      });
    },
    canvasCssToLogical(point: CssPoint): CssPoint {
      assertPoint(point, 'Ink Stage Frame Canvas point');
      return freezePoint({
        x: (canvasClientRect.left + point.x - documentClientOrigin.x) / actualScale,
        y: (canvasClientRect.top + point.y - documentClientOrigin.y) / actualScale,
      });
    },
    clientToLogical(point: CssPoint): CssPoint {
      assertPoint(point, 'Ink Stage Frame client point');
      return freezePoint({
        x: (point.x - documentClientOrigin.x) / actualScale,
        y: (point.y - documentClientOrigin.y) / actualScale,
      });
    },
    logicalToCanvasCss(point: CssPoint): CssPoint {
      assertPoint(point, 'Ink Stage Frame logical point');
      return freezePoint({
        x: documentClientOrigin.x + actualScale * point.x - canvasClientRect.left,
        y: documentClientOrigin.y + actualScale * point.y - canvasClientRect.top,
      });
    },
    logicalToClient(point: CssPoint): CssPoint {
      assertPoint(point, 'Ink Stage Frame logical point');
      return freezePoint({
        x: documentClientOrigin.x + actualScale * point.x,
        y: documentClientOrigin.y + actualScale * point.y,
      });
    },
  });
}

function freezePoint(point: CssPoint): CssPoint {
  return Object.freeze({ x: point.x, y: point.y });
}

function freezeRect(rect: CssRect): CssRect {
  return Object.freeze({ height: rect.height, left: rect.left, top: rect.top, width: rect.width });
}

function assertPoint(point: CssPoint, label: string): void {
  assertFinite(point.x, `${label} x`);
  assertFinite(point.y, `${label} y`);
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive.`);
}
