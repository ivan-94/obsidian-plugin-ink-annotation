import { describe, expect, it, vi } from 'vitest';

import { SidecarRepository, type TextFileStore } from '../storage/sidecar-repository';
import { AnnotationService } from './annotation-service';

describe('annotation service walking skeleton', () => {
  it('creates, persists and resolves a UTF-16 compound anchor after reload', async () => {
    const store = new MemoryTextFileStore();
    const ids = ['note-1', 'annotation-1'];
    const source = '# Architecture\n\n👩‍💻 Mutable Markdown needs resilient anchors.';
    const exact = 'Mutable Markdown';
    const start = source.indexOf(exact);
    const repository = new SidecarRepository(store);
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => '2026-07-14T08:00:00.000Z',
      repository,
    });

    const created = await service.createHighlight({
      filePath: '研究\\Mutable Markdown 标注.md',
      selection: {
        end: start + exact.length,
        scope: {
          headingPath: ['Architecture'],
          sectionEndLine: 3,
          sectionStartLine: 1,
        },
        start,
      },
      source,
      styleId: 'highlight-yellow',
    });

    expect(created).toMatchObject({
      filePath: '研究/Mutable Markdown 标注.md',
      id: 'annotation-1',
      mark: { kind: 'highlight', styleId: 'highlight-yellow' },
      noteId: 'note-1',
      status: 'active',
      target: {
        position: { end: start + exact.length, start, unit: 'utf16-code-unit' },
        quote: { exact },
        scope: {
          headingPath: ['Architecture'],
          sectionEndLine: 3,
          sectionStartLine: 1,
        },
      },
    });
    expect(created.target.quote.prefix).toMatch(/👩‍💻 $/u);
    expect(created.target.quote.suffix).toMatch(/^ needs resilient anchors\./u);
    expect(created.target.scope.blockFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(created.target.sourceRevision).toMatch(/^[a-f0-9]{64}$/u);

    const reloadedService = new AnnotationService({
      createId: () => 'unused',
      now: () => '2026-07-14T08:01:00.000Z',
      repository: new SidecarRepository(store),
    });
    const reloaded = await reloadedService.resolveHighlights({
      filePath: '研究/Mutable Markdown 标注.md',
      source,
    });

    expect(reloaded).toEqual({
      issues: [],
      resolved: [{ end: start + exact.length, record: created, start }],
      unanchored: [],
    });
  });

  it('keeps a stable selection transient until the user chooses an action', async () => {
    const store = new MemoryTextFileStore();
    const source = '# Reading\n\nSelecting text is not an annotation.';
    const exact = 'Selecting text';
    const start = source.indexOf(exact);
    const service = new AnnotationService({
      createId: () => 'must-not-be-called',
      repository: new SidecarRepository(store),
    });

    const pending = await service.prepareSelection({
      filePath: 'Reading safety.md',
      selection: { end: start + exact.length, scope: { headingPath: ['Reading'] }, start },
      source,
    });

    expect(pending.target.quote.exact).toBe(exact);
    const afterReload = await new AnnotationService({
      repository: new SidecarRepository(store),
    }).resolveHighlights({ filePath: 'Reading safety.md', source });
    expect(afterReload).toEqual({ issues: [], resolved: [], unanchored: [] });
  });

  it('resolves transient editor positions without writing canonical or note metadata', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const source = 'Mutable target text.';
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const created = await service.createHighlight({
      filePath: 'Transient.md',
      selection: { end: 14, scope: {}, start: 8 },
      source,
      styleId: 'highlight-sun',
    });
    const writesBeforeResolve = store.writeCount;

    const result = await service.resolveHighlights({
      filePath: 'Transient.md',
      persistChanges: false,
      source: `Prefix ${source}`,
    });

    expect(result.resolved[0]).toMatchObject({ end: 21, start: 15 });
    expect(store.writeCount).toBe(writesBeforeResolve);
    await expect(repository.readAnnotation('Transient.md', created.id)).resolves.toMatchObject({
      revision: 1,
      target: { position: { end: 14, start: 8 } },
    });
  });

  it('preserves the complete canonical record while marking a deleted target unanchored', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const source = '# Context\n\nKeep this target phrase safe.';
    const exact = 'target phrase';
    const start = source.indexOf(exact);
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => '2026-07-14T08:00:00.000Z',
      repository,
    });
    const created = await service.createHighlight({
      filePath: 'Unanchored.md',
      selection: {
        end: start + exact.length,
        scope: { headingPath: ['Context'], sectionEndLine: 2, sectionStartLine: 2 },
        start,
      },
      source,
      styleId: 'highlight-yellow',
    });
    const enriched = {
      ...created,
      body: 'Keep my note body.',
      revision: 2,
      tags: ['recovery'],
      updatedAt: '2026-07-14T08:01:00.000Z',
    };
    await repository.updateAnnotation(enriched);

    const reconciled = await service.resolveHighlights({
      filePath: 'Unanchored.md',
      source: '# Context\n\nThe passage was deleted.',
    });

    expect(reconciled.resolved).toEqual([]);
    expect(reconciled.unanchored).toHaveLength(1);
    expect(reconciled.unanchored[0]).toMatchObject({
      reason: 'not-found',
      record: {
        anchorFailure: { candidateCount: 0, reason: 'not-found' },
        body: 'Keep my note body.',
        mark: { kind: 'highlight', styleId: 'highlight-yellow' },
        revision: 3,
        status: 'unanchored',
        tags: ['recovery'],
        target: { quote: { exact } },
      },
    });
    await expect(repository.readAnnotation('Unanchored.md', created.id)).resolves.toEqual(
      reconciled.unanchored[0]?.record,
    );
  });

  it('rebases canonical selectors after a unique high-confidence relocation', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const source = '# Context\n\nKeep this target phrase safe.';
    const exact = 'target phrase';
    const start = source.indexOf(exact);
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const created = await service.createHighlight({
      filePath: 'Rebase.md',
      selection: {
        end: start + exact.length,
        scope: { headingPath: ['Context'], sectionEndLine: 2, sectionStartLine: 2 },
        start,
      },
      source,
      styleId: 'highlight-yellow',
    });
    const mutated = '# Context\n\nInserted paragraph.\n\nKeep this target phrase safe.';
    const relocatedStart = mutated.indexOf(exact);

    const reconciled = await service.resolveHighlights({ filePath: 'Rebase.md', source: mutated });

    expect(reconciled.resolved[0]).toMatchObject({
      end: relocatedStart + exact.length,
      record: {
        revision: 2,
        target: {
          position: { end: relocatedStart + exact.length, start: relocatedStart },
          quote: { exact },
          scope: { headingPath: ['Context'], sectionEndLine: 4, sectionStartLine: 4 },
        },
      },
      start: relocatedStart,
    });
    await expect(repository.readAnnotation('Rebase.md', created.id)).resolves.toEqual(
      reconciled.resolved[0]?.record,
    );
  });

  it('persists a note target as draft, activates saved content, rejects stale writes and cleans empty drafts', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'draft-1', 'draft-2'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => '2026-07-14T08:00:00.000Z',
      repository,
    });
    const source = 'Draft target text.';
    const pending = await service.prepareSelection({
      filePath: 'Drafts.md',
      selection: { end: 12, scope: {}, start: 0 },
      source,
    });

    const draft = await service.beginNoteDraft(pending);
    await expect(repository.readAnnotation('Drafts.md', draft.id)).resolves.toMatchObject({
      status: 'draft',
      target: { quote: { exact: 'Draft target' } },
    });
    const saved = await service.saveDraft(draft, { body: 'Local note', tags: ['research'] });
    expect(saved).toMatchObject({
      body: 'Local note',
      revision: 2,
      status: 'active',
      tags: ['research'],
    });
    await expect(service.saveDraft(draft, { body: 'stale overwrite', tags: [] })).rejects.toThrow(
      /increase revision/u,
    );

    const secondTarget = await service.prepareSelection({
      filePath: 'Drafts.md',
      selection: { end: 17, scope: {}, start: 13 },
      source,
    });
    const empty = await service.beginNoteDraft(secondTarget);
    await service.discardEmptyDraft(empty);
    await expect(repository.readAnnotation('Drafts.md', empty.id)).resolves.toBeNull();
  });

  it('commits an underline through the same canonical mark path', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'underline-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const pending = await service.prepareSelection({
      filePath: 'Underline.md',
      selection: { end: 9, scope: {}, start: 0 },
      source: 'Underline this sentence.',
    });

    const record = await service.commitMark(pending, {
      kind: 'underline',
      styleId: 'highlight-violet',
    });

    expect(record).toMatchObject({
      mark: { kind: 'underline', styleId: 'highlight-violet' },
      status: 'active',
    });
    await expect(repository.readAnnotation('Underline.md', record.id)).resolves.toEqual(record);
  });

  it('adds a note to an existing mark and changes its kind without losing body or tags', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const pending = await service.prepareSelection({
      filePath: 'Combined.md',
      selection: { end: 13, scope: {}, start: 0 },
      source: 'Combined mark and note.',
    });
    const highlight = await service.commitHighlight(pending, 'highlight-sun');

    const sameTarget = await service.beginNoteDraft(pending);
    expect(sameTarget.id).toBe(highlight.id);
    const noted = await service.saveDraft(sameTarget, {
      body: 'Keep this note.',
      mark: sameTarget.mark,
      tags: ['combined'],
    });
    const underlined = await service.commitMark(pending, {
      kind: 'underline',
      styleId: 'highlight-mint',
    });

    expect(underlined).toMatchObject({
      body: 'Keep this note.',
      id: highlight.id,
      mark: { kind: 'underline', styleId: 'highlight-mint' },
      revision: noted.revision + 1,
      tags: ['combined'],
    });
    const loaded = await repository.listAnnotations('Combined.md');
    expect(loaded.records).toEqual([underlined]);
  });

  it('persists a tombstone, hides it after reload and restores only the expected revision', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const source = 'Delete and undo this annotation.';
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => '2026-07-14T09:00:00.000Z',
      repository,
    });
    const created = await service.createHighlight({
      filePath: 'Delete Undo.md',
      selection: { end: 15, scope: {}, start: 0 },
      source,
      styleId: 'highlight-sun',
    });

    const deleted = await service.deleteAnnotation('Delete Undo.md', created.id);

    expect(deleted).toMatchObject({
      deletedAt: '2026-07-14T09:00:00.000Z',
      revision: 2,
    });
    await expect(
      service.resolveHighlights({ filePath: 'Delete Undo.md', source }),
    ).resolves.toEqual({
      issues: [],
      resolved: [],
      unanchored: [],
    });

    const restored = await new AnnotationService({
      now: () => '2026-07-14T09:01:00.000Z',
      repository: new SidecarRepository(store),
    }).undoDeletion('Delete Undo.md', created.id, deleted.revision);
    expect(restored).toMatchObject({ id: created.id, revision: 3 });
    expect(restored.deletedAt).toBeUndefined();
    await expect(
      service.resolveHighlights({ filePath: 'Delete Undo.md', source }),
    ).resolves.toMatchObject({ resolved: [{ record: { id: created.id, revision: 3 } }] });
  });

  it('refuses a single-row delete after the canonical revision changed', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const created = await service.createHighlight({
      filePath: 'Stale Delete.md',
      selection: { end: 5, scope: {}, start: 0 },
      source: 'Stale delete target.',
      styleId: 'highlight-sun',
    });
    const updated = await service.updateAnnotationContents(created.filePath, created.id, {
      body: '',
      mark: created.mark,
      tags: ['remote-update'],
    });

    await expect(
      service.deleteAnnotation(created.filePath, created.id, created.revision),
    ).rejects.toThrow('changed since it was selected');
    await expect(repository.readAnnotation(created.filePath, created.id)).resolves.toEqual(updated);
  });

  it('edits an unanchored record without replacing its recovery target or failure context', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const source = 'Original target text.';
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const created = await service.createHighlight({
      filePath: 'Editable Problem.md',
      selection: { end: 15, scope: {}, start: 0 },
      source,
      styleId: 'highlight-sun',
    });
    const [problem] = (
      await service.resolveHighlights({
        filePath: 'Editable Problem.md',
        source: 'The original passage disappeared.',
      })
    ).unanchored;
    if (problem === undefined) {
      throw new Error('Fixture did not become unanchored.');
    }

    const updated = await service.updateAnnotationContents('Editable Problem.md', created.id, {
      body: 'Still editable before repair.',
      mark: { kind: 'underline', styleId: 'highlight-mint' },
      tags: ['repair', 'editable'],
    });

    expect(updated).toMatchObject({
      anchorFailure: problem.record.anchorFailure,
      body: 'Still editable before repair.',
      revision: problem.record.revision + 1,
      status: 'unanchored',
      tags: ['repair', 'editable'],
      target: problem.record.target,
    });
    await expect(
      service.getAnnotationsById('Editable Problem.md', [created.id, 'missing']),
    ).resolves.toEqual([updated]);
  });

  it('persists a reattachment only after preview confirmation and resolves the replacement target', async () => {
    const store = new MemoryTextFileStore();
    const repository = new SidecarRepository(store);
    const ids = ['note-1', 'annotation-1'];
    const originalSource = 'Original target was here.';
    const currentSource = 'A replacement target is now available.';
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository,
    });
    const created = await service.createHighlight({
      filePath: 'Repair Flow.md',
      selection: { end: 15, scope: {}, start: 0 },
      source: originalSource,
      styleId: 'highlight-sun',
    });
    await service.resolveHighlights({ filePath: 'Repair Flow.md', source: currentSource });
    const replacementStart = currentSource.indexOf('replacement target');
    const replacement = await service.prepareSelection({
      filePath: 'Repair Flow.md',
      selection: {
        end: replacementStart + 'replacement target'.length,
        scope: {},
        start: replacementStart,
      },
      source: currentSource,
    });

    const candidate = await service.previewReattachment('Repair Flow.md', created.id, replacement);
    expect(
      (await repository.readAnnotation('Repair Flow.md', created.id))?.target.quote.exact,
    ).toBe('Original target');

    const repaired = await service.confirmReattachment('Repair Flow.md', candidate);

    expect(repaired).toMatchObject({
      revision: 3,
      status: 'active',
      target: { quote: { exact: 'replacement target' } },
    });
    await expect(
      service.resolveHighlights({ filePath: 'Repair Flow.md', source: currentSource }),
    ).resolves.toMatchObject({ resolved: [{ record: { id: created.id } }] });
  });

  it('stamps new and updated records with the current local device ID', async () => {
    const store = new MemoryTextFileStore();
    const ids = ['note-1', 'annotation-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      deviceId: 'device-mac-1',
      repository: new SidecarRepository(store),
    });
    const created = await service.createHighlight({
      filePath: 'Device.md',
      selection: { end: 6, scope: {}, start: 0 },
      source: 'Device target.',
      styleId: 'highlight-sun',
    });
    const updated = await service.updateAnnotationContents('Device.md', created.id, {
      body: 'Edited here',
      mark: created.mark,
      tags: [],
    });

    expect(created.deviceId).toBe('device-mac-1');
    expect(updated).toMatchObject({ deviceId: 'device-mac-1', revision: 2 });
  });

  it('applies bulk tags against revision snapshots and reports partial stale failures', async () => {
    const store = new MemoryTextFileStore();
    const ids = ['note-1', 'annotation-1', 'annotation-2'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository: new SidecarRepository(store),
    });
    const source = 'First target and second target.';
    const first = await service.createHighlight({
      filePath: 'Bulk.md',
      selection: { end: 12, scope: {}, start: 0 },
      source,
      styleId: 'highlight-sun',
    });
    const second = await service.createHighlight({
      filePath: 'Bulk.md',
      selection: { end: 30, scope: {}, start: 17 },
      source,
      styleId: 'highlight-mint',
    });

    const result = await service.bulkAddTags(
      [
        { expectedRevision: first.revision, filePath: first.filePath, id: first.id },
        { expectedRevision: 99, filePath: second.filePath, id: second.id },
      ],
      ['review'],
    );

    expect(result.succeeded).toMatchObject([{ id: first.id, revision: 2, tags: ['review'] }]);
    expect(result.failed).toEqual([
      {
        expectedRevision: 99,
        filePath: second.filePath,
        id: second.id,
        reason: 'stale',
      },
    ]);
    await expect(service.getAnnotationsById('Bulk.md', [second.id])).resolves.toMatchObject([
      { revision: 1, tags: [] },
    ]);
  });

  it('bulk deletes with tombstones while preserving every stale selection', async () => {
    const store = new MemoryTextFileStore();
    const ids = ['note-1', 'annotation-1'];
    const repository = new SidecarRepository(store);
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => '2026-07-14T15:00:00.000Z',
      repository,
    });
    const created = await service.createHighlight({
      filePath: 'Bulk Delete.md',
      selection: { end: 6, scope: {}, start: 0 },
      source: 'Delete target.',
      styleId: 'highlight-sun',
    });

    const result = await service.bulkDelete([
      { expectedRevision: created.revision, filePath: created.filePath, id: created.id },
      { expectedRevision: 7, filePath: created.filePath, id: 'missing' },
    ]);

    expect(result.succeeded).toMatchObject([
      { deletedAt: '2026-07-14T15:00:00.000Z', id: created.id, revision: 2 },
    ]);
    expect(result.failed).toEqual([
      {
        expectedRevision: 7,
        filePath: created.filePath,
        id: 'missing',
        reason: 'missing',
      },
    ]);
    await expect(repository.readAnnotation(created.filePath, created.id)).resolves.toMatchObject({
      deletedAt: '2026-07-14T15:00:00.000Z',
    });
  });

  it('keeps successful deletion receipts when a later bulk read fails', async () => {
    const store = new MemoryTextFileStore();
    const ids = ['note-1', 'annotation-1', 'annotation-2'];
    const repository = new SidecarRepository(store);
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => '2026-07-17T06:00:00.000Z',
      repository,
    });
    const first = await service.createHighlight({
      filePath: 'Bulk Partial Read.md',
      selection: { end: 5, scope: {}, start: 0 },
      source: 'First and second.',
      styleId: 'highlight-sun',
    });
    const second = await service.createHighlight({
      filePath: 'Bulk Partial Read.md',
      selection: { end: 16, scope: {}, start: 10 },
      source: 'First and second.',
      styleId: 'highlight-sun',
    });
    const readAnnotation = repository.readAnnotation.bind(repository);
    vi.spyOn(repository, 'readAnnotation').mockImplementation((filePath, annotationId) =>
      annotationId === second.id
        ? Promise.reject(new Error('iCloud file is not hydrated'))
        : readAnnotation(filePath, annotationId),
    );

    const result = await service.bulkDelete([
      { expectedRevision: first.revision, filePath: first.filePath, id: first.id },
      { expectedRevision: second.revision, filePath: second.filePath, id: second.id },
    ]);

    expect(result.succeeded).toMatchObject([{ id: first.id, revision: 2 }]);
    expect(result.failed).toEqual([
      {
        expectedRevision: second.revision,
        filePath: second.filePath,
        id: second.id,
        reason: 'write-failed',
      },
    ]);
  });

  it('bulk changes style without changing highlight versus underline identity', async () => {
    const store = new MemoryTextFileStore();
    const ids = ['note-1', 'annotation-1'];
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      repository: new SidecarRepository(store),
    });
    const created = await service.createHighlight({
      filePath: 'Bulk Style.md',
      selection: { end: 6, scope: {}, start: 0 },
      source: 'Styled target.',
      styleId: 'highlight-sun',
    });

    const result = await service.bulkChangeStyle(
      [{ expectedRevision: 1, filePath: created.filePath, id: created.id }],
      'highlight-violet',
    );

    expect(result).toMatchObject({
      failed: [],
      succeeded: [{ mark: { kind: 'highlight', styleId: 'highlight-violet' }, revision: 2 }],
    });
  });
});

class MemoryTextFileStore implements TextFileStore {
  private readonly files = new Map<string, string>();
  writeCount = 0;

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

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  write(path: string, contents: string): Promise<void> {
    this.writeCount += 1;
    this.files.set(path, contents);
    return Promise.resolve();
  }
}
