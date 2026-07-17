import { describe, expect, it, vi } from 'vitest';

import { AnnotationProjectionCoordinator } from './annotation-projection-coordinator';

describe('annotation projection coordinator', () => {
  it('refreshes every consumer once per distinct file path before resolving', async () => {
    let finishReading: (() => void) | undefined;
    const readingFinished = new Promise<void>((resolve) => {
      finishReading = resolve;
    });
    const reading = vi.fn((filePath: string) => {
      if (filePath === 'Notes/A.md') return readingFinished;
      return Promise.resolve();
    });
    const sidebar = vi.fn(() => Promise.resolve());
    const coordinator = new AnnotationProjectionCoordinator({
      consumers: [
        { name: 'reading-view', refresh: reading },
        { name: 'sidebar', refresh: sidebar },
      ],
    });

    let settled = false;
    const refreshing = coordinator.refresh(['Notes/A.md', 'Notes/B.md', 'Notes/A.md']).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(reading).toHaveBeenCalledTimes(2);
    expect(reading).toHaveBeenNthCalledWith(1, 'Notes/A.md');
    expect(reading).toHaveBeenNthCalledWith(2, 'Notes/B.md');
    expect(sidebar).toHaveBeenCalledTimes(2);
    expect(sidebar).toHaveBeenNthCalledWith(1, 'Notes/A.md');
    expect(sidebar).toHaveBeenNthCalledWith(2, 'Notes/B.md');
    expect(settled).toBe(false);

    finishReading?.();
    await refreshing;
    expect(settled).toBe(true);
  });

  it('reports one failed projection without interrupting or outliving the remaining refreshes', async () => {
    const failure = new Error('Reading View unavailable');
    const onIssue = vi.fn();
    let finishSidebar: (() => void) | undefined;
    const sidebarFinished = new Promise<void>((resolve) => {
      finishSidebar = resolve;
    });
    const reading = vi.fn((filePath: string) => {
      if (filePath === 'Notes/A.md') return Promise.reject(failure);
      return Promise.resolve();
    });
    const sidebar = vi.fn(() => sidebarFinished);
    const coordinator = new AnnotationProjectionCoordinator({
      consumers: [
        { name: 'reading-view', refresh: reading },
        { name: 'sidebar', refresh: sidebar },
      ],
      onIssue,
    });

    let settled = false;
    const refreshing = coordinator.refresh(['Notes/A.md', 'Notes/B.md']).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onIssue).toHaveBeenCalledOnce();
    expect(onIssue).toHaveBeenCalledWith({
      cause: failure,
      consumerName: 'reading-view',
      filePath: 'Notes/A.md',
    });
    expect(reading).toHaveBeenCalledTimes(2);
    expect(sidebar).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);

    finishSidebar?.();
    await expect(refreshing).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it('does not let diagnostics failure reclassify a completed projection fanout', async () => {
    const healthy = vi.fn(() => Promise.resolve());
    const coordinator = new AnnotationProjectionCoordinator({
      consumers: [
        { name: 'failed', refresh: () => Promise.reject(new Error('projection failed')) },
        { name: 'healthy', refresh: healthy },
      ],
      onIssue: () => {
        throw new Error('diagnostics failed');
      },
    });

    await expect(coordinator.refresh(['Note.md'])).resolves.toBeUndefined();
    expect(healthy).toHaveBeenCalledWith('Note.md');
  });
});
