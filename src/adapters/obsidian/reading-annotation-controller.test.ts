// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { AnnotationService } from '../../application/annotation-service';
import { SidecarRepository, type TextFileStore } from '../../storage/sidecar-repository';
import { ReadingAnnotationController } from './reading-annotation-controller';

describe('Reading annotation controller', () => {
  it('maps a Range, commits one highlight, persists it and renders before collapsing selection', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => '2026-07-14T08:00:00.000Z',
      repository,
    });
    const root = document.createElement('section');
    root.innerHTML = '<p>Mutable Markdown needs resilient anchors.</p>';
    document.body.append(root);
    const block = root.querySelector('p');
    const textNode = block?.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error('Fixture did not create a paragraph text node.');
    }
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 'Mutable Markdown'.length);
    let collapsed = false;
    const controller = new ReadingAnnotationController({
      collapseSelection: () => {
        collapsed = true;
      },
      document,
      service,
    });

    const prepared = await controller.showForRange({
      anchorRect: new DOMRect(40, 80, 120, 20),
      filePath: 'Walking Skeleton.md',
      fullSource: 'Mutable Markdown needs resilient anchors.',
      range,
      readingRoot: root,
      scope: { sectionEndLine: 1, sectionStartLine: 1 },
      sectionSource: 'Mutable Markdown needs resilient anchors.',
      sectionSourceStart: 0,
    });

    expect(prepared).toEqual({ supported: true });
    document.querySelector<HTMLButtonElement>('button[aria-label="Highlight: Sun"]')?.click();
    await vi.waitFor(() => expect(collapsed).toBe(true));

    expect(root.querySelector('.inkstone-text-highlight')?.textContent).toBe('Mutable Markdown');
    const reloaded = await new AnnotationService({
      repository: new SidecarRepository(store),
    }).resolveHighlights({
      filePath: 'Walking Skeleton.md',
      source: 'Mutable Markdown needs resilient anchors.',
    });
    expect(reloaded.resolved).toHaveLength(1);
  });

  it('persists visible text separately when a selection spans presentation markers', async () => {
    const source =
      'This paragraph contains **bold text**, _italic text_, ==highlighted text==, and ~~struck text~~.';
    const rendered =
      'This paragraph contains bold text, italic text, highlighted text, and struck text.';
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const controller = new ReadingAnnotationController({
      collapseSelection: () => undefined,
      document,
      service: new AnnotationService({
        createId: () => ids.shift() ?? 'unexpected-id',
        repository,
      }),
    });
    const root = document.createElement('section');
    root.innerHTML =
      '<p>This paragraph contains <strong>bold text</strong>, <em>italic text</em>, <mark>highlighted text</mark>, and <del>struck text</del>.</p>';
    document.body.append(root);
    const paragraph = root.querySelector('p');
    const first = paragraph?.firstChild;
    const last = paragraph?.lastChild;
    if (!(first instanceof Text) || !(last instanceof Text)) {
      throw new Error('Formatted paragraph fixture is malformed.');
    }
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.data.length);

    await expect(
      controller.showForRange({
        anchorRect: new DOMRect(40, 80, 120, 20),
        filePath: 'Formatted.md',
        fullSource: source,
        range,
        readingRoot: root,
        scope: { sectionEndLine: 0, sectionStartLine: 0 },
        sectionSource: source,
        sectionSourceStart: 0,
      }),
    ).resolves.toEqual({ supported: true });

    document.querySelector<HTMLButtonElement>('button[aria-label="Highlight: Sun"]')?.click();
    await vi.waitFor(async () => {
      const [record] = (await repository.listAnnotations('Formatted.md')).records;
      expect(record).toMatchObject({
        target: { displayText: rendered, quote: { exact: source } },
      });
    });
    expect(
      [...root.querySelectorAll<HTMLElement>('.inkstone-text-highlight')]
        .map((element) => element.textContent)
        .join(''),
    ).toBe(rendered);
  });

  it('commits underline with the recent style and renders underline semantics', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const { range, root } = selectionFixture();
    const controller = new ReadingAnnotationController({
      collapseSelection: () => undefined,
      document,
      presets: [{ color: '#ac92e8', id: 'highlight-violet', name: 'Violet' }],
      service,
    });
    await showFixture(controller, range, root);

    document.querySelector<HTMLButtonElement>('button[aria-label="Underline"]')?.click();
    await vi.waitFor(() =>
      expect(root.querySelector('.inkstone-text-highlight--underline-only')).not.toBeNull(),
    );
    const loaded = await repository.listAnnotations('Walking Skeleton.md');
    expect(loaded.records[0]?.mark).toEqual({
      kind: 'underline',
      styleId: 'highlight-violet',
    });
  });

  it('persists a target draft before handing focus to the note composer', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'draft-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const { range, root } = selectionFixture();
    let handedOffDraftId: string | null = null;
    const controller = new ReadingAnnotationController({
      collapseSelection: () => undefined,
      document,
      onNoteDraft: async (draft) => {
        await expect(repository.readAnnotation('Walking Skeleton.md', draft.id)).resolves.toEqual(
          draft,
        );
        handedOffDraftId = draft.id;
      },
      service,
    });
    await showFixture(controller, range, root);

    document.querySelector<HTMLButtonElement>('button[aria-label="Add note"]')?.click();
    await vi.waitFor(() => expect(handedOffDraftId).toBe('draft-1'));
  });

  it('creates a highlight and opens its inspector from the details action', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'details-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const { range, root } = selectionFixture();
    const opened: Array<{ id: string; invoker: HTMLElement }> = [];
    const controller = new ReadingAnnotationController({
      collapseSelection: () => undefined,
      document,
      onOpenDetails: (record, invoker) => {
        opened.push({ id: record.id, invoker });
      },
      service,
    });
    await showFixture(controller, range, root);

    document
      .querySelector<HTMLButtonElement>('button[aria-label="Open annotation details"]')
      ?.click();

    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toEqual({ id: 'details-1', invoker: root.querySelector('p') });
    expect(root.querySelector('.inkstone-text-highlight')?.textContent).toBe('Mutable Markdown');
    await expect(
      repository.readAnnotation('Walking Skeleton.md', 'details-1'),
    ).resolves.toMatchObject({
      mark: { kind: 'highlight', styleId: 'highlight-sun' },
    });
  });

  it('returns focus to the reading block when Escape dismisses the toolbar', async () => {
    const store = new MemoryTextFileStore();
    const { range, root } = selectionFixture();
    const controller = new ReadingAnnotationController({
      collapseSelection: () => undefined,
      document,
      service: new AnnotationService({ repository: new SidecarRepository(store) }),
    });
    await showFixture(controller, range, root);
    const toolbar = document.querySelector<HTMLElement>('[data-inkstone-quick-toolbar]');

    toolbar?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    expect(document.activeElement).toBe(root.querySelector('p'));
    expect(document.querySelector('[data-inkstone-quick-toolbar]')).toBeNull();
  });

  it('clears the native selection when an outside tap dismisses the mobile action bar', async () => {
    const store = new MemoryTextFileStore();
    const { range, root } = selectionFixture();
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    const controller = new ReadingAnnotationController({
      collapseSelection: () => document.getSelection()?.removeAllRanges(),
      document,
      service: new AnnotationService({ repository: new SidecarRepository(store) }),
      toolbarLayout: 'mobile-action-bar',
    });
    await showFixture(controller, range, root);
    expect(document.getSelection()?.toString()).toBe('Mutable Markdown');

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));

    expect(document.querySelector('[data-inkstone-quick-toolbar]')).toBeNull();
    expect(document.getSelection()?.rangeCount).toBe(0);
  });

  it('keeps the mobile selection active while a native selection handle is dragged', async () => {
    const store = new MemoryTextFileStore();
    const { range, root } = selectionFixture();
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    const collapseSelection = vi.fn(() => document.getSelection()?.removeAllRanges());
    const controller = new ReadingAnnotationController({
      collapseSelection,
      document,
      service: new AnnotationService({ repository: new SidecarRepository(store) }),
      toolbarLayout: 'mobile-action-bar',
    });
    await showFixture(controller, range, root);

    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20, pointerId: 4 }),
    );
    document.body.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 44, clientY: 20, pointerId: 4 }),
    );
    document.body.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, clientX: 44, clientY: 20, pointerId: 4 }),
    );

    expect(collapseSelection).not.toHaveBeenCalled();
    expect(document.getSelection()?.toString()).toBe('Mutable Markdown');
    expect(document.querySelector('[data-inkstone-quick-toolbar]')).not.toBeNull();
    controller.dispose();
    document.getSelection()?.removeAllRanges();
  });

  it('persists and renders a simple cross-paragraph selection as block-local fragments', async () => {
    const source = 'First paragraph.\n\nSecond paragraph.';
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const controller = new ReadingAnnotationController({
      collapseSelection: () => undefined,
      document,
      service: new AnnotationService({
        createId: () => ids.shift() ?? 'unexpected-id',
        repository,
      }),
    });
    const root = document.createElement('section');
    root.innerHTML = '<p>First paragraph.</p><p>Second paragraph.</p>';
    document.body.append(root);
    const blocks = root.querySelectorAll('p');
    const first = blocks[0]?.firstChild;
    const second = blocks[1]?.firstChild;
    if (!(first instanceof Text) || !(second instanceof Text)) {
      throw new Error('Cross-paragraph fixture is missing text nodes.');
    }
    const range = document.createRange();
    range.setStart(first, 'First '.length);
    range.setEnd(second, 'Second'.length);

    const prepared = await controller.showForRange({
      anchorRect: new DOMRect(40, 80, 120, 20),
      filePath: 'Cross block.md',
      fullSource: source,
      range,
      readingRoot: root,
      scope: { sectionEndLine: 2, sectionStartLine: 0 },
      sectionSource: source,
      sectionSourceStart: 0,
    });
    expect(prepared).toEqual({ supported: true });

    document.querySelector<HTMLButtonElement>('button[aria-label="Highlight: Sun"]')?.click();
    await vi.waitFor(() =>
      expect(root.querySelectorAll('.inkstone-text-highlight')).toHaveLength(2),
    );

    expect(
      [...root.querySelectorAll<HTMLElement>('.inkstone-text-highlight')].map(
        (element) => element.textContent,
      ),
    ).toEqual(['paragraph.', 'Second']);
    const [record] = (await repository.listAnnotations('Cross block.md')).records;
    expect(record?.target.quote.exact).toBe('paragraph.\n\nSecond');
  });
});

function selectionFixture(): { range: Range; root: HTMLElement } {
  const root = document.createElement('section');
  root.innerHTML = '<p>Mutable Markdown needs resilient anchors.</p>';
  document.body.append(root);
  const textNode = root.querySelector('p')?.firstChild;
  if (!(textNode instanceof Text)) {
    throw new Error('Fixture did not create a paragraph text node.');
  }
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, 'Mutable Markdown'.length);
  return { range, root };
}

function showFixture(
  controller: ReadingAnnotationController,
  range: Range,
  root: HTMLElement,
): Promise<unknown> {
  return controller.showForRange({
    anchorRect: new DOMRect(40, 80, 120, 20),
    filePath: 'Walking Skeleton.md',
    fullSource: 'Mutable Markdown needs resilient anchors.',
    range,
    readingRoot: root,
    scope: { sectionEndLine: 1, sectionStartLine: 1 },
    sectionSource: 'Mutable Markdown needs resilient anchors.',
    sectionSourceStart: 0,
  });
}

class MemoryTextFileStore implements TextFileStore {
  private readonly files = new Map<string, string>();

  list(directory: string): Promise<readonly string[]> {
    const prefix = `${directory}/`;
    return Promise.resolve(
      [...this.files.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map((path) => path.slice(prefix.length))
        .sort(),
    );
  }

  mkdir(): Promise<void> {
    return Promise.resolve();
  }

  read(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }

  write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
    return Promise.resolve();
  }
}
