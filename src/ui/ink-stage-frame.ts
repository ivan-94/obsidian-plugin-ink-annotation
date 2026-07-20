export interface CssPoint {
  readonly x: number;
  readonly y: number;
}

export interface MutableCssPoint {
  x: number;
  y: number;
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
  readonly clientToLogicalInto: (point: CssPoint, target: MutableCssPoint) => MutableCssPoint;
  readonly logicalToCanvasCss: (point: CssPoint) => CssPoint;
  readonly logicalToClient: (point: CssPoint) => CssPoint;
}

const INK_STAGE_FRAME_CSS_EPSILON = 1 / 64;
const INK_STAGE_FRAME_SCALE_EPSILON = 1e-6;

/**
 * Treats browser layout quantization noise as the same presentation frame. WebKit can report
 * equivalent CSS-zoom geometry a few hundredths of a pixel apart across ResizeObserver turns;
 * rebuilding every Canvas for that noise turns an idle observer callback into O(visible strokes).
 */
export function sameInkStageFrame(left: InkStageFrame | null, right: InkStageFrame): boolean {
  return (
    left !== null &&
    approximately(left.actualScale, right.actualScale, INK_STAGE_FRAME_SCALE_EPSILON) &&
    approximately(
      left.canvasClientRect.left,
      right.canvasClientRect.left,
      INK_STAGE_FRAME_CSS_EPSILON,
    ) &&
    approximately(
      left.canvasClientRect.top,
      right.canvasClientRect.top,
      INK_STAGE_FRAME_CSS_EPSILON,
    ) &&
    approximately(
      left.canvasClientRect.width,
      right.canvasClientRect.width,
      INK_STAGE_FRAME_CSS_EPSILON,
    ) &&
    approximately(
      left.canvasClientRect.height,
      right.canvasClientRect.height,
      INK_STAGE_FRAME_CSS_EPSILON,
    ) &&
    approximately(
      left.documentClientOrigin.x,
      right.documentClientOrigin.x,
      INK_STAGE_FRAME_CSS_EPSILON,
    ) &&
    approximately(
      left.documentClientOrigin.y,
      right.documentClientOrigin.y,
      INK_STAGE_FRAME_CSS_EPSILON,
    )
  );
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
    clientToLogicalInto(point: CssPoint, target: MutableCssPoint): MutableCssPoint {
      assertPoint(point, 'Ink Stage Frame client point');
      target.x = (point.x - documentClientOrigin.x) / actualScale;
      target.y = (point.y - documentClientOrigin.y) / actualScale;
      return target;
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

function approximately(left: number, right: number, epsilon: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= epsilon;
}
