import type {
  InkCompiledBrushGeometry,
  InkPromotedBrushGeometry,
} from '../domain/ink-brush-geometry-contract';

type InkCanvasBrushGeometry = InkCompiledBrushGeometry | InkPromotedBrushGeometry;

/**
 * Canvas 2D projection of the shared renderer-neutral Brush Geometry contract. Quantized contour
 * coordinates are converted to logical pixels here; DPR and zoom remain owned by the caller's
 * Canvas transform and never alter canonical geometry.
 */
export function drawInkBrushGeometryToCanvas(
  context: CanvasRenderingContext2D,
  geometry: InkCanvasBrushGeometry,
): void {
  context.save();
  try {
    context.globalCompositeOperation = geometry.blend.composite;
    if (geometry.version !== 'legacy-round-v1') {
      context.globalAlpha = geometry.blend.alpha.value;
      context.fillStyle = geometry.color;
      appendFilledContours(context, geometry);
      return;
    }

    const paint = legacyCanvasPaint(geometry.tool, geometry.color);
    context.globalAlpha = paint.alpha;
    context.fillStyle = paint.color;
    context.strokeStyle = paint.color;
    context.lineWidth = geometry.coverage.diameterUnits * geometry.quantization.logicalGrid;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    appendLegacyCenterline(context, geometry);
  } finally {
    context.restore();
  }
}

/** Draw transient hover/selection chrome from the same coverage that owns hit testing. */
export function drawInkBrushSelectionChromeToCanvas(
  context: CanvasRenderingContext2D,
  geometry: InkCanvasBrushGeometry,
  color: string,
  expansion: number,
): void {
  if (!Number.isFinite(expansion) || expansion < 0) {
    throw new Error('Ink Brush selection expansion must be finite and non-negative.');
  }
  context.save();
  try {
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.fillStyle = color;
    context.strokeStyle = color;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (geometry.version !== 'legacy-round-v1') {
      context.lineWidth = expansion * 2;
      appendFilledContourPath(context, geometry);
      context.stroke();
      return;
    }

    const first = geometry.coverage.centerline[0];
    if (first === undefined) return;
    const grid = geometry.quantization.logicalGrid;
    if (geometry.coverage.centerline.length === 1) {
      context.beginPath();
      context.arc(
        first.x * grid,
        first.y * grid,
        geometry.hitShape.radius + expansion,
        0,
        Math.PI * 2,
      );
      context.fill('nonzero');
      return;
    }
    context.lineWidth = geometry.coverage.diameterUnits * grid + expansion * 2;
    appendLegacyCenterline(context, geometry);
  } finally {
    context.restore();
  }
}

function appendFilledContours(
  context: CanvasRenderingContext2D,
  geometry: Exclude<InkCanvasBrushGeometry, { readonly version: 'legacy-round-v1' }>,
): void {
  appendFilledContourPath(context, geometry);
  // One fill call is the once-per-Logical-Stroke isolation boundary. Overlapping contour chunks
  // therefore do not multiply Highlighter alpha.
  context.fill(geometry.hitShape.fillRule);
}

function appendFilledContourPath(
  context: CanvasRenderingContext2D,
  geometry: Exclude<InkCanvasBrushGeometry, { readonly version: 'legacy-round-v1' }>,
): void {
  const grid = geometry.quantization.logicalGrid;
  context.beginPath();
  const appendCoverage = (coverage: InkCompiledBrushGeometry['coverage']): void => {
    if (coverage.kind !== 'quantized-filled-contours') return;
    for (const contour of coverage.contours) {
      const first = contour[0];
      if (first === undefined) continue;
      context.moveTo(first.x * grid, first.y * grid);
      for (let index = 1; index < contour.length; index += 1) {
        const point = contour[index];
        if (point !== undefined) context.lineTo(point.x * grid, point.y * grid);
      }
      context.closePath();
    }
  };
  if ('coverageChunks' in geometry) {
    for (const group of geometry.coverageChunks) {
      for (const coverage of group) appendCoverage(coverage);
    }
  } else {
    appendCoverage(geometry.coverage);
  }
}

function appendLegacyCenterline(
  context: CanvasRenderingContext2D,
  geometry: Extract<InkCompiledBrushGeometry, { readonly version: 'legacy-round-v1' }>,
): void {
  const { centerline } = geometry.coverage;
  const first = centerline[0];
  if (first === undefined) return;
  const grid = geometry.quantization.logicalGrid;
  const firstX = first.x * grid;
  const firstY = first.y * grid;
  context.beginPath();
  if (centerline.length === 1) {
    context.arc(firstX, firstY, geometry.hitShape.radius, 0, Math.PI * 2);
    context.fill('nonzero');
    return;
  }
  context.moveTo(firstX, firstY);
  for (let index = 1; index < centerline.length; index += 1) {
    const point = centerline[index];
    if (point !== undefined) context.lineTo(point.x * grid, point.y * grid);
  }
  context.stroke();
}

function legacyCanvasPaint(
  tool: Extract<InkCompiledBrushGeometry, { readonly version: 'legacy-round-v1' }>['tool'],
  sourceColor: string,
): { readonly alpha: number; readonly color: string } {
  const alphaColor = /^#(?<rgb>[0-9a-f]{6})(?<alpha>[0-9a-f]{2})$/iu.exec(sourceColor);
  const alpha = alphaColor?.groups?.alpha;
  const rgb = alphaColor?.groups?.rgb;
  return Object.freeze({
    alpha:
      alpha === undefined ? (tool === 'highlighter' ? 0.45 : 1) : Number.parseInt(alpha, 16) / 255,
    color: rgb === undefined ? sourceColor : `#${rgb}`,
  });
}
