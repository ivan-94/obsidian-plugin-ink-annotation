// @vitest-environment jsdom

import { Script } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decodeInkWorkerFrame,
  encodeInkWorkerFrame,
  INK_WORKER_FRAME_HEADER_BYTES,
} from '../runtime/ink-worker-protocol';
import {
  createInkOffscreenWorkerSource,
  prepareInkWorkerOffscreenPresentationAdapter,
  type InkWorkerPresentationAck,
} from './ink-worker-offscreen-presentation-adapter';

describe('InkWorkerOffscreenPresentationAdapter', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('emits a self-contained syntactically valid classic Worker source', () => {
    const source = createInkOffscreenWorkerSource();

    expect(source).toContain('inkstone-offscreen-worker-v1');
    expect(() => new Script(source)).not.toThrow();
    expect(source).not.toMatch(/require\(|node:|electron|worker_threads/u);
  });

  it('executes the real Worker source through init, configure, begin, frame, and Ack without browser globals', () => {
    const source = createInkOffscreenWorkerSource();
    const transcript: Array<Record<string, unknown>> = [];
    const stable = offscreenCanvasFixture();
    const tail = offscreenCanvasFixture();
    const scope: {
      onmessage: ((event: { readonly data: Record<string, unknown> }) => void) | null;
      postMessage(message: Record<string, unknown>, transfer?: readonly unknown[]): void;
    } = {
      onmessage: null,
      postMessage: (message) => transcript.push(message),
    };
    new Script(source).runInNewContext({
      ArrayBuffer,
      DataView,
      Float64Array,
      Math,
      Number,
      String,
      self: scope,
    });
    if (scope.onmessage === null) throw new Error('Worker source did not install onmessage.');
    const dispatch = scope.onmessage;
    const probeBuffer = new ArrayBuffer(64);

    dispatch({
      data: { probeBuffer, session: 17, type: 'ink-worker-prewarm' },
    });
    dispatch({
      data: {
        probeBuffer,
        session: 17,
        stableCanvas: stable.canvas,
        tailCanvas: tail.canvas,
        type: 'ink-worker-init',
      },
    });
    dispatch({
      data: {
        backingHeight: 200,
        backingWidth: 300,
        frameEpoch: 3,
        session: 17,
        transform: [2, 0, 0, 2, -10, -20],
        type: 'ink-worker-configure',
      },
    });
    dispatch({
      data: {
        color: '#123456',
        contactSequence: 9,
        frameEpoch: 3,
        opacity: 0.45,
        session: 17,
        tool: 'highlighter',
        type: 'ink-worker-begin-contact',
        width: 4,
      },
    });
    const buffer = new ArrayBuffer(
      INK_WORKER_FRAME_HEADER_BYTES + 10 * Float64Array.BYTES_PER_ELEMENT,
    );
    const stableXY = new Float64Array(buffer, INK_WORKER_FRAME_HEADER_BYTES, 4);
    stableXY.set([10, 20, 30, 40]);
    const tailXY = new Float64Array(buffer, INK_WORKER_FRAME_HEADER_BYTES + stableXY.byteLength, 2);
    tailXY.set([50, 60]);
    const provisionalXY = new Float64Array(
      buffer,
      INK_WORKER_FRAME_HEADER_BYTES + stableXY.byteLength + tailXY.byteLength,
      4,
    );
    provisionalXY.set([70, 80, 90, 100]);
    encodeInkWorkerFrame(buffer, {
      bufferId: 1,
      contactSequence: 9,
      frameEpoch: 3,
      generation: 11,
      leaseSequence: 1,
      sequence: 1,
      session: 17,
      stableStart: 0,
      stableXY,
      tailXY,
      provisionalXY,
    });
    dispatch({ data: { buffer, session: 17, type: 'ink-worker-frame' } });

    tail.context.moveTo.mockClear();
    tail.context.lineTo.mockClear();
    const replacement = new ArrayBuffer(
      INK_WORKER_FRAME_HEADER_BYTES + 4 * Float64Array.BYTES_PER_ELEMENT,
    );
    const replacementTail = new Float64Array(replacement, INK_WORKER_FRAME_HEADER_BYTES, 2);
    replacementTail.set([70, 80]);
    const replacementProvisional = new Float64Array(
      replacement,
      INK_WORKER_FRAME_HEADER_BYTES + replacementTail.byteLength,
      2,
    );
    replacementProvisional.set([85, 90]);
    encodeInkWorkerFrame(replacement, {
      bufferId: 2,
      contactSequence: 9,
      frameEpoch: 3,
      generation: 12,
      leaseSequence: 1,
      sequence: 2,
      session: 17,
      stableStart: 2,
      stableXY: new Float64Array(replacement, INK_WORKER_FRAME_HEADER_BYTES, 0),
      tailXY: replacementTail,
      provisionalXY: replacementProvisional,
    });
    dispatch({ data: { buffer: replacement, session: 17, type: 'ink-worker-frame' } });

    expect(transcript.map(({ type }) => type)).toEqual([
      'ink-worker-prewarmed',
      'ink-worker-ready',
      'ink-worker-frame-ack',
      'ink-worker-frame-ack',
    ]);
    expect(transcript.at(-1)).toMatchObject({ buffer: replacement, session: 17 });
    expect(stable.context.moveTo).toHaveBeenCalledWith(10, 20);
    expect(stable.context.lineTo).toHaveBeenCalledWith(30, 40);
    expect(stable.context.lineTo).not.toHaveBeenCalledWith(90, 100);
    expect(tail.context.moveTo).toHaveBeenCalledWith(70, 80);
    expect(tail.context.lineTo).toHaveBeenCalledWith(85, 90);
    expect(tail.context.lineTo).not.toHaveBeenCalledWith(90, 100);
    expect(tail.context.clearRect).toHaveBeenCalled();
    expect(stable.context.globalAlpha).toBe(1);
    expect(tail.context.globalAlpha).toBe(1);
    expect(stable.canvas.width).toBe(300);
    expect(tail.canvas.height).toBe(200);
  });

  it('prewarms without Canvas stores, then transfers a zero-sized pair only on activation', async () => {
    const fixture = workerFixture();
    const starting = prepareInkWorkerOffscreenPresentationAdapter({
      document,
      host: fixture.host,
      onAck: () => undefined,
      onFault: () => undefined,
      scheduler: fixture.scheduler,
      sessionEpoch: 17,
    });

    const prewarm = fixture.worker().messages[0];
    expect(prewarm?.message).toMatchObject({ session: 17, type: 'ink-worker-prewarm' });
    expect(prewarm?.transfer).toHaveLength(1);
    expect(fixture.transferredCanvases).toHaveLength(0);
    const probeBuffer = prewarm?.message.probeBuffer;
    if (!(probeBuffer instanceof ArrayBuffer)) throw new Error('Missing Worker probe buffer.');
    fixture.worker().emitMessage({ probeBuffer, session: 17, type: 'ink-worker-prewarmed' });

    const result = await starting;

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('Expected Worker prewarm readiness.');
    const activation = result.prepared.activate();
    const init = fixture.worker().messages.at(-1);
    expect(init?.message).toMatchObject({ session: 17, type: 'ink-worker-init' });
    expect(init?.transfer).toHaveLength(3);
    expect(fixture.transferredCanvases).toHaveLength(2);
    expect(activation.canvases.stable.width).toBe(0);
    expect(activation.canvases.tail.height).toBe(0);
    const activationProbe = init?.message.probeBuffer;
    if (!(activationProbe instanceof ArrayBuffer)) throw new Error('Missing activation probe.');
    fixture
      .worker()
      .emitMessage({ probeBuffer: activationProbe, session: 17, type: 'ink-worker-ready' });
    const activated = await activation.result;
    expect(activated.kind).toBe('ready');
    if (activated.kind !== 'ready') throw new Error('Expected Worker Adapter readiness.');
    expect(activated.adapter.canvases.stable.dataset.inkstoneInkActiveStable).toBe('worker');
    expect(activated.adapter.canvases.tail.dataset.inkstoneInkActive).toBe('worker');
    expect(fixture.revokeObjectURL).toHaveBeenCalledOnce();
    expect(fixture.scheduler.cancel).toHaveBeenCalledTimes(2);
    activated.adapter.dispose();
    expect(fixture.worker().terminate).toHaveBeenCalledOnce();
  });

  it('submits Float64 stable/tail payload through the three-slot pool and acknowledges exact identity', async () => {
    const fixture = workerFixture();
    const acknowledgements: InkWorkerPresentationAck[] = [];
    const adapter = await readyAdapter(fixture, (ack) => acknowledgements.push(ack));
    adapter.configure({
      backingHeight: 1_536,
      backingWidth: 2_048,
      frameEpoch: 3,
      transform: [2, 0, 0, 2, -10, -20],
    });
    adapter.beginContact({
      color: '#123456',
      contactSequence: 9,
      eraserColor: '#ff0000',
      opacity: 1,
      startPoint: { x: 10, y: 20 },
      tool: 'pen',
      width: 4,
    });

    const submitted = adapter.submit({
      generation: 11,
      provisionalPoints: xyPath([
        [70.75, 80.5],
        [90.125, 100.25],
      ]),
      stablePoints: xyPath([
        [10.25, 20.5],
        [30.75, 40.125],
      ]),
      stableStart: 0,
      tailPoints: xyPath([[50.5, 60.25]]),
    });

    expect(submitted).toMatchObject({
      kind: 'submitted-async',
      packetSequence: 1,
      submittedSegmentCount: 4,
    });
    const frameMessage = fixture.worker().messages.at(-1);
    expect(frameMessage?.message).toMatchObject({ type: 'ink-worker-frame' });
    expect(frameMessage?.transfer).toHaveLength(1);
    const buffer = frameMessage?.message.buffer;
    if (!(buffer instanceof ArrayBuffer)) throw new Error('Missing Worker frame buffer.');
    const decoded = decodeInkWorkerFrame(buffer);
    expect(decoded).toMatchObject({
      ok: true,
      frame: {
        contactSequence: 9,
        frameEpoch: 3,
        generation: 11,
        sequence: 1,
        session: 17,
        stableStart: 0,
      },
    });
    if (!decoded.ok) throw new Error('Expected a valid Worker frame.');
    expect([...decoded.frame.stableXY]).toEqual([10.25, 20.5, 30.75, 40.125]);
    expect([...decoded.frame.tailXY]).toEqual([50.5, 60.25]);
    expect([...decoded.frame.provisionalXY]).toEqual([70.75, 80.5, 90.125, 100.25]);

    fixture.worker().emitMessage({ buffer, session: 17, type: 'ink-worker-frame-ack' });

    expect(acknowledgements).toEqual([
      { contactSequence: 9, frameEpoch: 3, generation: 11, packetSequence: 1 },
    ]);
    adapter.dispose();
  });

  it('fails closed on pool exhaustion instead of allocating a fourth transferable buffer', async () => {
    const fixture = workerFixture();
    const faults: string[] = [];
    const adapter = await readyAdapter(
      fixture,
      () => undefined,
      (failure) => faults.push(failure),
    );
    adapter.configure({
      backingHeight: 100,
      backingWidth: 100,
      frameEpoch: 1,
      transform: [1, 0, 0, 1, 0, 0],
    });
    adapter.beginContact({
      color: '#000000',
      contactSequence: 1,
      opacity: 1,
      tool: 'pen',
      width: 2,
    });

    const frame = {
      generation: 1,
      stablePoints: xyPath([[1, 2]]),
      stableStart: 0,
      tailPoints: xyPath([[3, 4]]),
    };
    expect(adapter.submit(frame).kind).toBe('submitted-async');
    expect(adapter.submit({ ...frame, stableStart: 1 }).kind).toBe('submitted-async');
    expect(adapter.submit({ ...frame, stableStart: 2 }).kind).toBe('submitted-async');
    expect(adapter.submit({ ...frame, stableStart: 3 })).toEqual({ kind: 'backpressured' });
    expect(faults).toEqual(['backpressured']);
    expect(fixture.worker().terminate).toHaveBeenCalledOnce();
  });

  it('rejects an oversized or non-finite provisional lane before it reaches Worker raster state', async () => {
    const oversizedFixture = workerFixture();
    const oversizedFaults: string[] = [];
    const oversized = await readyAdapter(
      oversizedFixture,
      () => undefined,
      (failure) => oversizedFaults.push(failure),
    );
    oversized.configure({
      backingHeight: 100,
      backingWidth: 100,
      frameEpoch: 1,
      transform: [1, 0, 0, 1, 0, 0],
    });
    oversized.beginContact({
      color: '#000000',
      contactSequence: 1,
      opacity: 1,
      tool: 'pen',
      width: 2,
    });

    expect(
      oversized.submit({
        generation: 1,
        provisionalPoints: xyPath(
          Array.from({ length: 17 }, (_value, index) => [index, index] as const),
        ),
        stablePoints: xyPath([[1, 2]]),
        stableStart: 0,
        tailPoints: xyPath([]),
      }),
    ).toEqual({ kind: 'unavailable' });
    expect(oversizedFaults).toEqual(['protocol-failed']);
    expect(oversizedFixture.worker().terminate).toHaveBeenCalledOnce();

    const nonFiniteFixture = workerFixture();
    const nonFiniteFaults: string[] = [];
    const nonFinite = await readyAdapter(
      nonFiniteFixture,
      () => undefined,
      (failure) => nonFiniteFaults.push(failure),
    );
    nonFinite.configure({
      backingHeight: 100,
      backingWidth: 100,
      frameEpoch: 1,
      transform: [1, 0, 0, 1, 0, 0],
    });
    nonFinite.beginContact({
      color: '#000000',
      contactSequence: 1,
      opacity: 1,
      tool: 'pen',
      width: 2,
    });
    expect(
      nonFinite.submit({
        generation: 1,
        provisionalPoints: xyPath([[Number.NaN, 4]]),
        stablePoints: xyPath([[1, 2]]),
        stableStart: 0,
        tailPoints: xyPath([]),
      }),
    ).toEqual({ kind: 'unavailable' });
    expect(nonFiniteFaults).toEqual(['protocol-failed']);
    expect(nonFiniteFixture.worker().terminate).toHaveBeenCalledOnce();
  });

  it('recycles late Acks from a reset contact without retaining per-contact sequence state', async () => {
    const fixture = workerFixture();
    const acknowledgements: InkWorkerPresentationAck[] = [];
    const adapter = await readyAdapter(fixture, (ack) => acknowledgements.push(ack));
    adapter.configure({
      backingHeight: 100,
      backingWidth: 100,
      frameEpoch: 1,
      transform: [1, 0, 0, 1, 0, 0],
    });
    adapter.beginContact({
      color: '#000000',
      contactSequence: 1,
      opacity: 1,
      tool: 'pen',
      width: 2,
    });
    const frame = {
      generation: 1,
      stablePoints: xyPath([[1, 2]]),
      stableStart: 0,
      tailPoints: xyPath([[3, 4]]),
    };
    adapter.submit(frame);
    adapter.submit({ ...frame, stableStart: 1 });
    const oldBuffers = fixture
      .worker()
      .messages.filter(({ message }) => message.type === 'ink-worker-frame')
      .map(({ message }) => message.buffer);
    adapter.reset();
    adapter.beginContact({
      color: '#000000',
      contactSequence: 2,
      opacity: 1,
      tool: 'pen',
      width: 2,
    });
    const current = adapter.submit(frame);
    expect(current).toMatchObject({ kind: 'submitted-async', packetSequence: 1 });
    const currentBuffer = fixture.worker().messages.at(-1)?.message.buffer;
    for (const buffer of oldBuffers) {
      if (!(buffer instanceof ArrayBuffer)) throw new Error('Missing stale Worker frame buffer.');
      fixture.worker().emitMessage({ buffer, session: 17, type: 'ink-worker-frame-ack' });
    }
    if (!(currentBuffer instanceof ArrayBuffer)) throw new Error('Missing current Worker frame.');
    fixture
      .worker()
      .emitMessage({ buffer: currentBuffer, session: 17, type: 'ink-worker-frame-ack' });

    expect(acknowledgements).toEqual([
      { contactSequence: 2, frameEpoch: 1, generation: 1, packetSequence: 1 },
    ]);
    expect(fixture.worker().terminate).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it('times out or rejects a late/foreign acknowledgement without reviving the Adapter', async () => {
    const timeoutFixture = workerFixture();
    const starting = prepareInkWorkerOffscreenPresentationAdapter({
      document,
      host: timeoutFixture.host,
      onAck: () => undefined,
      onFault: () => undefined,
      scheduler: timeoutFixture.scheduler,
      sessionEpoch: 17,
    });
    timeoutFixture.fireTimeout();
    await expect(starting).resolves.toEqual({
      failureCategory: 'handshake-timeout',
      kind: 'unavailable',
    });
    expect(timeoutFixture.worker().terminate).toHaveBeenCalledOnce();
    expect(timeoutFixture.revokeObjectURL).toHaveBeenCalledOnce();

    const fixture = workerFixture();
    const faults: string[] = [];
    const adapter = await readyAdapter(
      fixture,
      () => undefined,
      (failure) => faults.push(failure),
    );
    adapter.configure({
      backingHeight: 100,
      backingWidth: 100,
      frameEpoch: 1,
      transform: [1, 0, 0, 1, 0, 0],
    });
    adapter.beginContact({
      color: '#000000',
      contactSequence: 1,
      opacity: 1,
      tool: 'pen',
      width: 2,
    });
    const submission = adapter.submit({
      generation: 1,
      stablePoints: xyPath([[1, 2]]),
      stableStart: 0,
      tailPoints: xyPath([[3, 4]]),
    });
    expect(submission.kind).toBe('submitted-async');
    const frame = fixture.worker().messages.at(-1)?.message.buffer;
    if (!(frame instanceof ArrayBuffer)) throw new Error('Missing Worker frame buffer.');
    fixture.worker().emitMessage({ buffer: frame, session: 18, type: 'ink-worker-frame-ack' });

    expect(faults).toEqual(['protocol-failed']);
    expect(fixture.worker().terminate).toHaveBeenCalledOnce();
  });
});

async function readyAdapter(
  fixture: ReturnType<typeof workerFixture>,
  onAck: (ack: InkWorkerPresentationAck) => void,
  onFault: (failure: string) => void = () => undefined,
) {
  const starting = prepareInkWorkerOffscreenPresentationAdapter({
    document,
    host: fixture.host,
    onAck,
    onFault,
    scheduler: fixture.scheduler,
    sessionEpoch: 17,
  });
  const prewarmProbe = fixture.worker().messages[0]?.message.probeBuffer;
  if (!(prewarmProbe instanceof ArrayBuffer)) throw new Error('Missing Worker prewarm probe.');
  fixture
    .worker()
    .emitMessage({ probeBuffer: prewarmProbe, session: 17, type: 'ink-worker-prewarmed' });
  const preparation = await starting;
  if (preparation.kind !== 'ready') throw new Error('Expected a prepared Worker.');
  const activation = preparation.prepared.activate();
  const activationProbe = fixture.worker().messages.at(-1)?.message.probeBuffer;
  if (!(activationProbe instanceof ArrayBuffer))
    throw new Error('Missing Worker activation probe.');
  fixture
    .worker()
    .emitMessage({ probeBuffer: activationProbe, session: 17, type: 'ink-worker-ready' });
  const result = await activation.result;
  if (result.kind !== 'ready') throw new Error('Expected a ready Worker Adapter.');
  return result.adapter;
}

function xyPath(points: ReadonlyArray<readonly [number, number]>) {
  const cursor = { x: 0, y: 0 };
  return {
    at(index: number) {
      const point = points[index];
      if (point === undefined) return undefined;
      cursor.x = point[0];
      cursor.y = point[1];
      return cursor;
    },
    length: points.length,
  };
}

function offscreenCanvasFixture() {
  const context = {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'round',
    lineJoin: 'round',
    lineTo: vi.fn(),
    lineWidth: 1,
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setLineDash: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    strokeStyle: '#000000',
  };
  const canvas = {
    addEventListener: vi.fn(),
    getContext: vi.fn(() => context),
    height: 1,
    width: 1,
  };
  return { canvas, context };
}

function workerFixture() {
  const workers: FakeWorker[] = [];
  const transferredCanvases: unknown[] = [];
  class WorkerFixture extends FakeWorker {
    constructor(url: string) {
      super(url);
      workers.push(this);
    }
  }
  class BlobFixture {
    constructor(
      readonly parts: readonly unknown[],
      readonly options: unknown,
    ) {}
  }
  let timeout: (() => void) | null = null;
  const scheduler = {
    cancel: vi.fn(),
    schedule: vi.fn((callback: () => void) => {
      timeout = callback;
      return { kind: 'timer' };
    }),
  };
  const revokeObjectURL = vi.fn();
  const transferControlToOffscreen = vi.fn(function (this: HTMLCanvasElement) {
    const transferred = { source: this };
    transferredCanvases.push(transferred);
    return transferred as unknown as OffscreenCanvas;
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
    configurable: true,
    value: transferControlToOffscreen,
  });
  return {
    fireTimeout: () => {
      if (timeout === null) throw new Error('Expected a readiness timeout.');
      timeout();
    },
    host: {
      Blob: BlobFixture,
      URL: { createObjectURL: () => 'blob:ink-worker', revokeObjectURL },
      Worker: WorkerFixture,
    },
    revokeObjectURL,
    scheduler,
    transferControlToOffscreen,
    transferredCanvases,
    worker: () => {
      const worker = workers[0];
      if (worker === undefined) throw new Error('Expected Worker construction.');
      return worker;
    },
  };
}

class FakeWorker {
  onerror: ((event: unknown) => unknown) | null = null;
  onmessage: ((event: { readonly data: Record<string, unknown> }) => unknown) | null = null;
  onmessageerror: ((event: unknown) => unknown) | null = null;
  readonly messages: Array<{
    readonly message: Record<string, unknown>;
    readonly transfer: readonly unknown[];
  }> = [];
  readonly terminate = vi.fn();

  constructor(readonly url: string) {}

  emitMessage(data: Record<string, unknown>): void {
    this.onmessage?.({ data });
  }

  postMessage(message: Record<string, unknown>, transfer: readonly unknown[] = []): void {
    this.messages.push({ message, transfer });
  }
}
