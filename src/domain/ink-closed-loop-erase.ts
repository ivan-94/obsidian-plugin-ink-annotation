import type { InkPoint, InkStroke } from './ink-surface';

const GEOMETRY_EPSILON = 1e-7;
const REQUIRED_CENTERLINE_COVERAGE = 0.7;

interface PointBounds {
  readonly maximumX: number;
  readonly maximumY: number;
  readonly minimumX: number;
  readonly minimumY: number;
}

export function logicalStrokeIdsCoveredByPolygon(
  strokes: readonly InkStroke[],
  polygon: readonly InkPoint[],
): readonly string[] {
  const polygonBounds = pointBounds(polygon);
  if (!isValidPolygon(polygon, polygonBounds)) return [];
  const logicalStrokes = new Map<string, InkStroke[]>();
  for (const stroke of strokes) {
    if (stroke.tool === 'eraser') continue;
    const identity = stroke.linkedStrokeId ?? stroke.id;
    const fragments = logicalStrokes.get(identity) ?? [];
    fragments.push(stroke);
    logicalStrokes.set(identity, fragments);
  }
  return [...logicalStrokes]
    .filter(([, fragments]) => logicalStrokeCovered(fragments, polygon, polygonBounds))
    .map(([identity]) => identity);
}

// This is a boundary-inclusive clipped-line coverage predicate: split the centerline at polygon
// intersections, classify each interval, then compare covered length with total length. It uses the
// same split-and-classify structure as standard LineString/Polygon predicates while preserving the
// product's even-odd self-intersection and boundary-only contracts.

function isValidPolygon(
  polygon: readonly InkPoint[],
  bounds: PointBounds | null,
): bounds is PointBounds {
  if (
    polygon.length < 3 ||
    bounds === null ||
    polygon.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))
  ) {
    return false;
  }
  const distinct = new Set(polygon.map(({ x, y }) => `${x}:${y}`));
  if (distinct.size < 3) return false;
  return (
    bounds.maximumX - bounds.minimumX > GEOMETRY_EPSILON &&
    bounds.maximumY - bounds.minimumY > GEOMETRY_EPSILON
  );
}

function logicalStrokeCovered(
  fragments: readonly InkStroke[],
  polygon: readonly InkPoint[],
  polygonBounds: PointBounds,
): boolean {
  let coveredLength = 0;
  let totalLength = 0;
  for (const fragment of fragments) {
    const coverage = strokeCenterlineCoverage(fragment, polygon, polygonBounds);
    if (coverage === null || !coverage.stationaryPointsCovered) return false;
    coveredLength += coverage.coveredLength;
    totalLength += coverage.totalLength;
  }
  return (
    totalLength <= GEOMETRY_EPSILON ||
    coveredLength / totalLength >= REQUIRED_CENTERLINE_COVERAGE - GEOMETRY_EPSILON
  );
}

interface StrokeCenterlineCoverage {
  readonly coveredLength: number;
  readonly stationaryPointsCovered: boolean;
  readonly totalLength: number;
}

function strokeCenterlineCoverage(
  stroke: InkStroke,
  polygon: readonly InkPoint[],
  polygonBounds: PointBounds,
): StrokeCenterlineCoverage | null {
  const strokeBounds = pointBounds(stroke.points);
  if (strokeBounds === null) return null;
  let coveredLength = 0;
  let totalLength = 0;
  let hasNonStationarySegment = false;
  const canIntersectPolygon = boundsOverlap(polygonBounds, strokeBounds);
  for (let index = 1; index < stroke.points.length; index += 1) {
    const start = stroke.points[index - 1];
    const end = stroke.points[index];
    if (start === undefined || end === undefined) continue;
    const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
    if (segmentLength <= GEOMETRY_EPSILON) continue;
    hasNonStationarySegment = true;
    totalLength += segmentLength;
    if (!canIntersectPolygon) continue;
    const parameters = segmentBoundaryParameters(start, end, polygon);
    for (let parameterIndex = 1; parameterIndex < parameters.length; parameterIndex += 1) {
      const before = parameters[parameterIndex - 1];
      const after = parameters[parameterIndex];
      if (before === undefined || after === undefined || after - before <= GEOMETRY_EPSILON) {
        continue;
      }
      const midpoint = (before + after) / 2;
      if (pointInPolygon(pointAlongSegment(start, end, midpoint), polygon)) {
        coveredLength += segmentLength * (after - before);
      }
    }
  }
  return {
    coveredLength,
    stationaryPointsCovered:
      hasNonStationarySegment || stroke.points.every((point) => pointInPolygon(point, polygon)),
    totalLength,
  };
}

function pointBounds(
  points: readonly { readonly x: number; readonly y: number }[],
): PointBounds | null {
  if (points.length === 0) return null;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  for (const { x, y } of points) {
    maximumX = Math.max(maximumX, x);
    maximumY = Math.max(maximumY, y);
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
  }
  if (![maximumX, maximumY, minimumX, minimumY].every(Number.isFinite)) return null;
  return { maximumX, maximumY, minimumX, minimumY };
}

function boundsOverlap(left: PointBounds, right: PointBounds): boolean {
  return (
    left.minimumX <= right.maximumX + GEOMETRY_EPSILON &&
    left.maximumX >= right.minimumX - GEOMETRY_EPSILON &&
    left.minimumY <= right.maximumY + GEOMETRY_EPSILON &&
    left.maximumY >= right.minimumY - GEOMETRY_EPSILON
  );
}

function segmentBoundaryParameters(
  start: InkPoint,
  end: InkPoint,
  polygon: readonly InkPoint[],
): readonly number[] {
  const parameters = [0, 1];
  const direction = { x: end.x - start.x, y: end.y - start.y };
  const lengthSquared = direction.x * direction.x + direction.y * direction.y;
  if (lengthSquared <= GEOMETRY_EPSILON) return parameters;

  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index];
    const edgeEnd = polygon[(index + 1) % polygon.length];
    if (edgeStart === undefined || edgeEnd === undefined) continue;
    const edgeDirection = { x: edgeEnd.x - edgeStart.x, y: edgeEnd.y - edgeStart.y };
    const relative = { x: edgeStart.x - start.x, y: edgeStart.y - start.y };
    const denominator = cross(direction, edgeDirection);
    if (Math.abs(denominator) > GEOMETRY_EPSILON) {
      const parameter = cross(relative, edgeDirection) / denominator;
      const edgeParameter = cross(relative, direction) / denominator;
      if (
        parameter >= -GEOMETRY_EPSILON &&
        parameter <= 1 + GEOMETRY_EPSILON &&
        edgeParameter >= -GEOMETRY_EPSILON &&
        edgeParameter <= 1 + GEOMETRY_EPSILON
      ) {
        parameters.push(clampUnit(parameter));
      }
      continue;
    }
    if (Math.abs(cross(relative, direction)) > GEOMETRY_EPSILON) continue;
    parameters.push(
      clampUnit(dot(relative, direction) / lengthSquared),
      clampUnit(dot({ x: edgeEnd.x - start.x, y: edgeEnd.y - start.y }, direction) / lengthSquared),
    );
  }

  return parameters
    .sort((left, right) => left - right)
    .filter(
      (value, index, all) => index === 0 || value - (all[index - 1] as number) > GEOMETRY_EPSILON,
    );
}

function pointAlongSegment(start: InkPoint, end: InkPoint, parameter: number): InkPoint {
  return {
    ...start,
    x: start.x + (end.x - start.x) * parameter,
    y: start.y + (end.y - start.y) * parameter,
  };
}

function cross(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): number {
  return left.x * right.y - left.y * right.x;
}

function dot(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): number {
  return left.x * right.x + left.y * right.y;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function pointInPolygon(point: InkPoint, polygon: readonly InkPoint[]): boolean {
  let inside = false;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    if (start === undefined || end === undefined) continue;
    if (pointOnSegment(point, start, end)) return true;
    if (
      start.y > point.y !== end.y > point.y &&
      point.x < ((end.x - start.x) * (point.y - start.y)) / (end.y - start.y) + start.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function pointOnSegment(point: InkPoint, start: InkPoint, end: InkPoint): boolean {
  const cross = (point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x);
  if (Math.abs(cross) > GEOMETRY_EPSILON) return false;
  return (
    point.x >= Math.min(start.x, end.x) &&
    point.x <= Math.max(start.x, end.x) &&
    point.y >= Math.min(start.y, end.y) &&
    point.y <= Math.max(start.y, end.y)
  );
}
