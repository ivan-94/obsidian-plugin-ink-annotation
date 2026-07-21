// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { InkPreviewProjection } from '../application/ink-preview-projection';
import type { InkSurfaceRecord } from '../domain/ink-surface';
import { InkPerformanceDiagnostics } from '../runtime/ink-performance-diagnostics';
import { InkWorkScheduler } from '../runtime/ink-work-scheduler';
import type {
  InkPreviewCacheKey,
  InkPreviewCacheTileCoordinate,
} from '../storage/indexeddb-ink-preview-cache';
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
        queueMicrotask(() => callback(0));
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

  it('retains an adopted tile resource while newly exposed coverage settles', async () => {
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
      const visible = scroll.querySelector<HTMLCanvasElement>('[data-inkstone-retained-tile]');
      const context = visible === null ? undefined : contexts.get(visible);
      expect(context === undefined ? [] : canvasCalls(context, 'drawImage')).not.toHaveLength(0);
    });
    const presented = scroll.querySelector<HTMLCanvasElement>('[data-inkstone-retained-tile]');
    if (presented === null) throw new Error('Missing presented Preview tile.');
    const initialTileCount = scroll.querySelectorAll('[data-inkstone-retained-tile]').length;
    const presentedContext = contexts.get(presented);
    if (presentedContext === undefined) throw new Error('Missing presented Preview tile context.');
    const clearsBeforeScroll = (
      presentedContext.clearRect as unknown as { readonly mock: { readonly calls: unknown[][] } }
    ).mock.calls.length;
    const backingBeforeScroll = { height: presented.height, width: presented.width };

    stallVisibleWork = true;
    documentTop = -512;
    scroll.dispatchEvent(new Event('scroll'));
    frames.shift()?.(16);

    expect(scroll.querySelector('[data-inkstone-retained-tile]')).toBe(presented);
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
    await Promise.resolve();
    expect(initialTileCount).toBeGreaterThan(0);
    expect(scroll.querySelectorAll('[data-inkstone-retained-tile]').length).toBeGreaterThan(0);
    expect(scroll.querySelector('[data-inkstone-retained-tile]')).toBe(presented);
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
    const cachedHit = {
      generation: 'cached',
      tiles: [{ byteLength: 1, bytes: Uint8Array.of(1).buffer, lod: 0, x: 0, y: 0 }],
    };
    const load = vi.fn(() => Promise.resolve(cachedHit));
    const loadRegion = vi.fn(
      (key: InkPreviewCacheKey, coordinates: readonly InkPreviewCacheTileCoordinate[]) => {
        void key;
        void coordinates;
        return Promise.resolve(cachedHit);
      },
    );
    const close = vi.fn();
    const bitmap = { close } as unknown as CanvasImageSource;
    const controller = new InkPreviewProjectionController({
      cache: { load, loadRegion, publish: vi.fn(() => Promise.resolve(true)) },
      cacheKey,
      decodeTile: () => Promise.resolve(bitmap),
      document,
      projection: new InkPreviewProjection([surface()]),
      requestFrame: (callback) => {
        queueMicrotask(() => callback(0));
        return 1;
      },
      root,
      scrollContainer: scroll,
    });

    controller.showPreview();
    await vi.waitFor(() => expect(canvasCalls(context, 'drawImage')).not.toHaveLength(0));

    expect(loadRegion).toHaveBeenCalledOnce();
    expect(loadRegion.mock.calls[0]?.[0]).toBe(cacheKey);
    expect(loadRegion.mock.calls[0]?.[1]?.[0]).toEqual({ lod: 0, x: 0, y: 0 });
    expect(loadRegion.mock.calls[0]?.[1]?.filter(({ lod }) => lod === 0)).toHaveLength(9);
    expect(loadRegion.mock.calls[0]?.[1]?.filter(({ lod }) => lod === -1)).toHaveLength(4);
    expect(load).not.toHaveBeenCalled();
    expect(canvasCalls(context, 'stroke')).toHaveLength(0);
    expect(close).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('isolates a corrupt near-visible cache tile without discarding an exact visible hit', async () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const root = document.createElement('div');
    document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 512, 512));
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
      cache: {
        loadRegion: () =>
          Promise.resolve({
            generation: 'cached',
            tiles: [
              { byteLength: 1, bytes: Uint8Array.of(1).buffer, lod: 0, x: 0, y: 0 },
              { byteLength: 1, bytes: Uint8Array.of(2).buffer, lod: 0, x: 1, y: 0 },
            ],
          }),
        publish: () => Promise.resolve(true),
      },
      cacheKey,
      decodeTile: (bytes) =>
        new Uint8Array(bytes)[0] === 2
          ? Promise.reject(new Error('corrupt near tile'))
          : Promise.resolve({ close: vi.fn() } as unknown as CanvasImageSource),
      document,
      projection: new InkPreviewProjection([surface()]),
      requestFrame: (callback) => {
        queueMicrotask(() => callback(0));
        return 1;
      },
      root,
    });

    controller.showPreview();
    await vi.waitFor(() =>
      expect(root.querySelectorAll('[data-inkstone-retained-tile]')).toHaveLength(1),
    );

    expect(canvasCalls(context, 'stroke')).toHaveLength(0);
    controller.dispose();
  });

  it('presents one compatible parent tile before scheduling exact visible refinement', async () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const root = document.createElement('div');
    document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 960, 900));
    const projection = new InkPreviewProjection([surface()]);
    const prepareQuery = vi.spyOn(projection, 'prepareQuery');
    const frames: FrameRequestCallback[] = [];
    const loadRegion = vi.fn(
      (_key: InkPreviewCacheKey, coordinates: readonly InkPreviewCacheTileCoordinate[]) => {
        expect(coordinates).toContainEqual({ lod: -1, x: 0, y: 0 });
        return Promise.resolve({
          generation: 'cached',
          tiles: [{ byteLength: 1, bytes: Uint8Array.of(1).buffer, lod: -1, x: 0, y: 0 }],
        });
      },
    );
    const controller = new InkPreviewProjectionController({
      cache: { loadRegion, publish: () => Promise.resolve(true) },
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
      decodeTile: () => Promise.resolve({ close: vi.fn() } as unknown as CanvasImageSource),
      document,
      projection,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      root,
    });

    controller.showPreview();
    await vi.waitFor(() =>
      expect(root.querySelector('[data-inkstone-retained-tile="cached:-1:0:0"]')).not.toBeNull(),
    );

    expect(prepareQuery).not.toHaveBeenCalled();
    expect(frames.length).toBeGreaterThan(0);
    controller.dispose();
  });

  it('demand-loads newly exposed cached coordinates on scroll without compiling canonical Geometry', async () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const scroll = document.createElement('div');
    const root = document.createElement('div');
    scroll.append(root);
    document.body.append(scroll);
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 512 },
      clientWidth: { configurable: true, value: 512 },
    });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 512, 512));
    let documentTop = 0;
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, documentTop, 960, 1_500),
    );
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
    const loadRegion = vi.fn(
      (_key: InkPreviewCacheKey, coordinates: readonly InkPreviewCacheTileCoordinate[]) =>
        Promise.resolve({
          generation: 'cached',
          tiles: coordinates.map(({ lod, x, y }) => ({
            byteLength: 1,
            bytes: Uint8Array.of(1).buffer,
            lod,
            x,
            y,
          })),
        }),
    );
    const bitmap = { close: vi.fn() } as unknown as CanvasImageSource;
    const controller = new InkPreviewProjectionController({
      cache: {
        loadRegion,
        publish: vi.fn(() => Promise.resolve(true)),
      },
      cacheKey,
      decodeTile: () => Promise.resolve(bitmap),
      document,
      projection: new InkPreviewProjection([surface()]),
      requestFrame: (callback) => {
        queueMicrotask(() => callback(0));
        return 1;
      },
      root,
      scrollContainer: scroll,
    });

    controller.showPreview();
    await vi.waitFor(() => expect(loadRegion).toHaveBeenCalledTimes(1));
    expect(loadRegion.mock.calls[0]?.[1]?.filter(({ lod }) => lod === 0)).toHaveLength(9);
    expect(loadRegion.mock.calls[0]?.[1]?.filter(({ lod }) => lod === -1)).toHaveLength(4);
    expect(loadRegion.mock.calls[0]?.[1]).toContainEqual({ lod: 0, x: -1, y: -1 });
    expect(loadRegion.mock.calls[0]?.[1]).toContainEqual({ lod: 0, x: 1, y: 1 });
    await vi.waitFor(() =>
      expect(root.querySelectorAll('[data-inkstone-retained-tile]')).toHaveLength(13),
    );
    const initialNodeCount = root.querySelectorAll('[data-inkstone-retained-tile]').length;
    const retained = root.querySelector('[data-inkstone-retained-tile]');
    documentTop = -512;
    scroll.dispatchEvent(new Event('scroll'));

    await vi.waitFor(() => expect(loadRegion).toHaveBeenCalledTimes(2));
    expect(loadRegion.mock.calls[1]?.[1]).toContainEqual({ lod: 0, x: 0, y: 1 });
    expect(loadRegion.mock.calls[1]?.[1]).toContainEqual({ lod: 0, x: -1, y: 3 });
    await vi.waitFor(() =>
      expect(canvasCalls(context, 'drawImage').length).toBeGreaterThan(initialNodeCount),
    );
    await vi.waitFor(() =>
      expect(root.querySelectorAll('[data-inkstone-retained-tile]').length).toBeGreaterThan(
        initialNodeCount,
      ),
    );
    expect(root.querySelector('[data-inkstone-retained-tile="cached:0:0:0"]')).toBe(retained);
    expect(canvasCalls(context, 'stroke')).toHaveLength(0);
    controller.dispose();
  });

  it('builds visible canonical Preview first, then retains bounded cold near tiles for scroll', async () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const scroll = document.createElement('div');
    const root = document.createElement('div');
    scroll.append(root);
    document.body.append(scroll);
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 512 },
      clientWidth: { configurable: true, value: 512 },
    });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 512, 512));
    let documentTop = 0;
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, documentTop, 960, 1_500),
    );
    const projection = new InkPreviewProjection([surface()]);
    const prepareQuery = vi.spyOn(projection, 'prepareQuery');
    const controller = new InkPreviewProjectionController({
      document,
      projection,
      requestFrame: (callback) => {
        queueMicrotask(() => callback(0));
        return 1;
      },
      root,
      scrollContainer: scroll,
    });

    controller.showPreview();
    await vi.waitFor(() =>
      expect(root.querySelectorAll('[data-inkstone-retained-tile]').length).toBeGreaterThan(1),
    );
    const first = root.querySelector('[data-inkstone-retained-tile]');
    expect(first).not.toBeNull();
    expect(
      root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-preview-canvas]')?.hidden,
    ).toBe(true);

    documentTop = -512;
    scroll.dispatchEvent(new Event('scroll'));

    await vi.waitFor(() =>
      expect(root.querySelectorAll('[data-inkstone-retained-tile]').length).toBeGreaterThan(2),
    );
    expect(root.querySelector('[data-inkstone-retained-tile]')).toBe(first);
    expect(prepareQuery.mock.calls.length).toBeGreaterThan(2);
    expect(root.querySelectorAll('[data-inkstone-retained-tile]').length).toBeLessThanOrEqual(64);
    controller.dispose();
  });

  it('does not let a stalled scroll-region cache read block canonical replacement pixels', async () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const scroll = document.createElement('div');
    const root = document.createElement('div');
    scroll.append(root);
    document.body.append(scroll);
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 512 },
      clientWidth: { configurable: true, value: 512 },
    });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 512, 512));
    let documentTop = 0;
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, documentTop, 960, 1_500),
    );
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
    let lookup = 0;
    const loadRegion = vi.fn(() => {
      lookup += 1;
      return lookup === 1
        ? Promise.resolve({
            generation: 'cached',
            tiles: [{ byteLength: 1, bytes: Uint8Array.of(1).buffer, lod: 0, x: 0, y: 0 }],
          })
        : new Promise<null>(() => undefined);
    });
    const canonical = surface();
    const controller = new InkPreviewProjectionController({
      cache: { loadRegion, publish: vi.fn(() => Promise.resolve(true)) },
      cacheKey,
      decodeTile: () => Promise.resolve({ close: vi.fn() } as unknown as CanvasImageSource),
      document,
      projection: new InkPreviewProjection([
        {
          ...canonical,
          strokes: [
            {
              ...canonical.strokes[0]!,
              points: [
                { pressure: 0.5, time: 1, x: 20, y: 600 },
                { pressure: 0.5, time: 2, x: 80, y: 640 },
              ],
            },
          ],
        },
      ]),
      requestFrame: (callback) => {
        callback(0);
        return 1;
      },
      root,
      scrollContainer: scroll,
    });
    controller.showPreview();
    await vi.waitFor(() => expect(canvasCalls(context, 'drawImage')).not.toHaveLength(0));
    expect(canvasCalls(context, 'stroke')).toHaveLength(0);

    documentTop = -512;
    scroll.dispatchEvent(new Event('scroll'));

    await vi.waitFor(() => expect(canvasCalls(context, 'stroke')).not.toHaveLength(0));
    expect(loadRegion).toHaveBeenCalledTimes(2);
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
            tiles: [{ byteLength: 1, bytes: Uint8Array.of(1).buffer, lod: 0, x: 0, y: 0 }],
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

    expect(canvasCalls(context, 'drawImage')).toHaveLength(1);
    expect(root.querySelector('[data-inkstone-retained-tile]')).not.toBeNull();
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

  it('still adopts and records an exact region hit that settles after the fallback deadline', async () => {
    const context = canvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const diagnostics = new InkPerformanceDiagnostics(true);
    const frames: FrameRequestCallback[] = [];
    let resolveRegion!: (hit: {
      readonly generation: string;
      readonly tiles: readonly [
        {
          readonly byteLength: number;
          readonly bytes: ArrayBuffer;
          readonly lod: number;
          readonly x: number;
          readonly y: number;
        },
      ];
    }) => void;
    const pendingRegion = new Promise<Parameters<typeof resolveRegion>[0]>((resolve) => {
      resolveRegion = resolve;
    });
    let releaseVisibleWork: (() => void) | undefined;
    const root = document.createElement('div');
    document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 512, 512));
    const controller = new InkPreviewProjectionController({
      cache: {
        loadRegion: () => pendingRegion,
        publish: () => Promise.resolve(true),
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
      decodeTile: () => Promise.resolve({ close: vi.fn() } as unknown as CanvasImageSource),
      document,
      inkPerformance: diagnostics,
      projection: new InkPreviewProjection([surface()]),
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      root,
      workScheduler: new InkWorkScheduler({
        yieldToHost: () =>
          new Promise<void>((resolve) => {
            releaseVisibleWork = resolve;
          }),
      }),
    });

    controller.showPreview();
    await Promise.resolve();
    await Promise.resolve();
    frames.shift()?.(0); // Cache deadline: begin canonical fallback.
    frames.shift()?.(16); // Stall canonical Tile Builder after it has begun.
    resolveRegion({
      generation: 'late-exact',
      tiles: [{ byteLength: 1, bytes: Uint8Array.of(1).buffer, lod: 0, x: 0, y: 0 }],
    });

    await vi.waitFor(() =>
      expect(
        diagnostics
          .snapshot()
          .recentSpans.some(
            ({ accepted, name }) => name === 'ink-preview-cache-lookup' && accepted !== false,
          ),
      ).toBe(true),
    );
    expect(root.querySelector('[data-inkstone-retained-tile="late-exact:0:0:0"]')).not.toBeNull();

    controller.dispose();
    releaseVisibleWork?.();
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
    const publishCompleteTiles = vi.fn(() => Promise.resolve(true));
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
      cache: {
        loadRegion: () => Promise.resolve(null),
        publish,
        publishCompleteTiles,
      },
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

    await vi.waitFor(() => expect(publishCompleteTiles).toHaveBeenCalledOnce());
    expect(encode).toHaveBeenCalled();
    expect(publishCompleteTiles).toHaveBeenCalledWith(cacheKey, [
      expect.objectContaining({ byteLength: 3, lod: 0, x: 0, y: 0 }),
    ]);
    expect(publish).not.toHaveBeenCalled();
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
      requestFrame: () => 1,
      root: firstRoot,
    });
    const second = new InkPreviewProjectionController({
      document,
      memoryCoordinator: coordinator,
      projection: secondProjection,
      requestFrame: () => 1,
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
