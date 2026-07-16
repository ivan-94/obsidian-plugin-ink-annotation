// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InkDocumentSession } from '../application/ink-document-session';
import { encodeInkSurfaceRecord, type InkSurfaceRecord } from '../domain/ink-surface';
import { InkSurfaceRepository } from '../storage/ink-surface-repository';
import { SidecarRepository, type TextFileStore } from '../storage/sidecar-repository';
import { InkCanvasController } from './ink-canvas-controller';

describe('Ink pointer persistence round-trip', () => {
  const contexts = new WeakMap<HTMLCanvasElement, ContextFixture>();

  beforeEach(() => {
    document.body.replaceChildren();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.get(this);
      if (existing !== undefined) return existing.context;
      const created = contextFixture();
      contexts.set(this, created);
      return created.context;
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('persists, previews, re-enters, draws again, reloads, and renders one coordinate plane', async () => {
    const store = new MemoryTextFileStore();
    const meta = await new SidecarRepository(store).getOrCreateNote({
      createId: () => 'note-1',
      filePath: 'Ink.md',
      now: '2026-07-14T08:00:00.000Z',
      sourceFingerprint: 'source-v1',
    });
    const repository = new InkSurfaceRepository(store);
    const initial = surface(meta.noteId);
    await repository.writeSurface(initial);
    const root = document.createElement('div');
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 352 },
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 352, 600));
    const session = new InkDocumentSession({
      debounceMs: 60_000,
      now: () => '2026-07-14T08:01:00.000Z',
      surfaces: [initial],
      writer: repository,
    });
    const controller = new InkCanvasController({ document, root, scrollContainer: root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active Ink canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 352, 600));

    controller.enter();
    root.dispatchEvent(pointer('pointerdown', 24, 30, 10));
    root.dispatchEvent(pointer('pointermove', 48, 60, 20));
    root.dispatchEvent(pointer('pointerup', 72, 90, 30));
    await controller.exit('preview');
    controller.enter();
    root.dispatchEvent(pointer('pointerdown', 100, 120, 40));
    root.dispatchEvent(pointer('pointerup', 120, 140, 50));
    await controller.exit();
    controller.dispose();

    const persisted = await new InkSurfaceRepository(store).readSurface('Ink.md', initial.id);
    expect(persisted).toMatchObject({
      revision: 3,
      strokes: [
        {
          points: [
            { pressure: 0.7, time: 10, x: 48, y: 60 },
            { pressure: 0.7, time: 30, x: 144, y: 180 },
          ],
        },
        {
          points: [
            { pressure: 0.7, time: 40, x: 200, y: 240 },
            { pressure: 0.7, time: 50, x: 240, y: 280 },
          ],
        },
      ],
    });

    if (persisted === null) throw new Error('Missing reloaded Ink surface.');
    const reloadedRoot = document.createElement('div');
    document.body.append(reloadedRoot);
    const reloaded = new InkDocumentSession({ surfaces: [persisted], writer: repository });
    const reloadedController = new InkCanvasController({
      document,
      root: reloadedRoot,
      session: reloaded,
    });
    const committed = reloadedRoot.querySelector<HTMLCanvasElement>(
      '[data-inkstone-ink-committed]',
    );
    if (committed === null) throw new Error('Missing reloaded committed Ink canvas.');
    const committedContext = contexts.get(committed);

    expect(committedContext?.moveTo).toHaveBeenCalledWith(48, 60);
    expect(committedContext?.lineTo).toHaveBeenCalledWith(144, 180);
    expect(committedContext?.moveTo).toHaveBeenCalledWith(200, 240);
    expect(committedContext?.lineTo).toHaveBeenCalledWith(240, 280);
    expect(committedContext?.stroke).toHaveBeenCalled();
    reloadedController.dispose();
  });

  it.each([
    { label: '50%', scale: 0.5 },
    { label: '100%', scale: 1 },
    { label: '150%', scale: 1.5 },
    { label: 'Fit', scale: 0.87358 },
  ])(
    'round-trips one persisted landmark through the controller and repository at $label',
    async ({ scale }) => {
      const store = new MemoryTextFileStore();
      const meta = await new SidecarRepository(store).getOrCreateNote({
        createId: () => 'note-scale',
        filePath: 'Scale.md',
        now: '2026-07-16T08:00:00.000Z',
        sourceFingerprint: 'source-scale',
      });
      const repository = new InkSurfaceRepository(store);
      const initial = fixedSurface(meta.noteId);
      await repository.writeSurface(initial);
      const { active, controller, root } = scaledController({
        repository,
        scale,
        surface: initial,
      });
      const first = { x: 150, y: 300 };
      const second = { x: 210, y: 360 };

      controller.enter();
      root.dispatchEvent(pointer('pointerdown', 80 + first.x * scale, 100 + first.y * scale, 10));
      root.dispatchEvent(pointer('pointerup', 80 + second.x * scale, 100 + second.y * scale, 20));
      expect(contexts.get(active)?.setTransform).toHaveBeenCalledWith(scale, 0, 0, scale, 0, 0);
      await controller.exit();
      controller.dispose();

      const persisted = await repository.readSurface(initial.filePath, initial.id);
      if (persisted === null) throw new Error('Missing scaled persisted Ink surface.');
      expect(persisted.revision).toBe(2);
      expect(persisted.strokes).toHaveLength(1);
      const persistedPoints = persisted.strokes[0]?.points;
      expect(persistedPoints).toHaveLength(2);
      expect(persistedPoints?.[0]?.x).toBeCloseTo(first.x, 8);
      expect(persistedPoints?.[0]?.y).toBeCloseTo(first.y, 8);
      expect(persistedPoints?.[1]?.x).toBeCloseTo(second.x, 8);
      expect(persistedPoints?.[1]?.y).toBeCloseTo(second.y, 8);
      const persistedBytes = encodeInkSurfaceRecord(persisted);

      const reloaded = scaledController({ repository, scale, surface: persisted });
      reloaded.controller.enter();
      expect(contexts.get(reloaded.committed)?.moveTo).toHaveBeenCalledWith(first.x, first.y);
      const renderedEnd = contexts.get(reloaded.committed)?.lineTo.mock.calls.at(-1);
      expect(renderedEnd?.[0]).toBeCloseTo(second.x, 8);
      expect(renderedEnd?.[1]).toBeCloseTo(second.y, 8);
      expect(contexts.get(reloaded.committed)?.setTransform).toHaveBeenCalledWith(
        scale,
        0,
        0,
        scale,
        0,
        0,
      );
      reloaded.controller.dispose();

      const unchanged = await repository.readSurface(initial.filePath, initial.id);
      if (unchanged === null) throw new Error('Missing unchanged scaled Ink surface.');
      expect(encodeInkSurfaceRecord(unchanged)).toBe(persistedBytes);
    },
  );
});

function scaledController(input: {
  readonly repository: InkSurfaceRepository;
  readonly scale: number;
  readonly surface: InkSurfaceRecord;
}): {
  readonly active: HTMLCanvasElement;
  readonly committed: HTMLCanvasElement;
  readonly controller: InkCanvasController;
  readonly root: HTMLElement;
} {
  const root = document.createElement('div');
  const layoutRoot = document.createElement('div');
  root.append(layoutRoot);
  document.body.append(root);
  Object.defineProperties(root, {
    clientHeight: { configurable: true, value: 600 },
    clientWidth: { configurable: true, value: 900 },
  });
  Object.defineProperty(layoutRoot, 'offsetWidth', { configurable: true, value: 704 });
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 900, 600));
  vi.spyOn(layoutRoot, 'getBoundingClientRect').mockReturnValue(
    rect(80, 100, 704 * input.scale, 1_200 * input.scale),
  );
  const session = new InkDocumentSession({
    debounceMs: 60_000,
    now: () => '2026-07-16T08:01:00.000Z',
    surfaces: [input.surface],
    writer: input.repository,
  });
  const controller = new InkCanvasController({
    document,
    layoutRoot,
    root,
    scrollContainer: root,
    session,
  });
  const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
  const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');
  if (active === null || committed === null) throw new Error('Missing scaled Ink canvas.');
  const canvasRect = rect(80, 100, 704 * input.scale, 1_200 * input.scale);
  vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(canvasRect);
  vi.spyOn(committed, 'getBoundingClientRect').mockReturnValue(canvasRect);
  return { active, committed, controller, root };
}

class MemoryTextFileStore implements TextFileStore {
  private readonly files = new Map<string, string>();

  list(directory: string): Promise<readonly string[]> {
    const prefix = `${directory}/`;
    return Promise.resolve(
      [...this.files.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length).split('/')[0])
        .filter((name): name is string => name !== undefined && name.length > 0)
        .filter((name, index, names) => names.indexOf(name) === index)
        .sort(),
    );
  }

  mkdir(): Promise<void> {
    return Promise.resolve();
  }

  read(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
    return Promise.resolve();
  }
}

function surface(noteId: string): InkSurfaceRecord {
  return {
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Ink.md',
    id: 'surface-1',
    layout: {
      blockFingerprints: ['block-1'],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1200,
      logicalWidth: 960,
      sourceRevision: 'source-v1',
      themeMode: 'light',
    },
    noteId,
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: [],
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}

function fixedSurface(noteId: string): InkSurfaceRecord {
  return {
    ...surface(noteId),
    filePath: 'Scale.md',
    id: 'surface-scale',
    layout: {
      ...surface(noteId).layout,
      logicalHeight: 1_200,
      logicalWidth: 704,
      originY: 0,
      sourceRevision: 'source-scale',
    },
    noteId,
    schemaVersion: 2,
  };
}

function pointer(type: string, x: number, y: number, timeStamp: number): Event {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, {
    getCoalescedEvents: { value: () => [event] },
    pointerId: { value: 1 },
    pointerType: { value: 'pen' },
    pressure: { value: 0.7 },
    tiltX: { value: 0 },
    tiltY: { value: 0 },
    timeStamp: { value: timeStamp },
  });
  return event;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    toJSON: () => ({}),
    top,
    width,
    x: left,
    y: top,
  };
}

interface ContextFixture {
  readonly context: CanvasRenderingContext2D;
  readonly lineTo: ReturnType<typeof vi.fn>;
  readonly moveTo: ReturnType<typeof vi.fn>;
  readonly setTransform: ReturnType<typeof vi.fn>;
  readonly stroke: ReturnType<typeof vi.fn>;
}

function contextFixture(): ContextFixture {
  const lineTo = vi.fn();
  const moveTo = vi.fn();
  const setTransform = vi.fn();
  const stroke = vi.fn();
  const context = {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    lineCap: 'round',
    lineJoin: 'round',
    lineTo,
    moveTo,
    restore: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setTransform,
    stroke,
    strokeStyle: '#000',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  return { context, lineTo, moveTo, setTransform, stroke };
}
