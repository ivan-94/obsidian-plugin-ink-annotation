// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InkSurfaceRecord } from '../domain/ink-surface';
import type { InkLayoutObservation, InkSurfaceSection } from '../domain/ink-surface-layout';
import { InkRebaseDialog } from './ink-rebase-dialog';

describe('Ink rebase dialog', () => {
  let canvas: ReturnType<typeof contextFixture>;

  beforeEach(() => {
    document.body.replaceChildren();
    canvas = contextFixture();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvas.context);
  });

  afterEach(() => vi.restoreAllMocks());

  it('previews a candidate without mutating canonical data, then persists only on confirm', async () => {
    const record = surface();
    const original = structuredClone(record);
    const writes: InkSurfaceRecord[] = [];
    const dialog = new InkRebaseDialog({
      document,
      now: () => '2026-07-14T13:00:00.000Z',
      onConfirm: (updated) => {
        writes.push(updated);
        return Promise.resolve();
      },
      record,
      targets: [target('A', 100, 200), target('B', 300, 500)],
    });

    const result = dialog.show();
    const select = document.querySelector<HTMLSelectElement>('[data-inkstone-rebase-target]');
    if (select === null) throw new Error('Missing rebase target selector.');
    select.value = '1';
    select.dispatchEvent(new Event('change'));

    expect(record).toEqual(original);
    expect(writes).toEqual([]);
    expect(document.querySelector('[data-inkstone-rebase-preview]')?.textContent).toContain('B');

    document.querySelector<HTMLButtonElement>('[data-inkstone-rebase-confirm]')?.click();
    await expect(result).resolves.toBe('confirmed');
    expect(writes[0]).toMatchObject({
      binding: { headingPath: ['B'], sourceStart: 300 },
      revision: 3,
      status: 'active',
      strokes: [
        {
          points: [
            { x: 50, y: 50 },
            { x: 100, y: 100 },
          ],
        },
      ],
    });
  });

  it('closes on cancel without a canonical write', async () => {
    const onConfirm = vi.fn<(record: InkSurfaceRecord) => Promise<void>>();
    const dialog = new InkRebaseDialog({
      document,
      onConfirm,
      record: surface(),
      targets: [target('A', 100, 200)],
    });

    const result = dialog.show();
    document.querySelector<HTMLButtonElement>('[data-inkstone-rebase-cancel]')?.click();

    await expect(result).resolves.toBe('cancelled');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.querySelector('[data-inkstone-rebase-dialog]')).toBeNull();
  });

  it('previews a physical nib from shared filled contours instead of a line-width stroke', () => {
    const dialog = new InkRebaseDialog({
      document,
      onConfirm: () => Promise.resolve(),
      record: physicalSurface(),
      targets: [target('A', 100, 200)],
    });

    void dialog.show();

    expect(canvas.scale).toHaveBeenCalledOnce();
    expect(canvas.closePath).toHaveBeenCalled();
    expect(canvas.fill).toHaveBeenCalledOnce();
    expect(canvas.stroke).not.toHaveBeenCalled();
  });

  it('keeps a linked physical fragment fail-closed without crashing or writing', async () => {
    const record = physicalSurface();
    const physical = record.strokes[0];
    if (physical === undefined) throw new Error('Missing linked physical rebase fixture.');
    const linked: InkSurfaceRecord = {
      ...record,
      strokes: [
        {
          ...physical,
          id: 'physical-pen-surface-a',
          linkedStrokeId: 'physical-pen',
          points: physical.points.map((point, fragmentTraceOrder) => ({
            ...point,
            fragmentGlobalY: point.y,
            fragmentTraceOrder,
          })),
        },
      ],
    };
    const original = structuredClone(linked);
    const onConfirm = vi.fn<(updated: InkSurfaceRecord) => Promise<void>>();
    const dialog = new InkRebaseDialog({
      document,
      onConfirm,
      record: linked,
      targets: [target('A', 100, 200)],
    });

    const result = dialog.show();

    expect(
      document.querySelector<HTMLButtonElement>('[data-inkstone-rebase-confirm]')?.disabled,
    ).toBe(true);
    expect(document.querySelector('.inkstone-ink-rebase-dialog__status')?.textContent).toMatch(
      /document-level rebase/u,
    );
    expect(linked).toEqual(original);
    expect(onConfirm).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[data-inkstone-rebase-cancel]')?.click();
    await expect(result).resolves.toBe('cancelled');
  });
});

function surface(): InkSurfaceRecord {
  return {
    binding: {
      blockFingerprints: ['old'],
      headingPath: ['Old'],
      sectionFingerprint: 'old',
      sourceEnd: 80,
      sourceStart: 0,
    },
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Ink.md',
    id: 'surface-a',
    layout: {
      blockFingerprints: ['old'],
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 1200,
      logicalWidth: 960,
      sourceRevision: 'old',
      themeMode: 'light',
    },
    noteId: 'note-1',
    revision: 2,
    schemaVersion: 1,
    status: 'needs-rebase',
    strokes: [
      {
        color: '#4f46d8',
        id: 'stroke-1',
        points: [point(100, 100), point(200, 200)],
        tool: 'pen',
        width: 4,
      },
    ],
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}

function physicalSurface(): InkSurfaceRecord {
  const base = surface();
  return {
    ...base,
    layout: { ...base.layout, originY: 0 },
    schemaVersion: 3,
    strokes: [
      {
        brushRenderVersion: 'pen-physical-v1',
        color: '#112233',
        id: 'physical-pen',
        inputProfile: { pressure: 'measured', tilt: 'unavailable' },
        points: [
          {
            orientation: { kind: 'unavailable' },
            pressure: 1,
            pressureKind: 'measured',
            time: 0,
            x: 100,
            y: 100,
          },
        ],
        tool: 'pen',
        width: 4,
      },
    ],
  };
}

function target(
  name: string,
  sourceStart: number,
  sourceEnd: number,
): {
  layout: InkLayoutObservation;
  section: InkSurfaceSection;
} {
  return {
    layout: {
      fontAvailable: true,
      fontFamily: 'Inter',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 600,
      logicalWidth: 480,
      sourceRevision: 'new',
      themeMode: 'light',
      viewportWidth: 480,
    },
    section: {
      blockFingerprints: [`block-${name}`],
      headingPath: [name],
      sectionFingerprint: `section-${name}`,
      sourceEnd,
      sourceStart,
    },
  };
}

function point(x: number, y: number) {
  return { pressure: 0.5, time: x + y, x, y };
}

function contextFixture() {
  const closePath = vi.fn();
  const fill = vi.fn();
  const scale = vi.fn();
  const stroke = vi.fn();
  const context = {
    beginPath: vi.fn(),
    closePath,
    clearRect: vi.fn(),
    fill,
    fillStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'round',
    lineJoin: 'round',
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    scale,
    stroke,
    strokeStyle: '#000',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  return { closePath, context, fill, scale, stroke };
}
