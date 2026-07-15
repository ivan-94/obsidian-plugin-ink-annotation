// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InkDocumentSession } from '../application/ink-document-session';
import type { InkSurfaceRecord } from '../domain/ink-surface';
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

  it('converts a pointer stream to logical points, persists through the codec, reloads, and renders', async () => {
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
    const session = new InkDocumentSession({
      debounceMs: 60_000,
      now: () => '2026-07-14T08:01:00.000Z',
      surfaces: [initial],
      writer: repository,
    });
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active Ink canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 480, 600));

    controller.enter();
    active.dispatchEvent(pointer('pointerdown', 24, 30, 10));
    active.dispatchEvent(pointer('pointermove', 48, 60, 20));
    active.dispatchEvent(pointer('pointerup', 72, 90, 30));
    await controller.exit();
    controller.dispose();

    const persisted = await new InkSurfaceRepository(store).readSurface('Ink.md', initial.id);
    expect(persisted).toMatchObject({
      revision: 2,
      strokes: [
        {
          points: [
            { pressure: 0.7, time: 10, x: 48, y: 60 },
            { pressure: 0.7, time: 30, x: 144, y: 180 },
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
    expect(committedContext?.stroke).toHaveBeenCalledTimes(1);
    reloadedController.dispose();
  });
});

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
  readonly stroke: ReturnType<typeof vi.fn>;
}

function contextFixture(): ContextFixture {
  const lineTo = vi.fn();
  const moveTo = vi.fn();
  const stroke = vi.fn();
  const context = {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    lineCap: 'round',
    lineJoin: 'round',
    lineTo,
    moveTo,
    scale: vi.fn(),
    stroke,
    strokeStyle: '#000',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  return { context, lineTo, moveTo, stroke };
}
