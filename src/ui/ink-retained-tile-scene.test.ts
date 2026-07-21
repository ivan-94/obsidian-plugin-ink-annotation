// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { InkGeometryCacheCoordinator } from './ink-geometry-cache';
import { InkRetainedTileScene } from './ink-retained-tile-scene';

describe('Ink retained tile scene', () => {
  it('reprojects the scene root while every adopted tile keeps stable DOM presentation', () => {
    const drawImage = vi.fn();
    const context = {
      clearRect: vi.fn(),
      drawImage,
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const host = document.createElement('div');
    const scene = new InkRetainedTileScene({ document, host, maximumNodeCount: 4 });
    const source = { close: vi.fn() } as unknown as CanvasImageSource;
    scene.adopt({
      backingHeight: 128,
      backingWidth: 128,
      key: '0:0:0',
      logicalBounds: { height: 128, width: 128, x: 0, y: 0 },
      source,
    });
    scene.project({ height: 128, logicalLeft: 0, logicalTop: 0, scale: 1, width: 128 });
    const tile = host.querySelector<HTMLCanvasElement>('[data-inkstone-retained-tile]');
    const root = host.querySelector<HTMLElement>('[data-inkstone-retained-tile-scene]');
    const tilePresentation = {
      height: tile?.style.height,
      hidden: tile?.hidden,
      transform: tile?.style.transform,
      width: tile?.style.width,
    };

    scene.project({ height: 128, logicalLeft: 128, logicalTop: 0, scale: 1, width: 128 });
    const forwardTransform = root?.style.transform;
    scene.project({ height: 128, logicalLeft: 0, logicalTop: 0, scale: 1, width: 128 });

    expect(host.querySelector('[data-inkstone-retained-tile]')).toBe(tile);
    expect(tilePresentation).toEqual({
      height: '128px',
      hidden: false,
      transform: 'translate3d(0px, 0px, 0)',
      width: '128px',
    });
    expect({
      height: tile?.style.height,
      hidden: tile?.hidden,
      transform: tile?.style.transform,
      width: tile?.style.width,
    }).toEqual(tilePresentation);
    expect(forwardTransform).toBe('matrix(1, 0, 0, 1, -128, 0)');
    expect(root?.style.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');
    expect(root?.style.willChange).toBe('transform');
    expect(tile?.style.willChange).toBe('');
    expect(drawImage).toHaveBeenCalledOnce();
    scene.dispose();
  });

  it('accounts every decoded backing globally and releases it on terminal dispose', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const coordinator = new InkGeometryCacheCoordinator(1_000_000);
    const scene = new InkRetainedTileScene({
      document,
      host: document.createElement('div'),
      maximumNodeCount: 4,
      memoryCoordinator: coordinator,
    });

    scene.adopt({
      backingHeight: 128,
      backingWidth: 128,
      key: 'accounted',
      logicalBounds: { height: 128, width: 128, x: 0, y: 0 },
      source: {} as CanvasImageSource,
    });

    expect(coordinator.byteSize).toBe(128 * 128 * 4);
    scene.dispose();
    expect(coordinator.byteSize).toBe(0);
  });

  it('cuts over compatible fallback coverage only at an explicit tile-set adoption boundary', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const host = document.createElement('div');
    const scene = new InkRetainedTileScene({ document, host, maximumNodeCount: 4 });
    for (const input of [
      { key: 'parent', logicalBounds: { height: 256, width: 256, x: 0, y: 0 } },
      { key: 'child', logicalBounds: { height: 128, width: 128, x: 0, y: 0 } },
    ]) {
      scene.adopt({
        backingHeight: 128,
        backingWidth: 128,
        source: {} as CanvasImageSource,
        ...input,
      });
    }
    scene.project({ height: 128, logicalLeft: 0, logicalTop: 0, scale: 1, width: 128 });

    scene.presentOnly(new Set(['parent']));
    expect(
      host.querySelector<HTMLCanvasElement>('[data-inkstone-retained-tile="parent"]')?.hidden,
    ).toBe(false);
    expect(
      host.querySelector<HTMLCanvasElement>('[data-inkstone-retained-tile="child"]')?.hidden,
    ).toBe(true);

    scene.presentOnly(new Set(['child']));
    expect(
      host.querySelector<HTMLCanvasElement>('[data-inkstone-retained-tile="parent"]')?.hidden,
    ).toBe(true);
    expect(
      host.querySelector<HTMLCanvasElement>('[data-inkstone-retained-tile="child"]')?.hidden,
    ).toBe(false);
    scene.dispose();
  });
});
