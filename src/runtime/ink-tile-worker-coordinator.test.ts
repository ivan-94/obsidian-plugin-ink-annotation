import { describe, expect, it, vi } from 'vitest';

import { InkTileWorkerCoordinator } from './ink-tile-worker-coordinator';

describe('InkTileWorkerCoordinator', () => {
  it('coalesces same-key jobs and respects visible-dirty priority', () => {
    const coordinator = new InkTileWorkerCoordinator();
    expect(coordinator.submit(job('cold', 'mount-a', 'tile-a', 1_024, 'cold')).kind).toBe(
      'accepted',
    );
    const first = coordinator.submit(job('dirty', 'mount-b', 'tile-b', 1_024, 'visible-dirty'));
    const duplicate = coordinator.submit(
      job('duplicate', 'mount-b', 'tile-b', 1_024, 'visible-dirty'),
    );

    expect(first.kind).toBe('accepted');
    if (first.kind !== 'accepted') throw new Error('Expected the first job to be accepted.');
    expect(duplicate).toEqual({ jobId: first.jobId, kind: 'coalesced' });
    expect(coordinator.takeNext()?.id).toBe('dirty');
    coordinator.dispose();
  });

  it('enforces global/per-mount queue, result, and byte ceilings', () => {
    const coordinator = new InkTileWorkerCoordinator({ maximumBytes: 8_192 });
    for (let index = 0; index < 4; index += 1) {
      expect(
        coordinator.submit(job(`a-${index}`, 'mount-a', `a-${index}`, 1_024, 'cold')).kind,
      ).toBe('accepted');
    }
    expect(coordinator.submit(job('a-4', 'mount-a', 'a-4', 1_024, 'cold')).kind).toBe(
      'rejected-mount-cap',
    );
    for (let index = 0; index < 4; index += 1) {
      expect(
        coordinator.submit(job(`b-${index}`, 'mount-b', `b-${index}`, 1_024, 'cold')).kind,
      ).toBe('accepted');
    }
    expect(coordinator.submit(job('overflow', 'mount-c', 'overflow', 1, 'cold')).kind).toBe(
      'rejected-queue-cap',
    );

    const running = coordinator.takeNext();
    expect(running).not.toBeNull();
    const close1 = vi.fn();
    const close2 = vi.fn();
    const close3 = vi.fn();
    expect(coordinator.complete(running!.id, { byteSize: 1, close: close1 }).kind).toBe('accepted');
    const second = coordinator.takeNext();
    expect(coordinator.complete(second!.id, { byteSize: 1, close: close2 }).kind).toBe('accepted');
    const third = coordinator.takeNext();
    expect(coordinator.complete(third!.id, { byteSize: 1, close: close3 }).kind).toBe(
      'rejected-result-cap',
    );
    expect(close3).toHaveBeenCalledOnce();
    coordinator.dispose();
    expect(close1).toHaveBeenCalledOnce();
    expect(close2).toHaveBeenCalledOnce();
  });

  it('uses reference-counted pause leases and resumes only after every scope releases', async () => {
    const coordinator = new InkTileWorkerCoordinator();
    coordinator.submit(job('queued', 'mount-a', 'queued', 1, 'visible-preview'));
    const first = coordinator.acquirePause('contact:a');
    const second = coordinator.acquirePause('contact:b');

    await Promise.all([first.acknowledged, second.acknowledged]);
    expect(coordinator.takeNext()).toBeNull();
    first.release();
    expect(coordinator.takeNext()).toBeNull();
    second.release();
    expect(coordinator.takeNext()?.id).toBe('queued');
    coordinator.dispose();
  });

  it('counts duplicate pause scopes independently and releases only the matching lease', async () => {
    const coordinator = new InkTileWorkerCoordinator();
    coordinator.submit(job('queued', 'mount-a', 'queued', 1, 'visible-preview'));
    const first = coordinator.acquirePause('contact:a');
    const second = coordinator.acquirePause('contact:a');

    await Promise.all([first.acknowledged, second.acknowledged]);
    expect(coordinator.stats().pausedScopeCount).toBe(2);
    first.release();
    expect(coordinator.takeNext()).toBeNull();
    second.release();
    expect(coordinator.takeNext()?.id).toBe('queued');
    coordinator.dispose();
  });

  it('round-robins mounts within one priority and releases queued/running byte leases on cancel', () => {
    const coordinator = new InkTileWorkerCoordinator();
    coordinator.submit(job('a-1', 'mount-a', 'a-1', 100, 'visible-preview'));
    coordinator.submit(job('a-2', 'mount-a', 'a-2', 100, 'visible-preview'));
    coordinator.submit(job('b-1', 'mount-b', 'b-1', 100, 'visible-preview'));
    coordinator.submit(job('b-2', 'mount-b', 'b-2', 100, 'visible-preview'));

    expect(coordinator.takeNext()?.id).toBe('a-1');
    expect(coordinator.cancel('a-1')).toBe('running');
    expect(coordinator.abandonRunning('a-1')).toBe(true);
    expect(coordinator.takeNext()?.id).toBe('b-1');
    expect(coordinator.abandonRunning('b-1')).toBe(true);
    expect(coordinator.cancel('a-2')).toBe('queued');
    expect(coordinator.stats().bytes).toBe(100);
    expect(coordinator.takeNext()?.id).toBe('b-2');
    expect(coordinator.abandonRunning('b-2')).toBe(true);
    expect(coordinator.stats().bytes).toBe(0);
    coordinator.dispose();
  });

  it('accounts acknowledged projection mirrors inside the same hard byte cap', () => {
    const coordinator = new InkTileWorkerCoordinator({ maximumBytes: 8_192 });

    expect(coordinator.reserveMirror('mirror-a', 6_144)).toBe(true);
    expect(coordinator.reserveMirror('mirror-b', 3_072)).toBe(false);
    expect(coordinator.submit(job('tile', 'mount-a', 'tile', 2_049, 'visible-preview')).kind).toBe(
      'rejected-byte-cap',
    );
    expect(coordinator.releaseMirror('mirror-a')).toBe(true);
    expect(coordinator.reserveMirror('mirror-b', 3_072)).toBe(true);
    expect(coordinator.stats()).toMatchObject({ bytes: 3_072, mirrorCount: 1 });
    coordinator.dispose();
  });
});

function job(
  id: string,
  mountId: string,
  key: string,
  byteSize: number,
  priority: 'cold' | 'near-visible' | 'visible-dirty' | 'visible-preview',
) {
  return { byteSize, id, key, mountId, priority } as const;
}
