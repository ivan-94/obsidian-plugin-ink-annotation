// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InkPoint, InkStroke, InkSurfaceRecord } from '../domain/ink-surface';
import type { InkSurfaceSessionSnapshot } from '../application/ink-surface-session';
import {
  committedStrokeRenderDelta,
  InkCanvasController,
  nextActivePaintSegment,
  selectVisibleInkStrokes,
} from './ink-canvas-controller';

describe('Ink palette performance', () => {
  afterEach(() => vi.restoreAllMocks());

  it('switches tools independently of 10,000 committed strokes within the interaction budget', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(contextFixture());
    const root = document.createElement('div');
    document.body.append(root);
    const controller = new InkCanvasController({ document, root, session: new LargeSession() });
    const pen = root.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="pen"]');
    const highlighter = root.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-tool="highlighter"]',
    );
    if (pen === null || highlighter === null) throw new Error('Missing palette buttons.');
    const startedAt = performance.now();

    for (let index = 0; index < 1_000; index += 1) {
      (index % 2 === 0 ? highlighter : pen).click();
    }
    const durationMs = performance.now() - startedAt;

    expect(durationMs).toBeLessThan(250);
    controller.dispose();
  });

  it('keeps long-stroke frames and committed append work independent of history length', () => {
    const points = Array.from({ length: 50_000 }, (_value, index): InkPoint => ({
      pressure: 0.5,
      time: index,
      x: index % 1_000,
      y: index % 1_000,
    }));
    const committed = Array.from({ length: 10_000 }, (_value, index) => stroke(index));
    const appended = stroke(10_000);
    const startedAt = performance.now();

    const activeDelta = nextActivePaintSegment(points, points.length - 1);
    const committedDelta = committedStrokeRenderDelta(committed, [...committed, appended]);
    const durationMs = performance.now() - startedAt;

    expect(activeDelta.points).toHaveLength(2);
    expect(committedDelta).toEqual({ kind: 'append', strokes: [appended] });
    expect(durationMs).toBeLessThan(16.7);
  });

  it('selects only viewport Ink from 10,000 off-screen strokes within one frame budget', () => {
    const strokes = Array.from({ length: 10_000 }, (_value, index): InkStroke => ({
      ...stroke(index),
      points: [
        { pressure: 0.5, time: index, x: 10, y: index * 20 },
        { pressure: 0.5, time: index + 1, x: 20, y: index * 20 + 10 },
      ],
    }));
    const startedAt = performance.now();

    const visible = selectVisibleInkStrokes(strokes, 100_000, 800);
    const durationMs = performance.now() - startedAt;

    expect(visible.length).toBeLessThan(50);
    expect(visible.every(({ points }) => points.some(({ y }) => y >= 99_998 && y <= 100_802))).toBe(
      true,
    );
    expect(durationMs).toBeLessThan(16.7);
  });
});

class LargeSession {
  private readonly record: InkSurfaceRecord = {
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Ink.md',
    id: 'surface',
    layout: {
      blockFingerprints: ['a'],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1000,
      logicalWidth: 1000,
      sourceRevision: 'source',
      themeMode: 'light',
    },
    noteId: 'note',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: Array.from({ length: 10_000 }, (_value, index) => stroke(index)),
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
  addStroke(): void {}
  background(): Promise<void> {
    return Promise.resolve();
  }
  canRedo(): boolean {
    return false;
  }
  canUndo(): boolean {
    return false;
  }
  eraseStrokeAt(): string | null {
    return null;
  }
  exit(): Promise<void> {
    return Promise.resolve();
  }
  redo(): boolean {
    return false;
  }
  retry(): Promise<void> {
    return Promise.resolve();
  }
  snapshot(): InkSurfaceSessionSnapshot {
    return {
      persistence: { kind: 'idle' },
      state: { dirty: false, kind: 'ink-mode', saveError: null },
      surface: this.record,
    };
  }
  undo(): boolean {
    return false;
  }
}

function stroke(index: number): InkStroke {
  const point: InkPoint = { pressure: 0.5, time: index, x: index % 1000, y: index % 1000 };
  return { color: '#111111', id: `stroke-${index}`, points: [point], tool: 'pen', width: 2 };
}

function contextFixture(): CanvasRenderingContext2D {
  return {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    lineCap: 'round',
    lineJoin: 'round',
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    scale: vi.fn(),
    stroke: vi.fn(),
    strokeStyle: '#000',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
}
