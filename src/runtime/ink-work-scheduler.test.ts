import { describe, expect, it, vi } from 'vitest';

import { InkWorkScheduler } from './ink-work-scheduler';

describe('InkWorkScheduler', () => {
  it('runs visible units before cold units and cancels cold continuation on new interaction', async () => {
    const order: string[] = [];
    const scheduler = new InkWorkScheduler({
      yieldToHost: () => Promise.resolve(),
    });
    const cold = scheduler.schedule({
      lane: 'cold',
      units: [
        () => order.push('cold-1'),
        () => {
          order.push('cold-2');
        },
      ],
    });
    const visible = scheduler.schedule({
      lane: 'visible',
      units: [() => order.push('visible')],
    });
    await visible;
    const release = scheduler.beginInteraction();
    release();

    expect(await cold).toBe('cancelled');
    expect(order).toEqual(['visible']);
  });

  it('cancels stale epoch work before its next mutation', async () => {
    let current = true;
    const scheduler = new InkWorkScheduler({ yieldToHost: () => Promise.resolve() });
    const work = scheduler.schedule({
      isCurrent: () => current,
      lane: 'cold',
      units: [
        () => {
          current = false;
        },
        () => {
          throw new Error('stale unit ran');
        },
      ],
    });

    expect(await work).toBe('cancelled');
  });

  it('reports a main-thread unit that exceeds the one millisecond cold budget', async () => {
    let now = 0;
    const onUnitMeasured = vi.fn();
    const onUnitOverrun = vi.fn();
    const scheduler = new InkWorkScheduler({
      now: () => now,
      onUnitMeasured,
      onUnitOverrun,
      yieldToHost: () => Promise.resolve(),
    });

    await scheduler.schedule({
      lane: 'cold',
      unitKinds: ['preview-query-index'],
      units: [
        () => {
          now = 1.5;
        },
      ],
    });

    expect(onUnitOverrun).toHaveBeenCalledWith({
      durationMs: 1.5,
      lane: 'cold',
      unitKind: 'preview-query-index',
    });
    expect(onUnitMeasured).toHaveBeenCalledWith({
      durationMs: 1.5,
      lane: 'cold',
      unitKind: 'preview-query-index',
    });
  });

  it('counts every deferred unit even when it stays within the target', async () => {
    let now = 0;
    const onUnitMeasured = vi.fn();
    const scheduler = new InkWorkScheduler({
      now: () => now,
      onUnitMeasured,
      yieldToHost: () => Promise.resolve(),
    });

    await scheduler.schedule({
      lane: 'visible',
      units: [() => (now = 0.5), () => (now = 0.75)],
    });

    expect(onUnitMeasured).toHaveBeenCalledTimes(2);
  });

  it('measures synchronous main-thread occupancy instead of asynchronous wait time', async () => {
    let now = 0;
    const onUnitOverrun = vi.fn();
    const scheduler = new InkWorkScheduler({
      now: () => now,
      onUnitOverrun,
      yieldToHost: () => Promise.resolve(),
    });

    await scheduler.schedule({
      lane: 'cold',
      units: [
        () =>
          Promise.resolve().then(() => {
            now = 50;
          }),
      ],
    });

    expect(onUnitOverrun).not.toHaveBeenCalled();
  });
});
