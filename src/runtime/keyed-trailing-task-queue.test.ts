import { describe, expect, it, vi } from 'vitest';

import { KeyedTrailingTaskQueue } from './keyed-trailing-task-queue';

describe('KeyedTrailingTaskQueue', () => {
  it('coalesces a mutation burst into the running task plus one trailing pass', async () => {
    const queue = new KeyedTrailingTaskQueue<string>();
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const task = vi.fn(async () => {
      if (task.mock.calls.length === 1) await firstBlocked;
    });

    const first = queue.schedule('view', task);
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1));
    const burst = Array.from({ length: 1_000 }, () => queue.schedule('view', task));
    releaseFirst?.();
    await Promise.all([first, ...burst]);

    expect(task).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh cycle after completion or failure', async () => {
    const queue = new KeyedTrailingTaskQueue<string>();
    const task = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('boom'));

    await queue.schedule('view', task);
    await expect(queue.schedule('view', task)).rejects.toThrow('boom');
    await queue.schedule('view', () => Promise.resolve());

    expect(task).toHaveBeenCalledTimes(2);
  });
});
