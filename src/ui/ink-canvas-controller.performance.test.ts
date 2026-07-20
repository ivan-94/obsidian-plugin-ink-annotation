// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InkPoint, InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import { INK_SAMPLE_FLAGS, type InkSampleCursor } from '../domain/ink-contact';
import type { InkSurfaceSessionSnapshot } from '../application/ink-surface-session';
import type {
  InkDocumentApplyResult,
  InkDocumentReadView,
  InkLogicalRect,
  InkRenderableStrokeRef,
} from '../application/ink-document-session';
import {
  createTestInkReadView,
  queryTestInkReadView,
} from '../test-support/ink-live-document-fixture';
import { InkCanvasController } from './ink-canvas-controller';
import { createInkStageFrame } from './ink-stage-frame';
import { InkRenderRuntime } from './ink-render-runtime';

describe('Ink palette performance', () => {
  afterEach(() => vi.restoreAllMocks());

  it('switches tools independently of 10,000 committed strokes within the interaction budget', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(contextFixture().context);
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({ document, root, session: new LargeSession() });
    const pen = root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="pen"]');
    const highlighter = root.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-tool="highlighter"]',
    );
    if (pen === null || highlighter === null) throw new Error('Missing palette buttons.');
    const startedAt = performance.now();

    for (let index = 0; index < 1_000; index += 1) {
      (index % 2 === 0 ? highlighter : pen).click();
    }
    const durationMs = performance.now() - startedAt;

    expect(durationMs).toBeLessThan(250);
    controller.dispose();
  });

  it('uses identical active-frame work for empty and 10,000-stroke histories', () => {
    const contexts = new WeakMap<HTMLCanvasElement, ContextFixture>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing.context;
      const created = contextFixture();
      contexts.set(this, created);
      return created.context;
    });

    const measure = (historySize: number) => {
      const history = Array.from({ length: historySize }, (_value, index) => strokeRef(index));
      const read = (): InkDocumentReadView => ({
        documentId: 'performance',
        generation: 0,
        indexBytes: historySize * 192,
        logicalHeight: 200_000,
        logicalWidth: 704,
        persistence: { kind: 'idle' },
        selection: [],
        state: { dirty: false, kind: 'ink-mode', saveError: null },
        strokeCount: historySize,
        strokes: history,
      });
      const query = vi.fn<() => readonly InkRenderableStrokeRef[]>(() => []);
      const frames: FrameRequestCallback[] = [];
      const host = document.createElement('div');
      document.body.append(host);
      const runtime = new InkRenderRuntime({
        document,
        host,
        query,
        read,
        requestFrame: (callback) => {
          frames.push(callback);
          return frames.length;
        },
      });
      runtime.setFrame(
        createInkStageFrame({
          actualScale: 1,
          canvasClientRect: { height: 800, left: 0, top: 0, width: 704 },
          documentClientOrigin: { x: 0, y: 0 },
        }),
      );
      runtime.installDocument(read());
      drain(frames);
      query.mockClear();
      const active = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
      const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
      const tailContext = active === null ? undefined : contexts.get(active);
      const stableContext = stable === null ? undefined : contexts.get(stable);
      for (const context of [stableContext, tailContext]) {
        context?.stroke.mockClear();
        context?.lineTo.mockClear();
      }

      runtime.applyActiveDelta({
        presentationDelta: numericActiveDelta(0),
        strokeId: `active-${historySize}`,
        style: { color: '#111111', tool: 'pen', width: 2 },
      });
      runtime.applyActiveDelta({
        presentationDelta: numericActiveDelta(1),
        strokeId: `active-${historySize}`,
        style: { color: '#111111', tool: 'pen', width: 2 },
      });
      const queuedFrames = frames.length;
      drain(frames);
      const result = {
        activeEncoding: runtime.stats().activeStableEncoding,
        activeSubmittedSegments: runtime.stats().lastActiveSubmittedSegmentCount,
        documentQueries: query.mock.calls.length,
        lineSegments:
          (stableContext?.lineTo.mock.calls.length ?? 0) +
          (tailContext?.lineTo.mock.calls.length ?? 0),
        paintCalls:
          (stableContext?.stroke.mock.calls.length ?? 0) +
          (tailContext?.stroke.mock.calls.length ?? 0),
        queuedFrames,
      };
      runtime.dispose();
      return result;
    };

    const empty = measure(0);
    expect(measure(10_000)).toEqual(empty);
    expect(empty).toEqual({
      activeEncoding: 'raw-spherical-sample',
      activeSubmittedSegments: 2,
      documentQueries: 0,
      lineSegments: 2,
      paintCalls: 2,
      queuedFrames: 1,
    });
  });

  it('keeps the first and last 100 steady-state frames identical across a 50k-point active stroke', () => {
    const contexts = new WeakMap<HTMLCanvasElement, ContextFixture>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing.context;
      const created = contextFixture();
      contexts.set(this, created);
      return created.context;
    });
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const read = (): InkDocumentReadView => ({
      documentId: 'long-active',
      generation: 0,
      indexBytes: 0,
      logicalHeight: 200_000,
      logicalWidth: 704,
      persistence: { kind: 'idle' },
      selection: [],
      state: { dirty: false, kind: 'ink-mode', saveError: null },
      strokeCount: 0,
      strokes: [],
    });
    const runtime = new InkRenderRuntime({
      document,
      host,
      query: () => [],
      read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(
      createInkStageFrame({
        actualScale: 1,
        canvasClientRect: { height: 800, left: 0, top: 0, width: 704 },
        documentClientOrigin: { x: 0, y: 0 },
      }),
    );
    runtime.installDocument(read());
    drain(frames);
    runtime.applyActiveDelta({
      presentationDelta: numericActiveDelta(0),
      strokeId: 'long-active',
      style: { color: '#111111', tool: 'pen', width: 2 },
    });
    drain(frames);
    const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (stable === null || tail === null) throw new Error('Missing Active Stroke layers.');
    const stableContext = contexts.get(stable);
    const tailContext = contexts.get(tail);
    if (stableContext === undefined || tailContext === undefined) {
      throw new Error('Missing Active Stroke contexts.');
    }
    clearContextCalls(stableContext);
    clearContextCalls(tailContext);
    const first: FrameWork[] = [];
    const last: FrameWork[] = [];

    for (let index = 1; index <= 50_000; index += 1) {
      runtime.applyActiveDelta({
        presentationDelta: numericActiveDelta(index),
        strokeId: 'long-active',
        style: { color: '#111111', tool: 'pen', width: 2 },
      });
      drain(frames);
      const work = frameWork(stableContext, tailContext);
      if (index <= 100) first.push(work);
      if (index > 49_900) last.push(work);
      clearContextCalls(stableContext);
      clearContextCalls(tailContext);
    }

    expect(last).toEqual(first);
    expect(new Set(first.map((work) => JSON.stringify(work)))).toEqual(
      new Set([
        JSON.stringify({
          lineSegments: 2,
          paintCalls: 2,
          stableClears: 0,
          tailClears: 1,
        }),
      ]),
    );
    expect(runtime.stats()).toMatchObject({
      activeSegmentCount: 50_000,
      activeStableChunkCount: 196,
      activeStableStorageKind: 'float64-chunks',
      activeTailStorageKind: 'float64-ring',
    });
    runtime.dispose();
  });

  it('keeps production numeric presentation history-independent across empty/10k and short/50k strokes', () => {
    const contexts = new WeakMap<HTMLCanvasElement, ContextFixture>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing.context;
      const created = contextFixture();
      contexts.set(this, created);
      return created.context;
    });
    const cases = [
      { activeUpdateCount: 128, historySize: 0, windowSize: 32 },
      { activeUpdateCount: 128, historySize: 10_000, windowSize: 32 },
      { activeUpdateCount: 50_000, historySize: 0, windowSize: 100 },
      { activeUpdateCount: 50_000, historySize: 10_000, windowSize: 100 },
    ] as const;
    const results = cases.map((input) => measureNumericHistoryCell(contexts, input));
    const expectedFrameWork: NumericFrameWork = {
      activeSubmittedSegments: 2,
      documentQueries: 0,
      lineSegments: 2,
      paintCalls: 2,
      queuedFrames: 1,
      stableClears: 0,
      tailClears: 1,
    };

    for (const result of results) {
      expect(result.lateFrames).toEqual(result.earlyFrames);
      expect(result.earlyFrames).toEqual(
        Array.from({ length: result.windowSize }, () => expectedFrameWork),
      );
      expect(result).toMatchObject({
        activeSegmentCount: result.activeUpdateCount,
        activeStableChunkCount: Math.ceil(result.activeStableSampleCount / 256),
        activeStableEncoding: 'raw-spherical-sample',
        activeStableSampleCount: result.activeUpdateCount + 1,
        activeStableStorageKind: 'float64-chunks',
        activeTailEncoding: 'raw-spherical-sample',
        activeTailStorageKind: 'float64-ring',
        backingStoreBytes: 3 * 704 * 800 * Uint32Array.BYTES_PER_ELEMENT,
        backingStoreCount: 3,
        documentQueries: 0,
      });
    }

    for (const activeUpdateCount of [128, 50_000]) {
      const empty = requireNumericCell(results, 0, activeUpdateCount);
      const withHistory = requireNumericCell(results, 10_000, activeUpdateCount);
      expect(withoutHistoryIdentity(withHistory)).toEqual(withoutHistoryIdentity(empty));
    }

    const short = requireNumericCell(results, 0, 128);
    const long = requireNumericCell(results, 0, 50_000);
    const addedSamples = long.activeStableSampleCount - short.activeStableSampleCount;
    const addedChunks = long.activeStableChunkCount - short.activeStableChunkCount;
    expect(long.activeWorkingSetBytes - short.activeWorkingSetBytes).toBe(
      addedSamples * (6 * Float64Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT) +
        addedChunks * 64,
    );
  });
});

interface FrameWork {
  readonly lineSegments: number;
  readonly paintCalls: number;
  readonly stableClears: number;
  readonly tailClears: number;
}

interface NumericFrameWork extends FrameWork {
  readonly activeSubmittedSegments: number;
  readonly documentQueries: number;
  readonly queuedFrames: number;
}

interface NumericHistoryCell {
  readonly activeSegmentCount: number;
  readonly activeStableChunkCount: number;
  readonly activeStableEncoding: string | null;
  readonly activeStableSampleCount: number;
  readonly activeStableStorageKind: 'float64-chunks';
  readonly activeTailEncoding: string | null;
  readonly activeTailStorageKind: 'float64-ring';
  readonly activeUpdateCount: number;
  readonly activeWorkingSetBytes: number;
  readonly backingStoreBytes: number;
  readonly backingStoreCount: number;
  readonly documentQueries: number;
  readonly earlyFrames: readonly NumericFrameWork[];
  readonly historySize: number;
  readonly lateFrames: readonly NumericFrameWork[];
  readonly windowSize: number;
}

function measureNumericHistoryCell(
  contexts: WeakMap<HTMLCanvasElement, ContextFixture>,
  input: {
    readonly activeUpdateCount: number;
    readonly historySize: number;
    readonly windowSize: number;
  },
): NumericHistoryCell {
  const history = Array.from({ length: input.historySize }, (_value, index) => strokeRef(index));
  const read = (): InkDocumentReadView => ({
    documentId: `matrix-${input.historySize}-${input.activeUpdateCount}`,
    generation: 0,
    indexBytes: input.historySize * 192,
    logicalHeight: 200_000,
    logicalWidth: 704,
    persistence: { kind: 'idle' },
    selection: [],
    state: { dirty: false, kind: 'ink-mode', saveError: null },
    strokeCount: input.historySize,
    strokes: history,
  });
  const query = vi.fn<() => readonly InkRenderableStrokeRef[]>(() => []);
  const frames: FrameRequestCallback[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const runtime = new InkRenderRuntime({
    devicePixelRatio: () => 1,
    document,
    host,
    query,
    read,
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
  });
  runtime.setFrame(
    createInkStageFrame({
      actualScale: 1,
      canvasClientRect: { height: 800, left: 0, top: 0, width: 704 },
      documentClientOrigin: { x: 0, y: 0 },
    }),
  );
  runtime.installDocument(read());
  drain(frames);
  query.mockClear();
  runtime.applyActiveDelta({
    presentationDelta: numericActiveDelta(0),
    strokeId: `matrix-active-${input.historySize}-${input.activeUpdateCount}`,
    style: { color: '#111111', tool: 'pen', width: 2 },
  });
  drain(frames);
  const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
  const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
  if (stable === null || tail === null) throw new Error('Missing numeric Active Stroke layers.');
  const stableContext = contexts.get(stable);
  const tailContext = contexts.get(tail);
  if (stableContext === undefined || tailContext === undefined) {
    throw new Error('Missing numeric Active Stroke contexts.');
  }
  clearContextCalls(stableContext);
  clearContextCalls(tailContext);
  const earlyFrames: NumericFrameWork[] = [];
  const lateFrames: NumericFrameWork[] = [];

  for (let index = 1; index <= input.activeUpdateCount; index += 1) {
    runtime.applyActiveDelta({
      presentationDelta: numericActiveDelta(index),
      strokeId: `matrix-active-${input.historySize}-${input.activeUpdateCount}`,
      style: { color: '#111111', tool: 'pen', width: 2 },
    });
    const queuedFrames = frames.length;
    drain(frames);
    const work: NumericFrameWork = {
      activeSubmittedSegments: runtime.stats().lastActiveSubmittedSegmentCount,
      documentQueries: query.mock.calls.length,
      ...frameWork(stableContext, tailContext),
      queuedFrames,
    };
    if (index <= input.windowSize) earlyFrames.push(work);
    if (index > input.activeUpdateCount - input.windowSize) lateFrames.push(work);
    query.mockClear();
    clearContextCalls(stableContext);
    clearContextCalls(tailContext);
  }

  const stats = runtime.stats();
  const result: NumericHistoryCell = {
    activeSegmentCount: stats.activeSegmentCount,
    activeStableChunkCount: stats.activeStableChunkCount,
    activeStableEncoding: stats.activeStableEncoding,
    activeStableSampleCount: stats.activeStableSampleCount,
    activeStableStorageKind: stats.activeStableStorageKind,
    activeTailEncoding: stats.activeTailEncoding,
    activeTailStorageKind: stats.activeTailStorageKind,
    activeUpdateCount: input.activeUpdateCount,
    activeWorkingSetBytes: stats.activeWorkingSetBytes,
    backingStoreBytes: stats.backingStoreBytes,
    backingStoreCount: host.querySelectorAll('canvas').length,
    documentQueries: query.mock.calls.length,
    earlyFrames,
    historySize: input.historySize,
    lateFrames,
    windowSize: input.windowSize,
  };
  runtime.dispose();
  host.remove();
  return result;
}

function requireNumericCell(
  cells: readonly NumericHistoryCell[],
  historySize: number,
  activeUpdateCount: number,
): NumericHistoryCell {
  const result = cells.find(
    (cell) => cell.historySize === historySize && cell.activeUpdateCount === activeUpdateCount,
  );
  if (result === undefined) throw new Error('Missing numeric history-independence matrix cell.');
  return result;
}

function withoutHistoryIdentity(cell: NumericHistoryCell): Omit<NumericHistoryCell, 'historySize'> {
  const { historySize, ...result } = cell;
  void historySize;
  return result;
}

function numericActiveDelta(index: number) {
  const stable = numericSample(index);
  const tail = numericSample(index + 1);
  return {
    kind: 'borrowed-numeric' as const,
    mutableTail: {
      length: 1,
      forEachSample: (consumer: (sample: InkSampleCursor) => void) => consumer(tail),
    },
    stablePrefixDelta: {
      length: 1,
      forEachSample: (consumer: (sample: InkSampleCursor) => void) => consumer(stable),
    },
  };
}

function numericSample(index: number): InkSampleCursor {
  return {
    altitude: Math.PI / 3,
    azimuth: Math.PI / 4,
    flags:
      INK_SAMPLE_FLAGS.pressureMeasured |
      INK_SAMPLE_FLAGS.altitudeMeasured |
      INK_SAMPLE_FLAGS.azimuthMeasured,
    pressure: 0.5,
    time: index,
    x: index * 4,
    y: 100,
  };
}

function frameWork(stable: ContextFixture, tail: ContextFixture): FrameWork {
  return {
    lineSegments: stable.lineTo.mock.calls.length + tail.lineTo.mock.calls.length,
    paintCalls: stable.stroke.mock.calls.length + tail.stroke.mock.calls.length,
    stableClears: stable.clearRect.mock.calls.length,
    tailClears: tail.clearRect.mock.calls.length,
  };
}

function clearContextCalls(context: ContextFixture): void {
  context.clearRect.mockClear();
  context.lineTo.mockClear();
  context.stroke.mockClear();
}

class LargeSession {
  private readonly record: InkSurfaceRecord = {
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Ink.md',
    id: 'surface',
    layout: {
      blockFingerprints: ['a'],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1000,
      logicalWidth: 1000,
      sourceRevision: 'source',
      themeMode: 'light',
    },
    noteId: 'note',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: Array.from({ length: 10_000 }, (_value, index) => stroke(index)),
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
  apply(): never {
    throw new Error('LargeSession does not accept drawing commands.');
  }
  background(): Promise<void> {
    return Promise.resolve();
  }
  canRedo(): boolean {
    return false;
  }
  canUndo(): boolean {
    return false;
  }
  eraseStrokeAt(): string | null {
    return null;
  }
  eraseStrokesInPolygon(): readonly string[] {
    return [];
  }
  enter(): void {}
  exit(): Promise<void> {
    return Promise.resolve();
  }
  redo(): boolean {
    return false;
  }
  retry(pendingId: string): InkDocumentApplyResult;
  retry(): Promise<void>;
  retry(pendingId?: string): InkDocumentApplyResult | Promise<void> {
    if (pendingId !== undefined) throw new Error(`No retained command ${pendingId}.`);
    return Promise.resolve();
  }
  snapshot(): InkSurfaceSessionSnapshot {
    return {
      persistence: { kind: 'idle' },
      state: { dirty: false, kind: 'ink-mode', saveError: null },
      surface: this.record,
    };
  }
  read() {
    return createTestInkReadView(this.snapshot());
  }
  query(viewport: InkLogicalRect) {
    return queryTestInkReadView(this.read(), viewport);
  }
  undo(): boolean {
    return false;
  }
}

function stroke(index: number): InkStroke {
  const point: InkPoint = { pressure: 0.5, time: index, x: index % 1000, y: index % 1000 };
  return { color: '#111111', id: `stroke-${index}`, points: [point], tool: 'pen', width: 2 };
}

function strokeRef(index: number): InkRenderableStrokeRef {
  const candidate = {
    ...stroke(index),
    points: [{ pressure: 0.5, time: index, x: 10, y: 10_000 + index * 10 }],
  };
  return {
    bounds: { height: 2, width: 2, x: 9, y: 9_999 + index * 10 },
    id: candidate.id,
    order: index,
    stroke: candidate,
  };
}

function drain(frames: FrameRequestCallback[]): void {
  while (frames.length > 0) frames.shift()?.(performance.now());
}

interface ContextFixture {
  readonly clearRect: ReturnType<typeof vi.fn>;
  readonly context: CanvasRenderingContext2D;
  readonly lineTo: ReturnType<typeof vi.fn>;
  readonly stroke: ReturnType<typeof vi.fn>;
}

function contextFixture(): ContextFixture {
  const clearRect = vi.fn();
  const lineTo = vi.fn();
  const strokeValue = vi.fn();
  const context = {
    beginPath: vi.fn(),
    clearRect,
    lineCap: 'round',
    lineJoin: 'round',
    lineTo,
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    stroke: strokeValue,
    strokeStyle: '#000',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  return { clearRect, context, lineTo, stroke: strokeValue };
}
