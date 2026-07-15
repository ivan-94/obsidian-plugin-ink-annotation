import {
  buildInkSpikeMetrics,
  compareInkLayoutFingerprint,
  deltaEncodeInkPoints,
  mapClientPointToLogical,
  routeInkPointer,
  simplifyInkPoints,
  splitStrokeAcrossSurfaces,
  type InkLayoutFingerprint,
  type InkSpikePoint,
} from './ink-spike-engine';

const LOGICAL = { height: 1200, width: 960 } as const;
const SURFACES = [
  { endY: 600, id: 'surface-a', startY: 0 },
  { endY: 1200, id: 'surface-b', startY: 600 },
] as const;

const activeCanvas = requireElement<HTMLCanvasElement>('active');
const committedCanvas = requireElement<HTMLCanvasElement>('committed');
const activeContext = requireContext(activeCanvas);
const committedContext = requireContext(committedCanvas);
const stageShell = requireElement<HTMLElement>('stage-shell');
const metricsElement = requireElement<HTMLElement>('metrics');
const eventsElement = requireElement<HTMLOListElement>('events');
const layoutStatus = requireElement<HTMLElement>('layout-status');

let activePointerId: number | null = null;
let activePoints: InkSpikePoint[] = [];
let lastPainted = 0;
let paintScheduled = false;
let lastInputAt = 0;
let spacePressed = false;
const committedStrokes: InkSpikePoint[][] = [];
const frameDurationsMs: number[] = [];
const aggregate = {
  captureEnds: 0,
  captureStarts: 0,
  coalescedEvents: 0,
  fragments: 0,
  inputPoints: 0,
  maximumPressure: 0,
  maximumDirtyAreaRatio: 0,
  minimumPressure: 1,
  pointerType: 'none',
  simplifiedPoints: 0,
  strokes: 0,
  tiltObserved: false,
};

const expectedLayout: InkLayoutFingerprint = {
  blockFingerprints: ['intro-v1', 'surface-one-v1', 'surface-two-v1'],
  fontFamily: 'Inter',
  fontSize: 18,
  lineHeight: 27.9,
  logicalWidth: LOGICAL.width,
  sourceRevision: 'spike-source-v1',
  theme: 'light',
};
let observedLayout = { ...expectedLayout };

activeCanvas.addEventListener('pointerdown', (event) => {
  const route = routeInkPointer({
    button: event.button,
    pointerType: event.pointerType,
    spacePressed,
  });
  if (route !== 'draw') {
    logEvent(`${event.pointerType || 'unknown'} routed to ${route}`);
    return;
  }
  event.preventDefault();
  activePointerId = event.pointerId;
  activePoints = [];
  lastPainted = 0;
  aggregate.pointerType = event.pointerType || 'unknown';
  activeCanvas.setPointerCapture(event.pointerId);
  aggregate.captureStarts += 1;
  appendPointerEvents(event);
  schedulePaint();
});

activeCanvas.addEventListener('pointermove', (event) => {
  if (event.pointerId !== activePointerId) {
    return;
  }
  event.preventDefault();
  appendPointerEvents(event);
  schedulePaint();
});

for (const eventName of ['pointerup', 'pointercancel'] as const) {
  activeCanvas.addEventListener(eventName, (event) => {
    if (event.pointerId !== activePointerId) {
      return;
    }
    event.preventDefault();
    appendPointerEvents(event);
    schedulePaint(() => finishStroke(eventName));
  });
}

activeCanvas.addEventListener('lostpointercapture', () => {
  aggregate.captureEnds += 1;
  logEvent('pointer capture released');
  renderMetrics();
});

globalThis.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    spacePressed = true;
  }
});
globalThis.addEventListener('keyup', (event) => {
  if (event.code === 'Space') {
    spacePressed = false;
  }
});
globalThis.addEventListener('resize', () => {
  updateScale();
  logEvent(`resize ${globalThis.innerWidth}×${globalThis.innerHeight}`);
});
globalThis.addEventListener('orientationchange', () => logEvent('orientation change'));
document.addEventListener('visibilitychange', () =>
  logEvent(document.hidden ? 'app backgrounded' : 'app resumed'),
);
globalThis.visualViewport?.addEventListener('resize', () =>
  logEvent(`visual viewport height ${Math.round(globalThis.visualViewport?.height ?? 0)}`),
);

requireElement<HTMLButtonElement>('clear').addEventListener('click', () => {
  committedStrokes.length = 0;
  committedContext.clearRect(0, 0, LOGICAL.width, LOGICAL.height);
  activeContext.clearRect(0, 0, LOGICAL.width, LOGICAL.height);
  logEvent('canvas cleared');
});

requireElement<HTMLButtonElement>('mismatch').addEventListener('click', () => {
  observedLayout = {
    ...observedLayout,
    fontFamily: observedLayout.fontFamily === 'Inter' ? 'Arial' : 'Inter',
  };
  renderLayoutStatus();
  renderMetrics();
});

requireElement<HTMLButtonElement>('theme').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  observedLayout = { ...observedLayout, theme };
  renderLayoutStatus();
  renderMetrics();
});

requireElement<HTMLButtonElement>('export-metrics').addEventListener('click', () => {
  const report = JSON.stringify(currentMetrics(), null, 2);
  const link = document.createElement('a');
  link.download = 'inkstone-s09-metrics.json';
  link.href = URL.createObjectURL(new Blob([report], { type: 'application/json' }));
  link.click();
  URL.revokeObjectURL(link.href);
});

updateScale();
renderLayoutStatus();
renderMetrics();
logEvent(`ready at DPR ${globalThis.devicePixelRatio}`);

function appendPointerEvents(event: PointerEvent): void {
  const coalesced = event.getCoalescedEvents?.() ?? [event];
  aggregate.coalescedEvents += Math.max(0, coalesced.length - 1);
  const bounds = activeCanvas.getBoundingClientRect();
  for (const sample of coalesced) {
    const logical = mapClientPointToLogical(sample, bounds, LOGICAL);
    const pressure = sample.pressure > 0 ? sample.pressure : 0.5;
    activePoints.push({
      pressure,
      time: sample.timeStamp,
      x: logical.x,
      y: logical.y,
      ...(sample.tiltX === 0 ? {} : { tiltX: sample.tiltX }),
      ...(sample.tiltY === 0 ? {} : { tiltY: sample.tiltY }),
    });
    aggregate.inputPoints += 1;
    aggregate.minimumPressure = Math.min(aggregate.minimumPressure, pressure);
    aggregate.maximumPressure = Math.max(aggregate.maximumPressure, pressure);
    aggregate.tiltObserved ||= sample.tiltX !== 0 || sample.tiltY !== 0;
  }
  lastInputAt = performance.now();
}

function schedulePaint(afterPaint?: () => void): void {
  if (paintScheduled) {
    if (afterPaint !== undefined) {
      requestAnimationFrame(afterPaint);
    }
    return;
  }
  paintScheduled = true;
  requestAnimationFrame(() => {
    paintScheduled = false;
    drawIncremental(activeContext, activePoints, lastPainted, '#4f46d8', 4);
    lastPainted = Math.max(0, activePoints.length - 1);
    if (lastInputAt > 0) {
      frameDurationsMs.push(performance.now() - lastInputAt);
      if (frameDurationsMs.length > 240) {
        frameDurationsMs.shift();
      }
    }
    afterPaint?.();
  });
}

function finishStroke(reason: 'pointercancel' | 'pointerup'): void {
  const points = activePoints;
  activePoints = [];
  lastPainted = 0;
  const pointerId = activePointerId;
  activePointerId = null;
  if (pointerId !== null && activeCanvas.hasPointerCapture(pointerId)) {
    activeCanvas.releasePointerCapture(pointerId);
  }
  activeContext.clearRect(0, 0, LOGICAL.width, LOGICAL.height);
  if (reason === 'pointercancel' || points.length < 2) {
    logEvent(`stroke ${reason}`);
    return;
  }
  const simplified = [...simplifyInkPoints(points, 0.8)];
  const linkedId = `spike-stroke-${aggregate.strokes + 1}`;
  const fragments = splitStrokeAcrossSurfaces(linkedId, simplified, SURFACES);
  const dirtyBounds = boundingBox(simplified);
  void deltaEncodeInkPoints(simplified);
  committedStrokes.push(simplified);
  drawStroke(committedContext, simplified, '#4f46d8', 4);
  aggregate.strokes += 1;
  aggregate.simplifiedPoints += simplified.length;
  aggregate.fragments += fragments.length;
  aggregate.maximumDirtyAreaRatio = Math.max(
    aggregate.maximumDirtyAreaRatio,
    (dirtyBounds.width * dirtyBounds.height) / (LOGICAL.width * LOGICAL.height),
  );
  logEvent(`stroke committed as ${fragments.length} linked fragment(s)`);
  renderMetrics();
}

function drawIncremental(
  context: CanvasRenderingContext2D,
  points: readonly InkSpikePoint[],
  startIndex: number,
  color: string,
  width: number,
): void {
  const visible = points.slice(Math.max(0, startIndex - 1));
  drawStroke(context, visible, color, width);
}

function drawStroke(
  context: CanvasRenderingContext2D,
  points: readonly InkSpikePoint[],
  color: string,
  width: number,
): void {
  if (points.length < 2) {
    return;
  }
  context.save();
  context.strokeStyle = color;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = width;
  context.beginPath();
  const first = points[0] as InkSpikePoint;
  context.moveTo(first.x, first.y);
  for (const point of points.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.stroke();
  context.restore();
}

function updateScale(): void {
  const available = Math.max(280, Math.min(960, stageShell.parentElement?.clientWidth ?? 960));
  document.documentElement.style.setProperty('--scale', String(available / LOGICAL.width));
}

function renderLayoutStatus(): void {
  const comparison = compareInkLayoutFingerprint(expectedLayout, observedLayout);
  layoutStatus.dataset.status = comparison.status;
  layoutStatus.textContent =
    comparison.status === 'match' ? 'Match' : `Needs rebase · ${comparison.changed.join(', ')}`;
}

function currentMetrics(): Record<string, unknown> {
  return {
    ...buildInkSpikeMetrics({
      coalescedEvents: aggregate.coalescedEvents,
      dirtyAreaRatio: aggregate.maximumDirtyAreaRatio,
      frameDurationsMs,
      fragments: aggregate.fragments,
      inputPoints: aggregate.inputPoints,
      pointerType: aggregate.pointerType,
      simplifiedPoints: aggregate.simplifiedPoints,
      strokes: aggregate.strokes,
    }),
    captureEnds: aggregate.captureEnds,
    captureStarts: aggregate.captureStarts,
    layout: compareInkLayoutFingerprint(expectedLayout, observedLayout),
    maximumPressure: aggregate.maximumPressure,
    minimumPressure: aggregate.inputPoints === 0 ? 0 : aggregate.minimumPressure,
    tiltObserved: aggregate.tiltObserved,
  };
}

function boundingBox(points: readonly InkSpikePoint[]): {
  readonly height: number;
  readonly width: number;
} {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    height: Math.max(...ys) - Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
  };
}

function renderMetrics(): void {
  metricsElement.textContent = JSON.stringify(currentMetrics(), null, 2);
}

function logEvent(message: string): void {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()} · ${message}`;
  eventsElement.prepend(item);
  while (eventsElement.children.length > 8) {
    eventsElement.lastElementChild?.remove();
  }
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing Ink spike element ${id}.`);
  }
  return element as T;
}

function requireContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('Canvas 2D is unavailable.');
  }
  return context;
}
