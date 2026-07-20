// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { InkPreviewProjection } from '../application/ink-preview-projection';
import type { InkSurfaceRecord } from '../domain/ink-surface';
import { InkPerformanceDiagnostics } from '../runtime/ink-performance-diagnostics';
import { InkWorkScheduler } from '../runtime/ink-work-scheduler';
import type { InkPreviewCacheKey } from '../storage/indexeddb-ink-preview-cache';
import { InkGeometryCacheCoordinator } from './ink-geometry-cache';
import { InkPreviewProjectionController } from './ink-preview-projection-controller';

describe('InkPreviewProjectionController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('presents canonical Preview with one committed canvas and no editable UI or Active canvases', async () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const scroll = document.createElement('div');
    const root = document.createElement('div');
    scroll.append(root);
    document.body.append(scroll);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 512, 512));
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 960, 900));
    const controller = new InkPreviewProjectionController({
      document,
      projection: new InkPreviewProjection([surface()]),
      requestFrame: (callback) => {
        callback(0);
        return 1;
      },
      root,
      scrollContainer: scroll,
    });

    controller.showPreview();

    expect(root.querySelectorAll('[data-inkstone-ink-preview-canvas]')).toHaveLength(1);
    expect(root.querySelector('[data-inkstone-ink-toolbar-host]')).toBeNull();
    expect(root.querySelector('[data-inkstone-ink-active]')).toBeNull();
    expect(root.querySelector('[data-inkstone-ink-active-stable]')).toBeNull();
    await vi.waitFor(() => expect(canvasCalls(context, 'stroke')).not.toHaveLength(0));
    controller.dispose();
  });

  it('shares the fixed containing-block document origin with editable Stage coordinates', () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const scroll = document.createElement('div');
    const root = document.createElement('div');
    const layoutRoot = document.createElement('div');
    scroll.append(root);
    root.append(layoutRoot);
    document.body.append(scroll);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 124, 744, 1_009));
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 124, 744, 1_009));
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockReturnValue(new DOMRect(24, 132, 704, 900));
    let drawFrame: FrameRequestCallback | null = null;
    const canonical = surface();
    const controller = new InkPreviewProjectionController({
      document,
      layoutRoot,
      projection: new InkPreviewProjection([
        { ...canonical, layout: { ...canonical.layout, logicalWidth: 704 } },
      ]),
      requestFrame: (callback) => {
        drawFrame = callback;
        return 1;
      },
      root,
      scrollContainer: scroll,
    });
    const overlay = root.querySelector<HTMLElement>('[data-inkstone-ink-preview-projection]');
    expect(overlay).not.toBeNull();
    vi.spyOn(overlay!, 'getBoundingClientRect').mockImplementation(() => {
      const left = Number.parseFloat(overlay!.style.left || '0');
      const top = Number.parseFloat(overlay!.style.top || '0');
      const width = Number.parseFloat(overlay!.style.width || '0');
      const height = Number.parseFloat(overlay!.style.height || '0');
      // iOS WKWebView can resolve fixed descendants against a transformed containing block.
      return new DOMRect(left, top + 72, width, height);
    });

    controller.showPreview();
    expect(drawFrame).not.toBeNull();
    drawFrame!(0);

    expect(overlay!.style.left).toBe('0px');
    expect(overlay!.style.top).toBe('52px');
    expect(overlay!.getBoundingClientRect().top).toBe(124);
    expect(
      (
        context.setTransform as unknown as {
          readonly mock: { readonly calls: readonly unknown[][] };
        }
      ).mock.calls.at(-1),
    ).toEqual([1, 0, 0, 1, 24, -44]);
    controller.dispose();
  });

  it('presents pane-wide strokes outside the Markdown document bounds', async () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const scroll = document.createElement('div');
    const layoutRoot = document.createElement('div');
    scroll.append(layoutRoot);
    document.body.append(scroll);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1_000, 600));
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockReturnValue(new DOMRect(148, 0, 704, 900));
    const canonical = surface();
    const controller = new InkPreviewProjectionController({
      document,
      layoutRoot,
      projection: new InkPreviewProjection([
        {
          ...canonical,
          layout: { ...canonical.layout, logicalWidth: 704 },
          strokes: [
            {
              ...canonical.strokes[0]!,
              points: [
                { pressure: 0.5, time: 1, x: -120, y: 20 },
                { pressure: 0.5, time: 2, x: -40, y: 80 },
              ],
            },
          ],
        },
      ]),
      requestFrame: (callback) => {
        callback(0);
        return 1;
      },
      root: scroll,
      scrollContainer: scroll,
    });

    controller.showPreview();

    await vi.waitFor(() => expect(canvasCalls(context, 'stroke')).not.toHaveLength(0));
    const overlay = scroll.querySelector<HTMLElement>('[data-inkstone-ink-preview-projection]');
    expect(overlay?.style.left).toBe('0px');
    expect(overlay?.style.width).toBe('1000px');
    controller.dispose();
  });

  it('retains the presented bitmap until a scrolled replacement is ready', async () => {
    const contexts = new Map<HTMLCanvasElement, CanvasRenderingContext2D>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing;
      const created = canvasContext();
      contexts.set(this, created);
      return created;
    });
    const frames: FrameRequestCallback[] = [];
    const deferredYield: { release?: () => void } = {};
    let stallVisibleWork = false;
    const workScheduler = new InkWorkScheduler({
      yieldToHost: () =>
        stallVisibleWork
          ? new Promise<void>((resolve) => {
              deferredYield.release = resolve;
            })
          : Promise.resolve(),
    });
    const scroll = document.createElement('div');
    const layoutRoot = document.createElement('div');
    scroll.append(layoutRoot);
    document.body.append(scroll);
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 1_000 },
    });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1_000, 600));
    let documentTop = 0;
    vi.spyOn(layoutRoot, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(148, documentTop, 704, 1_200),
    );
    const controller = new InkPreviewProjectionController({
      document,
      layoutRoot,
      projection: new InkPreviewProjection([surface()]),
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      root: scroll,
      scrollContainer: scroll,
      workScheduler,
    });

    controller.showPreview();
    frames.shift()?.(0);
    await vi.waitFor(() => {
      const visible = scroll.querySelector<HTMLCanvasElement>('[data-inkstone-ink-preview-canvas]');
      const context = visible === null ? undefined : contexts.get(visible);
      expect(context === undefined ? [] : canvasCalls(context, 'stroke')).not.toHaveLength(0);
    });
    const presented = scroll.querySelector<HTMLCanvasElement>('[data-inkstone-ink-preview-canvas]');
    if (presented === null) throw new Error('Missing presented Preview Canvas.');
    const presentedContext = contexts.get(presented);
    if (presentedContext === undefined) throw new Error('Missing presented Preview context.');
    const clearsBeforeScroll = (
      presentedContext.clearRect as unknown as { readonly mock: { readonly calls: unknown[][] } }
    ).mock.calls.length;
    const backingBeforeScroll = { height: presented.height, width: presented.width };

    stallVisibleWork = true;
    documentTop = -80;
    scroll.dispatchEvent(new Event('scroll'));
    frames.shift()?.(16);

    expect(scroll.querySelector('[data-inkstone-ink-preview-canvas]')).toBe(presented);
    expect(presented.hidden).toBe(false);
    expect(presented.style.transform).toContain('translate3d(0px, -80px, 0)');
    expect(presented.width).toBe(backingBeforeScroll.width);
    expect(presented.height).toBe(backingBeforeScroll.height);
    expect(
      (
        presentedContext.clearRect as unknown as {
          readonly mock: { readonly calls: unknown[][] };
        }
      ).mock.calls,
    ).toHaveLength(clearsBeforeScroll);

    stallVisibleWork = false;
    deferredYield.release?.();
    await vi.waitFor(() =>
      expect(scroll.querySelector('[data-inkstone-ink-preview-canvas]')).not.toBe(presented),
    );
    expect(presented.hidden).toBe(true);
    controller.dispose();
  });

  it('presents canonical physical Pen candidate pixels in Preview', async () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const root = document.createElement('div');
    document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 512, 512));
    const controller = new InkPreviewProjectionController({
      document,
      projection: new InkPreviewProjection([physicalSurface()]),
      requestFrame: (callback) => {
        callback(0);
        return 1;
      },
      root,
    });

    controller.showPreview();

    await vi.waitFor(() => expect(canvasCalls(context, 'fill')).not.toHaveLength(0));
    controller.dispose();
  });

  it('presents an exact cached tile without compiling canonical Geometry', async () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const scroll = document.createElement('div');
    const root = document.createElement('div');
    scroll.append(root);
    document.body.append(scroll);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 512, 512));
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 960, 900));
    const cacheKey: InkPreviewCacheKey = {
      alphaContract: 'premultiplied-transparent-v1',
      colorSpace: 'srgb',
      devicePixelRatio: 1,
      logicalTileSize: 512,
      noteIdentity: 'note',
      rendererVersion: 'renderer',
      scaleBucket: 1,
      surfaceSetDigest: 'exact',
      vaultIdentity: 'vault',
    };
    const load = vi.fn(() =>
      Promise.resolve({
        generation: 'cached',
        tiles: [{ byteLength: 1, bytes: Uint8Array.of(1).buffer, x: 0, y: 0 }],
      }),
    );
    const close = vi.fn();
    const bitmap = { close } as unknown as CanvasImageSource;
    const controller = new InkPreviewProjectionController({
      cache: { load, publish: vi.fn(() => Promise.resolve(true)) },
      cacheKey,
      decodeTile: () => Promise.resolve(bitmap),
      document,
      projection: new InkPreviewProjection([surface()]),
      requestFrame: (callback) => {
        callback(0);
        return 1;
      },
      root,
      scrollContainer: scroll,
    });

    controller.showPreview();
    await vi.waitFor(() => expect(canvasCalls(context, 'drawImage')).not.toHaveLength(0));

    expect(load).toHaveBeenCalledWith(cacheKey);
    expect(canvasCalls(context, 'stroke')).toHaveLength(0);
    expect(close).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('treats corrupt cached bytes as a miss and progressively renders canonical pixels', async () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(null),
    );
    const root = document.createElement('div');
    document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 512, 512));
    const controller = new InkPreviewProjectionController({
      cache: {
        load: () =>
          Promise.resolve({
            generation: 'corrupt',
            tiles: [{ byteLength: 1, bytes: Uint8Array.of(1).buffer, x: 0, y: 0 }],
          }),
        publish: () => Promise.resolve(false),
      },
      cacheKey: {
        alphaContract: 'premultiplied-transparent-v1',
        colorSpace: 'srgb',
        devicePixelRatio: 1,
        logicalTileSize: 512,
        noteIdentity: 'note',
        rendererVersion: 'renderer',
        scaleBucket: 1,
        surfaceSetDigest: 'exact',
        vaultIdentity: 'vault',
      },
      decodeTile: () => Promise.reject(new Error('corrupt PNG')),
      document,
      projection: new InkPreviewProjection([surface()]),
      requestFrame: (callback) => {
        callback(0);
        return 1;
      },
      root,
    });

    controller.showPreview();
    await vi.waitFor(() => expect(canvasCalls(context, 'stroke')).not.toHaveLength(0));

    expect(canvasCalls(context, 'drawImage')).toHaveLength(0);
    controller.dispose();
  });

  it('does not let a stalled disposable cache read block canonical Preview pixels', async () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const root = document.createElement('div');
    document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 512, 512));
    const controller = new InkPreviewProjectionController({
      cache: {
        load: () => new Promise(() => undefined),
        publish: () => Promise.resolve(false),
      },
      cacheKey: {
        alphaContract: 'premultiplied-transparent-v1',
        colorSpace: 'srgb',
        devicePixelRatio: 1,
        logicalTileSize: 512,
        noteIdentity: 'note',
        rendererVersion: 'renderer',
        scaleBucket: 1,
        surfaceSetDigest: 'exact',
        vaultIdentity: 'vault',
      },
      document,
      projection: new InkPreviewProjection([surface()]),
      requestFrame: (callback) => {
        callback(0);
        return 1;
      },
      root,
    });

    controller.showPreview();

    await vi.waitFor(() => expect(canvasCalls(context, 'stroke')).not.toHaveLength(0), {
      timeout: 1_000,
    });
    controller.dispose();
  });

  it('publishes stable visible tiles as best-effort cold work after a cache miss', async () => {
    const diagnostics = new InkPerformanceDiagnostics(true);
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const encode = vi.fn(() => Promise.resolve(Uint8Array.of(1, 2, 3).buffer));
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext(): CanvasRenderingContext2D {
          return context;
        }
      },
    );
    vi.stubGlobal('scheduler', {
      postTask: (callback: () => void) => Promise.resolve().then(callback),
    });
    const scroll = document.createElement('div');
    const root = document.createElement('div');
    scroll.append(root);
    document.body.append(scroll);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 512, 512));
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 960, 900));
    const publish = vi.fn(() => Promise.resolve(true));
    const cacheKey: InkPreviewCacheKey = {
      alphaContract: 'premultiplied-transparent-v1',
      colorSpace: 'srgb',
      devicePixelRatio: 1,
      logicalTileSize: 512,
      noteIdentity: 'note',
      rendererVersion: 'renderer',
      scaleBucket: 1,
      surfaceSetDigest: 'exact',
      vaultIdentity: 'vault',
    };
    const controller = new InkPreviewProjectionController({
      cache: { load: () => Promise.resolve(null), publish },
      cacheKey,
      document,
      inkPerformance: diagnostics,
      projection: new InkPreviewProjection([surface()]),
      requestFrame: (callback) => {
        callback(0);
        return 1;
      },
      root,
      scrollContainer: scroll,
      tileEncoder: { dispose: vi.fn(), encode },
    });

    controller.showPreview();

    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(encode).toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(cacheKey, [
      expect.objectContaining({ byteLength: 3, x: 0, y: 0 }),
    ]);
    expect(diagnostics.snapshot().recentSpans).toContainEqual(
      expect.objectContaining({ accepted: true, name: 'ink-preview-cache-publish' }),
    );
    controller.dispose();
  });

  it('accounts and releases every Preview spatial index through one plugin-wide coordinator', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const coordinator = new InkGeometryCacheCoordinator(64 * 1024 * 1024);
    const firstProjection = new InkPreviewProjection([surface()]);
    const secondProjection = new InkPreviewProjection([surface()]);
    const firstRoot = document.createElement('div');
    const secondRoot = document.createElement('div');
    const first = new InkPreviewProjectionController({
      document,
      memoryCoordinator: coordinator,
      projection: firstProjection,
      requestFrame: (callback) => {
        callback(0);
        return 1;
      },
      root: firstRoot,
    });
    const second = new InkPreviewProjectionController({
      document,
      memoryCoordinator: coordinator,
      projection: secondProjection,
      requestFrame: (callback) => {
        callback(0);
        return 1;
      },
      root: secondRoot,
    });

    expect(coordinator.byteSize).toBe(0);
    first.showPreview();
    second.showPreview();
    expect(coordinator.byteSize).toBe(
      firstProjection.read().indexBytes + secondProjection.read().indexBytes,
    );
    first.dispose();
    expect(coordinator.byteSize).toBe(secondProjection.read().indexBytes);
    second.dispose();
    expect(coordinator.byteSize).toBe(0);
  });
});

function surface(): InkSurfaceRecord {
  return {
    createdAt: '2026-07-20T00:00:00.000Z',
    filePath: 'Ink.md',
    id: 'surface',
    layout: {
      blockFingerprints: [],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 900,
      logicalWidth: 960,
      originY: 0,
      sourceRevision: 'source',
      themeMode: 'light',
    },
    noteId: 'note',
    revision: 1,
    schemaVersion: 2,
    status: 'active',
    strokes: [
      {
        color: '#112233',
        id: 'stroke',
        points: [
          { pressure: 0.5, time: 1, x: 10, y: 20 },
          { pressure: 0.5, time: 2, x: 100, y: 80 },
        ],
        tool: 'pen',
        width: 4,
      },
    ],
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}

function physicalSurface(): InkSurfaceRecord {
  return {
    ...surface(),
    schemaVersion: 3,
    strokes: [
      {
        brushRenderVersion: 'pen-physical-v1',
        color: '#112233',
        id: 'physical-pen',
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
            time: 10,
            x: 100,
            y: 80,
          },
        ],
        tool: 'pen',
        width: 4,
      },
    ],
  };
}

function canvasContext(): CanvasRenderingContext2D {
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillStyle: '#000000',
    drawImage: vi.fn(),
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'round',
    lineJoin: 'round',
    lineTo: vi.fn(),
    lineWidth: 1,
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    strokeStyle: '#000000',
  } as unknown as CanvasRenderingContext2D;
}

function canvasCalls(
  context: CanvasRenderingContext2D,
  method: 'drawImage' | 'fill' | 'stroke',
): readonly unknown[][] {
  return (context[method] as unknown as { readonly mock: { readonly calls: unknown[][] } }).mock
    .calls;
}
