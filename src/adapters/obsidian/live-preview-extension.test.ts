// @vitest-environment jsdom

import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  PendingTextSelection,
  ResolveHighlightsResult,
} from '../../application/annotation-service';
import type { TextAnnotationRecord } from '../../domain/text-annotation';
import {
  LivePreviewAnnotationCoordinator,
  shouldResolveLivePreviewAnnotations,
} from './live-preview-extension';

describe('Live Preview extension', () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const view of views.splice(0)) view.destroy();
    document.body.replaceChildren();
  });

  it('renders canonical marks only in Live Preview and opens the shared inspector target', async () => {
    const service = new FakeAnnotationService([
      resolved(record('annotation-1', 6, 10, { kind: 'highlight', styleId: 'sun' })),
      resolved(record('note-1', 11, 15, undefined, 'A note')),
    ]);
    const hits: string[][] = [];
    const coordinator = new LivePreviewAnnotationCoordinator({
      contextForState: () => ({ filePath: 'Editor.md', livePreview: true }),
      onAnnotationHit: (ids) => hits.push([...ids]),
      resolveDelayMs: 0,
      service,
      styleColor: () => '#f0c94b',
    });
    const view = createView('Hello mark note', coordinator);

    await vi.waitFor(() =>
      expect(view.dom.querySelector('[data-inkstone-annotation-id="annotation-1"]')).not.toBeNull(),
    );
    expect(view.dom.querySelector('.inkstone-editor-note-anchor')).not.toBeNull();
    view.dom
      .querySelector<HTMLElement>('[data-inkstone-annotation-id="annotation-1"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(hits).toEqual([['annotation-1']]);
    expect(service.resolveCalls).toEqual([
      { filePath: 'Editor.md', persistChanges: false, source: 'Hello mark note' },
    ]);

    coordinator.dispose();
    expect(view.dom.querySelector('.inkstone-editor-highlight')).toBeNull();
  });

  it('does not resolve or render in source mode', async () => {
    const service = new FakeAnnotationService([
      resolved(record('annotation-1', 0, 5, { kind: 'highlight', styleId: 'sun' })),
    ]);
    const coordinator = new LivePreviewAnnotationCoordinator({
      contextForState: () => ({ filePath: 'Source.md', livePreview: false }),
      resolveDelayMs: 0,
      service,
    });
    const view = createView('Source mode', coordinator);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(service.resolveCalls).toEqual([]);
    expect(view.dom.querySelector('.inkstone-editor-highlight')).toBeNull();
  });

  it('refreshes on source/Live Preview switches without creating duplicate records', async () => {
    let livePreview = false;
    const service = new FakeAnnotationService([
      resolved(record('annotation-1', 0, 6, { kind: 'highlight', styleId: 'sun' })),
    ]);
    const coordinator = new LivePreviewAnnotationCoordinator({
      contextForState: () => ({ filePath: 'Switch.md', livePreview }),
      resolveDelayMs: 0,
      service,
    });
    const view = createView('Switch views', coordinator);
    await new Promise((resolve) => setTimeout(resolve, 10));

    livePreview = true;
    view.dispatch({});
    await vi.waitFor(() =>
      expect(view.dom.querySelector('.inkstone-editor-highlight')).not.toBeNull(),
    );
    livePreview = false;
    view.dispatch({});
    expect(view.dom.querySelector('.inkstone-editor-highlight')).toBeNull();
    livePreview = true;
    view.dispatch({});
    await vi.waitFor(() => expect(service.resolveCalls).toHaveLength(2));

    expect(service.committedMarks).toEqual([]);
  });

  it('maps transient decorations immediately, then recovers from canonical quote/context', async () => {
    const service = new FakeAnnotationService([
      resolved(record('stable', 6, 10, { kind: 'underline', styleId: 'mint' })),
    ]);
    const coordinator = new LivePreviewAnnotationCoordinator({
      contextForState: () => ({ filePath: 'Transactions.md', livePreview: true }),
      resolveDelayMs: 0,
      service,
    });
    const view = createView('Hello mark', coordinator);
    await vi.waitFor(() =>
      expect(view.dom.querySelector('.inkstone-editor-underline')).not.toBeNull(),
    );

    service.resolved = [resolved(record('stable', 9, 13, { kind: 'underline', styleId: 'mint' }))];
    view.dispatch({ changes: { from: 0, insert: 'Hi ' } });

    expect(view.dom.querySelector('.inkstone-editor-underline')?.textContent).toBe('mark');
    await vi.waitFor(() => expect(service.resolveCalls.at(-1)?.source).toBe('Hi Hello mark'));
    expect(view.dom.querySelectorAll('[data-inkstone-annotation-id="stable"]')).toHaveLength(1);
  });

  it('creates emoji and CJK selections through the canonical service without duplicate storage', async () => {
    const service = new FakeAnnotationService([]);
    const changed: string[] = [];
    const coordinator = new LivePreviewAnnotationCoordinator({
      contextForState: () => ({ filePath: 'Unicode.md', livePreview: true }),
      onAnnotationsChanged: (filePath) => {
        changed.push(filePath);
      },
      resolveDelayMs: 0,
      service,
    });
    const source = '前缀😀标注文本后缀';
    const view = createView(source, coordinator);
    const start = source.indexOf('😀');
    const end = start + '😀标注文本'.length;
    view.dispatch({ selection: { anchor: start, head: end } });
    view.focus();

    await expect(coordinator.commitSelection({ kind: 'highlight', styleId: 'sun' })).resolves.toBe(
      true,
    );

    expect(service.prepared).toEqual({
      filePath: 'Unicode.md',
      selection: {
        end,
        scope: { sectionEndLine: 0, sectionStartLine: 0 },
        start,
      },
      source,
    });
    expect(service.committedMarks).toEqual([{ kind: 'highlight', styleId: 'sun' }]);
    expect(changed).toEqual(['Unicode.md']);
  });

  it('reuses the floating selection toolbar in Live Preview', async () => {
    const service = new FakeAnnotationService([]);
    const coordinator = new LivePreviewAnnotationCoordinator({
      contextForState: () => ({ filePath: 'Toolbar.md', livePreview: true }),
      document,
      presets: [{ color: '#f0c94b', id: 'sun', name: 'Sun' }],
      resolveDelayMs: 0,
      service,
    });
    const view = createView('Select this text', coordinator);
    view.dispatch({ selection: { anchor: 0, head: 6 } });
    view.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    await vi.waitFor(() =>
      expect(document.querySelector('button[aria-label="Highlight: Sun"]')).not.toBeNull(),
    );
    document.querySelector<HTMLButtonElement>('button[aria-label="Highlight: Sun"]')?.click();

    await vi.waitFor(() =>
      expect(service.committedMarks).toEqual([{ kind: 'highlight', styleId: 'sun' }]),
    );
  });

  it('waits for keyboard selection to settle before moving focus into the toolbar', async () => {
    const service = new FakeAnnotationService([]);
    const coordinator = new LivePreviewAnnotationCoordinator({
      contextForState: () => ({ filePath: 'Keyboard.md', livePreview: true }),
      document,
      presets: [{ color: '#f0c94b', id: 'sun', name: 'Sun' }],
      resolveDelayMs: 0,
      service,
    });
    const view = createView('Select this text', coordinator);
    view.focus();
    view.dispatch({ selection: { anchor: 0, head: 1 } });
    view.contentDOM.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));

    expect(document.querySelector('[data-inkstone-quick-toolbar]')).toBeNull();
    expect(view.hasFocus).toBe(true);

    view.dispatch({ selection: { anchor: 0, head: 6 } });
    view.contentDOM.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));

    await vi.waitFor(() =>
      expect(document.querySelector('button[aria-label="Highlight: Sun"]')).not.toBeNull(),
    );
  });

  it('commits each distinct non-empty multi-selection exactly once', async () => {
    const service = new FakeAnnotationService([]);
    const coordinator = new LivePreviewAnnotationCoordinator({
      contextForState: () => ({ filePath: 'Multi.md', livePreview: true }),
      resolveDelayMs: 0,
      service,
    });
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'first and second',
        extensions: [EditorState.allowMultipleSelections.of(true), coordinator.extension],
        selection: EditorSelection.create([
          EditorSelection.range(0, 5),
          EditorSelection.range(10, 16),
        ]),
      }),
    });
    views.push(view);

    await expect(coordinator.commitSelection({ kind: 'underline', styleId: 'mint' })).resolves.toBe(
      true,
    );

    expect(service.committedMarks).toEqual([
      { kind: 'underline', styleId: 'mint' },
      { kind: 'underline', styleId: 'mint' },
    ]);
    expect(
      (service.preparedHistory as Array<{ selection: { start: number } }>).map(
        (input) => input.selection.start,
      ),
    ).toEqual([0, 10]);
  });

  it('handles a CJK/emoji paste transaction without out-of-bounds decorations', async () => {
    const service = new FakeAnnotationService([]);
    const coordinator = new LivePreviewAnnotationCoordinator({
      contextForState: () => ({ filePath: 'Paste.md', livePreview: true }),
      resolveDelayMs: 0,
      service,
    });
    const view = createView('prefix suffix', coordinator);
    const pasted = '粘贴😀\n第二行';
    service.resolved = [
      resolved(record('pasted', 7, 7 + pasted.length, { kind: 'highlight', styleId: 'sun' })),
    ];

    view.dispatch({ changes: { from: 7, insert: pasted } });

    await vi.waitFor(() =>
      expect(service.resolveCalls.at(-1)?.source).toBe(`prefix ${pasted}suffix`),
    );
    await vi.waitFor(() =>
      expect(view.dom.querySelector('[data-inkstone-annotation-id="pasted"]')).not.toBeNull(),
    );
  });

  it('defers canonical resolution while an IME composition is active', () => {
    expect(
      shouldResolveLivePreviewAnnotations({
        composing: true,
        documentChanged: true,
        livePreview: true,
        viewportChanged: false,
      }),
    ).toBe(false);
    expect(
      shouldResolveLivePreviewAnnotations({
        composing: false,
        documentChanged: true,
        livePreview: true,
        viewportChanged: false,
      }),
    ).toBe(true);
  });

  function createView(doc: string, coordinator: LivePreviewAnnotationCoordinator): EditorView {
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [coordinator.extension] }),
    });
    views.push(view);
    return view;
  }
});

class FakeAnnotationService {
  committedMarks: TextAnnotationRecord['mark'][] = [];
  prepared: unknown;
  preparedHistory: unknown[] = [];
  resolveCalls: Array<{ filePath: string; persistChanges?: boolean; source: string }> = [];

  constructor(public resolved: ResolveHighlightsResult['resolved']) {}

  resolveHighlights(input: {
    filePath: string;
    persistChanges?: boolean;
    source: string;
  }): Promise<ResolveHighlightsResult> {
    this.resolveCalls.push(input);
    return Promise.resolve({ issues: [], resolved: this.resolved, unanchored: [] });
  }

  prepareSelection(input: {
    filePath: string;
    selection: {
      end: number;
      scope: { sectionEndLine: number; sectionStartLine: number };
      start: number;
    };
    source: string;
  }): Promise<PendingTextSelection> {
    this.prepared = input;
    this.preparedHistory.push(input);
    return Promise.resolve({
      filePath: input.filePath,
      target: record('pending', input.selection.start, input.selection.end).target,
    });
  }

  commitMark(
    pending: PendingTextSelection,
    mark: NonNullable<TextAnnotationRecord['mark']>,
  ): Promise<TextAnnotationRecord> {
    this.committedMarks.push(mark);
    const created = {
      ...record('created', pending.target.position.start, pending.target.position.end, mark),
      target: pending.target,
    };
    this.resolved = [resolved(created)];
    return Promise.resolve(created);
  }

  beginNoteDraft(pending: PendingTextSelection): Promise<TextAnnotationRecord> {
    return Promise.resolve({
      ...record('draft', pending.target.position.start, pending.target.position.end),
      status: 'draft',
      target: pending.target,
    });
  }
}

function resolved(record: TextAnnotationRecord): ResolveHighlightsResult['resolved'][number] {
  return { end: record.target.position.end, record, start: record.target.position.start };
}

function record(
  id: string,
  start: number,
  end: number,
  mark?: TextAnnotationRecord['mark'],
  body?: string,
): TextAnnotationRecord {
  return {
    ...(body === undefined ? {} : { body }),
    createdAt: '2026-07-14T00:00:00.000Z',
    filePath: 'Editor.md',
    id,
    ...(mark === undefined ? {} : { mark }),
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    tags: [],
    target: {
      position: { end, start, unit: 'utf16-code-unit' },
      quote: { exact: 'x'.repeat(Math.max(1, end - start)), prefix: '', suffix: '' },
      scope: {},
    },
    updatedAt: '2026-07-14T00:00:00.000Z',
  };
}
