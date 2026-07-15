import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { AnnotationService } from '../src/application/annotation-service';
import { VaultIndexBuilder } from '../src/application/vault-index-builder';
import { encodeInkSurfaceRecord, type InkSurfaceRecord } from '../src/domain/ink-surface';
import {
  encodeTextAnnotationRecord,
  type TextAnnotationRecord,
} from '../src/domain/text-annotation';
import { hashText } from '../src/domain/text-anchor';
import { calculateVirtualListWindow } from '../src/domain/virtual-list-window';
import { VaultAnnotationIndex } from '../src/domain/vault-annotation-index';
import { InkSurfaceRepository } from '../src/storage/ink-surface-repository';
import { SidecarRepository, type TextFileStore } from '../src/storage/sidecar-repository';
import { VaultIndexCache } from '../src/storage/vault-index-cache';

const SIDECAR_ROOT = '.obsidian-annotations/v1/notes';
const NOW = '2026-07-14T08:00:00.000Z';

export interface ScaleHarnessOptions {
  readonly bulkSelectionSize?: number;
  readonly cleanup?: boolean;
  readonly inkPerNote?: number;
  readonly noteCount?: number;
  readonly textPerNote?: number;
  readonly workRoot?: string;
}

export interface ScaleHarnessResult {
  readonly bulk: {
    readonly durationMs: number;
    readonly failed: number;
    readonly selected: number;
    readonly succeeded: number;
  };
  readonly cache: { readonly durationMs: number; readonly restoredEntries: number };
  readonly environment: {
    readonly arch: string;
    readonly node: string;
    readonly platform: string;
  };
  readonly fixture: {
    readonly canonicalFiles: number;
    readonly indexEntries: number;
    readonly notes: number;
    readonly retained: boolean;
    readonly workRoot: string;
  };
  readonly hydration: {
    readonly durationMs: number;
    readonly issues: number;
    readonly peakProgress: number;
  };
  readonly indexSafety: {
    readonly containsInkPoints: boolean;
    readonly containsThumbnailSvg: boolean;
  };
  readonly memory: {
    readonly afterBuildHeapMb: number;
    readonly afterBuildRssMb: number;
    readonly beforeBuildHeapMb: number;
    readonly beforeBuildRssMb: number;
    readonly heapDeltaMb: number;
    readonly rssDeltaMb: number;
  };
  readonly search: { readonly durationMs: number; readonly matches: number };
  readonly virtualWindow: {
    readonly durationMs: number;
    readonly materializedRows: number;
    readonly totalRows: number;
  };
}

/**
 * Builds a real small-file sidecar tree and runs production repositories/index code against it.
 * This is an APFS/Node qualification harness, not an iCloud or Obsidian renderer substitute.
 */
export async function runScaleHarness(
  options: ScaleHarnessOptions = {},
): Promise<ScaleHarnessResult> {
  const noteCount = positiveInteger(options.noteCount ?? 100, 'noteCount');
  const textPerNote = positiveInteger(options.textPerNote ?? 100, 'textPerNote');
  const inkPerNote = positiveInteger(options.inkPerNote ?? 100, 'inkPerNote');
  const bulkSelectionSize = nonNegativeInteger(
    options.bulkSelectionSize ?? 100,
    'bulkSelectionSize',
  );
  const ownsRoot = options.workRoot === undefined;
  const workRoot = options.workRoot ?? (await mkdtemp(join(tmpdir(), 'inkstone-scale-')));
  const store = new NodeTextFileStore(workRoot);
  const textRepository = new SidecarRepository(store);
  const inkRepository = new InkSurfaceRepository(store);
  const canonicalFiles = noteCount * (1 + textPerNote + inkPerNote);

  try {
    await createFixture({ inkPerNote, noteCount, store, textPerNote });
    const beforeBuild = process.memoryUsage();
    const index = new VaultAnnotationIndex();
    const cache = new VaultIndexCache(store);
    let peakProgress = 0;
    const hydrationStartedAt = performance.now();
    const hydration = await new VaultIndexBuilder({
      cache,
      index,
      source: {
        listAnnotations: (filePath) => textRepository.listAnnotations(filePath),
        listNotes: () => textRepository.listNotes(),
        listSurfaceSummaries: (filePath) => inkRepository.listSurfaceSummaries(filePath),
      },
    }).rebuild({
      concurrency: 8,
      onProgress: ({ completed }) => {
        peakProgress = Math.max(peakProgress, completed);
      },
    });
    const hydrationDurationMs = performance.now() - hydrationStartedAt;
    const afterBuild = process.memoryUsage();

    const expectedEntries = noteCount * (textPerNote + inkPerNote);
    if (hydration.indexed !== expectedEntries || index.snapshot().length !== expectedEntries) {
      throw new Error(`Scale hydration indexed ${hydration.indexed}; expected ${expectedEntries}.`);
    }
    const indexBytes = await store.read('.obsidian-annotations/v1/index.json');
    if (indexBytes === null) throw new Error('Scale hydration did not write its derived index.');
    const containsInkPoints = indexBytes.includes('"points"');
    const containsThumbnailSvg = indexBytes.includes('<svg');
    if (containsInkPoints || containsThumbnailSvg) {
      throw new Error('Derived Vault index leaked Ink vectors or thumbnail SVG.');
    }

    const cacheIndex = new VaultAnnotationIndex();
    const cacheStartedAt = performance.now();
    const restoredEntries = await new VaultIndexBuilder({
      cache,
      index: cacheIndex,
      source: {
        listAnnotations: (filePath) => textRepository.listAnnotations(filePath),
        listNotes: () => textRepository.listNotes(),
        listSurfaceSummaries: (filePath) => inkRepository.listSurfaceSummaries(filePath),
      },
    }).restoreCached();
    const cacheDurationMs = performance.now() - cacheStartedAt;

    const searchStartedAt = performance.now();
    const searchResult = index.query({ text: `needle-${noteCount - 1}-${textPerNote - 1}` });
    const searchDurationMs = performance.now() - searchStartedAt;
    if (searchResult.total !== 1 || searchDurationMs >= 250) {
      throw new Error(
        `Scale search returned ${searchResult.total} in ${round(searchDurationMs)} ms; expected one result below 250 ms.`,
      );
    }

    const virtualStartedAt = performance.now();
    const virtual = calculateVirtualListWindow({
      overscan: 4,
      rowHeight: 56,
      scrollTop: Math.floor(expectedEntries / 2) * 56,
      total: expectedEntries,
      viewportHeight: 560,
    });
    const virtualDurationMs = performance.now() - virtualStartedAt;
    const materializedRows = virtual.end - virtual.start;
    if (materializedRows >= 30) throw new Error('Scale virtual window materialized too many rows.');

    const selected = index
      .snapshot()
      .filter((entry) => entry.type !== 'ink')
      .slice(0, Math.min(bulkSelectionSize, noteCount * textPerNote))
      .map((entry) => ({
        expectedRevision: entry.revision,
        filePath: entry.filePath,
        id: entry.id,
      }));
    const bulkStartedAt = performance.now();
    const bulk =
      selected.length === 0
        ? { failed: [], succeeded: [] }
        : await new AnnotationService({ repository: textRepository }).bulkAddTags(selected, [
            'scale-qualified',
          ]);
    const bulkDurationMs = performance.now() - bulkStartedAt;
    if (bulk.failed.length > 0 || bulk.succeeded.length !== selected.length) {
      throw new Error('Scale bulk mutation did not update every selected revision snapshot.');
    }

    return {
      bulk: {
        durationMs: round(bulkDurationMs),
        failed: bulk.failed.length,
        selected: selected.length,
        succeeded: bulk.succeeded.length,
      },
      cache: { durationMs: round(cacheDurationMs), restoredEntries },
      environment: { arch: process.arch, node: process.version, platform: process.platform },
      fixture: {
        canonicalFiles,
        indexEntries: expectedEntries,
        notes: noteCount,
        retained: !ownsRoot || options.cleanup === false,
        workRoot,
      },
      hydration: {
        durationMs: round(hydrationDurationMs),
        issues: hydration.issues.length,
        peakProgress,
      },
      indexSafety: { containsInkPoints, containsThumbnailSvg },
      memory: {
        afterBuildHeapMb: megabytes(afterBuild.heapUsed),
        afterBuildRssMb: megabytes(afterBuild.rss),
        beforeBuildHeapMb: megabytes(beforeBuild.heapUsed),
        beforeBuildRssMb: megabytes(beforeBuild.rss),
        heapDeltaMb: megabytes(afterBuild.heapUsed - beforeBuild.heapUsed),
        rssDeltaMb: megabytes(afterBuild.rss - beforeBuild.rss),
      },
      search: { durationMs: round(searchDurationMs), matches: searchResult.total },
      virtualWindow: {
        durationMs: round(virtualDurationMs),
        materializedRows,
        totalRows: expectedEntries,
      },
    };
  } finally {
    if (ownsRoot && options.cleanup !== false) {
      await rm(workRoot, { force: true, recursive: true });
    }
  }
}

async function createFixture(input: {
  readonly inkPerNote: number;
  readonly noteCount: number;
  readonly store: NodeTextFileStore;
  readonly textPerNote: number;
}): Promise<void> {
  const files: Array<{ readonly contents: string; readonly path: string }> = [];
  for (let noteIndex = 0; noteIndex < input.noteCount; noteIndex += 1) {
    const filePath = `Scale/Note-${noteIndex}.md`;
    const pathHash = await hashText(filePath);
    const noteId = `note-${noteIndex}`;
    const noteRoot = `${SIDECAR_ROOT}/${pathHash}`;
    await Promise.all([
      input.store.mkdir(`${noteRoot}/annotations`),
      input.store.mkdir(`${noteRoot}/surfaces`),
    ]);
    files.push({
      contents: `${JSON.stringify(
        {
          filePath,
          lastReconciledAt: NOW,
          noteId,
          pathHash,
          schemaVersion: 1,
          sourceFingerprint: `source-${noteIndex}`,
        },
        null,
        2,
      )}\n`,
      path: `${noteRoot}/meta.json`,
    });
    for (let recordIndex = 0; recordIndex < input.textPerNote; recordIndex += 1) {
      files.push({
        contents: encodeTextAnnotationRecord(textRecord(filePath, noteId, noteIndex, recordIndex)),
        path: `${noteRoot}/annotations/annotation-${noteIndex}-${recordIndex}.json`,
      });
    }
    for (let surfaceIndex = 0; surfaceIndex < input.inkPerNote; surfaceIndex += 1) {
      files.push({
        contents: encodeInkSurfaceRecord(inkRecord(filePath, noteId, noteIndex, surfaceIndex)),
        path: `${noteRoot}/surfaces/surface-${noteIndex}-${surfaceIndex}.json`,
      });
    }
  }
  await runPool(files, 64, ({ contents, path }) => input.store.write(path, contents));
}

function textRecord(
  filePath: string,
  noteId: string,
  noteIndex: number,
  recordIndex: number,
): TextAnnotationRecord {
  const exact = `needle-${noteIndex}-${recordIndex}`;
  return {
    createdAt: NOW,
    filePath,
    id: `annotation-${noteIndex}-${recordIndex}`,
    mark: { kind: recordIndex % 2 === 0 ? 'highlight' : 'underline', styleId: 'highlight-sun' },
    noteId,
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    tags: recordIndex % 5 === 0 ? ['scale'] : [],
    target: {
      position: { end: exact.length, start: 0, unit: 'utf16-code-unit' },
      quote: { exact, prefix: '', suffix: '' },
      scope: { headingPath: ['Scale'], sectionEndLine: recordIndex, sectionStartLine: recordIndex },
      sourceRevision: `source-${noteIndex}`,
    },
    updatedAt: NOW,
  };
}

function inkRecord(
  filePath: string,
  noteId: string,
  noteIndex: number,
  surfaceIndex: number,
): InkSurfaceRecord {
  return {
    binding: {
      blockFingerprints: [`block-${surfaceIndex}`],
      headingPath: ['Scale', `Ink ${surfaceIndex}`],
      sectionFingerprint: `section-${noteIndex}-${surfaceIndex}`,
      sourceEnd: surfaceIndex * 10 + 10,
      sourceStart: surfaceIndex * 10,
    },
    createdAt: NOW,
    filePath,
    id: `surface-${noteIndex}-${surfaceIndex}`,
    layout: {
      blockFingerprints: [`block-${surfaceIndex}`],
      fontFamily: 'system-ui',
      fontSize: 16,
      lineHeight: 24,
      logicalHeight: 800,
      logicalWidth: 960,
      sourceRevision: `source-${noteIndex}`,
      themeMode: 'light',
    },
    noteId,
    revision: 1,
    schemaVersion: 1,
    status: 'active',
    strokes: [
      {
        color: '#4f46d8',
        id: `stroke-${noteIndex}-${surfaceIndex}`,
        points: [
          { pressure: 0.5, time: 0, x: 10, y: 10 },
          { pressure: 0.5, time: 16, x: 20, y: 20 },
        ],
        tool: 'pen',
        width: 4,
      },
    ],
    updatedAt: NOW,
  };
}

class NodeTextFileStore implements TextFileStore {
  constructor(private readonly root: string) {}

  async list(directory: string): Promise<readonly string[]> {
    try {
      return (await readdir(this.absolute(directory), { withFileTypes: true }))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  mkdir(path: string): Promise<void> {
    return mkdir(this.absolute(path), { recursive: true }).then(() => undefined);
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.absolute(path), 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await unlink(this.absolute(path));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  rename(from: string, to: string): Promise<void> {
    return mkdir(dirname(this.absolute(to)), { recursive: true }).then(() =>
      rename(this.absolute(from), this.absolute(to)),
    );
  }

  async write(path: string, contents: string): Promise<void> {
    const target = this.absolute(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }

  private absolute(path: string): string {
    return join(this.root, ...path.split('/'));
  }
}

async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item === undefined) return;
        await worker(item);
      }
    }),
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function megabytes(value: number): number {
  return round(value / 1024 / 1024);
}
