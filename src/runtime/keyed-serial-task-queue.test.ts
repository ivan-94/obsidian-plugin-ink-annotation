import { describe, expect, it, vi } from 'vitest';

import { KeyedSerialTaskQueue } from './keyed-serial-task-queue';

describe('keyed serial task queue', () => {
  it('prevents two mount tasks for one view from overlapping', async () => {
    const queue = new KeyedSerialTaskQueue<string>();
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const active: string[] = [];
    let overlapped = false;
    const run = (name: string, block = false): Promise<string> =>
      queue.schedule('view', async () => {
        if (active.length > 0) overlapped = true;
        active.push(name);
        if (block) await firstBlocked;
        active.pop();
        return name;
      });

    const first = run('interactive', true);
    await vi.waitFor(() => expect(active).toEqual(['interactive']));
    const second = run('observer');
    await Promise.resolve();
    expect(active).toEqual(['interactive']);
    releaseFirst?.();

    await expect(Promise.all([first, second])).resolves.toEqual(['interactive', 'observer']);
    expect(overlapped).toBe(false);
  });

  it('continues after a failed task and does not serialize unrelated views', async () => {
    const queue = new KeyedSerialTaskQueue<string>();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.schedule('first', async () => {
      await blocked;
      throw new Error('mount failed');
    });
    const unrelated = queue.schedule('second', () => Promise.resolve('ready'));
    const recovery = queue.schedule('first', () => Promise.resolve('recovered'));

    await expect(unrelated).resolves.toBe('ready');
    release?.();
    await expect(first).rejects.toThrow('mount failed');
    await expect(recovery).resolves.toBe('recovered');
  });
});
