// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TextAnnotationRecord } from '../domain/text-annotation';
import { AnnotationInspector } from './annotation-inspector';

describe('annotation inspector', () => {
  afterEach(() => document.body.replaceChildren());

  it('groups editor controls and footer actions into a compact layout', () => {
    const inspector = new AnnotationInspector({
      document,
      onDelete: (item) => Promise.resolve(item),
      onNavigate: () => undefined,
      onSave: (item) => Promise.resolve(item),
      onUndo: (item) => Promise.resolve(item),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: () => Promise.resolve(),
    });

    inspector.show({ anchorRect: new DOMRect(), records: [record('compact', 'Compact quote')] });

    const controls = document.querySelector('.inkstone-annotation-inspector__editor-controls');
    const footer = document.querySelector('.inkstone-annotation-inspector__footer');
    expect(controls).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(controls?.querySelector('.inkstone-annotation-inspector__segments')).not.toBeNull();
    expect(controls?.querySelector('.inkstone-annotation-inspector__styles')).not.toBeNull();
    expect(footer?.querySelector('.inkstone-annotation-inspector__actions')).not.toBeNull();
    expect(footer?.querySelector('.inkstone-annotation-inspector__save')).not.toBeNull();
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]')?.rows).toBe(
      2,
    );
  });

  it('moves keyboard focus into a single-record dialog and returns it on Escape', async () => {
    const invoker = document.createElement('button');
    document.body.append(invoker);
    invoker.focus();
    const inspector = new AnnotationInspector({
      document,
      onDelete: (item) => Promise.resolve(item),
      onNavigate: () => undefined,
      onSave: (item) => Promise.resolve(item),
      onUndo: (item) => Promise.resolve(item),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: () => Promise.resolve(),
    });

    inspector.show({ anchorRect: new DOMRect(), invoker, records: [record('one', 'One quote')] });

    expect(document.activeElement?.getAttribute('aria-label')).toBe('Highlight mark type');
    const status = document.querySelector('[data-inkstone-inspector-status]');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    document
      .querySelector('[data-inkstone-annotation-inspector]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    await vi.waitFor(() => expect(document.activeElement).toBe(invoker));
  });

  it('keeps Copy JSON directly available without an overflow menu', () => {
    const inspector = new AnnotationInspector({
      document,
      onDelete: (item) => Promise.resolve(item),
      onNavigate: () => undefined,
      onSave: (item) => Promise.resolve(item),
      onUndo: (item) => Promise.resolve(item),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: () => Promise.resolve(),
    });
    inspector.show({ anchorRect: new DOMRect(), records: [record('one', 'One quote')] });
    expect(document.querySelector('button[aria-label="Copy annotation JSON"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="More actions"]')).toBeNull();
    expect(document.querySelector('.inkstone-annotation-inspector__more-menu')).toBeNull();
  });

  it('shows every overlapping record before editing the explicitly chosen one', () => {
    const inspector = new AnnotationInspector({
      document,
      onDelete: (record) => Promise.resolve({ ...record, deletedAt: 'later', revision: 2 }),
      onNavigate: () => undefined,
      onSave: (record) => Promise.resolve(record),
      onUndo: (record) => Promise.resolve(record),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: () => Promise.resolve(),
    });

    inspector.show({
      anchorRect: new DOMRect(100, 100, 20, 20),
      records: [record('first', 'First quote'), record('second', 'Second quote')],
    });

    expect(
      [...document.querySelectorAll<HTMLButtonElement>('[data-inkstone-overlap-choice]')].map(
        (button) => button.textContent,
      ),
    ).toEqual(['First quoteHighlight', 'Second quoteHighlight']);
    expect(document.querySelector('[data-inkstone-inspector-editor]')).toBeNull();

    document.querySelector<HTMLButtonElement>('[data-annotation-id="second"]')?.click();

    expect(document.querySelector('[data-inkstone-overlap-chooser]')).toBeNull();
    expect(document.querySelector('[data-inkstone-inspector-editor]')?.textContent).toContain(
      'Second quote',
    );
    expect(document.querySelector('[data-inkstone-inspector-editor]')?.textContent).not.toContain(
      'First quote',
    );
  });

  it('exports only the record currently open in the inspector', () => {
    const exported: string[] = [];
    const inspector = new AnnotationInspector({
      document,
      onDelete: (item) => Promise.resolve(item),
      onExport: (item) => exported.push(item.id),
      onNavigate: () => undefined,
      onSave: (item) => Promise.resolve(item),
      onUndo: (item) => Promise.resolve(item),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: () => Promise.resolve(),
    });
    inspector.show({
      anchorRect: new DOMRect(100, 100, 20, 20),
      records: [record('first', 'First quote')],
    });

    document.querySelector<HTMLButtonElement>('button[aria-label="Export annotation"]')?.click();

    expect(exported).toEqual(['first']);
  });

  it('edits mark, style, note and tags on only the chosen record', async () => {
    const saves: Array<{ changes: unknown; id: string }> = [];
    const inspector = new AnnotationInspector({
      document,
      onDelete: (item) => Promise.resolve(item),
      onNavigate: () => undefined,
      onSave: (item, changes) => {
        saves.push({ changes, id: item.id });
        return Promise.resolve({
          ...item,
          revision: item.revision + 1,
          updatedAt: 'later',
        });
      },
      onUndo: (item) => Promise.resolve(item),
      presets: [
        { color: '#f0c94b', id: 'highlight-sun', name: 'Sun' },
        { color: '#72c7a5', id: 'highlight-mint', name: 'Mint' },
      ],
      writeClipboard: () => Promise.resolve(),
    });
    inspector.show({
      anchorRect: new DOMRect(100, 100, 20, 20),
      records: [record('first', 'First quote'), record('second', 'Second quote')],
    });
    document.querySelector<HTMLButtonElement>('[data-annotation-id="second"]')?.click();

    document.querySelector<HTMLButtonElement>('[data-inkstone-mark-type="underline"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-inkstone-style-id="highlight-mint"]')?.click();
    setValue(
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]'),
      'Edited note',
    );
    setValue(document.querySelector<HTMLInputElement>('input[aria-label="Tags"]'), 'one, two');
    document.querySelector<HTMLButtonElement>('button[aria-label="Save annotation"]')?.click();

    await vi.waitFor(() => expect(saves).toHaveLength(1));
    expect(saves).toEqual([
      {
        changes: {
          body: 'Edited note',
          mark: { kind: 'underline', styleId: 'highlight-mint' },
          tags: ['one', 'two'],
        },
        id: 'second',
      },
    ]);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-annotation-inspector]')).toBeNull(),
    );
  });

  it('closes after explicit Save and restores focus to the invoking control', async () => {
    const revisions: number[] = [];
    const invoker = document.createElement('button');
    document.body.append(invoker);
    invoker.focus();
    const inspector = new AnnotationInspector({
      document,
      onDelete: (item) => Promise.resolve(item),
      onNavigate: () => undefined,
      onSave: (item) => {
        revisions.push(item.revision);
        return Promise.resolve({
          ...item,
          revision: item.revision + 1,
          updatedAt: `revision-${item.revision + 1}`,
        });
      },
      onUndo: (item) => Promise.resolve(item),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: () => Promise.resolve(),
    });
    inspector.show({
      anchorRect: new DOMRect(),
      invoker,
      records: [record('repeat-save', 'Save this twice')],
    });

    const save = document.querySelector<HTMLButtonElement>('button[aria-label="Save annotation"]');
    save?.click();

    await vi.waitFor(() => expect(revisions).toEqual([1]));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-annotation-inspector]')).toBeNull(),
    );
    expect(document.activeElement).toBe(invoker);
  });

  it('copies the quote/link and navigates to source without changing the record', async () => {
    const copied: string[] = [];
    const navigated: string[] = [];
    const item = record('copy-me', 'Copy this quote');
    const inspector = new AnnotationInspector({
      document,
      onDelete: (value) => Promise.resolve(value),
      onNavigate: (value) => navigated.push(value.id),
      onSave: (value) => Promise.resolve(value),
      onUndo: (value) => Promise.resolve(value),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });
    inspector.show({ anchorRect: new DOMRect(), records: [item] });

    const copyQuote = document.querySelector<HTMLButtonElement>('button[aria-label="Copy quote"]');
    copyQuote?.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-inspector-status]')?.textContent).toBe(
        'Quote copied',
      ),
    );
    expect(copyQuote?.classList.contains('is-success')).toBe(true);

    const copyLink = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy annotation link"]',
    );
    copyLink?.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-inspector-status]')?.textContent).toBe(
        'Annotation link copied',
      ),
    );
    expect(copyLink?.classList.contains('is-success')).toBe(true);
    expect(copyQuote?.classList.contains('is-success')).toBe(false);

    const copyJson = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy annotation JSON"]',
    );
    copyJson?.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-inspector-status]')?.textContent).toBe(
        'Annotation JSON copied',
      ),
    );
    expect(copyJson?.classList.contains('is-success')).toBe(true);

    document.querySelector<HTMLButtonElement>('button[aria-label="Go to source"]')?.click();
    expect(document.querySelector('[data-inkstone-inspector-status]')?.textContent).toBe(
      'Source opened',
    );
    await vi.waitFor(() => expect(copied).toHaveLength(3));

    expect(copied).toEqual([
      'Copy this quote',
      'obsidian://inkstone-annotation?file=Overlap.md&id=copy-me',
      expect.stringContaining('"id": "copy-me"'),
    ]);
    expect(navigated).toEqual(['copy-me']);
  });

  it('keeps a deleted record recoverable through Undo and returns focus on close', async () => {
    const events: string[] = [];
    const invoker = document.createElement('button');
    document.body.append(invoker);
    const inspector = new AnnotationInspector({
      document,
      onDelete: (item) => {
        events.push(`delete:${item.id}`);
        return Promise.resolve({ ...item, deletedAt: 'later', revision: item.revision + 1 });
      },
      onNavigate: () => undefined,
      onSave: (item) => Promise.resolve(item),
      onUndo: (item) => {
        events.push(`undo:${item.id}:${item.revision}`);
        const { deletedAt: _deletedAt, ...restored } = item;
        void _deletedAt;
        return Promise.resolve({ ...restored, revision: item.revision + 1 });
      },
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: () => Promise.resolve(),
    });
    inspector.show({
      anchorRect: new DOMRect(),
      invoker,
      records: [record('recover-me', 'Recover this')],
    });

    document.querySelector<HTMLButtonElement>('button[aria-label="Delete annotation"]')?.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-deleted-state]')).not.toBeNull(),
    );
    document.querySelector<HTMLButtonElement>('button[aria-label="Undo delete"]')?.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-inspector-editor]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-inkstone-deleted-state]')).toBeNull();
    expect(events).toEqual(['delete:recover-me', 'undo:recover-me:2']);

    document
      .querySelector('[data-inkstone-annotation-inspector]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    await vi.waitFor(() => expect(document.activeElement).toBe(invoker));
  });

  it('previews only the selected replacement before confirming an unanchored repair', async () => {
    const item: TextAnnotationRecord = {
      ...record('repair-me', 'Old lost quote'),
      anchorFailure: { candidateCount: 0, reason: 'not-found' },
      status: 'unanchored',
    };
    const candidate = {
      annotationId: 'repair-me',
      baseRevision: 1,
      contextPreview: 'before New replacement after',
      target: {
        position: { end: 22, start: 7, unit: 'utf16-code-unit' as const },
        quote: { exact: 'New replacement', prefix: 'before ', suffix: ' after' },
        scope: {},
      },
    };
    const confirmations: string[] = [];
    const inspector = new AnnotationInspector({
      document,
      onConfirmReattach: (value, candidate) => {
        confirmations.push(`${value.id}:${candidate.target.quote.exact}`);
        const { anchorFailure: _failure, ...restored } = value;
        void _failure;
        return Promise.resolve({
          ...restored,
          revision: value.revision + 1,
          status: 'active',
          target: candidate.target,
        });
      },
      onDelete: (value) => Promise.resolve(value),
      onNavigate: () => undefined,
      onSave: (value) => Promise.resolve(value),
      onUndo: (value) => Promise.resolve(value),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: () => Promise.resolve(),
    });
    inspector.showReattachmentPreview({
      anchorRect: new DOMRect(),
      candidate,
      record: item,
    });

    expect(document.querySelector('[data-inkstone-reattachment-preview]')).not.toBeNull();
    const preview = document.querySelector('[data-inkstone-reattachment-preview]');
    expect(preview?.textContent).toContain('Repair annotation');
    expect(preview?.textContent).toContain('Current target');
    expect(preview?.textContent).toContain('Old lost quote');
    expect(preview?.textContent).toContain('New target');
    expect(preview?.textContent).toContain('New replacement');
    expect(preview?.textContent).not.toContain('before New replacement after');
    expect(preview?.textContent).not.toContain('Replacement:');
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label="Confirm reattachment"]')
        ?.textContent,
    ).toBe('Use selection');
    expect(confirmations).toEqual([]);

    document.querySelector<HTMLButtonElement>('button[aria-label="Confirm reattachment"]')?.click();
    await vi.waitFor(() => expect(confirmations).toEqual(['repair-me:New replacement']));
  });

  it('preserves a legacy style ID that is not in the current preset catalog', () => {
    const item: TextAnnotationRecord = {
      ...record('legacy', 'Legacy style quote'),
      mark: { kind: 'highlight', styleId: 'highlight-yellow' },
    };
    const inspector = new AnnotationInspector({
      document,
      onDelete: (value) => Promise.resolve(value),
      onNavigate: () => undefined,
      onSave: (value) => Promise.resolve(value),
      onUndo: (value) => Promise.resolve(value),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: () => Promise.resolve(),
    });

    inspector.show({ anchorRect: new DOMRect(), records: [item] });

    const style = document.querySelector<HTMLButtonElement>(
      '[data-inkstone-style-id="highlight-yellow"]',
    );
    expect(style?.getAttribute('aria-pressed')).toBe('true');
    expect(style?.getAttribute('aria-label')).toContain('Legacy style');
  });

  it('saves dirty edits before outside dismissal and only closes after success', async () => {
    const saved: string[] = [];
    const invoker = document.createElement('button');
    document.body.append(invoker);
    const inspector = new AnnotationInspector({
      document,
      onDelete: (item) => Promise.resolve(item),
      onNavigate: () => undefined,
      onSave: (item, changes) => {
        saved.push(changes.body);
        return Promise.resolve({ ...item, body: changes.body, revision: item.revision + 1 });
      },
      onUndo: (item) => Promise.resolve(item),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: () => Promise.resolve(),
    });
    inspector.show({ anchorRect: new DOMRect(), invoker, records: [record('dirty', 'Dirty')] });
    const note = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]');
    if (note === null) throw new Error('Expected note field.');
    note.value = 'Keep this edit';
    note.dispatchEvent(new Event('input', { bubbles: true }));

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

    await vi.waitFor(() => expect(saved).toEqual(['Keep this edit']));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-annotation-inspector]')).toBeNull(),
    );
    expect(document.activeElement).toBe(invoker);
  });

  it('keeps dirty inspector open when save-on-dismiss fails', async () => {
    const inspector = new AnnotationInspector({
      document,
      onDelete: (item) => Promise.resolve(item),
      onNavigate: () => undefined,
      onSave: () => Promise.reject(new Error('disk unavailable')),
      onUndo: (item) => Promise.resolve(item),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: () => Promise.resolve(),
    });
    inspector.show({ anchorRect: new DOMRect(), records: [record('dirty-fail', 'Dirty')] });
    const note = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]');
    if (note === null) throw new Error('Expected note field.');
    note.value = 'Do not lose me';
    note.dispatchEvent(new Event('input', { bubbles: true }));

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-inspector-status]')?.textContent).toContain(
        "Couldn't save locally",
      ),
    );
    expect(document.querySelector('[data-inkstone-annotation-inspector]')).not.toBeNull();
    expect(note.value).toBe('Do not lose me');
  });

  it('keeps an explicit failed save open and focuses the Retry action', async () => {
    const inspector = new AnnotationInspector({
      document,
      onDelete: (item) => Promise.resolve(item),
      onNavigate: () => undefined,
      onSave: () => Promise.reject(new Error('disk unavailable')),
      onUndo: (item) => Promise.resolve(item),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: () => Promise.resolve(),
    });
    inspector.show({ anchorRect: new DOMRect(), records: [record('retry', 'Retry save')] });

    document.querySelector<HTMLButtonElement>('button[aria-label="Save annotation"]')?.click();

    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-inspector-status]')?.textContent).toContain(
        "Couldn't save locally",
      ),
    );
    const retry = document.querySelector<HTMLButtonElement>('button[aria-label="Retry save"]');
    expect(document.querySelector('[data-inkstone-annotation-inspector]')).not.toBeNull();
    expect(retry?.textContent).toBe('Retry');
    expect(document.activeElement).toBe(retry);
  });

  it('keeps an unanchored record editable and exportable before repair', async () => {
    const saved: string[] = [];
    const copied: string[] = [];
    const item: TextAnnotationRecord = {
      ...record('unanchored-export', 'Missing source quote'),
      anchorFailure: { candidateCount: 0, reason: 'not-found' },
      body: 'Keep this note',
      status: 'unanchored',
    };
    const inspector = new AnnotationInspector({
      document,
      onDelete: (value) => Promise.resolve(value),
      onNavigate: () => undefined,
      onSave: (value, changes) => {
        saved.push(`${value.id}:${changes.body}`);
        return Promise.resolve({ ...value, body: changes.body, revision: value.revision + 1 });
      },
      onUndo: (value) => Promise.resolve(value),
      presets: [{ color: '#f0c94b', id: 'highlight-sun', name: 'Sun' }],
      writeClipboard: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });
    inspector.show({ anchorRect: new DOMRect(), records: [item] });

    expect(document.querySelector('button[aria-label="Preview reattachment"]')).toBeNull();
    expect(document.querySelector('.inkstone-annotation-inspector__repair')).toBeNull();

    setValue(
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]'),
      'Edited before repair',
    );
    document.querySelector<HTMLButtonElement>('button[aria-label="Copy annotation JSON"]')?.click();
    await vi.waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toContain('"status": "unanchored"');
    expect(copied[0]).toContain('"exact": "Missing source quote"');

    document.querySelector<HTMLButtonElement>('button[aria-label="Save annotation"]')?.click();
    await vi.waitFor(() => expect(saved).toEqual(['unanchored-export:Edited before repair']));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-annotation-inspector]')).toBeNull(),
    );
  });
});

function setValue(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null,
  value: string,
): void {
  if (element === null) {
    throw new Error('Expected inspector control.');
  }
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function record(id: string, exact: string): TextAnnotationRecord {
  return {
    createdAt: '2026-07-14T08:00:00.000Z',
    filePath: 'Overlap.md',
    id,
    mark: { kind: 'highlight', styleId: 'highlight-sun' },
    noteId: 'note-1',
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    tags: [],
    target: {
      position: { end: exact.length, start: 0, unit: 'utf16-code-unit' },
      quote: { exact, prefix: '', suffix: '' },
      scope: {},
    },
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}
