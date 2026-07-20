import type {
  InkDocumentReadView,
  InkLogicalRect,
  InkRenderableStrokeRef,
} from '../application/ink-document-session';
import type { InkStroke } from '../domain/ink-surface';
import type { InkSurfaceSessionSnapshot } from '../application/ink-surface-session';

export function createTestInkReadView(
  snapshot: InkSurfaceSessionSnapshot,
  generation = 0,
): InkDocumentReadView {
  const strokes = snapshot.surface.strokes.map((stroke, order) => ({
    bounds: strokeBounds(stroke),
    id: stroke.id,
    order,
    stroke,
  }));
  return {
    documentId: `test:${snapshot.surface.id}`,
    generation,
    indexBytes: 0,
    logicalHeight: snapshot.surface.layout.logicalHeight,
    logicalWidth: snapshot.surface.layout.logicalWidth,
    persistence: snapshot.persistence,
    selection: [],
    state: snapshot.state,
    strokeCount: strokes.length,
    strokes,
  };
}

export function queryTestInkReadView(
  read: InkDocumentReadView,
  viewport: InkLogicalRect,
): readonly InkRenderableStrokeRef[] {
  return read.strokes.filter(({ bounds }) => intersects(bounds, viewport));
}

function strokeBounds(stroke: InkStroke): InkLogicalRect {
  const radius = stroke.width / 2;
  return {
    height:
      Math.max(...stroke.points.map(({ y }) => y + radius)) -
      Math.min(...stroke.points.map(({ y }) => y - radius)),
    width:
      Math.max(...stroke.points.map(({ x }) => x + radius)) -
      Math.min(...stroke.points.map(({ x }) => x - radius)),
    x: Math.min(...stroke.points.map(({ x }) => x - radius)),
    y: Math.min(...stroke.points.map(({ y }) => y - radius)),
  };
}

function intersects(left: InkLogicalRect, right: InkLogicalRect): boolean {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
  );
}
