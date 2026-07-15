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

  it('allocates only a viewport-high canvas and redraws only visible strokes after scroll', () => {
    const scrollContainer = document.createElement('div');
    const root = document.createElement('div');
    scrollContainer.append(root);
    document.body.append(scrollContainer);
    let rootTop = 0;
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockImplementation(() =>
      rect(0, 0, 960, 200),
    );
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => rect(0, rootTop, 960, 1200));
    let viewportHeight = 200;
    Object.defineProperty(scrollContainer, 'clientHeight', {
      configurable: true,
      get: () => viewportHeight,
    });
    const controller = new InkCanvasController({
      document,
      root,
      scrollContainer,
      session: new ViewportSession(surface([stroke('top', 100), stroke('bottom', 900)])),
    });
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
    if (committed === null) throw new Error('Missing committed Ink canvas.');
    const fixture = contexts.get(committed);

    expect(committed.height).toBe(200);
    expect(committed.style.height).toBe('200px');
    expect(committed.style.top).toBe('0px');
    expect(fixture?.moveTo).toHaveBeenCalledTimes(1);
    expect(fixture?.moveTo).toHaveBeenLastCalledWith(10, 100);

    rootTop = -800;
    scrollContainer.dispatchEvent(new Event('scroll'));

    expect(committed.style.top).toBe('800px');
    expect(fixture?.clearRect).toHaveBeenLastCalledWith(0, 0, 960, 200);
    expect(fixture?.moveTo).toHaveBeenCalledTimes(2);
    expect(fixture?.moveTo).toHaveBeenLastCalledWith(10, 100);

    viewportHeight = 300;
    window.dispatchEvent(new Event('resize'));

    expect(committed.height).toBe(300);
    expect(committed.style.height).toBe('300px');
    controller.dispose();
  });

  it('reattaches the live viewport canvas when Obsidian replaces the virtualized reading root', () => {
    const scrollContainer = document.createElement('div');
    const firstRoot = document.createElement('div');
    scrollContainer.append(firstRoot);
    document.body.append(scrollContainer);
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 200));
    vi.spyOn(firstRoot, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
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
    vi.spyOn(replacementRoot, 'getBoundingClientRect').mockReturnValue(rect(0, -800, 960, 1200));
    firstRoot.replaceWith(replacementRoot);
    controller.reattach(replacementRoot);

    expect(controller.isAttachedTo(firstRoot)).toBe(false);
    expect(controller.isAttachedTo(replacementRoot)).toBe(true);
    expect(scrollContainer.querySelector('.inkstone-ink-surface')).toBe(overlay);
    expect(scrollContainer.classList.contains('is-ink-mode')).toBe(true);
    expect(
      scrollContainer.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]')?.style.top,
    ).toBe('800px');
    expect(
      scrollContainer.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]')?.style
        .pointerEvents,
    ).toBe('auto');
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
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => rect(0, 0, 960, rootHeight));
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

interface ContextFixture {
  readonly clearRect: ReturnType<typeof vi.fn>;
  readonly context: CanvasRenderingContext2D;
  readonly moveTo: ReturnType<typeof vi.fn>;
}

function contextFixture(): ContextFixture {
  const clearRect = vi.fn();
  const moveTo = vi.fn();
  const context = {
    beginPath: vi.fn(),
    clearRect,
    lineCap: 'round',
    lineJoin: 'round',
    lineTo: vi.fn(),
    moveTo,
    scale: vi.fn(),
    stroke: vi.fn(),
    strokeStyle: '#000',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  return { clearRect, context, moveTo };
}
