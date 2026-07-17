// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InkSurfaceSessionSnapshot } from '../application/ink-surface-session';
import type { InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import { InkCanvasController } from './ink-canvas-controller';

describe('Ink canvas viewport rendering', () => {
  const contexts = new WeakMap<HTMLCanvasElement, ContextFixture>();

  beforeEach(() => {
    document.body.replaceChildren();
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

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps top-padding Ink aligned while the document origin is above the pane origin', () => {
    const scrollContainer = document.createElement('div');
    const root = document.createElement('div');
    scrollContainer.append(root);
    document.body.append(scrollContainer);
    let rootTop = 32;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockImplementation(() =>
      rect(0, 0, 960, 200),
    );
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => rect(0, rootTop, 704, 1200));
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 200 },
      clientWidth: { configurable: true, value: 960 },
    });
    const controller = new InkCanvasController({
      document,
      root,
      scrollContainer,
      session: new ViewportSession(surface([stroke('origin', 0)])),
    });
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    if (committed === null) throw new Error('Missing committed Ink canvas.');
    const fixture = contexts.get(committed);

    expect(fixture?.moveTo).toHaveBeenLastCalledWith(10, 0);
    expect(fixture?.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 32);

    rootTop = 16;
    scrollContainer.dispatchEvent(new Event('scroll'));
    expect(fixture?.moveTo).toHaveBeenLastCalledWith(10, 0);
    expect(fixture?.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 16);

    rootTop = 0;
    scrollContainer.dispatchEvent(new Event('scroll'));
    expect(fixture?.moveTo).toHaveBeenLastCalledWith(10, 0);
    expect(fixture?.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    controller.dispose();
  });

  it('treats native scrolling as a read-only viewport change', () => {
    const scrollContainer = document.createElement('div');
    const layoutRoot = document.createElement('div');
    scrollContainer.append(layoutRoot);
    document.body.append(scrollContainer);
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 560, 200));
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockReturnValue(rect(8, -400, 528, 1_200));
    Object.defineProperties(scrollContainer, {
      clientHeight: { value: 200 },
      clientWidth: { value: 560 },
    });
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root: scrollContainer,
      scrollContainer,
      session: new ViewportSession(surface([stroke('visible', 500)])),
    });
    controller.enter();
    const committed = scrollContainer.querySelector<HTMLCanvasElement>(
      '[data-inkstone-ink-committed]',
    );
    if (committed === null) throw new Error('Missing committed Ink canvas.');
    const workspaceScaleWrites = vi.spyOn(layoutRoot.style, 'setProperty').mockClear();
    const canvasMeasurements = vi
      .spyOn(committed, 'getBoundingClientRect')
      .mockReturnValue(rect(0, 0, 560, 200));

    scrollContainer.dispatchEvent(new Event('scroll'));

    expect(
      workspaceScaleWrites.mock.calls.filter(([name]) => name === '--inkstone-ink-scale'),
    ).toEqual([]);
    expect(canvasMeasurements).not.toHaveBeenCalled();

    workspaceScaleWrites.mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(
      workspaceScaleWrites.mock.calls.filter(([name]) => name === '--inkstone-ink-scale'),
    ).toEqual([]);
    controller.dispose();
  });

  it('clears and redraws the active stroke from logical points when the Stage Frame changes', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const scrollContainer = document.createElement('div');
    const root = document.createElement('div');
    scrollContainer.append(root);
    document.body.append(scrollContainer);
    let rootTop = 0;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 200));
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => rect(0, rootTop, 704, 1200));
    Object.defineProperties(scrollContainer, {
      clientHeight: { value: 200 },
      clientWidth: { value: 960 },
    });
    const controller = new InkCanvasController({
      document,
      root,
      scrollContainer,
      session: new ViewportSession(surface([])),
    });
    controller.enter();
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active Ink canvas.');
    const fixture = contexts.get(active);
    scrollContainer.dispatchEvent(pointer('pointerdown', 10, 50));
    const clearsBeforeScroll = fixture?.clearRect.mock.calls.length ?? 0;
    const paintsBeforeScroll = fixture?.moveTo.mock.calls.length ?? 0;

    rootTop = -20;
    scrollContainer.dispatchEvent(new Event('scroll'));

    expect(fixture?.clearRect.mock.calls.length).toBeGreaterThan(clearsBeforeScroll);
    expect(fixture?.moveTo.mock.calls.length).toBeGreaterThan(paintsBeforeScroll);
    expect(fixture?.moveTo).toHaveBeenLastCalledWith(10, 50);
    controller.dispose();
  });

  it('allocates only a viewport-high canvas and redraws only visible strokes after scroll', () => {
    const scrollContainer = document.createElement('div');
    const root = document.createElement('div');
    scrollContainer.append(root);
    document.body.append(scrollContainer);
    let rootTop = 0;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockImplementation(() =>
      rect(0, 0, 960, 200),
    );
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => rect(0, rootTop, 704, 1200));
    let viewportHeight = 200;
    Object.defineProperty(scrollContainer, 'clientHeight', {
      configurable: true,
      get: () => viewportHeight,
    });
    const controller = new InkCanvasController({
      document,
      root,
      scrollContainer,
      session: new ViewportSession(
        surface([stroke('top', 100), stroke('bottom', 900), stroke('near-end', 1_100)]),
      ),
    });
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    if (committed === null) throw new Error('Missing committed Ink canvas.');
    const fixture = contexts.get(committed);

    expect(committed.height).toBe(200);
    expect(committed.style.height).toBe('100%');
    expect(committed.style.top).toBe('0px');
    expect(fixture?.moveTo).toHaveBeenCalledTimes(1);
    expect(fixture?.moveTo).toHaveBeenLastCalledWith(10, 100);

    rootTop = -800;
    scrollContainer.dispatchEvent(new Event('scroll'));

    expect(committed.style.top).toBe('0px');
    expect(fixture?.clearRect).toHaveBeenLastCalledWith(0, 0, 960, 200);
    expect(fixture?.moveTo).toHaveBeenCalledTimes(2);
    expect(fixture?.moveTo).toHaveBeenLastCalledWith(10, 900);
    expect(fixture?.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, -800);

    rootTop = -1_100;
    scrollContainer.dispatchEvent(new Event('scroll'));

    expect(fixture?.moveTo).toHaveBeenCalledTimes(3);
    expect(fixture?.moveTo).toHaveBeenLastCalledWith(10, 1_100);
    expect(fixture?.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, -1_100);

    viewportHeight = 300;
    window.dispatchEvent(new Event('resize'));

    expect(committed.height).toBe(300);
    expect(committed.style.height).toBe('100%');
    controller.dispose();
  });

  it('preserves the same logical viewport top when pane resize changes Fit scale', () => {
    const scrollContainer = document.createElement('div');
    const layoutRoot = document.createElement('div');
    scrollContainer.append(layoutRoot);
    document.body.append(scrollContainer);
    let paneWidth = 744;
    const scale = () => Math.max(0.5, Math.min(1, (paneWidth - 40) / 704));
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockImplementation(() =>
      rect(0, 0, paneWidth, 200),
    );
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockImplementation(() =>
      rect(20, -scrollContainer.scrollTop, 704 * scale(), 1_200 * scale()),
    );
    Object.defineProperties(scrollContainer, {
      clientHeight: { value: 200 },
      clientWidth: { get: () => paneWidth },
    });
    Object.defineProperty(layoutRoot, 'offsetWidth', { value: 704 });
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root: scrollContainer,
      scrollContainer,
      session: new ViewportSession(surface([])),
    });
    controller.enter();
    scrollContainer.scrollTop = 300;
    scrollContainer.dispatchEvent(new Event('scroll'));

    paneWidth = 560;
    scrollContainer.scrollTop = 0;
    window.dispatchEvent(new Event('resize'));

    expect(scrollContainer.scrollTop).toBeCloseTo(300 * scale());
    controller.dispose();
  });

  it('preserves the same logical viewport top across manual zoom', () => {
    const scrollContainer = document.createElement('div');
    const layoutRoot = document.createElement('div');
    scrollContainer.append(layoutRoot);
    document.body.append(scrollContainer);
    const scale = () => Number(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')) || 1;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 200));
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockImplementation(() =>
      rect(128, -scrollContainer.scrollTop, 704 * scale(), 1_200 * scale()),
    );
    Object.defineProperties(scrollContainer, {
      clientHeight: { value: 200 },
      clientWidth: { value: 960 },
    });
    Object.defineProperty(layoutRoot, 'offsetWidth', { value: 704 });
    const controller = new InkCanvasController({
      document,
      layoutRoot,
      root: scrollContainer,
      scrollContainer,
      session: new ViewportSession(surface([])),
    });
    controller.enter();
    scrollContainer.scrollTop = 300;
    scrollContainer.dispatchEvent(new Event('scroll'));

    scrollContainer.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-out]')?.click();

    expect(scale()).toBe(0.9);
    expect(scrollContainer.scrollTop).toBeCloseTo(270);
    controller.dispose();
  });

  it('reattaches the live viewport canvas when Obsidian replaces the virtualized reading root', () => {
    const scrollContainer = document.createElement('div');
    const firstRoot = document.createElement('div');
    scrollContainer.append(firstRoot);
    document.body.append(scrollContainer);
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 200));
    vi.spyOn(firstRoot, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 1200));
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200 });
    const controller = new InkCanvasController({
      document,
      layoutRoot: firstRoot,
      root: scrollContainer,
      scrollContainer,
      session: new ViewportSession(surface([])),
    });
    expect(controller.coversHeight(1200)).toBe(true);
    expect(controller.coversHeight(1201)).toBe(false);
    controller.enter();
    const overlay = scrollContainer.querySelector<HTMLElement>('.inkstone-ink-surface');
    if (overlay === null) throw new Error('Missing initial Ink overlay.');
    expect(controller.isAttachedTo(firstRoot)).toBe(true);

    const replacementRoot = document.createElement('div');
    vi.spyOn(replacementRoot, 'getBoundingClientRect').mockReturnValue(rect(0, -800, 704, 1200));
    firstRoot.replaceWith(replacementRoot);
    controller.reattach(replacementRoot);

    expect(controller.isAttachedTo(firstRoot)).toBe(false);
    expect(controller.isAttachedTo(replacementRoot)).toBe(true);
    expect(scrollContainer.querySelector('.inkstone-ink-surface')).toBe(overlay);
    expect(scrollContainer.classList.contains('is-ink-mode')).toBe(true);
    expect(
      scrollContainer.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]')?.style.top,
    ).toBe('0px');
    expect(
      scrollContainer.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]')?.style
        .pointerEvents,
    ).toBe('none');
    controller.dispose();
  });

  it('migrates the viewport Canvas and listeners when Obsidian replaces the Reading View host', () => {
    const firstScrollContainer = document.createElement('div');
    const firstRoot = document.createElement('div');
    firstScrollContainer.append(firstRoot);
    document.body.append(firstScrollContainer);
    let firstRootTop = 0;
    vi.spyOn(firstScrollContainer, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 200));
    vi.spyOn(firstRoot, 'getBoundingClientRect').mockImplementation(() =>
      rect(0, firstRootTop, 704, 1_200),
    );
    Object.defineProperties(firstScrollContainer, {
      clientHeight: { value: 200 },
      clientWidth: { value: 960 },
    });
    const controller = new InkCanvasController({
      document,
      layoutRoot: firstRoot,
      root: firstScrollContainer,
      scrollContainer: firstScrollContainer,
      session: new ViewportSession(surface([stroke('saved', 100)])),
    });
    controller.enter();
    const overlay = firstScrollContainer.querySelector<HTMLElement>('.inkstone-ink-surface');
    const committed = firstScrollContainer.querySelector<HTMLCanvasElement>(
      '[data-inkstone-ink-committed]',
    );
    if (overlay === null || committed === null) throw new Error('Missing initial Ink renderer.');
    const fixture = contexts.get(committed);
    firstScrollContainer.scrollTop = 400;
    firstRootTop = -400;
    firstScrollContainer.dispatchEvent(new Event('scroll'));

    const replacementScrollContainer = document.createElement('div');
    const replacementRoot = document.createElement('div');
    replacementScrollContainer.append(replacementRoot);
    document.body.append(replacementScrollContainer);
    let replacementRootTop = 0;
    vi.spyOn(replacementScrollContainer, 'getBoundingClientRect').mockReturnValue(
      rect(100, 0, 800, 200),
    );
    vi.spyOn(replacementRoot, 'getBoundingClientRect').mockImplementation(() =>
      rect(148, replacementRootTop, 704, 1_200),
    );
    Object.defineProperties(replacementScrollContainer, {
      clientHeight: { value: 200 },
      clientWidth: { value: 800 },
    });

    controller.reattach(replacementRoot, replacementScrollContainer, replacementScrollContainer);

    expect(
      controller.isAttachedTo(
        replacementRoot,
        replacementScrollContainer,
        replacementScrollContainer,
      ),
    ).toBe(true);
    expect(overlay.parentElement).toBe(replacementScrollContainer);
    expect(firstScrollContainer.classList.contains('is-ink-mode')).toBe(false);
    expect(replacementScrollContainer.classList.contains('is-ink-mode')).toBe(true);
    expect(replacementScrollContainer.scrollTop).toBe(400);

    fixture?.setTransform.mockClear();
    firstRootTop = -100;
    firstScrollContainer.dispatchEvent(new Event('scroll'));
    expect(fixture?.setTransform).not.toHaveBeenCalled();

    replacementRootTop = -100;
    replacementScrollContainer.dispatchEvent(new Event('scroll'));
    expect(fixture?.setTransform).toHaveBeenCalled();
    controller.dispose();
  });

  it('reports late virtualized layout growth so the manager can rebuild empty partitions', () => {
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
    const scrollContainer = document.createElement('div');
    const root = document.createElement('div');
    scrollContainer.append(root);
    document.body.append(scrollContainer);
    let rootHeight = 1200;
    Object.defineProperty(root, 'scrollHeight', { get: () => rootHeight });
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => rect(0, 0, 704, rootHeight));
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 200));
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 200 });
    const extents: number[] = [];
    const controller = new InkCanvasController({
      document,
      onLayoutExtentChanged: (height) => extents.push(height),
      root,
      scrollContainer,
      session: new ViewportSession(surface([])),
    });

    rootHeight = 1600;
    resize?.([], {} as ResizeObserver);

    expect(extents).toEqual([1600]);
    controller.dispose();
  });

  it('does not divide logical extent by zoom in Ink edit or after returning to raw view', async () => {
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
    const scrollContainer = document.createElement('div');
    const root = document.createElement('div');
    scrollContainer.append(root);
    document.body.append(scrollContainer);
    Object.defineProperty(root, 'scrollHeight', { value: 1200 });
    Object.defineProperties(scrollContainer, {
      clientHeight: { value: 600 },
      clientWidth: { value: 744 },
    });
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 744, 600));
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => {
      const scale = Number(root.style.getPropertyValue('--inkstone-ink-scale')) || 1;
      return rect((744 - 704 * scale) / 2, 0, 704 * scale, 1200 * scale);
    });
    const extents: number[] = [];
    const controller = new InkCanvasController({
      document,
      layoutRoot: root,
      onLayoutExtentChanged: (height) => extents.push(height),
      root: scrollContainer,
      scrollContainer,
      session: new ViewportSession(surface([])),
    });
    controller.enter();
    for (let index = 0; index < 5; index += 1) {
      scrollContainer.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-out]')?.click();
    }

    resize?.([], {} as ResizeObserver);

    expect(root.style.getPropertyValue('--inkstone-ink-scale')).toBe('0.5');
    expect(extents).toEqual([]);

    await controller.exit('raw');
    resize?.([], {} as ResizeObserver);

    expect(root.style.getPropertyValue('--inkstone-ink-scale')).toBe('');
    expect(extents).toEqual([]);
    controller.dispose();
  });

  it('restores raw Reading View scroll synchronously before the controller is disposed', async () => {
    const scrollContainer = document.createElement('div');
    const root = document.createElement('div');
    scrollContainer.append(root);
    document.body.append(scrollContainer);
    Object.defineProperties(scrollContainer, {
      clientHeight: { value: 200 },
      clientWidth: { value: 744 },
      scrollHeight: {
        get: () => (root.classList.contains('inkstone-ink-workspace') ? 2_000 : 1_200),
      },
    });
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 744, 200));
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(20, 0, 704, 1_200));
    const controller = new InkCanvasController({
      document,
      layoutRoot: root,
      root: scrollContainer,
      scrollContainer,
      session: new ViewportSession(surface([])),
    });
    controller.enter();
    scrollContainer.scrollTop = 900;
    const queuedFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });

    await controller.exit('raw');

    expect(scrollContainer.scrollTop).toBe(500);
    controller.dispose();
  });
});

class ViewportSession {
  constructor(private readonly record: InkSurfaceRecord) {}

  addStroke(): void {}
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
  retry(): Promise<void> {
    return Promise.resolve();
  }
  snapshot(): InkSurfaceSessionSnapshot {
    return {
      persistence: { kind: 'idle' },
      state: { dirty: false, kind: 'ink-mode', saveError: null },
      surface: this.record,
    };
  }
  undo(): boolean {
    return false;
  }
}

function surface(strokes: readonly InkStroke[]): InkSurfaceRecord {
  return {
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Long.md',
    id: 'surface',
    layout: {
      blockFingerprints: ['a'],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1200,
      logicalWidth: 960,
      sourceRevision: 'source',
      themeMode: 'light',
    },
    noteId: 'note',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes,
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}

function stroke(id: string, y: number): InkStroke {
  return {
    color: '#111111',
    id,
    points: [
      { pressure: 0.5, time: 0, x: 10, y },
      { pressure: 0.5, time: 1, x: 20, y: y + 20 },
    ],
    tool: 'pen',
    width: 4,
  };
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

function pointer(type: string, x: number, y: number): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    getCoalescedEvents: { value: () => [event] },
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
    pressure: { value: 0 },
    tiltX: { value: 0 },
    tiltY: { value: 0 },
  });
  return event;
}

interface ContextFixture {
  readonly clearRect: ReturnType<typeof vi.fn>;
  readonly context: CanvasRenderingContext2D;
  readonly moveTo: ReturnType<typeof vi.fn>;
  readonly setTransform: ReturnType<typeof vi.fn>;
}

function contextFixture(): ContextFixture {
  const clearRect = vi.fn();
  const moveTo = vi.fn();
  const setTransform = vi.fn();
  const context = {
    beginPath: vi.fn(),
    clearRect,
    lineCap: 'round',
    lineJoin: 'round',
    lineTo: vi.fn(),
    moveTo,
    restore: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setTransform,
    stroke: vi.fn(),
    strokeStyle: '#000',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  return { clearRect, context, moveTo, setTransform };
}
