// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { InkWorkScheduler } from '../runtime/ink-work-scheduler';
import { InkGeometryCacheCoordinator } from './ink-geometry-cache';
import { InkMainThreadTileBuilder } from './ink-main-thread-tile-builder';

describe('InkMainThreadTileBuilder', () => {
  it('runs query and draw as cooperative measured units and returns one complete tile', async () => {
    const setTransform = vi.fn();
    const context = {
      setTransform,
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const order: string[] = [];
    const measured: string[] = [];
    const builder = new InkMainThreadTileBuilder({
      document,
      scheduler: new InkWorkScheduler({
        onUnitMeasured: ({ unitKind }) => {
          if (unitKind !== undefined) measured.push(unitKind);
        },
        yieldToHost: () => Promise.resolve(),
      }),
    });

    const result = await builder.build({
      backingHeight: 64,
      backingWidth: 64,
      bounds: { height: 32, width: 32, x: -32, y: 0 },
      createDrawPlan: (_context, refs: readonly string[]) => ({
        unitKinds: refs.map(() => 'draw'),
        units: refs.map((ref) => () => order.push(`draw:${ref}`)),
      }),
      density: 2,
      isCurrent: () => true,
      key: 'tile',
      lane: 'visible',
      prepareQuery: () => ({
        result: () => ['a', 'b'],
        unitKinds: ['query-a', 'query-b'],
        units: [() => order.push('query:a'), () => order.push('query:b')],
      }),
    });

    expect(result?.key).toBe('tile');
    expect(result?.canvas.width).toBe(64);
    expect(result?.canvas.height).toBe(64);
    expect(setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 64, -0);
    expect(order).toEqual(['query:a', 'query:b', 'draw:a', 'draw:b']);
    expect(measured).toEqual(['query-a', 'query-b', 'draw', 'draw']);
    builder.dispose();
  });

  it('releases incomplete backing when its adoption fence becomes stale', async () => {
    let current = true;
    let canvas: HTMLCanvasElement | null = null;
    const captureCanvas = (value: HTMLCanvasElement): void => {
      canvas = value;
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      captureCanvas(this);
      return { setTransform: vi.fn() } as unknown as CanvasRenderingContext2D;
    });
    const builder = new InkMainThreadTileBuilder({
      document,
      scheduler: new InkWorkScheduler({ yieldToHost: () => Promise.resolve() }),
    });

    const result = await builder.build({
      backingHeight: 32,
      backingWidth: 32,
      bounds: { height: 32, width: 32, x: 0, y: 0 },
      createDrawPlan: () => ({ unitKinds: [], units: [] }),
      density: 1,
      isCurrent: () => current,
      key: 'stale',
      lane: 'visible',
      prepareQuery: () => ({
        result: () => [],
        unitKinds: ['invalidate'],
        units: [
          () => {
            current = false;
          },
        ],
      }),
    });

    expect(result).toBeNull();
    expect((canvas as HTMLCanvasElement | null)?.width).toBe(0);
    expect((canvas as HTMLCanvasElement | null)?.height).toBe(0);
    builder.dispose();
  });

  it('accounts in-flight backing stores globally and releases them at the terminal boundary', async () => {
    let releaseYield: (() => void) | undefined;
    const coordinator = new InkGeometryCacheCoordinator(64 * 1024);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const builder = new InkMainThreadTileBuilder({
      document,
      memoryCoordinator: coordinator,
      scheduler: new InkWorkScheduler({
        yieldToHost: () =>
          new Promise<void>((resolve) => {
            releaseYield = resolve;
          }),
      }),
    });

    const pending = builder.build({
      backingHeight: 64,
      backingWidth: 64,
      bounds: { height: 64, width: 64, x: 0, y: 0 },
      createDrawPlan: () => ({ unitKinds: [], units: [] }),
      density: 1,
      isCurrent: () => true,
      key: 'accounted',
      lane: 'visible',
      prepareQuery: () => ({
        result: () => [],
        unitKinds: ['query'],
        units: [() => undefined],
      }),
    });

    expect(coordinator.byteSize).toBe(64 * 64 * 4);
    await vi.waitFor(() => expect(releaseYield).toBeTypeOf('function'));
    releaseYield?.();
    const result = await pending;
    expect(result?.key).toBe('accounted');
    expect(coordinator.byteSize).toBe(0);

    builder.dispose();
    expect(coordinator.byteSize).toBe(0);
  });

  it('rejects a build that cannot fit the plugin-wide disposable-memory budget', async () => {
    const coordinator = new InkGeometryCacheCoordinator(8 * 1024);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const builder = new InkMainThreadTileBuilder({ document, memoryCoordinator: coordinator });

    const result = await builder.build({
      backingHeight: 64,
      backingWidth: 64,
      bounds: { height: 64, width: 64, x: 0, y: 0 },
      createDrawPlan: () => ({ unitKinds: [], units: [] }),
      density: 1,
      isCurrent: () => true,
      key: 'too-large-globally',
      lane: 'visible',
      prepareQuery: () => ({ result: () => [], unitKinds: [], units: [] }),
    });

    expect(result).toBeNull();
    expect(coordinator.byteSize).toBe(0);
    builder.dispose();
  });
});
