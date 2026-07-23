// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  AnnotationService,
  type ResolveHighlightsResult,
} from '../../application/annotation-service';
import { SidecarRepository, type TextFileStore } from '../../storage/sidecar-repository';
import { AnnotationInspector } from '../../ui/annotation-inspector';
import {
  ReadingViewIntegration,
  sourceOffsetAtLine,
  sourceOffsetForSection,
  type ReadingSectionInfo,
} from './reading-view-integration';

describe('Reading View integration', () => {
  it('converts zero-based Obsidian line numbers to UTF-16 source offsets', () => {
    expect(sourceOffsetAtLine('# Heading\n\nMutable Markdown\n', 2)).toBe(11);
    expect(sourceOffsetAtLine('emoji 😀\r\nsecond', 1)).toBe(10);
  });

  it('validates section text instead of trusting an inconsistent Obsidian lineStart', () => {
    const source = '# Heading\n\nMutable Markdown';

    expect(sourceOffsetForSection(source, { lineEnd: 2, lineStart: 2, text: source })).toBe(0);
    expect(
      sourceOffsetForSection(source, {
        lineEnd: 2,
        lineStart: 2,
        text: 'Mutable Markdown',
      }),
    ).toBe(11);
  });

  it('persists a selected section, restores it after reload, and cleans its DOM on unload', async () => {
    const source = '# Heading\n\nMutable **Markdown** remains readable.';
    const sectionText = 'Mutable **Markdown** remains readable.';
    const store = new MemoryTextFileStore();
    const ids = ['note-1', 'annotation-1'];
    const integration = createIntegration(store, () => ids.shift() ?? 'unexpected-id');
    const firstRoot = createSection();
    const firstBlock = firstRoot.querySelector('p');
    const strongText = firstRoot.querySelector('strong')?.firstChild;
    if (!(firstBlock instanceof HTMLElement) || !(strongText instanceof Text)) {
      throw new Error('Fixture did not create the expected rendered paragraph.');
    }
    const sectionInfo = (): ReadingSectionInfo => ({ lineEnd: 2, lineStart: 2, text: sectionText });
    const cleanup = await integration.mountSection({
      filePath: 'Notes/Walking Skeleton.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: sectionInfo,
      root: firstRoot,
    });
    const range = document.createRange();
    range.setStart(strongText, 0);
    range.setEnd(strongText, 'Markdown'.length);
    document.getSelection()?.addRange(range);

    firstBlock.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('button[aria-label="Highlight: Sun"]')).not.toBeNull(),
    );
    document.querySelector<HTMLButtonElement>('button[aria-label="Highlight: Sun"]')?.click();
    await vi.waitFor(() =>
      expect(firstRoot.querySelector('.inkstone-text-highlight')?.textContent).toBe('Markdown'),
    );
    expect(document.getSelection()?.rangeCount).toBe(0);

    cleanup();
    expect(firstRoot.querySelector('.inkstone-text-highlight')).toBeNull();
    expect(firstRoot.innerHTML).toBe('<p>Mutable <strong>Markdown</strong> remains readable.</p>');

    const reloadedIntegration = createIntegration(store);
    const reloadedRoot = createSection();
    await reloadedIntegration.mountSection({
      filePath: 'Notes/Walking Skeleton.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: sectionInfo,
      root: reloadedRoot,
    });

    expect(reloadedRoot.querySelector('.inkstone-text-highlight')?.textContent).toBe('Markdown');
    reloadedIntegration.dispose();
    expect(reloadedRoot.querySelector('.inkstone-text-highlight')).toBeNull();
  });

  it('restores one source span across ordinary presentation markers', async () => {
    const source =
      'This paragraph contains **bold text**, _italic text_, ==highlighted text==, and ~~struck text~~.';
    const rendered =
      'This paragraph contains bold text, italic text, highlighted text, and struck text.';
    const store = new MemoryTextFileStore();
    const service = new AnnotationService({
      createId: (() => {
        const ids = ['note-formatted', 'annotation-formatted'];
        return () => ids.shift() ?? 'unexpected-id';
      })(),
      repository: new SidecarRepository(store),
    });
    await service.createHighlight({
      filePath: 'Formatted restore.md',
      selection: {
        displayText: rendered,
        end: source.length,
        scope: { sectionEndLine: 0, sectionStartLine: 0 },
        start: 0,
      },
      source,
      styleId: 'highlight-sun',
    });
    const root = document.createElement('section');
    root.innerHTML =
      '<p>This paragraph contains <strong>bold text</strong>, <em>italic text</em>, <mark>highlighted text</mark>, and <del>struck text</del>.</p>';
    const integration = new ReadingViewIntegration({ document, service });

    await integration.mountSection({
      filePath: 'Formatted restore.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: source }),
      root,
    });

    expect(
      [...root.querySelectorAll<HTMLElement>('.inkstone-text-highlight')]
        .map((element) => element.textContent)
        .join(''),
    ).toBe(rendered);
    integration.dispose();
  });

  it('renders source-backed text after an embed without counting generated embed text', async () => {
    const source = 'before ![[Embedded note]] after';
    const exact = 'after';
    const start = source.indexOf(exact);
    const service = new AnnotationService({
      createId: (() => {
        const ids = ['note-embed', 'annotation-after-embed'];
        return () => ids.shift() ?? 'unexpected-id';
      })(),
      repository: new SidecarRepository(new MemoryTextFileStore()),
    });
    await service.createHighlight({
      filePath: 'Embed restore.md',
      selection: {
        displayText: exact,
        end: start + exact.length,
        scope: { sectionEndLine: 0, sectionStartLine: 0 },
        start,
      },
      source,
      styleId: 'highlight-sun',
    });
    const root = document.createElement('section');
    root.innerHTML =
      '<p>before <span class="internal-embed">generated preview text</span> after</p>';
    const integration = new ReadingViewIntegration({ document, service });

    await integration.mountSection({
      filePath: 'Embed restore.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: source }),
      root,
    });

    expect(root.querySelector('.inkstone-text-highlight')?.textContent).toBe(exact);
    expect(root.querySelector('.internal-embed .inkstone-text-highlight')).toBeNull();
    integration.dispose();
  });

  it('fails stale-context when the source revision changes during cold projection preparation', async () => {
    let source = 'Initial source.';
    const onIssue = vi.fn();
    const service = new AnnotationService({
      repository: new SidecarRepository(new MemoryTextFileStore()),
    });
    const root = document.createElement('p');
    root.textContent = source;
    document.body.append(root);
    const integration = new ReadingViewIntegration({ document, onIssue, service });
    await integration.mountSection({
      filePath: 'Stale.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: source }),
      root,
    });

    source = 'Changed source.';
    root.textContent = source;
    const text = root.firstChild;
    if (!(text instanceof Text)) throw new Error('Stale fixture is missing text.');
    const range = document.createRange();
    range.selectNodeContents(text);
    document.getSelection()?.addRange(range);
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    source = 'Changed again.';

    await vi.waitFor(() =>
      expect(document.querySelector('.inkstone-quick-toolbar__reason')?.textContent).toContain(
        'changed',
      ),
    );
    expect(onIssue.mock.calls[0]?.[0]).toMatchObject({ code: 'stale-context' });
    expect(document.querySelector('button[aria-label="Highlight: Sun"]')).toBeNull();
    integration.dispose();
    document.getSelection()?.removeAllRanges();
  });

  it('restores a highlight in the second item of a tight list', async () => {
    const source = '- first\n- second\n- third';
    const store = new MemoryTextFileStore();
    const service = new AnnotationService({
      createId: (() => {
        const ids = ['note-list', 'annotation-list'];
        return () => ids.shift() ?? 'unexpected-id';
      })(),
      repository: new SidecarRepository(store),
    });
    const start = source.indexOf('second');
    await service.createHighlight({
      filePath: 'Tight list.md',
      selection: {
        end: start + 'second'.length,
        scope: { sectionEndLine: 2, sectionStartLine: 0 },
        start,
      },
      source,
      styleId: 'highlight-sun',
    });
    const root = document.createElement('section');
    root.innerHTML = '<ul><li>first</li><li>second</li><li>third</li></ul>';
    const integration = new ReadingViewIntegration({ document, service });

    await integration.mountSection({
      filePath: 'Tight list.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 2, lineStart: 0, text: source }),
      root,
    });

    expect(
      root.querySelectorAll('li')[1]?.querySelector('.inkstone-text-highlight')?.textContent,
    ).toBe('second');
    integration.dispose();
  });

  it('releases rendered sections that Obsidian virtualizes out of the DOM', async () => {
    vi.useFakeTimers();
    try {
      const source = 'Virtualized paragraph.';
      const integration = createIntegration(new MemoryTextFileStore());
      const root = createSection();
      document.body.append(root);
      let resolveSource: ((source: string) => void) | undefined;
      const sourcePending = new Promise<string>((resolve) => {
        resolveSource = resolve;
      });
      const mounted = integration.mountSection({
        filePath: 'Long.md',
        getFullSource: () => sourcePending,
        getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: source }),
        root,
      });
      root.remove();
      resolveSource?.(source);
      await mounted;
      await vi.advanceTimersByTimeAsync(15_000);

      expect(mountedSectionCount(integration)).toBe(0);
      integration.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the toolbar after Obsidian moves a block out of its postprocessor root', async () => {
    const source = 'Virtualized paragraph remains selectable.';
    const integration = createIntegration(new MemoryTextFileStore());
    const readingView = document.createElement('div');
    readingView.className = 'markdown-reading-view';
    const originalRoot = document.createElement('section');
    originalRoot.innerHTML = `<p>${source}</p>`;
    readingView.append(originalRoot);
    document.body.append(readingView);
    await integration.mountSection({
      filePath: 'Long.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: source }),
      root: originalRoot,
    });
    const movedRoot = document.createElement('section');
    const paragraph = originalRoot.querySelector('p');
    if (paragraph === null || paragraph.firstChild === null) throw new Error('Missing paragraph.');
    movedRoot.append(paragraph);
    originalRoot.remove();
    readingView.append(movedRoot);
    const range = document.createRange();
    range.setStart(paragraph.firstChild, 0);
    range.setEnd(paragraph.firstChild, 'Virtualized'.length);
    document.getSelection()?.addRange(range);

    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    await vi.waitFor(() =>
      expect(document.querySelector('button[aria-label="Highlight: Sun"]')).not.toBeNull(),
    );
    integration.dispose();
    document.getSelection()?.removeAllRanges();
    readingView.remove();
  });

  it('restores highlights after Obsidian replaces and unloads one postprocessor root', async () => {
    const source = 'First paragraph.\n\nSecond paragraph.';
    const store = new MemoryTextFileStore();
    const service = new AnnotationService({
      repository: new SidecarRepository(store),
    });
    await service.createHighlight({
      filePath: 'Replaced sections.md',
      selection: {
        end: 'First paragraph.'.length,
        scope: { sectionEndLine: 0, sectionStartLine: 0 },
        start: 0,
      },
      source,
      styleId: 'highlight-sun',
    });
    const integration = new ReadingViewIntegration({ document, service });
    const readingView = document.createElement('div');
    readingView.className = 'markdown-reading-view';
    const firstRoot = document.createElement('section');
    const secondRoot = document.createElement('section');
    firstRoot.innerHTML = '<p>First paragraph.</p>';
    secondRoot.innerHTML = '<p>Second paragraph.</p>';
    readingView.append(firstRoot, secondRoot);
    document.body.append(readingView);
    const getSectionInfo = (element: HTMLElement): ReadingSectionInfo =>
      element.textContent.includes('First paragraph.')
        ? { lineEnd: 0, lineStart: 0, text: 'First paragraph.' }
        : { lineEnd: 2, lineStart: 2, text: 'Second paragraph.' };
    const cleanupFirst = await integration.mountSection({
      filePath: 'Replaced sections.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo,
      root: firstRoot,
    });
    const cleanupSecond = await integration.mountSection({
      filePath: 'Replaced sections.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo,
      root: secondRoot,
    });
    const replacement = document.createElement('section');
    replacement.innerHTML = '<p>First paragraph.</p>';
    firstRoot.replaceWith(replacement);
    cleanupFirst();

    await vi.waitFor(() =>
      expect(replacement.querySelector('.inkstone-text-highlight')?.textContent).toBe(
        'First paragraph.',
      ),
    );

    cleanupSecond();
    integration.dispose();
    readingView.remove();
  });

  it('ignores selections while Reading View remounts after an edit instead of using a cleaned source context', async () => {
    const beforeSource = 'Before edit.';
    const afterSource = 'After edit.';
    const issues: unknown[] = [];
    const integration = new ReadingViewIntegration({
      document,
      onIssue: (issue) => issues.push(issue),
      service: new AnnotationService({
        repository: new SidecarRepository(new MemoryTextFileStore()),
      }),
    });
    const readingView = document.createElement('div');
    readingView.className = 'markdown-reading-view';
    const before = document.createElement('section');
    before.innerHTML = `<p>${beforeSource}</p>`;
    readingView.append(before);
    document.body.append(readingView);
    const cleanupBefore = await integration.mountSection({
      filePath: 'Edited.md',
      getFullSource: () => Promise.resolve(beforeSource),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: beforeSource }),
      root: before,
    });
    cleanupBefore();
    before.remove();

    const after = document.createElement('section');
    after.innerHTML = `<p>${afterSource}</p>`;
    readingView.append(after);
    const paragraph = after.querySelector('p');
    const text = paragraph?.firstChild;
    if (!(paragraph instanceof HTMLElement) || !(text instanceof Text)) {
      throw new Error('Edited Reading View fixture is missing text.');
    }
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 'After'.length);
    document.getSelection()?.addRange(range);

    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(issues).toEqual([]);
    expect(document.querySelector('[data-inkstone-quick-toolbar]')).toBeNull();

    await integration.mountSection({
      filePath: 'Edited.md',
      getFullSource: () => Promise.resolve(afterSource),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: afterSource }),
      root: after,
    });
    paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('button[aria-label="Highlight: Sun"]')).not.toBeNull(),
    );

    document.getSelection()?.removeAllRanges();
    integration.dispose();
    readingView.remove();
  });

  it('skips block source mapping when the file has no text annotations', async () => {
    const source = 'Unannotated long-document block.';
    const integration = createIntegration(new MemoryTextFileStore());
    const root = createSection();
    const getSectionInfo = vi.fn(() => ({ lineEnd: 0, lineStart: 0, text: source }));

    await integration.mountSection({
      filePath: 'Unannotated.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo,
      root,
    });

    expect(getSectionInfo).not.toHaveBeenCalled();
    integration.dispose();
  });

  it('opens Add note in the shared inspector after persisting its draft target', async () => {
    const source = 'A note target in reading view.';
    const store = new MemoryTextFileStore();
    const ids = ['note-1', 'draft-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository: new SidecarRepository(store),
    });
    const inspector = new AnnotationInspector({
      document,
      onDelete: (record) => Promise.resolve(record),
      onDiscard: (record) => service.discardEmptyDraft(record),
      onNavigate: () => undefined,
      onSave: (record, changes) =>
        service.updateAnnotationContents(record.filePath, record.id, changes),
      onUndo: (record) => Promise.resolve(record),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: () => Promise.resolve(),
    });
    const integration = new ReadingViewIntegration({
      document,
      isMobile: true,
      onNoteDraft: (draft, target) => {
        inspector.show({
          anchorRect: target.anchorRect,
          initialFocus: 'note',
          invoker: target.block,
          records: [draft],
        });
      },
      service,
    });
    const root = document.createElement('p');
    root.textContent = source;
    document.body.append(root);
    await integration.mountSection({
      filePath: 'Composer Integration.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: source }),
      root,
    });
    const text = root.firstChild;
    if (!(text instanceof Text)) {
      throw new Error('Fixture did not create text.');
    }
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 13);
    document.getSelection()?.addRange(range);
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('button[aria-label="Add note"]')).not.toBeNull(),
    );
    expect(
      document
        .querySelector('[data-inkstone-quick-toolbar]')
        ?.classList.contains('inkstone-quick-toolbar--mobile-action-bar'),
    ).toBe(true);

    document.querySelector<HTMLButtonElement>('button[aria-label="Add note"]')?.click();

    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-annotation-inspector]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-inkstone-note-composer]')).toBeNull();
    const loaded = await new SidecarRepository(store).listAnnotations('Composer Integration.md');
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0]).toMatchObject({ id: 'draft-1', status: 'draft' });
    expect(
      document
        .querySelector<HTMLButtonElement>('[data-inkstone-mark-type="note"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-inkstone-annotation-inspector] textarea[aria-label="Note"]',
    );
    expect(document.activeElement).toBe(textarea);

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-annotation-inspector]')).toBeNull(),
    );
    expect(
      (await new SidecarRepository(store).listAnnotations('Composer Integration.md')).records,
    ).toHaveLength(0);
    integration.dispose();
  });

  it('applies the last highlight command to the current Reading View selection', async () => {
    const source = 'Command selection target.';
    const store = new MemoryTextFileStore();
    const ids = ['note-1', 'annotation-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository: new SidecarRepository(store),
    });
    const integration = new ReadingViewIntegration({ document, service });
    const root = document.createElement('p');
    root.textContent = source;
    document.body.append(root);
    await integration.mountSection({
      filePath: 'Commands.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: source }),
      root,
    });
    const text = root.firstChild;
    if (!(text instanceof Text)) {
      throw new Error('Fixture did not create text.');
    }
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 'Command selection'.length);
    document.getSelection()?.addRange(range);

    await expect(integration.applyLastHighlightToCurrentSelection()).resolves.toBe(true);

    expect(root.querySelector('.inkstone-text-highlight')?.textContent).toBe('Command selection');
    const loaded = await new SidecarRepository(store).listAnnotations('Commands.md');
    expect(loaded.records[0]?.mark).toEqual({ kind: 'highlight', styleId: 'highlight-sun' });
    integration.dispose();
  });

  it('captures a replacement target for repair without opening the creation toolbar or writing', async () => {
    const source = 'Choose this replacement target.';
    const store = new MemoryTextFileStore();
    const service = new AnnotationService({ repository: new SidecarRepository(store) });
    const integration = new ReadingViewIntegration({ document, service });
    const root = document.createElement('p');
    root.textContent = source;
    document.body.append(root);
    await integration.mountSection({
      filePath: 'Repair Capture.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: source }),
      root,
    });
    const text = root.firstChild;
    if (!(text instanceof Text)) {
      throw new Error('Fixture did not create text.');
    }
    const range = document.createRange();
    range.setStart(text, 12);
    range.setEnd(text, 30);
    document.getSelection()?.addRange(range);

    const pending = await integration.captureCurrentSelection();

    expect(pending?.target.quote.exact).toBe('replacement target');
    expect(document.querySelector('[data-inkstone-quick-toolbar]')).toBeNull();
    await expect(service.listCurrentFile('Repair Capture.md')).resolves.toMatchObject({
      model: { total: 0 },
    });
    document.getSelection()?.removeAllRanges();
    integration.dispose();
  });

  it('refreshes rendered colors after a preset rename/recolor without rewriting the record', async () => {
    const source = 'Custom style target.';
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const record = await service.createHighlight({
      filePath: 'Custom Style.md',
      selection: { end: 12, scope: {}, start: 0 },
      source,
      styleId: 'stable-style',
    });
    const integration = new ReadingViewIntegration({
      document,
      presets: [{ color: '#1264a3', id: 'stable-style', name: 'Focus' }],
      service,
    });
    const root = document.createElement('p');
    root.textContent = source;
    await integration.mountSection({
      filePath: 'Custom Style.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: source }),
      root,
    });
    expect(
      root
        .querySelector<HTMLElement>('.inkstone-text-highlight')
        ?.style.getPropertyValue('--text-highlight-bg'),
    ).toBe('#1264a3');

    await integration.setPresets([{ color: '#a35a12', id: 'stable-style', name: 'Priority' }]);

    expect(
      root
        .querySelector<HTMLElement>('.inkstone-text-highlight')
        ?.style.getPropertyValue('--text-highlight-bg'),
    ).toBe('#a35a12');
    await expect(repository.readAnnotation('Custom Style.md', record.id)).resolves.toEqual(record);
    integration.dispose();
  });

  it('keeps a deleted mark cleared when an older Reading View refresh resolves last', async () => {
    const source = 'Refresh race target.';
    const filePath = 'Refresh Race.md';
    const store = new MemoryTextFileStore();
    const service = new AnnotationService({
      createId: () => 'annotation-race',
      repository: new SidecarRepository(store),
    });
    const record = await service.createHighlight({
      filePath,
      selection: { end: 'Refresh'.length, scope: {}, start: 0 },
      source,
      styleId: 'highlight-sun',
    });
    const integration = new ReadingViewIntegration({ document, service });
    const root = document.createElement('p');
    root.textContent = source;
    await integration.mountSection({
      filePath,
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: source }),
      root,
    });
    expect(root.querySelector('.inkstone-text-highlight')?.textContent).toBe('Refresh');

    const staleResult = await service.resolveHighlights({ filePath, source });
    await service.deleteAnnotation(filePath, record.id);
    const freshResult = await service.resolveHighlights({ filePath, source });
    let releaseStaleResult: ((result: ResolveHighlightsResult) => void) | undefined;
    const delayedStaleResult = new Promise<ResolveHighlightsResult>((resolve) => {
      releaseStaleResult = resolve;
    });
    const resolveHighlights = vi
      .spyOn(service, 'resolveHighlights')
      .mockReturnValueOnce(delayedStaleResult)
      .mockResolvedValueOnce(freshResult);

    const olderRefresh = integration.refreshAnnotations(filePath);
    await vi.waitFor(() => expect(resolveHighlights).toHaveBeenCalledTimes(1));
    const newerRefresh = integration.refreshAnnotations(filePath);
    await newerRefresh;
    expect(root.querySelector('.inkstone-text-highlight')).toBeNull();

    releaseStaleResult?.(staleResult);
    await olderRefresh;

    expect(root.querySelector('.inkstone-text-highlight')).toBeNull();
    integration.dispose();
  });

  it('invalidates an initial section render when deletion refreshes it before mount completes', async () => {
    const source = 'Pending mount target.';
    const filePath = 'Pending Mount.md';
    const store = new MemoryTextFileStore();
    const service = new AnnotationService({
      createId: () => 'pending-mount-annotation',
      repository: new SidecarRepository(store),
    });
    const record = await service.createHighlight({
      filePath,
      selection: { end: 'Pending'.length, scope: {}, start: 0 },
      source,
      styleId: 'highlight-sun',
    });
    const staleResult = await service.resolveHighlights({ filePath, source });
    let releaseInitial: ((result: ResolveHighlightsResult) => void) | undefined;
    const delayedInitial = new Promise<ResolveHighlightsResult>((resolve) => {
      releaseInitial = resolve;
    });
    const resolveHighlights = vi
      .spyOn(service, 'resolveHighlights')
      .mockReturnValueOnce(delayedInitial);
    const integration = new ReadingViewIntegration({ document, service });
    const root = document.createElement('p');
    root.textContent = source;

    const mounting = integration.mountSection({
      filePath,
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: source }),
      root,
    });
    await vi.waitFor(() => expect(resolveHighlights).toHaveBeenCalledTimes(1));
    await service.deleteAnnotation(filePath, record.id, record.revision);

    await integration.refreshAnnotations(filePath);
    expect(resolveHighlights).toHaveBeenCalledTimes(2);
    expect(root.querySelector('.inkstone-text-highlight')).toBeNull();

    releaseInitial?.(staleResult);
    await mounting;
    expect(root.querySelector('.inkstone-text-highlight')).toBeNull();
    integration.dispose();
  });

  it('loads a note annotation set once while Obsidian mounts multiple preview sections', async () => {
    const source = 'First paragraph.\n\nSecond paragraph.';
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    await service.createHighlight({
      filePath: 'Cached.md',
      selection: { end: 5, scope: {}, start: 0 },
      source,
      styleId: 'highlight-yellow',
    });
    store.listCalls = 0;
    const integration = new ReadingViewIntegration({ document, service });
    const first = document.createElement('p');
    first.textContent = 'First paragraph.';
    const second = document.createElement('p');
    second.textContent = 'Second paragraph.';

    const cleanupFirst = await integration.mountSection({
      filePath: 'Cached.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: 'First paragraph.' }),
      root: first,
    });
    const cleanupSecond = await integration.mountSection({
      filePath: 'Cached.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 2, lineStart: 2, text: 'Second paragraph.' }),
      root: second,
    });

    expect(store.listCalls).toBe(1);
    cleanupFirst();
    cleanupSecond();
    integration.dispose();
  });

  it('restores one simple cross-paragraph record as independent block-local fragments', async () => {
    const source = 'First paragraph.\n\nSecond paragraph.';
    const store = new MemoryTextFileStore();
    const service = new AnnotationService({
      createId: (() => {
        const ids = ['note-cross', 'annotation-cross'];
        return () => ids.shift() ?? 'unexpected-id';
      })(),
      repository: new SidecarRepository(store),
    });
    await service.createHighlight({
      filePath: 'Cross block.md',
      selection: {
        end: source.indexOf('Second') + 'Second'.length,
        scope: { sectionEndLine: 2, sectionStartLine: 0 },
        start: source.indexOf('paragraph.'),
      },
      source,
      styleId: 'highlight-sun',
    });
    const root = document.createElement('section');
    root.innerHTML = '<p>First paragraph.</p><p>Second paragraph.</p>';
    document.body.append(root);
    const integration = new ReadingViewIntegration({ document, service });

    const cleanup = await integration.mountSection({
      filePath: 'Cross block.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 2, lineStart: 0, text: source }),
      root,
    });

    expect(
      [...root.querySelectorAll<HTMLElement>('.inkstone-text-highlight')].map(
        (element) => element.textContent,
      ),
    ).toEqual(['paragraph.', 'Second']);
    cleanup();
    integration.dispose();
  });

  it('creates a simple cross-paragraph record when Obsidian mounted separate preview sections', async () => {
    const source = 'First paragraph.\n\nSecond paragraph.';
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-split', 'annotation-split'];
    const integration = new ReadingViewIntegration({
      document,
      service: new AnnotationService({
        createId: () => ids.shift() ?? 'unexpected-id',
        repository,
      }),
    });
    const preview = document.createElement('div');
    const first = document.createElement('p');
    const second = document.createElement('p');
    first.textContent = 'First paragraph.';
    second.textContent = 'Second paragraph.';
    preview.append(first, second);
    document.body.append(preview);
    const cleanupFirst = await integration.mountSection({
      filePath: 'Split sections.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: 'First paragraph.' }),
      root: first,
    });
    const cleanupSecond = await integration.mountSection({
      filePath: 'Split sections.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 2, lineStart: 2, text: 'Second paragraph.' }),
      root: second,
    });
    const firstText = first.firstChild;
    const secondText = second.firstChild;
    if (!(firstText instanceof Text) || !(secondText instanceof Text)) {
      throw new Error('Split-section fixture is missing text nodes.');
    }
    const range = document.createRange();
    range.setStart(firstText, 'First '.length);
    range.setEnd(secondText, 'Second'.length);
    document.getSelection()?.addRange(range);

    second.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('button[aria-label="Highlight: Sun"]')).not.toBeNull(),
    );
    document.querySelector<HTMLButtonElement>('button[aria-label="Highlight: Sun"]')?.click();
    await vi.waitFor(() =>
      expect(
        [first, second].flatMap((block) => [...block.querySelectorAll('.inkstone-text-highlight')]),
      ).toHaveLength(2),
    );

    const [record] = (await repository.listAnnotations('Split sections.md')).records;
    expect(record?.target.quote.exact).toBe('paragraph.\n\nSecond');
    cleanupFirst();
    cleanupSecond();
    integration.dispose();
  });

  it('reports section restoration timing through opt-in diagnostics', async () => {
    const store = new MemoryTextFileStore();
    const samples: Array<{ durationMs: number; name: string }> = [];
    const times = [10, 22];
    const integration = new ReadingViewIntegration({
      document,
      now: () => times.shift() ?? 22,
      recordDuration: (name, durationMs) => samples.push({ durationMs, name }),
      service: new AnnotationService({ repository: new SidecarRepository(store) }),
    });
    const root = document.createElement('p');
    root.textContent = 'Measured.';

    const cleanup = await integration.mountSection({
      filePath: 'Measured.md',
      getFullSource: () => Promise.resolve('Measured.'),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: 'Measured.' }),
      root,
    });

    expect(samples).toEqual([{ durationMs: 12, name: 'reading-section-render' }]);
    cleanup();
    integration.dispose();
  });

  it('rebuilds an overlap plan immediately after committing a second record', async () => {
    const source = 'Overlap target here.';
    const store = new MemoryTextFileStore();
    const ids = ['note-1', 'wide', 'specific'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository: new SidecarRepository(store),
    });
    await service.createHighlight({
      filePath: 'Overlap.md',
      selection: { end: 14, scope: { sectionEndLine: 0, sectionStartLine: 0 }, start: 0 },
      source,
      styleId: 'sun',
    });
    let hitIds: readonly string[] = [];
    const integration = new ReadingViewIntegration({
      document,
      onAnnotationHit: (ids) => {
        hitIds = ids;
      },
      service,
    });
    const root = document.createElement('p');
    root.textContent = source;
    document.body.append(root);
    const cleanup = await integration.mountSection({
      filePath: 'Overlap.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: source }),
      root,
    });
    const wideText = root.querySelector('.inkstone-text-highlight')?.firstChild;
    if (!(wideText instanceof Text)) {
      throw new Error('Wide highlight text was not restored.');
    }
    const range = document.createRange();
    range.setStart(wideText, 'Overlap '.length);
    range.setEnd(wideText, 'Overlap target'.length);
    document.getSelection()?.addRange(range);

    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('button[aria-label="Highlight: Sun"]')).not.toBeNull(),
    );
    document.querySelector<HTMLButtonElement>('button[aria-label="Highlight: Sun"]')?.click();
    await vi.waitFor(() =>
      expect(
        [...root.querySelectorAll<HTMLElement>('.inkstone-text-highlight')].some(
          (element) =>
            element.dataset.inkstoneAnnotationIds === JSON.stringify(['specific', 'wide']),
        ),
      ).toBe(true),
    );
    const overlap = [...root.querySelectorAll<HTMLElement>('.inkstone-text-highlight')].find(
      (element) => element.dataset.inkstoneAnnotationIds?.includes('specific') === true,
    );
    overlap?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(hitIds).toEqual(['specific', 'wide']);

    cleanup();
    integration.dispose();
  });

  it('renders only the intersecting block from a 500-record note', async () => {
    const lines = Array.from({ length: 500 }, (_, index) => `Paragraph token-${index}.`);
    const source = lines.join('\n\n');
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-500', 'annotation-0'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const firstStart = source.indexOf('token-0');
    const first = await service.createHighlight({
      filePath: 'Scale.md',
      selection: {
        end: firstStart + 'token-0'.length,
        scope: { sectionEndLine: 0, sectionStartLine: 0 },
        start: firstStart,
      },
      source,
      styleId: 'sun',
    });
    for (let index = 1; index < lines.length; index += 1) {
      const exact = `token-${index}`;
      const start = source.indexOf(exact);
      await repository.writeAnnotation({
        ...first,
        id: `annotation-${index}`,
        target: {
          ...first.target,
          position: { end: start + exact.length, start, unit: 'utf16-code-unit' },
          quote: {
            exact,
            prefix: source.slice(Math.max(0, start - 32), start),
            suffix: source.slice(start + exact.length, start + exact.length + 32),
          },
          scope: { sectionEndLine: index * 2, sectionStartLine: index * 2 },
        },
      });
    }
    const targetIndex = 321;
    const root = document.createElement('p');
    root.textContent = lines[targetIndex] as string;
    const integration = new ReadingViewIntegration({ document, service });
    const startedAt = performance.now();
    const cleanup = await integration.mountSection({
      filePath: 'Scale.md',
      getFullSource: () => Promise.resolve(source),
      getSectionInfo: () => ({
        lineEnd: targetIndex * 2,
        lineStart: targetIndex * 2,
        text: source,
      }),
      root,
    });

    expect(root.querySelectorAll('.inkstone-text-highlight')).toHaveLength(1);
    expect(root.querySelector('.inkstone-text-highlight')?.textContent).toBe('token-321');
    expect(performance.now() - startedAt).toBeLessThan(500);
    cleanup();
    integration.dispose();
  });
});

function createIntegration(store: TextFileStore, createId?: () => string): ReadingViewIntegration {
  const repository = new SidecarRepository(store);
  return new ReadingViewIntegration({
    document,
    service:
      createId === undefined
        ? new AnnotationService({ repository })
        : new AnnotationService({
            createId,
            now: () => '2026-07-14T08:00:00.000Z',
            repository,
          }),
  });
}

function createSection(): HTMLElement {
  const root = document.createElement('section');
  root.innerHTML = '<p>Mutable <strong>Markdown</strong> remains readable.</p>';
  document.body.append(root);
  return root;
}

function mountedSectionCount(integration: ReadingViewIntegration): number {
  return (
    integration as unknown as {
      readonly sections: ReadonlyMap<HTMLElement, unknown>;
    }
  ).sections.size;
}

class MemoryTextFileStore implements TextFileStore {
  private readonly files = new Map<string, string>();
  listCalls = 0;

  list(directory: string): Promise<readonly string[]> {
    this.listCalls += 1;
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

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  write(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
    return Promise.resolve();
  }
}
