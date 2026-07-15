import { describe, expect, it } from 'vitest';

import {
  confirmInkRebase,
  previewInkRebase,
  reconcileInkSurface,
} from '../domain/ink-surface-layout';
import type { InkSurfaceRecord } from '../domain/ink-surface';
import { encodeTextAnnotationRecord } from '../domain/text-annotation';
import { InkSurfaceRepository } from '../storage/ink-surface-repository';
import { SidecarRepository, type TextFileStore } from '../storage/sidecar-repository';
import { AnnotationService } from './annotation-service';
import { InkDocumentSession } from './ink-document-session';
import { exportInkPng, exportInkSvg, renderInkStandaloneHtml } from './ink-exporter';
import { collectTextAnnotationExport } from './text-annotation-exporter';

describe('release candidate integrated recovery flow', () => {
  it('preserves one canonical text/Ink model through reload, repair, undo, conflict and export', async () => {
    const store = new ReleaseFixtureStore();
    const ids = ['note-rc', 'annotation-rc'];
    let clock = 0;
    const now = () => new Date(Date.UTC(2026, 6, 14, 12, 0, clock++)).toISOString();
    const repository = new SidecarRepository(store);
    const service = new AnnotationService({
      createId: () => ids.shift() ?? 'unexpected-id',
      deviceId: 'mac-fixture',
      now,
      repository,
    });
    const filePath = 'RC/统一恢复流程.md';
    const originalSource = '# RC\n\n👩‍💻 Keep this mutable passage safe.';
    const originalExact = 'mutable passage';
    const originalStart = originalSource.indexOf(originalExact);

    const created = await service.createHighlight({
      filePath,
      selection: {
        end: originalStart + originalExact.length,
        scope: { headingPath: ['RC'], sectionEndLine: 2, sectionStartLine: 2 },
        start: originalStart,
      },
      source: originalSource,
      styleId: 'highlight-sun',
    });
    const enriched = await service.updateAnnotationContents(filePath, created.id, {
      body: 'Retain this note through every recovery step.',
      mark: { kind: 'underline', styleId: 'highlight-mint' },
      tags: ['rc', 'recovery'],
    });

    const reloaded = new AnnotationService({
      deviceId: 'mac-fixture',
      now,
      repository: new SidecarRepository(store),
    });
    await expect(
      reloaded.resolveHighlights({ filePath, source: originalSource }),
    ).resolves.toMatchObject({
      resolved: [{ record: { id: created.id, revision: enriched.revision } }],
      unanchored: [],
    });

    const missingSource = '# RC\n\nThe original passage was removed.';
    const missing = await reloaded.resolveHighlights({ filePath, source: missingSource });
    expect(missing.unanchored).toMatchObject([
      {
        reason: 'not-found',
        record: {
          body: enriched.body,
          id: created.id,
          status: 'unanchored',
          tags: enriched.tags,
        },
      },
    ]);

    const replacementSource = '# RC\n\nA deliberately chosen replacement passage is stable.';
    const replacementExact = 'replacement passage';
    const replacementStart = replacementSource.indexOf(replacementExact);
    const replacement = await reloaded.prepareSelection({
      filePath,
      selection: {
        end: replacementStart + replacementExact.length,
        scope: { headingPath: ['RC'], sectionEndLine: 2, sectionStartLine: 2 },
        start: replacementStart,
      },
      source: replacementSource,
    });
    const preview = await reloaded.previewReattachment(filePath, created.id, replacement);
    await expect(
      new SidecarRepository(store).readAnnotation(filePath, created.id),
    ).resolves.toEqual(missing.unanchored[0]?.record);
    const repaired = await reloaded.confirmReattachment(filePath, preview);
    expect(repaired).toMatchObject({
      body: enriched.body,
      id: created.id,
      status: 'active',
      tags: enriched.tags,
      target: { quote: { exact: replacementExact } },
    });
    await expect(
      new AnnotationService({ repository: new SidecarRepository(store) }).resolveHighlights({
        filePath,
        source: replacementSource,
      }),
    ).resolves.toMatchObject({
      resolved: [{ record: { id: created.id, status: 'active' } }],
      unanchored: [],
    });

    const deleted = await reloaded.deleteAnnotation(filePath, created.id);
    await expect(
      new AnnotationService({ repository: new SidecarRepository(store) }).resolveHighlights({
        filePath,
        source: replacementSource,
      }),
    ).resolves.toEqual({ issues: [], resolved: [], unanchored: [] });
    const restored = await reloaded.undoDeletion(filePath, created.id, deleted.revision);
    expect(restored).toMatchObject({
      body: enriched.body,
      id: created.id,
      revision: deleted.revision + 1,
      tags: enriched.tags,
    });

    const textExport = await collectTextAnnotationExport([{ record: restored }], {
      format: 'markdown-report',
      generatedAt: now(),
      title: 'RC integrated flow',
    });
    expect(textExport).toContain(replacementExact);
    expect(textExport).toContain('Retain this note through every recovery step.');
    expect(textExport).toContain('- Tags: `rc`, `recovery`');

    const inkRepository = new InkSurfaceRepository(store);
    const surface: InkSurfaceRecord = {
      binding: {
        blockFingerprints: ['block-rc'],
        headingPath: ['RC'],
        sectionFingerprint: 'section-rc',
        sourceEnd: replacementSource.length,
        sourceStart: 0,
      },
      createdAt: now(),
      deviceId: 'mac-fixture',
      filePath,
      id: 'surface-rc',
      layout: {
        blockFingerprints: ['block-rc'],
        fontFamily: 'system-ui',
        fontSize: 16,
        lineHeight: 24,
        logicalHeight: 800,
        logicalWidth: 960,
        sourceRevision: 'source-rc-1',
        themeMode: 'light',
      },
      noteId: created.noteId,
      revision: 1,
      schemaVersion: 1,
      status: 'active',
      strokes: [],
      updatedAt: now(),
    };
    await inkRepository.writeSurface(surface);
    const inkSession = new InkDocumentSession({
      debounceMs: 60_000,
      now,
      surfaces: [surface],
      writer: inkRepository,
    });
    inkSession.addStroke({
      color: '#111111',
      id: 'stroke-rc',
      points: [
        { pressure: 0.4, time: 0, x: 10, y: 20 },
        { pressure: 0.6, time: 16, x: 30, y: 40 },
      ],
      tool: 'pen',
      width: 2,
    });
    expect(inkSession.undo()).toBe(true);
    expect(inkSession.redo()).toBe(true);
    await inkSession.exit();

    const inkAfterReload = await new InkSurfaceRepository(store).readSurface(filePath, surface.id);
    expect(inkAfterReload).toMatchObject({
      revision: 2,
      status: 'active',
      strokes: [{ linkedStrokeId: 'stroke-rc' }],
    });
    if (inkAfterReload === null) throw new Error('Ink fixture disappeared after reload.');

    const section = {
      blockFingerprints: ['block-rc-v2'],
      headingPath: ['RC'],
      sectionFingerprint: 'section-rc',
      sourceEnd: replacementSource.length + 20,
      sourceStart: 20,
    };
    const changedLayout = {
      fontAvailable: true,
      fontFamily: 'system-ui',
      fontSize: 18,
      lineHeight: 28,
      logicalHeight: 1000,
      logicalWidth: 960,
      sourceRevision: 'source-rc-2',
      themeMode: 'light' as const,
      viewportWidth: 720,
    };
    const reconciliation = reconcileInkSurface(inkAfterReload, [section], changedLayout);
    expect(reconciliation.kind).toBe('needs-rebase');
    await inkRepository.updateSurface(reconciliation.record);
    const rebasePreview = previewInkRebase(reconciliation.record, section, changedLayout);
    await expect(inkRepository.readSurface(filePath, surface.id)).resolves.toEqual(
      reconciliation.record,
    );
    const rebased = confirmInkRebase(reconciliation.record, rebasePreview, now());
    await inkRepository.updateSurface(rebased);
    expect(rebased).toMatchObject({
      layout: { fontSize: 18, logicalHeight: 1000, sourceRevision: 'source-rc-2' },
      revision: 4,
      status: 'active',
    });

    const svg = exportInkSvg(rebased);
    const png = exportInkPng(rebased, { background: '#ffffff', height: 100, width: 96 });
    const html = renderInkStandaloneHtml([rebased], {
      generatedAt: now(),
      title: 'RC Ink export',
    });
    expect(svg).toContain('data-ink-stroke-id="stroke-rc"');
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(html).toContain('1 stroke');

    const tombstonedSurface = await inkRepository.tombstoneSurface(
      filePath,
      surface.id,
      now(),
      'mac-fixture',
    );
    const restoredSurface = await inkRepository.restoreSurface(
      filePath,
      surface.id,
      now(),
      'mac-fixture',
    );
    expect(restoredSurface).toMatchObject({
      revision: tombstonedSurface.revision + 1,
      status: 'active',
      strokes: [{ linkedStrokeId: 'stroke-rc' }],
    });
    await expect(inkRepository.listSurfaceSummaries(filePath)).resolves.toMatchObject([
      { id: surface.id, revision: restoredSurface.revision, strokeCount: 1 },
    ]);

    store.addSibling(
      `/annotations/${restored.id}.json`,
      `${restored.id} (conflicted copy).json`,
      encodeTextAnnotationRecord({ ...restored, body: 'Divergent iCloud copy.' }),
    );
    store.addSibling(`/annotations/${restored.id}.json`, 'corrupt-record.json', '{');
    const conflicted = await new SidecarRepository(store).listAnnotations(filePath);
    expect(conflicted.records).toHaveLength(1);
    expect(conflicted.conflicts).toMatchObject([
      { annotationId: restored.id, kind: 'same-revision-divergence' },
    ]);
    expect(conflicted.conflicts[0]?.candidates).toHaveLength(2);
    expect(conflicted.issues.map((issue) => issue.kind).sort()).toEqual([
      'conflict',
      'corrupt-record',
    ]);
    const chosenConflictCandidate = conflicted.conflicts[0]?.candidates.find(
      (candidate) => candidate.record.body === 'Divergent iCloud copy.',
    );
    if (chosenConflictCandidate === undefined)
      throw new Error('Missing chosen conflict candidate.');
    const conflictRepairService = new AnnotationService({
      deviceId: 'repair-device',
      now,
      repository: new SidecarRepository(store),
    });
    const conflictResolution = await conflictRepairService.repairConflict(
      filePath,
      conflicted.conflicts[0] as NonNullable<(typeof conflicted.conflicts)[number]>,
      chosenConflictCandidate.path,
    );
    expect(conflictResolution).toMatchObject({
      body: 'Divergent iCloud copy.',
      deviceId: 'repair-device',
      revision: restored.revision + 1,
    });
    const afterConflictRepair = await new SidecarRepository(store).listAnnotations(filePath);
    expect(afterConflictRepair.records).toEqual([conflictResolution]);
    expect(afterConflictRepair.conflicts).toMatchObject([{ kind: 'duplicate-artifact' }]);
    expect(afterConflictRepair.issues.map((issue) => issue.kind).sort()).toEqual([
      'corrupt-record',
      'duplicate-artifact',
    ]);
    expect(store.canonicalFiles()).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`/annotations/${restored.id}.json`),
        expect.stringContaining(`/surfaces/${surface.id}.json`),
      ]),
    );
  });
});

class ReleaseFixtureStore implements TextFileStore {
  private readonly directories = new Set<string>();
  private readonly files = new Map<string, string>();

  list(directory: string): Promise<readonly string[]> {
    const prefix = `${trim(directory)}/`;
    const children = new Set<string>();
    for (const path of [...this.directories, ...this.files.keys()]) {
      if (!path.startsWith(prefix)) continue;
      const child = path.slice(prefix.length).split('/')[0];
      if (child !== undefined && child.length > 0) children.add(child);
    }
    return Promise.resolve([...children].sort());
  }

  mkdir(path: string): Promise<void> {
    const parts = trim(path).split('/');
    for (let length = 1; length <= parts.length; length += 1) {
      this.directories.add(parts.slice(0, length).join('/'));
    }
    return Promise.resolve();
  }

  read(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(trim(path)) ?? null);
  }

  rename(from: string, to: string): Promise<void> {
    const source = trim(from);
    const destination = trim(to);
    for (const [path, contents] of [...this.files]) {
      if (path !== source && !path.startsWith(`${source}/`)) continue;
      this.files.delete(path);
      this.files.set(`${destination}${path.slice(source.length)}`, contents);
    }
    for (const path of [...this.directories]) {
      if (path !== source && !path.startsWith(`${source}/`)) continue;
      this.directories.delete(path);
      this.directories.add(`${destination}${path.slice(source.length)}`);
    }
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    const normalized = trim(path);
    this.files.delete(normalized);
    for (const candidate of [...this.files.keys()]) {
      if (candidate.startsWith(`${normalized}/`)) this.files.delete(candidate);
    }
    return Promise.resolve();
  }

  write(path: string, contents: string): Promise<void> {
    this.files.set(trim(path), contents);
    return Promise.resolve();
  }

  addSibling(canonicalSuffix: string, filename: string, contents: string): void {
    const canonical = [...this.files.keys()].find((path) => path.endsWith(canonicalSuffix));
    if (canonical === undefined)
      throw new Error(`Missing fixture path ending in ${canonicalSuffix}`);
    const directory = canonical.slice(0, canonical.lastIndexOf('/'));
    this.files.set(`${directory}/${filename}`, contents);
  }

  canonicalFiles(): readonly string[] {
    return [...this.files.keys()]
      .filter((path) => /\/(annotations|surfaces)\/[^/]+\.json$/u.test(path))
      .sort();
  }
}

function trim(path: string): string {
  return path.replace(/^\/+|\/+$/gu, '');
}
