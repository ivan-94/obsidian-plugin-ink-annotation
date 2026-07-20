import {
  createInkBrushCompiledGeometry,
  createInkBrushLogicalStroke,
  digestInkBrushControlTrace,
} from './ink-brush-geometry-contract';
import type {
  InkBrushCompilationResult,
  InkBrushLogicalStroke,
  InkCompiledBrushGeometry,
  InkQuantizedBrushPoint,
} from './ink-brush-geometry-contract';
import { compileInkHighlighterPhysicalGeometry } from './ink-highlighter-physical-geometry';
import { compileInkPenPhysicalGeometry } from './ink-pen-physical-geometry';
import { LegacyRoundInkStrokeGeometry, unionBounds } from './ink-stroke-geometry';
import type { InkPhysicalPoint, InkStroke } from './ink-surface';

const LEGACY_LOGICAL_GRID = 1 / 10_000;
const LEGACY_TRACE_QUANTIZATION = Object.freeze({
  coordinateGrid: LEGACY_LOGICAL_GRID,
  sensorGrid: LEGACY_LOGICAL_GRID,
  timeGridMs: LEGACY_LOGICAL_GRID,
});
type LegacyLogicalStroke = Extract<
  InkBrushLogicalStroke,
  { readonly header: { readonly version: 'legacy-round-v1' } }
>;

/**
 * Closed domain seam between canonical Ink and renderer-neutral Brush Geometry.
 *
 * Physical Brush Render Versions remain reserved candidates; this seam can rebuild their
 * disposable geometry but does not publish them or enable production capture.
 */
export class SharedInkStrokeGeometry {
  private readonly legacy = new LegacyRoundInkStrokeGeometry();

  compile(stroke: InkStroke): InkBrushCompilationResult {
    const requestedVersion = String(stroke.brushRenderVersion ?? 'legacy-round-v1');
    let logicalStroke: InkBrushLogicalStroke;
    try {
      logicalStroke = this.toLogicalStroke(stroke);
    } catch {
      return Object.freeze({
        kind: 'unsupported',
        reason: isKnownBrushVersion(requestedVersion)
          ? 'invalid-canonical-stroke'
          : 'unknown-version',
        requestedVersion,
      });
    }
    switch (logicalStroke.header.version) {
      case 'pen-physical-v1':
        return compileInkPenPhysicalGeometry(logicalStroke);
      case 'highlighter-chisel-v1':
        return compileInkHighlighterPhysicalGeometry(logicalStroke);
      case 'legacy-round-v1': {
        try {
          if (!isLegacyLogicalStroke(logicalStroke)) {
            throw new Error('Legacy Ink Brush trace does not match its version.');
          }
          return Object.freeze({
            geometry: compileLegacyBrushGeometry(stroke, logicalStroke, this.legacy),
            kind: 'exact',
          });
        } catch {
          return Object.freeze({
            kind: 'unsupported',
            reason: 'invalid-canonical-stroke',
            requestedVersion,
          });
        }
      }
    }
  }

  bounds(stroke: InkStroke): InkCompiledBrushGeometry['bounds'] {
    return requireGeometry(this.compile(stroke)).bounds;
  }

  hitTest(
    stroke: InkStroke,
    point: { readonly x: number; readonly y: number },
    tolerance: number,
  ): boolean {
    return this.hitTestCompiled(requireGeometry(this.compile(stroke)), point, tolerance);
  }

  /** Hit-test already-cached logical geometry without recompiling its canonical trace. */
  hitTestCompiled(
    geometry: InkCompiledBrushGeometry,
    point: { readonly x: number; readonly y: number },
    tolerance: number,
  ): boolean {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error('Ink geometry hit point must be finite.');
    }
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      throw new Error('Ink geometry hit tolerance must be finite and non-negative.');
    }
    const { bounds } = geometry;
    if (
      point.x < bounds.x - tolerance ||
      point.y < bounds.y - tolerance ||
      point.x > bounds.x + bounds.width + tolerance ||
      point.y > bounds.y + bounds.height + tolerance
    ) {
      return false;
    }
    return hitCompiledGeometry(geometry, point, tolerance);
  }

  toLogicalStroke(stroke: InkStroke): InkBrushLogicalStroke {
    const version = stroke.brushRenderVersion ?? 'legacy-round-v1';
    const logicalStrokeId = stroke.linkedStrokeId ?? stroke.id;
    if (version === 'legacy-round-v1') {
      if (
        stroke.points.some(
          (point) => Object.hasOwn(point, 'orientation') || Object.hasOwn(point, 'pressureKind'),
        )
      ) {
        throw new Error('Legacy Ink cannot consume physical Brush Control Trace points.');
      }
      return createInkBrushLogicalStroke({
        header: {
          color: stroke.color,
          inputProfile: stroke.inputProfile ?? {
            pressure: 'legacy-unknown',
            tilt: 'legacy-unknown',
          },
          logicalStrokeId,
          nominalWidth: stroke.width,
          tool: stroke.tool,
          version,
        },
        trace: {
          kind: 'legacy-round-control-trace',
          points: stroke.points.map((point) => ({
            orientation: { kind: 'legacy-unknown' },
            pressure: point.pressure,
            time: point.time,
            x: point.x,
            y: point.y,
          })),
        },
      });
    }
    if (version === 'pen-physical-v1' || version === 'highlighter-chisel-v1') {
      return createInkBrushLogicalStroke({
        header: {
          color: stroke.color,
          inputProfile: stroke.inputProfile,
          logicalStrokeId,
          nominalWidth: stroke.width,
          tool: stroke.tool,
          version,
        },
        trace: {
          kind: 'physical-control-trace',
          points: stroke.points.map((point) => physicalControlPoint(point as InkPhysicalPoint)),
        },
      });
    }
    throw new Error(`Unknown Ink Brush Render Version: ${String(version)}`);
  }
}

function compileLegacyBrushGeometry(
  canonicalStroke: InkStroke,
  logicalStroke: LegacyLogicalStroke,
  legacy: LegacyRoundInkStrokeGeometry,
): InkCompiledBrushGeometry {
  const historical = legacy.compile(canonicalStroke);
  const centerline = logicalStroke.trace.points.map((point) =>
    Object.freeze({
      x: quantizeCoordinate(point.x, LEGACY_LOGICAL_GRID),
      y: quantizeCoordinate(point.y, LEGACY_LOGICAL_GRID),
    }),
  );
  const diameterUnits = Math.round(logicalStroke.header.nominalWidth / LEGACY_LOGICAL_GRID);
  if (!Number.isSafeInteger(diameterUnits) || diameterUnits <= 0) {
    throw new Error('Legacy Ink geometry width exceeds its quantized contract.');
  }
  const quantizedBounds = boundsForRoundCenterline(centerline, diameterUnits, LEGACY_LOGICAL_GRID);
  const bounds = unionBounds(historical.bounds, quantizedBounds);
  if (bounds === null) throw new Error('Legacy Ink geometry has no bounds.');
  return createInkBrushCompiledGeometry({
    blend: {
      alpha: { kind: 'from-canonical-color' },
      application: 'once-per-logical-stroke',
      colorSpace: 'srgb',
      composite: 'source-over',
    },
    bounds,
    color: canonicalStroke.color,
    coverage: {
      centerline,
      diameterUnits,
      kind: 'legacy-round-centerline',
    },
    hitShape: {
      kind: 'round-centerline-distance',
      radius: (diameterUnits * LEGACY_LOGICAL_GRID) / 2,
    },
    logicalStrokeId: logicalStroke.header.logicalStrokeId,
    quantization: { logicalGrid: LEGACY_LOGICAL_GRID },
    tool: logicalStroke.header.tool,
    traceDigest: digestInkBrushControlTrace(logicalStroke, LEGACY_TRACE_QUANTIZATION),
    version: 'legacy-round-v1',
  });
}

function isLegacyLogicalStroke(stroke: InkBrushLogicalStroke): stroke is LegacyLogicalStroke {
  return (
    stroke.header.version === 'legacy-round-v1' &&
    stroke.trace.kind === 'legacy-round-control-trace'
  );
}

function boundsForRoundCenterline(
  centerline: readonly InkQuantizedBrushPoint[],
  diameterUnits: number,
  grid: number,
): InkCompiledBrushGeometry['bounds'] {
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const point of centerline) {
    minimumX = Math.min(minimumX, point.x * grid);
    minimumY = Math.min(minimumY, point.y * grid);
    maximumX = Math.max(maximumX, point.x * grid);
    maximumY = Math.max(maximumY, point.y * grid);
  }
  const radius = (diameterUnits * grid) / 2;
  return Object.freeze({
    height: maximumY - minimumY + radius * 2,
    width: maximumX - minimumX + radius * 2,
    x: minimumX - radius,
    y: minimumY - radius,
  });
}

function quantizeCoordinate(value: number, grid: number): number {
  const quantized = Math.round(value / grid);
  if (!Number.isSafeInteger(quantized)) {
    throw new Error('Ink geometry coordinate exceeds its quantized contract.');
  }
  return Object.is(quantized, -0) ? 0 : quantized;
}

function requireGeometry(result: InkBrushCompilationResult): InkCompiledBrushGeometry {
  if ('geometry' in result) return result.geometry;
  throw new Error(`Unsupported Ink Brush Geometry ${result.requestedVersion}: ${result.reason}.`);
}

function hitCompiledGeometry(
  geometry: InkCompiledBrushGeometry,
  point: { readonly x: number; readonly y: number },
  tolerance: number,
): boolean {
  const grid = geometry.quantization.logicalGrid;
  if (geometry.version === 'legacy-round-v1') {
    return (
      distanceToQuantizedPath(point, geometry.coverage.centerline, grid) <=
      geometry.hitShape.radius + tolerance
    );
  }
  const { coverage } = geometry;
  let winding = 0;
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (const contour of coverage.contours) {
    winding += windingNumber(point, contour, grid);
    minimumDistance = Math.min(minimumDistance, distanceToQuantizedPath(point, contour, grid));
  }
  return winding !== 0 || minimumDistance <= tolerance;
}

function windingNumber(
  point: { readonly x: number; readonly y: number },
  contour: readonly InkQuantizedBrushPoint[],
  grid: number,
): number {
  let winding = 0;
  for (let index = 1; index < contour.length; index += 1) {
    const start = contour[index - 1];
    const end = contour[index];
    if (start === undefined || end === undefined) continue;
    const startX = start.x * grid;
    const startY = start.y * grid;
    const endX = end.x * grid;
    const endY = end.y * grid;
    if (distanceToSegment(point, startX, startY, endX, endY) <= Number.EPSILON * 64) return 1;
    const side = (endX - startX) * (point.y - startY) - (point.x - startX) * (endY - startY);
    if (startY <= point.y) {
      if (endY > point.y && side > 0) winding += 1;
    } else if (endY <= point.y && side < 0) {
      winding -= 1;
    }
  }
  return winding;
}

function distanceToQuantizedPath(
  point: { readonly x: number; readonly y: number },
  path: readonly InkQuantizedBrushPoint[],
  grid: number,
): number {
  if (path.length === 1) {
    const only = path[0] as InkQuantizedBrushPoint;
    return Math.hypot(point.x - only.x * grid, point.y - only.y * grid);
  }
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1];
    const end = path[index];
    if (start === undefined || end === undefined) continue;
    minimum = Math.min(
      minimum,
      distanceToSegment(point, start.x * grid, start.y * grid, end.x * grid, end.y * grid),
    );
  }
  return minimum;
}

function distanceToSegment(
  point: { readonly x: number; readonly y: number },
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number {
  const dx = endX - startX;
  const dy = endY - startY;
  const lengthSquared = dx * dx + dy * dy;
  const ratio =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - startX) * dx + (point.y - startY) * dy) / lengthSquared),
        );
  return Math.hypot(point.x - (startX + dx * ratio), point.y - (startY + dy * ratio));
}

function isKnownBrushVersion(value: string): boolean {
  return (
    value === 'legacy-round-v1' || value === 'pen-physical-v1' || value === 'highlighter-chisel-v1'
  );
}

function physicalControlPoint(point: InkPhysicalPoint): {
  readonly orientation: InkPhysicalPoint['orientation'];
  readonly pressure: { readonly kind: InkPhysicalPoint['pressureKind']; readonly value: number };
  readonly time: number;
  readonly x: number;
  readonly y: number;
} {
  if (
    !Object.hasOwn(point, 'orientation') ||
    !Object.hasOwn(point, 'pressureKind') ||
    Object.hasOwn(point, 'tiltX') ||
    Object.hasOwn(point, 'tiltY')
  ) {
    throw new Error('Physical Ink requires exact physical Brush Control Trace points.');
  }
  return {
    orientation:
      point.orientation.kind === 'unavailable'
        ? { kind: 'unavailable' }
        : {
            altitude: point.orientation.altitude,
            azimuth: point.orientation.azimuth,
            kind: 'measured',
            reliable: point.orientation.reliable,
          },
    pressure: { kind: point.pressureKind, value: point.pressure },
    time: point.time,
    x: point.x,
    y: point.y,
  };
}
