// @vitest-environment jsdom

import type { MarkdownView } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

import { ObsidianInkModeManager } from './ink-mode-manager';

vi.mock('obsidian', () => ({
  MarkdownView: class {},
  Notice: class {},
  setIcon: () => undefined,
  setTooltip: () => undefined,
}));

describe('Obsidian Ink Mode action', () => {
  it('uses a distinct paintbrush icon and deduplicates an in-flight toggle', async () => {
    const contentEl = document.createElement('div');
    const action = document.createElement('button');
    let registeredIcon = '';
    const view = {
      addAction: (icon: string): HTMLElement => {
        registeredIcon = icon;
        return action;
      },
      contentEl,
    } as unknown as MarkdownView;
    const manager = new ObsidianInkModeManager({
      app: {
        workspace: {
          getActiveViewOfType: () => view,
          getLeavesOfType: () => [],
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    const enter = vi.fn();
    let resolveMount!: (mounted: unknown) => void;
    const mount = new Promise((resolve) => {
      resolveMount = resolve;
    });
    const ensureMounted = vi.fn(() => mount);
    (
      manager as unknown as {
        ensureMounted: typeof ensureMounted;
      }
    ).ensureMounted = ensureMounted;

    const first = manager.toggle(view);
    const second = manager.toggle(view);

    expect(registeredIcon).toBe('paintbrush');
    expect(second).toBe(first);
    expect(ensureMounted).toHaveBeenCalledTimes(1);
    expect(action.classList.contains('is-pending')).toBe(true);
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.getAttribute('aria-label')).toBe('Opening Ink Mode…');

    resolveMount({ controller: { enter } });
    await first;

    expect(enter).toHaveBeenCalledTimes(1);
    expect(action.classList.contains('is-pending')).toBe(false);
    expect(action.getAttribute('aria-busy')).toBe('false');
    expect(action.getAttribute('aria-pressed')).toBe('true');
    manager.dispose();
  });

  it('detaches a mounted Ink overlay before reloading canonical surfaces for a file', async () => {
    const overlay = document.createElement('div');
    document.body.append(overlay);
    const view = { contentEl: document.createElement('div') } as unknown as MarkdownView;
    const dispose = vi.fn(() => overlay.remove());
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => null, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    const mounted = (
      manager as unknown as {
        mounted: Map<MarkdownView, unknown>;
      }
    ).mounted;
    mounted.set(view, {
      complete: true,
      controller: { dispose },
      filePath: 'Ink.md',
      session: {},
    });
    const ensureMounted = vi.fn(() => Promise.resolve(null));
    (
      manager as unknown as {
        ensureMounted: typeof ensureMounted;
      }
    ).ensureMounted = ensureMounted;

    await (manager as unknown as { refreshFile: (filePath: string) => Promise<void> }).refreshFile(
      'Ink.md',
    );

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(overlay.isConnected).toBe(false);
    expect(ensureMounted).toHaveBeenCalledWith(view, false);
    manager.dispose();
  });

  it('reclaims empty canonical surfaces only after Ink exit has flushed', async () => {
    const view = { contentEl: document.createElement('div') } as unknown as MarkdownView;
    const exit = vi.fn(() => Promise.resolve());
    const dispose = vi.fn();
    const reclaimEmptySurfaces = vi.fn(() => Promise.resolve([]));
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces } as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      ensureMounted: () => Promise<null>;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: { dispose, exit },
      filePath: 'Ink.md',
      session: {},
    });
    privateManager.ensureMounted = vi.fn(() => Promise.resolve(null));

    await manager.exit();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(reclaimEmptySurfaces).toHaveBeenCalledWith('Ink.md', expect.any(String), 'device-a');
    expect(exit.mock.invocationCallOrder[0]).toBeLessThan(
      reclaimEmptySurfaces.mock.invocationCallOrder[0] as number,
    );
    manager.dispose();
  });
});
