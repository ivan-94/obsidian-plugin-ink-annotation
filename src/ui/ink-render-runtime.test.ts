// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  InkDocumentChange,
  InkDocumentReadView,
  InkLogicalRect,
  InkRenderableStrokeRef,
} from '../application/ink-document-session';
import { INK_SAMPLE_FLAGS, type InkSampleCursor, type InkSampleView } from '../domain/ink-contact';
import type { InkBorrowedControlTraceDelta } from '../domain/ink-control-trace';
import { createInkBrushActiveGeometryUpdate } from '../domain/ink-brush-geometry-contract';
import { SharedInkStrokeGeometry } from '../domain/ink-shared-stroke-geometry';
import type { InkStroke } from '../domain/ink-surface';
import {
  LegacyRoundInkStrokeGeometry,
  type InkStrokeGeometry,
} from '../domain/ink-stroke-geometry';
import { InkPerformanceDiagnostics } from '../runtime/ink-performance-diagnostics';
import type { InkBorrowedProvisionalTail } from './ink-capture-pipeline';
import { createInkStageFrame } from './ink-stage-frame';
import {
  InkRenderRuntime,
  type InkWorkerPresentationAdapterPort,
  type InkWorkerPresentationPreparationFactory,
  type InkWorkerPresentationPreparationResult,
} from './ink-render-runtime';

describe('InkRenderRuntime', () => {
  let contexts: WeakMap<HTMLCanvasElement, ContextFixture>;

  beforeEach(() => {
    document.body.replaceChildren();
    contexts = new WeakMap();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing.context;
      const created = contextFixture();
      contexts.set(this, created);
      return created.context;
    });
  });

  it('owns one rAF and processes only new stable geometry plus the mutable tail', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = new InkRenderRuntime({
      document,
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    expect(frames).toHaveLength(1);
    drain(frames);

    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(20, 20, 4)],
        stablePrefixDelta: [point(10, 10, 0)],
      },
      strokeId: 'active',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(40, 30, 12)],
        stablePrefixDelta: [point(20, 20, 4), point(30, 25, 8)],
      },
      strokeId: 'active',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });

    expect(frames).toHaveLength(1);
    drain(frames);
    const active = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const fixtureContext = active === null ? undefined : contexts.get(active);
    expect(fixtureContext?.stroke).toHaveBeenCalled();
    expect(fixtureContext?.lineTo.mock.calls.length).toBeLessThanOrEqual(8);
    expect(runtime.stats().queuedFrameCount).toBe(0);
    runtime.dispose();
  });

  it('presents the first active frame before any pending committed history rebuild', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture(
      Array.from({ length: 100 }, (_, index) => stroke(`h-${index}`)),
    );
    const query = vi.fn(fixture.query);
    const runtime = new InkRenderRuntime({
      document,
      host,
      query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(20, 20, 4)],
        stablePrefixDelta: [point(10, 10, 0)],
      },
      strokeId: 'active-first-tip',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });

    drain(frames);

    const active = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const activeContext = active === null ? undefined : contexts.get(active);
    expect(activeContext?.stroke).toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(runtime.stats().visibleRecoveryRebuildCount).toBe(0);
    runtime.cancelActive();
    drain(frames);
    expect(query).toHaveBeenCalled();
    runtime.dispose();
  });

  it('does not rebuild the committed viewport for subpixel-equivalent Stage Frames', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture(
      Array.from({ length: 176 }, (_value, index) =>
        stroke(`history-${String(index)}`, 10 + Math.floor(index / 20) * 12),
      ),
    );
    const diagnostics = new InkPerformanceDiagnostics(true);
    const runtime = runtimeFixture(host, fixture, frames, diagnostics);
    runtime.setFrame(frame(0.8));
    runtime.installDocument(fixture.read());
    drain(frames);
    diagnostics.reset();

    runtime.setFrame(
      createInkStageFrame({
        actualScale: 0.8 + 1e-8,
        canvasClientRect: { height: 200.01, left: 0.01, top: -0.01, width: 200.01 },
        documentClientOrigin: { x: 0.01, y: -0.01 },
      }),
    );
    drain(frames);

    expect(
      diagnostics.snapshot().recentSpans.filter(({ name }) => name === 'ink-viewport-redraw'),
    ).toEqual([]);
    runtime.dispose();
  });

  it('defers Stage Frame replacement and viewport rebuild until the active contact ends', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('history')]);
    const query = vi.fn(fixture.query);
    const runtime = new InkRenderRuntime({
      document,
      host,
      query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(30, 25, 8)],
        stablePrefixDelta: [point(10, 10, 0), point(20, 20, 4)],
      },
      strokeId: 'active',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);
    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const committedContext = committed === null ? undefined : contexts.get(committed);
    if (committedContext === undefined) throw new Error('Missing committed Canvas context.');
    const clearsBeforeViewportChange = committedContext.clearRect.mock.calls.length;
    query.mockClear();

    runtime.setFrame(frame(0.5));
    runtime.invalidateViewport();
    drain(frames);

    expect(committedContext.clearRect).toHaveBeenCalledTimes(clearsBeforeViewportChange);
    expect(query).not.toHaveBeenCalled();

    runtime.cancelActive();
    drain(frames);

    expect(committedContext.clearRect.mock.calls.length).toBeGreaterThan(
      clearsBeforeViewportChange,
    );
    expect(query).toHaveBeenCalled();
    runtime.dispose();
  });

  it('projects during scrolling and rebuilds the settled viewport without shifting committed pixels', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('history')]);
    const query = vi.fn(fixture.query);
    const runtime = new InkRenderRuntime({
      document,
      host,
      query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const committedContext = committed === null ? undefined : contexts.get(committed);
    if (committed === null || committedContext === undefined) {
      throw new Error('Missing committed Canvas fixture.');
    }
    const clearsBeforeScroll = committedContext.clearRect.mock.calls.length;
    query.mockClear();
    const scrolled = createInkStageFrame({
      actualScale: 1,
      canvasClientRect: { height: 200, left: 0, top: 0, width: 200 },
      documentClientOrigin: { x: 0, y: -80 },
    });

    runtime.projectFrame(scrolled);

    expect(committedContext.clearRect).toHaveBeenCalledTimes(clearsBeforeScroll);
    expect(query).not.toHaveBeenCalled();
    expect(committed.style.transform).toContain('matrix');

    runtime.setFrame(scrolled);
    runtime.invalidateViewport();
    drain(frames);

    expect(query).toHaveBeenCalledOnce();
    expect(committedContext.drawImage).not.toHaveBeenCalled();
    expect(query.mock.calls[0]?.[0]).toMatchObject({ height: 200, y: 80 });
    expect(
      committedContext.clearRect.mock.calls
        .slice(clearsBeforeScroll)
        .some(([x, y, width, height]) => x === 0 && y === 0 && width === 200 && height === 200),
    ).toBe(true);
    expect(committed.style.transform).toBe('');
    runtime.dispose();
  });

  it('prepares the Worker Adapter in the background and swaps only the idle active pair', async () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: {
        enabled: true,
        prepare: worker.prepare,
      },
    });

    const retiredStable = host.querySelector<HTMLCanvasElement>(
      '[data-inkstone-ink-active-stable="true"]',
    );
    const retiredTail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active="true"]');
    if (retiredStable === null || retiredTail === null) {
      throw new Error('Missing initial main-thread Active pair.');
    }
    expect(host.querySelectorAll('canvas')).toHaveLength(3);
    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBeNull();
    expect(worker.activate).not.toHaveBeenCalled();
    expect(runtime.activePresentationAdapterState).toEqual({
      adapter: 'main-canvas-2d',
      epoch: 1,
      requestedAdapter: 'worker-offscreen-2d',
    });
    expect(Object.isFrozen(runtime.activePresentationAdapterState)).toBe(true);

    await worker.resolveReady();

    expect(retiredStable.width).toBe(0);
    expect(retiredStable.height).toBe(0);
    expect(retiredTail.width).toBe(0);
    expect(retiredTail.height).toBe(0);
    expect(host.querySelectorAll('canvas')).toHaveLength(3);
    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBe(worker.tail);
    expect(host.querySelector('[data-inkstone-ink-active-stable="worker"]')).toBe(worker.stable);
    expect(runtime.activePresentationAdapterState).toEqual({
      adapter: 'worker-offscreen-2d',
      epoch: 3,
      requestedAdapter: 'worker-offscreen-2d',
    });
    expect(runtime.stats().backingStoreCount).toBe(3);
    runtime.dispose();
    expect(runtime.activePresentationAdapterState).toBeNull();
    expect(worker.dispose).toHaveBeenCalledOnce();
  });

  it('reports requested Worker separately from effective main after startup fallback', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = new InkRenderRuntime({
      document,
      host,
      query: fixture.query,
      read: fixture.read,
      workerPresentation: {
        enabled: true,
        prepare: () => Promise.resolve({ failureCategory: 'api-unavailable', kind: 'unavailable' }),
      },
    });

    await Promise.resolve();

    expect(runtime.activePresentationAdapterState).toEqual({
      adapter: 'main-canvas-2d',
      epoch: 1,
      requestedAdapter: 'worker-offscreen-2d',
    });
    runtime.dispose();
  });

  it('retains a canvas-free prepared Worker during an active contact and activates it at idle', async () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    drain(frames);
    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(20, 20, 4)],
        stablePrefixDelta: [point(10, 10, 0)],
      },
      strokeId: 'main-contact-during-prewarm',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    await worker.resolvePrepared();

    expect(worker.activate).not.toHaveBeenCalled();
    expect(worker.disposePrepared).not.toHaveBeenCalled();
    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBeNull();

    runtime.cancelActive();
    expect(worker.activate).toHaveBeenCalledOnce();
    await worker.resolveActivationReady();

    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBe(worker.tail);
    runtime.dispose();
  });

  it('cancels a pending activation for new input, draws main truth, and disposes a late ready Adapter', async () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    drain(frames);
    await worker.resolvePrepared();
    expect(worker.activate).toHaveBeenCalledOnce();
    expect(runtime.activePresentationAdapterState).toBeNull();

    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(30, 30, 8)],
        stablePrefixDelta: [point(10, 10, 0), point(20, 20, 4)],
      },
      strokeId: 'input-raced-worker-activation',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    expect(worker.cancelActivation).toHaveBeenCalledOnce();
    expect(runtime.activePresentationAdapterState).toEqual({
      adapter: 'main-canvas-2d',
      epoch: 3,
      requestedAdapter: 'worker-offscreen-2d',
    });
    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBeNull();
    const mainStable = host.querySelector<HTMLCanvasElement>(
      '[data-inkstone-ink-active-stable="true"]',
    );
    if (mainStable === null) throw new Error('Activation race did not install a main pair.');
    expect(contexts.get(mainStable)?.moveTo).toHaveBeenCalledWith(10, 10);
    expect(contexts.get(mainStable)?.lineTo).toHaveBeenCalledWith(20, 20);

    await worker.resolveActivationReady();

    expect(worker.dispose).toHaveBeenCalledOnce();
    expect(runtime.activePresentationAdapterState).toEqual({
      adapter: 'main-canvas-2d',
      epoch: 3,
      requestedAdapter: 'worker-offscreen-2d',
    });
    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBeNull();
    runtime.dispose();
  });

  it('fails a throwing Worker frame configuration back to a fresh main pair', async () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    worker.configure.mockImplementationOnce(() => {
      throw new Error('synthetic Worker configure failure');
    });
    const runtime = new InkRenderRuntime({
      document,
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    drain(frames);

    await worker.resolveReady();
    await Promise.resolve();

    expect(host.querySelectorAll('canvas')).toHaveLength(3);
    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBeNull();
    expect(worker.dispose).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it('submits Worker active truth asynchronously and acknowledges only after the exact Ack', async () => {
    const frames: FrameRequestCallback[] = [];
    const submitted: Array<number | null> = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      onActiveFrame: (generation) => submitted.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    submitted.length = 0;
    await worker.resolveReady();
    const provisional = new Float64Array([25, 25, 30, 30]);

    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(20, 20, 4)],
        stablePrefixDelta: [point(10, 10, 0)],
      },
      presentationGeneration: 7,
      provisionalTail: borrowedProvisionalTail(provisional),
      strokeId: 'worker-active',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    provisional.fill(999);
    drain(frames);

    expect(worker.configure).toHaveBeenCalledOnce();
    expect(worker.beginContact).toHaveBeenCalledOnce();
    expect(worker.submit).toHaveBeenCalledOnce();
    const workerSubmission = worker.submit.mock.calls[0]?.[0];
    expect(workerSubmission?.provisionalPoints?.length).toBe(2);
    expect(workerSubmission?.provisionalPoints?.at(0)).toMatchObject({ x: 25, y: 25 });
    expect(workerSubmission?.provisionalPoints?.at(1)).toMatchObject({ x: 30, y: 30 });
    expect(workerSubmission?.tailPoints.at(0)).not.toMatchObject({ x: 25, y: 25 });
    expect(submitted).toEqual([]);
    expect(runtime.stats().backingStoreBytes).toBe(200 * 200 * 4 * 3);

    worker.ackLatest();

    expect(submitted).toEqual([7]);
    runtime.dispose();
  });

  it('composites Worker Highlighter stable and tail through one shared stack opacity', async () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    drain(frames);
    await worker.resolveReady();

    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(20, 20, 4)],
        stablePrefixDelta: [point(10, 10, 0)],
      },
      presentationGeneration: 8,
      strokeId: 'worker-highlighter',
      style: { color: '#ffd54f', tool: 'highlighter', width: 12 },
    });
    drain(frames);

    expect(host.querySelector<HTMLElement>('.inkstone-ink-active-stack')?.style.opacity).toBe(
      '0.45',
    );
    expect(worker.stable.style.opacity).toBe('1');
    expect(worker.tail.style.opacity).toBe('1');
    worker.ackLatest();
    runtime.dispose();
  });

  it('does not let an older Worker Ack complete truth dirtied by newer input', async () => {
    const frames: FrameRequestCallback[] = [];
    const submitted: Array<number | null> = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      onActiveFrame: (generation) => submitted.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    drain(frames);
    submitted.length = 0;
    await worker.resolveReady();

    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(20, 20, 4)],
        stablePrefixDelta: [point(10, 10, 0)],
      },
      presentationGeneration: 7,
      strokeId: 'worker-active',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);
    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(30, 30, 8)],
        stablePrefixDelta: [point(20, 20, 4)],
      },
      presentationGeneration: 7,
      strokeId: 'worker-active',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    worker.ackPacket(1);
    expect(submitted).toEqual([]);
    worker.ackPacket(2);
    expect(submitted).toEqual([7]);
    runtime.dispose();
  });

  it('retires a faulted Worker generation, installs a fresh three-store main pair, and replays truth', async () => {
    const frames: FrameRequestCallback[] = [];
    const submitted: Array<number | null> = [];
    const unpresented: number[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      onActiveFrame: (generation) => submitted.push(generation),
      onActiveFrameUnpresented: (generation) => unpresented.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    drain(frames);
    submitted.length = 0;
    await worker.resolveReady();
    expect(runtime.activePresentationAdapterState).toEqual({
      adapter: 'worker-offscreen-2d',
      epoch: 3,
      requestedAdapter: 'worker-offscreen-2d',
    });
    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(30, 30, 8)],
        stablePrefixDelta: [point(10, 10, 0), point(20, 20, 4)],
      },
      presentationGeneration: 11,
      provisionalTail: borrowedProvisionalTail(new Float64Array([90, 90])),
      strokeId: 'worker-fault',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    worker.fault('context-unavailable');

    expect(unpresented).toEqual([11]);
    expect(runtime.activePresentationAdapterState).toEqual({
      adapter: 'main-canvas-2d',
      epoch: 4,
      requestedAdapter: 'worker-offscreen-2d',
    });
    expect(host.querySelectorAll('canvas')).toHaveLength(3);
    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBeNull();
    const mainStable = host.querySelector<HTMLCanvasElement>(
      '[data-inkstone-ink-active-stable="true"]',
    );
    if (mainStable === null)
      throw new Error('Worker fallback did not install a main stable layer.');
    drain(frames);
    expect(contexts.get(mainStable)?.moveTo).toHaveBeenCalledWith(10, 10);
    expect(contexts.get(mainStable)?.lineTo).toHaveBeenCalledWith(20, 20);
    const mainTail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active="true"]');
    if (mainTail === null) throw new Error('Worker fallback did not install a main tail layer.');
    expect(contexts.get(mainTail)?.lineTo).not.toHaveBeenCalledWith(90, 90);
    expect(submitted).not.toContain(11);
    expect(runtime.stats().backingStoreCount).toBe(3);

    worker.ackPacket(1);
    expect(submitted).not.toContain(11);
    expect(host.querySelectorAll('canvas')).toHaveLength(3);
    runtime.dispose();
  });

  it('fails a three-slot Worker backpressure result closed and keeps main-thread truth', async () => {
    const frames: FrameRequestCallback[] = [];
    const unpresented: number[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    worker.submit.mockReturnValueOnce({ kind: 'backpressured' });
    const runtime = new InkRenderRuntime({
      document,
      host,
      onActiveFrameUnpresented: (generation) => unpresented.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    drain(frames);
    await worker.resolveReady();
    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(30, 30, 8)],
        stablePrefixDelta: [point(10, 10, 0), point(20, 20, 4)],
      },
      presentationGeneration: 12,
      strokeId: 'worker-backpressure',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    expect(unpresented).toEqual([12]);
    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBeNull();
    const mainStable = host.querySelector<HTMLCanvasElement>(
      '[data-inkstone-ink-active-stable="true"]',
    );
    if (mainStable === null) throw new Error('Backpressure did not install main truth replay.');
    expect(contexts.get(mainStable)?.lineTo).toHaveBeenCalledWith(20, 20);
    expect(host.querySelectorAll('canvas')).toHaveLength(3);
    runtime.dispose();
  });

  it('fences a missing Worker Ack at the injected deadline and ignores its late arrival', async () => {
    const frames: FrameRequestCallback[] = [];
    const submitted: Array<number | null> = [];
    const unpresented: number[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const deadline = deadlineFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      onActiveFrame: (generation) => submitted.push(generation),
      onActiveFrameUnpresented: (generation) => unpresented.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: {
        ackDeadlineMs: 25,
        deadlineScheduler: deadline.scheduler,
        enabled: true,
        prepare: worker.prepare,
      },
    });
    runtime.setFrame(frame());
    drain(frames);
    submitted.length = 0;
    await worker.resolveReady();
    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(20, 20, 4)],
        stablePrefixDelta: [point(10, 10, 0)],
      },
      presentationGeneration: 13,
      provisionalTail: borrowedProvisionalTail(new Float64Array([91, 91])),
      strokeId: 'worker-timeout',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    expect(deadline.scheduler.schedule).toHaveBeenCalledWith(expect.any(Function), 25);
    deadline.fireLatest();

    expect(unpresented).toEqual([13]);
    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBeNull();
    drain(frames);
    const timeoutMainTail = host.querySelector<HTMLCanvasElement>(
      '[data-inkstone-ink-active="true"]',
    );
    if (timeoutMainTail === null) throw new Error('Worker timeout did not install a main tail.');
    expect(contexts.get(timeoutMainTail)?.lineTo).not.toHaveBeenCalledWith(91, 91);
    worker.ackPacket(1);
    expect(submitted).not.toContain(13);
    runtime.dispose();
  });

  it('selects a fresh main pair for the entire Eraser contact instead of Worker raster', async () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    drain(frames);
    await worker.resolveReady();

    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(30, 30, 8)],
        stablePrefixDelta: [point(10, 10, 0), point(20, 20, 4)],
      },
      eraserColor: '#dc2626',
      strokeId: 'main-eraser',
      style: { color: '#000000', tool: 'eraser', width: 8 },
    });
    drain(frames);

    expect(worker.beginContact).not.toHaveBeenCalled();
    expect(worker.submit).not.toHaveBeenCalled();
    expect(worker.dispose).toHaveBeenCalledOnce();
    expect(host.querySelectorAll('canvas')).toHaveLength(3);
    const mainStable = host.querySelector<HTMLCanvasElement>(
      '[data-inkstone-ink-active-stable="true"]',
    );
    if (mainStable === null) throw new Error('Eraser did not select the main stable layer.');
    expect(contexts.get(mainStable)?.setLineDash).toHaveBeenCalledWith([6, 4]);
    runtime.dispose();
  });

  it('fails an idle Worker pair back before drawing a main-thread overlay', async () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const saved = stroke('overlay');
    const fixture = documentFixture([saved]);
    const worker = workerPresentationFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    await worker.resolveReady();
    const overlayRef = refs([saved])[0];
    if (overlayRef === undefined) throw new Error('Missing overlay fixture.');

    runtime.setOverlay({ hovered: [overlayRef], selected: [] });
    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBeNull();
    expect(host.querySelectorAll('canvas')).toHaveLength(3);
    drain(frames);

    const mainTail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active="true"]');
    if (mainTail === null) throw new Error('Overlay did not select the main tail layer.');
    expect(contexts.get(mainTail)?.stroke).toHaveBeenCalled();
    runtime.dispose();
  });

  it('does not schedule or redraw when the overlay receives the same refs in the same order', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const first = stroke('overlay-first');
    const second = stroke('overlay-second', 60);
    const fixture = documentFixture([first, second]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (tail === null) throw new Error('Missing Active Stroke tail layer.');
    const context = contexts.get(tail);
    const [firstRef, secondRef] = refs([first, second]);
    if (context === undefined || firstRef === undefined || secondRef === undefined) {
      throw new Error('Missing overlay fixtures.');
    }
    runtime.setOverlay({ hovered: [], selected: [firstRef, secondRef] });
    drain(frames);
    context.clearRect.mockClear();
    context.fill.mockClear();
    context.stroke.mockClear();

    runtime.setOverlay({ hovered: [], selected: [firstRef, secondRef] });

    expect(frames).toHaveLength(0);
    expect(context.clearRect).not.toHaveBeenCalled();
    expect(context.fill).not.toHaveBeenCalled();
    expect(context.stroke).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('keeps Worker truth on the frozen frame until an active Stage Frame replacement can apply', async () => {
    const frames: FrameRequestCallback[] = [];
    const unpresented: number[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      onActiveFrameUnpresented: (generation) => unpresented.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    drain(frames);
    await worker.resolveReady();
    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(30, 30, 8)],
        stablePrefixDelta: [point(10, 10, 0), point(20, 20, 4)],
      },
      presentationGeneration: 17,
      strokeId: 'worker-frame-change',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    runtime.setFrame(frame(0.5));

    expect(unpresented).toEqual([]);
    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBe(worker.tail);
    expect(frames).toHaveLength(0);

    runtime.cancelActive();
    expect(unpresented).toEqual([17]);
    drain(frames);
    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBe(worker.tail);
    runtime.dispose();
  });

  it('fails Worker presentation back and replays truth after committed context recovery', async () => {
    const frames: FrameRequestCallback[] = [];
    const unpresented: number[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      onActiveFrameUnpresented: (generation) => unpresented.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    drain(frames);
    await worker.resolveReady();
    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(30, 30, 8)],
        stablePrefixDelta: [point(10, 10, 0), point(20, 20, 4)],
      },
      presentationGeneration: 18,
      strokeId: 'worker-context-recovery',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);
    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    if (committed === null) throw new Error('Missing committed Canvas.');

    committed.dispatchEvent(new Event('contextlost', { cancelable: true }));

    expect(unpresented).toEqual([18]);
    expect(host.querySelector('[data-inkstone-ink-active="worker"]')).toBeNull();
    committed.dispatchEvent(new Event('contextrestored'));
    drain(frames);
    const mainStable = host.querySelector<HTMLCanvasElement>(
      '[data-inkstone-ink-active-stable="true"]',
    );
    if (mainStable === null) throw new Error('Context recovery did not install main presentation.');
    expect(contexts.get(mainStable)?.lineTo).toHaveBeenCalledWith(20, 20);
    runtime.dispose();
  });

  it('orders Worker frame before promotion reset and fences the late Ack without stale replay', async () => {
    const frames: FrameRequestCallback[] = [];
    const submitted: Array<number | null> = [];
    const unpresented: number[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const completed = stroke('worker-promote');
    const canonicalBefore = JSON.stringify(completed);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const deadline = deadlineFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      onActiveFrame: (generation) => submitted.push(generation),
      onActiveFrameUnpresented: (generation) => unpresented.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: {
        deadlineScheduler: deadline.scheduler,
        enabled: true,
        prepare: worker.prepare,
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    submitted.length = 0;
    await worker.resolveReady();
    runtime.applyActiveDelta({
      delta: { mutableTail: [], stablePrefixDelta: completed.points },
      presentationGeneration: 19,
      strokeId: completed.id,
      style: { color: completed.color, tool: completed.tool, width: completed.width },
    });
    runtime.finalizeActive(completed);
    drain(frames);

    fixture.replace([completed]);
    runtime.promoteActive(completed.id);
    runtime.applyDocumentChange(
      change('worker-complete', { addedIds: [completed.id], newStroke: completed }),
    );
    runtime.flushNow();

    expect(worker.submit.mock.invocationCallOrder[0]).toBeLessThan(
      worker.reset.mock.invocationCallOrder[0] ?? 0,
    );
    expect(unpresented).toEqual([19]);
    expect(runtime.stats().activeStrokeId).toBeNull();
    expect(JSON.stringify(completed)).toBe(canonicalBefore);
    expect(deadline.pendingCount()).toBe(0);
    worker.ackPacket(1);
    expect(submitted).not.toContain(19);
    expect(host.querySelectorAll('canvas')).toHaveLength(3);
    runtime.dispose();
  });

  it('resets and fences a cancelled Worker contact before accepting another contact', async () => {
    const frames: FrameRequestCallback[] = [];
    const submitted: Array<number | null> = [];
    const unpresented: number[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      onActiveFrame: (generation) => submitted.push(generation),
      onActiveFrameUnpresented: (generation) => unpresented.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    drain(frames);
    submitted.length = 0;
    await worker.resolveReady();
    runtime.applyActiveDelta({
      delta: { mutableTail: [], stablePrefixDelta: [point(10, 10, 0)] },
      presentationGeneration: 23,
      strokeId: 'worker-cancelled',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    runtime.cancelActive();
    worker.ackPacket(1);

    expect(unpresented).toEqual([23]);
    expect(submitted).not.toContain(23);
    expect(worker.reset).toHaveBeenCalledOnce();
    expect(runtime.stats().activeStrokeId).toBeNull();

    runtime.applyActiveDelta({
      delta: { mutableTail: [], stablePrefixDelta: [point(20, 20, 0)] },
      presentationGeneration: 24,
      strokeId: 'worker-next',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);
    expect(worker.beginContact).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it('records frame debt only while confirmed active presentation work is pending', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const diagnostics = new InkPerformanceDiagnostics(true);
    let now = 0;
    const runtime = new InkRenderRuntime({
      document,
      host,
      inkPerformance: diagnostics,
      now: () => now,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    frames.shift()?.(0);
    runtime.setActivePerformanceContact(diagnostics.openContact('pointer'));

    now = 10;
    runtime.applyActiveDelta({
      delta: { mutableTail: [point(20, 20, 4)], stablePrefixDelta: [point(10, 10, 0)] },
      strokeId: 'active',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    frames.shift()?.(16.7);

    // Holding the Pencil stationary does not create pending presentation work or frame debt.
    now = 1_000;
    runtime.applyActiveDelta({
      delta: { mutableTail: [point(30, 20, 8)], stablePrefixDelta: [point(20, 20, 4)] },
      strokeId: 'active',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    frames.shift()?.(1_008);

    expect(diagnostics.snapshot().frameIntervalsMs.activeWriting).toEqual([6.7, 8]);
    runtime.dispose();
  });

  it('acknowledges only the Active presentation generation consumed by a successful frame', () => {
    const frames: FrameRequestCallback[] = [];
    const submitted: Array<number | null> = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = new InkRenderRuntime({
      document,
      host,
      onActiveFrame: (generation) => submitted.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    submitted.length = 0;

    runtime.invalidateViewport();
    drain(frames);
    expect(submitted).toEqual([null]);
    submitted.length = 0;

    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(20, 20, 4)],
        stablePrefixDelta: [point(10, 10, 0)],
      },
      presentationGeneration: 7,
      strokeId: 'generation-owned',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    expect(submitted).toEqual([7]);
    runtime.invalidateViewport();
    drain(frames);
    expect(submitted).toEqual([7]);
    runtime.cancelActive();
    drain(frames);
    expect(submitted).toEqual([7, null]);
    runtime.dispose();
  });

  it('defers committed document work while a contact owns the frame before Active geometry arrives', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('history')]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const context = committed === null ? undefined : contexts.get(committed);
    const strokesBefore = context?.stroke.mock.calls.length ?? 0;
    const added = stroke('deferred-during-contact', 80);
    fixture.replace([stroke('history'), added]);
    runtime.applyDocumentChange(
      change('deferred-during-contact', { addedIds: [added.id], newStroke: added }),
    );
    runtime.setActivePerformanceContact({ adapter: 'pointer', sequence: 1 });

    frames.shift()?.(16.7);

    expect(context?.stroke).toHaveBeenCalledTimes(strokesBefore);
    runtime.setActivePerformanceContact(null);
    drain(frames);
    expect(context?.stroke).toHaveBeenCalledTimes(strokesBefore + 1);
    runtime.dispose();
  });

  it('keeps a failed Active presentation generation pending until a successful retry', () => {
    const frames: FrameRequestCallback[] = [];
    const submitted: Array<number | null> = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const diagnostics = new InkPerformanceDiagnostics(true);
    let now = 10;
    const runtime = new InkRenderRuntime({
      document,
      host,
      inkPerformance: diagnostics,
      now: () => now,
      onActiveFrame: (generation) => submitted.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    submitted.length = 0;
    runtime.setActivePerformanceContact(diagnostics.openContact('pointer'));
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (tail === null) throw new Error('Missing Active Stroke tail layer.');
    const tailContext = contexts.get(tail);
    tailContext?.stroke.mockImplementationOnce(() => {
      throw new Error('synthetic Canvas failure');
    });

    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(20, 20, 4)],
        stablePrefixDelta: [point(10, 10, 0)],
      },
      presentationGeneration: 9,
      strokeId: 'retry-generation',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    const failedFrame = frames.shift();
    expect(() => failedFrame?.(16.7)).toThrow('synthetic Canvas failure');
    expect(submitted).toEqual([null]);
    expect(diagnostics.snapshot().frameIntervalsMs.activeWriting).toEqual([]);

    now = 40;
    runtime.flushNow();
    expect(submitted).toEqual([null, 9]);
    expect(diagnostics.snapshot().frameIntervalsMs.activeWriting).toEqual([30]);
    runtime.dispose();
  });

  it('retires pending Active work when a Canvas context is lost and never acknowledges it later', () => {
    const frames: FrameRequestCallback[] = [];
    const submitted: Array<number | null> = [];
    const unpresented: number[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const diagnostics = new InkPerformanceDiagnostics(true);
    let now = 10;
    const runtime = new InkRenderRuntime({
      document,
      host,
      inkPerformance: diagnostics,
      now: () => now,
      onActiveFrame: (generation) => submitted.push(generation),
      onActiveFrameUnpresented: (generation) => unpresented.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    submitted.length = 0;
    runtime.setActivePerformanceContact(diagnostics.openContact('pointer'));
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (tail === null) throw new Error('Missing Active Stroke tail layer.');

    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(20, 20, 4)],
        stablePrefixDelta: [point(10, 10, 0)],
      },
      presentationGeneration: 11,
      strokeId: 'context-owned',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    tail.dispatchEvent(new Event('contextlost', { cancelable: true }));
    frames.shift()?.(20);
    expect(submitted).toEqual([null]);
    expect(unpresented).toEqual([11]);
    expect(diagnostics.snapshot().frameIntervalsMs.activeWriting).toEqual([]);

    now = 45;
    tail.dispatchEvent(new Event('contextrestored'));
    frames.shift()?.(45);
    expect(submitted).toEqual([null, null]);
    expect(unpresented).toEqual([11]);
    expect(diagnostics.snapshot().frameIntervalsMs.activeWriting).toEqual([]);
    runtime.dispose();
  });

  it('does not collect per-frame memory statistics while Ink diagnostics are disabled', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const diagnostics = new InkPerformanceDiagnostics(false);
    const recordMemory = vi.spyOn(diagnostics, 'recordMemory');
    const runtime = new InkRenderRuntime({
      document,
      host,
      inkPerformance: diagnostics,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });

    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);

    expect(recordMemory).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('keeps the next active frame bounded after a 50k-point horizontal prefix', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const prefix = Array.from({ length: 50_000 }, (_value, index) => point(index * 4, 100, index));

    runtime.applyActiveDelta({
      delta: { mutableTail: [], stablePrefixDelta: prefix },
      strokeId: 'long-active',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);
    const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (stable === null || tail === null) throw new Error('Missing split Active Stroke layers.');
    const stableContext = contexts.get(stable);
    const tailContext = contexts.get(tail);
    for (const context of [stableContext, tailContext]) {
      context?.clearRect.mockClear();
      context?.lineTo.mockClear();
      context?.stroke.mockClear();
    }
    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(200_004, 100, 50_001)],
        stablePrefixDelta: [point(200_000, 100, 50_000)],
      },
      strokeId: 'long-active',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    expect(runtime.stats().activeSegmentCount).toBe(50_000);
    expect(runtime.stats().activeStableChunkCount).toBe(196);
    expect(runtime.stats().lastActiveSubmittedSegmentCount).toBeLessThanOrEqual(32);
    expect(
      (stableContext?.lineTo.mock.calls.length ?? 0) + (tailContext?.lineTo.mock.calls.length ?? 0),
    ).toBe(2);
    expect(
      (stableContext?.stroke.mock.calls.length ?? 0) + (tailContext?.stroke.mock.calls.length ?? 0),
    ).toBe(2);
    expect(stableContext?.clearRect).not.toHaveBeenCalled();
    expect(tailContext?.clearRect).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it('copies borrowed active geometry into runtime-owned numeric storage before a delayed frame', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = new InkRenderRuntime({
      document,
      geometry: borrowingActiveGeometry(),
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const stableSource = [point(10, 10, 0), point(20, 20, 4)];
    const tailSource = [point(30, 30, 8)];

    runtime.applyActiveDelta({
      delta: { mutableTail: tailSource, stablePrefixDelta: stableSource },
      strokeId: 'borrowed-active',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    stableSource[0]!.x = 900;
    stableSource[1]!.x = 901;
    tailSource[0]!.x = 902;
    drain(frames);

    const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (stable === null || tail === null) throw new Error('Missing split Active Stroke layers.');
    expect(contexts.get(stable)?.moveTo).toHaveBeenCalledWith(10, 10);
    expect(contexts.get(stable)?.lineTo).toHaveBeenCalledWith(20, 20);
    expect(contexts.get(tail)?.moveTo).toHaveBeenCalledWith(20, 20);
    expect(contexts.get(tail)?.lineTo).toHaveBeenCalledWith(30, 30);
    expect(runtime.stats()).toMatchObject({
      activeStableEncoding: 'legacy-ink-point',
      activeStableStorageKind: 'float64-chunks',
      activeTailEncoding: 'legacy-ink-point',
      activeTailStorageKind: 'float64-ring',
    });
    runtime.dispose();
  });

  it('copies a borrowed numeric delta before return and replays it after context recovery', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const stableValues = new Float64Array([10, 10, 0, 0.5, 20, 20, 4, 0.6]);
    const tailValues = new Float64Array([30, 30, 8, 0.7]);

    runtime.applyActiveDelta({
      presentationDelta: borrowedNumericDelta(stableValues, tailValues),
      strokeId: 'numeric-owned',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    stableValues.fill(999);
    tailValues.fill(999);
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (tail === null) throw new Error('Missing Active Stroke tail layer.');
    tail.dispatchEvent(new Event('contextlost', { cancelable: true }));
    drain(frames);
    tail.dispatchEvent(new Event('contextrestored'));
    drain(frames);

    const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
    if (stable === null) throw new Error('Missing Active Stroke stable layer.');
    expect(contexts.get(stable)?.moveTo).toHaveBeenCalledWith(10, 10);
    expect(contexts.get(stable)?.lineTo).toHaveBeenCalledWith(20, 20);
    expect(contexts.get(tail)?.moveTo).toHaveBeenCalledWith(20, 20);
    expect(contexts.get(tail)?.lineTo).toHaveBeenCalledWith(30, 30);
    expect(runtime.stats()).toMatchObject({
      activeSegmentCount: 1,
      activeStableEncoding: 'raw-spherical-sample',
      activeStableStorageKind: 'float64-chunks',
      activeTailEncoding: 'raw-spherical-sample',
      activeTailStorageKind: 'float64-ring',
    });
    runtime.dispose();
  });

  it('copies at most one provisional lane synchronously and replaces P1 with confirmed overlap plus P2', () => {
    const frames: FrameRequestCallback[] = [];
    const submitted: Array<number | null> = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = new InkRenderRuntime({
      document,
      geometry: rawWritingGeometry(),
      host,
      onActiveFrame: (generation) => submitted.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    drain(frames);
    submitted.length = 0;
    const p1 = new Float64Array([30, 30, 40, 40]);

    runtime.applyActiveDelta({
      presentationDelta: borrowedNumericDelta(
        new Float64Array([10, 10, 0, 0.5]),
        new Float64Array([20, 20, 4, 0.5]),
      ),
      presentationGeneration: 31,
      provisionalTail: borrowedProvisionalTail(p1),
      strokeId: 'predicted-main',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    p1.fill(999);
    drain(frames);

    const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (stable === null || tail === null) throw new Error('Missing split Active Stroke layers.');
    const stableContext = contexts.get(stable);
    const tailContext = contexts.get(tail);
    expect(tailContext?.moveTo).toHaveBeenCalledWith(20, 20);
    expect(tailContext?.lineTo).toHaveBeenCalledWith(30, 30);
    expect(tailContext?.lineTo).toHaveBeenCalledWith(40, 40);
    expect(tailContext?.lineTo).not.toHaveBeenCalledWith(999, 999);
    expect(stableContext?.moveTo).not.toHaveBeenCalledWith(30, 30);
    expect(stableContext?.lineTo).not.toHaveBeenCalledWith(40, 40);
    tailContext?.moveTo.mockClear();
    tailContext?.lineTo.mockClear();
    const p2 = new Float64Array([35, 35]);

    runtime.applyActiveDelta({
      presentationDelta: borrowedNumericDelta(
        new Float64Array(),
        new Float64Array([30, 30, 8, 0.5]),
      ),
      presentationGeneration: 32,
      provisionalTail: borrowedProvisionalTail(p2),
      strokeId: 'predicted-main',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    p2.fill(888);
    drain(frames);

    expect(tailContext?.moveTo).toHaveBeenCalledWith(30, 30);
    expect(tailContext?.lineTo).toHaveBeenCalledWith(35, 35);
    expect(tailContext?.lineTo).not.toHaveBeenCalledWith(40, 40);
    expect(tailContext?.lineTo).not.toHaveBeenCalledWith(888, 888);
    expect(runtime.stats().activeStableSampleCount).toBe(1);
    expect(submitted).toEqual([31, 32]);
    runtime.dispose();
  });

  it('fails a provisional tail from a stale Stage Frame epoch closed to confirmed rendering', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = new InkRenderRuntime({
      document,
      geometry: rawWritingGeometry(),
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    drain(frames);

    runtime.applyActiveDelta({
      presentationDelta: borrowedNumericDelta(
        new Float64Array([10, 10, 0, 0.5]),
        new Float64Array([20, 20, 4, 0.5]),
      ),
      provisionalTail: borrowedProvisionalTail(new Float64Array([99, 99]), 1),
      strokeId: 'stale-prediction-frame',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (tail === null) throw new Error('Missing Active Stroke tail layer.');
    expect(contexts.get(tail)?.lineTo).not.toHaveBeenCalledWith(99, 99);
    expect(runtime.stats().activeStableSampleCount).toBe(1);
    runtime.dispose();
  });

  it('clears provisional display state on finalize, frame replacement, context recovery, and cancel', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = new InkRenderRuntime({
      document,
      geometry: rawWritingGeometry(),
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    drain(frames);
    runtime.applyActiveDelta({
      presentationDelta: borrowedNumericDelta(
        new Float64Array([10, 10, 0, 0.5]),
        new Float64Array([20, 20, 4, 0.5]),
      ),
      provisionalTail: borrowedProvisionalTail(new Float64Array([90, 90])),
      strokeId: 'prediction-cleanup',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (tail === null) throw new Error('Missing Active Stroke tail layer.');
    const tailContext = contexts.get(tail);
    tailContext?.moveTo.mockClear();
    tailContext?.lineTo.mockClear();

    runtime.finalizeActive({
      color: '#112233',
      id: 'prediction-cleanup',
      points: [point(10, 10, 0), point(20, 20, 4)],
      tool: 'pen',
      width: 4,
    });
    drain(frames);
    expect(tailContext?.lineTo).not.toHaveBeenCalledWith(90, 90);

    runtime.applyActiveDelta({
      presentationDelta: borrowedNumericDelta(
        new Float64Array(),
        new Float64Array([25, 25, 8, 0.5]),
      ),
      provisionalTail: borrowedProvisionalTail(new Float64Array([91, 91])),
      strokeId: 'prediction-cleanup',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);
    tailContext?.moveTo.mockClear();
    tailContext?.lineTo.mockClear();
    runtime.setFrame(frame(0.5));
    drain(frames);
    expect(tailContext?.lineTo).not.toHaveBeenCalledWith(91, 91);

    runtime.applyActiveDelta({
      presentationDelta: borrowedNumericDelta(
        new Float64Array(),
        new Float64Array([26, 26, 12, 0.5]),
      ),
      provisionalTail: borrowedProvisionalTail(new Float64Array([92, 92]), 1),
      strokeId: 'prediction-cleanup',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);
    tailContext?.moveTo.mockClear();
    tailContext?.lineTo.mockClear();
    tail.dispatchEvent(new Event('contextlost', { cancelable: true }));
    tail.dispatchEvent(new Event('contextrestored'));
    drain(frames);
    expect(tailContext?.lineTo).not.toHaveBeenCalledWith(92, 92);

    runtime.cancelActive();
    expect(runtime.stats().activeStrokeId).toBeNull();
    runtime.dispose();
  });

  it('preserves raw sensor values and capability flags across delayed presentation and context recovery', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = new InkRenderRuntime({
      document,
      geometry: rawWritingGeometry(),
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const measured = new Float64Array([
      10,
      20,
      30,
      0.625,
      Math.PI / 3,
      Math.PI / 4,
      INK_SAMPLE_FLAGS.pressureMeasured |
        INK_SAMPLE_FLAGS.altitudeMeasured |
        INK_SAMPLE_FLAGS.azimuthMeasured,
    ]);

    runtime.applyActiveDelta({
      presentationDelta: exactRawNumericDelta(measured),
      strokeId: 'sensor-owned',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    measured.fill(999);
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (tail === null) throw new Error('Missing Active Stroke tail layer.');
    tail.dispatchEvent(new Event('contextlost', { cancelable: true }));
    drain(frames);
    tail.dispatchEvent(new Event('contextrestored'));
    drain(frames);

    const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
    if (stable === null) throw new Error('Missing Active Stroke stable layer.');
    expect(contexts.get(stable)?.moveTo).toHaveBeenCalledWith(10, 20);
    expect(contexts.get(stable)?.moveTo).not.toHaveBeenCalledWith(999, 999);

    runtime.applyActiveDelta({
      presentationDelta: exactRawNumericDelta(
        new Float64Array([
          10,
          20,
          30,
          0.625,
          Math.PI / 3,
          Math.PI / 4,
          INK_SAMPLE_FLAGS.pressureMeasured |
            INK_SAMPLE_FLAGS.altitudeMeasured |
            INK_SAMPLE_FLAGS.azimuthMeasured,
        ]),
      ),
      strokeId: 'sensor-owned',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    runtime.applyActiveDelta({
      presentationDelta: exactRawNumericDelta(
        new Float64Array([
          10,
          20,
          30,
          0,
          0,
          0,
          INK_SAMPLE_FLAGS.pressureMeasured |
            INK_SAMPLE_FLAGS.altitudeMeasured |
            INK_SAMPLE_FLAGS.azimuthMeasured,
        ]),
      ),
      strokeId: 'sensor-owned',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    runtime.applyActiveDelta({
      presentationDelta: exactRawNumericDelta(new Float64Array([10, 20, 30, 111, 111, 111, 0])),
      strokeId: 'sensor-owned',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    runtime.applyActiveDelta({
      presentationDelta: exactRawNumericDelta(new Float64Array([10, 20, 30, 222, 222, 222, 0])),
      strokeId: 'sensor-owned',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    expect(runtime.stats()).toMatchObject({
      activeStableEncoding: 'raw-spherical-sample',
      activeStableSampleCount: 3,
      activeTailEncoding: 'raw-spherical-sample',
    });
    runtime.dispose();
  });

  it('keeps the stable prefix append-only while a backtracking mutable tail moves', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);

    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(70, 40, 12)],
        stablePrefixDelta: [point(10, 40, 0), point(40, 40, 8)],
      },
      strokeId: 'backtracking',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (stable === null || tail === null) throw new Error('Missing split Active Stroke layers.');
    const stableContext = contexts.get(stable);
    const tailContext = contexts.get(tail);
    const stableClears = stableContext?.clearRect.mock.calls.length ?? 0;
    const stableStrokes = stableContext?.stroke.mock.calls.length ?? 0;
    const tailClears = tailContext?.clearRect.mock.calls.length ?? 0;

    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(20, 40, 16)],
        stablePrefixDelta: [],
      },
      strokeId: 'backtracking',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    expect(stableContext?.clearRect).toHaveBeenCalledTimes(stableClears);
    expect(stableContext?.stroke).toHaveBeenCalledTimes(stableStrokes);
    expect(tailContext?.clearRect).toHaveBeenCalledTimes(tailClears + 1);
    runtime.dispose();
  });

  it('keeps the Eraser stable prefix separate and paints its start marker above the mutable tail', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);

    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(60, 20, 12)],
        stablePrefixDelta: [point(10, 10, 0), point(40, 10, 8)],
      },
      eraserColor: '#dc2626',
      strokeId: 'eraser-preview',
      style: { color: '#000000', tool: 'eraser', width: 8 },
    });
    drain(frames);

    const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (stable === null || tail === null) throw new Error('Missing split Active Stroke layers.');
    const stableContext = contexts.get(stable);
    const tailContext = contexts.get(tail);
    if (stableContext === undefined || tailContext === undefined) {
      throw new Error('Missing split Active Stroke Canvas contexts.');
    }

    expect(stableContext.lineTo).toHaveBeenCalledWith(40, 10);
    expect(stableContext.lineTo).not.toHaveBeenCalledWith(60, 20);
    expect(stableContext.setLineDash).toHaveBeenCalledWith([6, 4]);
    expect(stableContext.arc).not.toHaveBeenCalled();
    expect(tailContext.lineTo).toHaveBeenCalledWith(60, 20);
    expect(tailContext.setLineDash).toHaveBeenCalledWith([6, 4]);
    expect(tailContext.arc).toHaveBeenCalledWith(10, 10, 6, 0, Math.PI * 2);
    expect(tailContext.stroke.mock.invocationCallOrder[0]).toBeLessThan(
      tailContext.stroke.mock.invocationCallOrder.at(-1) ?? 0,
    );

    const stableClears = stableContext.clearRect.mock.calls.length;
    const tailClears = tailContext.clearRect.mock.calls.length;
    runtime.cancelActive();

    expect(stableContext.clearRect).toHaveBeenCalledTimes(stableClears + 1);
    expect(tailContext.clearRect).toHaveBeenCalledTimes(tailClears + 1);
    expect(runtime.stats().activeStrokeId).toBeNull();
    drain(frames);
    runtime.dispose();
  });

  it('draws an appended committed stroke without clearing the viewport', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('first')]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const context = committed === null ? undefined : contexts.get(committed);
    const clears = context?.clearRect.mock.calls.length ?? 0;
    const strokes = context?.stroke.mock.calls.length ?? 0;

    const added = stroke('added', 60);
    fixture.replace([stroke('first'), added]);
    runtime.applyDocumentChange(change('add', { addedIds: ['added'], newStroke: added }));
    drain(frames);

    expect(context?.clearRect).toHaveBeenCalledTimes(clears);
    expect(context?.stroke).toHaveBeenCalledTimes(strokes + 1);
    runtime.dispose();
  });

  it('does not schedule renderer work for a persistence-only document change', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('history')]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);

    runtime.applyDocumentChange({
      addedIds: [],
      bounds: [],
      commandId: 'persistence-only',
      generation: 2,
      persistenceDelta: { next: { kind: 'saving' }, previous: { kind: 'idle' } },
      removedIds: [],
      selectionDelta: null,
      updatedIds: [],
    });

    expect(frames).toEqual([]);
    runtime.dispose();
  });

  it.each([
    ['Pen', physicalStroke('physical-pen', 'pen'), 1],
    ['Highlighter', physicalStroke('physical-highlighter', 'highlighter'), 0.35],
  ] as const)(
    'renders committed physical %s coverage through one shared filled-contour Canvas path',
    (_label, saved, expectedAlpha) => {
      const frames: FrameRequestCallback[] = [];
      const host = document.createElement('div');
      document.body.append(host);
      const fixture = documentFixture([saved]);
      const runtime = runtimeFixture(host, fixture, frames);
      runtime.setFrame(frame());
      runtime.installDocument(fixture.read());

      drain(frames);

      const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
      const context = committed === null ? undefined : contexts.get(committed);
      expect(context?.fill).toHaveBeenCalledTimes(1);
      expect(context?.fill).toHaveBeenCalledWith('nonzero');
      expect(context?.stroke).not.toHaveBeenCalled();
      expect(context?.context.globalAlpha).toBe(expectedAlpha);
      runtime.dispose();
    },
  );

  it('reuses completed physical geometry through finalization and added-only promotion', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const saved = physicalStroke('physical-promoted-once', 'pen');
    const compile = vi.spyOn(SharedInkStrokeGeometry.prototype, 'compile');
    const diagnostics = new InkPerformanceDiagnostics(true);
    const fixture = documentFixture([]);
    const runtime = runtimeFixture(host, fixture, frames, diagnostics);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    runtime.applyPhysicalActiveDelta({
      alpha: 1,
      color: saved.color,
      geometryUpdate: physicalActiveFinishUpdate(saved.id, 'pen-physical-v1'),
      presentationDelta: borrowedNumericDelta(
        new Float64Array([10, 20, 0, 0.5]),
        new Float64Array([40, 30, 16, 0.5]),
      ),
      strokeId: saved.id,
      style: { color: saved.color, tool: 'pen', width: saved.width },
    });

    runtime.finalizeActive(saved);
    fixture.replace([saved]);
    runtime.promoteActive(saved.id);
    runtime.applyDocumentChange(change('physical-add', { addedIds: [saved.id], newStroke: saved }));
    runtime.flushNow();

    expect(compile).not.toHaveBeenCalled();
    expect(diagnostics.snapshot()).toMatchObject({
      armedAuditGuards: ['physical-finalize-no-recompile'],
      forbiddenWork: [],
    });
    expect(runtime.stats().cacheEntries).toBe(1);
    expect(runtime.stats().activeStrokeId).toBeNull();
    runtime.dispose();
  });

  it('submits the first physical pixel synchronously without waiting behind committed work', () => {
    const frames: FrameRequestCallback[] = [];
    const submitted: Array<number | null> = [];
    const host = document.createElement('div');
    document.body.append(host);
    const history = stroke('first-pixel-history');
    const fixture = documentFixture([history]);
    const runtime = new InkRenderRuntime({
      document,
      host,
      onActiveFrame: (generation) => submitted.push(generation),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    submitted.length = 0;
    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const committedContext = committed === null ? undefined : contexts.get(committed);
    const committedStrokes = committedContext?.stroke.mock.calls.length ?? 0;
    const added = stroke('queued-before-first-pixel', 80);
    fixture.replace([history, added]);
    runtime.applyDocumentChange(
      change('queued-before-first-pixel', { addedIds: [added.id], newStroke: added }),
    );
    runtime.setActivePerformanceContact({ adapter: 'pointer', sequence: 1 });

    runtime.applyPhysicalActiveDelta({
      alpha: 0.35,
      color: '#112233',
      geometryUpdate: physicalActiveUpdate('active-delta', 1),
      presentationDelta: borrowedNumericDelta(
        new Float64Array([10, 20, 0, 0.5]),
        new Float64Array([12, 21, 1, 0.5]),
      ),
      presentationGeneration: 9,
      strokeId: 'physical-mark',
      style: { color: '#112233', tool: 'highlighter', width: 10 },
    });

    expect(submitted).toEqual([9]);
    expect(committedContext?.stroke).toHaveBeenCalledTimes(committedStrokes);
    runtime.applyPhysicalActiveDelta({
      alpha: 0.35,
      color: '#112233',
      geometryUpdate: physicalActiveUpdate('active-delta', 2),
      presentationDelta: borrowedNumericDelta(
        new Float64Array([12, 21, 1, 0.5]),
        new Float64Array([16, 23, 2, 0.5]),
      ),
      presentationGeneration: 10,
      strokeId: 'physical-mark',
      style: { color: '#112233', tool: 'highlighter', width: 10 },
    });
    frames.shift()?.(16.7);
    expect(submitted).toEqual([9, 10]);
    expect(committedContext?.stroke).toHaveBeenCalledTimes(committedStrokes);
    runtime.setActivePerformanceContact(null);
    runtime.cancelActive();
    drain(frames);
    expect(committedContext?.stroke).toHaveBeenCalledTimes(committedStrokes + 1);
    runtime.dispose();
  });

  it('reports a legacy full-stroke finalization compile as forbidden completion work', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const diagnostics = new InkPerformanceDiagnostics(true);
    const fixture = documentFixture([]);
    const runtime = runtimeFixture(host, fixture, frames, diagnostics);
    const saved = stroke('legacy-finalize');
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    runtime.applyActiveDelta({
      delta: { mutableTail: [], stablePrefixDelta: saved.points },
      strokeId: saved.id,
      style: { color: saved.color, tool: saved.tool, width: saved.width },
    });

    runtime.finalizeActive(saved);

    expect(diagnostics.snapshot()).toMatchObject({
      auditedWork: [{ count: 1, kind: 'historical-copy', phase: 'completion' }],
      forbiddenWork: [{ count: 1, kind: 'historical-copy', phase: 'completion' }],
    });
    runtime.dispose();
  });

  it('draws physical selection chrome from compiled contours rather than a centerline proxy', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const saved = physicalStroke('physical-selected', 'highlighter');
    const fixture = documentFixture([saved]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const active = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const context = active === null ? undefined : contexts.get(active);
    const selected = refs([saved])[0];
    if (selected === undefined) throw new Error('Missing physical selection fixture.');

    runtime.setOverlay({ hovered: [], selected: [selected] });
    drain(frames);

    expect(context?.fill).toHaveBeenCalledTimes(1);
    expect(context?.stroke).toHaveBeenCalledTimes(1);
    expect(context?.moveTo).not.toHaveBeenCalledWith(10, 20);
    runtime.dispose();
  });

  it('fails closed instead of rendering an unknown Brush Render Version as a legacy line', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const unknown = {
      ...physicalStroke('unknown-brush', 'pen'),
      brushRenderVersion: 'future-brush-v9',
    } as unknown as InkStroke;
    const fixture = documentFixture([unknown]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());

    expect(() => drain(frames)).toThrow(/future-brush-v9.*unknown-version/u);

    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const context = committed === null ? undefined : contexts.get(committed);
    expect(context?.fill).not.toHaveBeenCalled();
    expect(context?.stroke).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('clears and redraws overlay chrome after a Stage Frame replacement', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const saved = stroke('overlay');
    const fixture = documentFixture([saved]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (tail === null) throw new Error('Missing Active Stroke tail layer.');
    const tailContext = contexts.get(tail);
    const overlayRef = refs([saved])[0];
    if (overlayRef === undefined) throw new Error('Missing overlay fixture.');

    runtime.setOverlay({ hovered: [overlayRef], selected: [] });
    drain(frames);
    const clears = tailContext?.clearRect.mock.calls.length ?? 0;
    const strokes = tailContext?.stroke.mock.calls.length ?? 0;

    runtime.setFrame(frame(0.5));
    drain(frames);

    expect(tailContext?.clearRect.mock.calls.length).toBeGreaterThan(clears);
    expect(tailContext?.stroke.mock.calls.length).toBeGreaterThan(strokes);
    runtime.dispose();
  });

  it('invalidates only dirty geometry for move, restyle, and erase, then redraws on frame replace', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const first = stroke('first', 10);
    const second = stroke('second', 130);
    const fixture = documentFixture([first, second]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const context = committed === null ? undefined : contexts.get(committed);
    const initialClears = context?.clearRect.mock.calls.length ?? 0;
    const initialStrokes = context?.stroke.mock.calls.length ?? 0;

    const moved = stroke('first', 40);
    fixture.replace([moved, second]);
    runtime.applyDocumentChange(
      documentChange('move', 1, {
        bounds: [{ id: first.id, newBounds: refBounds(moved), oldBounds: refBounds(first) }],
        updatedIds: [first.id],
      }),
    );
    drain(frames);
    expect(context?.clearRect).toHaveBeenCalledTimes(initialClears + 1);
    expect(context?.stroke).toHaveBeenCalledTimes(initialStrokes + 1);

    const restyled = { ...moved, color: '#abcdef' };
    fixture.replace([restyled, second]);
    runtime.applyDocumentChange(
      documentChange('restyle', 2, {
        bounds: [{ id: first.id, newBounds: refBounds(restyled), oldBounds: refBounds(moved) }],
        updatedIds: [first.id],
      }),
    );
    drain(frames);
    expect(context?.clearRect).toHaveBeenCalledTimes(initialClears + 2);
    expect(context?.stroke).toHaveBeenCalledTimes(initialStrokes + 2);

    fixture.replace([second]);
    runtime.applyDocumentChange(
      documentChange('erase', 3, {
        bounds: [{ id: first.id, newBounds: null, oldBounds: refBounds(restyled) }],
        removedIds: [first.id],
      }),
    );
    drain(frames);
    expect(context?.clearRect).toHaveBeenCalledTimes(initialClears + 3);
    expect(context?.stroke).toHaveBeenCalledTimes(initialStrokes + 2);

    runtime.setFrame(frame(0.5));
    drain(frames);
    expect(context?.clearRect).toHaveBeenCalledTimes(initialClears + 4);
    expect(context?.stroke).toHaveBeenCalledTimes(initialStrokes + 3);
    runtime.dispose();
  });

  it('keeps active geometry until identical committed geometry is drawn in the same frame', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const stableContext = stable === null ? undefined : contexts.get(stable);
    const tailContext = tail === null ? undefined : contexts.get(tail);
    const committedContext = committed === null ? undefined : contexts.get(committed);
    if (
      stableContext === undefined ||
      tailContext === undefined ||
      committedContext === undefined
    ) {
      throw new Error('Missing committed or split Active Stroke Canvas contexts.');
    }
    const completed = stroke('completed');
    runtime.applyActiveDelta({
      delta: { mutableTail: [], stablePrefixDelta: completed.points },
      strokeId: completed.id,
      style: { color: completed.color, tool: completed.tool, width: completed.width },
    });
    runtime.finalizeActive(completed);
    drain(frames);
    const stableClearsBeforePromotion = stableContext.clearRect.mock.calls.length;
    const tailClearsBeforePromotion = tailContext.clearRect.mock.calls.length;

    fixture.replace([completed]);
    runtime.promoteActive(completed.id);
    runtime.applyDocumentChange(
      change('complete', { addedIds: [completed.id], newStroke: completed }),
    );

    expect(stableContext.clearRect).toHaveBeenCalledTimes(stableClearsBeforePromotion);
    expect(tailContext.clearRect).toHaveBeenCalledTimes(tailClearsBeforePromotion);
    drain(frames);
    const committedPaintOrder = committedContext.stroke.mock.invocationCallOrder.at(-1) ?? 0;
    expect(committedPaintOrder).toBeLessThan(
      stableContext.clearRect.mock.invocationCallOrder.at(-1) ?? 0,
    );
    expect(committedPaintOrder).toBeLessThan(
      tailContext.clearRect.mock.invocationCallOrder.at(-1) ?? 0,
    );
    expect(stableContext.clearRect).toHaveBeenCalledTimes(stableClearsBeforePromotion + 1);
    expect(tailContext.clearRect).toHaveBeenCalledTimes(tailClearsBeforePromotion + 1);
    expect(runtime.stats().activeStrokeId).toBeNull();
    runtime.dispose();
  });

  it('accepts the next contact before the prior promotion frame without clearing the new Active stroke', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const first = stroke('rapid-first');
    const second = stroke('rapid-second', 40);

    runtime.applyActiveDelta({
      delta: { mutableTail: [], stablePrefixDelta: first.points },
      strokeId: first.id,
      style: { color: first.color, tool: first.tool, width: first.width },
    });
    runtime.finalizeActive(first);
    fixture.replace([first]);
    runtime.promoteActive(first.id);
    runtime.applyDocumentChange(
      change('rapid-first-complete', { addedIds: [first.id], newStroke: first }),
    );

    expect(() =>
      runtime.applyActiveDelta({
        delta: { mutableTail: [], stablePrefixDelta: second.points },
        strokeId: second.id,
        style: { color: second.color, tool: second.tool, width: second.width },
      }),
    ).not.toThrow();
    expect(runtime.stats().activeStrokeId).toBe(second.id);

    drain(frames);
    expect(runtime.stats().activeStrokeId).toBe(second.id);

    runtime.finalizeActive(second);
    fixture.replace([first, second]);
    runtime.promoteActive(second.id);
    runtime.applyDocumentChange(
      change('rapid-second-complete', { addedIds: [second.id], newStroke: second }),
    );
    drain(frames);
    expect(runtime.stats().activeStrokeId).toBeNull();
    runtime.dispose();
  });

  it('accounts finalized active geometry in the working set before promotion', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const retained = stroke('finalized-active');
    runtime.applyActiveDelta({
      delta: { mutableTail: [], stablePrefixDelta: retained.points },
      strokeId: retained.id,
      style: { color: retained.color, tool: retained.tool, width: retained.width },
    });
    drain(frames);
    const activeBytes = runtime.stats().activeWorkingSetBytes;
    const compiledBytes = new LegacyRoundInkStrokeGeometry().compile(retained).byteSizeEstimate;

    runtime.finalizeActive(retained);

    expect(runtime.stats().activeWorkingSetBytes).toBe(activeBytes + compiledBytes);
    runtime.dispose();
  });

  it('uses the active Canvas as an isolated one-stroke Highlighter coverage layer', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);

    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(20, 20, 4)],
        stablePrefixDelta: [point(10, 10, 0), point(15, 15, 2)],
      },
      strokeId: 'mark',
      style: { color: '#ffd54f', tool: 'highlighter', width: 12 },
    });
    drain(frames);

    const stack = host.querySelector<HTMLElement>('.inkstone-ink-active-stack');
    const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
    const active = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const stableContext = stable === null ? undefined : contexts.get(stable);
    const tailContext = active === null ? undefined : contexts.get(active);
    expect(stack?.style.opacity).toBe('0.45');
    expect(stableContext?.context.globalAlpha).toBe(1);
    expect(tailContext?.context.globalAlpha).toBe(1);
    expect(stableContext?.context.strokeStyle).toBe('#ffd54f');
    expect(tailContext?.context.strokeStyle).toBe('#ffd54f');
    runtime.dispose();
  });

  it('renders physical active stable/tail coverage as filled masks with Highlighter alpha applied once', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);

    runtime.applyPhysicalActiveDelta({
      alpha: 0.35,
      color: '#ffcc00',
      geometryUpdate: physicalActiveUpdate('active-delta', 1),
      presentationDelta: borrowedNumericDelta(
        new Float64Array([10, 10, 0, 0.5]),
        new Float64Array([20, 20, 4, 0.5]),
      ),
      strokeId: 'physical-mark',
      style: { color: '#ffcc00', tool: 'highlighter', width: 10 },
    });
    drain(frames);

    const stack = host.querySelector<HTMLElement>('.inkstone-ink-active-stack');
    const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const stableContext = stable === null ? undefined : contexts.get(stable);
    const tailContext = tail === null ? undefined : contexts.get(tail);
    expect(stack?.style.opacity).toBe('0.35');
    expect(stableContext?.fill).toHaveBeenCalledTimes(1);
    expect(tailContext?.fill).toHaveBeenCalledTimes(1);
    expect(stableContext?.fill).toHaveBeenCalledWith('nonzero');
    expect(tailContext?.fill).toHaveBeenCalledWith('nonzero');
    expect(stableContext?.stroke).not.toHaveBeenCalled();
    expect(tailContext?.stroke).not.toHaveBeenCalled();
    expect(stableContext?.context.globalAlpha).toBe(1);
    expect(tailContext?.context.globalAlpha).toBe(1);

    runtime.applyPhysicalActiveDelta({
      alpha: 0.35,
      color: '#ffcc00',
      geometryUpdate: physicalActiveUpdate('active-delta', 2, false),
      presentationDelta: borrowedNumericDelta(
        new Float64Array(),
        new Float64Array([25, 22, 8, 0.5]),
      ),
      strokeId: 'physical-mark',
      style: { color: '#ffcc00', tool: 'highlighter', width: 10 },
    });
    drain(frames);

    expect(stableContext?.fill).toHaveBeenCalledTimes(1);
    expect(tailContext?.fill).toHaveBeenCalledTimes(2);
    expect(tailContext?.clearRect).toHaveBeenCalled();
    runtime.dispose();
  });

  it('switches one known physical Active failure to local legacy presentation without dropping its numeric trace', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const diagnostics: string[] = [];
    const runtime = new InkRenderRuntime({
      document,
      host,
      onDiagnostic: (message) => diagnostics.push(message),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.applyPhysicalActiveDelta({
      alpha: 1,
      color: '#112233',
      geometryUpdate: {
        ...physicalActiveUpdate('active-delta', 1),
        logicalStrokeId: 'degraded-active-pen',
        version: 'pen-physical-v1',
      },
      presentationDelta: borrowedNumericDelta(
        new Float64Array([10, 10, 0, 0.5]),
        new Float64Array([20, 20, 4, 0.5]),
      ),
      strokeId: 'degraded-active-pen',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    runtime.applyDegradedPhysicalActiveDelta({
      diagnostic: 'known-version-geometry-failure',
      presentationDelta: borrowedNumericDelta(
        new Float64Array([20, 20, 4, 0.5]),
        new Float64Array([30, 25, 8, 0.5]),
      ),
      strokeId: 'degraded-active-pen',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    const stable = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active-stable]');
    const tail = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const stableContext = stable === null ? undefined : contexts.get(stable);
    const tailContext = tail === null ? undefined : contexts.get(tail);
    expect(
      (stableContext?.stroke.mock.calls.length ?? 0) + (tailContext?.stroke.mock.calls.length ?? 0),
    ).toBeGreaterThan(0);
    expect(runtime.stats().activeStrokeId).toBe('degraded-active-pen');
    expect(diagnostics).toEqual([
      'Known pen-physical-v1 Active geometry failed for degraded-active-pen; using local legacy presentation.',
    ]);
    runtime.dispose();
  });

  it('forces physical Active geometry onto main Canvas while Worker remains unpromoted', async () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([]);
    const worker = workerPresentationFixture();
    const runtime = new InkRenderRuntime({
      document,
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      workerPresentation: { enabled: true, prepare: worker.prepare },
    });
    runtime.setFrame(frame());
    drain(frames);
    await worker.resolveReady();
    expect(runtime.activePresentationAdapterState?.adapter).toBe('worker-offscreen-2d');

    runtime.applyPhysicalActiveDelta({
      alpha: 1,
      color: '#112233',
      geometryUpdate: {
        ...physicalActiveUpdate('active-delta', 1),
        version: 'pen-physical-v1',
      },
      presentationDelta: borrowedNumericDelta(
        new Float64Array([10, 10, 0, 0.5]),
        new Float64Array([20, 20, 4, 0.5]),
      ),
      strokeId: 'physical-mark',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);

    expect(runtime.activePresentationAdapterState).toMatchObject({
      adapter: 'main-canvas-2d',
      requestedAdapter: 'worker-offscreen-2d',
    });
    expect(worker.dispose).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it('restores active geometry first and defers committed recovery until contact ends', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('saved')]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(50, 40, 8)],
        stablePrefixDelta: [point(10, 20, 0), point(30, 30, 4)],
      },
      strokeId: 'active',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });
    drain(frames);
    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const active = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const committedContext = committed === null ? undefined : contexts.get(committed);
    const activeContext = active === null ? undefined : contexts.get(active);
    const committedStrokes = committedContext?.stroke.mock.calls.length ?? 0;
    const activeStrokes = activeContext?.stroke.mock.calls.length ?? 0;

    const lost = new Event('contextlost', { cancelable: true });
    active?.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    active?.dispatchEvent(new Event('contextrestored'));
    drain(frames);

    expect(committedContext?.stroke.mock.calls.length).toBe(committedStrokes);
    expect(activeContext?.stroke.mock.calls.length).toBeGreaterThan(activeStrokes);
    expect(runtime.stats().activeStrokeId).toBe('active');
    runtime.cancelActive();
    drain(frames);
    expect(committedContext?.stroke.mock.calls.length).toBeGreaterThan(committedStrokes);
    runtime.dispose();
  });

  it('keeps logical geometry cached across zoom and DPR projection changes', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('cached')]);
    const baseline = new LegacyRoundInkStrokeGeometry();
    const compile = vi.fn((candidate: InkStroke) => baseline.compile(candidate));
    const geometry = geometryFixture(baseline, compile);
    let ratio = 1;
    const runtime = new InkRenderRuntime({
      devicePixelRatio: () => ratio,
      document,
      geometry,
      host,
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    expect(compile).toHaveBeenCalledTimes(1);

    ratio = 2;
    runtime.invalidateViewport();
    drain(frames);
    runtime.setFrame(frame(0.5));
    drain(frames);

    expect(compile).toHaveBeenCalledTimes(1);
    expect(runtime.stats().cacheEntries).toBe(1);
    runtime.dispose();
  });

  it('keeps production committed raster tiles outside the DOM and inside 1.5 viewport bytes', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing.context;
      const created = contextFixture();
      Object.defineProperty(created.context, 'canvas', { configurable: true, value: this });
      contexts.set(this, created);
      return created.context;
    });
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('tile-a'), stroke('tile-b', 150)]);
    const runtime = runtimeFixture(host, fixture, frames);

    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);

    const stats = runtime.stats();
    expect(stats.rasterTileCount).toBeGreaterThan(0);
    expect(stats.rasterTileBytes).toBeLessThanOrEqual(200 * 200 * 4 * 1.5);
    expect(stats.rasterTileMisses).toBeGreaterThan(0);
    expect(stats.visibleRecoveryRebuildReason).toBe('initial-document-install');
    expect(host.querySelectorAll('canvas')).toHaveLength(3);
    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const committedContext = committed === null ? undefined : contexts.get(committed);
    const clearCountBeforeDamage = committedContext?.clearRect.mock.calls.length ?? 0;

    const updated = stroke('tile-a', 20);
    fixture.replace([updated, stroke('tile-b', 150)]);
    runtime.applyDocumentChange(
      documentChange('move-tile-a', 1, {
        bounds: [
          {
            id: updated.id,
            newBounds: refBounds(updated),
            oldBounds: refBounds(stroke('tile-a')),
          },
        ],
        updatedIds: [updated.id],
      }),
    );
    drain(frames);

    const afterLocalDamage = runtime.stats();
    expect(afterLocalDamage.visibleRecoveryRebuildCount).toBe(stats.visibleRecoveryRebuildCount);
    expect(afterLocalDamage.rasterTileHits).toBeGreaterThan(stats.rasterTileHits);
    expect(afterLocalDamage.rasterTileMisses - stats.rasterTileMisses).toBeLessThan(
      stats.rasterTileCount,
    );
    expect(
      committedContext?.clearRect.mock.calls
        .slice(clearCountBeforeDamage)
        .some(([, , width, height]) => width === 200 && height === 200),
    ).toBe(false);

    const clearCountBeforeExclusion = committedContext?.clearRect.mock.calls.length ?? 0;
    runtime.setCommittedExclusions(['tile-b']);
    drain(frames);
    expect(
      committedContext?.clearRect.mock.calls
        .slice(clearCountBeforeExclusion)
        .some(([, , width, height]) => width === 200 && height === 200),
    ).toBe(false);
    expect(host.querySelectorAll('canvas')).toHaveLength(3);
    runtime.dispose();
  });

  it('prepares at most two missing committed raster tiles per frame before atomic presentation', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing.context;
      const created = contextFixture();
      Object.defineProperty(created.context, 'canvas', { configurable: true, value: this });
      contexts.set(this, created);
      return created.context;
    });
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('incremental-tile')]);
    const runtime = runtimeFixture(host, fixture, frames);

    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    expect(frames).toHaveLength(1);

    frames.shift()?.(performance.now());

    expect(runtime.stats()).toMatchObject({
      rasterTileRebuildCount: 2,
      visibleRecoveryRebuildCount: 0,
    });
    expect(frames).toHaveLength(1);

    drain(frames);

    expect(runtime.stats().rasterTileRebuildCount).toBeGreaterThan(1);
    expect(runtime.stats().visibleRecoveryRebuildCount).toBe(1);
    runtime.dispose();
  });

  it('prepares at most two invalidated committed raster tiles per frame', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing.context;
      const created = contextFixture();
      Object.defineProperty(created.context, 'canvas', { configurable: true, value: this });
      contexts.set(this, created);
      return created.context;
    });
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('damaged-tile')]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const initialRebuilds = runtime.stats().rasterTileRebuildCount;

    runtime.applyDocumentChange(
      documentChange('invalidate-visible-viewport', 1, {
        bounds: [
          {
            id: 'damaged-tile',
            newBounds: { height: 200, width: 200, x: 0, y: 0 },
            oldBounds: { height: 200, width: 200, x: 0, y: 0 },
          },
        ],
        updatedIds: ['damaged-tile'],
      }),
    );

    frames.shift()?.(performance.now());

    expect(runtime.stats().rasterTileRebuildCount - initialRebuilds).toBe(2);
    expect(frames).toHaveLength(1);

    drain(frames);
    expect(runtime.stats().rasterTileRebuildCount - initialRebuilds).toBeGreaterThan(1);
    runtime.dispose();
  });

  it('promotes an added stroke directly without rebuilding its invalidated history tile', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing.context;
      const created = contextFixture();
      Object.defineProperty(created.context, 'canvas', { configurable: true, value: this });
      contexts.set(this, created);
      return created.context;
    });
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const history = stroke('append-history');
    const fixture = documentFixture([history]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const rebuilds = runtime.stats().rasterTileRebuildCount;
    const added = stroke('append-without-tile-rebuild', 40);
    fixture.replace([history, added]);

    runtime.applyDocumentChange(
      change('append-without-tile-rebuild', { addedIds: [added.id], newStroke: added }),
    );
    drain(frames);

    expect(runtime.stats().rasterTileRebuildCount).toBe(rebuilds);
    expect(runtime.stats().activeStrokeId).toBeNull();
    runtime.dispose();
  });

  it('keeps the old bitmap projected until resized backing tiles are ready', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing.context;
      const created = contextFixture();
      Object.defineProperty(created.context, 'canvas', { configurable: true, value: this });
      contexts.set(this, created);
      return created.context;
    });
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('resize-history')]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const baselineMutations = runtime.stats().backingStoreDimensionMutationCount;
    const resized = createInkStageFrame({
      actualScale: 1,
      canvasClientRect: { height: 200, left: 0, top: 0, width: 300 },
      documentClientOrigin: { x: 0, y: 0 },
    });

    runtime.projectFrame(resized);
    runtime.setFrame(resized);
    frames.shift()?.(performance.now());

    expect(runtime.stats().backingStoreDimensionMutationCount).toBe(baselineMutations);
    expect(committed?.style.transform).not.toBe('');
    expect(frames).toHaveLength(1);

    drain(frames);

    expect(runtime.stats().backingStoreDimensionMutationCount).toBeGreaterThan(baselineMutations);
    expect(committed?.style.transform).toBe('');
    runtime.dispose();
  });

  it('lets an active contact preempt a pending resized backing adoption', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing.context;
      const created = contextFixture();
      Object.defineProperty(created.context, 'canvas', { configurable: true, value: this });
      contexts.set(this, created);
      return created.context;
    });
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('preempted-resize-history')]);
    const query = vi.fn(fixture.query);
    const runtime = new InkRenderRuntime({
      document,
      host,
      query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const baselineMutations = runtime.stats().backingStoreDimensionMutationCount;
    const baselineQueries = query.mock.calls.length;
    const resized = createInkStageFrame({
      actualScale: 1,
      canvasClientRect: { height: 200, left: 0, top: 0, width: 300 },
      documentClientOrigin: { x: 0, y: 0 },
    });
    runtime.projectFrame(resized);
    runtime.setFrame(resized);
    runtime.applyActiveDelta({
      delta: {
        mutableTail: [point(20, 20, 4)],
        stablePrefixDelta: [point(10, 10, 0)],
      },
      strokeId: 'resize-first-tip',
      style: { color: '#112233', tool: 'pen', width: 4 },
    });

    frames.shift()?.(performance.now());

    expect(runtime.stats().backingStoreDimensionMutationCount).toBe(baselineMutations);
    expect(query.mock.calls.length).toBe(baselineQueries);
    const active = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    expect(active === null ? undefined : contexts.get(active)?.stroke).toHaveBeenCalled();
    runtime.cancelActive();
    drain(frames);
    runtime.dispose();
  });

  it('does not reallocate Canvas backing stores when only the Stage Frame projection changes', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('saved')]);
    const runtime = runtimeFixture(host, fixture, frames);
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    if (committed === null) throw new Error('Missing committed Canvas.');
    let width = committed.width;
    let height = committed.height;
    const widthWrites = vi.fn((value: number) => {
      width = value;
    });
    const heightWrites = vi.fn((value: number) => {
      height = value;
    });
    Object.defineProperties(committed, {
      height: { configurable: true, get: () => height, set: heightWrites },
      width: { configurable: true, get: () => width, set: widthWrites },
    });

    runtime.setFrame(frame(0.5));
    drain(frames);

    expect(widthWrites).not.toHaveBeenCalled();
    expect(heightWrites).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('degrades one known-version geometry failure without mutating or clearing the scene', () => {
    const frames: FrameRequestCallback[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const fixture = documentFixture([stroke('good'), stroke('bad', 80)]);
    const baseline = new LegacyRoundInkStrokeGeometry();
    const geometry = geometryFixture(baseline, (candidate) => {
      if (candidate.id === 'bad') throw new Error('synthetic compiler fault');
      return baseline.compile(candidate);
    });
    const diagnostics: string[] = [];
    const runtime = new InkRenderRuntime({
      document,
      geometry,
      host,
      onDiagnostic: (message) => diagnostics.push(message),
      query: fixture.query,
      read: fixture.read,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    runtime.setFrame(frame());
    runtime.installDocument(fixture.read());
    drain(frames);
    const committed = host.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const context = committed === null ? undefined : contexts.get(committed);

    expect(context?.stroke).toHaveBeenCalledTimes(2);
    expect(fixture.read().strokeCount).toBe(2);
    expect(diagnostics).toEqual(['Known legacy Ink geometry failed for bad; using fallback.']);
    runtime.dispose();
  });
});

function geometryFixture(
  baseline: LegacyRoundInkStrokeGeometry,
  compile: InkStrokeGeometry['compile'],
): InkStrokeGeometry {
  return {
    beginActivePresentation: (input) => baseline.beginActivePresentation(input),
    bounds: (candidate) => baseline.bounds(candidate),
    compile,
    extend: (active, input) => baseline.extend(active, input),
    hitTest: (candidate, pointValue, tolerance) =>
      baseline.hitTest(candidate, pointValue, tolerance),
  };
}

function borrowingActiveGeometry(): InkStrokeGeometry {
  const baseline = new LegacyRoundInkStrokeGeometry();
  return {
    beginActivePresentation: (input) => baseline.beginActivePresentation(input),
    bounds: (candidate) => baseline.bounds(candidate),
    compile: (candidate) => baseline.compile(candidate),
    extend: (active, input) => {
      const reference = baseline.extend(active, input);
      const stableLast = input.delta.stablePrefixDelta.at(-1) ?? active?.stableLast ?? null;
      const mutablePath =
        stableLast === null ? input.delta.mutableTail : [stableLast, ...input.delta.mutableTail];
      return {
        mutablePath,
        stablePathDelta: input.delta.stablePrefixDelta,
        state: {
          ...reference.state,
          mutableTail: input.delta.mutableTail,
          stableLast,
        },
      };
    },
    hitTest: (candidate, pointValue, tolerance) =>
      baseline.hitTest(candidate, pointValue, tolerance),
  };
}

function rawWritingGeometry(): InkStrokeGeometry {
  const baseline = new LegacyRoundInkStrokeGeometry();
  return {
    beginActivePresentation: ({ strokeId, style }) => {
      let stableSampleCount = 0;
      return {
        extend(delta, writer) {
          delta.stablePrefixDelta.forEachSample((sample) => {
            writer.appendStable(sample);
            stableSampleCount += 1;
          });
          writer.resetMutable();
          delta.mutableTail.forEachSample((sample) => writer.appendMutable(sample));
          return {
            mutableTailSampleCount: delta.mutableTail.length,
            paint: {
              color: style.color,
              composite: 'source-over',
              lineCap: 'round',
              lineJoin: 'round',
              opacity: 1,
            },
            stableSegmentCount: Math.max(0, stableSampleCount - 1),
            strokeId,
            tool: style.tool,
            width: style.width,
          };
        },
      };
    },
    bounds: (candidate) => baseline.bounds(candidate),
    compile: (candidate) => baseline.compile(candidate),
    extend: (active, input) => baseline.extend(active, input),
    hitTest: (candidate, pointValue, tolerance) =>
      baseline.hitTest(candidate, pointValue, tolerance),
  };
}

function runtimeFixture(
  host: HTMLElement,
  fixture: ReturnType<typeof documentFixture>,
  frames: FrameRequestCallback[],
  inkPerformance?: InkPerformanceDiagnostics,
): InkRenderRuntime {
  return new InkRenderRuntime({
    document,
    host,
    ...(inkPerformance === undefined ? {} : { inkPerformance }),
    query: fixture.query,
    read: fixture.read,
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
  });
}

function frame(actualScale = 1) {
  return createInkStageFrame({
    actualScale,
    canvasClientRect: { height: 200, left: 0, top: 0, width: 200 },
    documentClientOrigin: { x: 0, y: 0 },
  });
}

function drain(frames: FrameRequestCallback[]): void {
  while (frames.length > 0) frames.shift()?.(performance.now());
}

function documentFixture(initial: readonly InkStroke[]) {
  let strokes = [...initial];
  let generation = 0;
  const read = (): InkDocumentReadView => ({
    documentId: 'document',
    generation,
    indexBytes: 1_024,
    logicalHeight: 1_000,
    logicalWidth: 704,
    persistence: { kind: 'idle' },
    selection: [],
    state: { dirty: false, kind: 'ink-mode', saveError: null },
    strokeCount: strokes.length,
    strokes: refs(strokes),
  });
  const query = (viewport: InkLogicalRect): readonly InkRenderableStrokeRef[] =>
    refs(strokes).filter(({ bounds }) => intersects(bounds, viewport));
  return {
    query,
    read,
    replace(next: readonly InkStroke[]): void {
      strokes = [...next];
      generation += 1;
    },
  };
}

function refs(strokes: readonly InkStroke[]): readonly InkRenderableStrokeRef[] {
  return strokes.map((candidate, order) => ({
    bounds: {
      height: 24,
      width: 34,
      x: candidate.points[0]?.x ?? 0,
      y: candidate.points[0]?.y ?? 0,
    },
    id: candidate.id,
    order,
    stroke: candidate,
  }));
}

function change(
  commandId: string,
  input: { readonly addedIds: readonly string[]; readonly newStroke: InkStroke },
): InkDocumentChange {
  return {
    addedIds: input.addedIds,
    bounds: [
      {
        id: input.newStroke.id,
        newBounds: { height: 24, width: 34, x: 8, y: input.newStroke.points[0]?.y ?? 0 },
        oldBounds: null,
      },
    ],
    commandId,
    generation: 1,
    persistenceDelta: null,
    removedIds: [],
    selectionDelta: null,
    updatedIds: [],
  };
}

function documentChange(
  commandId: string,
  generation: number,
  input: {
    readonly addedIds?: readonly string[];
    readonly bounds: InkDocumentChange['bounds'];
    readonly removedIds?: readonly string[];
    readonly updatedIds?: readonly string[];
  },
): InkDocumentChange {
  return {
    addedIds: input.addedIds ?? [],
    bounds: input.bounds,
    commandId,
    generation,
    persistenceDelta: null,
    removedIds: input.removedIds ?? [],
    selectionDelta: null,
    updatedIds: input.updatedIds ?? [],
  };
}

function refBounds(candidate: InkStroke): InkLogicalRect {
  return refs([candidate])[0]?.bounds ?? { height: 0, width: 0, x: 0, y: 0 };
}

function stroke(id: string, y = 10): InkStroke {
  return {
    color: '#112233',
    id,
    points: [point(10, y, 0), point(40, y + 20, 16)],
    tool: 'pen',
    width: 4,
  };
}

function physicalStroke(id: string, tool: 'highlighter' | 'pen'): InkStroke {
  return {
    brushRenderVersion: tool === 'pen' ? 'pen-physical-v1' : 'highlighter-chisel-v1',
    color: tool === 'pen' ? '#112233' : '#ffcc00',
    id,
    inputProfile: { pressure: 'measured', tilt: 'unavailable' },
    points: [
      {
        orientation: { kind: 'unavailable' },
        pressure: 0.5,
        pressureKind: 'measured',
        time: 0,
        x: 10,
        y: 20,
      },
      {
        orientation: { kind: 'unavailable' },
        pressure: 0.5,
        pressureKind: 'measured',
        time: 16,
        x: 40,
        y: 30,
      },
    ],
    tool,
    width: tool === 'pen' ? 4 : 10,
  };
}

function physicalActiveUpdate(kind: 'active-delta', generation: number, appendStable = true) {
  const contour = (offset: number) => [
    { x: (10 + offset) * 256, y: 10 * 256 },
    { x: (20 + offset) * 256, y: 10 * 256 },
    { x: (20 + offset) * 256, y: 20 * 256 },
    { x: (10 + offset) * 256, y: 20 * 256 },
    { x: (10 + offset) * 256, y: 10 * 256 },
  ];
  return createInkBrushActiveGeometryUpdate({
    kind,
    logicalStrokeId: 'physical-mark',
    mutable: {
      coverage: [
        { contours: [contour(generation * 2)], kind: 'quantized-filled-contours' as const },
      ],
      generation,
      kind: 'replace-bounded-mutable-tail',
    },
    quantization: { logicalGrid: 1 / 256 },
    stable: {
      coverage: appendStable
        ? [{ contours: [contour(0)], kind: 'quantized-filled-contours' as const }]
        : [],
      kind: 'append-only-stable',
    },
    version: 'highlighter-chisel-v1',
    workScope: 'new-stable-plus-bounded-mutable-tail',
  });
}

function physicalActiveFinishUpdate(
  logicalStrokeId: string,
  version: 'highlighter-chisel-v1' | 'pen-physical-v1',
) {
  return createInkBrushActiveGeometryUpdate({
    ...physicalActiveUpdate('active-delta', 1),
    bounds: { height: 10, width: 12, x: 10, y: 10 },
    kind: 'active-finish',
    logicalStrokeId,
    ownershipTransfer: 'active-to-committed-without-blank-frame',
    version,
  });
}

function borrowedNumericDelta(
  stableValues: Float64Array,
  mutableValues: Float64Array,
): InkBorrowedControlTraceDelta {
  return {
    kind: 'borrowed-numeric',
    mutableTail: numericSampleView(mutableValues),
    stablePrefixDelta: numericSampleView(stableValues),
  };
}

function borrowedProvisionalTail(values: Float64Array, frameEpoch = 0): InkBorrowedProvisionalTail {
  return {
    frameEpoch,
    kind: 'borrowed-provisional-prediction-tail',
    length: values.length / 2,
    forEachPoint(consumer) {
      for (let index = 0; index < values.length; index += 2) {
        consumer(values[index] as number, values[index + 1] as number);
      }
    },
  };
}

function exactRawNumericDelta(values: Float64Array): InkBorrowedControlTraceDelta {
  const cursor: InkSampleCursor = {
    altitude: 0,
    azimuth: 0,
    flags: 0,
    pressure: 0,
    time: 0,
    x: 0,
    y: 0,
  };
  const stablePrefixDelta: InkSampleView = {
    length: values.length / 7,
    forEachSample(consumer) {
      for (let index = 0; index < values.length; index += 7) {
        cursor.x = values[index] as number;
        cursor.y = values[index + 1] as number;
        cursor.time = values[index + 2] as number;
        cursor.pressure = values[index + 3] as number;
        cursor.altitude = values[index + 4] as number;
        cursor.azimuth = values[index + 5] as number;
        cursor.flags = values[index + 6] as number;
        consumer(cursor);
      }
    },
  };
  return {
    kind: 'borrowed-numeric',
    mutableTail: { forEachSample: () => undefined, length: 0 },
    stablePrefixDelta,
  };
}

function numericSampleView(values: Float64Array): InkSampleView {
  const cursor: InkSampleCursor = {
    altitude: Math.PI / 3,
    azimuth: Math.PI / 4,
    flags:
      INK_SAMPLE_FLAGS.pressureMeasured |
      INK_SAMPLE_FLAGS.altitudeMeasured |
      INK_SAMPLE_FLAGS.azimuthMeasured,
    pressure: 0,
    time: 0,
    x: 0,
    y: 0,
  };
  return {
    length: values.length / 4,
    forEachSample(consumer) {
      for (let index = 0; index < values.length; index += 4) {
        cursor.x = values[index] as number;
        cursor.y = values[index + 1] as number;
        cursor.time = values[index + 2] as number;
        cursor.pressure = values[index + 3] as number;
        consumer(cursor);
      }
    },
  };
}

function point(x: number, y: number, time: number) {
  return { pressure: 0.5, time, x, y };
}

function intersects(left: InkLogicalRect, right: InkLogicalRect): boolean {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
  );
}

interface ContextFixture {
  readonly arc: ReturnType<typeof vi.fn>;
  readonly clip: ReturnType<typeof vi.fn>;
  readonly clearRect: ReturnType<typeof vi.fn>;
  readonly context: CanvasRenderingContext2D;
  readonly drawImage: ReturnType<typeof vi.fn>;
  readonly fill: ReturnType<typeof vi.fn>;
  readonly lineTo: ReturnType<typeof vi.fn>;
  readonly moveTo: ReturnType<typeof vi.fn>;
  readonly rect: ReturnType<typeof vi.fn>;
  readonly setLineDash: ReturnType<typeof vi.fn>;
  readonly stroke: ReturnType<typeof vi.fn>;
}

function contextFixture(): ContextFixture {
  const arc = vi.fn();
  const clip = vi.fn();
  const clearRect = vi.fn();
  const drawImage = vi.fn();
  const fill = vi.fn();
  const lineTo = vi.fn();
  const moveTo = vi.fn();
  const rect = vi.fn();
  const setLineDash = vi.fn();
  const stroke = vi.fn();
  const context = {
    arc,
    beginPath: vi.fn(),
    clip,
    clearRect,
    closePath: vi.fn(),
    drawImage,
    fill,
    fillStyle: '#000000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'round',
    lineJoin: 'round',
    lineTo,
    lineWidth: 1,
    moveTo,
    rect,
    restore: vi.fn(),
    save: vi.fn(),
    setLineDash,
    setTransform: vi.fn(),
    stroke,
    strokeStyle: '#000000',
  } as unknown as CanvasRenderingContext2D;
  return {
    arc,
    clip,
    clearRect,
    context,
    drawImage,
    fill,
    lineTo,
    moveTo,
    rect,
    setLineDash,
    stroke,
  };
}

function workerPresentationFixture() {
  let stable: HTMLCanvasElement | null = null;
  let tail: HTMLCanvasElement | null = null;
  const configure = vi.fn<InkWorkerPresentationAdapterPort['configure']>((input) => {
    if (stable === null || tail === null) throw new Error('Worker activation did not start.');
    stable.width = input.backingWidth;
    stable.height = input.backingHeight;
    tail.width = input.backingWidth;
    tail.height = input.backingHeight;
  });
  const beginContact = vi.fn<InkWorkerPresentationAdapterPort['beginContact']>();
  let packetSequence = 0;
  const submit = vi.fn<InkWorkerPresentationAdapterPort['submit']>(() => {
    packetSequence += 1;
    return {
      kind: 'submitted-async' as const,
      packetSequence,
      submittedSegmentCount: 1,
    };
  });
  const reset = vi.fn<InkWorkerPresentationAdapterPort['reset']>();
  const dispose = vi.fn<InkWorkerPresentationAdapterPort['dispose']>();
  const disposePrepared = vi.fn();
  const cancelActivation = vi.fn();
  let resolveActivation:
    | ((result: {
        readonly adapter: InkWorkerPresentationAdapterPort;
        readonly kind: 'ready';
      }) => void)
    | null = null;
  const activate = vi.fn(() => {
    stable = document.createElement('canvas');
    stable.width = 0;
    stable.height = 0;
    stable.dataset.inkstoneInkActiveStable = 'worker';
    tail = document.createElement('canvas');
    tail.width = 0;
    tail.height = 0;
    tail.dataset.inkstoneInkActive = 'worker';
    const canvases = { stable, tail };
    return {
      cancel: cancelActivation,
      canvases,
      result: new Promise<{
        readonly adapter: InkWorkerPresentationAdapterPort;
        readonly kind: 'ready';
      }>((resolve) => {
        resolveActivation = resolve;
      }),
    };
  });
  let resolvePreparation: ((result: InkWorkerPresentationPreparationResult) => void) | null = null;
  let preparationResolved = false;
  let callbacks: Parameters<InkWorkerPresentationPreparationFactory>[0] | null = null;
  const prepare = vi.fn<InkWorkerPresentationPreparationFactory>(
    (input) =>
      new Promise<InkWorkerPresentationPreparationResult>((resolve) => {
        callbacks = input;
        resolvePreparation = resolve;
      }),
  );
  const prepared = { activate, dispose: disposePrepared };
  const resolvePrepared = async (): Promise<void> => {
    if (!preparationResolved) {
      if (resolvePreparation === null) throw new Error('Worker preparation did not start.');
      preparationResolved = true;
      resolvePreparation({ kind: 'ready', prepared });
    }
    await Promise.resolve();
  };
  const resolveActivationReady = async (): Promise<void> => {
    if (resolveActivation === null || stable === null || tail === null) {
      throw new Error('Worker activation did not start.');
    }
    resolveActivation({
      adapter: { beginContact, canvases: { stable, tail }, configure, dispose, reset, submit },
      kind: 'ready',
    });
    await Promise.resolve();
  };
  const ackPacket = (acknowledgedPacketSequence: number): void => {
    const contact = beginContact.mock.calls.at(-1)?.[0];
    const configured = configure.mock.calls.at(-1)?.[0];
    const submission = submit.mock.calls[acknowledgedPacketSequence - 1]?.[0];
    if (
      callbacks === null ||
      contact === undefined ||
      configured === undefined ||
      submission === undefined
    ) {
      throw new Error('Worker does not own an acknowledged frame.');
    }
    callbacks.onAck({
      contactSequence: contact.contactSequence,
      frameEpoch: configured.frameEpoch,
      generation: submission.generation,
      packetSequence: acknowledgedPacketSequence,
    });
  };
  return {
    ackLatest() {
      ackPacket(packetSequence);
    },
    ackPacket,
    activate,
    beginContact,
    cancelActivation,
    configure,
    dispose,
    disposePrepared,
    fault(failure: Parameters<NonNullable<typeof callbacks>['onFault']>[0]) {
      if (callbacks === null) throw new Error('Worker preparation did not start.');
      callbacks.onFault(failure);
    },
    prepare,
    reset,
    resolveActivationReady,
    resolvePrepared,
    async resolveReady() {
      await resolvePrepared();
      await resolveActivationReady();
    },
    get stable() {
      if (stable === null) throw new Error('Worker activation did not create a stable Canvas.');
      return stable;
    },
    submit,
    get tail() {
      if (tail === null) throw new Error('Worker activation did not create a tail Canvas.');
      return tail;
    },
  };
}

function deadlineFixture() {
  const callbacks = new Map<object, () => void>();
  const scheduler = {
    cancel: vi.fn((handle: unknown) => {
      if (typeof handle === 'object' && handle !== null) callbacks.delete(handle);
    }),
    schedule: vi.fn((callback: () => void) => {
      const handle = {};
      callbacks.set(handle, callback);
      return handle;
    }),
  };
  return {
    fireLatest() {
      const latest = [...callbacks.entries()].at(-1);
      if (latest === undefined) throw new Error('Worker Ack deadline was not armed.');
      callbacks.delete(latest[0]);
      latest[1]();
    },
    pendingCount: () => callbacks.size,
    scheduler,
  };
}
