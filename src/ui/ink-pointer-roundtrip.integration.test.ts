// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InkDocumentSession } from '../application/ink-document-session';
import { LegacyRoundInkStrokeGeometry } from '../domain/ink-stroke-geometry';
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

  it('freezes the PF-42 Cycle 0 Pointer legacy geometry digest and sidecar bytes', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000042',
    );
    const store = new MemoryTextFileStore();
    const meta = await new SidecarRepository(store).getOrCreateNote({
      createId: () => 'note-pf42-cycle-0',
      filePath: 'Scale.md',
      now: '2026-07-18T00:00:00.000Z',
      sourceFingerprint: 'source-scale',
    });
    const repository = new InkSurfaceRepository(store);
    const initial = fixedSurface(meta.noteId);
    await repository.writeSurface(initial);
    const root = document.createElement('div');
    document.body.append(root);
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 704 },
    });
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 600));
    const session = new InkDocumentSession({
      debounceMs: 60_000,
      now: () => '2026-07-18T00:01:00.000Z',
      surfaces: [initial],
      writer: repository,
    });
    const controller = new InkCanvasController({ document, root, scrollContainer: root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing PF-42 active Ink canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 704, 600));
    const move = pointer('pointermove', 40, 50, 100, {
      coalesced: [
        pointer('pointermove', 20, 30, 100, { pressure: 0.25, tiltX: 0, tiltY: 0 }),
        pointer('pointermove', 30, 40, 100, {
          pressure: Number.NaN,
          tiltX: Number.NaN,
          tiltY: Number.NaN,
        }),
        pointer('pointermove', 40, 50, 100, { pressure: 0.8, tiltX: 0, tiltY: 0 }),
      ],
      pressure: 0.8,
      tiltX: 0,
      tiltY: 0,
    });

    controller.enter();
    root.dispatchEvent(pointer('pointerdown', 10, 20, 100, { pressure: 0, tiltX: 10, tiltY: 20 }));
    root.dispatchEvent(move);
    root.dispatchEvent(
      pointer('pointerup', 50, 60, 100, {
        pressure: Number.NaN,
        tiltX: Number.NaN,
        tiltY: Number.NaN,
      }),
    );
    await controller.exit();
    controller.dispose();

    const persisted = await repository.readSurface(initial.filePath, initial.id);
    if (persisted === null || persisted.strokes[0] === undefined) {
      throw new Error('Missing PF-42 persisted stroke.');
    }
    const geometry = new LegacyRoundInkStrokeGeometry().compile(persisted.strokes[0]);

    expect(geometry.digest).toBe('c6edd6a3');
    expect(encodeInkSurfaceRecord(persisted)).toBe(`{
  "createdAt": "2026-07-14T08:00:00.000Z",
  "filePath": "Scale.md",
  "id": "surface-scale",
  "layout": {
    "blockFingerprints": [
      "block-1"
    ],
    "fontFamily": "system-ui",
    "fontSize": 16,
    "lineHeight": 24,
    "logicalHeight": 1200,
    "logicalWidth": 704,
    "sourceRevision": "source-scale",
    "themeMode": "light",
    "originY": 0
  },
  "noteId": "note-pf42-cycle-0",
  "revision": 2,
  "schemaVersion": 2,
  "status": "active",
  "strokes": [
    {
      "color": "#4f46d8",
      "id": "00000000-0000-4000-8000-000000000042",
      "tool": "pen",
      "width": 4,
      "deltas": [
        {
          "dp": 0.25,
          "dt": 0,
          "dx": 10.602409638554215,
          "dy": 10.602409638554217,
          "tiltX": 0,
          "tiltY": 0
        },
        {
          "dp": 0.25,
          "dt": 0,
          "dx": 10.602409638554217,
          "dy": 10.602409638554214,
          "tiltX": null,
          "tiltY": null
        },
        {
          "dp": 0.30000000000000004,
          "dt": 0,
          "dx": 10.602409638554214,
          "dy": 10.60240963855422,
          "tiltX": 0,
          "tiltY": 0
        },
        {
          "dp": -0.30000000000000004,
          "dt": 0,
          "dx": 10.60240963855422,
          "dy": 10.602409638554214,
          "tiltX": null,
          "tiltY": null
        }
      ],
      "origin": {
        "pressure": 0,
        "time": 100,
        "x": 10.602409638554215,
        "y": 21.20481927710843,
        "tiltX": 10.000000000000004,
        "tiltY": 20.000000000000004
      },
      "pointEncoding": "delta-v1"
    }
  ],
  "updatedAt": "2026-07-18T00:01:00.000Z"
}
`);
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
            { pressure: 0.7, time: 20, x: 96, y: 120 },
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
      expect(contexts.get(active)?.setTransform).toHaveBeenCalledWith(scale, 0, 0, scale, 80, 100);
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
        80,
        100,
      );
      reloaded.controller.dispose();

      const unchanged = await repository.readSurface(initial.filePath, initial.id);
      if (unchanged === null) throw new Error('Missing unchanged scaled Ink surface.');
      expect(encodeInkSurfaceRecord(unchanged)).toBe(persistedBytes);
    },
  );

  it('persists one closed-loop batch erase while retaining a crossing stroke at 50%', async () => {
    const store = new MemoryTextFileStore();
    const meta = await new SidecarRepository(store).getOrCreateNote({
      createId: () => 'note-circle-erase',
      filePath: 'Scale.md',
      now: '2026-07-17T08:00:00.000Z',
      sourceFingerprint: 'source-circle-erase',
    });
    const repository = new InkSurfaceRepository(store);
    const base = fixedSurface(meta.noteId);
    const initial: InkSurfaceRecord = {
      ...base,
      strokes: [
        storedStroke('inside-a', [logicalPoint(140, 290), logicalPoint(180, 320)]),
        storedStroke('inside-b', [logicalPoint(190, 340), logicalPoint(220, 370)]),
        storedStroke('crossing', [logicalPoint(150, 330), logicalPoint(320, 330)]),
      ],
    };
    await repository.writeSurface(initial);
    const { controller, root } = scaledController({ repository, scale: 0.5, surface: initial });
    controller.enter();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();
    const client = (x: number, y: number) => ({ x: 80 + x * 0.5, y: 100 + y * 0.5 });
    const loop = [client(100, 250), client(260, 250), client(260, 420), client(100, 420)];

    root.dispatchEvent(pointer('pointerdown', loop[0]?.x ?? 0, loop[0]?.y ?? 0, 10));
    root.dispatchEvent(pointer('pointermove', loop[1]?.x ?? 0, loop[1]?.y ?? 0, 20));
    root.dispatchEvent(pointer('pointermove', loop[2]?.x ?? 0, loop[2]?.y ?? 0, 30));
    root.dispatchEvent(pointer('pointermove', loop[3]?.x ?? 0, loop[3]?.y ?? 0, 40));
    root.dispatchEvent(pointer('pointerup', loop[0]?.x ?? 0, loop[0]?.y ?? 0, 50));
    await controller.exit();
    controller.dispose();

    const persisted = await repository.readSurface(initial.filePath, initial.id);
    expect(persisted?.strokes.map(({ id }) => id)).toEqual(['crossing']);
  });
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

function storedStroke(id: string, points: InkSurfaceRecord['strokes'][number]['points']) {
  return { color: '#4f46d8', id, points, tool: 'pen' as const, width: 4 };
}

function logicalPoint(x: number, y: number) {
  return { pressure: 0.5, time: x + y, x, y };
}

function pointer(
  type: string,
  x: number,
  y: number,
  timeStamp: number,
  overrides: {
    readonly coalesced?: readonly Event[];
    readonly pressure?: number;
    readonly tiltX?: number;
    readonly tiltY?: number;
  } = {},
): Event {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, {
    getCoalescedEvents: { value: () => overrides.coalesced ?? [event] },
    pointerId: { value: 1 },
    pointerType: { value: 'pen' },
    pressure: { value: overrides.pressure ?? 0.7 },
    tiltX: { value: overrides.tiltX ?? 0 },
    tiltY: { value: overrides.tiltY ?? 0 },
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
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    lineCap: 'round',
    lineJoin: 'round',
    lineTo,
    moveTo,
    restore: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setLineDash: vi.fn(),
    setTransform,
    stroke,
    strokeStyle: '#000',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  return { context, lineTo, moveTo, setTransform, stroke };
}
