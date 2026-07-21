// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InkPoint, InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import type { InkSurfaceSessionSnapshot } from '../application/ink-surface-session';
import type {
  InkDocumentApplyResult,
  InkDocumentChange,
  InkDocumentCommand,
  InkLogicalRect,
} from '../application/ink-document-session';
import { InkLiveDocument } from '../application/ink-document-session';
import { UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE } from '../domain/ink-highlighter-physical-geometry';
import { InkPerformanceDiagnostics } from '../runtime/ink-performance-diagnostics';
import { InkWorkScheduler } from '../runtime/ink-work-scheduler';
import {
  createTestInkReadView,
  queryTestInkReadView,
} from '../test-support/ink-live-document-fixture';
import { InkCanvasController } from './ink-canvas-controller';
import {
  InkRenderRuntime,
  type InkWorkerPresentationPreparationFactory,
} from './ink-render-runtime';
import { createInkStageFrame } from './ink-stage-frame';
import {
  type InkToolPreference,
  LocalInkToolPreferenceStore,
} from '../storage/local-ink-tool-preference';

describe('Ink canvas controller', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(contextFixture());
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined,
    });
  });

  it('forwards an explicit experimental Worker presentation selection to the render runtime', async () => {
    const prepare: InkWorkerPresentationPreparationFactory = vi.fn(() =>
      Promise.resolve({ failureCategory: 'api-unavailable', kind: 'unavailable' } as const),
    );
    const root = document.createElement('div');
    document.body.append(root);

    const controller = new InkCanvasController({
      document,
      root,
      session: new FakeSession(surface()),
      workerPresentation: { enabled: true, prepare },
    });

    expect(controller.activePresentationAdapterState).toEqual({
      adapter: 'main-canvas-2d',
      epoch: 1,
      requestedAdapter: 'worker-offscreen-2d',
    });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(controller.activePresentationAdapterState).toEqual({
      adapter: 'main-canvas-2d',
      epoch: 1,
      requestedAdapter: 'worker-offscreen-2d',
    });
    controller.dispose();
  });

  it('resets sustained inactivity for navigation, toolbar, and keyboard interaction', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();

    root.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-in]')?.click();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="highlighter"]')?.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));

    expect(session.userInteractionCalls).toBe(4);
    controller.dispose();
  });

  it('routes physical Highlighter input through live-first S32 coverage with no Recovery call', () => {
    const fill = vi.fn();
    const canvasStroke = vi.fn();
    const canvasContext = contextFixture(canvasStroke);
    canvasContext.fill = fill;
    canvasContext.closePath = vi.fn();
    canvasContext.globalAlpha = 1;
    canvasContext.globalCompositeOperation = 'source-over';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
    const updateSurface = vi.fn((record: InkSurfaceRecord) => Promise.resolve(record));
    const source: InkSurfaceRecord = {
      ...surface([v3LegacyStroke('v3-history')]),
      layout: { ...surface().layout, originY: 0 },
      schemaVersion: 3,
    };
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      surfaces: [source],
      writer: { updateSurface },
    });
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      preference: { color: '#f4c542', hintShown: true, tool: 'highlighter', width: 12 },
      root,
      session,
      unpublishedPhysicalInkHat: {
        session,
      },
    });
    controller.enter();
    canvasStroke.mockClear();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    root.dispatchEvent(pointer('pointermove', 30, 35, 'pen'));
    expect(root.querySelector<HTMLElement>('.inkstone-ink-active-stack')?.style.opacity).toBe(
      String(UNPUBLISHED_INK_HIGHLIGHTER_CHISEL_PROFILE.opticalDensity),
    );
    expect(canvasStroke).not.toHaveBeenCalled();
    root.dispatchEvent(pointer('pointerup', 50, 40, 'pen'));

    const persisted = session
      .read()
      .strokes.find(({ stroke: candidate }) => candidate.id !== 'v3-history')?.stroke;
    expect(persisted).toMatchObject({
      brushRenderVersion: 'highlighter-chisel-v1',
      color: '#f4c542',
      inputProfile: { pressure: 'measured', tilt: 'measured' },
      tool: 'highlighter',
    });
    expect(updateSurface).not.toHaveBeenCalled();
    expect(fill).toHaveBeenCalledWith('nonzero');
    controller.dispose();
  });

  it('cancels a physical contact poisoned by invalid coalesced input instead of bridging to pen-up', () => {
    const canvasContext = contextFixture();
    canvasContext.fill = vi.fn();
    canvasContext.closePath = vi.fn();
    canvasContext.globalAlpha = 1;
    canvasContext.globalCompositeOperation = 'source-over';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
    const source: InkSurfaceRecord = {
      ...surface([]),
      layout: { ...surface().layout, originY: 0 },
      schemaVersion: 3,
    };
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      surfaces: [source],
      writer: { updateSurface: (record) => Promise.resolve(record) },
    });
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      preference: { color: '#112233', hintShown: true, tool: 'pen', width: 4 },
      root,
      session,
      unpublishedPhysicalInkHat: { session },
    });
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    root.dispatchEvent(pointer('pointermove', 20, 25, 'pen'));
    const invalidMove = pointer('pointermove', 500, 500, 'pen');
    Object.defineProperty(invalidMove, 'getCoalescedEvents', {
      configurable: true,
      value: () => [
        {
          altitudeAngle: undefined,
          azimuthAngle: undefined,
          clientX: Number.NaN,
          clientY: 500,
          pointerId: 1,
          pointerType: 'pen',
          pressure: 0.7,
          tiltX: 0,
          tiltY: 0,
          timeStamp: invalidMove.timeStamp,
        },
      ],
    });
    root.dispatchEvent(invalidMove);
    root.dispatchEvent(pointer('pointerup', 500, 500, 'pen'));

    expect(session.read().strokes).toHaveLength(0);

    root.dispatchEvent(pointer('pointerdown', 30, 30, 'pen'));
    root.dispatchEvent(pointer('pointermove', 40, 35, 'pen'));
    root.dispatchEvent(pointer('pointerup', 50, 40, 'pen'));
    expect(session.read().strokes).toHaveLength(1);
    controller.dispose();
  });

  it('reports a front-loaded parent repair on the real controller input span', () => {
    const canvasContext = contextFixture();
    canvasContext.fill = vi.fn();
    canvasContext.closePath = vi.fn();
    canvasContext.globalAlpha = 1;
    canvasContext.globalCompositeOperation = 'source-over';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
    const source: InkSurfaceRecord = {
      ...surface([]),
      layout: { ...surface().layout, originY: 0 },
      schemaVersion: 3,
    };
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      surfaces: [source],
      writer: { updateSurface: (record) => Promise.resolve(record) },
    });
    const diagnostics = new InkPerformanceDiagnostics(true);
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      preference: { color: '#112233', hintShown: true, tool: 'pen', width: 4 },
      root,
      session,
      unpublishedPhysicalInkHat: { session },
    });
    controller.enter();

    const down = pointer('pointerdown', 10, 20, 'pen');
    Object.defineProperty(down, 'timeStamp', { configurable: true, value: 0 });
    root.dispatchEvent(down);
    const move = pointer('pointermove', 40, 20, 'pen');
    const rawFirst = pointer('pointermove', 20, 30, 'pen');
    const rawSecond = pointer('pointermove', 30, 32, 'pen');
    Object.defineProperty(move, 'timeStamp', { configurable: true, value: 30 });
    Object.defineProperty(rawFirst, 'timeStamp', { configurable: true, value: 10 });
    Object.defineProperty(rawSecond, 'timeStamp', { configurable: true, value: 20 });
    Object.defineProperty(move, 'getCoalescedEvents', {
      configurable: true,
      value: () => [move, rawFirst, rawSecond],
    });
    root.dispatchEvent(move);

    expect(diagnostics.snapshot().recentSpans).toContainEqual(
      expect.objectContaining({
        causalRepair: 'front-loaded-parent',
        inputPhase: 'move',
        name: 'ink-input-handler',
      }),
    );
    const up = pointer('pointerup', 45, 20, 'pen');
    Object.defineProperty(up, 'timeStamp', { configurable: true, value: 40 });
    root.dispatchEvent(up);
    const stored = session.read().strokes[0]?.stroke;
    expect(stored).toMatchObject({ brushRenderVersion: 'pen-physical-v1' });
    if (stored?.brushRenderVersion !== 'pen-physical-v1') {
      throw new Error('Expected the physical stringing canary stroke.');
    }
    const first = stored.points[0];
    const second = stored.points[1];
    if (first === undefined || second === undefined) {
      throw new Error('Expected a multi-point physical stringing canary trace.');
    }
    expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeLessThan(20);
    controller.dispose();
  });

  it('seals the confirmed prefix and rejects stale samples across a forced Stage Frame epoch', () => {
    const canvasContext = contextFixture();
    canvasContext.fill = vi.fn();
    canvasContext.closePath = vi.fn();
    canvasContext.globalAlpha = 1;
    canvasContext.globalCompositeOperation = 'source-over';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      surfaces: [surface()],
      writer: { updateSurface: (record) => Promise.resolve(record) },
    });
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      preference: { color: '#112233', hintShown: true, tool: 'pen', width: 4 },
      root,
      session,
      unpublishedPhysicalInkHat: { session },
    });
    controller.enter();
    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    root.dispatchEvent(pointer('pointermove', 30, 32, 'pen'));
    const internal = controller as unknown as {
      publishStageFrame(frame: ReturnType<typeof createInkStageFrame>): void;
      sealActiveContactForForcedStageFrame(): void;
    };
    internal.publishStageFrame(
      createInkStageFrame({
        actualScale: 1,
        canvasClientRect: { height: 300, left: 0, top: 0, width: 300 },
        documentClientOrigin: { x: 0, y: 0 },
      }),
    );

    internal.sealActiveContactForForcedStageFrame();
    root.dispatchEvent(pointer('pointermove', 250, 250, 'pen'));
    root.dispatchEvent(pointer('pointerup', 260, 260, 'pen'));

    const stored = session.read().strokes[0]?.stroke;
    expect(stored).toMatchObject({ brushRenderVersion: 'pen-physical-v1' });
    expect(stored?.points.at(-1)).toMatchObject({ x: 30, y: 32 });
    expect(stored?.points.some(({ x, y }) => x >= 250 || y >= 250)).toBe(false);
    controller.dispose();
  });

  it('promotes a completed physical stroke without reinstalling the full committed document', () => {
    const flushNow = vi.spyOn(InkRenderRuntime.prototype, 'flushNow');
    const canvasContext = contextFixture();
    canvasContext.fill = vi.fn();
    canvasContext.closePath = vi.fn();
    canvasContext.globalAlpha = 1;
    canvasContext.globalCompositeOperation = 'source-over';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
    const diagnostics = new InkPerformanceDiagnostics(true);
    const source: InkSurfaceRecord = {
      ...surface([v3LegacyStroke('history-a'), v3LegacyStroke('history-b')]),
      layout: { ...surface().layout, originY: 0 },
      schemaVersion: 3,
    };
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      surfaces: [source],
      writer: { updateSurface: (record) => Promise.resolve(record) },
    });
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      preference: { color: '#112233', hintShown: true, tool: 'pen', width: 4 },
      root,
      session,
      unpublishedPhysicalInkHat: {
        session,
      },
    });
    controller.enter();
    diagnostics.reset();
    flushNow.mockClear();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    root.dispatchEvent(pointer('pointermove', 20, 25, 'pen'));
    root.dispatchEvent(pointer('pointerup', 30, 30, 'pen'));

    const viewportCounts = diagnostics
      .snapshot()
      .recentSpans.filter(({ name }) => name === 'ink-viewport-redraw')
      .map(({ viewportResultCount }) => viewportResultCount);
    expect(viewportCounts).not.toContain(3);
    expect(viewportCounts.at(-1)).toBe(1);
    expect(flushNow).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('commits the logical physical stroke even when final active rendering fails', () => {
    const canvasContext = contextFixture();
    canvasContext.closePath = vi.fn();
    canvasContext.fill = vi.fn();
    canvasContext.globalAlpha = 1;
    canvasContext.globalCompositeOperation = 'source-over';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
    const finalizeActive = vi
      .spyOn(InkRenderRuntime.prototype, 'finalizeActive')
      .mockImplementationOnce(() => {
        throw new Error('synthetic final active render failure');
      });
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({
      document,
      root,
      session,
      unpublishedPhysicalInkHat: { session },
    });
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    root.dispatchEvent(pointer('pointermove', 20, 25, 'pen'));
    root.dispatchEvent(pointer('pointerup', 30, 30, 'pen'));

    expect(finalizeActive).toHaveBeenCalledOnce();
    expect(session.read().strokes).toHaveLength(1);
    expect(
      root.querySelector<HTMLElement>('[data-inkstone-ink-toolbar-host]')?.dataset
        .inkstonePhysicalCandidate,
    ).toBe('ready');
    controller.dispose();
  });

  it('returns immediately when the session callback and commit path deliver the same change', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    const read = session.read();
    const change: InkDocumentChange = {
      addedIds: ['deduplicated'],
      bounds: [],
      commandId: 'deduplicated-change',
      generation: read.generation,
      persistenceDelta: null,
      removedIds: [],
      selectionDelta: null,
      updatedIds: [],
    };
    const canUndo = vi.spyOn(session, 'canUndo');

    controller.sync(read, change);
    canUndo.mockClear();
    controller.sync(read, change);

    expect(canUndo).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('keeps a degraded physical trace canonical while only its Active presentation falls back locally', () => {
    const canvasStroke = vi.fn();
    const canvasContext = contextFixture(canvasStroke);
    canvasContext.fill = vi.fn();
    canvasContext.closePath = vi.fn();
    canvasContext.globalAlpha = 1;
    canvasContext.globalCompositeOperation = 'source-over';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
    const updateSurface = vi.fn((record: InkSurfaceRecord) => Promise.resolve(record));
    const source: InkSurfaceRecord = {
      ...surface([]),
      layout: { ...surface().layout, originY: 0 },
      schemaVersion: 3,
    };
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      surfaces: [source],
      writer: { updateSurface },
    });
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      preference: { color: '#112233', hintShown: true, tool: 'pen', width: 4 },
      root,
      session,
      unpublishedPhysicalInkHat: {
        session,
      },
    });
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    root.dispatchEvent(pointer('pointermove', 1e15, 22, 'pen'));
    expect(root.querySelector('[data-inkstone-ink-status]')?.textContent).toContain(
      'using local legacy presentation',
    );
    expect(canvasStroke).toHaveBeenCalled();
    root.dispatchEvent(pointer('pointerup', 1e15, 24, 'pen'));

    expect(updateSurface).not.toHaveBeenCalled();
    expect(session.read().strokes[0]?.stroke).toMatchObject({
      brushRenderVersion: 'pen-physical-v1',
      tool: 'pen',
    });
    controller.dispose();
  });

  it('moves explicitly between raw, Ink preview, and Ink edit without preview input capture', () => {
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, layoutRoot, root, session });

    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const overlay = root.querySelector<HTMLElement>('[data-inkstone-ink-surface]');
    const toolbar = root.querySelector<HTMLElement>('[data-inkstone-ink-toolbar-host]');

    expect(overlay?.hidden).toBe(true);
    expect(overlay?.dataset.inkstoneInkController).toMatch(/^\d+$/u);
    expect(toolbar?.dataset).toMatchObject({
      inkstoneControllerActive: 'false',
      inkstoneInkController: overlay?.dataset.inkstoneInkController,
      inkstonePhysicalCandidate: 'unavailable',
    });
    expect(layoutRoot.classList.contains('inkstone-ink-workspace')).toBe(false);
    controller.showPreview();
    expect(overlay?.hidden).toBe(false);
    expect(active?.style.pointerEvents).toBe('none');
    expect(committed?.style.pointerEvents).toBe('none');
    expect(layoutRoot.classList.contains('inkstone-ink-workspace')).toBe(true);
    expect(root.classList.contains('is-ink-preview')).toBe(true);
    expect(root.querySelector<HTMLElement>('.inkstone-ink-controls')?.style.display).toBe('none');

    controller.hidePreview();
    expect(overlay?.hidden).toBe(true);
    expect(root.classList.contains('is-ink-preview')).toBe(false);
    expect(root.classList.contains('is-ink-mode')).toBe(false);

    controller.enter();
    expect(toolbar?.dataset.inkstoneControllerActive).toBe('true');
    expect(active?.style.pointerEvents).toBe('none');
    expect(root.classList.contains('is-ink-preview')).toBe(false);
    expect(root.classList.contains('is-ink-mode')).toBe(true);
    expect(root.querySelector<HTMLElement>('.inkstone-ink-controls')?.style.display).toBe('flex');
    expect(root.classList.contains('inkstone-ink-host')).toBe(true);
    controller.dispose();
  });

  it('does not run Select hover hit-testing after Ink edit exits to preview', async () => {
    const activeStroke = vi.fn();
    const activeClear = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      return this.dataset.inkstoneInkActive === 'true'
        ? contextFixture(activeStroke, activeClear)
        : contextFixture();
    });
    const root = document.createElement('div');
    document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 600));
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();
    root.dispatchEvent(pointer('pointermove', 10, 10));
    expect(activeStroke).toHaveBeenCalled();

    await controller.exit('preview');

    root.dispatchEvent(pointer('pointermove', 10, 10));

    expect(session.hoverCalls).toHaveLength(1);
    expect(root.style.cursor).toBe('');
    expect(activeClear).toHaveBeenCalled();
    expect(activeClear.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      activeStroke.mock.invocationCallOrder.at(-1) ?? 0,
    );
    controller.dispose();
  });

  it('re-enters the retained preview session before accepting another stroke', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });

    controller.enter();
    await controller.exit('preview');
    controller.enter();
    root.dispatchEvent(pointer('pointerdown', 10, 20));
    root.dispatchEvent(pointer('pointerup', 20, 30));

    expect(session.enterCalls).toBe(2);
    expect(session.strokes).toHaveLength(1);
    controller.dispose();
  });

  it('captures mouse drawing from the Reading View host while Canvas stays pointer-transparent', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));

    controller.enter();
    expect(active.style.pointerEvents).toBe('none');
    expect(root.querySelector<HTMLElement>('.inkstone-ink-controls')?.style.display).toBe('flex');
    expect(root.querySelector('[data-inkstone-ink-status]')?.textContent).toContain('Ink Mode');
    root.dispatchEvent(pointer('pointerdown', 10, 20));
    root.dispatchEvent(pointer('pointermove', 20, 30));
    root.dispatchEvent(pointer('pointerup', 30, 40));
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    root.dispatchEvent(wheel);

    expect(session.strokes[0]?.tool).toBe('pen');
    expect(Array.isArray(session.strokes[0]?.points)).toBe(true);
    expect(session.strokes[0]?.points.length).toBeGreaterThanOrEqual(2);
    expect(session.applyCalls).toBe(1);
    expect(session.interactionCalls).toEqual([true, false]);
    expect(wheel.defaultPrevented).toBe(false);

    await controller.exit();
    expect(session.exitCalls).toBe(1);
    expect(active.style.pointerEvents).toBe('none');
    expect(root.querySelector<HTMLElement>('.inkstone-ink-controls')?.style.display).toBe('none');
    expect(root.classList.contains('is-ink-mode')).toBe(false);
  });

  it('preserves measured Pencil pressure zero through the completed document command', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen', 'all', undefined, 0));
    root.dispatchEvent(pointer('pointerup', 20, 30, 'pen', 'all', undefined, 0));

    expect(session.strokes[0]?.points.map(({ pressure }) => pressure)).toEqual([0, 0]);
    controller.dispose();
  });

  it('uses Pencil predictions only for an active visual tail and never persists them', () => {
    const predictionReads = vi.fn();
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();

    root.dispatchEvent(
      pointerWithPredictions('pointerdown', 10, 20, [[510, 520]], predictionReads),
    );
    root.dispatchEvent(
      pointerWithPredictions(
        'pointermove',
        20,
        30,
        [
          [610, 620],
          [710, 720],
        ],
        predictionReads,
      ),
    );
    root.dispatchEvent(pointerWithPredictions('pointerup', 30, 40, [[810, 820]], predictionReads));

    expect(predictionReads).toHaveBeenCalledTimes(2);
    expect(session.strokes).toHaveLength(1);
    expect(session.strokes[0]?.points).toHaveLength(3);
    expect(session.strokes[0]?.points.every(({ x, y }) => x <= 30 && y <= 40)).toBe(true);
    controller.dispose();
  });

  it('does not request provisional predictions for the stroke eraser', () => {
    const predictionReads = vi.fn();
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(
      pointerWithPredictions('pointerdown', 10, 20, [[510, 520]], predictionReads),
    );
    root.dispatchEvent(
      pointerWithPredictions('pointermove', 20, 30, [[610, 620]], predictionReads),
    );
    root.dispatchEvent(pointer('pointerup', 30, 40, 'pen'));

    expect(predictionReads).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('applies the fixed logical width only while Ink Mode is active', async () => {
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      session: new FakeSession(surface()),
    });

    expect(layoutRoot.classList.contains('inkstone-ink-workspace')).toBe(false);
    expect(layoutRoot.style.getPropertyValue('--inkstone-ink-logical-width')).toBe('');

    controller.enter();
    expect(layoutRoot.classList.contains('inkstone-ink-workspace')).toBe(true);
    expect(layoutRoot.style.getPropertyValue('--inkstone-ink-logical-width')).toBe('704px');
    expect(layoutRoot.style.getPropertyValue('--inkstone-ink-logical-height')).toBe('1200px');

    await controller.exit();
    expect(layoutRoot.classList.contains('inkstone-ink-workspace')).toBe(false);
    expect(layoutRoot.style.getPropertyValue('--inkstone-ink-logical-width')).toBe('');
    expect(layoutRoot.style.getPropertyValue('--inkstone-ink-logical-height')).toBe('');
  });

  it('offers zoom out, fit, and zoom in for the synchronized Ink workspace', () => {
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      session: new FakeSession(surface()),
    });

    controller.enter();

    expect(root.classList.contains('is-ink-fit')).toBe(true);
    expect(root.querySelector('[data-inkstone-ink-zoom-out]')).not.toBeNull();
    expect(root.querySelector('[data-inkstone-ink-zoom-fit]')?.textContent).toContain('100%');
    expect(root.querySelector('[data-inkstone-ink-zoom-in]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-in]')?.click();
    expect(root.classList.contains('is-ink-fit')).toBe(false);
    expect(Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale'))).toBeCloseTo(1.1);
    expect(root.querySelector('[data-inkstone-ink-zoom-fit]')?.textContent).toContain('110%');
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-fit]')?.click();
    expect(root.classList.contains('is-ink-fit')).toBe(true);
    expect(Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale'))).toBe(1);
    controller.dispose();
  });

  it('restores Preview to 100% without forgetting the previous Edit zoom', async () => {
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-out]')?.click();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-out]')?.click();
    expect(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')).toBe('0.8');

    await controller.exit('preview');

    expect(root.classList.contains('is-ink-preview')).toBe(true);
    expect(root.classList.contains('is-ink-fit')).toBe(false);
    expect(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')).toBe('1');

    controller.enter();
    expect(root.classList.contains('is-ink-fit')).toBe(false);
    expect(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')).toBe('0.8');
    controller.dispose();
  });

  it('leaves Select and move when the user chooses a drawing tool', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const select = root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]');
    const pen = root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="pen"]');
    if (active === null || select === null || pen === null)
      throw new Error('Missing Ink controls.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 1_200));

    controller.enter();
    select.click();
    pen.click();
    root.dispatchEvent(pointer('pointerdown', 100, 100));
    root.dispatchEvent(pointer('pointerup', 100, 100));

    expect(select.getAttribute('aria-pressed')).toBe('false');
    expect(pen.getAttribute('aria-pressed')).toBe('true');
    expect(session.strokes).toHaveLength(1);
    controller.dispose();
  });

  it('opens color, width, and zoom controls only from the More action', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();
    const extendedControls = [
      root.querySelector<HTMLElement>('[data-inkstone-ink-color]'),
      root.querySelector<HTMLElement>('[data-inkstone-ink-width-control]'),
      root.querySelector<HTMLElement>('[data-inkstone-ink-zoom-out]'),
      root.querySelector<HTMLElement>('[data-inkstone-ink-zoom-fit]'),
      root.querySelector<HTMLElement>('[data-inkstone-ink-zoom-in]'),
    ];
    if (extendedControls.some((control) => control === null)) {
      throw new Error('Missing extended Ink control.');
    }
    const areHidden = (): boolean => extendedControls.every((control) => control?.hidden === true);

    expect(areHidden()).toBe(true);
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="pen"]')?.click();
    expect(areHidden()).toBe(true);
    root.querySelector<HTMLButtonElement>('button[aria-label="Show or hide Ink options"]')?.click();
    expect(extendedControls.every((control) => control?.hidden === false)).toBe(true);
    controller.dispose();
  });

  it('shows the selected tool style after switching tools while options are hidden', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      preference: {
        ...LocalInkToolPreferenceStore.DEFAULT,
        hintShown: true,
        toolStyles: {
          ...LocalInkToolPreferenceStore.DEFAULT_TOOL_STYLES,
          highlighter: { color: '#aabbcc', width: 12 },
          pen: { color: '#112233', width: 4 },
        },
      },
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();
    const pen = root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="pen"]');
    const highlighter = root.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-tool="highlighter"]',
    );
    const options = root.querySelector<HTMLButtonElement>(
      'button[aria-label="Show or hide Ink options"]',
    );
    const color = root.querySelector<HTMLInputElement>('[data-inkstone-ink-color]');
    const width = root.querySelector<HTMLSelectElement>('[data-inkstone-ink-width-select]');
    if (
      pen === null ||
      highlighter === null ||
      options === null ||
      color === null ||
      width === null
    ) {
      throw new Error('Missing Ink style controls.');
    }

    expect(color.hidden).toBe(true);
    highlighter.click();
    expect(pen.getAttribute('aria-pressed')).toBe('false');
    expect(highlighter.getAttribute('aria-pressed')).toBe('true');
    expect(color.hidden).toBe(true);

    options.click();

    expect(color.hidden).toBe(false);
    expect(color.value).toBe('#aabbcc');
    expect(width.value).toBe('12');
    expect(pen.getAttribute('aria-pressed')).toBe('false');
    expect(highlighter.getAttribute('aria-pressed')).toBe('true');
    controller.dispose();
  });

  it('applies the brush width selected from the dropdown to the next stroke', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active Canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 1_200));

    controller.enter();
    root.querySelector<HTMLButtonElement>('button[aria-label="Show or hide Ink options"]')?.click();
    const width = root.querySelector<HTMLSelectElement>('[data-inkstone-ink-width-select]');
    expect(width?.value).toBe('4');
    if (width === null) throw new Error('Missing Ink width dropdown.');
    width.value = '8';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    root.dispatchEvent(pointer('pointerdown', 100, 100));
    root.dispatchEvent(pointer('pointerup', 100, 100));

    expect(session.strokes.at(-1)?.width).toBe(8);
    controller.dispose();
  });

  it('remembers color and width independently for every drawing tool', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();
    root.querySelector<HTMLButtonElement>('button[aria-label="Show or hide Ink options"]')?.click();
    const chooseStyle = (tool: 'pen' | 'highlighter' | 'eraser', value: string, pixels: number) => {
      root.querySelector<HTMLButtonElement>(`[data-inkstone-ink-tool="${tool}"]`)?.click();
      const color = root.querySelector<HTMLInputElement>('[data-inkstone-ink-color]');
      const width = root.querySelector<HTMLSelectElement>('[data-inkstone-ink-width-select]');
      if (color === null || width === null) throw new Error('Missing Ink style controls.');
      color.value = value;
      color.dispatchEvent(new Event('input', { bubbles: true }));
      width.value = String(pixels);
      width.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const expectStyle = (tool: 'pen' | 'highlighter' | 'eraser', value: string, pixels: number) => {
      root.querySelector<HTMLButtonElement>(`[data-inkstone-ink-tool="${tool}"]`)?.click();
      expect(root.querySelector<HTMLInputElement>('[data-inkstone-ink-color]')?.value).toBe(value);
      expect(root.querySelector<HTMLSelectElement>('[data-inkstone-ink-width-select]')?.value).toBe(
        String(pixels),
      );
    };

    chooseStyle('pen', '#112233', 8);
    chooseStyle('highlighter', '#445566', 16);
    chooseStyle('eraser', '#778899', 2);

    expectStyle('pen', '#112233', 8);
    expectStyle('highlighter', '#445566', 16);
    expectStyle('eraser', '#778899', 2);
    controller.dispose();
  });

  it('restores every tool style after the Ink controller is recreated', () => {
    const changes: InkToolPreference[] = [];
    const firstRoot = document.createElement('div');
    document.body.append(firstRoot);
    const first = new InkCanvasController({
      document,
      onPreferenceChanged: (preference) => changes.push(preference),
      root: firstRoot,
      session: new FakeSession(surface()),
    });
    first.enter();
    firstRoot
      .querySelector<HTMLButtonElement>('button[aria-label="Show or hide Ink options"]')
      ?.click();

    const chooseStyle = (
      root: HTMLElement,
      tool: 'pen' | 'highlighter' | 'eraser',
      color: string,
      width: number,
    ) => {
      root.querySelector<HTMLButtonElement>(`[data-inkstone-ink-tool="${tool}"]`)?.click();
      const colorInput = root.querySelector<HTMLInputElement>('[data-inkstone-ink-color]');
      const widthInput = root.querySelector<HTMLSelectElement>('[data-inkstone-ink-width-select]');
      if (colorInput === null || widthInput === null)
        throw new Error('Missing Ink style controls.');
      colorInput.value = color;
      colorInput.dispatchEvent(new Event('input', { bubbles: true }));
      widthInput.value = String(width);
      widthInput.dispatchEvent(new Event('change', { bubbles: true }));
    };
    chooseStyle(firstRoot, 'pen', '#112233', 8);
    chooseStyle(firstRoot, 'highlighter', '#445566', 16);
    chooseStyle(firstRoot, 'eraser', '#778899', 2);
    const saved = changes.at(-1);
    if (saved === undefined) throw new Error('Missing persisted Ink preference.');
    first.dispose();

    const secondRoot = document.createElement('div');
    document.body.append(secondRoot);
    const second = new InkCanvasController({
      document,
      preference: saved,
      root: secondRoot,
      session: new FakeSession(surface()),
    });
    second.enter();
    const expectStyle = (tool: 'pen' | 'highlighter' | 'eraser', color: string, width: number) => {
      secondRoot.querySelector<HTMLButtonElement>(`[data-inkstone-ink-tool="${tool}"]`)?.click();
      expect(secondRoot.querySelector<HTMLInputElement>('[data-inkstone-ink-color]')?.value).toBe(
        color,
      );
      expect(
        secondRoot.querySelector<HTMLSelectElement>('[data-inkstone-ink-width-select]')?.value,
      ).toBe(String(width));
    };

    expectStyle('pen', '#112233', 8);
    expectStyle('highlighter', '#445566', 16);
    expectStyle('eraser', '#778899', 2);
    second.dispose();
  });

  it('replaces the complete Canvas transform after a zoom gesture settles', async () => {
    vi.useFakeTimers();
    const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
    const transformSpies = new WeakMap<HTMLCanvasElement, ReturnType<typeof vi.fn>>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing;
      const transformSpy = vi.fn();
      const created = contextFixture(vi.fn(), vi.fn(), transformSpy);
      contexts.set(this, created);
      transformSpies.set(this, transformSpy);
      return created;
    });
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 1_000 },
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1_000, 600));
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockImplementation(() => {
      const scale = Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')) || 1;
      return rect((1_000 - 704 * scale) / 2, 0, 704 * scale, 1_200 * scale);
    });
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session: new FakeSession(surface([stroke('saved')])),
    });
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (committed === null || active === null) throw new Error('Missing Ink Canvas layers.');
    const committedTransformSpy = transformSpies.get(committed);
    const activeTransformSpy = transformSpies.get(active);
    if (committedTransformSpy === undefined || activeTransformSpy === undefined) {
      throw new Error('Missing Ink Canvas transform spies.');
    }

    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-out]')?.click();
    await vi.runAllTimersAsync();

    expect(committedTransformSpy).toHaveBeenCalledWith(0.9, 0, 0, 0.9, 183.2, 0);
    expect(activeTransformSpy).toHaveBeenCalledWith(0.9, 0, 0, 0.9, 183.2, 0);
    controller.dispose();
    vi.useRealTimers();
  });

  it('keeps Ink aligned when iPad WebKit reports an unzoomed layout rect after CSS zoom', async () => {
    vi.useFakeTimers();
    const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
    const transformSpies = new WeakMap<HTMLCanvasElement, ReturnType<typeof vi.fn>>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing;
      const transformSpy = vi.fn();
      const created = contextFixture(vi.fn(), vi.fn(), transformSpy);
      contexts.set(this, created);
      transformSpies.set(this, transformSpy);
      return created;
    });
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 700 },
      clientWidth: { configurable: true, value: 1_280 },
      offsetWidth: { configurable: true, value: 1_280 },
    });
    Object.defineProperty(layoutRoot, 'offsetWidth', { configurable: true, value: 704 });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1_280, 700));
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockImplementation(() => {
      const scale = Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')) || 1;
      const visualLeft = (1_280 - 704 * scale) / 2;
      const visualTop = 120;
      // WebKit bug 77998: CSS zoom is rendered, but the returned rect keeps the unzoomed size and
      // divides its viewport position by the zoom factor.
      return rect(visualLeft / scale, visualTop / scale, 704, 1_200);
    });
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session,
    });
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    if (committed === null) throw new Error('Missing committed Canvas.');
    const transformSpy = transformSpies.get(committed);
    if (transformSpy === undefined) throw new Error('Missing committed transform spy.');

    controller.enter();
    for (let step = 0; step < 4; step += 1) {
      root.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-out]')?.click();
    }
    const visualDocumentLeft = (1_280 - 704 * 0.6) / 2;
    root.dispatchEvent(pointer('pointerdown', visualDocumentLeft + 60, 180));
    root.dispatchEvent(pointer('pointerup', visualDocumentLeft + 60, 180));
    await vi.runAllTimersAsync();

    expect(transformSpy).toHaveBeenLastCalledWith(0.6, 0, 0, 0.6, visualDocumentLeft, 120);
    expect(session.strokes.at(-1)?.points[0]?.x).toBeCloseTo(100);
    expect(session.strokes.at(-1)?.points[0]?.y).toBeCloseTo(100);
    controller.dispose();
    vi.useRealTimers();
  });

  it('measures actual scale even when no explicit scroll container is available', () => {
    const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
    const transformSpies = new WeakMap<HTMLCanvasElement, ReturnType<typeof vi.fn>>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing;
      const transformSpy = vi.fn();
      const created = contextFixture(vi.fn(), vi.fn(), transformSpy);
      contexts.set(this, created);
      transformSpies.set(this, transformSpy);
      return created;
    });
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { value: 600 },
      clientWidth: { value: 360 },
    });
    Object.defineProperty(layoutRoot, 'offsetWidth', { value: 720 });
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockReturnValue(rect(100, 20, 360, 600));
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      session: new FakeSession(surface([stroke('saved')])),
    });
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    if (committed === null) throw new Error('Missing committed Canvas.');
    const transformSpy = transformSpies.get(committed);
    if (transformSpy === undefined) throw new Error('Missing committed transform spy.');

    controller.enter();

    expect(transformSpy).toHaveBeenLastCalledWith(0.5, 0, 0, 0.5, 0, 0);
    controller.dispose();
  });

  it('measures actual scale from the unzoomed layout border box instead of assuming 704', () => {
    const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
    const transformSpies = new WeakMap<HTMLCanvasElement, ReturnType<typeof vi.fn>>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing;
      const transformSpy = vi.fn();
      const created = contextFixture(vi.fn(), vi.fn(), transformSpy);
      contexts.set(this, created);
      transformSpies.set(this, transformSpy);
      return created;
    });
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { value: 600 },
      clientWidth: { value: 1_000 },
    });
    Object.defineProperty(layoutRoot, 'offsetWidth', { value: 720 });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1_000, 600));
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockReturnValue(rect(320, 0, 360, 600));
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session: new FakeSession(surface([stroke('saved')])),
    });
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    if (committed === null) throw new Error('Missing committed Canvas.');
    const transformSpy = transformSpies.get(committed);
    if (transformSpy === undefined) throw new Error('Missing committed transform spy.');

    controller.enter();

    expect(transformSpy).toHaveBeenLastCalledWith(0.5, 0, 0, 0.5, 320, 0);
    controller.dispose();
  });

  it('scales the accepted 100% document-origin inset instead of keeping it in client pixels', async () => {
    vi.useFakeTimers();
    const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
    const transformSpies = new WeakMap<HTMLCanvasElement, ReturnType<typeof vi.fn>>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing;
      const transformSpy = vi.fn();
      const created = contextFixture(vi.fn(), vi.fn(), transformSpy);
      contexts.set(this, created);
      transformSpies.set(this, transformSpy);
      return created;
    });
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 744 },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === root) return rect(100, 100, 744, 600);
      if (this === layoutRoot) {
        const scale = Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')) || 1;
        return rect(100 + (744 - 704 * scale) / 2, 132, 704 * scale, 1_200 * scale);
      }
      if (this.classList.contains('inkstone-ink-surface')) {
        return rect(
          100 + (Number.parseFloat(this.style.left) || 0),
          60 + (Number.parseFloat(this.style.top) || 0),
          Number.parseFloat(this.style.width) || 744,
          Number.parseFloat(this.style.height) || 600,
        );
      }
      return rect(0, 0, 0, 0);
    });
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session: new FakeSession(surface([stroke('saved')])),
    });
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    if (committed === null) throw new Error('Missing committed Canvas.');
    const transformSpy = transformSpies.get(committed);
    if (transformSpy === undefined) throw new Error('Missing committed transform spy.');

    controller.enter();
    for (let index = 0; index < 5; index += 1) {
      root.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-out]')?.click();
    }
    await vi.runAllTimersAsync();

    expect(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')).toBe('0.5');
    expect(transformSpy).toHaveBeenCalledWith(0.5, 0, 0, 0.5, 196, 12);
    expect(root.querySelector<HTMLElement>('.inkstone-ink-surface')?.style.top).toBe('40px');
    controller.dispose();
    vi.useRealTimers();
  });

  it('normalizes a compatibility inset recaptured after a 50% Reading View host replacement', async () => {
    vi.useFakeTimers();
    const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
    const transformSpies = new WeakMap<HTMLCanvasElement, ReturnType<typeof vi.fn>>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing;
      const transformSpy = vi.fn();
      const created = contextFixture(vi.fn(), vi.fn(), transformSpy);
      contexts.set(this, created);
      transformSpies.set(this, transformSpy);
      return created;
    });
    const firstHost = document.createElement('div');
    const firstLayout = document.createElement('div');
    const replacementHost = document.createElement('div');
    const replacementLayout = document.createElement('div');
    firstHost.append(firstLayout);
    replacementHost.append(replacementLayout);
    document.body.append(firstHost, replacementHost);
    for (const host of [firstHost, replacementHost]) {
      Object.defineProperties(host, {
        clientHeight: { value: 600 },
        clientWidth: { value: 744 },
      });
    }
    for (const layout of [firstLayout, replacementLayout]) {
      Object.defineProperty(layout, 'offsetWidth', { value: 704 });
    }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === firstHost || this === replacementHost) return rect(100, 100, 744, 600);
      if (this === firstLayout || this === replacementLayout) {
        const scale = Number(this.style.getPropertyValue('--inkstone-ink-scale')) || 1;
        return rect(100 + (744 - 704 * scale) / 2, 132, 704 * scale, 1_200 * scale);
      }
      if (this.classList.contains('inkstone-ink-surface')) {
        const left = Number.parseFloat(this.style.left) || 0;
        const top = Number.parseFloat(this.style.top) || 0;
        const width = Number.parseFloat(this.style.width) || 744;
        const height = Number.parseFloat(this.style.height) || 600;
        return this.parentElement === replacementHost
          ? rect(100 + left * 0.5, 80 + top * 0.5, width * 0.5, height * 0.5)
          : rect(100 + left, 60 + top, width, height);
      }
      if (this instanceof HTMLCanvasElement) {
        return this.parentElement?.getBoundingClientRect() ?? rect(0, 0, 0, 0);
      }
      return rect(0, 0, 0, 0);
    });
    const controller = new InkCanvasController({
      document,
      layoutRoot: firstLayout,
      root: firstHost,
      scrollContainer: firstHost,
      session: new FakeSession(surface([stroke('saved')])),
    });
    const committed = firstHost.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    if (committed === null) throw new Error('Missing committed Canvas.');
    const transformSpy = transformSpies.get(committed);
    if (transformSpy === undefined) throw new Error('Missing committed transform spy.');
    controller.enter();
    for (let index = 0; index < 5; index += 1) {
      firstHost.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-out]')?.click();
    }
    await vi.runAllTimersAsync();
    expect(transformSpy.mock.calls.filter(([scale]) => scale === 0.5).at(-1)).toEqual([
      0.5, 0, 0, 0.5, 196, 12,
    ]);

    controller.reattach(replacementLayout, replacementHost, replacementHost);

    expect(transformSpy.mock.calls.filter(([scale]) => scale === 0.5).at(-1)).toEqual([
      0.5, 0, 0, 0.5, 196, 12,
    ]);
    controller.dispose();
    vi.useRealTimers();
  });

  it('calibrates a hidden narrow pane against the overlay containing-block scale', () => {
    const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
    const transformSpies = new WeakMap<HTMLCanvasElement, ReturnType<typeof vi.fn>>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing;
      const transformSpy = vi.fn();
      const created = contextFixture(vi.fn(), vi.fn(), transformSpy);
      contexts.set(this, created);
      transformSpies.set(this, transformSpy);
      return created;
    });
    let visible = false;
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, get: () => (visible ? 600 : 0) },
      clientWidth: { configurable: true, get: () => (visible ? 372 : 0) },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (!visible) return rect(0, 0, 0, 0);
      if (this === root) return rect(100, 100, 372, 600);
      if (this === layoutRoot) {
        const scale = Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')) || 1;
        return rect(100 + (372 - 704 * scale) / 2, 132, 704 * scale, 1_200 * scale);
      }
      if (this.classList.contains('inkstone-ink-surface')) {
        return rect(
          100 + (Number.parseFloat(this.style.left) || 0),
          60 + (Number.parseFloat(this.style.top) || 0),
          Number.parseFloat(this.style.width) || 744,
          Number.parseFloat(this.style.height) || 600,
        );
      }
      return rect(0, 0, 0, 0);
    });
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session: new FakeSession(surface([stroke('saved')])),
    });
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    if (committed === null) throw new Error('Missing committed Canvas.');
    const transformSpy = transformSpies.get(committed);
    if (transformSpy === undefined) throw new Error('Missing committed transform spy.');

    visible = true;
    controller.enter();

    expect(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')).toBe('0.5');
    expect(transformSpy).toHaveBeenCalledWith(0.5, 0, 0, 0.5, 10, 12);
    controller.dispose();
  });

  it('restores and calibrates overlay geometry when a hidden preview pane becomes visible', () => {
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        disconnect(): void {}
        observe(): void {}
      },
    );
    let visible = false;
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, get: () => (visible ? 600 : 0) },
      clientWidth: { configurable: true, get: () => (visible ? 744 : 0) },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (!visible) return rect(0, 0, 0, 0);
      if (this === root) return rect(100, 100, 744, 600);
      if (this === layoutRoot) return rect(120, 132, 704, 1_200);
      if (this.classList.contains('inkstone-ink-surface')) {
        return rect(
          100 + (Number.parseFloat(this.style.left) || 0),
          60 + (Number.parseFloat(this.style.top) || 0),
          Number.parseFloat(this.style.width) || 744,
          Number.parseFloat(this.style.height) || 600,
        );
      }
      if (this instanceof HTMLCanvasElement) {
        return this.parentElement?.getBoundingClientRect() ?? rect(0, 0, 0, 0);
      }
      return rect(0, 0, 0, 0);
    });
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session: new FakeSession(surface([stroke('saved')])),
    });
    const overlay = root.querySelector<HTMLElement>('.inkstone-ink-surface');
    if (overlay === null) throw new Error('Missing Ink overlay.');
    controller.showPreview();

    visible = true;
    resize?.([], {} as ResizeObserver);

    expect(overlay.getBoundingClientRect()).toMatchObject({
      height: 600,
      left: 100,
      top: 100,
      width: 744,
    });
    controller.dispose();
  });

  it('calibrates a transformed fixed containing block before publishing the measured Canvas rect', () => {
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 744 },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === root) return rect(100, 100, 744, 600);
      if (this === layoutRoot) return rect(120, 132, 704, 1_200);
      if (this.classList.contains('inkstone-ink-surface')) {
        return rect(
          80 + (Number.parseFloat(this.style.left) || 0) * 0.8,
          60 + (Number.parseFloat(this.style.top) || 0) * 0.8,
          (Number.parseFloat(this.style.width) || 744) * 0.8,
          (Number.parseFloat(this.style.height) || 600) * 0.8,
        );
      }
      if (this instanceof HTMLCanvasElement) {
        return this.parentElement?.getBoundingClientRect() ?? rect(0, 0, 0, 0);
      }
      return rect(0, 0, 0, 0);
    });
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session: new FakeSession(surface([stroke('saved')])),
    });
    const overlay = root.querySelector<HTMLElement>('.inkstone-ink-surface');
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    if (overlay === null || committed === null) throw new Error('Missing Ink renderer.');

    controller.enter();

    expect(overlay.getBoundingClientRect()).toMatchObject({
      height: 600,
      left: 100,
      top: 100,
      width: 744,
    });
    expect(committed.getBoundingClientRect()).toMatchObject({
      height: 600,
      left: 100,
      top: 100,
      width: 744,
    });
    expect(committed.width).toBe(744);
    expect(committed.height).toBe(600);
    controller.dispose();
  });

  it('maps drawing input to the visually centered document after zoom', () => {
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 1_000 },
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1_000, 600));
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockImplementation(() => {
      const scale = Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')) || 1;
      return rect((1_000 - 704 * scale) / 2, 0, 704 * scale, 1_200 * scale);
    });
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session,
    });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active Canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1_000, 600));

    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-out]')?.click();
    const visualDocumentLeft = (1_000 - 704 * 0.9) / 2;
    root.dispatchEvent(pointer('pointerdown', visualDocumentLeft + 90, 100));
    root.dispatchEvent(pointer('pointerup', visualDocumentLeft + 90, 100));

    expect(session.strokes.at(-1)?.points[0]?.x).toBeCloseTo(100);
    controller.dispose();
  });

  it('classifies closure in CSS space while sending logical loop points at 50% zoom', () => {
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 1_000 },
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1_000, 600));
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockImplementation(() => {
      const scale = Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')) || 1;
      return rect((1_000 - 704 * scale) / 2, 0, 704 * scale, 1_200 * scale);
    });
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session,
    });
    controller.enter();
    for (let step = 0; step < 5; step += 1) {
      root.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-out]')?.click();
    }
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();
    const documentLeft = (1_000 - 704 * 0.5) / 2;

    root.dispatchEvent(pointer('pointerdown', documentLeft + 10, 10));
    root.dispatchEvent(pointer('pointermove', documentLeft + 110, 10));
    root.dispatchEvent(pointer('pointermove', documentLeft + 110, 110));
    root.dispatchEvent(pointer('pointermove', documentLeft + 10, 110));
    root.dispatchEvent(pointer('pointerup', documentLeft + 10, 10));

    const loop = session.erasePolygonCalls[0];
    expect(loop).toBeDefined();
    expect((loop?.[1]?.x ?? 0) - (loop?.[0]?.x ?? 0)).toBeCloseTo(200);
    expect((loop?.[2]?.y ?? 0) - (loop?.[1]?.y ?? 0)).toBeCloseTo(200);
    controller.dispose();
  });

  it('captures Ink in visible pane whitespace using document-relative coordinates', () => {
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 744 },
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 744, 600));
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockReturnValue(rect(20, 0, 704, 1_200));
    const base = surface();
    const session = new FakeSession({
      ...base,
      layout: { ...base.layout, logicalWidth: 704 },
    });
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session,
    });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const overlay = root.querySelector<HTMLElement>('[data-inkstone-ink-surface]');
    if (active === null || overlay === null) throw new Error('Missing pane-wide Ink canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 744, 600));

    controller.enter();
    root.dispatchEvent(pointer('pointerdown', 10, 20));
    root.dispatchEvent(pointer('pointermove', 5, 30));
    root.dispatchEvent(pointer('pointerup', 0, 40));

    expect(overlay.style.width).toBe('744px');
    expect(session.strokes[0]?.points.some((point) => point.x < 0)).toBe(true);
    controller.dispose();
  });

  it('observes the pane and recomputes fit zoom when a sidebar resize narrows it', () => {
    let resize: ResizeObserverCallback | undefined;
    const observed = new Set<Element>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        disconnect() {}
        observe(target: Element) {
          observed.add(target);
        }
      },
    );
    let paneWidth = 744;
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, get: () => paneWidth },
    });
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => rect(0, 0, paneWidth, 600));
    const base = surface();
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session: new FakeSession({
        ...base,
        layout: { ...base.layout, logicalWidth: 704 },
      }),
    });

    controller.enter();
    expect(observed.has(root)).toBe(true);
    expect(Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale'))).toBe(1);

    paneWidth = 500;
    resize?.([], {} as ResizeObserver);

    expect(Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale'))).toBeCloseTo(
      460 / 704,
    );
    controller.dispose();
  });

  it('coalesces equivalent ResizeObserver callbacks without redrawing visible history', () => {
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        disconnect() {}
        observe() {}
      },
    );
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 744 },
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 744, 600));
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockReturnValue(rect(20, 32, 704, 1_200));
    const diagnostics = new InkPerformanceDiagnostics(true);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      layoutRoot,
      root,
      scrollContainer: root,
      session: new FakeSession(
        surface(Array.from({ length: 176 }, (_value, index) => stroke(`history-${String(index)}`))),
      ),
    });
    controller.enter();
    diagnostics.reset();

    for (let index = 0; index < 7; index += 1) {
      resize?.([], {} as ResizeObserver);
    }

    expect(
      diagnostics.snapshot().recentSpans.filter(({ name }) => name === 'ink-viewport-redraw'),
    ).toEqual([]);
    controller.dispose();
  });

  it('publishes one resized frame whose pointer inverse stays locked to the Markdown landmark', () => {
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        disconnect() {}
        observe() {}
      },
    );
    let paneWidth = 744;
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, get: () => paneWidth },
    });
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() =>
      rect(100, 100, paneWidth, 600),
    );
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockImplementation(() => {
      const scale = Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')) || 1;
      return rect(100 + (paneWidth - 704 * scale) / 2, 132, 704 * scale, 1_200 * scale);
    });
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session,
    });
    controller.enter();

    paneWidth = 500;
    resize?.([], {} as ResizeObserver);
    const scale = 460 / 704;
    const landmarkClientX = 120 + 100 * scale;
    root.dispatchEvent(pointer('pointerdown', landmarkClientX, 200));
    root.dispatchEvent(pointer('pointerup', landmarkClientX, 200));

    expect(Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale'))).toBeCloseTo(scale);
    expect(session.strokes.at(-1)?.points[0]?.x).toBeCloseTo(100);
    controller.dispose();
  });

  it('freezes the contact coordinate frame when native scrolling changes the viewport mid-stroke', () => {
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 704 },
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 600));
    let documentTop = 0;
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockImplementation(() =>
      rect(0, documentTop, 704, 1_200),
    );
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session,
    });
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    documentTop = -100;
    root.dispatchEvent(new Event('scroll'));
    root.dispatchEvent(pointer('pointermove', 20, 30, 'pen'));
    root.dispatchEvent(pointer('pointerup', 30, 40, 'pen'));

    const points = session.strokes.at(-1)?.points ?? [];
    expect(
      Math.max(...points.map(({ y }) => y)) - Math.min(...points.map(({ y }) => y)),
    ).toBeLessThan(30);
    controller.dispose();
  });

  it('uses compositor projection during scroll and rebuilds the viewport once after settling', async () => {
    vi.useFakeTimers();
    try {
      const root = document.createElement('div');
      const layoutRoot = document.createElement('div');
      root.append(layoutRoot);
      document.body.append(root);
      Object.defineProperties(root, {
        clientHeight: { configurable: true, value: 600 },
        clientWidth: { configurable: true, value: 704 },
      });
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 600));
      let documentTop = 0;
      vi.spyOn(layoutRoot, 'getBoundingClientRect').mockImplementation(() =>
        rect(0, documentTop, 704, 1_200),
      );
      const session = new FakeSession(surface([stroke('scroll-history')]));
      const query = vi.spyOn(session, 'query');
      const controller = new InkCanvasController({
        document,
        layoutRoot,
        root,
        scrollContainer: root,
        session,
      });
      controller.enter();
      await vi.runAllTimersAsync();
      query.mockClear();
      const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
      if (committed === null) throw new Error('Missing committed Canvas.');

      documentTop = -80;
      root.dispatchEvent(new Event('scroll'));

      expect(query).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(16);
      expect(committed.style.transform).toContain('matrix');
      expect(query).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      expect(query).toHaveBeenCalled();
      expect(committed.style.transform).toBe('');
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces scroll and repeated zoom previews into one settled viewport rebuild', async () => {
    vi.useFakeTimers();
    try {
      const root = document.createElement('div');
      const layoutRoot = document.createElement('div');
      root.append(layoutRoot);
      document.body.append(root);
      Object.defineProperties(root, {
        clientHeight: { configurable: true, value: 600 },
        clientWidth: { configurable: true, value: 704 },
      });
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 600));
      let documentTop = 0;
      vi.spyOn(layoutRoot, 'getBoundingClientRect').mockImplementation(() =>
        rect(0, documentTop, 704, 1_200),
      );
      const session = new FakeSession(surface([stroke('viewport-history')]));
      const query = vi.spyOn(session, 'query');
      const controller = new InkCanvasController({
        document,
        layoutRoot,
        root,
        scrollContainer: root,
        session,
      });
      controller.enter();
      await vi.runAllTimersAsync();
      query.mockClear();

      documentTop = -80;
      root.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(100);
      for (let count = 0; count < 4; count += 1) {
        root.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-in]')?.click();
      }

      expect(query).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(query).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(query).toHaveBeenCalledTimes(1);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fits inside the pane content box without creating horizontal overflow', () => {
    const root = document.createElement('div');
    root.style.paddingLeft = '32px';
    root.style.paddingRight = '32px';
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 746 },
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 761, 600));
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session: new FakeSession(surface()),
    });

    controller.enter();

    expect(Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale'))).toBeCloseTo(
      (746 - 64) / 704,
    );
    controller.dispose();
  });

  it('anchors the pane-wide Canvas while Markdown remains centered inside it', () => {
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    layoutRoot.style.paddingInlineStart = '40px';
    root.append(layoutRoot);
    document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(100, 20, 1_000, 800));
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockReturnValue(rect(200, 70, 593, 1_200));
    root.scrollLeft = 0.5;
    root.scrollTop = 120;
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root,
      scrollContainer: root,
      session: new FakeSession(surface()),
    });
    const overlay = root.querySelector<HTMLElement>('[data-inkstone-ink-surface]');

    controller.showPreview();

    expect(overlay?.style.left).toBe('0px');
    expect(overlay?.style.top).toBe('0px');
    expect(overlay?.style.width).toBe('1000px');
    controller.dispose();
  });

  it('resizes the continuous overlay when the live document extent grows', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    const overlay = root.querySelector<HTMLElement>('.inkstone-ink-surface');
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    if (overlay === null || committed === null) throw new Error('Missing Ink canvas.');
    controller.enter();

    session.setLogicalHeight(1_600);
    controller.sync(session.read());

    expect(overlay.style.height).toBe('1600px');
    expect(committed.style.height).toBe('100%');
    expect(root.style.getPropertyValue('--inkstone-ink-logical-height')).toBe('1600px');
  });

  it('preserves the nearest relative reading context across fixed-width reflow', async () => {
    const scrollContainer = document.createElement('div');
    const layoutRoot = document.createElement('div');
    scrollContainer.append(layoutRoot);
    document.body.append(scrollContainer);
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: {
        configurable: true,
        get: () => (layoutRoot.classList.contains('inkstone-ink-workspace') ? 2_000 : 1_000),
      },
    });
    scrollContainer.scrollTop = 450;
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root: scrollContainer,
      scrollContainer,
      session: new FakeSession(surface()),
    });

    controller.enter();
    expect(scrollContainer.scrollTop).toBe(950);
    await controller.exit();
    expect(scrollContainer.scrollTop).toBe(450);
  });

  it('never lets a deferred reflow restore overwrite newer native navigation', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame));
    const scrollContainer = document.createElement('div');
    const layoutRoot = document.createElement('div');
    scrollContainer.append(layoutRoot);
    document.body.append(scrollContainer);
    Object.defineProperties(scrollContainer, {
      clientHeight: { value: 100 },
      scrollHeight: {
        get: () => (layoutRoot.classList.contains('inkstone-ink-workspace') ? 2_000 : 1_000),
      },
    });
    scrollContainer.scrollTop = 450;
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root: scrollContainer,
      scrollContainer,
      session: new FakeSession(surface()),
    });

    controller.enter();
    expect(scrollContainer.scrollTop).toBe(950);
    scrollContainer.scrollTop = 1_200;
    scrollContainer.dispatchEvent(new Event('scroll'));
    for (const callback of [...frames.values()]) callback(performance.now());

    expect(scrollContainer.scrollTop).toBe(1_200);
    controller.dispose();
  });

  it('reports pointer-to-Canvas-submission latency without exposing stroke points', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    let now = 100;
    const samples: number[] = [];
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      now: () => now,
      recordInputToPaint: (durationMs) => samples.push(durationMs),
      root,
      session: new FakeSession(surface()),
    });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20));
    expect(frames).toHaveLength(1);
    now = 108;
    frames.shift()?.(now);
    expect(samples).toEqual([8]);
    expect(frames).toHaveLength(0);
  });

  it('measures accepted input from the first listener line', () => {
    let now = 100;
    const diagnostics = new InkPerformanceDiagnostics(true, () => now);
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      root,
      session,
    });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();

    const down = pointer('pointerdown', 10, 20, 'pen', 'all', () => {
      now += 3;
    });
    root.dispatchEvent(down);

    expect(diagnostics.snapshot().recentSpans).toContainEqual({
      accepted: true,
      adapter: 'pointer',
      contactSequence: 1,
      durationMs: 3,
      inputPhase: 'down',
      name: 'ink-input-handler',
      sampleCountBucket: '1',
      workPhase: 'input',
    });
    controller.dispose();
  });

  it('does not allocate a diagnostics contact while Ink diagnostics are disabled', () => {
    const diagnostics = new InkPerformanceDiagnostics(false);
    const beginSpan = vi.spyOn(diagnostics, 'beginSpan');
    const openContact = vi.spyOn(diagnostics, 'openContact');
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    root.dispatchEvent(pointer('pointerup', 20, 30, 'pen'));

    expect(beginSpan).not.toHaveBeenCalled();
    expect(openContact).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('does not resume diagnostics inside a contact whose recorder epoch was reset', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const diagnostics = new InkPerformanceDiagnostics(true);
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    frames.shift()?.(16.7);
    diagnostics.setEnabled(false);
    diagnostics.setEnabled(true);
    root.dispatchEvent(pointer('pointermove', 20, 30, 'pen'));
    frames.shift()?.(33.4);
    root.dispatchEvent(pointer('pointerup', 30, 40, 'pen'));

    expect(diagnostics.snapshot()).toMatchObject({
      frameIntervalsMs: { activeWriting: [], idle: [] },
      hangingSpanCount: 0,
      openContactCount: 0,
      recentSpans: [],
    });
    controller.dispose();
  });

  it('correlates input, frame, Canvas submission, and commit for one contact', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame));
    let now = 100;
    const diagnostics = new InkPerformanceDiagnostics(true, () => now);
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      root,
      session: new FakeSession(surface()),
    });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    now = 108;
    frames.get(1)?.(now);
    now = 112;
    root.dispatchEvent(pointer('pointerup', 20, 30, 'pen'));
    controller.dispose();

    const snapshot = diagnostics.snapshot();
    expect(
      snapshot.recentSpans
        .filter(({ contactSequence }) => contactSequence === 1)
        .map(({ name }) => name),
    ).toEqual([
      'ink-input-handler',
      'ink-frame-work',
      'ink-input-to-submit',
      'ink-stroke-commit',
      'ink-input-handler',
    ]);
    expect(snapshot.hangingSpanCount).toBe(0);
    expect(snapshot.openContactCount).toBe(0);
    expect(snapshot.recentSpans.find(({ name }) => name === 'ink-stroke-commit')).toMatchObject({
      documentCommandProduced: true,
    });
  });

  it('keeps a physical down span owned when optional pointer capture throws', () => {
    const canvasContext = contextFixture();
    canvasContext.closePath = vi.fn();
    canvasContext.fill = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const diagnostics = new InkPerformanceDiagnostics(true);
    const source: InkSurfaceRecord = {
      ...surface([]),
      layout: { ...surface().layout, originY: 0 },
      schemaVersion: 3,
    };
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      surfaces: [source],
      writer: { updateSurface: (record) => Promise.resolve(record) },
    });
    const root = document.createElement('div');
    Object.defineProperty(root, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(() => {
        throw new DOMException('No active pointer.', 'NotFoundError');
      }),
    });
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      preference: { color: '#112233', hintShown: true, tool: 'pen', width: 4 },
      root,
      session,
      unpublishedPhysicalInkHat: { session },
    });
    controller.enter();
    for (let remaining = 8; frames.length > 0 && remaining > 0; remaining -= 1) {
      frames.shift()?.(16.7);
    }
    diagnostics.reset();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    frames.shift()?.(33.4);

    const snapshot = diagnostics.snapshot();
    expect(snapshot.recentSpans).toContainEqual(
      expect.objectContaining({
        adapter: 'pointer',
        inputPhase: 'down',
        name: 'ink-input-to-submit',
        presentationOutcome: 'submitted',
        sampleCountBucket: '1',
      }),
    );
    expect(snapshot.hangingSpanCount).toBe(0);
    controller.dispose();
  });

  it('settles multiple accepted batches in one presentation frame exactly once', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const diagnostics = new InkPerformanceDiagnostics(true);
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      root,
      session: new FakeSession(surface()),
    });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    root.dispatchEvent(pointer('pointermove', 20, 30, 'pen'));
    root.dispatchEvent(pointer('pointermove', 30, 40, 'pen'));
    expect(frames).toHaveLength(1);
    const submittedFrame = frames.shift();
    submittedFrame?.(16.7);
    submittedFrame?.(33.4);

    expect(
      diagnostics
        .snapshot()
        .recentSpans.filter(({ accepted, name }) => accepted && name === 'ink-input-to-submit'),
    ).toEqual([
      expect.objectContaining({
        batchSequence: 1,
        requestedGeneration: 1,
        submittedGeneration: 1,
      }),
      expect.objectContaining({
        batchSequence: 2,
        requestedGeneration: 1,
        submittedGeneration: 1,
      }),
      expect.objectContaining({
        batchSequence: 3,
        requestedGeneration: 1,
        submittedGeneration: 1,
      }),
    ]);
    controller.dispose();
  });

  it('marks an eraser contact that changes no stroke as not producing a document command', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10, 'pen'));
    root.dispatchEvent(pointer('pointerup', 12, 12, 'pen'));

    expect(
      diagnostics.snapshot().recentSpans.find(({ name }) => name === 'ink-stroke-commit'),
    ).toMatchObject({ documentCommandProduced: false });
    controller.dispose();
  });

  it('does not attribute an ended contact to the active render generation of the next contact', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame));
    let now = 100;
    const diagnostics = new InkPerformanceDiagnostics(true, () => now);
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      root,
      session: new FakeSession(surface([stroke('saved')])),
    });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10, 'pen'));
    root.dispatchEvent(pointer('pointerup', 12, 12, 'pen'));
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="pen"]')?.click();
    root.dispatchEvent(pointer('pointerdown', 20, 20, 'pen'));
    now = 108;
    frames.values().next().value?.(now);

    expect(
      diagnostics
        .snapshot()
        .recentSpans.filter(({ name }) => name === 'ink-input-to-submit')
        .map(
          ({
            accepted,
            batchSequence,
            contactSequence,
            presentationOutcome,
            requestedGeneration,
            submittedGeneration,
          }) => ({
            accepted,
            batchSequence,
            contactSequence,
            presentationOutcome,
            requestedGeneration,
            submittedGeneration,
          }),
        ),
    ).toEqual([
      {
        accepted: false,
        batchSequence: 1,
        contactSequence: 1,
        presentationOutcome: 'cancelled',
        requestedGeneration: 1,
        submittedGeneration: null,
      },
      {
        accepted: true,
        batchSequence: 1,
        contactSequence: 2,
        presentationOutcome: 'submitted',
        requestedGeneration: 2,
        submittedGeneration: 2,
      },
    ]);
    controller.dispose();
  });

  it('classifies a context-lost Presentation Frame Generation as unpresented', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const diagnostics = new InkPerformanceDiagnostics(true);
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    root
      .querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]')
      ?.dispatchEvent(new Event('contextlost', { cancelable: true }));
    frames.shift()?.(16.7);

    expect(
      diagnostics.snapshot().recentSpans.filter(({ name }) => name === 'ink-input-to-submit'),
    ).toEqual([
      expect.objectContaining({
        accepted: false,
        batchSequence: 1,
        presentationOutcome: 'unpresented',
        requestedGeneration: 1,
        submittedGeneration: null,
      }),
    ]);
    controller.dispose();
  });

  it('classifies pending ownership as unpresented when the controller unloads', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    const diagnostics = new InkPerformanceDiagnostics(true);
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    controller.dispose();

    expect(
      diagnostics.snapshot().recentSpans.find(({ name }) => name === 'ink-input-to-submit'),
    ).toEqual(
      expect.objectContaining({
        accepted: false,
        presentationOutcome: 'unpresented',
        submittedGeneration: null,
      }),
    );
  });

  it('classifies pending ownership as unpresented when Obsidian replaces the host', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    const diagnostics = new InkPerformanceDiagnostics(true);
    const root = document.createElement('div');
    const replacement = document.createElement('div');
    document.body.append(root, replacement);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      layoutRoot: root,
      root,
      scrollContainer: root,
      session: new FakeSession(surface()),
    });
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    controller.reattach(replacement, replacement, replacement);

    expect(
      diagnostics.snapshot().recentSpans.find(({ name }) => name === 'ink-input-to-submit'),
    ).toEqual(
      expect.objectContaining({
        accepted: false,
        presentationOutcome: 'unpresented',
        submittedGeneration: null,
      }),
    );
    controller.dispose();
  });

  it('uses the same listener-first spans for the stylus Touch adapter', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();

    root.dispatchEvent(touch('touchstart', 10, 20, 'stylus'));
    root.dispatchEvent(touch('touchmove', 20, 30, 'stylus'));
    root.dispatchEvent(touch('touchend', 30, 40, 'stylus'));
    controller.dispose();

    const snapshot = diagnostics.snapshot();
    expect(
      snapshot.recentSpans
        .filter(
          ({ accepted, adapter, name }) =>
            accepted && adapter === 'stylus-touch' && name === 'ink-input-handler',
        )
        .map(({ inputPhase }) => inputPhase),
    ).toEqual(['down', 'move', 'up']);
    expect(snapshot.recentSpans).toContainEqual(
      expect.objectContaining({
        adapter: 'stylus-touch',
        contactSequence: 1,
        name: 'ink-stroke-commit',
      }),
    );
    expect(snapshot.hangingSpanCount).toBe(0);
    expect(snapshot.openContactCount).toBe(0);
  });

  it('keeps the accepted input path free of cold document snapshots', () => {
    const measurements = [0, 10_000].map((historyCount) => {
      const diagnostics = new InkPerformanceDiagnostics(true);
      const root = document.createElement('div');
      document.body.append(root);
      const session = new FakeSession(
        surface(
          Array.from({ length: historyCount }, (_value, index) => stroke(`history-${index}`)),
        ),
      );
      const controller = new InkCanvasController({
        document,
        inkPerformance: diagnostics,
        root,
        session,
      });
      controller.enter();
      const read = vi.spyOn(session, 'read');
      const query = vi.spyOn(session, 'query');
      const snapshot = vi.spyOn(session, 'snapshot');
      const measure = vi.spyOn(root, 'getBoundingClientRect');

      root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
      read.mockClear();
      query.mockClear();
      snapshot.mockClear();
      measure.mockClear();
      for (let index = 0; index < 100; index += 1) {
        root.dispatchEvent(pointer('pointermove', 20 + index, 30 + index, 'pen'));
      }

      expect(diagnostics.snapshot().forbiddenWork).toEqual([]);
      const measurement = {
        apply: session.applyCalls,
        domMeasurements: measure.mock.calls.length,
        queries: query.mock.calls.length,
        reads: read.mock.calls.length,
        snapshots: snapshot.mock.calls.length,
      };
      controller.dispose();
      return measurement;
    });

    expect(measurements).toEqual([
      { apply: 0, domMeasurements: 0, queries: 0, reads: 0, snapshots: 0 },
      { apply: 0, domMeasurements: 0, queries: 0, reads: 0, snapshots: 0 },
    ]);
  });

  it('commits a same-extent stroke without remeasuring the Stage Frame', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    const measure = vi.spyOn(root, 'getBoundingClientRect');
    measure.mockClear();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    root.dispatchEvent(pointer('pointermove', 20, 25, 'pen'));
    root.dispatchEvent(pointer('pointerup', 30, 30, 'pen'));

    expect(session.read().strokes).toHaveLength(1);
    expect(measure).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('measures viewport redraws with only a result count', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const root = document.createElement('div');
    document.body.append(root);

    const controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      root,
      session: new FakeSession(surface([stroke('visible')])),
    });

    expect(diagnostics.snapshot().recentSpans).toContainEqual(
      expect.objectContaining({
        name: 'ink-viewport-redraw',
        viewportResultCount: 1,
        workPhase: 'viewport',
      }),
    );
    expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/points|pressure|tilt|color/);
    expect(diagnostics.snapshot().memory.backingStoreBytes).toBeGreaterThan(0);
    expect(diagnostics.snapshot().memory.disposableCacheBytes).toBeGreaterThan(0);
    controller.dispose();
  });

  it('routes touch input to reading instead of starting a desktop stroke', () => {
    const root = document.createElement('div');
    const readingContent = document.createElement('p');
    root.append(readingContent);
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();
    const markdownPointerHandler = vi.fn();
    readingContent.addEventListener('pointerdown', markdownPointerHandler);

    const touchStart = pointer('pointerdown', 10, 20, 'touch');
    readingContent.dispatchEvent(touchStart);
    readingContent.dispatchEvent(pointer('pointerup', 20, 30, 'touch'));

    expect(session.strokes).toEqual([]);
    expect(touchStart.defaultPrevented).toBe(false);
    expect(markdownPointerHandler).not.toHaveBeenCalled();
  });

  it('draws Pencil input from the Reading View host while leaving finger input to scrolling', () => {
    const root = document.createElement('div');
    const readingContent = document.createElement('p');
    root.append(readingContent);
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();

    readingContent.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    readingContent.dispatchEvent(pointer('pointerup', 20, 30, 'pen'));
    const touchStart = pointer('pointerdown', 10, 20, 'touch');
    readingContent.dispatchEvent(touchStart);

    expect(session.strokes).toHaveLength(1);
    expect(touchStart.defaultPrevented).toBe(false);
    controller.dispose();
  });

  it('draws Apple Pencil from the WebKit stylus Touch fallback when Pointer Events report touch', () => {
    const root = document.createElement('div');
    const readingContent = document.createElement('p');
    root.append(readingContent);
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();

    readingContent.dispatchEvent(pointer('pointerdown', 10, 20, 'touch'));
    const stylusStart = touch('touchstart', 10, 20, 'stylus');
    readingContent.dispatchEvent(stylusStart);
    readingContent.dispatchEvent(touch('touchmove', 20, 30, 'stylus'));
    readingContent.dispatchEvent(touch('touchend', 30, 40, 'stylus'));

    expect(stylusStart.defaultPrevented).toBe(true);
    expect(session.strokes).toHaveLength(1);
    controller.dispose();
  });

  it('keeps direct WebKit finger touches uncancelled for native scrolling', () => {
    const root = document.createElement('div');
    const readingContent = document.createElement('p');
    root.append(readingContent);
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    const markdownTouchHandler = vi.fn();
    readingContent.addEventListener('touchstart', markdownTouchHandler);

    const fingerStart = touch('touchstart', 10, 20, 'direct');
    readingContent.dispatchEvent(fingerStart);
    readingContent.dispatchEvent(touch('touchmove', 10, 40, 'direct'));
    readingContent.dispatchEvent(touch('touchend', 10, 40, 'direct'));

    expect(fingerStart.defaultPrevented).toBe(false);
    expect(markdownTouchHandler).not.toHaveBeenCalled();
    expect(session.strokes).toEqual([]);
    controller.dispose();
  });

  it('does not duplicate a Pencil stroke when WebKit emits both Pointer and stylus Touch events', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    root.dispatchEvent(touch('touchstart', 10, 20, 'stylus'));
    root.dispatchEvent(pointer('pointermove', 20, 30, 'pen'));
    root.dispatchEvent(touch('touchmove', 20, 30, 'stylus'));
    root.dispatchEvent(pointer('pointerup', 30, 40, 'pen'));
    root.dispatchEvent(touch('touchend', 30, 40, 'stylus'));

    expect(session.strokes).toHaveLength(1);
    controller.dispose();
  });

  it('blocks Reading View double-click activation only during Ink edit without blocking touch scroll', async () => {
    const root = document.createElement('div');
    const readingContent = document.createElement('p');
    root.append(readingContent);
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      root,
      session: new FakeSession(surface()),
    });
    const editActivation = vi.fn();
    root.addEventListener('dblclick', editActivation);
    controller.enter();

    const touchStart = pointer('pointerdown', 10, 20, 'touch');
    readingContent.dispatchEvent(touchStart);
    const doubleClick = new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      detail: 2,
    });
    readingContent.dispatchEvent(doubleClick);

    expect(touchStart.defaultPrevented).toBe(false);
    expect(doubleClick.defaultPrevented).toBe(true);
    expect(editActivation).not.toHaveBeenCalled();

    await controller.exit('preview');
    const previewDoubleClick = new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      detail: 2,
    });
    readingContent.dispatchEvent(previewDoubleClick);
    expect(previewDoubleClick.defaultPrevented).toBe(false);
    expect(editActivation).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('blocks Reading View text selection only during Ink edit', async () => {
    const root = document.createElement('div');
    const readingContent = document.createElement('p');
    root.append(readingContent);
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();

    const editSelection = new Event('selectstart', {
      bubbles: true,
      cancelable: true,
    });
    readingContent.dispatchEvent(editSelection);
    expect(editSelection.defaultPrevented).toBe(true);

    await controller.exit('preview');
    const previewSelection = new Event('selectstart', {
      bubbles: true,
      cancelable: true,
    });
    readingContent.dispatchEvent(previewSelection);
    expect(previewSelection.defaultPrevented).toBe(false);
    controller.dispose();
  });

  it('allows the first Pencil click but blocks the second click that activates Markdown edit', () => {
    const root = document.createElement('div');
    const readingContent = document.createElement('p');
    root.append(readingContent);
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      root,
      session: new FakeSession(surface()),
    });
    const readingActivation = vi.fn();
    root.addEventListener('click', readingActivation);
    controller.enter();

    readingContent.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    readingContent.dispatchEvent(pointer('pointerup', 20, 30, 'pen'));
    const firstClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1,
    });
    readingContent.dispatchEvent(firstClick);
    const secondClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 2,
    });
    readingContent.dispatchEvent(secondClick);

    expect(firstClick.defaultPrevented).toBe(false);
    expect(secondClick.defaultPrevented).toBe(true);
    expect(readingActivation).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('switches pen/highlighter styles and exposes non-color active state', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const highlighter = root.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-tool="highlighter"]',
    );
    if (active === null || highlighter === null) throw new Error('Missing Ink controls.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();

    highlighter.click();
    root.dispatchEvent(pointer('pointerdown', 10, 20));
    root.dispatchEvent(pointer('pointerup', 30, 40));

    expect(highlighter.getAttribute('aria-pressed')).toBe('true');
    expect(session.strokes[0]).toMatchObject({ tool: 'highlighter', width: 12 });
    highlighter.click();
    expect(root.querySelector<HTMLInputElement>('[data-inkstone-ink-color]')?.hidden).toBe(true);
  });

  it('routes eraser hits and undo/redo controls through linked document commands', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();

    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();
    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointerup', 12, 12));
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-undo]')?.click();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-redo]')?.click();

    expect(session.eraseCalls).toBe(1);
    expect(session.undoCalls).toBe(1);
    expect(session.redoCalls).toBe(1);
  });

  it('presents linked document undo and redo without a full recovery rebuild', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      return {
        ...contextFixture(),
        canvas: this,
        drawImage: vi.fn(),
      };
    });
    const diagnostics = new InkPerformanceDiagnostics(true);
    const source: InkSurfaceRecord = {
      ...surface([v3LegacyStroke('history')]),
      layout: { ...surface().layout, originY: 0 },
      schemaVersion: 3,
    };
    let controller: InkCanvasController | null = null;
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      onChange: (read, change) => controller?.sync(read, change),
      surfaces: [source],
      writer: { updateSurface: (record) => Promise.resolve(record) },
    });
    session.enter();
    session.apply({ id: 'add-command-stroke', kind: 'add', stroke: v3LegacyStroke('command') });
    const root = document.createElement('div');
    document.body.append(root);
    controller = new InkCanvasController({
      document,
      inkPerformance: diagnostics,
      root,
      session,
      workScheduler: new InkWorkScheduler(),
    });
    controller.enter();
    await vi.waitFor(() =>
      expect(root.querySelector('[data-inkstone-committed-tile]:not([hidden])')).not.toBeNull(),
    );
    const visibleTiles = [
      ...root.querySelectorAll<HTMLCanvasElement>('[data-inkstone-committed-tile]:not([hidden])'),
    ];
    const recoveryRebuildsBeforeCommand = controller.renderRuntimeStats.visibleRecoveryRebuildCount;
    const rasterRebuildsBeforeCommand = controller.renderRuntimeStats.rasterTileRebuildCount;
    diagnostics.reset();

    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-undo]')?.click();
    expect(session.read().strokes.map(({ id }) => id)).toEqual(['history']);
    expect(controller.renderRuntimeStats.visibleRecoveryRebuildCount).toBe(
      recoveryRebuildsBeforeCommand,
    );
    expect(controller.renderRuntimeStats.rasterTileRebuildCount).toBe(rasterRebuildsBeforeCommand);
    expect(visibleTiles.every((tile) => tile.isConnected && !tile.hidden)).toBe(true);
    expect(root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]')?.hidden).toBe(
      true,
    );
    expect(
      diagnostics.snapshot().recentSpans.filter(({ name }) => name.startsWith('ink-command-')),
    ).toEqual([
      expect.objectContaining({ commandKind: 'undo', name: 'ink-command-apply' }),
      expect.objectContaining({
        commandKind: 'undo',
        name: 'ink-command-to-submit',
        presentationOutcome: 'submitted',
      }),
    ]);

    const redo = root.querySelector<HTMLButtonElement>('[data-inkstone-ink-redo]');
    await vi.waitFor(() => expect(redo?.disabled).toBe(false));
    diagnostics.reset();
    redo?.click();
    expect(session.read().strokes.map(({ id }) => id)).toEqual(['history', 'command']);
    expect(controller.renderRuntimeStats.visibleRecoveryRebuildCount).toBe(
      recoveryRebuildsBeforeCommand,
    );
    expect(controller.renderRuntimeStats.rasterTileRebuildCount).toBe(rasterRebuildsBeforeCommand);
    expect(visibleTiles.every((tile) => tile.isConnected && !tile.hidden)).toBe(true);
    expect(root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]')?.hidden).toBe(
      true,
    );
    expect(
      diagnostics.snapshot().recentSpans.filter(({ name }) => name.startsWith('ink-command-')),
    ).toEqual([
      expect.objectContaining({ commandKind: 'redo', name: 'ink-command-apply' }),
      expect.objectContaining({
        commandKind: 'redo',
        name: 'ink-command-to-submit',
        presentationOutcome: 'submitted',
      }),
    ]);
    controller.dispose();
  });

  it('cancels an unpresented command response when the controller is disposed', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const diagnostics = new InkPerformanceDiagnostics(true);
    const source: InkSurfaceRecord = {
      ...surface([v3LegacyStroke('history')]),
      layout: { ...surface().layout, originY: 0 },
      schemaVersion: 3,
    };
    let controller: InkCanvasController | null = null;
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      onChange: (read, change) => controller?.sync(read, change),
      surfaces: [source],
      writer: { updateSurface: (record) => Promise.resolve(record) },
    });
    session.enter();
    session.apply({ id: 'add-command-stroke', kind: 'add', stroke: v3LegacyStroke('command') });
    const root = document.createElement('div');
    document.body.append(root);
    controller = new InkCanvasController({ document, inkPerformance: diagnostics, root, session });
    controller.enter();
    for (let remaining = 32; frames.length > 0 && remaining > 0; remaining -= 1) {
      frames.shift()?.(performance.now());
    }
    diagnostics.reset();

    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-undo]')?.click();
    expect(diagnostics.snapshot().hangingSpanCount).toBe(1);

    controller.dispose();
    expect(diagnostics.snapshot().hangingSpanCount).toBe(0);
  });

  it('presents a linked document erase without a full recovery rebuild', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const source: InkSurfaceRecord = {
      ...surface([v3LegacyStroke('erase-target')]),
      layout: { ...surface().layout, originY: 0 },
      schemaVersion: 3,
    };
    let controller: InkCanvasController | null = null;
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      onChange: (read, change) => controller?.sync(read, change),
      surfaces: [source],
      writer: { updateSurface: (record) => Promise.resolve(record) },
    });
    const root = document.createElement('div');
    document.body.append(root);
    controller = new InkCanvasController({ document, inkPerformance: diagnostics, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();
    const recoveryRebuildsBeforeCommand = controller.renderRuntimeStats.visibleRecoveryRebuildCount;
    diagnostics.reset();

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointerup', 12, 12));

    expect(session.read().strokes).toHaveLength(0);
    expect(controller.renderRuntimeStats.visibleRecoveryRebuildCount).toBe(
      recoveryRebuildsBeforeCommand,
    );
    expect(
      diagnostics.snapshot().recentSpans.filter(({ name }) => name.startsWith('ink-command-')),
    ).toEqual([
      expect.objectContaining({ commandKind: 'erase', name: 'ink-command-apply' }),
      expect.objectContaining({
        commandKind: 'erase',
        name: 'ink-command-to-submit',
        presentationOutcome: 'submitted',
      }),
    ]);
    controller.dispose();
  });

  it('presents linked document selection deletion without a full recovery rebuild', async () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const source: InkSurfaceRecord = {
      ...surface([v3LegacyStroke('delete-target')]),
      layout: { ...surface().layout, originY: 0 },
      schemaVersion: 3,
    };
    let controller: InkCanvasController | null = null;
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      onChange: (read, change) => controller?.sync(read, change),
      surfaces: [source],
      writer: { updateSurface: (record) => Promise.resolve(record) },
    });
    const root = document.createElement('div');
    document.body.append(root);
    controller = new InkCanvasController({ document, inkPerformance: diagnostics, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 1200));
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();
    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointerup', 10, 10));
    const deleteSelection = root.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-delete-selection]',
    );
    await vi.waitFor(() => expect(deleteSelection?.hidden).toBe(false));
    const recoveryRebuildsBeforeCommand = controller.renderRuntimeStats.visibleRecoveryRebuildCount;
    diagnostics.reset();

    deleteSelection?.click();

    expect(session.read().strokes).toHaveLength(0);
    expect(controller.renderRuntimeStats.visibleRecoveryRebuildCount).toBe(
      recoveryRebuildsBeforeCommand,
    );
    expect(
      diagnostics.snapshot().recentSpans.filter(({ name }) => name.startsWith('ink-command-')),
    ).toEqual([
      expect.objectContaining({ commandKind: 'delete-selection', name: 'ink-command-apply' }),
      expect.objectContaining({
        commandKind: 'delete-selection',
        name: 'ink-command-to-submit',
        presentationOutcome: 'submitted',
      }),
    ]);
    controller.dispose();
  });

  it('presents linked document selection without a full recovery rebuild', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const source: InkSurfaceRecord = {
      ...surface([v3LegacyStroke('select-target')]),
      layout: { ...surface().layout, originY: 0 },
      schemaVersion: 3,
    };
    let controller: InkCanvasController | null = null;
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      onChange: (read, change) => controller?.sync(read, change),
      surfaces: [source],
      writer: { updateSurface: (record) => Promise.resolve(record) },
    });
    const root = document.createElement('div');
    document.body.append(root);
    controller = new InkCanvasController({ document, inkPerformance: diagnostics, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 1200));
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();
    const recoveryRebuildsBeforeCommand = controller.renderRuntimeStats.visibleRecoveryRebuildCount;
    diagnostics.reset();

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointerup', 10, 10));

    expect(session.selectedStrokeIds()).toEqual(['select-target']);
    expect(controller.renderRuntimeStats.visibleRecoveryRebuildCount).toBe(
      recoveryRebuildsBeforeCommand,
    );
    expect(
      diagnostics.snapshot().recentSpans.filter(({ name }) => name.startsWith('ink-command-')),
    ).toEqual([
      expect.objectContaining({ commandKind: 'selection', name: 'ink-command-apply' }),
      expect.objectContaining({
        commandKind: 'selection',
        name: 'ink-command-to-submit',
        presentationOutcome: 'submitted',
      }),
    ]);
    controller.dispose();
  });

  it('enters Select before the real-host Gate presents a selection command', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const source: InkSurfaceRecord = {
      ...surface([v3LegacyStroke('gate-select-target')]),
      layout: { ...surface().layout, originY: 0 },
      schemaVersion: 3,
    };
    let controller: InkCanvasController | null = null;
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      onChange: (read, change) => controller?.sync(read, change),
      surfaces: [source],
      writer: { updateSurface: (record) => Promise.resolve(record) },
    });
    const root = document.createElement('div');
    document.body.append(root);
    controller = new InkCanvasController({ document, inkPerformance: diagnostics, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 1200));
    controller.enter();
    diagnostics.reset();

    expect(controller.runLocalPerformanceCommand('selection')).toBe(true);

    expect(session.selectedStrokeIds()).toEqual(['gate-select-target']);
    expect(
      diagnostics.snapshot().recentSpans.filter(({ name }) => name.startsWith('ink-command-')),
    ).toEqual([
      expect.objectContaining({ commandKind: 'selection', name: 'ink-command-apply' }),
      expect.objectContaining({
        commandKind: 'selection',
        name: 'ink-command-to-submit',
        presentationOutcome: 'submitted',
      }),
    ]);
    controller.dispose();
  });

  it('presents a linked document selection move as one incremental command', () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const source: InkSurfaceRecord = {
      ...surface([v3LegacyStroke('move-target')]),
      layout: { ...surface().layout, originY: 0 },
      schemaVersion: 3,
    };
    let controller: InkCanvasController | null = null;
    const session = new InkLiveDocument({
      debounceMs: 60_000,
      onChange: (read, change) => controller?.sync(read, change),
      surfaces: [source],
      writer: { updateSurface: (record) => Promise.resolve(record) },
    });
    const root = document.createElement('div');
    document.body.append(root);
    controller = new InkCanvasController({ document, inkPerformance: diagnostics, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 1200));
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();
    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointerup', 10, 10));
    diagnostics.reset();
    const recoveryRebuildsBeforeCommand = controller.renderRuntimeStats.visibleRecoveryRebuildCount;

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointermove', 30, 40));
    root.dispatchEvent(pointer('pointerup', 30, 40));

    expect(session.read().strokes[0]?.stroke.points[0]).toMatchObject({ x: 30, y: 40 });
    expect(controller.renderRuntimeStats.visibleRecoveryRebuildCount).toBe(
      recoveryRebuildsBeforeCommand,
    );
    expect(
      diagnostics.snapshot().recentSpans.filter(({ commandKind }) => commandKind === 'move'),
    ).toEqual([
      expect.objectContaining({ name: 'ink-command-apply' }),
      expect.objectContaining({
        name: 'ink-command-to-submit',
        presentationOutcome: 'submitted',
      }),
    ]);
    controller.dispose();
  });

  it('routes a qualifying closed eraser path to one region erase', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointermove', 110, 10));
    root.dispatchEvent(pointer('pointermove', 110, 110));
    root.dispatchEvent(pointer('pointermove', 10, 110));
    root.dispatchEvent(pointer('pointerup', 10, 10));

    expect(session.erasePolygonCalls).toHaveLength(1);
    expect(session.eraseCalls).toBe(0);
    controller.dispose();
  });

  it('tolerates a natural Pencil loop that finishes with a moderate closing gap', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10, 'pen'));
    root.dispatchEvent(pointer('pointermove', 110, 10, 'pen'));
    root.dispatchEvent(pointer('pointermove', 110, 110, 'pen'));
    root.dispatchEvent(pointer('pointermove', 10, 110, 'pen'));
    root.dispatchEvent(pointer('pointerup', 10, 50, 'pen'));

    expect(session.erasePolygonCalls).toHaveLength(1);
    expect(session.eraseCalls).toBe(0);
    controller.dispose();
  });

  it('recognizes a deliberate Pencil loop with a large pen-lift gap', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10, 'pen'));
    root.dispatchEvent(pointer('pointermove', 110, 10, 'pen'));
    root.dispatchEvent(pointer('pointermove', 110, 110, 'pen'));
    root.dispatchEvent(pointer('pointermove', 10, 110, 'pen'));
    root.dispatchEvent(pointer('pointerup', 10, 90, 'pen'));

    expect(session.erasePolygonCalls).toHaveLength(1);
    expect(session.eraseCalls).toBe(0);
    controller.dispose();
  });

  it('keeps a self-intersecting Pencil loop eligible for even-odd region erase', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10, 'pen'));
    root.dispatchEvent(pointer('pointermove', 110, 110, 'pen'));
    root.dispatchEvent(pointer('pointermove', 10, 110, 'pen'));
    root.dispatchEvent(pointer('pointermove', 110, 10, 'pen'));
    root.dispatchEvent(pointer('pointerup', 10, 10, 'pen'));

    expect(session.erasePolygonCalls).toHaveLength(1);
    expect(session.eraseCalls).toBe(0);
    controller.dispose();
  });

  it('closes an Apple Pencil loop when WebKit exposes coalesced samples only for moves', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10, 'pen', 'moves-only'));
    root.dispatchEvent(pointer('pointermove', 110, 10, 'pen', 'moves-only'));
    root.dispatchEvent(pointer('pointermove', 110, 110, 'pen', 'moves-only'));
    root.dispatchEvent(pointer('pointermove', 10, 110, 'pen', 'moves-only'));
    root.dispatchEvent(pointer('pointerup', 10, 10, 'pen', 'moves-only'));

    expect(session.erasePolygonCalls).toHaveLength(1);
    expect(session.eraseCalls).toBe(0);
    controller.dispose();
  });

  it('keeps Apple Pencil tap erase when WebKit returns no coalesced down/up samples', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10, 'pen', 'moves-only'));
    root.dispatchEvent(pointer('pointerup', 12, 12, 'pen', 'moves-only'));

    expect(session.eraseCalls).toBe(1);
    expect(session.erasePolygonCalls).toEqual([]);
    controller.dispose();
  });

  it('keeps a long open eraser path as one endpoint erase', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointermove', 110, 10));
    root.dispatchEvent(pointer('pointermove', 110, 110));
    root.dispatchEvent(pointer('pointerup', 60, 110));

    expect(session.eraseCalls).toBe(1);
    expect(session.erasePolygonCalls).toEqual([]);
    controller.dispose();
  });

  it('does not auto-close a retraced scribble whose endpoints happen to be nearby', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10, 'pen'));
    root.dispatchEvent(pointer('pointermove', 30, 10, 'pen'));
    root.dispatchEvent(pointer('pointermove', 10, 11, 'pen'));
    root.dispatchEvent(pointer('pointermove', 30, 10, 'pen'));
    root.dispatchEvent(pointer('pointermove', 10, 11, 'pen'));
    root.dispatchEvent(pointer('pointermove', 10, 26, 'pen'));
    root.dispatchEvent(pointer('pointerup', 10, 15, 'pen'));

    expect(session.eraseCalls).toBe(1);
    expect(session.erasePolygonCalls).toEqual([]);
    controller.dispose();
  });

  it('cancels a closed eraser path without leaking it into the next gesture', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointermove', 110, 10));
    root.dispatchEvent(pointer('pointermove', 110, 110));
    root.dispatchEvent(pointer('pointermove', 10, 110));
    root.dispatchEvent(pointer('pointermove', 10, 10));
    root.dispatchEvent(pointer('pointercancel', 10, 10));
    root.dispatchEvent(pointer('pointerdown', 200, 200));
    root.dispatchEvent(pointer('pointerup', 202, 202));

    expect(session.erasePolygonCalls).toEqual([]);
    expect(session.eraseCalls).toBe(1);
    controller.dispose();
  });

  it('seals the confirmed prefix on lostpointercapture without duplicating the later pointerup', () => {
    const canvasContext = contextFixture();
    canvasContext.closePath = vi.fn();
    canvasContext.fill = vi.fn();
    canvasContext.globalAlpha = 1;
    canvasContext.globalCompositeOperation = 'source-over';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext);
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({
      document,
      root,
      session,
      unpublishedPhysicalInkHat: { session },
    });
    controller.enter();

    root.dispatchEvent(pointer('pointerdown', 10, 10, 'pen'));
    root.dispatchEvent(pointer('pointermove', 20, 20, 'pen'));
    root.dispatchEvent(pointer('lostpointercapture', 20, 20, 'pen'));
    root.dispatchEvent(pointer('pointerup', 30, 30, 'pen'));
    root.dispatchEvent(pointer('pointerdown', 40, 40, 'pen'));
    root.dispatchEvent(pointer('pointerup', 50, 50, 'pen'));
    root.dispatchEvent(pointer('pointerdown', 70, 70, 'pen'));
    root.dispatchEvent(pointer('pointermove', 80, 80, 'pen'));
    root.dispatchEvent(pointer('lostpointercapture', 80, 80, 'pen'));
    root.dispatchEvent(pointer('pointerup', 90, 90, 'pen'));
    root.dispatchEvent(pointer('pointerdown', 100, 100, 'pen'));
    root.dispatchEvent(pointer('pointerup', 110, 110, 'pen'));
    root.dispatchEvent(pointer('pointerdown', 130, 130, 'pen'));
    root.dispatchEvent(pointer('pointermove', 140, 140, 'pen'));
    root.dispatchEvent(pointer('lostpointercapture', 140, 140, 'pen'));
    root.dispatchEvent(pointer('pointerup', 150, 150, 'pen'));

    expect(session.strokes).toHaveLength(5);
    expect(session.strokes[0]?.points).toMatchObject([
      { x: 10, y: 10 },
      { x: 20, y: 20 },
    ]);
    expect(session.strokes[1]?.points).toMatchObject([
      { x: 40, y: 40 },
      { x: 50, y: 50 },
    ]);
    expect(session.strokes[2]?.points).toMatchObject([
      { x: 70, y: 70 },
      { x: 80, y: 80 },
    ]);
    expect(session.strokes[3]?.points).toMatchObject([
      { x: 100, y: 100 },
      { x: 110, y: 110 },
    ]);
    expect(session.strokes[4]?.points).toMatchObject([
      { x: 130, y: 130 },
      { x: 140, y: 140 },
    ]);
    controller.dispose();
  });

  it('cancels an unfinished eraser loop when the user switches tools', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointermove', 110, 10));
    root.dispatchEvent(pointer('pointermove', 110, 110));
    root.dispatchEvent(pointer('pointermove', 10, 110));
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="pen"]')?.click();
    root.dispatchEvent(pointer('pointerup', 10, 10));

    expect(session.erasePolygonCalls).toEqual([]);
    expect(session.eraseCalls).toBe(0);
    expect(session.strokes.map(({ id }) => id)).toEqual(['saved']);
    controller.dispose();
  });

  it('cancels an unfinished eraser loop when Ink edit exits', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointermove', 110, 10));
    root.dispatchEvent(pointer('pointermove', 110, 110));
    root.dispatchEvent(pointer('pointermove', 10, 110));
    await controller.exit();
    root.dispatchEvent(pointer('pointerup', 10, 10));

    expect(session.erasePolygonCalls).toEqual([]);
    expect(session.eraseCalls).toBe(0);
    controller.dispose();
  });

  it('cancels an unfinished eraser loop when Obsidian replaces the active host', () => {
    const root = document.createElement('div');
    const replacement = document.createElement('div');
    document.body.append(root, replacement);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({
      document,
      layoutRoot: root,
      root,
      scrollContainer: root,
      session,
    });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointermove', 110, 10));
    root.dispatchEvent(pointer('pointermove', 110, 110));
    root.dispatchEvent(pointer('pointermove', 10, 110));
    controller.reattach(replacement, replacement, replacement);
    replacement.dispatchEvent(pointer('pointerup', 10, 10));

    expect(session.erasePolygonCalls).toEqual([]);
    expect(session.eraseCalls).toBe(0);
    controller.dispose();
  });

  it('cancels an unfinished eraser loop when the controller unloads', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointermove', 110, 10));
    root.dispatchEvent(pointer('pointermove', 110, 110));
    root.dispatchEvent(pointer('pointermove', 10, 110));
    controller.dispose();
    root.dispatchEvent(pointer('pointerup', 10, 10));

    expect(session.erasePolygonCalls).toEqual([]);
    expect(session.eraseCalls).toBe(0);
  });

  it('describes both point and closed-loop gestures on the eraser control', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      root,
      session: new FakeSession(surface()),
    });

    expect(
      root
        .querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')
        ?.getAttribute('aria-label'),
    ).toBe('Stroke eraser: tap a stroke or circle strokes');
    controller.dispose();
  });

  it('renders a dashed eraser path with a non-color closure marker', () => {
    const contexts: CanvasRenderingContext2D[] = [];
    const arc = vi.fn();
    const setLineDash = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      const context = contextFixture(undefined, undefined, undefined, {
        arc,
        setLineDash,
      });
      contexts.push(context);
      return context;
    });
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointermove', 110, 10));

    expect(contexts[1]).toBeDefined();
    expect(setLineDash).toHaveBeenCalledWith(expect.arrayContaining([expect.any(Number)]));
    expect(arc).toHaveBeenCalled();
    controller.dispose();
  });

  it('uses the WebKit stylus Touch fallback for the eraser', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(touch('touchstart', 10, 10, 'stylus'));
    root.dispatchEvent(touch('touchend', 12, 12, 'stylus'));

    expect(session.eraseCalls).toBe(1);
    controller.dispose();
  });

  it('uses the WebKit stylus Touch fallback for closed-loop erase', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(touch('touchstart', 10, 10, 'stylus'));
    root.dispatchEvent(touch('touchmove', 110, 10, 'stylus'));
    root.dispatchEvent(touch('touchmove', 110, 110, 'stylus'));
    root.dispatchEvent(touch('touchmove', 10, 110, 'stylus'));
    root.dispatchEvent(touch('touchend', 10, 10, 'stylus'));

    expect(session.erasePolygonCalls).toHaveLength(1);
    expect(session.eraseCalls).toBe(0);
    controller.dispose();
  });

  it('commits one closed-loop erase when WebKit emits both Pointer and stylus Touch events', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();

    root.dispatchEvent(pointer('pointerdown', 10, 10, 'pen'));
    root.dispatchEvent(touch('touchstart', 10, 10, 'stylus'));
    root.dispatchEvent(pointer('pointermove', 110, 10, 'pen'));
    root.dispatchEvent(touch('touchmove', 110, 10, 'stylus'));
    root.dispatchEvent(pointer('pointermove', 110, 110, 'pen'));
    root.dispatchEvent(pointer('pointermove', 10, 110, 'pen'));
    root.dispatchEvent(pointer('pointerup', 10, 10, 'pen'));
    root.dispatchEvent(touch('touchend', 10, 10, 'stylus'));

    expect(session.erasePolygonCalls).toHaveLength(1);
    expect(session.eraseCalls).toBe(0);
    controller.dispose();
  });

  it('selects and previews a mouse drag while keeping touch available for scrolling', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 1200));
    controller.enter();

    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();
    expect(root.style.touchAction).toBe('');
    expect(root.querySelector<HTMLButtonElement>('[data-inkstone-ink-multiple]')?.hidden).toBe(
      false,
    );
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-multiple]')?.click();
    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointermove', 30, 40));
    root.dispatchEvent(pointer('pointerup', 30, 40));

    expect(session.selectCalls).toEqual([{ additive: true, x: 10, y: 10 }]);
    expect(session.previewCalls[0]).toMatchObject({ dy: 30 });
    expect(session.previewCalls[0]?.dx).toBeCloseTo(20);
    expect(session.commitCalls).toBe(1);
    expect(session.strokes).toHaveLength(1);
  });

  it('reveals a delete action for the current selection and removes it as one command', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 1200));
    controller.enter();

    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();
    expect(
      root.querySelector<HTMLButtonElement>('[data-inkstone-ink-delete-selection]')?.hidden,
    ).toBe(true);

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointerup', 10, 10));

    const deleteButton = root.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-delete-selection]',
    );
    expect(deleteButton?.hidden).toBe(false);
    expect(deleteButton?.getAttribute('aria-label')).toBe('Delete 1 selected Ink stroke');

    deleteButton?.click();

    expect(session.deleteSelectionCalls).toBe(1);
    expect(session.strokes).toEqual([]);
    expect(session.selectedStrokeIds()).toEqual([]);
    expect(deleteButton?.hidden).toBe(true);
    controller.dispose();
  });

  it('uses the WebKit stylus Touch fallback for Select and move', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();

    root.dispatchEvent(touch('touchstart', 10, 10, 'stylus'));
    root.dispatchEvent(touch('touchmove', 30, 40, 'stylus'));
    root.dispatchEvent(touch('touchend', 30, 40, 'stylus'));

    expect(session.selectCalls).toEqual([{ additive: false, x: 10, y: 10 }]);
    expect(session.previewCalls[0]).toMatchObject({ dx: 20, dy: 30 });
    expect(session.commitCalls).toBe(1);
    expect(session.strokes).toHaveLength(1);
    controller.dispose();
  });

  it('drags the full multiple selection when the pointer starts on an already selected stroke', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const first = stroke('first');
    const second = {
      ...stroke('second'),
      points: [
        { pressure: 0.5, time: 0, x: 110, y: 110 },
        { pressure: 0.5, time: 16, x: 120, y: 120 },
      ],
    };
    const session = new FakeSession(surface([first, second]));
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 1200));
    controller.enter();

    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-multiple]')?.click();
    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointerup', 10, 10));
    root.dispatchEvent(pointer('pointerdown', 110, 110));
    root.dispatchEvent(pointer('pointerup', 110, 110));
    expect(session.selectedStrokeIds()).toEqual(['first', 'second']);

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointermove', 30, 40));
    root.dispatchEvent(pointer('pointerup', 30, 40));

    expect(session.selectedStrokeIds()).toEqual(['first', 'second']);
    expect(session.strokes[0]?.points[0]).toMatchObject({ x: 30, y: 40 });
    expect(session.strokes[1]?.points[0]).toMatchObject({ x: 130, y: 140 });
    expect(session.commitCalls).toBe(1);
  });

  it('toggles an already selected stroke only when the multiple-selection gesture stays a click', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const second = {
      ...stroke('second'),
      points: [
        { pressure: 0.5, time: 0, x: 110, y: 110 },
        { pressure: 0.5, time: 16, x: 120, y: 120 },
      ],
    };
    const session = new FakeSession(surface([stroke('first'), second]));
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 1200));
    controller.enter();

    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-multiple]')?.click();
    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointerup', 10, 10));
    root.dispatchEvent(pointer('pointerdown', 110, 110));
    root.dispatchEvent(pointer('pointerup', 110, 110));

    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointermove', 12, 12));
    root.dispatchEvent(pointer('pointerup', 12, 12));

    expect(session.selectedStrokeIds()).toEqual(['second']);
    expect(session.previewCalls).toEqual([]);
    expect(session.commitCalls).toBe(0);
  });

  it('shows a non-mutating hover affordance in Select/Move', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 1200));
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();

    root.dispatchEvent(pointer('pointermove', 10, 10));

    expect(session.hoverCalls).toEqual([{ x: 10, y: 10 }]);
    expect(session.selectedStrokeIds()).toEqual([]);
    expect(root.style.cursor).toBe('grab');

    root.dispatchEvent(pointer('pointerleave', 100, 100));
    expect(root.style.cursor).toBe('');
  });

  it('keeps repeated selection previews off the committed Ink layer', () => {
    const contexts = new Map<HTMLCanvasElement, CanvasRenderingContext2D>();
    const strokeSpies = new Map<HTMLCanvasElement, ReturnType<typeof vi.fn>>();
    const clearRectSpies = new Map<HTMLCanvasElement, ReturnType<typeof vi.fn>>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing;
      const strokeSpy = vi.fn();
      const clearRectSpy = vi.fn();
      const created = contextFixture(strokeSpy, clearRectSpy);
      contexts.set(this, created);
      strokeSpies.set(this, strokeSpy);
      clearRectSpies.set(this, clearRectSpy);
      return created;
    });
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(
      surface(Array.from({ length: 100 }, (_, index) => stroke(`saved-${index}`))),
    );
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    const committedStroke = committed === null ? undefined : strokeSpies.get(committed);
    const activeClearRect = active === null ? undefined : clearRectSpies.get(active);
    if (active === null || committedStroke === undefined || activeClearRect === undefined) {
      throw new Error('Missing Ink canvas fixture.');
    }
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();
    root.dispatchEvent(pointer('pointerdown', 10, 10));
    committedStroke.mockClear();
    activeClearRect.mockClear();

    root.dispatchEvent(pointer('pointermove', 30, 40));
    const firstPreviewPaints = committedStroke.mock.calls.length;
    root.dispatchEvent(pointer('pointermove', 40, 50));

    expect(firstPreviewPaints).toBeGreaterThan(0);
    expect(committedStroke).toHaveBeenCalledTimes(firstPreviewPaints);
    expect(activeClearRect).toHaveBeenCalled();
    expect(activeClearRect.mock.calls.at(-1)?.[2]).toBeLessThan(active.width);
    expect(activeClearRect.mock.calls.at(-1)?.[3]).toBeLessThan(active.height);
  });

  it('orders Escape as cancel preview, clear selection, then exit Ink Mode', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const exitRequests: string[] = [];
    const controller = new InkCanvasController({
      document,
      onExitRequested: () => {
        exitRequests.push('exit');
        return Promise.resolve();
      },
      root,
      session,
    });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();
    root.dispatchEvent(pointer('pointerdown', 10, 10));
    root.dispatchEvent(pointer('pointermove', 30, 40));

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(session.cancelCalls).toBe(1);
    expect(session.commitCalls).toBe(0);
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(session.clearCalls).toBe(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(exitRequests).toEqual(['exit']);
  });

  it('snapshots device-local tool preference and records the one-time hint without late mutation', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const changes: InkToolPreference[] = [];
    const preference: InkToolPreference = {
      color: '#123456',
      hintShown: false,
      tool: 'highlighter',
      width: 8,
    };
    const controller = new InkCanvasController({
      document,
      onPreferenceChanged: (next) => changes.push(next),
      preference,
      root,
      session: new FakeSession(surface()),
    });

    controller.enter();

    expect(
      root.querySelector('[data-inkstone-ink-tool="highlighter"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(root.querySelector('[data-inkstone-ink-status]')?.textContent).toContain('Draw with');
    expect(changes.at(-1)).toMatchObject({ hintShown: true, tool: 'highlighter' });
    expect(preference.hintShown).toBe(false);
  });

  it('restores every stable toolbar choice from the device-local preference', () => {
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      preference: {
        color: '#123456',
        hintShown: true,
        interaction: 'select',
        multiple: true,
        optionsVisible: true,
        tool: 'highlighter',
        width: 1,
        zoomMode: 'manual',
        zoomScale: 0.7,
      },
      root,
      session: new FakeSession(surface()),
    });

    controller.enter();

    expect(
      root.querySelector('[data-inkstone-ink-select-move]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(root.querySelector<HTMLElement>('[data-inkstone-ink-multiple]')?.hidden).toBe(false);
    expect(root.querySelector('[data-inkstone-ink-multiple]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(root.querySelector<HTMLInputElement>('[data-inkstone-ink-color]')?.hidden).toBe(false);
    expect(root.querySelector<HTMLInputElement>('[data-inkstone-ink-color]')?.value).toBe(
      '#123456',
    );
    expect(root.querySelector<HTMLSelectElement>('[data-inkstone-ink-width-select]')?.value).toBe(
      '1',
    );
    expect(
      root
        .querySelector('button[aria-label="Show or hide Ink options"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(root.classList.contains('is-ink-fit')).toBe(false);
    expect(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')).toBe('0.7');
    controller.dispose();
  });

  it('persists option visibility, selection controls, and edit zoom after each user choice', () => {
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    document.body.append(root);
    const changes: InkToolPreference[] = [];
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      onPreferenceChanged: (preference) => changes.push(preference),
      preference: { ...LocalInkToolPreferenceStore.DEFAULT, hintShown: true },
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();

    root.querySelector<HTMLButtonElement>('button[aria-label="Show or hide Ink options"]')?.click();
    expect(changes.at(-1)).toMatchObject({ optionsVisible: true });

    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-out]')?.click();
    expect(changes.at(-1)).toMatchObject({ zoomMode: 'manual', zoomScale: 0.9 });

    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();
    expect(changes.at(-1)).toMatchObject({ interaction: 'select', optionsVisible: false });

    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-multiple]')?.click();
    expect(changes.at(-1)).toMatchObject({ interaction: 'select', multiple: true });
    controller.dispose();
  });

  it('keeps the palette in deterministic keyboard order without stealing focus on iPad', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();
    const controls = root.querySelector<HTMLElement>('.inkstone-ink-controls');
    const buttons = [...(controls?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const keyboardControls = [
      ...(controls?.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select') ??
        []),
    ];

    expect(controls?.hasAttribute('data-inkstone-ink-toolbar-app')).toBe(true);
    expect(controls?.getAttribute('role')).toBe('toolbar');
    expect(keyboardControls.map((control) => control.getAttribute('aria-label'))).toEqual([
      'Move Ink toolbar',
      'Exit Ink Mode',
      'Pen',
      'Highlighter',
      'Stroke eraser: tap a stroke or circle strokes',
      'Select and move Ink',
      'Select multiple Ink strokes',
      'Delete 0 selected Ink strokes',
      'Ink width',
      'Zoom Ink workspace out',
      'Fit Ink workspace to pane · 100%',
      'Zoom Ink workspace in',
      'Undo Ink change',
      'Redo Ink change',
      'Show or hide Ink options',
      'Retry local Ink save',
      'Export retained unsaved Ink as SVG',
    ]);
    expect(
      buttons.every((button) => button.textContent?.trim() || button.getAttribute('aria-label')),
    ).toBe(true);
    expect(
      buttons.filter((button) => !button.hidden).every((button) => button.title.length > 0),
    ).toBe(true);
    expect(root.querySelector('[data-inkstone-ink-status]')?.getAttribute('aria-live')).toBe(
      'polite',
    );
    expect(root.querySelector('[data-inkstone-ink-status]')?.getAttribute('role')).toBe('status');
    expect(root.querySelector('[data-inkstone-ink-width-control]')).not.toBeNull();
    expect(root.querySelector<HTMLInputElement>('[data-inkstone-ink-color]')?.hidden).toBe(true);
    expect(
      root
        .querySelector<HTMLButtonElement>('button[aria-label="Exit Ink Mode"]')
        ?.querySelector('.inkstone-icon-button__label'),
    ).toBeNull();
    const selectMove = root.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]');
    const multiple = root.querySelector<HTMLButtonElement>('[data-inkstone-ink-multiple]');
    expect(selectMove?.querySelector('.inkstone-icon-button__label')).toBeNull();
    expect(selectMove?.querySelector('[data-inkstone-icon="move"]')).not.toBeNull();
    expect(multiple?.querySelector('.inkstone-icon-button__label')).toBeNull();
    expect(multiple?.querySelector('[data-inkstone-icon="list-checks"]')).not.toBeNull();
    const more = root.querySelector<HTMLButtonElement>(
      'button[aria-label="Show or hide Ink options"]',
    );
    more?.focus();
    expect(root.querySelector<HTMLInputElement>('[aria-label="Ink color"]')?.hidden).toBe(true);
    more?.click();
    expect(document.activeElement).toBe(more);
    expect(root.querySelector<HTMLInputElement>('[aria-label="Ink color"]')?.hidden).toBe(false);
    const width = root.querySelector<HTMLSelectElement>('[data-inkstone-ink-width-select]');
    expect(width?.value).toBe('4');
    expect([...(width?.options ?? [])].map((option) => option.value)).toEqual([
      '1',
      '2',
      '4',
      '8',
      '12',
      '16',
    ]);
    expect(
      root
        .querySelector<HTMLElement>('.inkstone-ink-controls__width-preview')
        ?.style.getPropertyValue('height'),
    ).toBe('4px');
    more?.click();
    expect(root.querySelector<HTMLInputElement>('[aria-label="Ink color"]')?.hidden).toBe(true);
  });

  it('moves the compact floating palette by its drag handle and keeps it in the viewport', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const changes: InkToolPreference[] = [];
    const controller = new InkCanvasController({
      document,
      onPreferenceChanged: (preference) => changes.push(preference),
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();
    const controls = root.querySelector<HTMLElement>('.inkstone-ink-controls');
    const handle = root.querySelector<HTMLButtonElement>('[data-inkstone-ink-drag-handle]');
    if (controls === null || handle === null) throw new Error('Missing draggable Ink controls.');
    vi.spyOn(controls, 'getBoundingClientRect').mockReturnValue(rect(760, 80, 420, 48));
    Object.defineProperties(document.documentElement, {
      clientHeight: { configurable: true, value: 800 },
      clientWidth: { configurable: true, value: 1200 },
    });

    handle.dispatchEvent(pointer('pointerdown', 780, 100));
    document.dispatchEvent(pointer('pointermove', 400, 300));
    document.dispatchEvent(pointer('pointerup', 400, 300));

    expect(controls.dataset.inkstoneInkDragged).toBe('true');
    expect(controls.style.left).toBe('380px');
    expect(controls.style.top).toBe('280px');
    expect(controls.style.right).toBe('auto');
    expect(changes.at(-1)?.toolbarPosition).toEqual({ left: 380, top: 280 });

    handle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }));
    expect(controls.style.left).toBe('752px');
    expect(changes.at(-1)?.toolbarPosition).toEqual({ left: 752, top: 80 });
  });

  it('restores and clamps the remembered palette inside the iPad visual viewport', () => {
    const visualViewport = new EventTarget();
    Object.defineProperties(visualViewport, {
      height: { value: 400 },
      offsetLeft: { value: 100 },
      offsetTop: { value: 50 },
      width: { value: 500 },
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      preference: {
        color: '#123456',
        hintShown: true,
        tool: 'pen',
        toolbarPosition: { left: 20, top: 900 },
        width: 4,
      },
      root,
      session: new FakeSession(surface()),
    });
    const controls = root.querySelector<HTMLElement>('.inkstone-ink-controls');
    if (controls === null) throw new Error('Missing Ink controls.');
    vi.spyOn(controls, 'getBoundingClientRect').mockReturnValue(rect(20, 900, 420, 48));

    controller.enter();

    expect(controls.dataset.inkstoneInkDragged).toBe('true');
    expect(controls.style.left).toBe('112px');
    expect(controls.style.top).toBe('390px');
  });

  it('keeps a remembered palette position while its first iPad layout rect is still zero', () => {
    const visualViewport = new EventTarget();
    Object.defineProperties(visualViewport, {
      height: { value: 700 },
      offsetLeft: { value: 0 },
      offsetTop: { value: 0 },
      width: { value: 1_000 },
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      preference: {
        color: '#123456',
        hintShown: true,
        tool: 'pen',
        toolbarPosition: { left: 240, top: 180 },
        width: 4,
      },
      root,
      session: new FakeSession(surface()),
    });
    const controls = root.querySelector<HTMLElement>('.inkstone-ink-controls');
    if (controls === null) throw new Error('Missing Ink controls.');
    vi.spyOn(controls, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 0, 0));

    controller.enter();

    expect(controls.style.left).toBe('240px');
    expect(controls.style.top).toBe('180px');
  });

  it('extends the pane Canvas through the owning iPad view content', async () => {
    const viewportHost = document.createElement('div');
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    root.append(layoutRoot);
    viewportHost.append(root);
    document.body.append(viewportHost);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 1_000 },
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 100, 1_000, 600));
    vi.spyOn(viewportHost, 'getBoundingClientRect').mockReturnValue(rect(0, 100, 1_000, 900));
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockReturnValue(rect(148, 132, 704, 500));
    const extentChanged = vi.fn();
    const shortSurface = surface();
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      onLayoutExtentChanged: extentChanged,
      root,
      scrollContainer: root,
      session: new FakeSession({
        ...shortSurface,
        layout: { ...shortSurface.layout, logicalHeight: 500 },
      }),
      viewportHost,
    });
    const overlay = root.querySelector<HTMLElement>('.inkstone-ink-surface');
    if (overlay === null) throw new Error('Missing Ink surface.');

    controller.enter();
    await vi.waitFor(() => expect(extentChanged).toHaveBeenCalled());

    expect(overlay.style.height).toBe('900px');
    expect(extentChanged).toHaveBeenCalledWith(868);
  });

  it('defaults a compact document pane to the bottom so the toolbar does not cover its title', () => {
    const root = document.createElement('div');
    document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(100, 80, 480, 600));
    Object.defineProperties(document.documentElement, {
      clientHeight: { configurable: true, value: 800 },
      clientWidth: { configurable: true, value: 1200 },
    });
    const controller = new InkCanvasController({
      document,
      root,
      session: new FakeSession(surface()),
    });
    const controls = root.querySelector<HTMLElement>('.inkstone-ink-controls');
    if (controls === null) throw new Error('Missing Ink controls.');
    vi.spyOn(controls, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 420, 46));

    controller.enter();

    expect(controls.style.left).toBe('148px');
    expect(controls.style.top).toBe('618px');
    expect(controls.dataset.inkstoneInkDragged).toBeUndefined();
  });

  it('paints disabled Saving feedback before delegating Done to the host lifecycle', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const requests: string[] = [];
    const diagnostics = new InkPerformanceDiagnostics(true);
    let acknowledgePaint = (): void => undefined;
    const afterNextPaint = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledgePaint = resolve;
        }),
    );
    const controller = new InkCanvasController({
      afterNextPaint,
      document,
      inkPerformance: diagnostics,
      onExitRequested: () => {
        requests.push('exit');
        return Promise.resolve();
      },
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();

    root.querySelector<HTMLButtonElement>('button[aria-label="Exit Ink Mode"]')?.click();

    const done = root.querySelector<HTMLButtonElement>('button[aria-label="Exit Ink Mode"]');
    const status = root.querySelector<HTMLElement>('[data-inkstone-ink-status]');

    expect(afterNextPaint).toHaveBeenCalledOnce();
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toContain('Saving');
    expect(done?.disabled).toBe(true);
    expect(requests).toEqual([]);
    expect(diagnostics.snapshot().hangingSpanCount).toBe(2);

    acknowledgePaint();
    await vi.waitFor(() => expect(requests).toEqual(['exit']));
    await vi.waitFor(() => expect(diagnostics.snapshot().hangingSpanCount).toBe(0));
    expect(diagnostics.snapshot().recentSpans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ink-done-first-feedback', workPhase: 'save' }),
        expect.objectContaining({ accepted: true, name: 'ink-done-total', workPhase: 'save' }),
      ]),
    );
  });

  it('keeps Ink Mode active on save failure and exposes Retry', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    session.failExit = true;
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();

    await expect(controller.exit()).rejects.toThrow('disk unavailable');

    expect(root.classList.contains('is-ink-mode')).toBe(true);
    const retry = root.querySelector<HTMLButtonElement>('[data-inkstone-ink-retry]');
    expect(retry?.hidden).toBe(false);
    retry?.click();
    await vi.waitFor(() => expect(session.retryCalls).toBe(1));
  });

  it('rejects new drawing input while Done is saving the frozen revision', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    let finishSave = (): void => undefined;
    const exit = vi.spyOn(session, 'exit').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();

    const exiting = controller.exit();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    root.dispatchEvent(pointer('pointerdown', 10, 20, 'pen'));
    root.dispatchEvent(pointer('pointerup', 30, 40, 'pen'));

    expect(session.applyCalls).toBe(0);

    finishSave();
    await exiting;
    controller.dispose();
  });

  it('delegates persistence Retry to the lifecycle owner without locally deactivating', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const retryOwner = vi.fn(() => Promise.resolve());
    const session = new FakeSession(surface());
    session.failExit = true;
    const controller = new InkCanvasController({
      document,
      onRetryRequested: retryOwner,
      root,
      session,
    });
    controller.enter();
    await expect(controller.exit()).rejects.toThrow('disk unavailable');

    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-retry]')?.click();
    await vi.waitFor(() => expect(retryOwner).toHaveBeenCalledTimes(1));

    expect(session.retryCalls).toBe(0);
    expect(root.classList.contains('is-ink-mode')).toBe(true);
    controller.dispose();
  });

  it('exports the retained in-memory revision after Done persistence fails', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const exportOwner = vi.fn(() => Promise.resolve());
    const session = new FakeSession(surface());
    session.failExit = true;
    const controller = new InkCanvasController({
      document,
      onExportUnsavedRequested: exportOwner,
      root,
      session,
    });
    controller.enter();
    await expect(controller.exit()).rejects.toThrow('disk unavailable');

    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-export-unsaved]')?.click();
    await vi.waitFor(() => expect(exportOwner).toHaveBeenCalledTimes(1));

    expect(root.classList.contains('is-ink-mode')).toBe(true);
    expect(session.read().state).toMatchObject({ dirty: true, kind: 'ink-mode' });
    controller.dispose();
  });

  it('keeps routine local-save success out of the compact toolbar', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    session.savedLocally = true;
    const controller = new InkCanvasController({
      document,
      preference: { color: '#4f46d8', hintShown: true, tool: 'pen', width: 4 },
      root,
      session,
    });

    controller.enter();

    const status = root.querySelector<HTMLElement>('[data-inkstone-ink-status]');
    expect(status?.textContent).toContain('Saved locally');
    expect(status?.hidden).toBe(true);
  });
});

class FakeSession {
  applyCalls = 0;
  cancelCalls = 0;
  clearCalls = 0;
  commitCalls = 0;
  deleteSelectionCalls = 0;
  eraseCalls = 0;
  erasePolygonCalls: Array<readonly InkPoint[]> = [];
  enterCalls = 0;
  exitCalls = 0;
  failExit = false;
  hoverCalls: Array<{ x: number; y: number }> = [];
  interactionCalls: boolean[] = [];
  userInteractionCalls = 0;
  private interactionActive = false;
  retryCalls = 0;
  redoCalls = 0;
  previewCalls: Array<{ dx: number; dy: number }> = [];
  private previewBaseStrokes: InkStroke[] | null = null;
  private readonly selected = new Set<string>();
  savedLocally = false;
  state: InkSurfaceSessionSnapshot['state'] = {
    dirty: false,
    kind: 'ink-mode',
    saveError: null,
  };
  strokes: InkStroke[];
  selectCalls: Array<{ additive: boolean; x: number; y: number }> = [];
  undoCalls = 0;

  constructor(private record: InkSurfaceRecord) {
    this.strokes = [...record.strokes];
  }

  snapshot(): InkSurfaceSessionSnapshot {
    return {
      persistence:
        this.state.kind === 'ink-mode' && this.state.saveError !== null
          ? {
              error: new Error(this.state.saveError),
              kind: 'error',
              message: "Couldn't save Ink locally. Retry.",
            }
          : this.savedLocally
            ? { kind: 'saved-locally' }
            : { kind: 'idle' },
      state: this.state,
      surface: { ...this.record, strokes: this.strokes },
    };
  }

  read() {
    return createTestInkReadView(this.snapshot());
  }

  query(viewport: InkLogicalRect) {
    return queryTestInkReadView(this.read(), viewport);
  }

  setInteractionActive(active: boolean): void {
    if (active === this.interactionActive) return;
    this.interactionActive = active;
    this.interactionCalls.push(active);
  }

  noteUserInteraction(): void {
    this.userInteractionCalls += 1;
  }

  setLogicalHeight(logicalHeight: number): void {
    this.record = {
      ...this.record,
      layout: { ...this.record.layout, logicalHeight },
    };
  }

  addStroke(stroke: InkStroke): void {
    if (this.state.kind === 'reading') throw new Error('Cannot add outside Ink Mode.');
    this.strokes.push(stroke);
    this.state = { dirty: true, kind: 'ink-mode', saveError: null };
  }

  apply(command: InkDocumentCommand): InkDocumentApplyResult {
    if (command.kind !== 'add')
      throw new Error(`Unexpected fake document command: ${command.kind}`);
    this.applyCalls += 1;
    this.addStroke(command.stroke);
    return committedAddResult(command, this.strokes.length);
  }

  enter(): void {
    this.enterCalls += 1;
    if (this.state.kind === 'reading') {
      this.state = { dirty: false, kind: 'ink-mode', saveError: null };
    }
  }

  background(): Promise<void> {
    return Promise.resolve();
  }

  cancelSelectionMove(): boolean {
    this.cancelCalls += 1;
    if (this.previewBaseStrokes !== null) this.strokes = this.previewBaseStrokes;
    this.previewBaseStrokes = null;
    return true;
  }

  clearSelection(): boolean {
    this.clearCalls += 1;
    const changed = this.selected.size > 0 || this.previewBaseStrokes !== null;
    this.selected.clear();
    this.previewBaseStrokes = null;
    return changed;
  }

  commitSelectionMove(): boolean {
    this.commitCalls += 1;
    this.previewBaseStrokes = null;
    return true;
  }

  deleteSelectedStrokes(): readonly string[] {
    this.deleteSelectionCalls += 1;
    const selected = this.selectedStrokeIds();
    this.strokes = this.strokes.filter((candidate) => !this.selected.has(candidate.id));
    this.selected.clear();
    if (selected.length > 0) {
      this.state = { dirty: true, kind: 'ink-mode', saveError: null };
    }
    return selected;
  }

  previewSelectionMove(dx: number, dy: number): { readonly dx: number; readonly dy: number } {
    this.previewCalls.push({ dx, dy });
    this.previewBaseStrokes ??= this.strokes;
    this.strokes = this.previewBaseStrokes.map((candidate) =>
      this.selected.has(candidate.id)
        ? {
            ...candidate,
            points: candidate.points.map((point) => ({
              ...point,
              x: point.x + dx,
              y: point.y + dy,
            })),
          }
        : candidate,
    );
    return { dx, dy };
  }

  selectStrokeAt(
    point: { readonly x: number; readonly y: number },
    _tolerance: number,
    additive = false,
  ): readonly string[] {
    this.selectCalls.push({ additive, x: point.x, y: point.y });
    const strokeId = this.hitStrokeId(point);
    if (!additive) this.selected.clear();
    if (strokeId === null) {
      this.selected.clear();
    } else if (additive && this.selected.has(strokeId)) {
      this.selected.delete(strokeId);
    } else {
      this.selected.add(strokeId);
    }
    return this.selectedStrokeIds();
  }

  selectedStrokeIds(): readonly string[] {
    return [...this.selected];
  }

  strokeIdAt(point: { readonly x: number; readonly y: number }): string | null {
    this.hoverCalls.push({ x: point.x, y: point.y });
    return this.hitStrokeId(point);
  }

  private hitStrokeId(point: { readonly x: number; readonly y: number }): string | null {
    return (
      this.strokes.find((candidate) =>
        candidate.points.some(
          (candidatePoint) =>
            Math.hypot(candidatePoint.x - point.x, candidatePoint.y - point.y) <= 8,
        ),
      )?.id ?? null
    );
  }

  exit(): Promise<void> {
    this.exitCalls += 1;
    if (this.failExit) {
      this.state = {
        dirty: true,
        kind: 'ink-mode',
        pendingIntent: 'exit',
        saveError: 'disk unavailable',
      };
      return Promise.reject(new Error('disk unavailable'));
    }
    this.state = { kind: 'reading' };
    return Promise.resolve();
  }

  retry(): Promise<void>;
  retry(): Promise<void> {
    this.retryCalls += 1;
    this.failExit = false;
    this.state = { kind: 'reading' };
    return Promise.resolve();
  }

  canRedo(): boolean {
    return true;
  }

  canUndo(): boolean {
    return true;
  }

  eraseStrokeAt(): string | null {
    this.eraseCalls += 1;
    return this.strokes[0]?.id ?? null;
  }

  eraseStrokesInPolygon(polygon: readonly InkPoint[]): readonly string[] {
    this.erasePolygonCalls.push(polygon);
    return [];
  }

  redo(): boolean {
    this.redoCalls += 1;
    return true;
  }

  undo(): boolean {
    this.undoCalls += 1;
    return true;
  }
}

function committedAddResult(
  command: Extract<InkDocumentCommand, { readonly kind: 'add' }>,
  generation: number,
): InkDocumentApplyResult {
  return {
    change: {
      addedIds: [command.stroke.id],
      bounds: [],
      commandId: command.id,
      generation,
      persistenceDelta: null,
      removedIds: [],
      selectionDelta: null,
      updatedIds: [],
    },
    kind: 'committed',
  };
}

function surface(strokes: readonly InkStroke[] = []): InkSurfaceRecord {
  return {
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Ink.md',
    id: 'surface-1',
    layout: {
      blockFingerprints: ['block'],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1200,
      logicalWidth: 960,
      sourceRevision: 'source',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes,
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}

function stroke(id: string): InkStroke {
  return {
    color: '#4f46d8',
    id,
    points: [
      { pressure: 0.5, time: 0, x: 10, y: 10 },
      { pressure: 0.5, time: 16, x: 20, y: 20 },
    ],
    tool: 'pen',
    width: 4,
  };
}

function v3LegacyStroke(id: string): InkStroke {
  return {
    ...stroke(id),
    brushRenderVersion: 'legacy-round-v1',
    inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
  };
}

function pointer(
  type: string,
  x: number,
  y: number,
  pointerType = 'mouse',
  coalescedEvents: 'all' | 'moves-only' = 'all',
  onCoalesced?: () => void,
  pressure = pointerType === 'pen' ? 0.7 : 0,
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    getCoalescedEvents: {
      configurable: true,
      value: () => {
        onCoalesced?.();
        return coalescedEvents === 'moves-only' && type !== 'pointermove' ? [] : [event];
      },
    },
    pointerId: { value: 1 },
    pointerType: { value: pointerType },
    pressure: { value: pressure },
    tiltX: { value: 0 },
    tiltY: { value: 0 },
  });
  return event;
}

function pointerWithPredictions(
  type: string,
  x: number,
  y: number,
  predictions: readonly (readonly [number, number])[],
  onPredictions?: () => void,
): Event {
  const event = pointer(type, x, y, 'pen');
  const predictedEvents = predictions.map(([predictedX, predictedY], index) => {
    const predicted = pointer('pointermove', predictedX, predictedY, 'pen');
    Object.defineProperty(predicted, 'timeStamp', {
      configurable: true,
      value: event.timeStamp + index + 1,
    });
    return predicted;
  });
  Object.defineProperty(event, 'getPredictedEvents', {
    configurable: true,
    value: () => {
      onPredictions?.();
      return predictedEvents;
    },
  });
  return event;
}

function touch(
  type: string,
  x: number,
  y: number,
  touchType: 'direct' | 'stylus',
  identifier = 7,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const sample = {
    altitudeAngle: touchType === 'stylus' ? Math.PI / 4 : 0,
    azimuthAngle: 0,
    clientX: x,
    clientY: y,
    force: touchType === 'stylus' ? 0.7 : 0,
    identifier,
    touchType,
  };
  Object.defineProperties(event, {
    changedTouches: { value: [sample] },
    touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : [sample] },
  });
  return event;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    toJSON: () => ({}),
    top,
    width,
    x: left,
    y: top,
  };
}

function contextFixture(
  strokeSpy = vi.fn(),
  clearRectSpy = vi.fn(),
  setTransformSpy = vi.fn(),
  previewSpies: {
    arc?: ReturnType<typeof vi.fn>;
    setLineDash?: ReturnType<typeof vi.fn>;
  } = {},
): CanvasRenderingContext2D {
  return {
    arc: previewSpies.arc ?? vi.fn(),
    beginPath: vi.fn(),
    clip: vi.fn(),
    clearRect: clearRectSpy,
    lineCap: 'round',
    lineJoin: 'round',
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    rect: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setLineDash: previewSpies.setLineDash ?? vi.fn(),
    setTransform: setTransformSpy,
    stroke: strokeSpy,
    strokeStyle: '#000',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
}
