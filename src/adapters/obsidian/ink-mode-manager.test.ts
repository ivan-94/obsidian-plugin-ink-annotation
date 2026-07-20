// @vitest-environment jsdom

import { MarkdownView } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeInkSurfaceRecord, type InkSurfaceRecord } from '../../domain/ink-surface';
import type { InkSurfaceSummary } from '../../domain/ink-surface-summary';
import type { InkWorkerPresentationPreparationFactory } from '../../ui/ink-render-runtime';
import { ObsidianInkModeManager } from './ink-mode-manager';

interface LoadedInkSurfacesForTest {
  readonly conflicts: readonly [];
  readonly issues: readonly [];
  readonly records: readonly InkSurfaceRecord[];
}

vi.mock('obsidian', () => ({
  MarkdownView: class {},
  Notice: class {},
  setIcon: (element: HTMLElement, icon: string) => {
    element.dataset.icon = icon;
  },
  setTooltip: (element: HTMLElement, tooltip: string) => {
    element.dataset.tooltip = tooltip;
  },
}));

afterEach(() => {
  Reflect.deleteProperty(
    globalThis,
    Symbol.for('inkstone.annotations.retained-ink-session-owners.v2'),
  );
});

function menuRecorder<Item extends { icon?: string; onClick?: () => void; title?: string }>(
  items: Item[],
) {
  return {
    addItem(configure: (item: unknown) => void) {
      const record: Item = {} as Item;
      const item = {
        onClick(callback: () => void) {
          record.onClick = callback;
          return item;
        },
        setIcon(icon: string) {
          record.icon = icon;
          return item;
        },
        setSection() {
          return item;
        },
        setTitle(title: string) {
          record.title = title;
          return item;
        },
      };
      configure(item);
      items.push(record);
    },
  };
}

describe('Obsidian Ink Mode action', () => {
  it('does not treat a transient window blur as a confirmed background-idle save signal', async () => {
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    const background = vi.spyOn(manager, 'background').mockResolvedValue();

    document.defaultView?.dispatchEvent(new Event('blur'));
    await Promise.resolve();

    expect(background).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('fails closed before mounting a partial note when one surface has a schema-version conflict', async () => {
    const view = markdownView('Ink.md');
    const partialRecord = inkSurface('Ink.md');
    const conflictedV2 = { ...partialRecord, id: 'conflicted', schemaVersion: 2 as const };
    const conflictedV3 = { ...conflictedV2, schemaVersion: 3 as const };
    const getOrCreateNote = vi.fn(() => Promise.resolve({ noteId: partialRecord.noteId }));
    const writeSurface = vi.fn(() => Promise.resolve());
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: { getLeavesOfType: () => [] },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () =>
          Promise.resolve({
            conflicts: [
              {
                candidates: [
                  { path: 'conflicted.json', record: conflictedV3 },
                  { path: 'conflicted iCloud.json', record: conflictedV2 },
                ],
                kind: 'schema-version-mismatch',
                selectedPath: 'conflicted.json',
                surfaceId: conflictedV2.id,
              },
            ],
            issues: [
              {
                kind: 'conflict',
                message: 'schema-version-mismatch; no candidate is editable',
                path: 'conflicted.json',
              },
            ],
            records: [partialRecord],
          }),
        writeSurface,
      } as never,
      preferenceStore: {} as never,
      textRepository: { getOrCreateNote } as never,
    });

    const mounted = await (
      manager as unknown as {
        mountView: (view: MarkdownView, createIfMissing: boolean) => Promise<unknown>;
      }
    ).mountView(view, true);

    expect(mounted).toBeNull();
    expect(getOrCreateNote).not.toHaveBeenCalled();
    expect(writeSurface).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('fails closed before mounting or writing when the note contains unsupported Ink', async () => {
    const contentEl = document.createElement('div');
    contentEl.append(readingHost(1_200));
    const view = {
      contentEl,
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const writeSurface = vi.fn(() => Promise.resolve());
    const getOrCreateNote = vi.fn(() => Promise.resolve({ noteId: 'note-a' }));
    const onIssue = vi.fn();
    const unsupportedIssue = {
      kind: 'unsupported-record',
      message: 'Ink uses a newer schema; update Inkstone before editing this note.',
      path: '.obsidian-annotations/v1/notes/hash/surfaces/surface-1.json',
      reason: 'unsupported-schema-version',
    } as const;
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: { getLeavesOfType: () => [] },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () =>
          Promise.resolve({ conflicts: [], issues: [unsupportedIssue], records: [] }),
        writeSurface,
      } as never,
      onIssue,
      preferenceStore: {} as never,
      textRepository: { getOrCreateNote } as never,
    });

    const mounted = await (
      manager as unknown as {
        mountView: (view: MarkdownView, createIfMissing: boolean) => Promise<unknown>;
      }
    ).mountView(view, true);

    expect(mounted).toBeNull();
    expect(onIssue).toHaveBeenCalledWith(unsupportedIssue);
    expect(getOrCreateNote).not.toHaveBeenCalled();
    expect(writeSurface).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('fails closed before mounting a partial note when canonical Ink is corrupt', async () => {
    const view = markdownView('Ink.md');
    const partialRecord = inkSurface('Ink.md');
    const getOrCreateNote = vi.fn(() => Promise.resolve({ noteId: partialRecord.noteId }));
    const onIssue = vi.fn();
    const corruptIssue = {
      kind: 'corrupt-record',
      message: 'Ink surface record is not valid JSON.',
      path: '.obsidian-annotations/v1/notes/hash/surfaces/corrupt.json',
    } as const;
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: { getLeavesOfType: () => [] },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () =>
          Promise.resolve({
            conflicts: [],
            issues: [corruptIssue],
            records: [partialRecord],
          }),
      } as never,
      onIssue,
      preferenceStore: {} as never,
      textRepository: { getOrCreateNote } as never,
    });

    const mounted = await (
      manager as unknown as {
        mountView: (view: MarkdownView, createIfMissing: boolean) => Promise<unknown>;
      }
    ).mountView(view, true);

    expect(mounted).toBeNull();
    expect(onIssue).toHaveBeenCalledWith(corruptIssue);
    expect(getOrCreateNote).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('opens one historical v1 surface without eagerly rewriting it to schema v2', async () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(canvasContext());
    const current = inkSurface('Ink.md');
    const { originY: _originY, ...legacyLayout } = current.layout;
    void _originY;
    const legacy: InkSurfaceRecord = {
      ...current,
      layout: legacyLayout,
      schemaVersion: 1,
    };
    const updateSurfacesAtomically = vi.fn(() => Promise.resolve());
    const view = markdownView('Ink.md');
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: { getLeavesOfType: () => [] },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () => Promise.resolve({ conflicts: [], issues: [], records: [legacy] }),
        updateSurfacesAtomically,
      } as never,
      preferenceStore: {
        load: () => ({ color: '#d97777', hintShown: true, tool: 'pen', width: 4 }),
        save: () => undefined,
      } as never,
      textRepository: {
        getOrCreateNote: () => Promise.resolve({ noteId: legacy.noteId }),
      } as never,
    });

    const mounted = await (
      manager as unknown as {
        mountView: (view: MarkdownView, createIfMissing: boolean) => Promise<unknown>;
      }
    ).mountView(view, true);

    expect(updateSurfacesAtomically).not.toHaveBeenCalled();
    expect(mounted).not.toBeNull();
    manager.dispose();
    getContext.mockRestore();
  });

  it('fails closed without writes when multiple historical v1 surfaces have no canonical order', async () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(canvasContext());
    const current = inkSurface('Ink.md');
    const { originY: _originY, ...legacyLayout } = current.layout;
    void _originY;
    const first: InkSurfaceRecord = {
      ...current,
      layout: legacyLayout,
      schemaVersion: 1,
    };
    const second: InkSurfaceRecord = { ...first, id: 'surface-b' };
    const updateSurfacesAtomically = vi.fn(() => Promise.resolve());
    const getOrCreateNote = vi.fn(() => Promise.resolve({ noteId: first.noteId }));
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: { getLeavesOfType: () => [] },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () =>
          Promise.resolve({ conflicts: [], issues: [], records: [second, first] }),
        updateSurfacesAtomically,
      } as never,
      preferenceStore: {
        load: () => ({ color: '#d97777', hintShown: true, tool: 'pen', width: 4 }),
        save: () => undefined,
      } as never,
      textRepository: { getOrCreateNote } as never,
    });

    const mounted = await (
      manager as unknown as {
        mountView: (view: MarkdownView, createIfMissing: boolean) => Promise<unknown>;
      }
    ).mountView(markdownView('Ink.md'), true);

    expect(mounted).toBeNull();
    expect(getOrCreateNote).not.toHaveBeenCalled();
    expect(updateSurfacesAtomically).not.toHaveBeenCalled();
    manager.dispose();
    getContext.mockRestore();
  });

  it('forwards the explicitly selected Worker presentation Adapter into mounted Ink', async () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(canvasContext());
    const prepare: InkWorkerPresentationPreparationFactory = vi.fn(() =>
      Promise.resolve({ failureCategory: 'api-unavailable', kind: 'unavailable' } as const),
    );
    const contentEl = document.createElement('div');
    contentEl.append(readingHost(1_200));
    const view = {
      contentEl,
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: { getLeavesOfType: () => [] },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () => Promise.resolve({ conflicts: [], records: [] }),
        writeSurface: () => Promise.resolve(),
      } as never,
      preferenceStore: {
        load: () => ({ color: '#d97777', hintShown: true, tool: 'pen', width: 4 }),
        save: () => undefined,
      } as never,
      textRepository: {
        getOrCreateNote: () => Promise.resolve({ noteId: 'note-a' }),
      } as never,
      workerPresentation: { enabled: true, prepare },
    });

    await (
      manager as unknown as {
        mountView: (view: MarkdownView, createIfMissing: boolean) => Promise<unknown>;
      }
    ).mountView(view, true);

    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(manager.activePresentationAdapterState).toBeNull();
    (manager as unknown as { activeView: MarkdownView | null }).activeView = view;
    expect(manager.activePresentationAdapterState).toEqual({
      adapter: 'main-canvas-2d',
      epoch: 1,
      requestedAdapter: 'worker-offscreen-2d',
    });
    manager.dispose();
    getContext.mockRestore();
  });

  it('locates Ink in the current Markdown file without reopening that file', async () => {
    const file = { path: 'Ink.md' };
    const view = Object.assign(new MarkdownView({} as never), {
      contentEl: document.createElement('div'),
      file,
    });
    const openFile = vi.fn(() => Promise.resolve());
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { getFileByPath: () => file },
        workspace: { getLeaf: () => ({ openFile, view }), getLeavesOfType: () => [] },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });

    await manager.navigateToSurface(inkSummary());

    expect(openFile).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('presents Raw without Ink as an explicit start action instead of a toggle', () => {
    const action = document.createElement('button');
    let registeredIcon = '';
    let registeredTitle = '';
    const view = {
      addAction: (icon: string, title: string): HTMLElement => {
        registeredIcon = icon;
        registeredTitle = title;
        return action;
      },
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });

    manager.registerView(view);

    expect(registeredIcon).toBe('paintbrush');
    expect(registeredTitle).toBe('开始涂鸦');
    expect(action.dataset.icon).toBe('paintbrush');
    expect(action.dataset.tooltip).toBe('开始涂鸦');
    expect(action.getAttribute('aria-label')).toBe('开始涂鸦');
    expect(action.hasAttribute('aria-pressed')).toBe(false);
    manager.dispose();
  });

  it('keeps Ink discovery and controls dormant until the Markdown view enters Reading View', async () => {
    let mode = 'source';
    const action = document.createElement('button');
    const addAction = vi.fn(() => action);
    const listSurfaceSummaries = vi.fn(() => Promise.resolve([{ strokeCount: 1 }]));
    const view = {
      addAction,
      contentEl: document.createElement('div'),
      file: { path: 'Ink.md' },
      getMode: () => mode,
    } as unknown as MarkdownView;
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { listSurfaceSummaries } as never,
      preferenceStore: {} as never,
      showInkPreviewByDefault: true,
      textRepository: {} as never,
    });

    manager.registerView(view);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(addAction).not.toHaveBeenCalled();
    expect(listSurfaceSummaries).not.toHaveBeenCalled();

    mode = 'preview';
    manager.registerView(view);

    await vi.waitFor(() => expect(listSurfaceSummaries).toHaveBeenCalledOnce());
    expect(addAction).toHaveBeenCalledOnce();
    expect(action.hidden).toBe(false);
    manager.dispose();
  });

  it('refreshes the active Ink attachment when Obsidian reports a layout change', async () => {
    const contentEl = document.createElement('div');
    const view = {
      addAction: () => document.createElement('button'),
      contentEl,
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const enter = vi.fn();
    const mounted = {
      complete: true,
      controller: { dispose: vi.fn(), enter },
      filePath: 'Ink.md',
      session: {},
    };
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    const ensureMounted = vi.fn(() => Promise.resolve(mounted));
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      ensureMounted: typeof ensureMounted;
      mounted: Map<MarkdownView, unknown>;
    };
    manager.registerView(view);
    privateManager.activeView = view;
    privateManager.mounted.set(view, mounted);
    privateManager.ensureMounted = ensureMounted;

    manager.registerView(view);

    await vi.waitFor(() => expect(ensureMounted).toHaveBeenCalledWith(view, true));
    expect(enter).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('keeps the live active session when a replacement root reports a larger height', async () => {
    const contentEl = document.createElement('div');
    const host = document.createElement('div');
    host.className = 'markdown-preview-view';
    const root = document.createElement('div');
    root.className = 'markdown-preview-sizer';
    host.append(root);
    contentEl.append(host);
    Object.defineProperty(root, 'scrollHeight', { value: 1_600 });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 704, 1_600));
    const view = {
      contentEl,
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const dispose = vi.fn();
    const reattach = vi.fn();
    const mounted = {
      complete: true,
      controller: {
        coversHeight: () => false,
        dispose,
        isAttachedTo: () => false,
        reattach,
      },
      filePath: 'Ink.md',
      session: {},
    };
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mountView: (view: MarkdownView, createIfMissing: boolean) => Promise<unknown>;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, mounted);

    await expect(privateManager.mountView(view, true)).resolves.toBe(mounted);

    expect(dispose).not.toHaveBeenCalled();
    expect(reattach).toHaveBeenCalledWith(root, host, host);
    manager.dispose();
  });

  it('does not start a layout refresh while the same toolbar action is exiting Ink', async () => {
    const view = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const exit = vi.fn(() => Promise.resolve());
    const dispose = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces: () => Promise.resolve([]) } as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    manager.registerView(view);
    const ensureMounted = vi.fn(() => Promise.resolve(null));
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      ensureMounted: typeof ensureMounted;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: { dispose, exit },
      filePath: 'Ink.md',
      session: { read: () => ({ strokeCount: 0 }) },
    });
    privateManager.ensureMounted = ensureMounted;

    await manager.toggle(view);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(ensureMounted).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('flushes the active session before the same Markdown view switches files', async () => {
    let file = { path: 'Old.md' };
    const view = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
      get file() {
        return file;
      },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const exit = vi.fn(() => Promise.resolve());
    const dispose = vi.fn();
    const reclaimEmptySurfaces = vi.fn(() => Promise.resolve([]));
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces } as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    manager.registerView(view);
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: { dispose, exit },
      filePath: 'Old.md',
      session: { read: () => ({ strokeCount: 0 }) },
    });

    file = { path: 'New.md' };
    manager.registerView(view);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith('raw'));
    expect(exit.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0] ?? 0);
    expect(reclaimEmptySurfaces).toHaveBeenCalledWith('Old.md', expect.any(String), 'device-a');
    expect(privateManager.activeView).toBeNull();
    manager.dispose();
  });

  it('provides a barrier behind queued view reconciliation', async () => {
    const view = { contentEl: document.createElement('div') } as unknown as MarkdownView;
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    let release = (): void => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const privateManager = manager as unknown as {
      refreshQueue: {
        schedule: (view: MarkdownView, task: () => Promise<void>) => Promise<void>;
      };
    };
    void privateManager.refreshQueue.schedule(view, () => pending);
    let synchronized = false;
    const barrier = manager.synchronizeRegisteredView(view).then(() => {
      synchronized = true;
    });
    await Promise.resolve();
    expect(synchronized).toBe(false);

    release();
    await barrier;

    expect(synchronized).toBe(true);
    manager.dispose();
  });

  it('flushes and detaches active Ink when the same Markdown view leaves Reading View', async () => {
    let mode = 'preview';
    const action = document.createElement('button');
    const view = {
      addAction: () => action,
      contentEl: document.createElement('div'),
      file: { path: 'Ink.md' },
      getMode: () => mode,
    } as unknown as MarkdownView;
    const exit = vi.fn(() => Promise.resolve());
    const dispose = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces: () => Promise.resolve([]) } as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    manager.registerView(view);
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: { dispose, exit },
      filePath: 'Ink.md',
      session: { read: () => ({ strokeCount: 0 }) },
    });

    mode = 'source';
    manager.registerView(view);

    expect(action.hidden).toBe(true);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith('raw'));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(privateManager.activeView).toBeNull();
    manager.dispose();
  });

  it('uses a programmatic Ink toggle in editing mode only to flush a stale active session', async () => {
    const view = {
      contentEl: document.createElement('div'),
      file: { path: 'Ink.md' },
      getMode: () => 'source',
    } as unknown as MarkdownView;
    const exit = vi.fn(() => Promise.resolve());
    const dispose = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces: () => Promise.resolve([]) } as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: { dispose, exit },
      filePath: 'Ink.md',
      session: { read: () => ({ strokeCount: 1 }) },
    });

    await manager.toggle(view);

    expect(exit).toHaveBeenCalledWith('raw');
    expect(dispose).toHaveBeenCalledOnce();
    expect(privateManager.activeView).toBeNull();
    manager.dispose();
  });

  it('detaches a passive Ink preview when the Markdown view enters editing mode', async () => {
    let mode = 'preview';
    const action = document.createElement('button');
    const view = {
      addAction: () => action,
      contentEl: document.createElement('div'),
      file: { path: 'Ink.md' },
      getMode: () => mode,
    } as unknown as MarkdownView;
    const dispose = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    manager.registerView(view);
    const privateManager = manager as unknown as {
      mounted: Map<MarkdownView, unknown>;
      previewViews: Set<MarkdownView>;
    };
    privateManager.mounted.set(view, {
      complete: true,
      controller: { dispose },
      filePath: 'Ink.md',
      session: {},
    });
    privateManager.previewViews.add(view);

    mode = 'source';
    manager.registerView(view);

    expect(action.hidden).toBe(true);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(privateManager.mounted.has(view)).toBe(false);
    manager.dispose();
  });

  it('serializes repeated layout refreshes while an incompatible active view is flushing', async () => {
    let mode = 'preview';
    const view = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
      file: { path: 'Ink.md' },
      getMode: () => mode,
    } as unknown as MarkdownView;
    let resolveExit!: () => void;
    const pendingExit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const exit = vi.fn(() => pendingExit);
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces: () => Promise.resolve([]) } as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    manager.registerView(view);
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: { dispose: vi.fn(), exit },
      filePath: 'Ink.md',
      session: { read: () => ({ state: { dirty: false, kind: 'ink-mode' }, strokeCount: 0 }) },
    });

    mode = 'source';
    manager.registerView(view);
    manager.registerView(view);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    resolveExit();
    await vi.waitFor(() => expect(privateManager.activeView).toBeNull());
    expect(exit).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it('flushes the old active file when the view switches files during font readiness', async () => {
    const fonts = pendingDocumentFonts();
    let file = { path: 'Old.md' };
    let fileReads = 0;
    const view = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
      get file() {
        fileReads += 1;
        return file;
      },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const exit = vi.fn(() => Promise.resolve());
    const dispose = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces: () => Promise.resolve([]) } as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    manager.registerView(view);
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: { dispose, exit },
      filePath: 'Old.md',
      session: { read: () => ({ strokeCount: 0 }) },
    });

    manager.registerView(view);
    await vi.waitFor(() => expect(fileReads).toBeGreaterThanOrEqual(3));
    file = { path: 'New.md' };
    fonts.resolve();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith('raw'));
    expect(exit.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0] ?? 0);
    fonts.restore();
    manager.dispose();
  });

  it('flushes active Ink when the view leaves Reading View during font readiness', async () => {
    const fonts = pendingDocumentFonts();
    let mode = 'preview';
    let modeReads = 0;
    const view = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
      file: { path: 'Ink.md' },
      getMode: () => {
        modeReads += 1;
        return mode;
      },
    } as unknown as MarkdownView;
    const exit = vi.fn(() => Promise.resolve());
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces: () => Promise.resolve([]) } as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    manager.registerView(view);
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: { dispose: vi.fn(), exit },
      filePath: 'Ink.md',
      session: { read: () => ({ state: { dirty: false, kind: 'ink-mode' }, strokeCount: 0 }) },
    });

    manager.registerView(view);
    await vi.waitFor(() => expect(modeReads).toBeGreaterThanOrEqual(2));
    mode = 'source';
    fonts.resolve();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith('raw'));
    fonts.restore();
    manager.dispose();
  });

  it('does not show a pending automatic preview after the preference is disabled', async () => {
    const view = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const showPreview = vi.fn();
    const dispose = vi.fn();
    const mounted = {
      complete: true,
      controller: { dispose, showPreview },
      filePath: 'Ink.md',
      session: {},
    };
    let resolveMount!: () => void;
    const pendingMount = new Promise<typeof mounted>((resolve) => {
      resolveMount = () => resolve(mounted);
    });
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      showInkPreviewByDefault: true,
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      ensureMounted: () => Promise<typeof mounted>;
      mounted: Map<MarkdownView, typeof mounted>;
    };
    privateManager.ensureMounted = vi.fn(() => pendingMount);

    manager.registerView(view);
    await manager.setPreviewByDefault(false);
    privateManager.mounted.set(view, mounted);
    resolveMount();

    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(showPreview).not.toHaveBeenCalled();
    expect(privateManager.mounted.has(view)).toBe(false);
    manager.dispose();
  });

  it('measures the current Reading View only after fonts become layout-stable', async () => {
    const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    let resolveFonts!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveFonts = resolve;
    });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready },
    });
    const contentEl = document.createElement('div');
    const firstHost = document.createElement('div');
    firstHost.className = 'markdown-preview-view';
    const firstRoot = document.createElement('div');
    firstRoot.className = 'markdown-preview-sizer';
    firstHost.append(firstRoot);
    contentEl.append(firstHost);
    Object.defineProperty(firstRoot, 'scrollHeight', { configurable: true, value: 1_200 });
    vi.spyOn(firstRoot, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 704, 1_200));
    const view = {
      contentEl,
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const isAttachedTo = vi.fn<
      (root: HTMLElement, host: HTMLElement, scroll: HTMLElement | null) => boolean
    >(() => false);
    const reattach =
      vi.fn<(root: HTMLElement, host: HTMLElement, scroll: HTMLElement | null) => void>();
    const mounted = {
      complete: true,
      controller: {
        coversHeight: () => true,
        dispose: vi.fn(),
        isAttachedTo,
        reattach,
      },
      filePath: 'Ink.md',
      session: {},
    };
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    (
      manager as unknown as {
        mounted: Map<MarkdownView, unknown>;
      }
    ).mounted.set(view, mounted);

    const mounting = (
      manager as unknown as {
        mountView: (view: MarkdownView, createIfMissing: boolean) => Promise<unknown>;
      }
    ).mountView(view, true);
    const replacementHost = document.createElement('div');
    replacementHost.className = 'markdown-preview-view';
    const replacementRoot = document.createElement('div');
    replacementRoot.className = 'markdown-preview-sizer';
    replacementHost.append(replacementRoot);
    Object.defineProperty(replacementRoot, 'scrollHeight', { configurable: true, value: 1_200 });
    vi.spyOn(replacementRoot, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 704, 1_200),
    );
    firstHost.replaceWith(replacementHost);
    resolveFonts();

    await mounting;

    expect(isAttachedTo.mock.calls[0]?.[0]).toBe(replacementRoot);
    expect(isAttachedTo.mock.calls[0]?.[1]).toBe(replacementHost);
    expect(isAttachedTo.mock.calls[0]?.[2]).toBe(replacementHost);
    expect(reattach.mock.calls[0]?.[0]).toBe(replacementRoot);
    expect(reattach.mock.calls[0]?.[1]).toBe(replacementHost);
    expect(reattach.mock.calls[0]?.[2]).toBe(replacementHost);
    manager.dispose();
    if (originalFonts === undefined) {
      Reflect.deleteProperty(document, 'fonts');
    } else {
      Object.defineProperty(document, 'fonts', originalFonts);
    }
  });

  it('reattaches a newly persisted surface to the current DOM after an async write', async () => {
    const context = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      lineCap: 'round',
      lineJoin: 'round',
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      setTransform: vi.fn(),
      stroke: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const contentEl = document.createElement('div');
    const firstHost = readingHost(1_200);
    const firstRoot = firstHost.querySelector<HTMLElement>('.markdown-preview-sizer');
    if (firstRoot === null) throw new Error('Missing first Reading View root.');
    contentEl.append(firstHost);
    const view = {
      contentEl,
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    let resolveWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const writeSurface = vi.fn(() => pendingWrite);
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: { getLeavesOfType: () => [] },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () => Promise.resolve({ conflicts: [], records: [] }),
        writeSurface,
      } as never,
      preferenceStore: {
        load: () => ({ color: '#d97777', hintShown: true, tool: 'pen', width: 4 }),
        save: () => undefined,
      } as never,
      textRepository: {
        getOrCreateNote: () => Promise.resolve({ noteId: 'note-a' }),
      } as never,
    });

    const mounting = (
      manager as unknown as {
        mountView: (view: MarkdownView, createIfMissing: boolean) => Promise<unknown>;
      }
    ).mountView(view, true);
    await vi.waitFor(() => expect(writeSurface).toHaveBeenCalledTimes(1));
    const replacementHost = readingHost(1_400);
    const replacementRoot = replacementHost.querySelector<HTMLElement>('.markdown-preview-sizer');
    if (replacementRoot === null) throw new Error('Missing replacement Reading View root.');
    firstHost.replaceWith(replacementHost);
    resolveWrite();

    const mounted = (await mounting) as {
      controller: {
        isAttachedTo: (root: HTMLElement, host: HTMLElement, scroll: HTMLElement) => boolean;
      };
    };

    expect(mounted.controller.isAttachedTo(replacementRoot, replacementHost, replacementHost)).toBe(
      true,
    );
    manager.dispose();
    getContext.mockRestore();
  });

  it('saves after reopening canonical Ink on a taller rendered document', async () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(canvasContext());
    const canonical = inkSurface('Ink.md');
    let persisted = canonical;
    const updateSurface = vi.fn(
      (record: InkSurfaceRecord, expectedBase?: InkSurfaceRecord): Promise<void> => {
        if (
          expectedBase === undefined ||
          encodeInkSurfaceRecord(expectedBase) !== encodeInkSurfaceRecord(persisted)
        ) {
          return Promise.reject(new Error('Ink surface changed since the expected base was read.'));
        }
        persisted = record;
        return Promise.resolve();
      },
    );
    const contentEl = document.createElement('div');
    contentEl.append(readingHost(1_800));
    const view = {
      contentEl,
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: { getLeavesOfType: () => [] },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () => Promise.resolve({ conflicts: [], records: [canonical] }),
        updateSurface,
      } as never,
      preferenceStore: {
        load: () => ({ color: '#d97777', hintShown: true, tool: 'pen', width: 4 }),
        save: () => undefined,
      } as never,
      liveFirstPersistence: {
        legacyRecoveryReader: { load: () => null },
      },
      textRepository: {
        getOrCreateNote: () => Promise.resolve({ noteId: canonical.noteId }),
      } as never,
    });
    const mounted = await (
      manager as unknown as {
        mountView: (
          view: MarkdownView,
          createIfMissing: boolean,
        ) => Promise<{
          session: {
            addStroke: (stroke: InkSurfaceRecord['strokes'][number]) => void;
            background: () => Promise<void>;
          };
        }>;
      }
    ).mountView(view, true);

    mounted.session.addStroke(inkStroke('after-transient-extent'));
    await mounted.session.background();

    const [savedRecord, savedExpectedBase] = updateSurface.mock.calls[0] ?? [];
    expect(savedRecord).toMatchObject({
      layout: { logicalHeight: 1_800 },
      revision: 2,
    });
    expect(savedExpectedBase).toBe(canonical);
    expect(persisted).toMatchObject({
      layout: { logicalHeight: 1_800 },
      revision: 2,
      strokes: [canonical.strokes[0], expect.objectContaining({ id: 'after-transient-extent' })],
    });
    manager.dispose();
    getContext.mockRestore();
  });

  it('opens existing Ink in preview when the default preview preference is enabled', async () => {
    const contentEl = document.createElement('div');
    const action = document.createElement('button');
    const view = {
      addAction: () => action,
      contentEl,
    } as unknown as MarkdownView;
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      showInkPreviewByDefault: true,
      textRepository: {} as never,
    });
    const showPreview = vi.fn();
    const ensureMounted = vi.fn(() =>
      Promise.resolve({ controller: { showPreview }, filePath: 'Ink.md' }),
    );
    (
      manager as unknown as {
        ensureMounted: typeof ensureMounted;
      }
    ).ensureMounted = ensureMounted;

    manager.registerView(view);
    await vi.waitFor(() => expect(showPreview).toHaveBeenCalledTimes(1));

    expect(ensureMounted).toHaveBeenCalledWith(view, false);
    expect(action.dataset.icon).toBe('paintbrush');
    expect(action.dataset.tooltip).toBe('正在预览涂鸦 · 编辑');
    expect(action.getAttribute('aria-label')).toBe('正在预览涂鸦 · 编辑');
    expect(action.hasAttribute('aria-pressed')).toBe(false);
    expect(action.classList.contains('is-preview')).toBe(true);
    manager.dispose();
  });

  it('presents hidden Ink as Show Preview and opens Preview instead of Edit', async () => {
    const action = document.createElement('button');
    const view = {
      addAction: (_icon: string, _title: string, callback: (event: MouseEvent) => void) => {
        action.addEventListener('click', callback);
        return action;
      },
      contentEl: document.createElement('div'),
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const showPreview = vi.fn();
    const enter = vi.fn();
    const mounted = {
      complete: true,
      controller: { dispose: vi.fn(), enter, showPreview },
      filePath: 'Ink.md',
      session: {},
    };
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaceSummaries: () => Promise.resolve([{ deletedAt: undefined, strokeCount: 2 }]),
      } as never,
      preferenceStore: {} as never,
      showInkPreviewByDefault: false,
      textRepository: {} as never,
    });
    (
      manager as unknown as {
        ensureMounted: () => Promise<typeof mounted>;
        mounted: Map<MarkdownView, typeof mounted>;
      }
    ).ensureMounted = vi.fn(() => {
      (
        manager as unknown as {
          mounted: Map<MarkdownView, typeof mounted>;
        }
      ).mounted.set(view, mounted);
      return Promise.resolve(mounted);
    });

    manager.registerView(view);

    await vi.waitFor(() => expect(action.dataset.icon).toBe('eye'));
    expect(action.classList.contains('has-hidden-ink')).toBe(true);
    expect(action.dataset.tooltip).toBe('涂鸦已隐藏 · 显示预览');
    expect(action.getAttribute('aria-label')).toBe('涂鸦已隐藏 · 显示预览');
    action.click();
    await vi.waitFor(() => expect(showPreview).toHaveBeenCalledTimes(1));

    expect(enter).not.toHaveBeenCalled();
    expect(action.classList.contains('is-preview')).toBe(true);
    manager.dispose();
  });

  it('does not let a stale derived summary claim that canonical Ink still exists', async () => {
    const action = document.createElement('button');
    const contentEl = document.createElement('div');
    contentEl.append(readingHost(1_200));
    const view = {
      addAction: () => action,
      contentEl,
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaceSummaries: () => Promise.resolve([{ strokeCount: 1 }]),
        listSurfaces: () => Promise.resolve({ conflicts: [], issues: [], records: [] }),
      } as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });

    manager.registerView(view);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(action.getAttribute('aria-label')).toBe('开始涂鸦');
    expect(action.dataset.icon).toBe('paintbrush');
    manager.dispose();
  });

  it('does not derive toolbar state from a partial schema-conflict projection', async () => {
    const partialRecord = inkSurface('Ink.md');
    const conflictedV2 = { ...partialRecord, id: 'conflicted' };
    const conflictedV3 = { ...conflictedV2, schemaVersion: 3 as const };
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () =>
          Promise.resolve({
            conflicts: [
              {
                candidates: [
                  { path: 'conflicted.json', record: conflictedV3 },
                  { path: 'conflicted iCloud.json', record: conflictedV2 },
                ],
                kind: 'schema-version-mismatch',
                selectedPath: 'conflicted.json',
                surfaceId: conflictedV2.id,
              },
            ],
            issues: [
              {
                kind: 'conflict',
                message: 'schema-version-mismatch; no candidate is editable',
                path: 'conflicted.json',
              },
            ],
            records: [partialRecord],
          }),
      } as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });

    const hasInk = await (
      manager as unknown as {
        readCanonicalFileHasInkState: (filePath: string) => Promise<boolean | null>;
      }
    ).readCanonicalFileHasInkState('Ink.md');

    expect(hasInk).toBeNull();
    manager.dispose();
  });

  it('turns a stale Show Preview click into Start drawing when canonical Ink disappeared', async () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(canvasContext());
    const action = document.createElement('button');
    let activate!: () => void;
    let hasCanonicalInk = true;
    const contentEl = document.createElement('div');
    contentEl.append(readingHost(1_200));
    const view = {
      addAction: (_icon: string, _title: string, callback: () => void) => {
        activate = callback;
        return action;
      },
      contentEl,
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const writeSurface = vi.fn(() => Promise.resolve());
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: {
          getActiveViewOfType: () => view,
          getLeavesOfType: () => [],
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () =>
          Promise.resolve({
            conflicts: [],
            issues: [],
            records: hasCanonicalInk ? [inkSurface('Ink.md')] : [],
          }),
        writeSurface,
      } as never,
      preferenceStore: {
        load: () => ({ color: '#d97777', hintShown: true, tool: 'pen', width: 4 }),
        save: () => undefined,
      } as never,
      textRepository: {
        getOrCreateNote: () => Promise.resolve({ noteId: 'note-a' }),
      } as never,
    });
    manager.registerView(view);
    await vi.waitFor(() => expect(action.getAttribute('aria-label')).toBe('涂鸦已隐藏 · 显示预览'));

    hasCanonicalInk = false;
    activate();

    await vi.waitFor(() => expect(action.getAttribute('aria-label')).toBe('完成涂鸦并预览'));
    expect(writeSurface).toHaveBeenCalled();
    manager.dispose();
    getContext.mockRestore();
  });

  it('recomputes the next action when an existing Markdown view changes files', async () => {
    const action = document.createElement('button');
    let file = { path: 'Ink.md' };
    const view = {
      addAction: () => action,
      contentEl: document.createElement('div'),
      get file() {
        return file;
      },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const listSurfaceSummaries = vi.fn((filePath: string) =>
      Promise.resolve(filePath === 'Ink.md' ? [{ strokeCount: 1 }] : []),
    );
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { listSurfaceSummaries } as never,
      preferenceStore: {} as never,
      showInkPreviewByDefault: false,
      textRepository: {} as never,
    });
    manager.registerView(view);
    await vi.waitFor(() => expect(action.dataset.icon).toBe('eye'));

    file = { path: 'Empty.md' };
    manager.registerView(view);

    await vi.waitFor(() => expect(listSurfaceSummaries).toHaveBeenCalledWith('Empty.md'));
    expect(action.dataset.icon).toBe('paintbrush');
    expect(action.getAttribute('aria-label')).toBe('开始涂鸦');
    manager.dispose();
  });

  it('places Close Preview only in the native more-options menu and returns to hidden Raw', async () => {
    const action = document.createElement('button');
    const originalPaneMenu = vi.fn();
    const view = {
      addAction: () => action,
      contentEl: document.createElement('div'),
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
      onPaneMenu: originalPaneMenu,
    } as unknown as MarkdownView;
    const dispose = vi.fn();
    const hidePreview = vi.fn();
    const showPreview = vi.fn();
    const mounted = {
      complete: true,
      controller: { dispose, hidePreview, showPreview },
      filePath: 'Ink.md',
      session: {},
    };
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaceSummaries: () => Promise.resolve([{ deletedAt: undefined, strokeCount: 2 }]),
      } as never,
      preferenceStore: {} as never,
      showInkPreviewByDefault: true,
      textRepository: {} as never,
    });
    (
      manager as unknown as {
        ensureMounted: () => Promise<typeof mounted>;
        mounted: Map<MarkdownView, typeof mounted>;
      }
    ).ensureMounted = vi.fn(() => {
      (
        manager as unknown as {
          mounted: Map<MarkdownView, typeof mounted>;
        }
      ).mounted.set(view, mounted);
      return Promise.resolve(mounted);
    });
    manager.registerView(view);
    await vi.waitFor(() => expect(showPreview).toHaveBeenCalledTimes(1));

    const tabItems: Array<{ title: string }> = [];
    const moreItems: Array<{
      icon: string;
      onClick: () => void;
      title: string;
    }> = [];
    view.onPaneMenu(menuRecorder(tabItems) as never, 'tab-header');
    view.onPaneMenu(menuRecorder(moreItems) as never, 'more-options');

    expect(originalPaneMenu).toHaveBeenCalledTimes(2);
    expect(tabItems).toEqual([]);
    expect(moreItems).toHaveLength(1);
    expect(moreItems[0]).toMatchObject({ icon: 'eye-off', title: '关闭涂鸦预览' });
    moreItems[0]?.onClick();
    await vi.waitFor(() => expect(hidePreview).toHaveBeenCalledTimes(1));

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(action.dataset.icon).toBe('eye');
    expect(action.getAttribute('aria-label')).toBe('涂鸦已隐藏 · 显示预览');
    manager.registerView(view);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showPreview).toHaveBeenCalledTimes(1);
    manager.dispose();
    expect(Reflect.get(view, 'onPaneMenu')).toBe(originalPaneMenu);
  });

  it('registers the Ink action without observing passive Reading DOM mutations', () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const view = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });

    manager.registerView(view);

    expect(observe).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('shows progress while entering and presents Edit as an explicit completion action', async () => {
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
    await vi.waitFor(() => expect(ensureMounted).toHaveBeenCalledTimes(1));
    expect(action.classList.contains('is-pending')).toBe(true);
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.getAttribute('aria-disabled')).toBe('true');
    expect(action.hasAttribute('disabled')).toBe(true);
    expect(action.dataset.icon).toBe('loader-circle');
    expect(action.getAttribute('aria-label')).toBe('正在打开涂鸦…');

    const mounted = {
      controller: {
        background: () => Promise.resolve(),
        dispose: vi.fn(),
        enter,
      },
      filePath: 'Ink.md',
      session: {},
    };
    (
      manager as unknown as {
        mounted: Map<MarkdownView, unknown>;
      }
    ).mounted.set(view, mounted);
    resolveMount(mounted);
    await first;

    expect(enter).toHaveBeenCalledTimes(1);
    expect(action.classList.contains('is-pending')).toBe(false);
    expect(action.getAttribute('aria-busy')).toBe('false');
    expect(action.getAttribute('aria-disabled')).toBe('false');
    expect(action.hasAttribute('disabled')).toBe(false);
    expect(action.dataset.icon).toBe('check');
    expect(action.dataset.tooltip).toBe('完成涂鸦并预览');
    expect(action.getAttribute('aria-label')).toBe('完成涂鸦并预览');
    expect(action.hasAttribute('aria-pressed')).toBe(false);
    manager.dispose();
  });

  it('keeps Edit visible after a failed completion save and turns the action into Retry', async () => {
    const action = document.createElement('button');
    const view = {
      addAction: () => action,
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const saveError = new Error('disk unavailable');
    const exit = vi.fn().mockRejectedValueOnce(saveError).mockResolvedValueOnce(undefined);
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces: () => Promise.resolve([]) } as never,
      preferenceStore: {} as never,
      showInkPreviewByDefault: true,
      textRepository: {} as never,
    });
    manager.registerView(view);
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: { dispose: vi.fn(), exit },
      filePath: 'Ink.md',
      session: { read: () => ({ strokeCount: 1 }) },
    });

    await expect(manager.toggle(view)).rejects.toBe(saveError);

    expect(privateManager.activeView).toBe(view);
    expect(action.dataset.icon).toBe('rotate-ccw');
    expect(action.dataset.tooltip).toBe('保存失败 · 重试');
    expect(action.getAttribute('aria-label')).toBe('保存失败 · 重试');
    expect(action.hasAttribute('aria-pressed')).toBe(false);

    await manager.toggle(view);

    expect(exit).toHaveBeenCalledTimes(2);
    expect(privateManager.activeView).toBeNull();
    expect(action.dataset.icon).toBe('paintbrush');
    expect(action.getAttribute('aria-label')).toBe('正在预览涂鸦 · 编辑');
    manager.dispose();
  });

  it('cancels a pending enter when the active leaf changes before mounting completes', async () => {
    const viewA = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const viewB = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    let activeView: MarkdownView | null = viewA;
    const manager = new ObsidianInkModeManager({
      app: {
        workspace: {
          getActiveViewOfType: () => activeView,
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
    const dispose = vi.fn();
    const mounted = {
      complete: true,
      controller: { dispose, enter },
      filePath: 'A.md',
      session: {},
    };
    let resolveMount!: () => void;
    const pendingMount = new Promise<typeof mounted>((resolve) => {
      resolveMount = () => resolve(mounted);
    });
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      ensureMounted: () => Promise<typeof mounted>;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.ensureMounted = vi.fn(() => pendingMount);

    const entering = manager.toggle(viewA);
    await vi.waitFor(() => expect(privateManager.ensureMounted).toHaveBeenCalled());
    activeView = viewB;
    manager.handleActiveLeafChange();
    privateManager.mounted.set(viewA, mounted);
    resolveMount();
    await entering;

    expect(enter).not.toHaveBeenCalled();
    expect(privateManager.activeView).toBeNull();
    expect(dispose).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it('retries a failed exit through the global owner transition before clearing ownership', async () => {
    const action = document.createElement('button');
    const view = {
      addAction: () => action,
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const persistenceError = new Error('disk unavailable');
    const exit = vi
      .fn<(target: 'raw' | 'preview') => Promise<void>>()
      .mockRejectedValueOnce(persistenceError)
      .mockResolvedValueOnce();
    const dispose = vi.fn();
    const controller = { dispose, exit, retrySave: vi.fn() };
    const mounted = {
      complete: true,
      controller,
      filePath: 'Ink.md',
      session: { read: () => ({ strokeCount: 0 }) },
    };
    const manager = new ObsidianInkModeManager({
      app: {
        workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces: () => Promise.resolve([]) } as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    manager.registerView(view);
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
      retryFailedSave: (view: MarkdownView, controller: unknown) => Promise<void>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, mounted);

    await expect(manager.exit()).rejects.toBe(persistenceError);
    expect(privateManager.activeView).toBe(view);

    await privateManager.retryFailedSave(view, controller);

    expect(exit).toHaveBeenNthCalledWith(1, 'raw');
    expect(exit).toHaveBeenNthCalledWith(2, 'raw');
    expect(privateManager.activeView).toBeNull();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(action.hasAttribute('aria-pressed')).toBe(false);
    manager.dispose();
  });

  it('retries a failed background save without releasing the active owner', async () => {
    const view = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const retrySave = vi.fn(() => Promise.resolve());
    const controller = { dispose: vi.fn(), retrySave };
    const manager = new ObsidianInkModeManager({
      app: {
        workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
      retryFailedSave: (view: MarkdownView, controller: unknown) => Promise<void>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller,
      filePath: 'Ink.md',
      session: {},
    });

    await privateManager.retryFailedSave(view, controller);

    expect(retrySave).toHaveBeenCalledTimes(1);
    expect(privateManager.activeView).toBe(view);
    manager.dispose();
  });

  it('migrates a legacy version-3 checkpoint with exact CAS bases without mutating its store', async () => {
    const firstBase = inkSurface('Ink.md');
    const secondBase = { ...inkSurface('Ink.md'), id: 'surface-b' };
    const firstPending = {
      ...firstBase,
      revision: 2,
      strokes: [...firstBase.strokes, inkStroke('pending-a')],
      updatedAt: '2026-07-16T01:00:00.000Z',
    };
    const secondPending = {
      ...secondBase,
      revision: 2,
      strokes: [...secondBase.strokes, inkStroke('pending-b')],
      updatedAt: '2026-07-16T01:00:00.000Z',
    };
    const updateSurfacesAtomically = vi.fn(() => Promise.resolve());
    const clear = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { updateSurfacesAtomically } as never,
      preferenceStore: {} as never,
      liveFirstPersistence: {
        legacyRecoveryReader: {
          load: () => ({
            capturedAt: '2026-07-16T01:00:00.000Z',
            expectedBases: [firstBase, secondBase],
            filePath: 'Ink.md',
            generation: 'generation-v3',
            pendingAttempts: [firstPending, secondPending],
            records: [firstPending, secondPending],
            version: 3,
          }),
        },
      },
      textRepository: {} as never,
    });
    const restoreLocalRecovery = (
      manager as unknown as {
        restoreLocalRecovery: (
          filePath: string,
          canonical: readonly InkSurfaceRecord[],
        ) => Promise<readonly InkSurfaceRecord[]>;
      }
    ).restoreLocalRecovery.bind(manager);

    await expect(restoreLocalRecovery('Ink.md', [firstBase, secondBase])).resolves.toMatchObject([
      { id: firstBase.id, revision: 2 },
      { id: secondBase.id, revision: 2 },
    ]);

    expect(updateSurfacesAtomically).toHaveBeenCalledWith(
      [firstPending, secondPending],
      [firstBase, secondBase],
    );
    expect(clear).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('invalidates stale preview mounts for the same file after one owner saves', () => {
    const ownerView = { contentEl: document.createElement('div') } as unknown as MarkdownView;
    const staleView = { contentEl: document.createElement('div') } as unknown as MarkdownView;
    const ownerSession = {};
    const staleDispose = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      invalidateSiblingMounts: (view: MarkdownView, filePath: string, session: unknown) => void;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = ownerView;
    privateManager.mounted.set(ownerView, {
      controller: { dispose: vi.fn() },
      filePath: 'Ink.md',
      session: ownerSession,
    });
    privateManager.mounted.set(staleView, {
      controller: { dispose: staleDispose },
      filePath: 'Ink.md',
      session: {},
    });

    privateManager.invalidateSiblingMounts(ownerView, 'Ink.md', ownerSession);

    expect(staleDispose).toHaveBeenCalledTimes(1);
    expect(privateManager.mounted.has(staleView)).toBe(false);
    expect(privateManager.mounted.has(ownerView)).toBe(true);
    manager.dispose();
  });

  it('serializes mounts for separate views of the same file', async () => {
    const firstView = markdownView('folder/../Serialized.md');
    const secondView = markdownView('./Serialized.md');
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    let concurrent = 0;
    let maximumConcurrent = 0;
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const mountView = vi.fn(async (view: MarkdownView) => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      if (view === firstView) await firstPending;
      concurrent -= 1;
      return null;
    });
    const privateManager = manager as unknown as {
      ensureMounted: (view: MarkdownView, createIfMissing: boolean) => Promise<unknown>;
      mountView: typeof mountView;
    };
    privateManager.mountView = mountView;

    const first = privateManager.ensureMounted(firstView, false);
    await vi.waitFor(() => expect(mountView).toHaveBeenCalledTimes(1));
    const second = privateManager.ensureMounted(secondView, false);
    await Promise.resolve();

    expect(mountView).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(mountView).toHaveBeenCalledTimes(2);
    expect(maximumConcurrent).toBe(1);
    manager.dispose();
  });

  it('queues a toggle for another view instead of swallowing it behind an in-flight toggle', async () => {
    const viewA = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const viewB = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    let activeView: MarkdownView | null = viewA;
    const manager = new ObsidianInkModeManager({
      app: {
        workspace: {
          getActiveViewOfType: () => activeView,
          getLeavesOfType: () => [],
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces: () => Promise.resolve([]) } as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    const enterA = vi.fn();
    const enterB = vi.fn();
    let resolveA!: () => void;
    let resolveB!: () => void;
    const mountedA = {
      controller: {
        background: () => Promise.resolve(),
        dispose: vi.fn(),
        enter: enterA,
        exit: vi.fn(() => Promise.resolve()),
      },
      filePath: 'A.md',
      session: { read: () => ({ strokeCount: 0 }) },
    };
    const mountedB = {
      controller: {
        background: () => Promise.resolve(),
        dispose: vi.fn(),
        enter: enterB,
      },
      filePath: 'B.md',
      session: {},
    };
    const pendingA = new Promise<typeof mountedA>((resolve) => {
      resolveA = () => resolve(mountedA);
    });
    const pendingB = new Promise<typeof mountedB>((resolve) => {
      resolveB = () => resolve(mountedB);
    });
    const ensureMounted = vi.fn((view: MarkdownView) => (view === viewA ? pendingA : pendingB));
    (
      manager as unknown as {
        ensureMounted: typeof ensureMounted;
      }
    ).ensureMounted = ensureMounted;

    const first = manager.toggle(viewA);
    activeView = viewB;
    const second = manager.toggle(viewB);

    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(ensureMounted).toHaveBeenCalledTimes(1));
    const privateManager = manager as unknown as {
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.mounted.set(viewA, mountedA);
    resolveA();
    await vi.waitFor(() => expect(ensureMounted).toHaveBeenCalledWith(viewB, true));
    privateManager.mounted.set(viewB, mountedB);
    resolveB();
    await second;

    expect(enterA).not.toHaveBeenCalled();
    expect(enterB).toHaveBeenCalledTimes(1);
    manager.dispose();
  });

  it('serializes an active-leaf exit with the next view toggle', async () => {
    const viewA = {
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const viewB = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    let resolveFirstExit!: () => void;
    const firstExit = new Promise<void>((resolve) => {
      resolveFirstExit = resolve;
    });
    const exitA = vi.fn(() => (exitA.mock.calls.length === 1 ? firstExit : Promise.resolve()));
    const enterB = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: {
        workspace: {
          getActiveViewOfType: () => viewB,
          getLeavesOfType: () => [],
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces: () => Promise.resolve([]) } as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      ensureMounted: (view: MarkdownView) => Promise<unknown>;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = viewA;
    privateManager.mounted.set(viewA, {
      complete: true,
      controller: { dispose: vi.fn(), exit: exitA },
      filePath: 'A.md',
      session: { read: () => ({ strokeCount: 0 }) },
    });
    const mountedB = {
      complete: true,
      controller: { dispose: vi.fn(), enter: enterB },
      filePath: 'B.md',
      session: {},
    };
    privateManager.ensureMounted = vi.fn(() => {
      privateManager.mounted.set(viewB, mountedB);
      return Promise.resolve(mountedB);
    });

    manager.handleActiveLeafChange();
    await vi.waitFor(() => expect(exitA).toHaveBeenCalledTimes(1));
    const toggleB = manager.toggle(viewB);
    await Promise.resolve();
    await Promise.resolve();

    expect(exitA).toHaveBeenCalledTimes(1);
    expect(enterB).not.toHaveBeenCalled();

    resolveFirstExit();
    await toggleB;

    expect(exitA).toHaveBeenCalledTimes(1);
    expect(enterB).toHaveBeenCalledTimes(1);
    expect(privateManager.activeView).toBe(viewB);
    manager.dispose();
  });

  it('keeps a dirty session mounted when passive-leave confirmation returns Cancel', async () => {
    const leafA = {};
    const viewA = {
      contentEl: document.createElement('div'),
      leaf: leafA,
    } as unknown as MarkdownView;
    const viewB = { contentEl: document.createElement('div') } as unknown as MarkdownView;
    const setActiveLeaf = vi.fn();
    const requestUnsavedExitDecision = vi.fn(() => Promise.resolve('cancel' as const));
    const exit = vi.fn(() => Promise.resolve());
    const controller = {
      background: () => Promise.resolve(),
      dispose: vi.fn(),
      exit,
    };
    const manager = new ObsidianInkModeManager({
      app: {
        workspace: {
          getActiveViewOfType: () => viewB,
          getLeavesOfType: () => [],
          setActiveLeaf,
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      requestUnsavedExitDecision,
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = viewA;
    privateManager.mounted.set(viewA, {
      complete: true,
      controller,
      filePath: 'A.md',
      session: {
        read: () => ({ state: { dirty: true, kind: 'ink-mode', saveError: null } }),
      },
    });

    manager.handleActiveLeafChange();
    await vi.waitFor(() => expect(requestUnsavedExitDecision).toHaveBeenCalledOnce());

    expect(exit).not.toHaveBeenCalled();
    expect(privateManager.activeView).toBe(viewA);
    expect(setActiveLeaf).toHaveBeenCalledWith(leafA, { focus: true });
    manager.dispose();
  });

  it('persists a dirty session before passive leave when Save is chosen', async () => {
    const leafA = {};
    const viewA = {
      contentEl: document.createElement('div'),
      leaf: leafA,
    } as unknown as MarkdownView;
    const viewB = { contentEl: document.createElement('div') } as unknown as MarkdownView;
    const exit = vi.fn(() => Promise.resolve());
    const dispose = vi.fn();
    const requestUnsavedExitDecision = vi.fn(() => Promise.resolve('save' as const));
    const manager = new ObsidianInkModeManager({
      app: {
        workspace: {
          getActiveViewOfType: () => viewB,
          getLeavesOfType: () => [],
          setActiveLeaf: vi.fn(),
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces: () => Promise.resolve([]) } as never,
      preferenceStore: {} as never,
      requestUnsavedExitDecision,
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = viewA;
    privateManager.mounted.set(viewA, {
      complete: true,
      controller: { background: vi.fn(), dispose, exit },
      filePath: 'A.md',
      session: {
        read: () => ({
          state: { dirty: true, kind: 'ink-mode', saveError: null },
          strokeCount: 1,
        }),
      },
    });

    manager.handleActiveLeafChange();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith('raw'));

    expect(requestUnsavedExitDecision).toHaveBeenCalledWith({
      filePath: 'A.md',
      reason: 'view-close',
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(privateManager.activeView).toBeNull();
    manager.dispose();
  });

  it('drops only the in-memory dirty session on passive leave when Discard is chosen', async () => {
    const viewA = {
      contentEl: document.createElement('div'),
      leaf: {},
    } as unknown as MarkdownView;
    const viewB = { contentEl: document.createElement('div') } as unknown as MarkdownView;
    const exit = vi.fn(() => Promise.resolve());
    const dispose = vi.fn();
    const reclaimEmptySurfaces = vi.fn(() => Promise.resolve([]));
    const manager = new ObsidianInkModeManager({
      app: {
        workspace: {
          getActiveViewOfType: () => viewB,
          getLeavesOfType: () => [],
          setActiveLeaf: vi.fn(),
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: { reclaimEmptySurfaces } as never,
      preferenceStore: {} as never,
      requestUnsavedExitDecision: () => Promise.resolve('discard'),
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = viewA;
    privateManager.mounted.set(viewA, {
      complete: true,
      controller: { background: vi.fn(), dispose, exit },
      filePath: 'A.md',
      session: {
        read: () => ({
          state: { dirty: true, kind: 'ink-mode', saveError: null },
          strokeCount: 1,
        }),
      },
    });

    manager.handleActiveLeafChange();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());

    expect(exit).not.toHaveBeenCalled();
    expect(reclaimEmptySurfaces).toHaveBeenCalledOnce();
    expect(privateManager.activeView).toBeNull();
    manager.dispose();
  });

  it('keeps a dirty session mounted when its Markdown view leaves Reading View and Cancel is chosen', async () => {
    let mode = 'preview';
    const leaf = {};
    const view = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
      file: { path: 'Ink.md' },
      getMode: () => mode,
      leaf,
    } as unknown as MarkdownView;
    const requestUnsavedExitDecision = vi.fn(() => Promise.resolve('cancel' as const));
    const exit = vi.fn(() => Promise.resolve());
    const setActiveLeaf = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [], setActiveLeaf } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      requestUnsavedExitDecision,
      textRepository: {} as never,
    });
    manager.registerView(view);
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: { background: vi.fn(), dispose: vi.fn(), exit },
      filePath: 'Ink.md',
      session: {
        read: () => ({
          state: { dirty: true, kind: 'ink-mode', saveError: null },
          strokeCount: 1,
        }),
      },
    });

    mode = 'source';
    manager.registerView(view);
    await vi.waitFor(() =>
      expect(requestUnsavedExitDecision).toHaveBeenCalledWith({
        filePath: 'Ink.md',
        reason: 'view-mode-change',
      }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(privateManager.activeView).toBe(view);
    expect(setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
    privateManager.activeView = null;
    manager.dispose();
  });

  it('asks before detaching a dirty session when the same Markdown view switches notes', async () => {
    const leaf = {};
    const file = { path: 'A.md' };
    const view = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
      file,
      getMode: () => 'preview',
      leaf,
    } as unknown as MarkdownView;
    const requestUnsavedExitDecision = vi.fn(() => Promise.resolve('cancel' as const));
    const exit = vi.fn(() => Promise.resolve());
    const manager = new ObsidianInkModeManager({
      app: {
        workspace: { getLeavesOfType: () => [], setActiveLeaf: vi.fn() },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      requestUnsavedExitDecision,
      textRepository: {} as never,
    });
    manager.registerView(view);
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: { background: vi.fn(), dispose: vi.fn(), exit },
      filePath: 'A.md',
      session: {
        read: () => ({
          state: { dirty: true, kind: 'ink-mode', saveError: null },
          strokeCount: 1,
        }),
      },
    });

    file.path = 'B.md';
    manager.registerView(view);
    await vi.waitFor(() =>
      expect(requestUnsavedExitDecision).toHaveBeenCalledWith({
        filePath: 'A.md',
        reason: 'note-switch',
      }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(privateManager.activeView).toBe(view);
    privateManager.activeView = null;
    manager.dispose();
  });

  it('asks before detaching a dirty session when layout change closes its Markdown view', async () => {
    const leaf = {};
    const view = { contentEl: document.createElement('div'), leaf } as unknown as MarkdownView;
    const requestUnsavedExitDecision = vi.fn(() => Promise.resolve('cancel' as const));
    const exit = vi.fn(() => Promise.resolve());
    const setActiveLeaf = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [], setActiveLeaf } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      requestUnsavedExitDecision,
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: { background: vi.fn(), dispose: vi.fn(), exit },
      filePath: 'A.md',
      session: {
        read: () => ({
          state: { dirty: true, kind: 'ink-mode', saveError: null },
          strokeCount: 1,
        }),
      },
    });

    manager.registerAllMarkdownViews();
    await vi.waitFor(() =>
      expect(requestUnsavedExitDecision).toHaveBeenCalledWith({
        filePath: 'A.md',
        reason: 'view-close',
      }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(privateManager.activeView).toBe(view);
    expect(setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
    privateManager.activeView = null;
    manager.dispose();
  });

  it('does not enter another Ink view when the dirty owner rejects the note switch', async () => {
    const leafA = {};
    const viewA = {
      contentEl: document.createElement('div'),
      leaf: leafA,
    } as unknown as MarkdownView;
    const viewB = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const requestUnsavedExitDecision = vi.fn(() => Promise.resolve('cancel' as const));
    const exitA = vi.fn(() => Promise.resolve());
    const ensureMounted = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: {
        workspace: {
          getActiveViewOfType: () => viewB,
          getLeavesOfType: () => [],
          setActiveLeaf: vi.fn(),
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      requestUnsavedExitDecision,
      textRepository: {} as never,
    });
    manager.registerView(viewB);
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      ensureMounted: typeof ensureMounted;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = viewA;
    privateManager.mounted.set(viewA, {
      complete: true,
      controller: { background: vi.fn(), dispose: vi.fn(), exit: exitA },
      filePath: 'A.md',
      session: {
        read: () => ({
          state: { dirty: true, kind: 'ink-mode', saveError: null },
          strokeCount: 1,
        }),
      },
    });
    privateManager.ensureMounted = ensureMounted;

    await manager.toggle(viewB);

    expect(requestUnsavedExitDecision).toHaveBeenCalledWith({
      filePath: 'A.md',
      reason: 'note-switch',
    });
    expect(exitA).not.toHaveBeenCalled();
    expect(ensureMounted).not.toHaveBeenCalled();
    expect(privateManager.activeView).toBe(viewA);
    privateManager.activeView = null;
    manager.dispose();
  });

  it('keeps the current owner and blocks the queued view when persistence fails', async () => {
    const viewA = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const viewB = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const persistenceError = new Error('disk unavailable');
    const exitA = vi.fn(() => Promise.reject(persistenceError));
    const disposeA = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: {
        workspace: {
          getActiveViewOfType: () => viewA,
          getLeavesOfType: () => [],
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    manager.registerView(viewA);
    const ensureMounted = vi.fn();
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      ensureMounted: typeof ensureMounted;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = viewA;
    privateManager.mounted.set(viewA, {
      complete: true,
      controller: {
        background: () => Promise.resolve(),
        dispose: disposeA,
        exit: exitA,
      },
      filePath: 'A.md',
      session: { read: () => ({ strokeCount: 0 }) },
    });
    privateManager.ensureMounted = ensureMounted;

    const first = manager.toggle(viewA);
    const second = manager.toggle(viewB);

    await expect(first).rejects.toBe(persistenceError);
    await expect(second).rejects.toBe(persistenceError);
    expect(ensureMounted).not.toHaveBeenCalled();
    expect(privateManager.activeView).toBe(viewA);
    expect(disposeA).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('applies a preview preference change after an in-flight exit completes', async () => {
    const view = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    let resolveExit!: () => void;
    const pendingExit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const exit = vi.fn(() => pendingExit);
    const hidePreview = vi.fn();
    const dispose = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      showInkPreviewByDefault: true,
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: {
        background: () => Promise.resolve(),
        dispose,
        exit,
        hidePreview,
      },
      filePath: 'Ink.md',
      session: { read: () => ({ strokeCount: 1 }) },
    });

    const exiting = manager.exit();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith('preview'));
    const changingPreference = manager.setPreviewByDefault(false);
    resolveExit();
    await Promise.all([exiting, changingPreference]);

    expect(hidePreview).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(privateManager.mounted.has(view)).toBe(false);
    manager.dispose();
  });

  it('detaches a mounted Ink overlay without remounting it in passive Reading View', async () => {
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
    expect(ensureMounted).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('recomputes the primary action from canonical Ink after a whole-surface deletion', async () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(canvasContext());
    const action = document.createElement('button');
    let activate!: () => void;
    let hasCanonicalInk = true;
    const contentEl = document.createElement('div');
    contentEl.append(readingHost(1_200));
    const view = {
      addAction: (_icon: string, _title: string, callback: () => void) => {
        activate = callback;
        return action;
      },
      contentEl,
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const writeSurface = vi.fn(() => Promise.resolve());
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: {
          getActiveViewOfType: () => view,
          getLeavesOfType: () => [],
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () =>
          Promise.resolve({
            conflicts: [],
            issues: [],
            records: hasCanonicalInk ? [inkSurface('Ink.md')] : [],
          }),
        writeSurface,
      } as never,
      preferenceStore: {
        load: () => ({ color: '#d97777', hintShown: true, tool: 'pen', width: 4 }),
        save: () => undefined,
      } as never,
      textRepository: {
        getOrCreateNote: () => Promise.resolve({ noteId: 'note-a' }),
      } as never,
    });
    manager.registerView(view);
    await vi.waitFor(() => expect(action.getAttribute('aria-label')).toBe('涂鸦已隐藏 · 显示预览'));

    hasCanonicalInk = false;
    await manager.refreshFile('Ink.md');

    expect(action.getAttribute('aria-label')).toBe('开始涂鸦');
    activate();
    await vi.waitFor(() => expect(action.getAttribute('aria-label')).toBe('完成涂鸦并预览'));
    expect(writeSurface).toHaveBeenCalled();

    manager.dispose();
    getContext.mockRestore();
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
      session: { read: () => ({ strokeCount: 0 }) },
    });
    privateManager.ensureMounted = vi.fn(() => Promise.resolve(null));

    await manager.exit();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(reclaimEmptySurfaces).toHaveBeenCalledWith('Ink.md', expect.any(String), 'device-a');
    expect(exit.mock.invocationCallOrder[0]).toBeLessThan(
      reclaimEmptySurfaces.mock.invocationCallOrder[0] as number,
    );
    expect(privateManager.ensureMounted).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('recreates an editable Ink surface after the final stroke is erased and the action is clicked again', async () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(canvasContext());
    const action = document.createElement('button');
    let activate!: () => void;
    let resolveInitialDiscovery!: (value: LoadedInkSurfacesForTest) => void;
    const initialDiscovery = new Promise<LoadedInkSurfacesForTest>((resolve) => {
      resolveInitialDiscovery = resolve;
    });
    const staleInitialRecord = inkSurface('Ink.md');
    let persisted = structuredClone(staleInitialRecord);
    let surfaceRead = 0;
    const contentEl = document.createElement('div');
    contentEl.append(readingHost(1_200));
    const view = {
      addAction: (_icon: string, _title: string, callback: () => void) => {
        activate = callback;
        return action;
      },
      contentEl,
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: {
          getActiveViewOfType: () => view,
          getLeavesOfType: () => [],
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () =>
          surfaceRead++ === 0
            ? initialDiscovery
            : Promise.resolve({ conflicts: [], issues: [], records: [persisted] }),
        reclaimEmptySurfaces: () => Promise.resolve([]),
        updateSurface: (record: InkSurfaceRecord) => {
          persisted = record;
          return Promise.resolve();
        },
      } as never,
      preferenceStore: {
        load: () => ({ color: '#d97777', hintShown: true, tool: 'pen', width: 4 }),
        save: () => undefined,
      } as never,
      liveFirstPersistence: {
        legacyRecoveryReader: { load: () => null },
      },
      textRepository: {
        getOrCreateNote: () => Promise.resolve({ noteId: persisted.noteId }),
      } as never,
    });
    manager.registerView(view);
    await manager.toggle(view);
    const firstMount = (
      manager as unknown as {
        mounted: Map<
          MarkdownView,
          {
            session: {
              eraseStrokeAt: (
                point: { pressure: number; time: number; x: number; y: number },
                radius: number,
              ) => string | null;
            };
          }
        >;
      }
    ).mounted.get(view);

    expect(firstMount).toBeDefined();
    firstMount?.session.eraseStrokeAt({ pressure: 0.5, time: 1, x: 20, y: 20 }, 8);
    await manager.toggle(view);
    expect(persisted.strokes).toEqual([]);

    resolveInitialDiscovery({ conflicts: [], issues: [], records: [staleInitialRecord] });
    await initialDiscovery;
    await Promise.resolve();
    expect((manager as unknown as { hasInkViews: Set<MarkdownView> }).hasInkViews.has(view)).toBe(
      false,
    );

    activate();

    await vi.waitFor(() =>
      expect((manager as unknown as { activeView: MarkdownView | null }).activeView).toBe(view),
    );
    const reopened = (
      manager as unknown as {
        mounted: Map<MarkdownView, { session: { snapshot: () => { surface: InkSurfaceRecord } } }>;
      }
    ).mounted.get(view);
    expect(reopened).toBeDefined();
    expect(reopened).not.toBe(firstMount);
    expect(reopened?.session.snapshot().surface.strokes).toEqual([]);
    expect(action.getAttribute('aria-label')).toBe('完成涂鸦并预览');
    manager.dispose();
    getContext.mockRestore();
  });

  it('migrates an unacknowledged v4 journal after restart without rewriting the legacy store', async () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(canvasContext());
    const view = markdownView('Ink.md');
    const original = inkSurface('Ink.md');
    let persisted = original;
    const recovered = {
      ...original,
      strokes: [...original.strokes, inkStroke('recovered-after-quota')],
    };
    const loadLegacy = vi.fn(() => ({
      acknowledgedRecords: [original],
      acknowledgedSequence: 0,
      baseRecords: [original],
      capturedAt: '2026-07-19T00:00:00.000Z',
      filePath: 'Ink.md',
      generation: 'legacy-v4',
      lastSequence: 1,
      records: [recovered],
      version: 4 as const,
    }));
    const onIssue = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () => Promise.resolve({ conflicts: [], issues: [], records: [persisted] }),
        updateSurface: (record: InkSurfaceRecord) => {
          persisted = record;
          return Promise.resolve(record);
        },
      } as never,
      onIssue,
      preferenceStore: {
        load: () => ({ color: '#d97777', hintShown: true, tool: 'pen', width: 4 }),
        save: () => undefined,
      } as never,
      liveFirstPersistence: { legacyRecoveryReader: { load: loadLegacy } },
      textRepository: {
        getOrCreateNote: () => Promise.resolve({ noteId: original.noteId }),
      } as never,
    });

    await manager.toggle(view);

    expect(persisted.strokes.map(({ id }) => id)).toEqual(['stroke-a', 'recovered-after-quota']);
    expect(onIssue).not.toHaveBeenCalled();
    expect(loadLegacy).toHaveBeenCalledWith('Ink.md');
    manager.dispose();
    getContext.mockRestore();
  });

  it('re-enters Ink Mode after a flushed whole-surface deletion without replaying its stale v4 base', async () => {
    globalThis.localStorage.clear();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(canvasContext());
    const contentEl = document.createElement('div');
    contentEl.append(readingHost(1_200));
    const view = {
      addAction: () => document.createElement('button'),
      contentEl,
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    let persisted = inkSurface('Ink.md');
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: {
          getActiveViewOfType: () => view,
          getLeavesOfType: () => [],
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () => Promise.resolve({ conflicts: [], issues: [], records: [persisted] }),
        reclaimEmptySurfaces: () => Promise.resolve([]),
        updateSurface: (record: InkSurfaceRecord) => {
          persisted = record;
          return Promise.resolve(record);
        },
        writeSurface: (record: InkSurfaceRecord) => {
          persisted = record;
          return Promise.resolve();
        },
      } as never,
      preferenceStore: {
        load: () => ({ color: '#d97777', hintShown: true, tool: 'pen', width: 4 }),
        save: () => undefined,
      } as never,
      textRepository: {
        getOrCreateNote: () => Promise.resolve({ noteId: persisted.noteId }),
      } as never,
    });

    await manager.toggle(view);
    await manager.prepareFileMutation('Ink.md');
    persisted = {
      ...persisted,
      deletedAt: '2026-07-18T06:00:00.000Z',
      revision: persisted.revision + 1,
      updatedAt: '2026-07-18T06:00:00.000Z',
    };

    await expect(manager.toggle(view)).resolves.toBeUndefined();

    manager.dispose();
    getContext.mockRestore();
    globalThis.localStorage.clear();
  });

  it('opens Ink Mode after a pre-fix acknowledged v4 base outlives a canonical whole-surface deletion', async () => {
    globalThis.localStorage.clear();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(canvasContext());
    const contentEl = document.createElement('div');
    contentEl.append(readingHost(1_200));
    const view = {
      addAction: () => document.createElement('button'),
      contentEl,
      file: { path: 'Ink.md' },
      getMode: () => 'preview',
    } as unknown as MarkdownView;
    const original = inkSurface('Ink.md');
    let persisted: InkSurfaceRecord = {
      ...original,
      deletedAt: '2026-07-18T06:00:00.000Z',
      revision: original.revision + 1,
      updatedAt: '2026-07-18T06:00:00.000Z',
    };
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: {
          getActiveViewOfType: () => view,
          getLeavesOfType: () => [],
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () => Promise.resolve({ conflicts: [], issues: [], records: [persisted] }),
        reclaimEmptySurfaces: () => Promise.resolve([]),
        updateSurface: (record: InkSurfaceRecord) => {
          persisted = record;
          return Promise.resolve(record);
        },
        writeSurface: (record: InkSurfaceRecord) => {
          persisted = record;
          return Promise.resolve();
        },
      } as never,
      preferenceStore: {
        load: () => ({ color: '#d97777', hintShown: true, tool: 'pen', width: 4 }),
        save: () => undefined,
      } as never,
      liveFirstPersistence: {
        legacyRecoveryReader: {
          load: () => ({
            acknowledgedRecords: [original],
            acknowledgedSequence: 0,
            baseRecords: [original],
            capturedAt: original.updatedAt,
            filePath: 'Ink.md',
            generation: 'pre-fix-generation',
            lastSequence: 0,
            records: [original],
            version: 4,
          }),
        },
      },
      textRepository: {
        getOrCreateNote: () => Promise.resolve({ noteId: persisted.noteId }),
      } as never,
    });

    await expect(manager.toggle(view)).resolves.toBeUndefined();

    manager.dispose();
    getContext.mockRestore();
    globalThis.localStorage.clear();
  });

  it('ignores a stale mismatched v4 checkpoint without blocking the canonical document', async () => {
    const original = inkSurface('Ink.md');
    const recovered = { ...original, strokes: [...original.strokes, inkStroke('local')] };
    const updateSurface = vi.fn(() => Promise.resolve());
    const onIssue = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: { getActiveViewOfType: () => null, getLeavesOfType: () => [] },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        updateSurface,
      } as never,
      onIssue,
      preferenceStore: {
        load: () => ({ color: '#d97777', hintShown: true, tool: 'pen', width: 4 }),
        save: () => undefined,
      } as never,
      liveFirstPersistence: {
        legacyRecoveryReader: {
          load: () => ({
            acknowledgedRecords: [original],
            acknowledgedSequence: 0,
            baseRecords: [original],
            capturedAt: '2026-07-18T05:59:00.000Z',
            filePath: 'Ink.md',
            generation: 'pre-fix-generation',
            lastSequence: 1,
            records: [recovered],
            version: 4 as const,
          }),
        },
      },
      textRepository: {
        getOrCreateNote: () => Promise.resolve({ noteId: original.noteId }),
      } as never,
    });
    const restoreLocalRecovery = (
      manager as unknown as {
        restoreLocalRecovery: (
          filePath: string,
          canonical: readonly InkSurfaceRecord[],
        ) => Promise<readonly InkSurfaceRecord[]>;
      }
    ).restoreLocalRecovery.bind(manager);

    await expect(restoreLocalRecovery('Ink.md', [])).resolves.toEqual([]);
    expect(onIssue).not.toHaveBeenCalled();
    expect(updateSurface).not.toHaveBeenCalled();
    manager.dispose();
  });

  it('propagates final-stroke removal to another tab before its stale discovery lands', async () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(canvasContext());
    const actions = new Map<MarkdownView, HTMLButtonElement>();
    const activations = new Map<MarkdownView, () => void>();
    const discoveryResolvers: Array<(value: LoadedInkSurfacesForTest) => void> = [];
    const discoveryRequests = Array.from(
      { length: 2 },
      () =>
        new Promise<LoadedInkSurfacesForTest>((resolve) => {
          discoveryResolvers.push(resolve);
        }),
    );
    let surfaceRead = 0;
    const staleInitialRecord = inkSurface('Ink.md');
    let persisted = structuredClone(staleInitialRecord);
    const createView = (): MarkdownView => {
      const contentEl = document.createElement('div');
      contentEl.append(readingHost(1_200));
      const view = {
        addAction: (_icon: string, _title: string, callback: () => void) => {
          const action = document.createElement('button');
          actions.set(view, action);
          activations.set(view, callback);
          return action;
        },
        contentEl,
        file: { path: 'Ink.md' },
        getMode: () => 'preview',
      } as unknown as MarkdownView;
      return view;
    };
    const ownerView = createView();
    const siblingView = createView();
    let activeWorkspaceView = ownerView;
    const manager = new ObsidianInkModeManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Ink') },
        workspace: {
          getActiveViewOfType: () => activeWorkspaceView,
          getLeavesOfType: () => [],
        },
      } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {
        listSurfaces: () =>
          discoveryRequests[surfaceRead++] ??
          Promise.resolve({ conflicts: [], issues: [], records: [persisted] }),
        reclaimEmptySurfaces: () => Promise.resolve([]),
        updateSurface: (record: InkSurfaceRecord) => {
          persisted = record;
          return Promise.resolve();
        },
      } as never,
      preferenceStore: {
        load: () => ({ color: '#d97777', hintShown: true, tool: 'pen', width: 4 }),
        save: () => undefined,
      } as never,
      liveFirstPersistence: {
        legacyRecoveryReader: { load: () => null },
      },
      textRepository: {
        getOrCreateNote: () => Promise.resolve({ noteId: persisted.noteId }),
      } as never,
    });
    manager.registerView(ownerView);
    manager.registerView(siblingView);
    await manager.toggle(ownerView);
    const ownerMount = (
      manager as unknown as {
        mounted: Map<
          MarkdownView,
          {
            session: {
              eraseStrokeAt: (
                point: { pressure: number; time: number; x: number; y: number },
                radius: number,
              ) => string | null;
            };
          }
        >;
      }
    ).mounted.get(ownerView);

    expect(ownerMount).toBeDefined();
    ownerMount?.session.eraseStrokeAt({ pressure: 0.5, time: 1, x: 20, y: 20 }, 8);
    await manager.toggle(ownerView);
    expect(persisted.strokes).toEqual([]);

    for (const resolve of discoveryResolvers) {
      resolve({ conflicts: [], issues: [], records: [staleInitialRecord] });
    }
    await Promise.all(discoveryRequests);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(actions.get(siblingView)?.getAttribute('aria-label')).toBe('开始涂鸦');
    activeWorkspaceView = siblingView;
    activations.get(siblingView)?.();
    await vi.waitFor(() =>
      expect(actions.get(siblingView)?.getAttribute('aria-label')).toBe('完成涂鸦并预览'),
    );

    manager.dispose();
    getContext.mockRestore();
  });

  it('finishes Ink edit into Preview even when default-on-open Preview is disabled', async () => {
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
      showInkPreviewByDefault: false,
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      activeView: MarkdownView | null;
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.activeView = view;
    privateManager.mounted.set(view, {
      complete: true,
      controller: { dispose, exit },
      filePath: 'Ink.md',
      session: { read: () => ({ strokeCount: 1 }) },
    });

    await manager.exit();

    expect(exit).toHaveBeenCalledWith('preview');
    expect(dispose).not.toHaveBeenCalled();
    expect(reclaimEmptySurfaces).not.toHaveBeenCalled();
    expect(privateManager.mounted.has(view)).toBe(true);
    manager.dispose();
  });

  it('restores raw Obsidian view immediately when default preview is disabled', async () => {
    const view = { contentEl: document.createElement('div') } as unknown as MarkdownView;
    const hidePreview = vi.fn();
    const dispose = vi.fn();
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      showInkPreviewByDefault: true,
      textRepository: {} as never,
    });
    const privateManager = manager as unknown as {
      mounted: Map<MarkdownView, unknown>;
    };
    privateManager.mounted.set(view, {
      complete: true,
      controller: { dispose, hidePreview },
      filePath: 'Ink.md',
      session: {},
    });

    await manager.setPreviewByDefault(false);

    expect(hidePreview).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(privateManager.mounted.has(view)).toBe(false);
    manager.dispose();
  });

  it('enters Ink edit by reusing the mounted preview coordinate plane', async () => {
    const view = {
      addAction: () => document.createElement('button'),
      contentEl: document.createElement('div'),
    } as unknown as MarkdownView;
    const enter = vi.fn();
    const dispose = vi.fn();
    const mounted = {
      complete: true,
      controller: { dispose, enter },
      filePath: 'Ink.md',
      session: {},
    };
    const manager = new ObsidianInkModeManager({
      app: { workspace: { getActiveViewOfType: () => view, getLeavesOfType: () => [] } } as never,
      deviceId: 'device-a',
      document,
      inkRepository: {} as never,
      preferenceStore: {} as never,
      textRepository: {} as never,
    });
    manager.registerView(view);
    const ensureMounted = vi.fn(() => Promise.resolve(mounted));
    (
      manager as unknown as {
        ensureMounted: typeof ensureMounted;
        mounted: Map<MarkdownView, unknown>;
      }
    ).ensureMounted = ensureMounted;
    (
      manager as unknown as {
        mounted: Map<MarkdownView, unknown>;
      }
    ).mounted.set(view, mounted);

    await manager.toggle(view);

    expect(dispose).not.toHaveBeenCalled();
    expect(enter).toHaveBeenCalledTimes(1);
    manager.dispose();
  });
});

function inkSummary(): InkSurfaceSummary {
  return {
    filePath: 'Ink.md',
    headingPath: ['Document'],
    id: 'surface-1',
    logicalHeight: 800,
    logicalWidth: 704,
    position: 0,
    revision: 1,
    status: 'active',
    strokeCount: 8,
    thumbnailSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    updatedAt: '2026-07-16T10:24:00.000Z',
  };
}

function readingHost(height: number): HTMLElement {
  const host = document.createElement('div');
  host.className = 'markdown-preview-view';
  const root = document.createElement('div');
  root.className = 'markdown-preview-sizer';
  host.append(root);
  Object.defineProperties(host, {
    clientHeight: { value: 600 },
    clientWidth: { value: 744 },
  });
  Object.defineProperty(root, 'scrollHeight', { value: height });
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 744, 600));
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 0, 704, height));
  return host;
}

function markdownView(filePath: string): MarkdownView {
  const contentEl = document.createElement('div');
  contentEl.append(readingHost(1_200));
  return {
    addAction: () => document.createElement('button'),
    contentEl,
    file: { path: filePath },
    getMode: () => 'preview',
  } as unknown as MarkdownView;
}

function inkSurface(filePath: string): InkSurfaceRecord {
  const now = '2026-07-16T00:00:00.000Z';
  return {
    createdAt: now,
    deviceId: 'device-a',
    filePath,
    id: 'surface-a',
    layout: {
      blockFingerprints: [],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1_200,
      logicalWidth: 704,
      originY: 0,
      sourceRevision: 'source-a',
      themeMode: 'light',
    },
    noteId: 'note-a',
    revision: 1,
    schemaVersion: 2,
    status: 'active',
    strokes: [
      {
        color: '#d97777',
        id: 'stroke-a',
        points: [
          { pressure: 0.5, time: 1, x: 20, y: 20 },
          { pressure: 0.5, time: 2, x: 40, y: 40 },
        ],
        tool: 'pen',
        width: 4,
      },
    ],
    updatedAt: now,
  };
}

function inkStroke(id: string): InkSurfaceRecord['strokes'][number] {
  return {
    color: '#d97777',
    id,
    points: [
      { pressure: 0.5, time: 3, x: 60, y: 60 },
      { pressure: 0.5, time: 4, x: 80, y: 80 },
    ],
    tool: 'pen',
    width: 4,
  };
}

function canvasContext(): CanvasRenderingContext2D {
  return {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    lineCap: 'round',
    lineJoin: 'round',
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

function pendingDocumentFonts(): { resolve: () => void; restore: () => void } {
  const original = Object.getOwnPropertyDescriptor(document, 'fonts');
  let resolve!: () => void;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready },
  });
  return {
    resolve,
    restore: () => {
      if (original === undefined) Reflect.deleteProperty(document, 'fonts');
      else Object.defineProperty(document, 'fonts', original);
    },
  };
}
