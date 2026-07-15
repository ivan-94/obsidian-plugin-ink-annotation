export function cssPointToInkLogical(
  point: { readonly x: number; readonly y: number },
  layout: {
    readonly cssHeight: number;
    readonly cssWidth: number;
    readonly logicalHeight: number;
    readonly logicalWidth: number;
  },
): { readonly x: number; readonly y: number } {
  assertPositiveLayout(layout);
  return {
    x: clamp((point.x / layout.cssWidth) * layout.logicalWidth, 0, layout.logicalWidth),
    y: clamp((point.y / layout.cssHeight) * layout.logicalHeight, 0, layout.logicalHeight),
  };
}

export function inkLogicalToCanvasPixel(
  point: { readonly x: number; readonly y: number },
  layout: {
    readonly canvasPixelHeight: number;
    readonly canvasPixelWidth: number;
    readonly logicalHeight: number;
    readonly logicalWidth: number;
  },
): { readonly x: number; readonly y: number } {
  assertPositiveLayout(layout);
  return {
    x: (point.x / layout.logicalWidth) * layout.canvasPixelWidth,
    y: (point.y / layout.logicalHeight) * layout.canvasPixelHeight,
  };
}

function assertPositiveLayout(layout: Record<string, number>): void {
  if (Object.values(layout).some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Ink coordinate layout dimensions must be finite and positive.');
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
