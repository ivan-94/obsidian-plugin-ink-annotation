export interface InkSpikePoint {
  readonly pressure: number;
  readonly tiltX?: number;
  readonly tiltY?: number;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export interface InkSpikeSurface {
  readonly endY: number;
  readonly id: string;
  readonly startY: number;
}

export interface InkLayoutFingerprint {
  readonly blockFingerprints: readonly string[];
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly logicalWidth: number;
  readonly sourceRevision: string;
  readonly theme: string;
}

export function routeInkPointer(input: {
  readonly button: number;
  readonly pointerType: string;
  readonly spacePressed: boolean;
}): 'draw' | 'ignore' | 'pan' | 'scroll' {
  if (input.pointerType === 'touch') {
    return 'scroll';
  }
  if (input.spacePressed) {
    return 'pan';
  }
  if ((input.pointerType === 'pen' || input.pointerType === 'mouse') && input.button === 0) {
    return 'draw';
  }
  return 'ignore';
}

export function mapClientPointToLogical(
  point: { readonly clientX: number; readonly clientY: number },
  bounds: {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  },
  logical: { readonly height: number; readonly width: number },
): { readonly x: number; readonly y: number } {
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new Error('Ink canvas bounds must be positive.');
  }
  return {
    x: clamp(((point.clientX - bounds.left) / bounds.width) * logical.width, 0, logical.width),
    y: clamp(((point.clientY - bounds.top) / bounds.height) * logical.height, 0, logical.height),
  };
}

export function simplifyInkPoints(
  points: readonly InkSpikePoint[],
  tolerance: number,
): readonly InkSpikePoint[] {
  if (tolerance < 0) {
    throw new Error('Ink simplification tolerance cannot be negative.');
  }
  if (points.length <= 2) {
    return [...points];
  }
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return [];
  }
  let furthestDistance = 0;
  let furthestIndex = -1;
  for (let index = 1; index < points.length - 1; index += 1) {
    const candidate = points[index];
    if (candidate === undefined) {
      continue;
    }
    const distance = distanceToSegment(candidate, first, last);
    if (distance > furthestDistance) {
      furthestDistance = distance;
      furthestIndex = index;
    }
  }
  if (furthestIndex < 0 || furthestDistance <= tolerance) {
    return [first, last];
  }
  const left = simplifyInkPoints(points.slice(0, furthestIndex + 1), tolerance);
  const right = simplifyInkPoints(points.slice(furthestIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

export function deltaEncodeInkPoints(points: readonly InkSpikePoint[]): {
  readonly origin: InkSpikePoint | null;
  readonly points: readonly {
    readonly dp: number;
    readonly dt: number;
    readonly dx: number;
    readonly dy: number;
    readonly tiltX?: number;
    readonly tiltY?: number;
  }[];
} {
  const origin = points[0];
  if (origin === undefined) {
    return { origin: null, points: [] };
  }
  return {
    origin: { ...origin },
    points: points.slice(1).map((point, index) => {
      const previous = points[index] as InkSpikePoint;
      return {
        dp: point.pressure - previous.pressure,
        dt: point.time - previous.time,
        dx: point.x - previous.x,
        dy: point.y - previous.y,
        ...(point.tiltX === undefined ? {} : { tiltX: point.tiltX }),
        ...(point.tiltY === undefined ? {} : { tiltY: point.tiltY }),
      };
    }),
  };
}

export function splitStrokeAcrossSurfaces(
  linkedStrokeId: string,
  points: readonly InkSpikePoint[],
  surfaces: readonly InkSpikeSurface[],
): readonly {
  readonly linkedStrokeId: string;
  readonly points: readonly InkSpikePoint[];
  readonly surfaceId: string;
}[] {
  if (linkedStrokeId.length === 0) {
    throw new Error('Linked stroke ID must not be empty.');
  }
  const fragments: Array<{
    linkedStrokeId: string;
    points: InkSpikePoint[];
    surfaceId: string;
  }> = [];
  for (const surface of surfaces) {
    if (surface.endY <= surface.startY) {
      throw new Error(`Ink surface ${surface.id} has invalid bounds.`);
    }
    const fragment: InkSpikePoint[] = [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      if (start === undefined || end === undefined) {
        continue;
      }
      const clipped = clipSegmentToYRange(start, end, surface.startY, surface.endY);
      if (clipped === null) {
        continue;
      }
      appendUnique(fragment, clipped[0]);
      appendUnique(fragment, clipped[1]);
    }
    if (points.length === 1) {
      const only = points[0];
      if (only !== undefined && only.y >= surface.startY && only.y <= surface.endY) {
        fragment.push(only);
      }
    }
    if (fragment.length > 0) {
      fragments.push({ linkedStrokeId, points: fragment, surfaceId: surface.id });
    }
  }
  return fragments;
}

export function compareInkLayoutFingerprint(
  expected: InkLayoutFingerprint,
  actual: InkLayoutFingerprint,
):
  | { readonly status: 'match' }
  | { readonly changed: readonly (keyof InkLayoutFingerprint)[]; readonly status: 'needs-rebase' } {
  const changed = (
    [
      'blockFingerprints',
      'fontFamily',
      'fontSize',
      'lineHeight',
      'logicalWidth',
      'sourceRevision',
      'theme',
    ] as const
  ).filter((key) =>
    key === 'blockFingerprints'
      ? JSON.stringify(expected[key]) !== JSON.stringify(actual[key])
      : expected[key] !== actual[key],
  );
  return changed.length === 0 ? { status: 'match' } : { changed, status: 'needs-rebase' };
}

export function buildInkSpikeMetrics(input: {
  readonly coalescedEvents: number;
  readonly dirtyAreaRatio: number;
  readonly frameDurationsMs: readonly number[];
  readonly fragments: number;
  readonly inputPoints: number;
  readonly pointerType: string;
  readonly simplifiedPoints: number;
  readonly strokes: number;
}): {
  readonly coalescedEvents: number;
  readonly dirtyAreaRatio: number;
  readonly fragmentCount: number;
  readonly inputCount: number;
  readonly inputToPaintP95Ms: number;
  readonly pointerType: string;
  readonly simplificationRatio: number;
  readonly simplifiedCount: number;
  readonly strokeCount: number;
} {
  const durations = [...input.frameDurationsMs].sort((left, right) => left - right);
  const percentileIndex = Math.max(0, Math.ceil(durations.length * 0.95) - 1);
  return {
    coalescedEvents: input.coalescedEvents,
    dirtyAreaRatio: input.dirtyAreaRatio,
    fragmentCount: input.fragments,
    inputCount: input.inputPoints,
    inputToPaintP95Ms: durations[percentileIndex] ?? 0,
    pointerType: input.pointerType,
    simplificationRatio: input.inputPoints === 0 ? 1 : input.simplifiedPoints / input.inputPoints,
    simplifiedCount: input.simplifiedPoints,
    strokeCount: input.strokes,
  };
}

function distanceToSegment(point: InkSpikePoint, start: InkSpikePoint, end: InkSpikePoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy),
    0,
    1,
  );
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function clipSegmentToYRange(
  start: InkSpikePoint,
  end: InkSpikePoint,
  minimumY: number,
  maximumY: number,
): readonly [InkSpikePoint, InkSpikePoint] | null {
  const dy = end.y - start.y;
  if (dy === 0) {
    return start.y >= minimumY && start.y <= maximumY ? [start, end] : null;
  }
  const lowerT = (minimumY - start.y) / dy;
  const upperT = (maximumY - start.y) / dy;
  const enter = Math.max(0, Math.min(lowerT, upperT));
  const exit = Math.min(1, Math.max(lowerT, upperT));
  if (enter > exit) {
    return null;
  }
  return [interpolatePoint(start, end, enter), interpolatePoint(start, end, exit)];
}

function interpolatePoint(start: InkSpikePoint, end: InkSpikePoint, t: number): InkSpikePoint {
  return {
    pressure: start.pressure + (end.pressure - start.pressure) * t,
    time: start.time + (end.time - start.time) * t,
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    ...(start.tiltX === undefined || end.tiltX === undefined
      ? {}
      : { tiltX: start.tiltX + (end.tiltX - start.tiltX) * t }),
    ...(start.tiltY === undefined || end.tiltY === undefined
      ? {}
      : { tiltY: start.tiltY + (end.tiltY - start.tiltY) * t }),
  };
}

function appendUnique(points: InkSpikePoint[], point: InkSpikePoint): void {
  const previous = points.at(-1);
  if (previous?.x === point.x && previous.y === point.y && previous.time === point.time) {
    return;
  }
  points.push(point);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
