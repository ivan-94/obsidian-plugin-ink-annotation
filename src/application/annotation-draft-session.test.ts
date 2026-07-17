import { afterEach, describe, expect, it, vi } from 'vitest';

import { SidecarRepository, type TextFileStore } from '../storage/sidecar-repository';
import { AnnotationDraftSession } from './annotation-draft-session';
import { AnnotationService } from './annotation-service';

describe('annotation draft session', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps edits in memory until an explicit flush activates the draft', async () => {
    vi.useFakeTimers();
    const fixture = await createDraftFixture();
    const states: string[] = [];
    const session = new AnnotationDraftSession({
      draft: fixture.draft,
      onStateChange: (state) => states.push(state.kind),
      service: fixture.service,
    });

    session.update({ body: 'First local thought', tags: ['research'] });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(
      fixture.repository.readAnnotation('Drafts.md', fixture.draft.id),
    ).resolves.toMatchObject({ revision: 1, status: 'draft' });
    expect(session.snapshot().kind).toBe('idle');
    expect(states).not.toContain('saving');

    await session.flush();

    expect(session.snapshot().kind).toBe('saved-locally');
    await expect(
      fixture.repository.readAnnotation('Drafts.md', fixture.draft.id),
    ).resolves.toMatchObject({
      body: 'First local thought',
      revision: 2,
      status: 'active',
      tags: ['research'],
    });
    expect(states).toContain('saving');
    expect(states).toContain('saved-locally');
    expect(states).not.toContain('synced');
  });

  it('flushes the latest edit on close and removes an empty draft', async () => {
    vi.useFakeTimers();
    const fixture = await createDraftFixture();
    const session = new AnnotationDraftSession({
      draft: fixture.draft,
      service: fixture.service,
    });
    session.update({ body: 'Close must persist me.' });

    await session.close();

    await expect(
      fixture.repository.readAnnotation('Drafts.md', fixture.draft.id),
    ).resolves.toMatchObject({ body: 'Close must persist me.', revision: 2, status: 'active' });

    const second = await createDraftFixture('Empty.md');
    const emptySession = new AnnotationDraftSession({
      draft: second.draft,
      service: second.service,
    });
    await emptySession.close();
    await expect(second.repository.readAnnotation('Empty.md', second.draft.id)).resolves.toBeNull();
  });

  it('retains failed content, exposes an actionable error and succeeds on retry', async () => {
    vi.useFakeTimers();
    const fixture = await createDraftFixture();
    const session = new AnnotationDraftSession({
      draft: fixture.draft,
      service: fixture.service,
    });
    session.update({ body: 'Do not lose this.' });
    fixture.store.failNextWrite = true;

    await expect(session.flush()).rejects.toThrow('disk unavailable');
    expect(session.snapshot()).toMatchObject({
      kind: 'error',
      message: "Couldn't save locally.",
    });
    await expect(
      fixture.repository.readAnnotation('Drafts.md', fixture.draft.id),
    ).resolves.toMatchObject({ revision: 1, status: 'draft' });

    await session.flush();
    expect(session.snapshot().kind).toBe('saved-locally');
    await expect(
      fixture.repository.readAnnotation('Drafts.md', fixture.draft.id),
    ).resolves.toMatchObject({ body: 'Do not lose this.', revision: 2, status: 'active' });
  });

  it('removes a previously saved body when the user clears it', async () => {
    const fixture = await createDraftFixture();
    const session = new AnnotationDraftSession({ draft: fixture.draft, service: fixture.service });
    session.update({ body: 'Temporary text' });
    await session.flush();
    session.update({ body: '' });
    await session.flush();

    await expect(
      fixture.repository.readAnnotation('Drafts.md', fixture.draft.id),
    ).resolves.toMatchObject({ revision: 3, status: 'draft' });
    expect(
      (await fixture.repository.readAnnotation('Drafts.md', fixture.draft.id))?.body,
    ).toBeUndefined();
    await session.close();
    await expect(
      fixture.repository.readAnnotation('Drafts.md', fixture.draft.id),
    ).resolves.toBeNull();
  });
});

async function createDraftFixture(filePath = 'Drafts.md'): Promise<{
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
    now: () => '2026-07-14T08:00:00.000Z',
    repository,
  });
  const pending = await service.prepareSelection({
    filePath,
    selection: { end: 12, scope: {}, start: 0 },
    source: 'Draft target text.',
  });
  const draft = await service.beginNoteDraft(pending);
  return { draft, repository, service, store };
}

class MemoryTextFileStore implements TextFileStore {
  readonly files = new Map<string, string>();
  failNextWrite = false;

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
    if (this.failNextWrite && path.endsWith('.json') && path.includes('/annotations/')) {
      this.failNextWrite = false;
      return Promise.reject(new Error('disk unavailable'));
    }
    this.files.set(path, contents);
    return Promise.resolve();
  }
}
