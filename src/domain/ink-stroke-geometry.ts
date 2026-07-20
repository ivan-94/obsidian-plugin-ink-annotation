import {
  INK_SAMPLE_FLAGS,
  type InkContactStyleSnapshot,
  type InkSampleCursor,
} from './ink-contact';
import type { InkBorrowedControlTraceDelta, InkLegacyTraceDelta } from './ink-control-trace';
import type { InkBrushRenderVersion } from './ink-brush-contract';
import type {
  InkCompiledBrushGeometry,
  InkPromotedBrushGeometry,
} from './ink-brush-geometry-contract';
import type { InkPoint, InkStroke } from './ink-surface';

export const LEGACY_ROUND_BRUSH_VERSION = 'legacy-round-v1' as const;

export interface InkGeometryBounds {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface InkGeometryPaint {
  readonly color: string;
  readonly composite: 'source-over';
  readonly lineCap: 'round';
  readonly lineJoin: 'round';
  readonly opacity: number;
}

export interface CompiledInkStroke {
  readonly bounds: InkGeometryBounds;
  /** Present when the S33 shared Brush Geometry seam owns rasterization. */
  readonly brushGeometry?: InkCompiledBrushGeometry;
  /** Present only for a process-local Active-to-Committed ownership transfer. */
  readonly promotedBrushGeometry?: InkPromotedBrushGeometry;
  readonly byteSizeEstimate: number;
  readonly digest: string;
  readonly paint: InkGeometryPaint;
  readonly points: readonly InkPoint[];
  readonly strokeId: string;
  readonly tool: InkStroke['tool'];
  readonly version: InkBrushRenderVersion;
  readonly width: number;
}

export interface LegacyActiveGeometryState {
  readonly mutableTail: readonly InkPoint[];
  readonly paint: InkGeometryPaint;
  readonly stableLast: InkPoint | null;
  readonly stableSegmentCount: number;
  readonly strokeId: string;
  readonly tool: InkStroke['tool'];
  readonly width: number;
}

export interface InkActiveGeometryInput {
  readonly delta: InkLegacyTraceDelta;
  readonly strokeId: string;
  readonly style: InkContactStyleSnapshot;
}

export interface InkActiveGeometryDelta {
  readonly mutablePath: readonly InkPoint[];
  readonly stablePathDelta: readonly InkPoint[];
  readonly state: LegacyActiveGeometryState;
}

export interface InkActivePresentationState {
  readonly mutableTailSampleCount: number;
  readonly paint: InkGeometryPaint;
  readonly stableSegmentCount: number;
  readonly strokeId: string;
  readonly tool: InkStroke['tool'];
  readonly width: number;
}

/** Writer methods must synchronously copy every cursor value they retain. */
export interface InkActivePresentationWriter {
  appendMutable(sample: InkSampleCursor): void;
  appendStable(sample: InkSampleCursor): void;
  resetMutable(): void;
}

export interface InkActivePresentationSession {
  extend(
    delta: InkBorrowedControlTraceDelta,
    writer: InkActivePresentationWriter,
  ): InkActivePresentationState;
}

export interface InkStrokeGeometry {
  beginActivePresentation(input: {
    readonly strokeId: string;
    readonly style: InkContactStyleSnapshot;
  }): InkActivePresentationSession;
  bounds(stroke: InkStroke): InkGeometryBounds;
  compile(stroke: InkStroke): CompiledInkStroke;
  extend(
    active: LegacyActiveGeometryState | null,
    input: InkActiveGeometryInput,
  ): InkActiveGeometryDelta;
  hitTest(stroke: InkStroke, point: Pick<InkPoint, 'x' | 'y'>, tolerance: number): boolean;
}

/** Pure Foundation compiler for the historical fixed-width, round-cap/round-join brush. */
export class LegacyRoundInkStrokeGeometry implements InkStrokeGeometry {
  beginActivePresentation(input: {
    readonly strokeId: string;
    readonly style: InkContactStyleSnapshot;
  }): InkActivePresentationSession {
    assertActiveIdentity(input.strokeId, input.style);
    return new LegacyRoundActivePresentationSession(input.strokeId, input.style);
  }

  bounds(stroke: InkStroke): InkGeometryBounds {
    assertLegacyStroke(stroke);
    return boundsForPath(stroke.points, stroke.width);
  }

  compile(stroke: InkStroke): CompiledInkStroke {
    assertLegacyStroke(stroke);
    const points = freezePoints(stroke.points);
    const paint = legacyPaint(stroke.tool, stroke.color);
    return Object.freeze({
      bounds: boundsForPath(points, stroke.width),
      byteSizeEstimate: 160 + points.length * 56 + paint.color.length * 2,
      digest: legacyGeometryDigest(stroke, paint),
      paint,
      points,
      strokeId: stroke.linkedStrokeId ?? stroke.id,
      tool: stroke.tool,
      version: LEGACY_ROUND_BRUSH_VERSION,
      width: stroke.width,
    });
  }

  hitTest(stroke: InkStroke, point: Pick<InkPoint, 'x' | 'y'>, tolerance: number): boolean {
    assertLegacyStroke(stroke);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error('Ink geometry hit point must be finite.');
    }
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      throw new Error('Ink geometry hit tolerance must be finite and non-negative.');
    }
    return distanceToPath(point, stroke.points) <= tolerance + stroke.width / 2;
  }

  extend(
    active: LegacyActiveGeometryState | null,
    input: InkActiveGeometryInput,
  ): InkActiveGeometryDelta {
    assertActiveInput(active, input);
    const paint = active?.paint ?? legacyPaint(input.style.tool, input.style.color);
    let stableLast = active?.stableLast ?? null;
    const stablePathDelta: InkPoint[] = [];
    let addedSegmentCount = 0;
    for (const source of input.delta.stablePrefixDelta) {
      const point = freezePoint(source);
      if (stableLast !== null && !samePoint(stableLast, point)) {
        if (stablePathDelta.length === 0) stablePathDelta.push(stableLast);
        stablePathDelta.push(point);
        addedSegmentCount += 1;
      }
      stableLast = point;
    }
    const mutableTail = freezePoints(input.delta.mutableTail);
    const nextMutablePath = mutablePath(stableLast, mutableTail);
    const state = Object.freeze({
      mutableTail,
      paint,
      stableLast,
      stableSegmentCount: (active?.stableSegmentCount ?? 0) + addedSegmentCount,
      strokeId: input.strokeId,
      tool: input.style.tool,
      width: input.style.width,
    });
    return Object.freeze({
      mutablePath: nextMutablePath,
      stablePathDelta: Object.freeze(stablePathDelta),
      state,
    });
  }
}

type ActivePresentationSample = InkSampleCursor;

class LegacyRoundActivePresentationSession implements InkActivePresentationSession {
  private readonly candidate: ActivePresentationSample = createActivePresentationSample();
  private readonly lastStable: ActivePresentationSample = createActivePresentationSample();
  private hasStable = false;
  private stableSegmentCount = 0;
  private readonly paint: InkGeometryPaint;

  constructor(
    private readonly strokeId: string,
    private readonly style: InkContactStyleSnapshot,
  ) {
    this.paint = legacyPaint(style.tool, style.color);
  }

  extend(
    delta: InkBorrowedControlTraceDelta,
    writer: InkActivePresentationWriter,
  ): InkActivePresentationState {
    if (delta.kind !== 'borrowed-numeric') {
      throw new Error('Active Ink presentation requires a borrowed numeric delta.');
    }
    let wroteStableAnchor = false;
    delta.stablePrefixDelta.forEachSample((source) => {
      copyActivePresentationSample(source, this.candidate);
      if (this.hasStable && !sameActivePresentationSample(this.lastStable, this.candidate)) {
        if (!wroteStableAnchor) {
          writer.appendStable(this.lastStable);
          wroteStableAnchor = true;
        }
        writer.appendStable(this.candidate);
        this.stableSegmentCount += 1;
      }
      copyActivePresentationSample(this.candidate, this.lastStable);
      this.hasStable = true;
    });

    writer.resetMutable();
    if (this.hasStable) writer.appendMutable(this.lastStable);
    delta.mutableTail.forEachSample((sample) => writer.appendMutable(sample));

    return Object.freeze({
      mutableTailSampleCount: delta.mutableTail.length,
      paint: this.paint,
      stableSegmentCount: this.stableSegmentCount,
      strokeId: this.strokeId,
      tool: this.style.tool,
      width: this.style.width,
    });
  }
}

export function legacyGeometryCacheKey(stroke: InkStroke, generation: number): string {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error('Ink geometry cache generation must be a non-negative integer.');
  }
  const paint = legacyPaint(stroke.tool, stroke.color);
  return [
    LEGACY_ROUND_BRUSH_VERSION,
    stroke.linkedStrokeId ?? stroke.id,
    `g${generation}`,
    legacyGeometryDigest(stroke, paint),
    `w${quantize(stroke.width)}`,
    stroke.tool,
    paint.color,
    `a${quantize(paint.opacity)}`,
    paint.composite,
  ].join('|');
}

export function boundsForPath(
  points: readonly Pick<InkPoint, 'x' | 'y'>[],
  width: number,
): InkGeometryBounds {
  if (points.length === 0) throw new Error('Ink geometry requires at least one point.');
  if (!Number.isFinite(width) || width <= 0)
    throw new Error('Ink geometry width must be positive.');
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error('Ink geometry points must be finite.');
    }
    minimumX = Math.min(minimumX, point.x);
    minimumY = Math.min(minimumY, point.y);
    maximumX = Math.max(maximumX, point.x);
    maximumY = Math.max(maximumY, point.y);
  }
  const radius = width / 2;
  return Object.freeze({
    height: maximumY - minimumY + width,
    width: maximumX - minimumX + width,
    x: minimumX - radius,
    y: minimumY - radius,
  });
}

export function unionBounds(
  ...candidates: readonly (InkGeometryBounds | null)[]
): InkGeometryBounds | null {
  const bounds = candidates.filter(
    (candidate): candidate is InkGeometryBounds => candidate !== null,
  );
  if (bounds.length === 0) return null;
  const left = Math.min(...bounds.map(({ x }) => x));
  const top = Math.min(...bounds.map(({ y }) => y));
  const right = Math.max(...bounds.map(({ width, x }) => x + width));
  const bottom = Math.max(...bounds.map(({ height, y }) => y + height));
  return Object.freeze({ height: bottom - top, width: right - left, x: left, y: top });
}

export function compiledInkVisibleBounds(
  strokes: readonly CompiledInkStroke[],
  logicalWidth: number,
  logicalHeight: number,
): {
  readonly height: number;
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
} {
  if (
    !Number.isFinite(logicalWidth) ||
    logicalWidth <= 0 ||
    !Number.isFinite(logicalHeight) ||
    logicalHeight <= 0
  ) {
    throw new Error('Ink visible geometry dimensions must be positive.');
  }
  let minimumX = 0;
  let minimumY = 0;
  let maximumX = logicalWidth;
  let maximumY = logicalHeight;
  for (const { bounds } of strokes) {
    minimumX = Math.min(minimumX, bounds.x);
    minimumY = Math.min(minimumY, bounds.y);
    maximumX = Math.max(maximumX, bounds.x + bounds.width);
    maximumY = Math.max(maximumY, bounds.y + bounds.height);
  }
  return Object.freeze({
    height: maximumY - minimumY,
    minX: minimumX,
    minY: minimumY,
    width: maximumX - minimumX,
  });
}

function assertLegacyStroke(stroke: InkStroke): void {
  if (stroke.points.length === 0)
    throw new Error(`Ink stroke ${stroke.id} has no geometry points.`);
  if (!Number.isFinite(stroke.width) || stroke.width <= 0) {
    throw new Error(`Ink stroke ${stroke.id} has an invalid geometry width.`);
  }
  if (stroke.color.length === 0) throw new Error(`Ink stroke ${stroke.id} has no geometry color.`);
  for (const point of stroke.points) {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      !Number.isFinite(point.time) ||
      !Number.isFinite(point.pressure)
    ) {
      throw new Error(`Ink stroke ${stroke.id} has a non-finite geometry point.`);
    }
  }
}

function assertActiveInput(
  active: LegacyActiveGeometryState | null,
  input: InkActiveGeometryInput,
): void {
  assertActiveIdentity(input.strokeId, input.style);
  if (active === null) return;
  if (
    active.strokeId !== input.strokeId ||
    active.tool !== input.style.tool ||
    active.width !== input.style.width ||
    active.paint.color !== legacyPaint(input.style.tool, input.style.color).color
  ) {
    throw new Error('Active Ink geometry style and identity are immutable for one contact.');
  }
}

function assertActiveIdentity(strokeId: string, style: InkContactStyleSnapshot): void {
  if (strokeId.length === 0) throw new Error('Active Ink geometry requires a stroke ID.');
  if (!Number.isFinite(style.width) || style.width <= 0) {
    throw new Error('Active Ink geometry width must be positive.');
  }
  if (style.color.length === 0) throw new Error('Active Ink geometry requires a color.');
}

function createActivePresentationSample(): ActivePresentationSample {
  return { altitude: 0, azimuth: 0, flags: 0, pressure: 0, time: 0, x: 0, y: 0 };
}

function copyActivePresentationSample(
  source: InkSampleCursor,
  target: ActivePresentationSample,
): void {
  target.x = source.x;
  target.y = source.y;
  target.time = source.time;
  target.flags = source.flags;
  target.pressure = (source.flags & INK_SAMPLE_FLAGS.pressureMeasured) === 0 ? 0 : source.pressure;
  target.altitude = (source.flags & INK_SAMPLE_FLAGS.altitudeMeasured) === 0 ? 0 : source.altitude;
  target.azimuth = (source.flags & INK_SAMPLE_FLAGS.azimuthMeasured) === 0 ? 0 : source.azimuth;
}

function sameActivePresentationSample(
  left: ActivePresentationSample,
  right: ActivePresentationSample,
): boolean {
  const leftPressure = (left.flags & INK_SAMPLE_FLAGS.pressureMeasured) === 0 ? 0.5 : left.pressure;
  const rightPressure =
    (right.flags & INK_SAMPLE_FLAGS.pressureMeasured) === 0 ? 0.5 : right.pressure;
  const leftOrientationFlags =
    left.flags & (INK_SAMPLE_FLAGS.altitudeMeasured | INK_SAMPLE_FLAGS.azimuthMeasured);
  const rightOrientationFlags =
    right.flags & (INK_SAMPLE_FLAGS.altitudeMeasured | INK_SAMPLE_FLAGS.azimuthMeasured);
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.time === right.time &&
    leftPressure === rightPressure &&
    leftOrientationFlags === rightOrientationFlags &&
    ((leftOrientationFlags & INK_SAMPLE_FLAGS.altitudeMeasured) === 0 ||
      left.altitude === right.altitude) &&
    ((leftOrientationFlags & INK_SAMPLE_FLAGS.azimuthMeasured) === 0 ||
      left.azimuth === right.azimuth)
  );
}

function legacyPaint(tool: InkStroke['tool'], sourceColor: string): InkGeometryPaint {
  const alphaColor = /^#(?<rgb>[0-9a-f]{6})(?<alpha>[0-9a-f]{2})$/iu.exec(sourceColor);
  const alpha = alphaColor?.groups?.alpha;
  const color = alphaColor?.groups?.rgb === undefined ? sourceColor : `#${alphaColor.groups.rgb}`;
  const opacity =
    alpha === undefined ? (tool === 'highlighter' ? 0.45 : 1) : Number.parseInt(alpha, 16) / 255;
  return Object.freeze({
    color,
    composite: 'source-over',
    lineCap: 'round',
    lineJoin: 'round',
    opacity,
  });
}

function mutablePath(
  stableLast: InkPoint | null,
  mutableTail: readonly InkPoint[],
): readonly InkPoint[] {
  if (stableLast === null) return mutableTail;
  if (mutableTail.length === 0) return Object.freeze([stableLast]);
  return Object.freeze([stableLast, ...mutableTail]);
}

function freezePoints(points: readonly InkPoint[]): readonly InkPoint[] {
  return Object.freeze(points.map(freezePoint));
}

function freezePoint(point: InkPoint): InkPoint {
  return Object.freeze({ ...point });
}

function samePoint(left: InkPoint, right: InkPoint): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.time === right.time &&
    left.pressure === right.pressure &&
    left.tiltX === right.tiltX &&
    left.tiltY === right.tiltY
  );
}

function distanceToPath(
  point: Pick<InkPoint, 'x' | 'y'>,
  points: readonly Pick<InkPoint, 'x' | 'y'>[],
): number {
  if (points.length === 1) {
    const only = points[0] as Pick<InkPoint, 'x' | 'y'>;
    return Math.hypot(point.x - only.x, point.y - only.y);
  }
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (start === undefined || end === undefined) continue;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const ratio =
      lengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
          );
    minimum = Math.min(
      minimum,
      Math.hypot(point.x - (start.x + dx * ratio), point.y - (start.y + dy * ratio)),
    );
  }
  return minimum;
}

function legacyGeometryDigest(stroke: InkStroke, paint: InkGeometryPaint): string {
  let digest = 0x811c9dc5;
  const add = (value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      digest ^= value.charCodeAt(index);
      digest = Math.imul(digest, 0x01000193) >>> 0;
    }
  };
  add(LEGACY_ROUND_BRUSH_VERSION);
  add(stroke.tool);
  add(paint.color);
  add(quantize(paint.opacity));
  add(quantize(stroke.width));
  for (const point of stroke.points) {
    add(quantize(point.x));
    add(quantize(point.y));
    add(quantize(point.pressure));
    add(quantize(point.time));
    add(point.tiltX === undefined ? '-' : quantize(point.tiltX));
    add(point.tiltY === undefined ? '-' : quantize(point.tiltY));
  }
  return digest.toString(16).padStart(8, '0');
}

function quantize(value: number): string {
  return (Math.round(value * 10_000) / 10_000).toString();
}
