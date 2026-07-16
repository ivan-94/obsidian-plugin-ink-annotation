export const INK_DOCUMENT_LOGICAL_WIDTH = 704;
export const INK_FIT_GUTTER = 20;
export const INK_ZOOM_MIN = 0.5;
export const INK_ZOOM_MAX = 2;
export const INK_ZOOM_STEP = 0.1;

export interface InkViewportGeometry {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export function fitInkWorkspaceScale(
  paneWidth: number,
  documentWidth: number,
  gutter = INK_FIT_GUTTER,
): number {
  assertPositive(paneWidth, 'Ink pane width');
  assertPositive(documentWidth, 'Ink document width');
  if (!Number.isFinite(gutter) || gutter < 0) {
    throw new Error('Ink fit gutter must be finite and non-negative.');
  }
  return clamp((paneWidth - gutter * 2) / documentWidth, INK_ZOOM_MIN, 1);
}

export function stepInkWorkspaceScale(scale: number, direction: -1 | 1): number {
  assertPositive(scale, 'Ink workspace scale');
  return clamp(roundScale(scale + direction * INK_ZOOM_STEP), INK_ZOOM_MIN, INK_ZOOM_MAX);
}

export function inkViewportGeometry(input: {
  readonly documentLeft: number;
  readonly documentTop: number;
  readonly paneHeight: number;
  readonly paneLeft: number;
  readonly paneTop: number;
  readonly paneWidth: number;
  readonly scale: number;
}): InkViewportGeometry {
  assertFinite(input.documentLeft, 'Ink document left');
  assertFinite(input.documentTop, 'Ink document top');
  assertPositive(input.paneHeight, 'Ink pane height');
  assertFinite(input.paneLeft, 'Ink pane left');
  assertFinite(input.paneTop, 'Ink pane top');
  assertPositive(input.paneWidth, 'Ink pane width');
  assertPositive(input.scale, 'Ink workspace scale');
  return {
    height: input.paneHeight / input.scale,
    left: (input.paneLeft - input.documentLeft) / input.scale,
    top: (input.paneTop - input.documentTop) / input.scale,
    width: input.paneWidth / input.scale,
  };
}

function roundScale(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive.`);
}
