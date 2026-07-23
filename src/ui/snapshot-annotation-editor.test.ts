// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { SnapshotAnnotationSession } from '../application/snapshot-annotation-session';
import { SharedInkStrokeGeometry } from '../domain/ink-shared-stroke-geometry';
import { LocalInkToolPreferenceStore } from '../storage/local-ink-tool-preference';
import { SnapshotAnnotationEditor } from './snapshot-annotation-editor';

vi.mock('obsidian', () => ({
  setIcon: (element: HTMLElement, icon: string) => {
    element.dataset.icon = icon;
  },
}));

describe('Snapshot Annotation editor lifecycle', () => {
  it('mounts the shared Ink toolbar and renders through shared Brush Geometry', async () => {
    document.body.replaceChildren();
    const session = await sessionWithStroke();
    const context = canvasContext();
    const compile = vi.spyOn(SharedInkStrokeGeometry.prototype, 'compile');
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const editor = new SnapshotAnnotationEditor({
      createObjectUrl: () => 'data:image/png;base64,fixture',
      document,
      revokeObjectUrl: () => undefined,
    });

    editor.open({
      onClose: vi.fn(),
      onDone: () => Promise.resolve(),
      pngBytes: pngHeader(600, 400),
      session,
    });

    expect(document.querySelector('[data-inkstone-ink-toolbar-app]')).not.toBeNull();
    expect(document.querySelector('.inkstone-snapshot-editor__toolbar')).toBeNull();
    expect(compile).toHaveBeenCalledWith(expect.objectContaining({ id: 'stroke-a' }));
    editor.dispose();
  });

  it('does not expose Snapshot crop controls', async () => {
    document.body.replaceChildren();
    const session = await emptySession();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const editor = new SnapshotAnnotationEditor({
      createObjectUrl: () => 'data:image/png;base64,fixture',
      document,
      revokeObjectUrl: () => undefined,
    });
    editor.open({
      onClose: vi.fn(),
      onDone: () => Promise.resolve(),
      pngBytes: pngHeader(600, 400),
      session,
    });

    expect(document.querySelector('[data-inkstone-snapshot-crop]')).toBeNull();
    expect(document.querySelector('[data-inkstone-snapshot-apply-crop]')).toBeNull();
    editor.dispose();
  });

  it('labels Preview as read-only and lets the user enter Edit from that state', async () => {
    document.body.replaceChildren();
    const session = await sessionWithStroke();
    const onEdit = vi.fn(() => Promise.resolve());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const editor = new SnapshotAnnotationEditor({
      createObjectUrl: () => 'data:image/png;base64,fixture',
      document,
      revokeObjectUrl: () => undefined,
    });
    editor.open({
      onClose: vi.fn(),
      onDone: () => Promise.resolve(),
      onEdit,
      pngBytes: pngHeader(600, 400),
      readOnly: true,
      session,
    });

    const root = document.querySelector('[data-inkstone-snapshot-editor]');
    const edit = document.querySelector<HTMLButtonElement>('[data-inkstone-snapshot-read-only]');
    expect(root?.getAttribute('aria-label')).toBe('Snapshot annotation preview, read only');
    expect(edit?.textContent).toContain('Read only');
    expect(edit?.textContent).toContain('Edit');
    expect(document.querySelector('[data-inkstone-ink-toolbar-app]')).toBeNull();

    edit?.click();
    await vi.waitFor(() => expect(onEdit).toHaveBeenCalledOnce());
    editor.dispose();
  });

  it('switches between Highlighter and Stroke Eraser while keeping erasure undoable', async () => {
    document.body.replaceChildren();
    const session = await sessionWithStroke();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const editor = new SnapshotAnnotationEditor({
      createObjectUrl: () => 'data:image/png;base64,fixture',
      document,
      revokeObjectUrl: () => undefined,
    });
    editor.open({
      onClose: vi.fn(),
      onDone: () => Promise.resolve(),
      pngBytes: pngHeader(600, 400),
      session,
    });
    const canvas = document.querySelector<HTMLCanvasElement>('[data-inkstone-snapshot-canvas]');
    expect(canvas).not.toBeNull();
    vi.spyOn(canvas as HTMLCanvasElement, 'getBoundingClientRect').mockReturnValue(
      rect(0, 0, 300, 200),
    );

    document.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="eraser"]')?.click();
    dispatchPointer(canvas as HTMLCanvasElement, 'pointerdown', 10, 20, 1);
    expect(session.snapshot().record.ink.strokes).toEqual([]);

    document.querySelector<HTMLButtonElement>('[data-inkstone-ink-undo]')?.click();
    expect(session.snapshot().record.ink.strokes).toMatchObject([{ id: 'stroke-a' }]);

    document.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="highlighter"]')?.click();
    dispatchPointer(canvas as HTMLCanvasElement, 'pointerdown', 30, 40, 2);
    dispatchPointer(canvas as HTMLCanvasElement, 'pointermove', 90, 100, 2);
    dispatchPointer(canvas as HTMLCanvasElement, 'pointerup', 90, 100, 2);
    expect(session.snapshot().record.ink.strokes.at(-1)?.tool).toBe('highlighter');
    editor.dispose();
  });

  it('uses touch for pan and Cmd plus wheel for zoom without creating Ink', async () => {
    document.body.replaceChildren();
    const session = await sessionWithStroke();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const editor = new SnapshotAnnotationEditor({
      createObjectUrl: () => 'data:image/png;base64,fixture',
      document,
      revokeObjectUrl: () => undefined,
    });
    editor.open({
      onClose: vi.fn(),
      onDone: () => Promise.resolve(),
      pngBytes: pngHeader(600, 400),
      session,
    });
    const canvas = document.querySelector<HTMLCanvasElement>('[data-inkstone-snapshot-canvas]');
    const viewport = document.querySelector<HTMLElement>('.inkstone-snapshot-editor__viewport');
    const frame = document.querySelector<HTMLElement>('.inkstone-snapshot-editor__frame');
    expect(canvas).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(frame).not.toBeNull();
    vi.spyOn(viewport as HTMLElement, 'getBoundingClientRect').mockReturnValue(
      rect(0, 0, 300, 200),
    );

    document.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-fit]')?.click();
    expect(frame?.style.transform).toContain('scale(1)');
    dispatchPointer(canvas as HTMLCanvasElement, 'pointerdown', 40, 40, 10, 'touch');
    dispatchPointer(canvas as HTMLCanvasElement, 'pointermove', 70, 60, 10, 'touch');
    dispatchPointer(canvas as HTMLCanvasElement, 'pointerup', 70, 60, 10, 'touch');
    expect(frame?.style.transform).toContain('translate(30px, 20px)');
    expect(session.snapshot().record.ink.strokes).toHaveLength(1);

    document.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-fit]')?.click();
    expect(frame?.style.transform).toContain('translate(0px, 0px) scale(1)');
    const ordinaryWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 150,
      clientY: 100,
      deltaY: -120,
    });
    viewport?.dispatchEvent(ordinaryWheel);
    expect(frame?.style.transform).toContain('translate(0px, 0px) scale(1)');
    expect(ordinaryWheel.defaultPrevented).toBe(false);

    const commandWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 150,
      clientY: 100,
      deltaY: -120,
      metaKey: true,
    });
    viewport?.dispatchEvent(commandWheel);
    expect(frame?.style.transform).not.toContain('scale(1)');
    expect(commandWheel.defaultPrevented).toBe(true);
    editor.dispose();
  });

  it('drags the image camera from blank canvas while Select and move Ink is active', async () => {
    document.body.replaceChildren();
    const session = await sessionWithStroke();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const editor = new SnapshotAnnotationEditor({
      createObjectUrl: () => 'data:image/png;base64,fixture',
      document,
      revokeObjectUrl: () => undefined,
    });
    editor.open({
      onClose: vi.fn(),
      onDone: () => Promise.resolve(),
      pngBytes: pngHeader(600, 400),
      session,
    });
    const canvas = document.querySelector<HTMLCanvasElement>('[data-inkstone-snapshot-canvas]');
    const viewport = document.querySelector<HTMLElement>('.inkstone-snapshot-editor__viewport');
    const frame = document.querySelector<HTMLElement>('.inkstone-snapshot-editor__frame');
    expect(canvas).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(frame).not.toBeNull();
    vi.spyOn(canvas as HTMLCanvasElement, 'getBoundingClientRect').mockReturnValue(
      rect(0, 0, 300, 200),
    );
    vi.spyOn(viewport as HTMLElement, 'getBoundingClientRect').mockReturnValue(
      rect(0, 0, 300, 200),
    );
    document.querySelector<HTMLButtonElement>('[data-inkstone-ink-zoom-fit]')?.click();
    document.querySelector<HTMLButtonElement>('[data-inkstone-ink-select-move]')?.click();
    expect(canvas?.dataset.inkstoneSnapshotInteraction).toBe('select');

    dispatchPointer(canvas as HTMLCanvasElement, 'pointerdown', 250, 150, 20);
    dispatchPointer(canvas as HTMLCanvasElement, 'pointermove', 280, 170, 20);
    dispatchPointer(canvas as HTMLCanvasElement, 'pointerup', 280, 170, 20);

    expect(frame?.style.transform).toContain('translate(30px, 20px) scale(1)');
    expect(session.snapshot().record.ink.strokes[0]?.points[0]).toMatchObject({ x: 10, y: 20 });
    editor.dispose();
  });

  it('uses Escape instead of an overlay Back button before leaving a changed session', async () => {
    document.body.replaceChildren();
    const session = await sessionWithStroke();
    const onClose = vi.fn();
    const onSaveDraft = vi.fn(() => Promise.resolve());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const editor = new SnapshotAnnotationEditor({
      createObjectUrl: () => 'data:image/png;base64,fixture',
      document,
      revokeObjectUrl: () => undefined,
    });
    editor.open({
      onClose,
      onDone: () => Promise.resolve(),
      onSaveDraft,
      pngBytes: pngHeader(600, 400),
      session,
    });

    expect(document.querySelector('[data-inkstone-snapshot-back]')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    const dialog = document.querySelector('[data-inkstone-snapshot-back-dialog]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Save draft');
    expect(dialog?.textContent).toContain('Discard');
    expect(dialog?.textContent).toContain('Continue editing');
    expect(onClose).not.toHaveBeenCalled();

    document.querySelector<HTMLButtonElement>('[data-inkstone-snapshot-save-draft]')?.click();
    await vi.waitFor(() => expect(onSaveDraft).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-inkstone-snapshot-editor]')).toBeNull();
  });

  it('shows an explicit Close action on desktop and protects unsaved work', async () => {
    document.body.replaceChildren();
    const session = await sessionWithStroke();
    const onClose = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const editor = new SnapshotAnnotationEditor({
      createObjectUrl: () => 'data:image/png;base64,fixture',
      document,
      revokeObjectUrl: () => undefined,
    });
    editor.open({
      onClose,
      onDone: () => Promise.resolve(),
      pngBytes: pngHeader(600, 400),
      session,
    });

    const close = document.querySelector<HTMLButtonElement>('[data-inkstone-snapshot-close]');
    expect(close?.getAttribute('aria-label')).toBe('Close Snapshot editor');
    close?.click();

    expect(document.querySelector('[data-inkstone-snapshot-back-dialog]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    editor.dispose();
  });

  it('shows a touch-sized Close action inside the mobile safe header', async () => {
    document.body.replaceChildren();
    document.body.classList.add('is-mobile');
    const onClose = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const editor = new SnapshotAnnotationEditor({
      createObjectUrl: () => 'data:image/png;base64,fixture',
      document,
      revokeObjectUrl: () => undefined,
    });

    try {
      editor.open({
        onClose,
        onDone: () => Promise.resolve(),
        pngBytes: pngHeader(600, 400),
        session: await emptySession(),
      });

      const close = document.querySelector<HTMLButtonElement>('[data-inkstone-snapshot-close]');
      expect(close?.getAttribute('aria-label')).toBe('Close Snapshot editor');
      expect(close?.dataset.icon).toBe('x');
      close?.click();
      expect(onClose).toHaveBeenCalledOnce();
      expect(document.querySelector('[data-inkstone-snapshot-editor]')).toBeNull();
    } finally {
      editor.dispose();
      document.body.classList.remove('is-mobile');
    }
  });

  it('restores the last tool, color, and width from the device-local preference', async () => {
    document.body.replaceChildren();
    const preferenceStore = new LocalInkToolPreferenceStore(
      new MemoryStorage(),
      'Snapshot fixture Vault',
      'ipad-fixture',
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const createEditor = () =>
      new SnapshotAnnotationEditor({
        createObjectUrl: () => 'data:image/png;base64,fixture',
        document,
        preferenceStore,
        revokeObjectUrl: () => undefined,
      });
    const open = async (editor: SnapshotAnnotationEditor) =>
      editor.open({
        onClose: vi.fn(),
        onDone: () => Promise.resolve(),
        pngBytes: pngHeader(600, 400),
        session: await emptySession(),
      });

    const first = createEditor();
    await open(first);
    document.querySelector<HTMLButtonElement>('[data-inkstone-ink-tool="highlighter"]')?.click();
    const color = document.querySelector<HTMLInputElement>('[data-inkstone-ink-color]');
    const width = document.querySelector<HTMLSelectElement>('[data-inkstone-ink-width-select]');
    if (color === null || width === null) throw new Error('Fixture Ink options were not mounted.');
    color.value = '#123456';
    color.dispatchEvent(new Event('input', { bubbles: true }));
    width.value = '8';
    width.dispatchEvent(new Event('change', { bubbles: true }));
    const controls = document.querySelector<HTMLElement>('.inkstone-ink-controls');
    const dragHandle = document.querySelector<HTMLElement>('[data-inkstone-ink-drag-handle]');
    if (controls === null || dragHandle === null) {
      throw new Error('Fixture Ink toolbar drag handle was not mounted.');
    }
    vi.spyOn(controls, 'getBoundingClientRect').mockReturnValue(rect(16, 600, 500, 46));
    dispatchPointer(dragHandle, 'pointerdown', 20, 610, 41);
    dispatchPointer(document, 'pointermove', 120, 510, 41);
    dispatchPointer(document, 'pointerup', 120, 510, 41);
    first.dispose();

    const second = createEditor();
    await open(second);
    expect(
      document
        .querySelector('[data-inkstone-ink-tool="highlighter"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(document.querySelector<HTMLInputElement>('[data-inkstone-ink-color]')?.value).toBe(
      '#123456',
    );
    expect(
      document.querySelector<HTMLSelectElement>('[data-inkstone-ink-width-select]')?.value,
    ).toBe('8');
    expect(document.querySelector<HTMLElement>('.inkstone-ink-controls')?.style.left).toBe('116px');
    expect(document.querySelector<HTMLElement>('.inkstone-ink-controls')?.style.top).toBe('500px');
    second.dispose();
  });

  it('keeps the mounted session after save failure and exposes Retry plus flattened PNG Export', async () => {
    document.body.replaceChildren();
    const session = await sessionWithStroke();
    const onDone = vi.fn(() => Promise.reject(new Error('fixture Vault failure')));
    const onExport = vi.fn(() => Promise.resolve());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const editor = new SnapshotAnnotationEditor({
      createObjectUrl: () => 'data:image/png;base64,fixture',
      document,
      revokeObjectUrl: () => undefined,
    });
    editor.open({
      onClose: vi.fn(),
      onDone,
      onExport,
      pngBytes: pngHeader(600, 400),
      session,
    });

    document.querySelector<HTMLButtonElement>('[data-inkstone-ink-done]')?.click();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    const retry = document.querySelector<HTMLButtonElement>('[data-inkstone-ink-retry]');
    const exportButton = document.querySelector<HTMLButtonElement>(
      '[data-inkstone-ink-export-unsaved]',
    );
    expect(document.querySelector('[data-inkstone-snapshot-editor]')).not.toBeNull();
    expect(retry?.getAttribute('aria-label')).toBe('Retry local save');
    await vi.waitFor(() => expect(exportButton?.hidden).toBe(false));

    exportButton?.click();
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledOnce());
    expect(session.snapshot().record.ink.strokes).toMatchObject([{ id: 'stroke-a' }]);
    editor.dispose();
  });
});

async function sessionWithStroke(): Promise<SnapshotAnnotationSession> {
  const session = await emptySession();
  session.addStroke({
    brushRenderVersion: 'legacy-round-v1',
    color: '#d97777',
    id: 'stroke-a',
    inputProfile: { pressure: 'legacy-unknown', tilt: 'legacy-unknown' },
    points: [{ pressure: 0.5, time: 1, x: 10, y: 20 }],
    tool: 'pen',
    width: 4,
  });
  return session;
}

async function emptySession(): Promise<SnapshotAnnotationSession> {
  const pngBytes = pngHeader(600, 400);
  const target = {
    position: { end: 4, start: 0, unit: 'utf16-code-unit' as const },
    quote: { exact: 'Test', prefix: '', suffix: '' },
    scope: { headingPath: ['Test'] },
    sourceRevision: 'source-a',
  };
  return SnapshotAnnotationSession.create({
    backend: { id: 'fake', version: '1' },
    capturedAt: '2026-07-22T00:00:00.000Z',
    filePath: 'Notes/Test.md',
    id: 'snapshot-a',
    logicalHeight: 200,
    logicalWidth: 300,
    noteId: 'note-a',
    pixelHeight: 400,
    pixelRatio: 2,
    pixelWidth: 600,
    pngBytes,
    source: {
      coverage: [target],
      focus: target,
      headingPath: ['Test'],
      sourceRevision: 'source-a',
    },
  });
}

function canvasContext(): CanvasRenderingContext2D {
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    lineCap: 'round',
    lineJoin: 'round',
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

function dispatchPointer(
  target: EventTarget,
  type: string,
  clientX: number,
  clientY: number,
  pointerId: number,
  pointerType = 'mouse',
): void {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
    pressure: { value: 0.5 },
  });
  target.dispatchEvent(event);
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

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
