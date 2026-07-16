// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import type { InkSurfaceSessionSnapshot } from '../application/ink-surface-session';
import {
  committedStrokeRenderDelta,
  InkCanvasController,
  nextActivePaintSegment,
} from './ink-canvas-controller';
import type { InkToolPreference } from '../storage/local-ink-tool-preference';

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
  });

  it('paints only the new tail of a long active stroke after the first frame', () => {
    const points = [
      { pressure: 0.5, time: 0, x: 0, y: 0 },
      { pressure: 0.5, time: 1, x: 1, y: 1 },
      { pressure: 0.5, time: 2, x: 2, y: 2 },
      { pressure: 0.5, time: 3, x: 3, y: 3 },
    ];

    expect(nextActivePaintSegment(points.slice(0, 2), 0)).toEqual({
      nextPaintedPointCount: 2,
      points: points.slice(0, 2),
    });
    expect(nextActivePaintSegment(points, 2)).toEqual({
      nextPaintedPointCount: 4,
      points: points.slice(1),
    });
  });

  it('appends a committed stroke without replaying an unchanged large prefix', () => {
    const first = stroke('first');
    const second = stroke('second');

    expect(committedStrokeRenderDelta([first], [first, second])).toEqual({
      kind: 'append',
      strokes: [second],
    });
    expect(committedStrokeRenderDelta([first, second], [first, second])).toEqual({
      kind: 'none',
      strokes: [],
    });
    expect(committedStrokeRenderDelta([first, second], [first])).toEqual({
      kind: 'full',
      strokes: [first],
    });
    expect(committedStrokeRenderDelta([first], [{ ...first, color: '#ffffff' }])).toEqual({
      kind: 'full',
      strokes: [{ ...first, color: '#ffffff' }],
    });
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

    expect(overlay?.hidden).toBe(true);
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
    expect(wheel.defaultPrevented).toBe(false);

    await controller.exit();
    expect(session.exitCalls).toBe(1);
    expect(active.style.pointerEvents).toBe('none');
    expect(root.querySelector<HTMLElement>('.inkstone-ink-controls')?.style.display).toBe('none');
    expect(root.classList.contains('is-ink-mode')).toBe(false);
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

  it('applies a visible width sample to the next stroke', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active Canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 1_200));

    controller.enter();
    root.querySelector<HTMLButtonElement>('button[aria-label="Show or hide Ink options"]')?.click();
    root.querySelector<HTMLElement>('[data-inkstone-ink-width-sample="8"]')?.click();
    root.dispatchEvent(pointer('pointerdown', 100, 100));
    root.dispatchEvent(pointer('pointerup', 100, 100));

    expect(session.strokes.at(-1)?.width).toBe(8);
    controller.dispose();
  });

  it('replaces the complete Canvas transform when actual rendered scale changes', () => {
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

    expect(committedTransformSpy).toHaveBeenCalledWith(0.9, 0, 0, 0.9, 183.2, 0);
    expect(activeTransformSpy).toHaveBeenCalledWith(0.9, 0, 0, 0.9, 183.2, 0);
    controller.dispose();
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

  it('scales the accepted 100% document-origin inset instead of keeping it in client pixels', () => {
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

    expect(layoutRoot.style.getPropertyValue('--inkstone-ink-scale')).toBe('0.5');
    expect(transformSpy).toHaveBeenCalledWith(0.5, 0, 0, 0.5, 196, 12);
    expect(root.querySelector<HTMLElement>('.inkstone-ink-surface')?.style.top).toBe('40px');
    controller.dispose();
  });

  it('normalizes a compatibility inset recaptured after a 50% Reading View host replacement', () => {
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
    expect(transformSpy.mock.calls.filter(([scale]) => scale === 0.5).at(-1)).toEqual([
      0.5, 0, 0, 0.5, 196, 12,
    ]);

    controller.reattach(replacementLayout, replacementHost, replacementHost);

    expect(transformSpy.mock.calls.filter(([scale]) => scale === 0.5).at(-1)).toEqual([
      0.5, 0, 0, 0.5, 196, 12,
    ]);
    controller.dispose();
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
    controller.sync(session.snapshot());

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

  it('reports pointer-to-presented-frame latency without exposing stroke points', () => {
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
    expect(samples).toEqual([]);
    now = 116;
    frames.shift()?.(now);

    expect(samples).toEqual([16]);
  });

  it('routes touch input to reading instead of starting a desktop stroke', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();

    const touchStart = pointer('pointerdown', 10, 20, 'touch');
    root.dispatchEvent(touchStart);
    root.dispatchEvent(pointer('pointerup', 20, 30, 'touch'));

    expect(session.strokes).toEqual([]);
    expect(touchStart.defaultPrevented).toBe(false);
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

  it('keeps the palette in deterministic keyboard order with names, tooltips, and live status', () => {
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

    expect(controls?.hasAttribute('data-inkstone-ink-toolbar-app')).toBe(true);
    expect(controls?.getAttribute('role')).toBe('toolbar');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Move Ink toolbar',
      'Exit Ink Mode',
      'Pen',
      'Highlighter',
      'Stroke eraser',
      'Select and move Ink',
      'Select multiple Ink strokes',
      'Set Ink width to 2 px',
      'Set Ink width to 4 px',
      'Set Ink width to 8 px',
      'Zoom Ink workspace out',
      'Fit Ink workspace to pane · 100%',
      'Zoom Ink workspace in',
      'Undo Ink change',
      'Redo Ink change',
      'Show or hide Ink options',
      'Retry local Ink save',
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
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Ink color');
    expect(root.querySelector<HTMLInputElement>('[aria-label="Ink color"]')?.hidden).toBe(false);
    more?.click();
    expect(root.querySelector<HTMLInputElement>('[aria-label="Ink color"]')?.hidden).toBe(true);
  });

  it('moves the compact floating palette by its drag handle and keeps it in the viewport', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
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

    handle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }));
    expect(controls.style.left).toBe('752px');
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

  it('delegates the palette Exit button to the host Ink mode lifecycle', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const requests: string[] = [];
    const controller = new InkCanvasController({
      document,
      onExitRequested: () => {
        requests.push('exit');
        return Promise.resolve();
      },
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();

    root.querySelector<HTMLButtonElement>('button[aria-label="Exit Ink Mode"]')?.click();
    await vi.waitFor(() => expect(requests).toEqual(['exit']));
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
  cancelCalls = 0;
  clearCalls = 0;
  commitCalls = 0;
  eraseCalls = 0;
  enterCalls = 0;
  exitCalls = 0;
  failExit = false;
  hoverCalls: Array<{ x: number; y: number }> = [];
  retryCalls = 0;
  redoCalls = 0;
  previewCalls: Array<{ dx: number; dy: number }> = [];
  private previewBaseStrokes: InkStroke[] | null = null;
  private selected = false;
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
    const changed = this.selected || this.previewBaseStrokes !== null;
    this.selected = false;
    this.previewBaseStrokes = null;
    return changed;
  }

  commitSelectionMove(): boolean {
    this.commitCalls += 1;
    this.previewBaseStrokes = null;
    return true;
  }

  previewSelectionMove(dx: number, dy: number): { readonly dx: number; readonly dy: number } {
    this.previewCalls.push({ dx, dy });
    this.previewBaseStrokes ??= this.strokes;
    const selectedId = this.previewBaseStrokes[0]?.id;
    this.strokes = this.previewBaseStrokes.map((candidate) =>
      candidate.id === selectedId
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
    this.selected = this.strokes.length > 0;
    return this.selected ? [this.strokes[0]?.id ?? ''] : [];
  }

  selectedStrokeIds(): readonly string[] {
    return !this.selected || this.strokes.length === 0 ? [] : [this.strokes[0]?.id ?? ''];
  }

  strokeIdAt(point: { readonly x: number; readonly y: number }): string | null {
    this.hoverCalls.push({ x: point.x, y: point.y });
    return this.strokes[0]?.id ?? null;
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

  redo(): boolean {
    this.redoCalls += 1;
    return true;
  }

  undo(): boolean {
    this.undoCalls += 1;
    return true;
  }
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

function pointer(type: string, x: number, y: number, pointerType = 'mouse'): Event {
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
    pointerType: { value: pointerType },
    pressure: { value: pointerType === 'pen' ? 0.7 : 0 },
    tiltX: { value: 0 },
    tiltY: { value: 0 },
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
): CanvasRenderingContext2D {
  return {
    beginPath: vi.fn(),
    clearRect: clearRectSpy,
    lineCap: 'round',
    lineJoin: 'round',
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setTransform: setTransformSpy,
    stroke: strokeSpy,
    strokeStyle: '#000',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
}
