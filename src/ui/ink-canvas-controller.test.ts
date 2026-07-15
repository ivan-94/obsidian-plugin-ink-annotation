// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import type { InkSurfaceSessionSnapshot } from '../application/ink-surface-session';
import {
  committedStrokeRenderDelta,
  InkCanvasController,
  nextActivePaintSegment,
} from './ink-canvas-controller';
import type { InkToolPreference } from '../storage/local-ink-tool-preference';

describe('Ink canvas controller', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(contextFixture());
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('paints only the new tail of a long active stroke after the first frame', () => {
    const points = [
      { pressure: 0.5, time: 0, x: 0, y: 0 },
      { pressure: 0.5, time: 1, x: 1, y: 1 },
      { pressure: 0.5, time: 2, x: 2, y: 2 },
      { pressure: 0.5, time: 3, x: 3, y: 3 },
    ];

    expect(nextActivePaintSegment(points.slice(0, 2), 0)).toEqual({
      nextPaintedPointCount: 2,
      points: points.slice(0, 2),
    });
    expect(nextActivePaintSegment(points, 2)).toEqual({
      nextPaintedPointCount: 4,
      points: points.slice(1),
    });
  });

  it('appends a committed stroke without replaying an unchanged large prefix', () => {
    const first = stroke('first');
    const second = stroke('second');

    expect(committedStrokeRenderDelta([first], [first, second])).toEqual({
      kind: 'append',
      strokes: [second],
    });
    expect(committedStrokeRenderDelta([first, second], [first, second])).toEqual({
      kind: 'none',
      strokes: [],
    });
    expect(committedStrokeRenderDelta([first, second], [first])).toEqual({
      kind: 'full',
      strokes: [first],
    });
    expect(committedStrokeRenderDelta([first], [{ ...first, color: '#ffffff' }])).toEqual({
      kind: 'full',
      strokes: [{ ...first, color: '#ffffff' }],
    });
  });

  it('renders committed Ink while inactive without intercepting reading interactions', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });

    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const committed = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-committed]');

    expect(active?.style.pointerEvents).toBe('none');
    expect(committed?.style.pointerEvents).toBe('none');
    expect(root.classList.contains('inkstone-ink-host')).toBe(true);
    controller.dispose();
  });

  it('captures mouse drawing only in Ink Mode and restores pointer pass-through after exit', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));

    controller.enter();
    expect(active.style.pointerEvents).toBe('auto');
    expect(root.querySelector<HTMLElement>('.inkstone-ink-controls')?.style.display).toBe('flex');
    expect(root.querySelector('[data-inkstone-ink-status]')?.textContent).toContain('Ink Mode');
    active.dispatchEvent(pointer('pointerdown', 10, 20));
    active.dispatchEvent(pointer('pointermove', 20, 30));
    active.dispatchEvent(pointer('pointerup', 30, 40));

    expect(session.strokes[0]?.tool).toBe('pen');
    expect(Array.isArray(session.strokes[0]?.points)).toBe(true);
    expect(session.strokes[0]?.points.length).toBeGreaterThanOrEqual(2);

    await controller.exit();
    expect(session.exitCalls).toBe(1);
    expect(active.style.pointerEvents).toBe('none');
    expect(root.querySelector<HTMLElement>('.inkstone-ink-controls')?.style.display).toBe('none');
    expect(root.classList.contains('is-ink-mode')).toBe(false);
  });

  it('reports pointer-to-presented-frame latency without exposing stroke points', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    let now = 100;
    const samples: number[] = [];
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      now: () => now,
      recordInputToPaint: (durationMs) => samples.push(durationMs),
      root,
      session: new FakeSession(surface()),
    });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();

    active.dispatchEvent(pointer('pointerdown', 10, 20));
    expect(frames).toHaveLength(1);
    now = 108;
    frames.shift()?.(now);
    expect(samples).toEqual([]);
    now = 116;
    frames.shift()?.(now);

    expect(samples).toEqual([16]);
  });

  it('routes touch input to reading instead of starting a desktop stroke', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();

    active.dispatchEvent(pointer('pointerdown', 10, 20, 'touch'));
    active.dispatchEvent(pointer('pointerup', 20, 30, 'touch'));

    expect(session.strokes).toEqual([]);
  });

  it('switches pen/highlighter styles and exposes non-color active state', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    const highlighter = root.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-tool="highlighter"]',
    );
    if (active === null || highlighter === null) throw new Error('Missing Ink controls.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();

    highlighter.click();
    active.dispatchEvent(pointer('pointerdown', 10, 20));
    active.dispatchEvent(pointer('pointerup', 30, 40));

    expect(highlighter.getAttribute('aria-pressed')).toBe('true');
    expect(session.strokes[0]).toMatchObject({ tool: 'highlighter', width: 12 });
    highlighter.click();
    expect(root.querySelector<HTMLInputElement>('[data-inkstone-ink-color]')?.hidden).toBe(false);
  });

  it('routes eraser hits and undo/redo controls through linked document commands', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface([stroke('saved')]));
    const controller = new InkCanvasController({ document, root, session });
    const active = root.querySelector<HTMLCanvasElement>('[data-inkstone-ink-active]');
    if (active === null) throw new Error('Missing active canvas.');
    vi.spyOn(active, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 960, 1200));
    controller.enter();

    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();
    active.dispatchEvent(pointer('pointerdown', 10, 10));
    active.dispatchEvent(pointer('pointerup', 12, 12));
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-undo]')?.click();
    root.querySelector<HTMLButtonElement>('[data-inkstone-ink-redo]')?.click();

    expect(session.eraseCalls).toBe(1);
    expect(session.undoCalls).toBe(1);
    expect(session.redoCalls).toBe(1);
  });

  it('snapshots device-local tool preference and records the one-time hint without late mutation', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const changes: InkToolPreference[] = [];
    const preference: InkToolPreference = {
      color: '#123456',
      hintShown: false,
      tool: 'highlighter',
      width: 8,
    };
    const controller = new InkCanvasController({
      document,
      onPreferenceChanged: (next) => changes.push(next),
      preference,
      root,
      session: new FakeSession(surface()),
    });

    controller.enter();

    expect(
      root.querySelector('[data-inkstone-ink-tool="highlighter"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(root.querySelector('[data-inkstone-ink-status]')?.textContent).toContain('Draw with');
    expect(changes.at(-1)).toMatchObject({ hintShown: true, tool: 'highlighter' });
    expect(preference.hintShown).toBe(false);
  });

  it('keeps the palette in deterministic keyboard order with names, tooltips, and live status', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({
      document,
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();
    const controls = root.querySelector<HTMLElement>('.inkstone-ink-controls');
    const buttons = [...(controls?.querySelectorAll<HTMLButtonElement>('button') ?? [])];

    expect(controls?.getAttribute('role')).toBe('toolbar');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Done drawing',
      'Pen',
      'Highlighter',
      'Eraser',
      'Undo Ink change',
      'Redo Ink change',
      'Show or hide Ink color and width',
      'Retry local Ink save',
    ]);
    expect(
      buttons.every((button) => button.textContent?.trim() || button.getAttribute('aria-label')),
    ).toBe(true);
    expect(
      buttons.filter((button) => !button.hidden).every((button) => button.title.length > 0),
    ).toBe(true);
    expect(root.querySelector('[data-inkstone-ink-status]')?.getAttribute('aria-live')).toBe(
      'polite',
    );
    expect(root.querySelector('[data-inkstone-ink-status]')?.getAttribute('role')).toBe('status');
    const more = root.querySelector<HTMLButtonElement>(
      'button[aria-label="Show or hide Ink color and width"]',
    );
    more?.focus();
    more?.click();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Ink color');
    expect(root.querySelector<HTMLInputElement>('[aria-label="Ink color"]')?.hidden).toBe(false);
  });

  it('delegates the palette Exit button to the host Ink mode lifecycle', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const requests: string[] = [];
    const controller = new InkCanvasController({
      document,
      onExitRequested: () => {
        requests.push('exit');
        return Promise.resolve();
      },
      root,
      session: new FakeSession(surface()),
    });
    controller.enter();

    root.querySelector<HTMLButtonElement>('button[aria-label="Done drawing"]')?.click();
    await vi.waitFor(() => expect(requests).toEqual(['exit']));
  });

  it('keeps Ink Mode active on save failure and exposes Retry', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const session = new FakeSession(surface());
    session.failExit = true;
    const controller = new InkCanvasController({ document, root, session });
    controller.enter();

    await expect(controller.exit()).rejects.toThrow('disk unavailable');

    expect(root.classList.contains('is-ink-mode')).toBe(true);
    const retry = root.querySelector<HTMLButtonElement>('[data-inkstone-ink-retry]');
    expect(retry?.hidden).toBe(false);
    retry?.click();
    await vi.waitFor(() => expect(session.retryCalls).toBe(1));
  });
});

class FakeSession {
  eraseCalls = 0;
  exitCalls = 0;
  failExit = false;
  retryCalls = 0;
  redoCalls = 0;
  state: InkSurfaceSessionSnapshot['state'] = {
    dirty: false,
    kind: 'ink-mode',
    saveError: null,
  };
  strokes: InkStroke[];
  undoCalls = 0;

  constructor(private record: InkSurfaceRecord) {
    this.strokes = [...record.strokes];
  }

  snapshot(): InkSurfaceSessionSnapshot {
    return {
      persistence:
        this.state.kind === 'ink-mode' && this.state.saveError !== null
          ? {
              error: new Error(this.state.saveError),
              kind: 'error',
              message: "Couldn't save Ink locally. Retry.",
            }
          : { kind: 'idle' },
      state: this.state,
      surface: { ...this.record, strokes: this.strokes },
    };
  }

  addStroke(stroke: InkStroke): void {
    this.strokes.push(stroke);
    this.state = { dirty: true, kind: 'ink-mode', saveError: null };
  }

  background(): Promise<void> {
    return Promise.resolve();
  }

  exit(): Promise<void> {
    this.exitCalls += 1;
    if (this.failExit) {
      this.state = {
        dirty: true,
        kind: 'ink-mode',
        pendingIntent: 'exit',
        saveError: 'disk unavailable',
      };
      return Promise.reject(new Error('disk unavailable'));
    }
    this.state = { kind: 'reading' };
    return Promise.resolve();
  }

  retry(): Promise<void> {
    this.retryCalls += 1;
    this.failExit = false;
    this.state = { kind: 'reading' };
    return Promise.resolve();
  }

  canRedo(): boolean {
    return true;
  }

  canUndo(): boolean {
    return true;
  }

  eraseStrokeAt(): string | null {
    this.eraseCalls += 1;
    return this.strokes[0]?.id ?? null;
  }

  redo(): boolean {
    this.redoCalls += 1;
    return true;
  }

  undo(): boolean {
    this.undoCalls += 1;
    return true;
  }
}

function surface(strokes: readonly InkStroke[] = []): InkSurfaceRecord {
  return {
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Ink.md',
    id: 'surface-1',
    layout: {
      blockFingerprints: ['block'],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1200,
      logicalWidth: 960,
      sourceRevision: 'source',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes,
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}

function stroke(id: string): InkStroke {
  return {
    color: '#4f46d8',
    id,
    points: [
      { pressure: 0.5, time: 0, x: 10, y: 10 },
      { pressure: 0.5, time: 16, x: 20, y: 20 },
    ],
    tool: 'pen',
    width: 4,
  };
}

function pointer(type: string, x: number, y: number, pointerType = 'mouse'): Event {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, {
    getCoalescedEvents: { value: () => [event] },
    pointerId: { value: 1 },
    pointerType: { value: pointerType },
    pressure: { value: pointerType === 'pen' ? 0.7 : 0 },
    tiltX: { value: 0 },
    tiltY: { value: 0 },
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

function contextFixture(): CanvasRenderingContext2D {
  return {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    lineCap: 'round',
    lineJoin: 'round',
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    stroke: vi.fn(),
    strokeStyle: '#000',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
}
