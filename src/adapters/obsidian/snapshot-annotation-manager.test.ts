// @vitest-environment jsdom

import { MarkdownView, type TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

import type { SnapshotCaptureBackend } from './snapshot-capture-backend';
import {
  leaseSnapshotCaptureSubject,
  SnapshotCaptureBackendRegistry,
} from './snapshot-capture-backend';
import { ObsidianSnapshotAnnotationManager } from './snapshot-annotation-manager';
import { SnapshotAnnotationSession } from '../../application/snapshot-annotation-session';
import { SnapshotAnnotationRepository } from '../../storage/snapshot-annotation-repository';
import type { SnapshotAnnotationFileStore } from '../../storage/snapshot-annotation-repository';
import {
  type OpenSnapshotAnnotationEditorInput,
  SnapshotAnnotationEditor,
} from '../../ui/snapshot-annotation-editor';

vi.mock('obsidian', () => ({
  MarkdownView: class {},
  setIcon: (element: HTMLElement, icon: string) => {
    element.dataset.icon = icon;
  },
}));

describe('Snapshot Annotation desktop core flow', () => {
  it('reopens a sidebar-selected Snapshot by its file path when no Markdown leaf is active', async () => {
    document.body.replaceChildren();
    const pngBytes = pngHeader(600, 400);
    const session = await SnapshotAnnotationSession.create({
      backend: { id: 'fake', version: '1' },
      capturedAt: '2026-07-22T00:00:00.000Z',
      filePath: 'Notes/Test.md',
      id: 'snapshot-sidebar',
      logicalHeight: 200,
      logicalWidth: 300,
      noteId: 'note-a',
      pixelHeight: 400,
      pixelRatio: 2,
      pixelWidth: 600,
      pngBytes,
      source: {
        coverage: [target()],
        focus: target(),
        headingPath: ['Test'],
        sourceRevision: 'source-a',
      },
    });
    const repository = new SnapshotAnnotationRepository(new MemorySnapshotFileStore());
    await repository.create(session.snapshot().record, pngBytes);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const manager = new ObsidianSnapshotAnnotationManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Test') },
        workspace: { getActiveViewOfType: () => null },
      },
      backendId: 'unused',
      captureBackends: new SnapshotCaptureBackendRegistry([]),
      createCaptureSubject: () => leaseSnapshotCaptureSubject({ kind: 'fake' }),
      document,
      editor: new SnapshotAnnotationEditor({
        createObjectUrl: () => 'data:image/png;base64,fixture',
        document,
        revokeObjectUrl: () => undefined,
      }),
      repository,
      textRepository: { getOrCreateNote: vi.fn() },
    });

    await expect(manager.reopen('Notes/Test.md', 'snapshot-sidebar')).resolves.toBe(true);
    expect(document.querySelector('[data-inkstone-snapshot-editor]')).not.toBeNull();
    manager.dispose();
  });

  it('opens the Snapshot note before going to its source from the Entire Vault sidebar', async () => {
    document.body.replaceChildren();
    const pngBytes = pngHeader(600, 400);
    const session = await SnapshotAnnotationSession.create({
      backend: { id: 'fake', version: '1' },
      capturedAt: '2026-07-22T00:00:00.000Z',
      filePath: 'Notes/Test.md',
      id: 'snapshot-go-to-source',
      logicalHeight: 200,
      logicalWidth: 300,
      noteId: 'note-a',
      pixelHeight: 400,
      pixelRatio: 2,
      pixelWidth: 600,
      pngBytes,
      source: {
        coverage: [target()],
        focus: target(),
        headingPath: ['Test'],
        sourceRevision: 'source-a',
      },
    });
    const repository = new SnapshotAnnotationRepository(new MemorySnapshotFileStore());
    await repository.create(session.snapshot().record, pngBytes);
    const contentEl = document.createElement('div');
    const sizer = document.createElement('div');
    sizer.className = 'markdown-preview-sizer';
    const heading = document.createElement('h1');
    heading.textContent = 'Test';
    const scrollIntoView = vi.fn();
    heading.scrollIntoView = scrollIntoView;
    sizer.append(heading);
    contentEl.append(sizer);
    const file = { path: 'Notes/Test.md' } as TFile;
    const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      contentEl,
      file,
      getMode: () => 'preview' as const,
    });
    const openFile = vi.fn(() => Promise.resolve());
    const manager = new ObsidianSnapshotAnnotationManager({
      app: {
        vault: {
          cachedRead: () => Promise.resolve('# Test'),
          getFileByPath: () => file,
        },
        workspace: {
          getActiveViewOfType: () => null,
          getLeaf: () => ({ openFile, view }),
        },
      },
      backendId: 'unused',
      captureBackends: new SnapshotCaptureBackendRegistry([]),
      createCaptureSubject: () => leaseSnapshotCaptureSubject({ kind: 'fake' }),
      document,
      editor: { dispose: vi.fn() } as unknown as SnapshotAnnotationEditor,
      repository,
      textRepository: { getOrCreateNote: vi.fn() },
    });

    await expect(manager.jumpToSource('Notes/Test.md', 'snapshot-go-to-source')).resolves.toBe(
      true,
    );
    expect(openFile).toHaveBeenCalledWith(file);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    manager.dispose();
  });

  it('selects the Snapshot source when its note opens in an editing view', async () => {
    document.body.replaceChildren();
    const pngBytes = pngHeader(600, 400);
    const session = await SnapshotAnnotationSession.create({
      backend: { id: 'fake', version: '1' },
      capturedAt: '2026-07-22T00:00:00.000Z',
      filePath: 'Notes/Test.md',
      id: 'snapshot-editing-source',
      logicalHeight: 200,
      logicalWidth: 300,
      noteId: 'note-a',
      pixelHeight: 400,
      pixelRatio: 2,
      pixelWidth: 600,
      pngBytes,
      source: {
        coverage: [target()],
        focus: target(),
        headingPath: ['Test'],
        sourceRevision: 'source-a',
      },
    });
    const repository = new SnapshotAnnotationRepository(new MemorySnapshotFileStore());
    await repository.create(session.snapshot().record, pngBytes);
    const setSelection = vi.fn();
    const scrollIntoView = vi.fn();
    const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      contentEl: document.createElement('div'),
      editor: {
        offsetToPos: (offset: number) => ({ ch: offset, line: 0 }),
        scrollIntoView,
        setSelection,
      },
      file: { path: 'Notes/Test.md' },
      getMode: () => 'source' as const,
    });
    const manager = new ObsidianSnapshotAnnotationManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Test') },
        workspace: { getActiveViewOfType: () => view },
      },
      backendId: 'unused',
      captureBackends: new SnapshotCaptureBackendRegistry([]),
      createCaptureSubject: () => leaseSnapshotCaptureSubject({ kind: 'fake' }),
      document,
      editor: { dispose: vi.fn() } as unknown as SnapshotAnnotationEditor,
      repository,
      textRepository: { getOrCreateNote: vi.fn() },
    });

    await expect(manager.jumpToSource('Notes/Test.md', 'snapshot-editing-source')).resolves.toBe(
      true,
    );
    expect(setSelection).toHaveBeenCalledWith({ ch: 2, line: 0 }, { ch: 6, line: 0 });
    expect(scrollIntoView).toHaveBeenCalledWith(
      { from: { ch: 2, line: 0 }, to: { ch: 6, line: 0 } },
      true,
    );
    manager.dispose();
  });

  it('promotes a read-only Preview into Edit for the same canonical Snapshot', async () => {
    const pngBytes = pngHeader(600, 400);
    const session = await SnapshotAnnotationSession.create({
      backend: { id: 'fake', version: '1' },
      capturedAt: '2026-07-22T00:00:00.000Z',
      filePath: 'Notes/Test.md',
      id: 'snapshot-preview',
      logicalHeight: 200,
      logicalWidth: 300,
      noteId: 'note-a',
      pixelHeight: 400,
      pixelRatio: 2,
      pixelWidth: 600,
      pngBytes,
      source: {
        coverage: [target()],
        focus: target(),
        headingPath: ['Test'],
        sourceRevision: 'source-a',
      },
    });
    const repository = new SnapshotAnnotationRepository(new MemorySnapshotFileStore());
    await repository.create(session.snapshot().record, pngBytes);
    const openings: OpenSnapshotAnnotationEditorInput[] = [];
    const manager = new ObsidianSnapshotAnnotationManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Test') },
        workspace: { getActiveViewOfType: () => null },
      },
      backendId: 'unused',
      captureBackends: new SnapshotCaptureBackendRegistry([]),
      createCaptureSubject: () => leaseSnapshotCaptureSubject({ kind: 'fake' }),
      document,
      editor: {
        dispose: vi.fn(),
        open: (input: OpenSnapshotAnnotationEditorInput) => openings.push(input),
      } as unknown as SnapshotAnnotationEditor,
      repository,
      textRepository: { getOrCreateNote: vi.fn() },
    });

    await expect(manager.reopen('Notes/Test.md', 'snapshot-preview', true)).resolves.toBe(true);
    expect(openings).toHaveLength(1);
    expect(openings[0]).toMatchObject({ readOnly: true });
    await openings[0]?.onEdit?.();
    expect(openings).toHaveLength(2);
    expect(openings[1]?.readOnly).toBe(false);
    expect(openings[1]?.session.snapshot().record.id).toBe('snapshot-preview');
    manager.dispose();
  });

  it('resumes the latest device-local Draft for the active file', async () => {
    document.body.replaceChildren();
    const contentEl = document.createElement('div');
    const preview = document.createElement('div');
    preview.className = 'markdown-preview-view';
    const sizer = document.createElement('div');
    sizer.className = 'markdown-preview-sizer';
    preview.append(sizer);
    contentEl.append(preview);
    document.body.append(contentEl);
    const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      contentEl,
      file: { path: 'Notes/Test.md' },
      getMode: () => 'preview' as const,
    });
    const pngBytes = pngHeader(600, 400);
    const draftSession = await SnapshotAnnotationSession.create({
      backend: { id: 'fake', version: '1' },
      capturedAt: '2026-07-22T00:00:00.000Z',
      filePath: 'Notes/Test.md',
      id: 'snapshot-draft',
      logicalHeight: 200,
      logicalWidth: 300,
      noteId: 'note-a',
      pixelHeight: 400,
      pixelRatio: 2,
      pixelWidth: 600,
      pngBytes,
      source: {
        coverage: [target()],
        focus: target(),
        headingPath: ['Test'],
        sourceRevision: 'source-a',
      },
    });
    draftSession.addStroke(stroke('stroke-draft'));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const manager = new ObsidianSnapshotAnnotationManager({
      app: {
        vault: { cachedRead: () => Promise.resolve('# Test') },
        workspace: { getActiveViewOfType: () => view },
      },
      backendId: 'unused',
      captureBackends: new SnapshotCaptureBackendRegistry([]),
      createCaptureSubject: () => leaseSnapshotCaptureSubject({ kind: 'fake' }),
      document,
      draftStore: {
        discard: () => Promise.resolve(),
        load: () => Promise.resolve(null),
        loadLatest: () =>
          Promise.resolve({
            draftKey: 'Notes/Test.md:snapshot-draft',
            isNew: true,
            pngBytes,
            record: draftSession.snapshot().record,
            savedAt: '2026-07-22T01:00:00.000Z',
          }),
        replace: () => Promise.resolve(),
      },
      editor: new SnapshotAnnotationEditor({
        createObjectUrl: () => 'data:image/png;base64,fixture',
        document,
        revokeObjectUrl: () => undefined,
      }),
      repository: new SnapshotAnnotationRepository(new MemorySnapshotFileStore()),
      textRepository: { getOrCreateNote: vi.fn() },
    });

    await expect(manager.resumeLatestDraftForActiveFile()).resolves.toBe(true);
    expect(manager.activeSessionSnapshot()).toMatchObject({
      persistence: { kind: 'editing' },
      record: { id: 'snapshot-draft', ink: { strokes: [{ id: 'stroke-draft' }] } },
    });
    expect(document.querySelector('[data-inkstone-snapshot-editor]')).not.toBeNull();
    manager.dispose();
  });

  it('captures Reading View, draws one image-local stroke, commits, and reopens it', async () => {
    document.body.replaceChildren();
    const contentEl = document.createElement('div');
    const preview = document.createElement('div');
    preview.className = 'markdown-preview-view';
    const sizer = document.createElement('div');
    sizer.className = 'markdown-preview-sizer';
    const heading = document.createElement('h1');
    heading.textContent = 'Test';
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Visible paragraph';
    const repeatedParagraph = document.createElement('p');
    repeatedParagraph.textContent = 'Visible paragraph';
    const headingCollapse = document.createElement('span');
    headingCollapse.className = 'collapse-indicator';
    headingCollapse.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    const generated = document.createElement('div');
    generated.className = 'mermaid';
    generated.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    const iframe = document.createElement('iframe');
    sizer.append(heading, headingCollapse, paragraph, repeatedParagraph, generated, iframe);
    preview.append(sizer);
    contentEl.append(preview);
    const commandPalette = document.createElement('div');
    commandPalette.className = 'prompt';
    document.body.append(contentEl, commandPalette);
    vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue(rect(20, 30, 300, 200));
    vi.spyOn(heading, 'getBoundingClientRect').mockReturnValue(rect(40, 50, 180, 30));
    vi.spyOn(paragraph, 'getBoundingClientRect').mockReturnValue(rect(40, 110, 220, 50));
    vi.spyOn(repeatedParagraph, 'getBoundingClientRect').mockReturnValue(rect(40, 165, 220, 30));

    const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      contentEl,
      file: { path: 'Notes/Test.md' },
      getMode: () => 'preview' as const,
    });
    const store = new MemorySnapshotFileStore();
    const repository = new SnapshotAnnotationRepository(store);
    const onRecordsChanged = vi.fn();
    const captureBackend: SnapshotCaptureBackend = {
      capture: (request) => {
        expect(commandPalette.style.display).toBe('none');
        expect(headingCollapse.style.display).toBe('none');
        expect(generated.style.display).not.toBe('none');
        return Promise.resolve({
          backendId: 'fake-capture',
          backendVersion: '1',
          captureGeneration: request.captureGeneration,
          capturedCssRect: request.viewportCssRect,
          mimeType: 'image/png',
          pixelHeight: 400,
          pixelRatio: 2,
          pixelWidth: 600,
          pngBytes: pngHeader(600, 400),
        });
      },
      describe: () => ({
        backendId: 'fake-capture',
        backendVersion: '1',
        contentClasses: ['reading-view-viewport'],
        platform: 'both',
        supportsCancellation: true,
      }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext());
    const manager = new ObsidianSnapshotAnnotationManager({
      app: {
        vault: {
          cachedRead: () => Promise.resolve('# Test\n\nVisible paragraph\n\nVisible paragraph'),
        },
        workspace: { getActiveViewOfType: () => view },
      },
      backendId: 'fake-capture',
      captureBackends: new SnapshotCaptureBackendRegistry([captureBackend]),
      createCaptureSubject: () => leaseSnapshotCaptureSubject({ kind: 'fake' }),
      createId: () => 'snapshot-a',
      deviceId: 'device-a',
      document,
      editor: new SnapshotAnnotationEditor({
        createObjectUrl: () => 'data:image/png;base64,fixture',
        document,
        revokeObjectUrl: () => undefined,
      }),
      now: () => '2026-07-22T05:00:00.000Z',
      onRecordsChanged,
      repository,
      textRepository: {
        getOrCreateNote: () =>
          Promise.resolve({
            filePath: 'Notes/Test.md',
            lastReconciledAt: '2026-07-22T05:00:00.000Z',
            noteId: 'note-a',
            pathHash: 'hash-a',
            schemaVersion: 1,
            sourceFingerprint: 'source-a',
          }),
      },
    });

    await manager.captureActiveReadingView();
    expect(commandPalette.style.display).toBe('');
    const canvas = document.querySelector<HTMLCanvasElement>('[data-inkstone-snapshot-canvas]');
    expect(canvas).not.toBeNull();
    expect(manager.activeSessionSnapshot()?.record.source).toMatchObject({
      coverage: [
        { displayText: 'Test', quote: { exact: '# Test' } },
        { quote: { exact: 'Visible paragraph' } },
        { quote: { exact: 'Visible paragraph' } },
      ],
      focus: { position: { start: 8 }, quote: { exact: 'Visible paragraph' } },
      headingPath: ['Test'],
    });
    vi.spyOn(canvas as HTMLCanvasElement, 'getBoundingClientRect').mockReturnValue(
      rect(100, 80, 300, 200),
    );
    dispatchPointer(canvas as HTMLCanvasElement, 'pointerdown', 125, 110, 1);
    dispatchPointer(canvas as HTMLCanvasElement, 'pointermove', 225, 210, 1);
    dispatchPointer(canvas as HTMLCanvasElement, 'pointerup', 225, 210, 1);
    document.querySelector<HTMLButtonElement>('[data-inkstone-ink-done]')?.click();

    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-snapshot-editor]')).toBeNull(),
    );
    expect(document.querySelector('.inkstone-snapshot-marker')).toBeNull();
    expect(onRecordsChanged).toHaveBeenCalledWith('Notes/Test.md');
    const reopened = await manager.reopenLatestForActiveFile();
    expect(reopened).toBe(true);
    const record = manager.activeSessionSnapshot()?.record;
    expect(record?.asset).toMatchObject({ logicalHeight: 200, logicalWidth: 300 });
    expect(record?.ink.strokes[0]?.points.at(0)).toEqual(expect.objectContaining({ x: 25, y: 30 }));
    expect(record?.ink.strokes[0]?.points.at(-1)).toEqual(
      expect.objectContaining({ x: 125, y: 130 }),
    );
    manager.dispose();
  });

  it('cancels the generation when Markdown source changes before capture acceptance', async () => {
    document.body.replaceChildren();
    const contentEl = document.createElement('div');
    const preview = document.createElement('div');
    preview.className = 'markdown-preview-view';
    const sizer = document.createElement('div');
    sizer.className = 'markdown-preview-sizer';
    const heading = document.createElement('h1');
    heading.textContent = 'Test';
    sizer.append(heading);
    preview.append(sizer);
    contentEl.append(preview);
    document.body.append(contentEl);
    vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue(rect(20, 30, 300, 200));
    vi.spyOn(heading, 'getBoundingClientRect').mockReturnValue(rect(40, 50, 180, 30));
    const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      contentEl,
      file: { path: 'Notes/Test.md' },
      getMode: () => 'preview' as const,
    });
    let source = '# Test';
    const backend: SnapshotCaptureBackend = {
      capture: (request) => {
        source = '# Test\n\nChanged during capture';
        return Promise.resolve({
          backendId: 'fake-capture',
          backendVersion: '1',
          captureGeneration: request.captureGeneration,
          capturedCssRect: request.viewportCssRect,
          mimeType: 'image/png',
          pixelHeight: 400,
          pixelRatio: 2,
          pixelWidth: 600,
          pngBytes: pngHeader(600, 400),
        });
      },
      describe: () => ({
        backendId: 'fake-capture',
        backendVersion: '1',
        contentClasses: ['reading-view-viewport'],
        platform: 'both',
        supportsCancellation: true,
      }),
    };
    const repository = new SnapshotAnnotationRepository(new MemorySnapshotFileStore());
    const manager = new ObsidianSnapshotAnnotationManager({
      app: {
        vault: { cachedRead: () => Promise.resolve(source) },
        workspace: { getActiveViewOfType: () => view },
      },
      backendId: 'fake-capture',
      captureBackends: new SnapshotCaptureBackendRegistry([backend]),
      createCaptureSubject: () => leaseSnapshotCaptureSubject({ kind: 'fake' }),
      document,
      editor: new SnapshotAnnotationEditor({ document }),
      repository,
      textRepository: { getOrCreateNote: () => Promise.resolve({ noteId: 'note-a' }) },
    });

    await expect(manager.captureActiveReadingView()).resolves.toBe(false);
    await expect(repository.listRecords('Notes/Test.md')).resolves.toEqual([]);
    expect(document.querySelector('[data-inkstone-snapshot-editor]')).toBeNull();
    manager.dispose();
  });
});

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

function dispatchPointer(
  target: HTMLCanvasElement,
  type: string,
  clientX: number,
  clientY: number,
  pointerId: number,
): void {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pressure: { value: 0.5 },
  });
  target.dispatchEvent(event);
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

function target() {
  return {
    position: { end: 4, start: 0, unit: 'utf16-code-unit' as const },
    quote: { exact: 'Test', prefix: '', suffix: '' },
    scope: { headingPath: ['Test'] },
    sourceRevision: 'source-a',
  };
}

function stroke(id: string) {
  return {
    brushRenderVersion: 'legacy-round-v1' as const,
    color: '#d97777',
    id,
    inputProfile: { pressure: 'legacy-unknown' as const, tilt: 'legacy-unknown' as const },
    points: [{ pressure: 0.5, time: 1, x: 10, y: 20 }],
    tool: 'pen' as const,
    width: 4,
  };
}

class MemorySnapshotFileStore implements SnapshotAnnotationFileStore {
  readonly coordinationScope = this;
  private readonly binary = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>();
  private readonly text = new Map<string, string>();

  list(directory: string): Promise<readonly string[]> {
    const prefix = `${directory}/`;
    const children = new Set<string>();
    for (const path of [...this.directories, ...this.binary.keys(), ...this.text.keys()]) {
      if (!path.startsWith(prefix)) continue;
      const child = path.slice(prefix.length).split('/')[0];
      if (child !== undefined && child.length > 0) children.add(child);
    }
    return Promise.resolve([...children].sort());
  }

  mkdir(path: string): Promise<void> {
    this.directories.add(path);
    return Promise.resolve();
  }

  read(path: string): Promise<string | null> {
    return Promise.resolve(this.text.get(path) ?? null);
  }

  readBinary(path: string): Promise<ArrayBuffer | null> {
    const value = this.binary.get(path);
    return Promise.resolve(value === undefined ? null : Uint8Array.from(value).buffer);
  }

  write(path: string, contents: string): Promise<void> {
    this.text.set(path, contents);
    return Promise.resolve();
  }

  writeBinary(path: string, contents: ArrayBuffer): Promise<void> {
    this.binary.set(path, new Uint8Array(contents.slice(0)));
    return Promise.resolve();
  }
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
