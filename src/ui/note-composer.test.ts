// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnnotationService } from '../application/annotation-service';
import { SidecarRepository, type TextFileStore } from '../storage/sidecar-repository';
import { NoteComposer } from './note-composer';

describe('note composer', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('anchors a compact editor, focuses after durable draft creation and saves body and tags locally', async () => {
    vi.useFakeTimers();
    const fixture = await createDraftFixture();
    const composer = new NoteComposer({
      anchorRect: new DOMRect(100, 120, 80, 20),
      document,
      draft: fixture.draft,
      layout: 'anchored',
      service: fixture.service,
    });

    composer.show();

    const dialog = document.querySelector<HTMLElement>('[data-inkstone-note-composer]');
    const textarea = dialog?.querySelector<HTMLTextAreaElement>('textarea');
    const tags = dialog?.querySelector<HTMLInputElement>('input[aria-label="Tags"]');
    const status = dialog?.querySelector('[data-inkstone-save-state]');
    expect(dialog?.classList.contains('inkstone-note-composer--anchored')).toBe(true);
    expect(dialog?.querySelector('.inkstone-note-composer__quote')?.textContent).toBe(
      'Draft target',
    );
    expect(document.activeElement).toBe(textarea);
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');

    setInput(textarea, 'A durable local thought.');
    setInput(tags, 'research, anchors');
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() =>
      expect(dialog?.querySelector('[data-inkstone-save-state]')?.textContent).toBe(
        'Saved locally',
      ),
    );
    expect(dialog?.textContent).not.toContain('Synced');
    await expect(
      fixture.repository.readAnnotation('Composer.md', fixture.draft.id),
    ).resolves.toMatchObject({
      body: 'A durable local thought.',
      status: 'active',
      tags: ['research', 'anchors'],
    });
  });

  it('uses a keyboard-aware bottom sheet fallback for mobile layouts', async () => {
    const fixture = await createDraftFixture();
    const composer = new NoteComposer({
      anchorRect: new DOMRect(100, 120, 80, 20),
      document,
      draft: fixture.draft,
      layout: 'bottom-sheet',
      service: fixture.service,
    });

    composer.show();

    expect(
      document
        .querySelector('[data-inkstone-note-composer]')
        ?.classList.contains('inkstone-note-composer--bottom-sheet'),
    ).toBe(true);
    await composer.close();
  });

  it('flushes pending text when the document backgrounds and when the close button is used', async () => {
    vi.useFakeTimers();
    const fixture = await createDraftFixture();
    const composer = new NoteComposer({
      anchorRect: new DOMRect(100, 120, 80, 20),
      document,
      draft: fixture.draft,
      layout: 'anchored',
      service: fixture.service,
    });
    composer.show();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-inkstone-note-composer] textarea',
    );
    setInput(textarea, 'Flush before debounce.');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(async () =>
      expect(
        await fixture.repository.readAnnotation('Composer.md', fixture.draft.id),
      ).toMatchObject({
        body: 'Flush before debounce.',
      }),
    );

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    setInput(textarea, 'Flush on real window blur.');
    window.dispatchEvent(new Event('blur'));
    expect(document.querySelector('[data-inkstone-save-state]')?.textContent).toBe('Saving…');
    await vi.waitFor(async () =>
      expect(
        await fixture.repository.readAnnotation('Composer.md', fixture.draft.id),
      ).toMatchObject({
        body: 'Flush on real window blur.',
      }),
    );

    setInput(textarea, 'Close has the latest text.');
    document.querySelector<HTMLButtonElement>('button[aria-label="Close note"]')?.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-note-composer]')).toBeNull(),
    );
    await expect(
      fixture.repository.readAnnotation('Composer.md', fixture.draft.id),
    ).resolves.toMatchObject({ body: 'Close has the latest text.' });
  });

  it('returns focus to the note field before a successful Retry button is hidden', async () => {
    vi.useFakeTimers();
    const fixture = await createDraftFixture();
    const composer = new NoteComposer({
      anchorRect: new DOMRect(100, 120, 80, 20),
      document,
      draft: fixture.draft,
      layout: 'anchored',
      service: fixture.service,
    });
    composer.show();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-inkstone-note-composer] textarea',
    );
    fixture.store.failNextWrite();
    setInput(textarea, 'Retry this thought.');

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-save-state]')?.textContent).toBe(
        "Couldn't save locally. Retry.",
      ),
    );
    const retry = document.querySelector<HTMLButtonElement>('.inkstone-note-composer__retry');
    retry?.focus();
    retry?.click();

    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-save-state]')?.textContent).toBe(
        'Saved locally',
      ),
    );
    expect(retry?.hidden).toBe(true);
    expect(document.activeElement).toBe(textarea);
  });

  it('keeps the composer open and focuses Retry when Escape cannot save locally', async () => {
    vi.useFakeTimers();
    const fixture = await createDraftFixture();
    const composer = new NoteComposer({
      anchorRect: new DOMRect(100, 120, 80, 20),
      document,
      draft: fixture.draft,
      layout: 'anchored',
      service: fixture.service,
    });
    composer.show();
    fixture.store.failNextWrite();
    setInput(
      document.querySelector<HTMLTextAreaElement>('[data-inkstone-note-composer] textarea'),
      'Do not lose this draft.',
    );

    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));

    await vi.waitFor(() =>
      expect(document.querySelector('[data-inkstone-save-state]')?.textContent).toBe(
        "Couldn't save locally. Retry.",
      ),
    );
    const retry = document.querySelector<HTMLButtonElement>('.inkstone-note-composer__retry');
    expect(document.querySelector('[data-inkstone-note-composer]')).not.toBeNull();
    expect(document.activeElement).toBe(retry);
  });

  it('starts a final local flush when the host unloads the composer', async () => {
    vi.useFakeTimers();
    const fixture = await createDraftFixture();
    const composer = new NoteComposer({
      anchorRect: new DOMRect(100, 120, 80, 20),
      document,
      draft: fixture.draft,
      layout: 'anchored',
      service: fixture.service,
    });
    composer.show();
    setInput(
      document.querySelector<HTMLTextAreaElement>('[data-inkstone-note-composer] textarea'),
      'Unload flush content.',
    );

    composer.dispose();

    await vi.waitFor(async () =>
      expect(
        await fixture.repository.readAnnotation('Composer.md', fixture.draft.id),
      ).toMatchObject({
        body: 'Unload flush content.',
      }),
    );
  });
});

function setInput(
  element: HTMLInputElement | HTMLTextAreaElement | null | undefined,
  value: string,
): void {
  if (element === null || element === undefined) {
    throw new Error('Expected composer input.');
  }
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function createDraftFixture(): Promise<{
  draft: Awaited<ReturnType<AnnotationService['beginNoteDraft']>>;
  repository: SidecarRepository;
  service: AnnotationService;
  store: MemoryTextFileStore;
}> {
  const store = new MemoryTextFileStore();
  const repository = new SidecarRepository(store);
  const ids = ['note-1', 'draft-1'];
  const service = new AnnotationService({
    createId: () => ids.shift() ?? 'unexpected-id',
    repository,
  });
  const pending = await service.prepareSelection({
    filePath: 'Composer.md',
    selection: { end: 12, scope: {}, start: 0 },
    source: 'Draft target text.',
  });
  return { draft: await service.beginNoteDraft(pending), repository, service, store };
}

class MemoryTextFileStore implements TextFileStore {
  private failWrites = 0;
  private readonly files = new Map<string, string>();

  failNextWrite(): void {
    this.failWrites += 1;
  }

  list(directory: string): Promise<readonly string[]> {
    const prefix = `${directory}/`;
    return Promise.resolve(
      [...this.files.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map((path) => path.slice(prefix.length)),
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
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      return Promise.reject(new Error('Injected write failure.'));
    }
    this.files.set(path, contents);
    return Promise.resolve();
  }
}
